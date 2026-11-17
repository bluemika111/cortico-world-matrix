/**
 * Matrix 客户端-服务器 API 的最小客户端。
 *
 * 只实现这个扩展用到的部分：sync、收发消息、上传与下载媒体、房间状态与成员。
 * 没有端到端加密，消息就是明文 JSON；凭据是长期访问令牌，不走登录流程。
 */
import type { Logger } from 'cortico/core/types.ts';
import { encodeSegment, isRoomAlias, parseMxc } from './ids.ts';

/** 一条房间事件；只列出这个扩展读的字段。 */
export interface MatrixEvent {
  type: string;
  event_id?: string;
  sender?: string;
  state_key?: string;
  origin_server_ts?: number;
  content?: Record<string, unknown>;
  unsigned?: Record<string, unknown>;
  room_id?: string;
}

export interface SyncTimeline {
  events?: MatrixEvent[];
  limited?: boolean;
  prev_batch?: string;
}

export interface SyncRoomData {
  timeline?: SyncTimeline;
  state?: { events?: MatrixEvent[] };
  ephemeral?: { events?: MatrixEvent[] };
  summary?: {
    'm.heroes'?: string[];
    'm.joined_member_count'?: number;
    'm.invited_member_count'?: number;
  };
  unread_notifications?: { notification_count?: number; highlight_count?: number };
}

export interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, SyncRoomData>;
    invite?: Record<string, { invite_state?: { events?: MatrixEvent[] } }>;
    leave?: Record<string, unknown>;
  };
  /** 端到端加密要用的三样东西：to-device 消息、一次性密钥计数、设备列表变化。 */
  to_device?: { events?: Array<Record<string, unknown>> };
  device_one_time_keys_count?: Record<string, number>;
  device_unused_fallback_key_types?: string[];
  'org.matrix.msc2732.device_unused_fallback_key_types'?: string[];
  device_lists?: { changed?: string[]; left?: string[] };
}

export interface MatrixMember {
  display_name?: string;
}

/** 服务端拒绝了一次请求；`errcode` 是 Matrix 的错误码。 */
export class MatrixError extends Error {
  constructor(
    message: string,
    readonly errcode: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'MatrixError';
  }

  /** 令牌失效：再重试也没用，停在错误状态比反复 401 好。 */
  get unauthorized(): boolean {
    return this.status === 401 || this.errcode === 'M_UNKNOWN_TOKEN' || this.errcode === 'M_MISSING_TOKEN';
  }

  /** 从 `since` 续不上：丢掉 next_batch 重新开始。 */
  get stalePosition(): boolean {
    return this.errcode === 'M_UNKNOWN_POS' || this.errcode === 'M_INVALID_PARAM';
  }
}

export interface MatrixClientOptions {
  homeserver: string;
  accessToken: string;
  log: Logger;
  /** 测试注入；不给时用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 普通请求的时限；sync 自己按长轮询的时长放宽。 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** fetch 认的请求体；从 fetch 自己的签名里取，免得依赖 DOM 的 lib。 */
type FetchBody = NonNullable<Parameters<typeof fetch>[1]>['body'];

/** 去掉末尾斜杠；地址为空时返回空串。 */
export function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export class MatrixClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly abortController = new AbortController();
  private txn = 0;

  constructor(private readonly opts: MatrixClientOptions) {
    this.base = normalizeBase(opts.homeserver);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get homeserver(): string {
    return this.base;
  }

  get configured(): boolean {
    return Boolean(this.base && this.opts.accessToken);
  }

  /** 停掉挂在服务端上的长轮询：World 停止时调用，不必等满一个 timeout。 */
  abort(): void {
    this.abortController.abort();
  }


  // ---- 账号 ----

  async whoami(): Promise<{ userId: string; deviceId?: string }> {
    const data = await this.get<{ user_id?: string; device_id?: string }>('/_matrix/client/v3/account/whoami');
    const userId = String(data.user_id ?? '');
    if (!userId) throw new MatrixError('whoami 没有返回 user_id', 'M_BAD_RESPONSE', 200);
    return { userId, deviceId: data.device_id };
  }

  async versions(): Promise<string[]> {
    const data = await this.get<{ versions?: string[] }>('/_matrix/client/versions', { auth: false });
    return Array.isArray(data.versions) ? data.versions.map(String) : [];
  }

  /** 显示名与头像；取不到时返回空对象。 */
  async profile(userId: string): Promise<{ displayname?: string; avatarUrl?: string }> {
    const data = await this.get<{ displayname?: string; avatar_url?: string }>(
      `/_matrix/client/v3/profile/${encodeSegment(userId)}`,
      { auth: false },
    );
    return { displayname: data.displayname, avatarUrl: data.avatar_url };
  }

  // ---- 房间 ----

  async joinedRooms(): Promise<string[]> {
    const data = await this.get<{ joined_rooms?: string[] }>('/_matrix/client/v3/joined_rooms');
    return Array.isArray(data.joined_rooms) ? data.joined_rooms.map(String) : [];
  }

  /** 房间状态事件的内容；不存在时返回 null。 */
  async roomState(roomId: string, eventType: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.get<Record<string, unknown>>(
        `/_matrix/client/v3/rooms/${encodeSegment(roomId)}/state/${encodeSegment(eventType)}`,
      );
    } catch (error) {
      if (error instanceof MatrixError && error.status === 404) return null;
      throw error;
    }
  }

  async roomName(roomId: string): Promise<string | null> {
    const state = await this.roomState(roomId, 'm.room.name');
    const name = state ? String(state.name ?? '').trim() : '';
    return name || null;
  }

  async roomAlias(roomId: string): Promise<string | null> {
    const state = await this.roomState(roomId, 'm.room.canonical_alias');
    const alias = state ? String(state.alias ?? '').trim() : '';
    return alias || null;
  }

  async joinedMembers(roomId: string): Promise<Record<string, MatrixMember>> {
    const data = await this.get<{ joined?: Record<string, MatrixMember> }>(
      `/_matrix/client/v3/rooms/${encodeSegment(roomId)}/joined_members`,
    );
    return data.joined ?? {};
  }

  /** `#alias:server` 或 `!id:server` 解成 room id。 */
  async resolveRoom(target: string): Promise<string> {
    if (!isRoomAlias(target)) return target;
    const data = await this.get<{ room_id?: string }>(`/_matrix/client/v3/directory/room/${encodeSegment(target)}`, {
      auth: false,
    });
    const roomId = String(data.room_id ?? '');
    if (!roomId) throw new MatrixError(`别名 ${target} 没有对应的房间`, 'M_NOT_FOUND', 404);
    return roomId;
  }

  async joinRoom(roomIdOrAlias: string): Promise<string> {
    const data = await this.post<{ room_id?: string }>(
      `/_matrix/client/v3/join/${encodeSegment(roomIdOrAlias)}`,
      {},
    );
    return String(data.room_id ?? roomIdOrAlias);
  }

  /** 最近若干条事件，按时间升序返回。 */
  async messages(roomId: string, limit: number): Promise<MatrixEvent[]> {
    const query = new URLSearchParams({ dir: 'b', limit: String(Math.max(1, Math.min(1000, limit))) });
    const data = await this.get<{ chunk?: MatrixEvent[] }>(
      `/_matrix/client/v3/rooms/${encodeSegment(roomId)}/messages?${query.toString()}`,
    );
    const chunk = Array.isArray(data.chunk) ? data.chunk : [];
    return [...chunk].reverse();
  }

  // ---- sync ----

  /**
   * 长轮询 sync。`since` 为空时是一次全量同步，只用来拿 next_batch，
   * 调用方不应该把它的时间线当成新消息。
   */
  async sync(since: string | null, timeoutMs: number): Promise<SyncResponse> {
    const query = new URLSearchParams();
    query.set('timeout', String(Math.max(0, Math.floor(timeoutMs))));
    if (since) query.set('since', since);
    // 服务端会等到 timeout 才回，请求本身的时限要更宽。
    return this.get<SyncResponse>(`/_matrix/client/v3/sync?${query.toString()}`, {
      timeoutMs: Math.max(0, Math.floor(timeoutMs)) + 20_000,
    });
  }

  // ---- 发送 ----

  /**
   * 发一条房间事件。事件类型与内容由调用方给；返回 event_id。
   * txnId 是幂等键：同一条 txnId 重发不会产生第二条消息。
   */
  async sendEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
    txnId = this.nextTxn(),
  ): Promise<string> {
    const data = await this.put<{ event_id?: string }>(
      `/_matrix/client/v3/rooms/${encodeSegment(roomId)}/send/${encodeSegment(eventType)}/${encodeSegment(txnId)}`,
      content,
    );
    const eventId = String(data.event_id ?? '');
    if (!eventId) throw new MatrixError('发送没有返回 event_id', 'M_BAD_RESPONSE', 200);
    return eventId;
  }

  async redact(roomId: string, eventId: string, reason?: string, txnId = this.nextTxn()): Promise<string> {
    const body: Record<string, unknown> = {};
    if (reason) body.reason = reason;
    const data = await this.put<{ event_id?: string }>(
      `/_matrix/client/v3/rooms/${encodeSegment(roomId)}/redact/${encodeSegment(eventId)}/${encodeSegment(txnId)}`,
      body,
    );
    return String(data.event_id ?? eventId);
  }

  async setTyping(roomId: string, userId: string, typing: boolean, timeoutMs = 5000): Promise<void> {
    await this.put(`/_matrix/client/v3/rooms/${encodeSegment(roomId)}/typing/${encodeSegment(userId)}`, {
      typing,
      timeout: Math.max(0, Math.floor(timeoutMs)),
    });
  }

  /** 把一条事件标成已读。失败不影响收发。 */
  async sendReadReceipt(roomId: string, eventId: string): Promise<void> {
    await this.post(
      `/_matrix/client/v3/rooms/${encodeSegment(roomId)}/receipt/m.read/${encodeSegment(eventId)}`,
      {},
    );
  }

  // ---- 媒体 ----

  /** 上传字节，返回 mxc 地址。 */
  async upload(bytes: Uint8Array, mime: string, filename: string): Promise<string> {
    const query = new URLSearchParams({ filename });
    const data = await this.request<{ content_uri?: string }>(
      'POST',
      `/_matrix/media/v3/upload?${query.toString()}`,
      { body: bytes, contentType: mime, timeoutMs: 120_000 },
    );
    const uri = String(data.content_uri ?? '');
    if (!parseMxc(uri)) throw new MatrixError('上传没有返回 mxc 地址', 'M_BAD_RESPONSE', 200);
    return uri;
  }

  /**
   * 下载一个 mxc。先问 v1.11 的客户端媒体端点，404 时退回 v3：
   * 老版本服务端只实现了后者。媒体过期（服务端按保留策略清掉）时抛 404。
   */
  async download(mxc: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const parsed = parseMxc(mxc);
    if (!parsed) throw new MatrixError(`不是 mxc 地址：${mxc.slice(0, 60)}`, 'M_BAD_MEDIA', 400);
    const server = encodeSegment(parsed.server);
    const mediaId = encodeSegment(parsed.mediaId);
    const paths = [
      `/_matrix/client/v1/media/download/${server}/${mediaId}`,
      `/_matrix/media/v3/download/${server}/${mediaId}`,
    ];
    let last: unknown = null;
    for (const path of paths) {
      try {
        return await this.requestRaw('GET', path, { timeoutMs: 30_000 });
      } catch (error) {
        last = error;
        if (error instanceof MatrixError && error.status !== 404) throw error;
      }
    }
    throw last instanceof Error ? last : new MatrixError('媒体下载失败', 'M_UNKNOWN', 500);
  }

  // ---- 内部 ----

  private nextTxn(): string {
    this.txn += 1;
    return `mxb-${Date.now().toString(36)}-${this.txn}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private get<T>(path: string, opts: { auth?: boolean; timeoutMs?: number } = {}): Promise<T> {
    return this.request<T>('GET', path, opts);
  }

  private post<T>(path: string, body: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    return this.request<T>('POST', path, { ...opts, contentType: 'application/json', body: JSON.stringify(body) });
  }

  private put<T>(path: string, body: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    return this.request<T>('PUT', path, { ...opts, contentType: 'application/json', body: JSON.stringify(body) });
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: FetchBody; contentType?: string; auth?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const raw = await this.requestRaw(method, path, opts);
    const text = new TextDecoder().decode(raw.bytes).trim();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MatrixError(`${method} ${path}: 响应不是 JSON（${text.slice(0, 120)}）`, 'M_BAD_RESPONSE', 200);
    }
  }

  /** 一次请求，最多对 429 重试一次。 */
  private async requestRaw(
    method: string,
    path: string,
    opts: { body?: FetchBody; contentType?: string; auth?: boolean; timeoutMs?: number } = {},
  ): Promise<{ bytes: Uint8Array; mime: string }> {
    const url = `${this.base}${path}`;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      const signal = AbortSignal.any([controller.signal, this.abortController.signal]);
      try {
        const headers: Record<string, string> = {};
        if (opts.auth !== false) headers.Authorization = `Bearer ${this.opts.accessToken}`;
        if (opts.contentType) headers['Content-Type'] = opts.contentType;
        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: opts.body,
          signal,
          redirect: 'follow',
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (response.ok) {
          return { bytes, mime: (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '' };
        }
        const detail = this.describeFailure(bytes);
        if (response.status === 429 && attempt === 1) {
          const wait = this.retryAfterMs(detail, response.headers.get('retry-after'));
          this.opts.log.warn('服务端限流，等一会儿再试', { path, waitMs: wait });
          await sleep(Math.min(wait, 30_000));
          continue;
        }
        throw new MatrixError(
          `${method} ${path}: ${detail.message || `HTTP ${response.status}`}（${detail.errcode || response.status}）`,
          detail.errcode || `HTTP_${response.status}`,
          response.status,
        );
      } catch (error) {
        if (error instanceof MatrixError) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        if (this.abortController.signal.aborted) {
          throw new MatrixError(`${method} ${path}: 已取消`, 'M_ABORTED', 0);
        }
        const aborted = controller.signal.aborted;
        throw new MatrixError(
          aborted ? `${method} ${path}: 超时（${timeoutMs}ms）` : `${method} ${path}: ${reason}`,
          aborted ? 'M_TIMEOUT' : 'M_NETWORK',
          0,
        );
      } finally {
        clearTimeout(timer);
      }
    }
    throw new MatrixError(`${method} ${path}: 重试之后仍然失败`, 'M_RATE_LIMITED', 429);
  }

  /** 从错误响应里读出 Matrix 的错误码与说明；读不出时退回状态文本。 */
  private describeFailure(bytes: Uint8Array): { errcode: string; message: string; retryAfterMs: number } {
    const text = new TextDecoder().decode(bytes).trim();
    if (text) {
      try {
        const parsed = JSON.parse(text) as { errcode?: unknown; error?: unknown; retry_after_ms?: unknown };
        const errcode = typeof parsed.errcode === 'string' ? parsed.errcode : '';
        const message = typeof parsed.error === 'string' ? parsed.error : '';
        const retryAfterMs = Number(parsed.retry_after_ms);
        if (errcode || message) {
          return { errcode, message: message || errcode, retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : 0 };
        }
      } catch {
        // 不是 JSON：当纯文本用。
      }
      return { errcode: '', message: text.slice(0, 200), retryAfterMs: 0 };
    }
    return { errcode: '', message: '', retryAfterMs: 0 };
  }

  private retryAfterMs(detail: { retryAfterMs: number }, header: string | null): number {
    if (detail.retryAfterMs > 0) return detail.retryAfterMs;
    const seconds = Number(header);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export interface LoginOptions {
  user: string;
  password: string;
  /** 设备在服务端显示的名字；建议带上主机名，多台机器时好认。 */
  deviceName?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface LoginResult {
  userId: string;
  accessToken: string;
  /** 这次登录新建的设备；每登录一次就是一个新设备。 */
  deviceId: string;
}

/**
 * 用账号密码换一个属于「这一次登录」的设备令牌。
 *
 * 和手填令牌的关键差别：服务端会给一个新 device_id。同一个账号在多台机器上各登录一次，
 * 各拿各的设备，加密库互不覆盖；共用同一个令牌则会让两边的设备密钥互相顶掉。
 */
export async function loginWithPassword(homeserver: string, options: LoginOptions): Promise<LoginResult> {
  const base = homeserver.trim().replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  const body = {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: options.user },
    password: options.password,
    ...(options.deviceName ? { initial_device_display_name: options.deviceName } : {}),
  };
  let response: Response;
  try {
    response = await fetchImpl(`${base}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new MatrixError(`登录请求没发出去：${error instanceof Error ? error.message : String(error)}`, 'M_NETWORK', 0);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // 非 JSON（反代吐的 HTML 之类），下面按失败处理。
  }
  if (!response.ok) {
    const errcode = typeof payload.errcode === 'string' ? payload.errcode : 'M_UNKNOWN';
    const reason = typeof payload.error === 'string' ? payload.error : text.slice(0, 200);
    throw new MatrixError(`登录被拒绝：${reason || errcode}`, errcode, response.status);
  }
  const userId = payload.user_id;
  const accessToken = payload.access_token;
  const deviceId = payload.device_id;
  if (typeof userId !== 'string' || typeof accessToken !== 'string' || typeof deviceId !== 'string') {
    throw new MatrixError('登录成功但返回里缺 user_id / access_token / device_id', 'M_UNKNOWN', 0);
  }
  return { userId, accessToken, deviceId };
}
