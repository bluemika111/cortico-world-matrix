/**
 * 一个按脚本回话的 Matrix 客户端：sync 从队列里取响应，队列空了就挂住，
 * 直到 abort 把这一次长轮询打断——和真实长轮询的时序一致。
 */
import { MatrixError, type MatrixEvent, type SyncResponse } from '../../src/matrix/client.ts';
import type { CryptoLayer } from '../../src/matrix/crypto.ts';

/** 假的加密层：记下加密了什么，按表解密。 */
export class FakeCrypto implements CryptoLayer {
  readonly deviceId = 'FAKEDEV';
  readonly ed25519 = 'FAKEED25519';
  /** 这些房间按加密处理。 */
  readonly encryptedRooms = new Set<string>();
  /** eventId → 解密后的事件；没有条目表示解不开。 */
  readonly decrypted = new Map<string, MatrixEvent>();
  readonly encrypted: Array<{ roomId: string; eventType: string; content: Record<string, unknown> }> = [];
  prepared: string[] = [];
  syncs = 0;
  roomEvents = 0;

  async prepare(roomIds: string[]): Promise<void> {
    this.prepared = roomIds;
  }

  async isRoomEncrypted(roomId: string): Promise<boolean> {
    return this.encryptedRooms.has(roomId);
  }

  async decryptEvent(_roomId: string, event: MatrixEvent): Promise<MatrixEvent | null> {
    return this.decrypted.get(event.event_id ?? '') ?? null;
  }

  async encryptEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.encrypted.push({ roomId, eventType, content });
    return {
      algorithm: 'm.megolm.v1.aes-sha2',
      ciphertext: 'fake-ciphertext',
      sender_key: 'fake-sender-key',
      session_id: 'fake-session',
      device_id: this.deviceId,
    };
  }

  async encryptMedia(bytes: Uint8Array): Promise<{ bytes: Uint8Array; file: Record<string, unknown> }> {
    return { bytes, file: { key: { kty: 'oct' }, iv: 'fake-iv', hashes: { sha256: 'fake' }, v: 'v2' } };
  }

  async decryptMedia(): Promise<Uint8Array | null> {
    return null;
  }

  async onSync(): Promise<void> {
    this.syncs += 1;
  }

  async onRoomEvent(): Promise<void> {
    this.roomEvents += 1;
  }

  async stop(): Promise<void> {}
}

export class FakeMatrix {
  /** 依次回给 sync 的响应；给 Error 时抛出来，模拟断线或错误码。 */
  readonly syncQueue: Array<SyncResponse | Error> = [];
  readonly syncCalls: Array<{ since: string | null; timeout: number }> = [];
  readonly sent: Array<{ roomId: string; type: string; content: Record<string, unknown> }> = [];
  readonly uploads: Array<{ mime: string; bytes: number; filename: string }> = [];
  readonly downloads = new Map<string, { bytes: Uint8Array; mime: string }>();
  readonly roomNames = new Map<string, string>();
  /** 房间状态事件：roomId → 事件类型 → 内容。 */
  readonly roomStates = new Map<string, Record<string, Record<string, unknown>>>();
  /** 房间成员：roomId → userId → 成员信息。 */
  readonly roomMembers = new Map<string, Record<string, { display_name?: string }>>();
  readonly backfill = new Map<string, MatrixEvent[]>();
  readonly redactions: Array<{ roomId: string; eventId: string; reason?: string }> = [];
  aliasRooms = new Map<string, string>();
  whoamiUserId = '@coo:example.org';
  displayName = 'Coo';
  versionsList = ['v1.11'];
  abortCalls = 0;
  private pendingReject: ((error: Error) => void) | null = null;
  private txn = 0;

  async sync(since: string | null, timeout: number): Promise<SyncResponse> {
    this.syncCalls.push({ since, timeout });
    const next = this.syncQueue.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    return new Promise<SyncResponse>((_resolve, reject) => {
      this.pendingReject = reject;
    });
  }

  abort(): void {
    this.abortCalls += 1;
    const reject = this.pendingReject;
    this.pendingReject = null;
    reject?.(new MatrixError('已取消', 'M_ABORTED', 0));
  }

  async whoami(): Promise<{ userId: string; deviceId?: string }> {
    return { userId: this.whoamiUserId, deviceId: 'DEVID' };
  }

  async versions(): Promise<string[]> {
    return this.versionsList;
  }

  async profile(userId: string): Promise<{ displayname?: string; avatarUrl?: string }> {
    return { displayname: userId === this.whoamiUserId ? this.displayName : undefined };
  }

  async joinedRooms(): Promise<string[]> {
    return [...this.roomNames.keys()];
  }

  async roomName(roomId: string): Promise<string | null> {
    return this.roomNames.get(roomId) ?? null;
  }

  async roomState(roomId: string, eventType: string): Promise<Record<string, unknown> | null> {
    return this.roomStates.get(roomId)?.[eventType] ?? null;
  }

  async joinedMembers(roomId: string): Promise<Record<string, { display_name?: string }>> {
    return this.roomMembers.get(roomId) ?? {};
  }

  async messages(roomId: string, limit: number): Promise<MatrixEvent[]> {
    return (this.backfill.get(roomId) ?? []).slice(-limit);
  }

  async resolveRoom(target: string): Promise<string> {
    const roomId = this.aliasRooms.get(target);
    if (!roomId) throw new MatrixError(`别名 ${target} 不存在`, 'M_NOT_FOUND', 404);
    return roomId;
  }

  async sendEvent(roomId: string, type: string, content: Record<string, unknown>): Promise<string> {
    this.sent.push({ roomId, type, content });
    this.txn += 1;
    return `$sent-${this.txn}`;
  }

  async upload(bytes: Uint8Array, mime: string, filename: string): Promise<string> {
    this.uploads.push({ mime, bytes: bytes.byteLength, filename });
    return `mxc://example.org/upload-${this.uploads.length}`;
  }

  async download(mxc: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const found = this.downloads.get(mxc);
    if (!found) throw new MatrixError(`媒体不存在：${mxc}`, 'M_NOT_FOUND', 404);
    return found;
  }

  async redact(roomId: string, eventId: string, reason?: string): Promise<string> {
    this.redactions.push({ roomId, eventId, reason });
    return `$redacted-${this.redactions.length}`;
  }
}

/** 一条 `m.room.message` 事件。 */
export function messageEvent(options: {
  eventId: string;
  sender: string;
  body: string;
  roomId?: string;
  msgtype?: string;
  content?: Record<string, unknown>;
  ts?: number;
}): MatrixEvent {
  return {
    type: 'm.room.message',
    event_id: options.eventId,
    sender: options.sender,
    room_id: options.roomId ?? '!room:example.org',
    origin_server_ts: options.ts ?? 1_700_000_000_000,
    content: { msgtype: options.msgtype ?? 'm.text', body: options.body, ...options.content },
  };
}

/** 一条 `m.room.member` 状态事件。 */
export function memberEvent(options: {
  userId: string;
  displayName: string;
  membership: 'join' | 'leave' | 'invite' | 'ban';
  sender?: string;
}): MatrixEvent {
  return {
    type: 'm.room.member',
    state_key: options.userId,
    sender: options.sender ?? options.userId,
    content: { membership: options.membership, displayname: options.displayName },
  };
}
