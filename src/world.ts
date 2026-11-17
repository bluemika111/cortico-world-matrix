/**
 * Matrix 接入 World：用客户端-服务器 API 的 sync 长轮询收房间事件，按开关与名单决定
 * 哪些消息叫醒 Coo，并提供发消息、表情包、反应、语音与主动说话。
 *
 * 世界只做机械的事：连接的建立与重试、事件归一化、开关与名单过滤、记录、计数与上限。
 * 该不该开口、说什么、发到哪里，都是模型自己的判断。
 */
import { existsSync, renameSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BlobInput,
  Logger,
  StoragePart,
  ToolDef,
  World,
  WorldHost,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { nowIso, shortTime } from 'cortico/core/util.ts';
import { MATRIX_SECTION, type EncryptionMode, type MatrixConfigSection, matrixConfigGroup } from './config.ts';
import { ENV_PROMPT_FILE, envPromptVars } from './env.ts';
import { MessageLog } from './history.ts';
import { MatrixClient, MatrixError, type MatrixEvent, type SyncResponse, loginWithPassword } from './matrix/client.ts';
import { type CryptoLayer, type CryptoOptions, cryptoStoreDir, loadCrypto } from './matrix/crypto.ts';
import { inspectDeps, installDeps } from './matrix/deps.ts';
import { bodyMentions, type MediaRef, renderEvent } from './matrix/events.ts';
import { encodeSegment, isRoomAlias, isRoomId, isUserId, localpart, mediaNameOf } from './matrix/ids.ts';
import {
  renderIncoming,
  renderNotice,
  renderProactive,
  renderStatus,
  renderTranscript,
} from './model-text.ts';
import {
  conversationKey,
  localDateKey,
  minutesOfDay,
  parseRoomRoster,
  rosterAllows,
} from './policy.ts';
import {
  type DailyCounter,
  type ProactiveCandidate,
  emptyCounter,
  evaluateProactive,
  markFired,
  rollCounter,
} from './proactive.ts';
import { StickerLibrary, guessImageMime } from './sticker.ts';
import { buildTools, type SendRequest, type SendResult, type ToolContext } from './tools.ts';
import { run, extensionOfMime } from './voice/audio.ts';
import { VoiceService } from './voice/index.ts';

const ENV_PROMPT = ENV_PROMPT_FILE;

/** 一条入站消息里能带的最大图片附件数。 */
const MAX_IMAGE_ATTACHMENTS = 2;
/** 单张图片的下载硬上限：再大就不往下拉了。 */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
/** 超过这个体积就缩图，免得原图挤占上下文。 */
const IMAGE_TARGET_BYTES = 1.5 * 1024 * 1024;
/** 缩图失败时，最多直接附多大的原图。 */
const IMAGE_FALLBACK_BYTES = 5 * 1024 * 1024;
/** 缩图后的长边上限，与多数模型的图片处理尺寸取齐。 */
const IMAGE_MAX_EDGE = 1568;
/** 一条消息分片的字节上限；再长就切成几条发。 */
const MAX_MESSAGE_BYTES = 4000;

export interface MatrixWorldOptions {
  cfg: MatrixConfigSection;
  timezone: string;
  dataDir: string;
  botName: string;
  secret: (name: string) => string | undefined;
  persist: (patch: Partial<MatrixConfigSection>) => void;
  restart: () => void;
  /** 测试注入；不给时按配置建真客户端。 */
  clientFactory?: (opts: { homeserver: string; accessToken: string; log: Logger }) => MatrixClient;
  /** 测试注入：加密层。不给时按配置加载 matrix-bot-sdk。 */
  cryptoFactory?: (opts: CryptoOptions) => Promise<CryptoLayer | null>;
  /** 测试注入：缩图。不给时先试 ffmpeg，再试 Windows 的 System.Drawing。 */
  shrinkImage?: (bytes: Uint8Array, mime: string) => Promise<{ bytes: Uint8Array; mime: string } | null>;
  now?: () => number;
  random?: () => number;
  /** 加密消息解不开时的重试次数与间隔；测试里调小。 */
  decryptRetries?: number;
  decryptDelayMs?: number;
  /** 发送遇到「房间暂时写不进去」时的重试次数与间隔；测试里调小。 */
  sendRetries?: number;
  sendRetryDelayMs?: number;
}

/** 一条等待转写或已经转写过的语音。 */
interface RecordContext {
  eventId: string;
  roomId: string;
  roomName: string;
  senderName: string;
  at: string;
  /** 已经尝试过几次转写。 */
  attempts: number;
  lastError?: string;
}

interface SyncStatus {
  state: 'offline' | 'connecting' | 'online' | 'error';
  detail: string;
}

export class MatrixWorld implements World, ToolContext {
  readonly id = 'matrix';

  private host: WorldHost | null = null;
  private client: MatrixClient | null = null;
  private readonly history: MessageLog;
  private readonly stickers: StickerLibrary;
  private readonly voice: VoiceService;
  private readonly clock: () => number;
  private readonly random: () => number;

  private status: SyncStatus = { state: 'offline', detail: '未启动' };
  private selfUserId = '';
  private selfName = '';
  private nextBatch = '';
  /** 当前令牌挂着的设备；sync 位置按它校验。 */
  private selfDeviceId = '';
  /** 落盘那份 sync 位置属于哪个设备。 */
  private syncTokenDevice = '';
  private syncing = false;
  /** 加密层；没装依赖或初始化失败时是 null，此时按明文模式跑。 */
  private crypto: CryptoLayer | null = null;
  private cryptoState: 'off' | 'missing' | 'ready' | 'failed' = 'off';
  /** 加密层没起来的原因，面板与状态行要显示。 */
  private cryptoError = '';
  /** 加密依赖的安装进度：面板轮询这两个字段。 */
  private installing = false;
  private installLog = '';
  private installOk: boolean | null = null;
  private readonly roomNames = new Map<string, string>();
  private readonly roomAliases = new Map<string, string>();
  private readonly roomMemberCounts = new Map<string, number>();
  private readonly roomMembers = new Map<string, Map<string, string>>();
  private readonly roomEncrypted = new Set<string>();
  private lastRoomId: string | null = null;
  /** 每个房间最近一条叫醒过模型的消息，`mx_react` 不给 id 时用它。 */
  private readonly lastIncomingByRoom = new Map<string, string>();
  /** 每个房间自己最后发出去的那条，`mx_redact` 不给 id 时用它。 */
  private readonly lastSelfByRoom = new Map<string, string>();
  /** 最后往哪个房间发过东西；没有消息叫醒过模型时，撤回就落在这里。 */
  private lastSelfRoomId: string | null = null;
  private readonly records = new Map<string, RecordContext>();

  private proactiveCounter: DailyCounter = emptyCounter('');
  private proactiveReason = '还没检查过';
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private chain: Promise<void> = Promise.resolve();
  private writeChain: Promise<void> = Promise.resolve();
  private lastError = '';

  constructor(private readonly opts: MatrixWorldOptions) {
    this.clock = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    const dataDir = opts.dataDir;
    // 日志转发：连接建立前是静默的，挂上宿主后自动改走宿主的日志。
    const log = delegatingLogger(() => this.logger());
    this.history = new MessageLog({
      dataDir,
      perConversation: () => opts.cfg.historyLimit,
      conversations: () => opts.cfg.historyConversations,
    });
    this.stickers = new StickerLibrary({
      dir: opts.cfg.sticker.dir.trim() || join(dataDir, 'stickers'),
      log,
    });
    this.voice = new VoiceService({
      cfg: () => this.opts.cfg.voice,
      dataDir,
      log,
      secret: opts.secret,
    });
  }

  // ---- World 契约 ----

  envPromptVars(): Record<string, string> {
    return envPromptVars({
      status: this.status,
      userId: this.selfUserId,
      displayName: this.selfName,
      rooms: this.roomSummary(),
      stickers: this.stickers.size,
      voice: this.opts.cfg.voice.enabled,
      proactive: this.opts.cfg.proactive.enabled,
      encryption: `${encryptionModeLabel(this.opts.cfg.encryption)}（${this.cryptoLabel()}）`,
    });
  }

  tools(): ToolDef[] {
    return buildTools(this);
  }

  webUi(language?: Language): WorldWebUiDecl {
    const lang = language ?? 'zh';
    const zh = lang !== 'en';
    return {
      label: zh ? 'Matrix 接入' : 'Matrix',
      lamps: [
        { label: zh ? '连接' : 'Connection', state: lampOf(this.status.state), hint: this.status.detail },
        {
          label: zh ? '房间' : 'Rooms',
          state: this.roomNames.size > 0 ? 'online' : 'offline',
          hint: `${this.roomNames.size}`,
        },
        {
          label: zh ? '表情包' : 'Stickers',
          state: this.stickers.size > 0 ? 'online' : 'offline',
          hint: `${this.stickers.size}`,
        },
        {
          label: zh ? '主动说话' : 'Proactive',
          state: this.opts.cfg.proactive.enabled ? 'online' : 'offline',
          hint: this.proactiveReason,
        },
        {
          label: zh ? '语音' : 'Voice',
          state: this.opts.cfg.voice.enabled ? 'online' : 'offline',
          hint: this.opts.cfg.voice.enabled ? `${this.opts.cfg.voice.asr.provider} / ${this.opts.cfg.voice.tts.provider}` : (zh ? '未开启' : 'off'),
        },
        {
          label: zh ? '加密' : 'Encryption',
          state: this.cryptoState === 'ready' ? 'online' : this.cryptoState === 'failed' ? 'error' : 'offline',
          hint: this.cryptoLabel(),
        },
      ],
      badges: [
        {
          label: zh ? '账号' : 'Account',
          value: this.selfUserId || (this.status.state === 'online' ? (zh ? '未拿到' : 'unknown') : (zh ? '未连接' : 'offline')),
          tone: this.selfUserId ? 'on' : 'off',
        },
        { label: zh ? '监听' : 'Watched', value: this.watchedCount(), tone: 'plain' },
      ],
      panels: [
        {
          id: 'connection',
          title: zh ? '连接与开关' : 'Connection and switches',
          description: zh
            ? '服务器地址、访问令牌、长轮询时长，房间推送的开关与监听名单。名单留空表示监听全部房间。'
            : 'Homeserver, access token, sync timeout, the delivery switch and the watch list. An empty list watches every room.',
        },
        {
          id: 'rooms',
          title: zh ? '房间' : 'Rooms',
          description: zh ? '已加入的房间、成员数、是否加密，以及哪些在监听。' : 'Joined rooms, member counts, encryption, and which ones are watched.',
        },
        {
          id: 'encryption',
          title: zh ? '端到端加密' : 'End-to-end encryption',
          description: zh
            ? '加密策略、启用状态与失败原因，以及每个房间在当前策略下能不能说话。'
            : 'The policy, whether the crypto layer came up, and which rooms the policy allows.',
        },
        {
          id: 'stickers',
          title: zh ? '表情包' : 'Stickers',
          description: zh ? '图库里的图片，按分组列出。' : 'The images in the library, grouped by pack.',
        },
        {
          id: 'proactive',
          title: zh ? '主动说话' : 'Proactive chat',
          description: zh ? '状态机此刻的判断、今天的计数，以及手动发起一次。' : "What the state machine decided, today's count, and a manual opening.",
        },
        {
          id: 'voice',
          title: zh ? '语音' : 'Voice',
          description: zh ? 'ffmpeg、识别与合成服务的探测结果。' : 'What the ffmpeg, ASR and TTS probes found.',
        },
      ],
      config: [matrixConfigGroup(lang)],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      promptDocs: [
        {
          key: `${MATRIX_SECTION}.envPrompt`,
          title: zh ? 'Matrix 接入 · 环境提示词' : 'Matrix · environment prompt',
          description: zh ? '说明你在 Matrix 上看得见什么、这些事件从哪来。' : 'What the bot sees on Matrix and where these events come from.',
          path: ENV_PROMPT,
          role: 'envPrompt',
          vars: [
            { name: 'matrix.identity', description: zh ? '当前连接与账号。' : 'The current connection and account.' },
            { name: 'matrix.rooms', description: zh ? '正在参与的房间。' : 'The rooms the account is in.', multiline: true },
            { name: 'matrix.capabilities', description: zh ? '此刻可用的能力。' : 'What is available right now.' },
          ],
        },
      ],
      storage: this.storage(),
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.stopped = false;
    await this.history.load();
    await this.stickers.scan();
    this.restoreCounters();
    host.log.info('Matrix 接入启动', {
      homeserver: this.opts.cfg.homeserver,
      stickers: this.stickers.size,
      skipped: this.opts.cfg.enabled ? 'no' : 'world disabled',
    });
    if (!this.opts.cfg.enabled) {
      this.publishStatus({ state: 'offline', detail: 'World 未启用' });
      return;
    }
    await this.loadSyncToken();
    this.connect();
    this.startTimers();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.client?.abort();
    this.client = null;
    await this.crypto?.stop().catch(() => {});
    this.crypto = null;
    await this.chain.catch(() => {});
    await this.history.compact().catch(() => {});
    this.host = null;
  }

  // ---- 连接 ----

  private connect(): void {
    const cfg = this.opts.cfg;
    const log = this.logger();
    if (!cfg.homeserver.trim()) {
      this.publishStatus({ state: 'error', detail: '服务器地址是空的' });
      return;
    }
    if (!cfg.accessToken.trim()) {
      this.publishStatus({ state: 'error', detail: '访问令牌是空的' });
      return;
    }
    const client = this.opts.clientFactory
      ? this.opts.clientFactory({ homeserver: cfg.homeserver, accessToken: cfg.accessToken, log })
      : new MatrixClient({ homeserver: cfg.homeserver, accessToken: cfg.accessToken, log });
    this.client = client;
    void this.runSync();
  }

  /** 取一次账号与显示名；失败不影响收发，下一次连接会再试。 */
  private async identify(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const who = await client.whoami();
      this.selfUserId = who.userId;
      this.selfDeviceId = who.deviceId ?? '';
      // sync 位置是按设备存的：换了设备（或换了账号）之后，旧的 next_batch 不属于它，
      // 拿它续同步会拿到残缺的房间状态——表现就是发消息报 no forward extremities。
      this.dropStaleSyncPosition();
    } catch (error) {
      this.lastError = message(error);
      this.logger().warn('whoami 失败：判断不了自己的账号，@ 与「自己发的消息」都会失准', { error: this.lastError });
      return;
    }
    try {
      const profile = await client.profile(this.selfUserId);
      this.selfName = profile.displayname?.trim() || localpart(this.selfUserId);
    } catch {
      this.selfName = localpart(this.selfUserId);
    }
  }

  private publishStatus(status: SyncStatus): void {
    const before = this.status.state;
    this.status = status;
    // 只在真正换状态时推一条，重连抖动时不刷屏。
    if (before === status.state) return;
    if (before !== 'online' && status.state !== 'online') return;
    const host = this.host;
    if (!host || this.stopped) return;
    void host
      .pushEvent(
        {
          type: 'matrix.status',
          ts: nowIso(this.opts.timezone),
          source: this.id,
          senderKey: this.id,
          text: renderStatus({
            time: this.timeOf(this.clock()),
            state: status.state,
            detail: status.detail,
            userId: this.selfUserId || undefined,
          }),
        },
        { trigger: 'piggyback' },
      )
      .catch(() => {});
  }

  /** sync 长轮询的主循环：一次请求挂到服务端有事件或超时，然后立刻再来一次。 */
  private async runSync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.publishStatus({ state: 'connecting', detail: `正在连接 ${this.opts.cfg.homeserver}` });
    // 先问清自己是谁：判断「这条是不是我发的」、认出 @ 自己、写提及都要用这个账号。
    await this.identify();
    // 房间清单与加密层不能等 sync：重启时带着上次的 next_batch，sync 不会重放房间，
    // 只在首次全量同步里建房间表的话，重启之后房间列表就是空的。
    await this.loadRooms();
    await this.startCrypto();
    this.publishStatus({ state: 'online', detail: `已连接 · ${this.roomNames.size} 个房间` });
    let failures = 0;
    try {
      while (!this.stopped) {
        const client = this.client;
        if (!client) break;
        const cfg = this.opts.cfg;
        const since = this.nextBatch || null;
        try {
          const startedAt = Date.now();
          const response = await client.sync(since, since ? syncTimeoutOf(cfg.syncTimeoutMs) : 0);
          if (this.stopped) break;
          failures = 0;
          // 先把 to-device 与设备列表变化喂给加密机，再处理时间线：解密密钥可能就在这一帧里。
          await this.crypto?.onSync(response).catch((error: unknown) => {
            this.logger().warn('加密机处理 sync 失败', { error: message(error) });
          });
          if (since) {
            await this.handleSync(response);
            this.publishStatus({ state: 'online', detail: `同步中 · ${this.roomNames.size} 个房间` });
          } else {
            await this.bootstrap(response);
          }
          if (response.next_batch) {
            this.nextBatch = response.next_batch;
            this.saveSyncToken();
          }
          // 服务端对超范围的 timeout 会立刻回一帧空响应（实测 tuwunel 在 95 秒以上这样）。
          // 没有这条下限，长轮询会退化成满速轮询，把服务端打满。
          if (since && Date.now() - startedAt < 500 && !hasTimelineEvents(response)) await sleep(1000);
        } catch (error) {
          if (this.stopped) break;
          const reason = message(error);
          this.lastError = reason;
          // 令牌失效、房间访问被拒这类错误重试也没用，停在错误状态等人处理。
          if (isFatal(error)) {
            this.publishStatus({ state: 'error', detail: reason });
            this.logger().error('Matrix 连接中断，需要处理之后再重启 World', { error: reason });
            break;
          }
          failures += 1;
          if (isStalePosition(error) && this.nextBatch) {
            // since 续不上：丢掉位置，下一次从头同步；时间线仍然不重放。
            this.logger().warn('sync 位置失效，重新开始同步', { error: reason });
            this.nextBatch = '';
            this.saveSyncToken();
            continue;
          }
          const wait = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
          this.publishStatus({ state: 'connecting', detail: `同步失败，${Math.round(wait / 1000)} 秒后重试：${reason}` });
          await sleep(wait);
        }
      }
    } finally {
      this.syncing = false;
    }
  }

  /** 首次同步：把房间状态补齐，再把最近的历史回填进记录。不把时间线当成新消息。 */
  private async bootstrap(response: SyncResponse): Promise<void> {
    const joined = response.rooms?.join ?? {};
    for (const [roomId, data] of Object.entries(joined)) {
      for (const event of data.state?.events ?? []) this.applyState(roomId, event);
      // 初始同步把房间创建时的状态事件放在时间线里，state 段只给一部分：
      // 不扫一遍时间线就会漏掉 m.room.encryption，房间会被当成明文。
      for (const event of data.timeline?.events ?? []) {
        if (event.state_key !== undefined) this.applyState(roomId, event);
      }
      const count = data.summary?.['m.joined_member_count'];
      if (typeof count === 'number') this.roomMemberCounts.set(roomId, count);
      const heroes = data.summary?.['m.heroes'];
      if (!this.roomNames.has(roomId) && Array.isArray(heroes) && heroes.length > 0) {
        this.roomNames.set(roomId, heroes.map((userId) => this.nameOf(userId)).join('、'));
      }
    }
    // 没有名字的房间也要留在表里：用房间号兜底，否则它既不回填也不出现在工具的输出里。
    for (const roomId of Object.keys(joined)) await this.ensureRoomName(roomId);
    // 启动时挂着的邀请也要接受：只处理「已加入」的话，重启期间来的邀请永远进不去。
    await this.handleInvites(response);
    await this.backfill();
  }

  /**
   * 从服务端把房间清单、名字、成员与加密状态拉一遍。
   * 这一步不依赖 sync：重启时带着上次的 next_batch，sync 只会回新事件，不会重放房间。
   */
  private async loadRooms(): Promise<void> {
    const client = this.client;
    if (!client) return;
    let rooms: string[];
    try {
      rooms = await client.joinedRooms();
    } catch (error) {
      this.logger().warn('读房间列表失败', { error: message(error) });
      return;
    }
    try {
      this.logger().debug('joinedRooms', { ids: rooms });
      for (const roomId of rooms) {
        await this.ensureRoomName(roomId);
        const encryption = await client.roomState(roomId, 'm.room.encryption').catch(() => null);
        if (encryption) this.roomEncrypted.add(roomId);
        const members = await client.joinedMembers(roomId).catch(() => null);
        if (!members) continue;
        const map = new Map<string, string>();
        for (const [userId, info] of Object.entries(members)) {
          map.set(userId, String(info.display_name ?? '').trim() || localpart(userId));
        }
        this.roomMembers.set(roomId, map);
        this.roomMemberCounts.set(roomId, map.size);
      }
    } catch (error) {
      this.logger().warn('读房间状态失败', { error: message(error) });
    }
  }

  /**
   * 起加密层。`on` 模式下起不来就退回明文并记下原因；`strict` 模式下起不来等于什么都做不了，
   * 但 World 照常连着——面板要能显示原因，人也才有机会改配置。
   */
  private async startCrypto(): Promise<void> {
    if (this.crypto || this.cryptoState === 'ready') return;
    if (this.opts.cfg.encryption === 'off') {
      this.cryptoState = 'off';
      this.cryptoError = '';
      return;
    }
    const factory = this.opts.cryptoFactory ?? loadCrypto;
    try {
      const layer = await factory({
        homeserver: this.opts.cfg.homeserver,
        accessToken: this.opts.cfg.accessToken,
        dataDir: this.opts.dataDir,
        log: this.logger(),
        userId: this.selfUserId,
        // 换设备就得换加密库：旧库里的身份会顶替新设备，密钥全挂错地方。
        deviceId: this.selfDeviceId,
      });
      if (!layer) {
        this.cryptoState = 'missing';
        this.cryptoError = '没有装 matrix-bot-sdk（pnpm add matrix-bot-sdk），或原生模块加载失败';
        this.logger().warn('加密层没起来', { reason: this.cryptoError });
        return;
      }
      await withTimeout(layer.prepare([...this.roomNames.keys()]), 30_000, '上传设备密钥超时');
      this.crypto = layer;
      this.cryptoState = 'ready';
      this.cryptoError = '';
      // 加密机是房间加不加密的权威来源：state 事件可能没同步到，这里补齐。
      for (const roomId of this.roomNames.keys()) {
        if (await layer.isRoomEncrypted(roomId).catch(() => false)) this.roomEncrypted.add(roomId);
      }
      this.logger().info(
        `端到端加密已就绪 device=${layer.deviceId} ed25519=${layer.ed25519} account=${this.selfUserId ?? '?'}`,
      );
    } catch (error) {
      this.cryptoState = 'failed';
      this.cryptoError = message(error);
      this.logger().warn('加密层启动失败', { error: this.cryptoError });
    }
  }

  /** 房间名缺失时问一次服务端：先 state 里的名字，再规范别名，最后用房间号。 */
  private async ensureRoomName(roomId: string): Promise<void> {
    if (this.roomNames.has(roomId)) return;
    const client = this.client;
    let name: string | null = null;
    if (client) {
      name = await client.roomName(roomId).catch(() => null);
      if (!name) name = await client.roomAlias(roomId).catch(() => null);
    }
    this.roomNames.set(roomId, name || roomId);
    this.history.rememberName(roomId, this.roomNames.get(roomId) ?? roomId);
  }

  /** 解一条加密事件；没有加密层或解不开时返回 null，调用方按 `[加密消息]` 处理。 */
  /**
   * 解一条加密事件。解不开时不立刻放弃：新设备第一次收到某个会话时，
   * 加密机要发密钥请求、等对方客户端把 megolm 会话送过来，这中间有秒级延迟。
   * 每轮先冲一次待发请求（`onSync({})` 会把密钥请求送出去），再重试。
   */
  /** 接受房间邀请；失败只记日志，不影响别的房间。 */
  private async acceptInvite(roomId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      await client.joinRoom(roomId);
      this.logger().info('已接受房间邀请', { roomId });
    } catch (error) {
      this.logger().warn('接受房间邀请失败', { roomId, error: message(error) });
    }
  }

  private async decryptEvent(roomId: string, event: MatrixEvent): Promise<MatrixEvent | null> {
    const crypto = this.crypto;
    if (!crypto) return null;
    const retries = Math.max(1, this.opts.decryptRetries ?? 3);
    const delay = Math.max(0, this.opts.decryptDelayMs ?? 2000);
    for (let attempt = 0; attempt < retries; attempt += 1) {
      const decrypted = await crypto.decryptEvent(roomId, event);
      if (decrypted) return decrypted;
      if (attempt === retries - 1) break;
      // 把这一轮攒下的密钥请求发出去，然后给对面一点时间回应。
      await crypto.onSync({ next_batch: '' }).catch(() => {});
      await sleep(delay);
    }
    this.logger().warn('加密消息解不开（多半是对方客户端没在线分发密钥）', {
      roomId,
      eventId: event.event_id,
      senderKey: (event.content as { sender_key?: string })?.sender_key,
      sessionId: (event.content as { session_id?: string })?.session_id,
      algorithm: (event.content as { algorithm?: string })?.algorithm,
    });
    return null;
  }

  /** 这个房间要不要加密发送。加密机说了算；没有加密机时退回 state 里的标记。 */
  private async roomNeedsEncryption(roomId: string): Promise<boolean> {
    // state 事件已经确认这个房间加密，就别再问加密机：它只认 sync 里喂过的 state，
    // 重启后那张表可能是空的，会把加密房间当明文，于是往加密房间里发明文事件——
    // 表现就是发送失败（服务端报 no forward extremities），或者别人读不了。
    if (this.roomEncrypted.has(roomId)) return true;
    const crypto = this.crypto;
    if (!crypto) return false;
    try {
      const encrypted = await crypto.isRoomEncrypted(roomId);
      if (encrypted) this.roomEncrypted.add(roomId);
      return encrypted;
    } catch {
      return false;
    }
  }

  /** 当前策略下这个房间能不能跟 Coo 说话。强制模式下只认加密房间。 */
  private async roomAllowed(roomId: string): Promise<boolean> {
    if (this.opts.cfg.encryption !== 'strict') return true;
    return this.roomNeedsEncryption(roomId);
  }

  /** 状态行与面板共用的一句话：已启用 / 启用失败-原因 / 未启用。 */
  private cryptoLabel(): string {
    switch (this.cryptoState) {
      case 'ready':
        return `已启用（设备 ${this.crypto?.deviceId ?? '未知'}）`;
      case 'missing':
      case 'failed':
        return `启用失败：${this.cryptoError || '原因未知'}`;
      default:
        return this.opts.cfg.encryption === 'off' ? '未启用（配置里关掉了）' : '未启用';
    }
  }

  /** 从服务端拉每个监听房间最近的若干条进记录。回填不产生唤醒事件。 */
  private async backfill(): Promise<void> {
    const limit = Math.floor(this.opts.cfg.backfillLimit);
    if (limit <= 0 || !this.client) return;
    const roster = parseRoomRoster(this.opts.cfg.listenRooms);
    for (const roomId of this.roomNames.keys()) {
      if (!rosterAllows(roster, roomId)) continue;
      let events: MatrixEvent[];
      try {
        events = await this.client.messages(roomId, limit);
      } catch (error) {
        this.logger().warn('回填历史失败', { roomId, error: message(error) });
        continue;
      }
      for (const event of events) {
        if (!event.event_id) continue;
        // 回填的也可能是加密消息：先解再渲染，否则记录里全是 `[加密消息]`。
        const resolved =
          event.type === 'm.room.encrypted' ? ((await this.decryptEvent(roomId, event)) ?? event) : event;
        const rendered = renderEvent(resolved, { selfUserId: this.selfUserId, selfName: this.selfName });
        if (!rendered || !rendered.text) continue;
        this.recordIncoming(roomId, resolved, rendered.text, resolved.sender === this.selfUserId);
      }
    }
  }

  /** 处理邀请：记下房间、通知 Coo、接受邀请。启动时的初始同步与增量同步都要走这里。 */
  private async handleInvites(response: SyncResponse): Promise<void> {
    const invited = response.rooms?.invite ?? {};
    for (const [roomId, data] of Object.entries(invited)) {
      const events = data.invite_state?.events ?? [];
      const name = events.find((event) => event.type === 'm.room.name')?.content?.name;
      const inviter = events.find(
        (event) => event.type === 'm.room.member' && event.state_key === this.selfUserId,
      )?.sender;
      // 邀请里能看出房间加不加密：强制模式下只报加密房间的邀请。
      const encrypted = events.some((event) => event.type === 'm.room.encryption');
      if (encrypted) this.roomEncrypted.add(roomId);
      this.roomNames.set(roomId, String(name ?? roomId));
      this.enqueueInvite(roomId, String(name ?? roomId), inviter ?? '', encrypted);
      // 光被邀请进不了房间：没接受之前往它发消息，服务端会报
      // 「no forward extremities」。所以邀请到手就接受。
      void this.acceptInvite(roomId);
    }
  }

  /** 一次增量同步：状态、时间线、邀请。 */
  private async handleSync(response: SyncResponse): Promise<void> {
    const joined = response.rooms?.join ?? {};
    for (const [roomId, data] of Object.entries(joined)) {
      for (const event of data.state?.events ?? []) this.applyState(roomId, event);
      const count = data.summary?.['m.joined_member_count'];
      if (typeof count === 'number') this.roomMemberCounts.set(roomId, count);
      // 运行中新加入的房间也要有名字，否则工具里只看得到房间号。
      if (!this.roomNames.has(roomId)) void this.ensureRoomName(roomId);
      for (const event of data.timeline?.events ?? []) this.enqueue(roomId, event);
    }
    await this.handleInvites(response);
  }

  // ---- 事件分发 ----

  /** 消息按到达顺序处理；图片下载与转写不占这条队列。 */
  private enqueue(roomId: string, event: MatrixEvent): void {
    this.chain = this.chain
      .then(() => this.handleEvent(roomId, event))
      .catch((error: unknown) => {
        this.lastError = message(error);
        this.logger().warn('处理事件失败', { error: this.lastError });
      });
  }

  private async handleEvent(roomId: string, raw: MatrixEvent): Promise<void> {
    if (this.stopped) return;
    // 加密机靠原始事件跟踪 megolm 会话轮换，解密之前先喂一次。
    if (this.crypto) await this.crypto.onRoomEvent(roomId, raw).catch(() => {});
    const event = raw.type === 'm.room.encrypted' ? ((await this.decryptEvent(roomId, raw)) ?? raw) : raw;
    const type = event.type;
    const sender = event.sender ?? '';
    const content = event.content ?? {};

    if (type === 'm.room.member') {
      this.applyMember(roomId, event);
      await this.noticeMember(roomId, event);
      return;
    }
    if (type === 'm.room.name') {
      const name = String(content.name ?? '').trim();
      if (!name) return;
      this.roomNames.set(roomId, name);
      this.history.rememberName(roomId, name);
      await this.notice(roomId, 'room_name', sender, { detail: name });
      return;
    }
    if (type === 'm.room.topic') {
      const topic = String(content.topic ?? '').trim();
      if (!topic) return;
      await this.notice(roomId, 'room_topic', sender, { detail: topic });
      return;
    }
    if (type === 'm.room.encryption') {
      if (this.roomEncrypted.has(roomId)) return;
      this.roomEncrypted.add(roomId);
      await this.notice(roomId, 'room_encryption', sender, {});
      return;
    }
    if (type === 'm.room.redaction') {
      const target = String(content.redacts ?? (event as unknown as { redacts?: string }).redacts ?? '');
      const original = this.history.find(target)?.text;
      await this.notice(roomId, 'redaction', sender, { target, detail: original });
      return;
    }
    if (type === 'm.reaction') {
      const relates = (content['m.relates_to'] ?? {}) as { event_id?: string; key?: string };
      await this.notice(roomId, 'reaction', sender, { target: String(relates.event_id ?? ''), detail: String(relates.key ?? '') });
      return;
    }
    if (type === 'm.typing' || type === 'm.receipt' || type === 'm.presence' || type.startsWith('m.call')) return;
    if (!type.startsWith('m.room.message') && type !== 'm.sticker' && type !== 'm.room.encrypted') return;

    const rendered = renderEvent(event, { selfUserId: this.selfUserId, selfName: this.selfName });
    if (!rendered || !rendered.text) return;
    const eventId = event.event_id ?? '';
    const isSelf = sender === this.selfUserId;
    const roomName = this.roomName(roomId);
    const senderName = this.nameOf(sender);
    const time = this.timeOf(event.origin_server_ts ?? this.clock());

    this.recordIncoming(roomId, event, rendered.text, isSelf, senderName);

    // 语音先记账：即使这次不叫醒模型，工具也能再转写一次。
    if (eventId) {
      for (const audio of rendered.audio) {
        this.records.set(eventId, {
          eventId,
          roomId,
          roomName,
          senderName,
          at: new Date(event.origin_server_ts ?? this.clock()).toISOString(),
          attempts: 0,
        });
      }
    }

    if (isSelf) return;

    const mentioned = rendered.mentionedSelf || this.repliesToSelf(rendered.replyToId);
    await this.deliver(roomId, event, rendered, senderName, time, mentioned);
  }

  /** 一条入站消息：按开关决定叫不叫醒，图片下载成附件。 */
  private async deliver(
    roomId: string,
    event: MatrixEvent,
    rendered: ReturnType<typeof renderEvent>,
    senderName: string,
    time: string,
    mentioned: boolean,
  ): Promise<void> {
    if (!rendered) return;
    const eventId = event.event_id ?? '';
    const allowed = this.opts.cfg.receiveRooms;
    const mentionOnly = this.opts.cfg.onlyMentionInRoom;
    const inRoster = rosterAllows(parseRoomRoster(this.opts.cfg.listenRooms), roomId) || this.aliasAllowed(roomId);
    if (!inRoster) {
      // 名单外的房间不投递、不转写，但记录照留：历史工具还查得到。
      return;
    }
    // 强制加密模式下，明文房间的消息不叫醒 Coo：记录照留，只是不推。
    if (!(await this.roomAllowed(roomId))) return;
    const shouldWake = allowed && (!mentionOnly || mentioned);
    if (!shouldWake) return;

    // `here` 只跟随真叫醒过模型的房间：名单外或推送关着时，不该把「你在跟谁说话」悄悄改掉。
    this.lastRoomId = roomId;
    if (eventId) this.lastIncomingByRoom.set(roomId, eventId);
    const { blobs, missed } = await this.imageBlobs(rendered.images, eventId);
    const line = renderIncoming({
      roomName: this.roomName(roomId),
      time,
      senderName,
      senderId: event.sender ?? '',
      body: rendered.text,
      editOf: rendered.editOf,
    });
    // 图片没拿到时要说出来：否则正文里的链接看起来像「你能看见这张图」。
    const note = missed > 0 ? `（其中 ${missed} 张图片没能附上，看不到内容）` : '';
    await this.push({
      type: 'matrix.message',
      text: note ? `${line}${note}` : line,
      roomId,
      mentioned,
      blobs,
      meta: { eventId, room: conversationKey(roomId) },
    });

    // 表情包学进图库：只在开关打开且拿得到地址时做。
    if (this.opts.cfg.sticker.enabled && this.opts.cfg.sticker.learnFromMatrix) {
      for (const sticker of rendered.stickers) void this.learnSticker(sticker);
    }

    // 转写不阻塞后续消息；关掉的通道既不推消息，也不该把转写结果另发一条事件。
    if (this.opts.cfg.voice.enabled && this.opts.cfg.voice.autoTranscribe) {
      for (const audio of rendered.audio) void this.transcribeLater(eventId, audio.mxc, audio.mimetype, roomId, audio.file);
    }
  }

  private async notice(
    roomId: string,
    kind: Parameters<typeof renderNotice>[0]['kind'],
    actor: string,
    extra: { target?: string; detail?: string },
  ): Promise<void> {
    if (!this.opts.cfg.receiveRooms) return;
    if (!rosterAllows(parseRoomRoster(this.opts.cfg.listenRooms), roomId) && !this.aliasAllowed(roomId)) return;
    if (actor === this.selfUserId) return;
    if (!(await this.roomAllowed(roomId))) return;
    await this.push({
      type: noticeTypeOf(kind),
      text: renderNotice({
        kind,
        time: this.timeOf(this.clock()),
        roomName: this.roomName(roomId),
        actorName: this.nameOf(actor),
        actorId: actor,
        target: extra.target,
        detail: extra.detail,
      }),
      roomId,
      mentioned: false,
      meta: { room: conversationKey(roomId) },
    });
  }

  private async noticeMember(roomId: string, event: MatrixEvent): Promise<void> {
    const membership = String((event.content ?? {}).membership ?? '');
    const target = String(event.state_key ?? '');
    // 自己加入房间这件事不用告诉 Coo：它本来就知道自己在哪儿。
    if (membership === 'join' && target === this.selfUserId) return;
    // 邀请自己进房间由 sync 的 invite 段单独投递，这里再来一条就重复了。
    if (membership === 'invite' && target === this.selfUserId) return;
    const kind =
      membership === 'join' ? 'member_join'
      : membership === 'leave' ? 'member_leave'
      : membership === 'invite' ? 'member_invite'
      : membership === 'ban' ? 'member_ban'
      : null;
    if (!kind) return;
    await this.notice(roomId, kind, event.sender ?? '', { target: `${this.nameOf(target)}(${target})` });
  }

  private enqueueInvite(roomId: string, roomName: string, inviter: string, encrypted: boolean): void {
    if (!this.opts.cfg.receiveRooms) return;
    if (!rosterAllows(parseRoomRoster(this.opts.cfg.listenRooms), roomId)) return;
    // 强制模式下明文房间的邀请也不报：Coo 进去也没法说话。
    if (this.opts.cfg.encryption === 'strict' && !encrypted) return;
    this.chain = this.chain
      .then(async () => {
        await this.push({
          type: 'matrix.member',
          text: renderNotice({
            kind: 'member_invite',
            time: this.timeOf(this.clock()),
            roomName,
            actorName: this.nameOf(inviter),
            actorId: inviter,
            target: `${this.nameOf(this.selfUserId)}(${this.selfUserId})`,
            detail: `房间 ${roomId}`,
          }),
          roomId,
          mentioned: true,
          meta: { room: conversationKey(roomId) },
        });
      })
      .catch(() => {});
  }

  private async push(input: {
    type: string;
    text: string;
    roomId: string;
    mentioned: boolean;
    blobs?: BlobInput[];
    meta?: Record<string, unknown>;
  }): Promise<void> {
    const host = this.host;
    if (!host || !input.text) return;
    const trigger = input.mentioned ? 'flush' : 'debounce';
    try {
      await host.pushEvent(
        {
          type: input.type,
          ts: nowIso(this.opts.timezone),
          source: this.id,
          senderKey: conversationKey(input.roomId),
          text: input.text,
          blobs: input.blobs,
          meta: input.meta,
        },
        { trigger },
      );
    } catch (error) {
      this.lastError = message(error);
      this.logger().warn('投递事件失败', { error: this.lastError });
    }
  }

  // ---- 状态与成员 ----

  private applyState(roomId: string, event: MatrixEvent): void {
    const content = event.content ?? {};
    if (event.type === 'm.room.member') {
      this.applyMember(roomId, event);
      return;
    }
    if (event.type === 'm.room.name') {
      const name = String(content.name ?? '').trim();
      if (name) {
        this.roomNames.set(roomId, name);
        this.history.rememberName(roomId, name);
      }
      return;
    }
    if (event.type === 'm.room.canonical_alias') {
      const alias = String(content.alias ?? '').trim();
      if (alias) this.roomAliases.set(roomId, alias);
      return;
    }
    if (event.type === 'm.room.encryption') {
      this.roomEncrypted.add(roomId);
    }
  }

  private applyMember(roomId: string, event: MatrixEvent): void {
    const userId = String(event.state_key ?? '');
    if (!userId) return;
    const content = event.content ?? {};
    const membership = String(content.membership ?? '');
    const displayName = String(content.displayname ?? '').trim() || localpart(userId);
    let members = this.roomMembers.get(roomId);
    if (!members) {
      members = new Map();
      this.roomMembers.set(roomId, members);
    }
    if (membership === 'join' || membership === 'invite') {
      members.set(userId, displayName);
      this.roomMemberCounts.set(roomId, members.size);
    } else {
      members.delete(userId);
      this.roomMemberCounts.set(roomId, members.size);
    }
    if (userId === this.selfUserId) {
      this.selfName = displayName;
      this.history.rememberName(roomId, this.roomName(roomId));
    }
  }

  private nameOf(userId: string): string {
    if (!userId) return '';
    if (userId === this.selfUserId && this.selfName) return this.selfName;
    for (const members of this.roomMembers.values()) {
      const found = members.get(userId);
      if (found) return found;
    }
    return localpart(userId);
  }

  private roomName(roomId: string): string {
    return this.roomNames.get(roomId) ?? this.history.nameOf(roomId) ?? roomId;
  }

  /** 名单里写的是别名时，也认它对应的房间。 */
  private aliasAllowed(roomId: string): boolean {
    const roster = parseRoomRoster(this.opts.cfg.listenRooms);
    if (roster === null) return true;
    const alias = this.roomAliases.get(roomId);
    return Boolean(alias && roster.has(alias));
  }

  private repliesToSelf(replyTo?: string): boolean {
    if (!replyTo) return false;
    return this.history.find(replyTo)?.self === true;
  }

  private recordIncoming(roomId: string, event: MatrixEvent, text: string, self: boolean, senderName?: string): void {
    const eventId = event.event_id ?? '';
    if (!eventId) return;
    const sender = event.sender ?? '';
    this.history.append({
      eventId,
      roomId,
      userId: sender,
      userName: self ? this.selfName || '你' : senderName ?? this.nameOf(sender),
      at: new Date(event.origin_server_ts ?? this.clock()).toISOString(),
      text,
      self,
      roomName: this.roomName(roomId),
    });
  }

  // ---- 图片与语音 ----

  /**
   * 下载图片做成附件。
   *
   * 返回没能附上的张数 `missed`：超时、404（媒体按保留策略清掉了）、太大、
   * 当前模型不收这种格式都算。调用方要把这个数写进正文。
   */
  private async imageBlobs(
    images: MediaRef[],
    eventId: string,
  ): Promise<{ blobs?: BlobInput[]; missed: number }> {
    if (!this.opts.cfg.imageToModel || images.length === 0) return { missed: 0 };
    // 粗筛：模型一张图都不收时不必下载。
    const acceptsAnyImage = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].some((mime) =>
      this.takesImages(mime),
    );
    if (!acceptsAnyImage) return { missed: images.length };

    const out: BlobInput[] = [];
    const targets = images.slice(0, MAX_IMAGE_ATTACHMENTS);
    let missed = images.length - targets.length;
    for (const image of targets) {
      if (!image.mxc.startsWith('mxc://')) {
        missed += 1;
        continue;
      }
      const downloaded = await this.downloadMedia(image.mxc, eventId, image.file);
      if (!downloaded) {
        missed += 1;
        continue;
      }

      let { bytes, mime } = downloaded;
      if (!mime) mime = image.mimetype || guessImageMime(image.name, 'image/jpeg');
      if (!mime.startsWith('image/')) {
        missed += 1;
        continue;
      }
      // 原图常有 3–10MB：先缩到模型吃得下的尺寸，缩不动再决定要不要退回原图。
      if (bytes.byteLength > IMAGE_TARGET_BYTES) {
        const shrunk = await this.shrink(bytes, mime, eventId);
        if (shrunk) {
          bytes = shrunk.bytes;
          mime = shrunk.mime;
        } else if (bytes.byteLength > IMAGE_FALLBACK_BYTES) {
          missed += 1;
          this.logger().warn('图片太大且缩图失败', { eventId, bytes: bytes.byteLength });
          continue;
        }
      }
      if (!this.takesImages(mime)) {
        // 动图多数模型不收，抽一帧静图顶替；其他格式就只能放弃。
        const frame = mime === 'image/gif' ? await this.firstFrame(bytes) : null;
        if (!frame) {
          missed += 1;
          continue;
        }
        bytes = frame;
        mime = 'image/png';
      }
      out.push({
        bytes,
        mime,
        name: image.sticker ? 'matrix-sticker' : 'matrix-image',
        fallbackText: image.sticker ? '[表情包]' : '[图片]',
      });
    }
    return { blobs: out.length ? out : undefined, missed };
  }

  /**
   * 取一份媒体。加密附件传 `file`：下载下来的是密文，要先用加密机解开，
   * 真实 MIME 也在 `file.mimetype` 里而不是响应的 content-type。
   */
  private async downloadMedia(
    mxc: string,
    eventId: string,
    file?: Record<string, unknown>,
  ): Promise<{ bytes: Uint8Array; mime: string } | null> {
    const client = this.client;
    if (!client) return null;
    try {
      const got = await client.download(mxc);
      if (got.bytes.byteLength === 0) return null;
      if (got.bytes.byteLength > MAX_IMAGE_BYTES) {
        this.logger().warn('媒体太大，不下载', { eventId, bytes: got.bytes.byteLength });
        return null;
      }
      if (!file) return got;
      const crypto = this.crypto;
      if (!crypto) {
        this.logger().warn('加密附件需要 matrix-bot-sdk 才能解开', { eventId });
        return null;
      }
      const plain = await crypto.decryptMedia(file);
      if (!plain) {
        this.logger().warn('加密附件解不开', { eventId });
        return null;
      }
      return { bytes: plain, mime: String(file.mimetype ?? got.mime ?? '') };
    } catch (error) {
      this.logger().warn('媒体没能取到', { eventId, reason: message(error) });
      return null;
    }
  }

  takesImages(mime = 'image/jpeg'): boolean {
    try {
      return this.host?.modelFacts.accepts(mime) ?? false;
    } catch {
      return false;
    }
  }

  /** 把过大的一张图缩成模型吃得下的 JPEG：先 ffmpeg，再 Windows 自带的 System.Drawing。 */
  private async shrink(
    bytes: Uint8Array,
    mime: string,
    eventId: string,
  ): Promise<{ bytes: Uint8Array; mime: string } | null> {
    if (this.opts.shrinkImage) return this.opts.shrinkImage(bytes, mime);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = join(this.opts.dataDir, 'voice');
    const input = join(dir, `${stamp}${extensionOfMime(mime)}`);
    const output = join(dir, `${stamp}-small.jpg`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(input, bytes);

      const ffmpeg = await this.voice.ffmpeg();
      if (ffmpeg) {
        const result = await run(
          ffmpeg,
          ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vf', `scale='min(${IMAGE_MAX_EDGE},iw)':-2`, '-q:v', '3', output],
          30_000,
        );
        const shrunk = result.ok ? await readImageFile(output) : null;
        if (shrunk) return shrunk;
      }

      if (process.platform === 'win32') {
        const script = fileURLToPath(new URL('../scripts/shrink-image.ps1', import.meta.url));
        const result = await run(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-InPath', input, '-OutPath', output, '-MaxEdge', String(IMAGE_MAX_EDGE), '-Quality', '82'],
          30_000,
        );
        const shrunk = result.ok ? await readImageFile(output) : null;
        if (shrunk) return shrunk;
        this.logger().warn('图片缩图失败', { eventId, error: result.stderr.trim().slice(-200) });
      }
      return null;
    } catch (error) {
      this.logger().warn('图片缩图失败', { eventId, error: message(error) });
      return null;
    } finally {
      void rm(input, { force: true }).catch(() => {});
      void rm(output, { force: true }).catch(() => {});
    }
  }

  /** 用 ffmpeg 取动图的第一帧；没有 ffmpeg 就返回 null，由调用方只留占位。 */
  private async firstFrame(bytes: Uint8Array): Promise<Uint8Array | null> {
    const ffmpeg = await this.voice.ffmpeg();
    if (!ffmpeg) return null;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = join(this.opts.dataDir, 'voice');
    const input = join(dir, `${stamp}.gif`);
    const output = join(dir, `${stamp}.png`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(input, bytes);
      const result = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1', output], 20_000);
      if (!result.ok) return null;
      const frame = await readFile(output);
      return new Uint8Array(frame);
    } catch {
      return null;
    } finally {
      void rm(input, { force: true }).catch(() => {});
      void rm(output, { force: true }).catch(() => {});
    }
  }

  private async learnSticker(sticker: { mxc: string; name: string; file?: Record<string, unknown> }): Promise<void> {
    if (!sticker.mxc.startsWith('mxc://')) return;
    const got = await this.downloadMedia(sticker.mxc, 'sticker', sticker.file);
    if (!got) return;
    const mime = got.mime || guessImageMime(sticker.name);
    if (!mime.startsWith('image/')) return;
    await this.stickers.learn(sticker.name || mediaNameOf(sticker.mxc), got.bytes, mime);
  }

  private async transcribeLater(
    eventId: string,
    mxc: string,
    mimetype: string | undefined,
    roomId: string,
    file?: Record<string, unknown>,
  ): Promise<void> {
    const context = this.records.get(eventId);
    if (!context || context.attempts > 0) return;
    // 关掉的通道不转写：省一次识别调用，也不产生事件。
    if (!this.opts.cfg.receiveRooms) return;
    context.attempts += 1;
    const result = await this.transcribe(eventId, mxc, mimetype, file);
    const host = this.host;
    if (!host) return;
    // 转写要等几秒，这期间开关可能被关掉：推送前再看一眼。
    if (!this.opts.cfg.receiveRooms) return;
    if (!result.ok) context.lastError = result.reason;
    const text = renderTranscript({
      roomName: context.roomName,
      time: this.timeOf(this.clock()),
      senderName: context.senderName,
      ok: result.ok,
      text: result.ok ? result.text : undefined,
      reason: result.ok ? undefined : result.reason,
    });
    try {
      await host.pushEvent(
        {
          type: 'matrix.transcript',
          ts: nowIso(this.opts.timezone),
          source: this.id,
          senderKey: conversationKey(roomId),
          text,
          meta: { eventId },
        },
        { trigger: 'flush' },
      );
    } catch {
      // 转写结果投不进去时记录里还有上一次的错误说明。
    }
  }

  private async transcribe(eventId: string, mxc: string, mimetype?: string, file?: Record<string, unknown>) {
    const got = await this.downloadMedia(mxc, eventId, file);
    if (!got) return { ok: false as const, reason: '语音文件没取下来' };
    return this.voice.transcribe(got.bytes, got.mime || mimetype || 'audio/ogg', eventId);
  }

  // ---- 发送 ----

  async send(request: SendRequest): Promise<SendResult> {
    // 关掉的通道双向生效：既然设定了不收，也就不在这里发——否则一不小心就在房间里冒出一句。
    if (!this.opts.cfg.receiveRooms) {
      return {
        ok: false,
        error: `房间推送关着，这条没有发出去（${this.roomLabel(request.roomId)}）。要往这里发，先在面板「连接与开关」里打开「接收房间消息」。`,
      };
    }
    const client = this.client;
    if (!client) return { ok: false, error: '还没有连上 Matrix' };
    if (this.status.state !== 'online') {
      return { ok: false, error: `连接状态是「${this.status.detail}」，这条没有发出去。` };
    }

    const roomId = await this.resolveRoomId(request.roomId);
    if (!roomId) return { ok: false, error: `房间「${request.roomId}」解析不出房间号。` };
    // 加密房间要 olm/megolm：有加密层就加密发送，没有就拦下——发明文进去别人读不了。
    const encrypted = await this.roomNeedsEncryption(roomId);
    this.logger().debug('发送前判断', { encrypted, roomId, known: [...this.roomEncrypted] });
    if (this.opts.cfg.encryption === 'strict' && !encrypted) {
      return {
        ok: false,
        error: `由于安全策略，禁止连接非加密房间（${this.roomLabel(roomId)}）。要在这里说话，先在客户端里给房间开加密。`,
      };
    }
    if (encrypted && !this.crypto) {
      return {
        ok: false,
        error: `${this.roomLabel(roomId)}开了端到端加密，但加密层没起来（${this.cryptoLabel()}），发不出别人能读的消息。`,
      };
    }

    const ids: string[] = [];
    try {
      for (const part of request.parts) {
        if (part.kind === 'text') {
          for (const chunk of splitText(part.text, MAX_MESSAGE_BYTES)) {
            const content = this.textContent(chunk, request);
            ids.push(await this.sendContent(roomId, 'm.room.message', content, encrypted));
          }
          continue;
        }
        if (part.kind === 'audio') {
          const info: Record<string, unknown> = { mimetype: part.mime, size: part.bytes.byteLength };
          if (part.durationMs && part.durationMs > 0) info.duration = Math.round(part.durationMs);
          const media = await this.uploadMedia(part.bytes, part.mime, `voice${extensionOfMime(part.mime)}`, encrypted);
          const content = media.file
            ? { msgtype: 'm.audio', body: 'voice', file: media.file }
            : { msgtype: 'm.audio', body: 'voice', url: media.url, info };
          ids.push(await this.sendContent(roomId, 'm.room.message', content, encrypted));
          continue;
        }
        const info: Record<string, unknown> = { mimetype: part.mime, size: part.bytes.byteLength };
        const media = await this.uploadMedia(
          part.bytes,
          part.mime,
          `${part.name || 'image'}${extensionOfMime(part.mime)}`,
          encrypted,
        );
        if (part.sticker) {
          const content = media.file
            ? { body: part.name || 'sticker', file: media.file }
            : { body: part.name || 'sticker', url: media.url, info };
          ids.push(await this.sendContent(roomId, 'm.sticker', content, encrypted));
        } else {
          const content = media.file
            ? { msgtype: 'm.image', body: part.name || 'image', file: media.file }
            : { msgtype: 'm.image', body: part.name || 'image', url: media.url, info };
          ids.push(await this.sendContent(roomId, 'm.room.message', content, encrypted));
        }
      }
    } catch (error) {
      const reason = message(error);
      this.lastError = reason;
      return { ok: false, error: reason, eventIds: ids.length ? ids : undefined };
    }

    const last = ids[ids.length - 1];
    if (last) {
      this.lastSelfByRoom.set(roomId, last);
      this.lastSelfRoomId = roomId;
      this.history.append({
        eventId: last,
        roomId,
        userId: this.selfUserId,
        userName: this.selfName || '你',
        at: new Date(this.clock()).toISOString(),
        text: request.text,
        self: true,
        roomName: this.roomName(roomId),
      });
    }
    return { ok: true, eventIds: ids };
  }

  /** 文本事件的 content：引用、提及与分片后的正文。 */
  private textContent(text: string, request: SendRequest): Record<string, unknown> {
    const content: Record<string, unknown> = { msgtype: 'm.text', body: text };
    if (request.replyTo) {
      content['m.relates_to'] = { 'm.in_reply_to': { event_id: request.replyTo } };
    }
    if (request.mention) {
      content['m.mentions'] = { user_ids: [request.mention] };
      const pill = `<a href="https://matrix.to/#/${encodeSegment(request.mention)}">${escapeHtml(this.nameOf(request.mention))}</a>`;
      const local = `@${localpart(request.mention)}`;
      const html = escapeHtml(text).split(local).join(pill);
      content.format = 'org.matrix.custom.html';
      content.formatted_body = html;
    }
    return content;
  }

  /** 发一条事件；加密房间里先加密内容，再以 `m.room.encrypted` 发出去。 */
  private async sendContent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
    encrypted: boolean,
  ): Promise<string> {
    const client = this.client;
    if (!client) throw new Error('还没有连上 Matrix');
    const id = await this.sendWithRetry(roomId, eventType, content, encrypted);
    if (encrypted && this.crypto) {
      // 加密机把 megolm 会话的分享排进待发队列，要等下一次 updateSyncData 才真正发出去。
      // 不立刻冲一次的话，对方要等到下一个 sync（最长 90 秒）才解得开。
      await this.crypto.onSync({ next_batch: '' }).catch(() => {});
    }
    return id;
  }

  /**
   * 发一条事件，遇到「房间暂时写不进去」就等一会儿重试。
   *
   * tuwunel 2.0.0 在客户端刚启动的十几秒里，房间的 forward extremities 索引会是空的，
   * 这段时间内任何发送都会被拒；十几秒后自己恢复。等一等再发，比把失败写进回执好。
   */
  private async sendWithRetry(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
    encrypted: boolean,
  ): Promise<string> {
    const client = this.client;
    if (!client) throw new Error('还没有连上 Matrix');
    const retries = Math.max(1, this.opts.sendRetries ?? 4);
    const delay = Math.max(0, this.opts.sendRetryDelayMs ?? 5000);
    for (let attempt = 0; ; attempt += 1) {
      try {
        if (!encrypted || !this.crypto) return await client.sendEvent(roomId, eventType, content);
        const payload = await this.crypto.encryptEvent(roomId, eventType, content);
        return await client.sendEvent(roomId, 'm.room.encrypted', payload);
      } catch (error) {
        const reason = message(error);
        const transient = /forward extremities|M_UNKNOWN|限流|M_LIMIT_EXCEEDED/.test(reason);
        if (!transient || attempt >= retries - 1) throw error;
        this.logger().warn('房间暂时写不进去，等一会儿重试', { roomId, attempt: attempt + 1, delay, reason });
        await sleep(delay);
      }
    }
  }

  /** 上传附件；加密房间里先加密字节，返回的 `file` 要写进事件内容。 */
  private async uploadMedia(
    bytes: Uint8Array,
    mime: string,
    filename: string,
    encrypted: boolean,
  ): Promise<{ url: string; file?: Record<string, unknown> }> {
    const client = this.client;
    if (!client) throw new Error('还没有连上 Matrix');
    if (!encrypted || !this.crypto) return { url: await client.upload(bytes, mime, filename) };
    const made = await this.crypto.encryptMedia(bytes);
    const url = await client.upload(made.bytes, 'application/octet-stream', filename);
    return { url, file: { ...made.file, url } };
  }

  async speak(roomId: string, text: string): Promise<SendResult> {
    if (!this.opts.cfg.voice.enabled) return { ok: false, error: '语音没打开' };
    // 先看通道：关着的话没必要先合成一段发不出去的音频。
    if (!this.opts.cfg.receiveRooms) {
      return { ok: false, error: `房间推送关着，语音没有发出去（${this.roomLabel(roomId)}）。` };
    }
    const made = await this.voice.synthesize(text);
    if (!made.ok) return { ok: false, error: made.reason };
    if ('fallbackText' in made) {
      // 合成不了或超长按配置回落成文字：内容不再变成语音，但不能丢。
      return this.send({ roomId, parts: [{ kind: 'text', text }], text });
    }
    return this.send({
      roomId,
      parts: [{ kind: 'audio', bytes: made.bytes, mime: made.mime, name: 'voice', durationMs: made.durationMs }],
      text: `[语音]${text.slice(0, 40)}`,
    });
  }

  async react(roomId: string, eventId: string, emoji: string): Promise<SendResult> {
    if (!this.opts.cfg.receiveRooms) return { ok: false, error: '房间推送关着，没有贴表情。' };
    const client = this.client;
    if (!client) return { ok: false, error: '还没有连上 Matrix' };
    const encrypted = await this.roomNeedsEncryption(roomId);
    if (this.opts.cfg.encryption === 'strict' && !encrypted) {
      return { ok: false, error: `由于安全策略，禁止连接非加密房间（${this.roomLabel(roomId)}）。` };
    }
    if (encrypted && !this.crypto) {
      return { ok: false, error: `${this.roomLabel(roomId)}开了端到端加密，但加密层没起来（${this.cryptoLabel()}），贴的表情别人读不到。` };
    }
    try {
      const content = { 'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key: emoji } };
      const id = await this.sendContent(roomId, 'm.reaction', content, encrypted);
      return { ok: true, eventIds: [id] };
    } catch (error) {
      const reason = message(error);
      this.lastError = reason;
      return { ok: false, error: reason };
    }
  }

  async redact(roomId: string, eventId: string, reason?: string): Promise<SendResult> {
    const client = this.client;
    if (!client) return { ok: false, error: '还没有连上 Matrix' };
    try {
      const id = await client.redact(roomId, eventId, reason);
      return { ok: true, eventIds: [id] };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }

  // ---- ToolContext ----

  config(): MatrixConfigSection {
    return this.opts.cfg;
  }

  get timezone(): string {
    return this.opts.timezone;
  }

  selfId(): string {
    return this.selfUserId;
  }

  connected(): boolean {
    return this.status.state === 'online';
  }

  statusText(): string {
    const cfg = this.opts.cfg;
    const roster = parseRoomRoster(cfg.listenRooms);
    const lines = [
      `连接：${this.status.state} · ${this.status.detail}`,
      `账号：${this.selfUserId ? `${this.selfName || '未知名'}(${this.selfUserId})` : '还没拿到'}`,
      `服务器：${cfg.homeserver || '(未填)'}，长轮询 ${cfg.syncTimeoutMs}ms`,
      `开关：房间推送${cfg.receiveRooms ? '开' : '关'}${cfg.onlyMentionInRoom ? '，只在被提到时推送' : ''}`,
      `监听：${roster ? `${roster.size} 个房间` : '全部房间'}`,
      `房间：${this.roomNames.size} 个${this.roomEncrypted.size ? `，其中 ${this.roomEncrypted.size} 个开了加密` : ''}`,
      `加密：${encryptionModeLabel(this.opts.cfg.encryption)} · ${this.cryptoLabel()}`,
      `表情包：${this.stickers.size} 张${cfg.sticker.enabled ? '' : '（功能关着）'}`,
      `语音：${cfg.voice.enabled ? `开，识别 ${cfg.voice.asr.provider}，合成 ${cfg.voice.tts.provider}` : '关'}`,
      `主动说话：${cfg.proactive.enabled ? `开，今日已开口 ${this.proactiveCounter.count}/${cfg.proactive.maxPerDay}` : '关'}（${this.proactiveReason}）`,
    ];
    if (this.lastError) lines.push(`最近一次错误：${this.lastError}`);
    return lines.join('\n');
  }

  async resolveRoom(token: unknown): Promise<string | null> {
    const text = typeof token === 'string' ? token.trim() : '';
    if (!text || text === 'here') return this.lastRoomId;
    const resolved = await this.resolveRoomId(text);
    return resolved;
  }

  /** 房间号、别名、房间名都能解成房间号。 */
  private async resolveRoomId(token: string): Promise<string | null> {
    // 模型给的房间号可能混进零宽字符、不换行空格之类：肉眼看不见，但会让
    // Set.has 和房间表查找全部落空——表现就是「面板说房间已加密，发送却判明文」。
    const text = token.replace(/[\u200b-\u200f\u2028\u2029\ufeff\u00a0]/g, '').trim();
    if (!text) return null;
    // 先对齐本地房间表：它的键来自 /joined_rooms，才是服务端真正认的那个写法。
    // tuwunel 这个版本返回的房间号可能不带 `:server`，模型手里却常是完整号，
    // 直接拿去发就是 no forward extremities。
    const known = this.matchKnownRoom(text);
    if (known) return known;
    if (isRoomId(text)) return text;
    if (isRoomAlias(text)) {
      if (!this.client) return null;
      try {
        return await this.client.resolveRoom(text);
      } catch (error) {
        this.logger().warn('别名解析失败', { alias: text, error: message(error) });
        return null;
      }
    }
    const exact = [...this.roomNames].find(([, name]) => name === text);
    if (exact) return exact[0];
    const lower = text.toLowerCase();
    const loose = [...this.roomNames].find(([, name]) => name.toLowerCase() === lower);
    if (loose) return loose[0];
    // 记录里出现过的房间名也认。
    const remembered = this.history.rooms().find((room) => room.name === text || room.name.toLowerCase() === lower);
    return remembered?.roomId ?? null;
  }

  /** 把任意写法的房间号对回服务端实际使用的那个；对不上返回 null。 */
  private matchKnownRoom(text: string): string | null {
    if (this.roomNames.has(text)) return text;
    const bare = text.split(':')[0];
    if (!bare) return null;
    for (const id of this.roomNames.keys()) {
      if (id === text) return id;
      if (id.split(':')[0] === bare) return id;
    }
    return null;
  }

  lastRoom(): string | null {
    return this.lastRoomId;
  }

  roomLabel(roomId: string): string {
    return `房间「${this.roomName(roomId)}」(${roomId})`;
  }

  roomOfEvent(eventId: string): string | null {
    return this.history.find(eventId)?.roomId ?? null;
  }

  /** 最近一条叫醒过模型的消息；`roomId` 省略时用 `here`。 */
  lastIncomingEvent(roomId?: string): { roomId: string; eventId: string } | null {
    const target = roomId ?? this.lastRoomId;
    if (!target) return null;
    const eventId = this.lastIncomingByRoom.get(target);
    return eventId ? { roomId: target, eventId } : null;
  }

  /** 自己在这个房间最后发出去的那条。 */
  lastSelfEvent(roomId?: string): { roomId: string; eventId: string } | null {
    const target = roomId ?? this.lastRoomId ?? this.lastSelfRoomId;
    if (!target) return null;
    const eventId = this.lastSelfByRoom.get(target);
    return eventId ? { roomId: target, eventId } : null;
  }

  /**
   * 把提及参数解成完整 userId：完整 id、`@本地名`、显示名都认。
   * 正文里只印显示名，模型要提人时用得上这几种写法。
   */
  resolveUserId(token: string, roomId: string): string | null {
    const text = token.trim();
    if (!text) return null;
    if (isUserId(text)) return text;
    const members = this.roomMembers.get(roomId);
    if (!members) return null;
    const wanted = text.startsWith('@') ? text.slice(1) : text;
    const lower = wanted.toLowerCase();
    for (const [userId, name] of members) {
      if (localpart(userId).toLowerCase() === lower) return userId;
      if (name.toLowerCase() === lower) return userId;
    }
    return null;
  }

  async stickerSearch(query: string, limit: number): Promise<Array<{ id: string; name: string; pack: string }>> {
    if (!this.opts.cfg.sticker.enabled) return [];
    if (this.stickers.size === 0) await this.stickers.scan();
    return this.stickers.search(query, limit).map((entry) => ({ id: entry.id, name: entry.name, pack: entry.pack }));
  }

  async readSticker(id: string): Promise<{ bytes: Uint8Array; mime: string; name: string } | null> {
    return this.stickers.read(id);
  }

  /** 出站图片的字节：http(s)、mxc 地址与本地路径都认。 */
  async imageBytes(source: string): Promise<{ bytes: Uint8Array; mime: string; name: string } | null> {
    const value = source.trim();
    if (!value) return null;
    if (value.startsWith('mxc://')) {
      const client = this.client;
      if (!client) return null;
      try {
        const got = await client.download(value);
        return { bytes: got.bytes, mime: got.mime || 'image/png', name: mediaNameOf(value) };
      } catch {
        return null;
      }
    }
    if (/^https?:\/\//i.test(value)) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        timer.unref?.();
        const response = await fetch(value, { signal: controller.signal, redirect: 'follow' });
        clearTimeout(timer);
        if (!response.ok) return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
        const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
        const name = value.split('/').pop()?.split(/[?#]/)[0] || 'image';
        return { bytes, mime: mime?.startsWith('image/') ? mime : guessImageMime(value, 'image/png'), name };
      } catch {
        return null;
      }
    }
    const path = value.startsWith('file://') ? fileURLToPath(value) : value;
    try {
      const bytes = await readFile(path);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
      return { bytes: new Uint8Array(bytes), mime: guessImageMime(path, 'image/png'), name: path.split(/[\\/]/).pop() || 'image' };
    } catch {
      return null;
    }
  }

  historyText(roomId: string | null, limit: number, around?: string): string {
    if (around) {
      const window = this.history.around(around, Math.floor(limit / 2), Math.floor(limit / 2));
      if (window.length === 0) return `记录里没有 #${around} 这条消息。`;
      return this.formatRecords(window);
    }
    if (!roomId) {
      const all = this.history
        .rooms()
        .slice(0, 5)
        .flatMap((room) => this.history.recent({ roomId: room.roomId }, Math.ceil(limit / 5)));
      if (all.length === 0) return '还没有任何记录。';
      return this.formatRecords(all);
    }
    const messages = this.history.recent({ roomId }, limit);
    if (messages.length === 0) return `${this.roomLabel(roomId)}还没有记录。`;
    return this.formatRecords(messages);
  }

  searchText(keyword: string, context: number, limit: number): string {
    const hits = this.history.search(keyword, context, limit);
    if (hits.length === 0) return `记录里没有「${keyword}」。`;
    const blocks = hits.map((hit) => `命中 #${hit.at.eventId}：\n${this.formatRecords(hit.hits)}`);
    return `${hits.length} 处命中「${keyword}」：\n${blocks.join('\n')}`;
  }

  roomsText(): string {
    if (this.roomNames.size === 0) return '还没有加入任何房间。';
    const roster = parseRoomRoster(this.opts.cfg.listenRooms);
    const lines = [...this.roomNames].map(([roomId, name]) => {
      const count = this.roomMemberCounts.get(roomId);
      const watched = rosterAllows(roster, roomId) || this.aliasAllowed(roomId);
      const encrypted = this.roomEncrypted.has(roomId);
      const blocked = this.opts.cfg.encryption === 'strict' && !encrypted;
      const flags = [
        encrypted ? (this.cryptoState === 'ready' ? '已加密' : '已加密（读不到内容）') : '明文',
        blocked ? '强制加密策略下不可用' : '',
        watched ? (this.opts.cfg.receiveRooms ? '在监听' : '在监听但推送关着') : '不在监听名单',
      ].filter(Boolean);
      // 成员名单要带 userId：正文里只印显示名，提及得靠这里查。
      const members = this.roomMembers.get(roomId);
      const who = members && members.size > 0
        ? [...members].map(([userId, displayName]) => `${displayName}(${userId})`).join('、')
        : count !== undefined ? `${count} 人` : '成员未知';
      return `- 「${name}」 ${roomId} · ${who}${flags.length ? ` · ${flags.join(' · ')}` : ''}`;
    });
    const policy = `加密策略：${encryptionModeLabel(this.opts.cfg.encryption)}（${this.cryptoLabel()}）`;
    return `${policy}\n已加入 ${lines.length} 个房间：\n${lines.join('\n')}`;
  }

  private formatRecords(messages: Array<{ eventId: string; roomName: string; userName: string; userId: string; at: string; text: string; self: boolean }>): string {
    return messages
      .map((record) => {
        const who = record.self ? '你' : record.userName;
        const time = shortTime(this.opts.timezone, new Date(record.at));
        // 记录是查 id 的地方：这里印完整事件 id，正文里不印。
        return `#${record.eventId} [Matrix-${record.roomName} ${time}] ${who}: ${record.text}`;
      })
      .join('\n');
  }

  // ---- 定时状态机 ----

  private startTimers(): void {
    const tick = () => {
      if (this.stopped) return;
      void this.tickProactive();
      const seconds = Math.max(30, Math.floor(this.opts.cfg.proactive.tickSec)) * 1000;
      this.timer = setTimeout(tick, seconds);
      this.timer.unref?.();
    };
    this.timer = setTimeout(tick, Math.max(30, Math.floor(this.opts.cfg.proactive.tickSec)) * 1000);
    this.timer.unref?.();
  }

  private candidates(): ProactiveCandidate[] {
    const cfg = this.opts.cfg;
    const roster = parseRoomRoster(cfg.listenRooms);
    return this.history
      .rooms()
      .filter((room) => rosterAllows(roster, room.roomId) || this.aliasAllowed(room.roomId))
      .map((room) => ({
        roomId: room.roomId,
        name: room.name,
        lastActivityAt: room.lastAt,
        lastFiredAt: this.proactiveCounter.byRoom[conversationKey(room.roomId)] ?? 0,
      }));
  }

  private async tickProactive(): Promise<void> {
    const cfg = this.opts.cfg.proactive;
    if (!cfg.enabled) {
      this.proactiveReason = '未开启';
      return;
    }
    if (!this.opts.cfg.receiveRooms) {
      this.proactiveReason = '房间推送关着';
      return;
    }
    const now = this.clock();
    this.rollCounters(now);
    const candidates = this.candidates();
    const decision = evaluateProactive({
      now,
      timezone: this.opts.timezone,
      activeFrom: cfg.activeFrom,
      activeTo: cfg.activeTo,
      quietMinutes: cfg.quietMinutes,
      minIntervalMinutes: cfg.minIntervalMinutes,
      chance: cfg.chance,
      maxPerDay: cfg.maxPerDay,
      countToday: this.proactiveCounter.count,
      candidates,
      lastFiredAt: this.proactiveCounter.lastFiredAt,
      random: this.random(),
    });
    if (!decision.fire) {
      this.proactiveReason = decision.reason;
      return;
    }
    this.proactiveCounter = markFired(this.proactiveCounter, now, decision.target.roomId);
    this.proactiveReason = `已开口：${decision.target.name}`;
    const host = this.host;
    if (!host) return;
    try {
      await host.pushEvent(
        {
          type: 'matrix.proactive',
          ts: nowIso(this.opts.timezone),
          source: this.id,
          senderKey: conversationKey(decision.target.roomId),
          text: renderProactive({
            now: this.timeOf(now),
            roomName: decision.target.name,
            roomId: decision.target.roomId,
            quietMs: decision.quietMs,
            countToday: this.proactiveCounter.count,
            maxPerDay: cfg.maxPerDay,
            alternatives: decision.alternatives.map((item) => ({ roomName: item.name, roomId: item.roomId })),
          }),
        },
        { trigger: 'flush' },
      );
    } catch (error) {
      this.logger().warn('主动开口投递失败', { error: message(error) });
    }
  }

  // ---- 面板 ----

  private async invoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
    switch (`${panel}/${method}`) {
      case 'connection/status':
        return this.connectionStatus();
      case 'connection/save':
        return this.saveConnection(args[0]);
      case 'connection/switches':
        return this.saveSwitches(args[0]);
      case 'connection/roster':
        return this.saveRoster(args[0]);
      case 'connection/probe':
        return this.probeConnection();
      case 'connection/login':
        return this.loginAccount(args[0]);
      case 'connection/restart': {
        this.opts.restart();
        return { ok: true, note: '已请求重启，新参数会在重启后生效。' };
      }
      case 'rooms/list':
        return this.roomsPanel();
      case 'encryption/status':
        return this.encryptionPanel();
      case 'encryption/deps':
        return this.depsPanel();
      case 'encryption/install':
        return this.startInstall();
      case 'encryption/mode':
        return this.saveEncryptionMode(args[0]);
      case 'encryption/reload': {
        this.opts.restart();
        return { ok: true, note: '已请求重启，加密层会重新加载。' };
      }
      case 'stickers/list':
        return this.stickerList(args[0]);
      case 'stickers/rescan':
        return { ok: true, count: await this.stickers.scan(), packs: this.stickers.packs() };
      case 'proactive/status':
        return this.proactiveStatus();
      case 'proactive/fire':
        return this.fireProactive();
      case 'voice/probe':
        return this.voice.probe();
      default:
        throw new Error(`未知面板方法：${panel}/${method}`);
    }
  }

  /** 连通性自检：先确认令牌有效，再看 sync 能不能立刻回一帧。 */
  private async probeConnection(): Promise<Record<string, unknown>> {
    const cfg = this.opts.cfg;
    const hints: string[] = [];
    const client = this.client;
    if (!client) {
      return {
        ok: false,
        target: cfg.homeserver,
        detail: '还没有建立客户端：World 没启用，或连接参数是空的。',
        hints: ['先在 World 页启用本扩展，并填好服务器地址与访问令牌。'],
      };
    }
    let versions: string[] = [];
    try {
      versions = await client.versions();
    } catch (error) {
      return {
        ok: false,
        target: cfg.homeserver,
        detail: `连不上：${message(error)}`,
        hints: [
          '确认这个地址能打开 /_matrix/client/versions（浏览器里试一下）',
          '反代要放行 /_matrix/ 下的全部路径，并把读超时设得比长轮询时长更大',
        ],
      };
    }
    let account = '';
    try {
      const who = await client.whoami();
      account = who.userId;
    } catch (error) {
      return {
        ok: false,
        target: cfg.homeserver,
        detail: `服务器能连，但令牌无效：${message(error)}`,
        hints: ['访问令牌要带上 Bearer 前缀由扩展自己加，这里只填令牌本身', '令牌被吊销时重新登录一次，把新令牌填进来'],
      };
    }
    let rooms: string[] = [];
    try {
      rooms = await client.joinedRooms();
    } catch (error) {
      hints.push(`读房间列表失败：${message(error)}`);
    }
    if (rooms.length === 0) hints.push('这个账号还没有加入任何房间：先在客户端里把它邀请进来并接受');
    return {
      ok: true,
      target: cfg.homeserver,
      detail: `服务器可用（${versions.slice(-1)[0] ?? '版本未知'}），令牌属于 ${account}，已加入 ${rooms.length} 个房间`,
      hints,
    };
  }

  private connectionStatus(): Record<string, unknown> {
    const cfg = this.opts.cfg;
    return {
      state: this.status.state,
      detail: this.status.detail,
      userId: this.selfUserId,
      displayName: this.selfName,
      homeserver: cfg.homeserver,
      tokenSet: Boolean(cfg.accessToken),
      loginUser: cfg.loginUser ?? '',
      loginDeviceName: cfg.loginDeviceName ?? '',
      syncTimeoutMs: cfg.syncTimeoutMs,
      encryption: cfg.encryption,
      cryptoState: this.cryptoState,
      cryptoLabel: this.cryptoLabel(),
      cryptoError: this.cryptoError,
      cryptoDevice: this.crypto?.deviceId ?? '',
      receiveRooms: cfg.receiveRooms,
      onlyMentionInRoom: cfg.onlyMentionInRoom,
      listenRooms: cfg.listenRooms,
      roomCount: this.roomNames.size,
      lastError: this.lastError,
    };
  }

  private saveConnection(payload: unknown): Record<string, unknown> {
    const body = (payload ?? {}) as Record<string, unknown>;
    const patch: Partial<MatrixConfigSection> = {};
    if (typeof body.homeserver === 'string') patch.homeserver = body.homeserver.trim().replace(/\/+$/, '');
    if (typeof body.accessToken === 'string' && body.accessToken.trim()) patch.accessToken = body.accessToken.trim();
    if (typeof body.syncTimeoutMs === 'number' && Number.isFinite(body.syncTimeoutMs)) {
      patch.syncTimeoutMs = Math.max(1000, Math.min(300_000, Math.round(body.syncTimeoutMs)));
    }
    this.opts.persist(patch);
    this.opts.restart();
    return { ok: true, note: '连接参数已保存，正在重启进程使其生效。' };
  }

  /**
   * 用账号密码登录：服务端会给这一次登录发一个新设备。
   *
   * 这台机器就从此独占这个 device。多台机器各登录一次，各拿各的 device，
   * 不会像共用同一个令牌那样把彼此的加密密钥顶掉。
   */
  private async loginAccount(payload: unknown): Promise<Record<string, unknown>> {
    const body = (payload ?? {}) as Record<string, unknown>;
    const homeserver = String(body.homeserver ?? this.opts.cfg.homeserver ?? '')
      .trim()
      .replace(/\/+$/, '');
    const user = String(body.user ?? '').trim();
    const password = typeof body.password === 'string' ? body.password : '';
    const deviceName = String(body.deviceName ?? '').trim() || `Coopanion@${hostname()}`;
    if (!homeserver) return { ok: false, note: '服务器地址是空的。' };
    if (!user || !password) return { ok: false, note: '账号和密码都要填。' };
    let result;
    try {
      result = await loginWithPassword(homeserver, { user, password, deviceName });
    } catch (error) {
      const err = error as { errcode?: string; status?: number; message?: string };
      if (err.errcode === 'M_FORBIDDEN' || err.status === 403) return { ok: false, note: '账号或密码不对。' };
      if (err.errcode === 'M_USER_DEACTIVATED') return { ok: false, note: '这个账号已停用。' };
      if (err.errcode === 'M_UNRECOGNIZED' || err.errcode === 'M_NOT_FOUND' || err.status === 404) {
        return { ok: false, note: '这个地址不支持密码登录，确认填的是 Matrix 客户端-服务器 API 的基址。' };
      }
      return { ok: false, note: `登录失败：${err.message ?? String(error)}` };
    }
    // 换了设备，旧加密库就作废了。挪走而不是删掉：真要翻回来还有东西可看。
    const retired = this.retireCryptoStore(result.userId);
    this.opts.persist({
      homeserver,
      accessToken: result.accessToken,
      loginUser: user,
      loginDeviceName: deviceName,
    });
    this.opts.restart();
    return {
      ok: true,
      userId: result.userId,
      deviceId: result.deviceId,
      deviceName,
      retired,
      note: `已登录为 ${result.userId}（设备 ${deviceName} / ${result.deviceId}）。进程正在重启。`,
    };
  }

  /** 换设备时把旧加密库改名挪走；目录还被占用就放弃，让人自己清。 */
  private retireCryptoStore(userId: string): string {
    const dir = cryptoStoreDir(this.opts.dataDir, userId);
    if (!existsSync(dir)) return '';
    const target = `${dir}.old-${Date.now()}`;
    try {
      renameSync(dir, target);
      return target;
    } catch (error) {
      this.logger().warn('旧加密库没能挪走；新设备若报 store 不匹配，手动清掉这个目录', {
        dir,
        error: message(error),
      });
      return '';
    }
  }

  private saveSwitches(payload: unknown): Record<string, unknown> {
    const body = (payload ?? {}) as Record<string, unknown>;
    const patch: Partial<MatrixConfigSection> = {};
    if (typeof body.receiveRooms === 'boolean') patch.receiveRooms = body.receiveRooms;
    if (typeof body.onlyMentionInRoom === 'boolean') patch.onlyMentionInRoom = body.onlyMentionInRoom;
    this.opts.persist(patch);
    return { ok: true, note: '开关已写回配置，立即生效。' };
  }

  private saveRoster(payload: unknown): Record<string, unknown> {
    const body = (payload ?? {}) as Record<string, unknown>;
    if (typeof body.listenRooms !== 'string') return { ok: false, note: '没有收到名单。' };
    this.opts.persist({ listenRooms: body.listenRooms.trim() });
    const roster = parseRoomRoster(body.listenRooms);
    const unknown = roster ? [...roster].filter((id) => !this.roomNames.has(id) && ![...this.roomAliases.values()].includes(id)) : [];
    return {
      ok: true,
      note: `名单已保存：${roster ? `${roster.size} 个房间` : '全部房间'}。${unknown.length ? `其中 ${unknown.length} 个还没在已加入的房间里出现过。` : ''}`,
    };
  }

  /** 加密依赖的体检结果 + 安装进度。 */
  private async depsPanel(): Promise<Record<string, unknown>> {
    const status = await inspectDeps();
    return { ...status, installing: this.installing, installLog: this.installLog, installOk: this.installOk };
  }

  /** 后台装依赖：pnpm add + 补原生模块，面板轮询 deps 看进度。 */
  private startInstall(): Record<string, unknown> {
    if (this.installing) return { ok: false, note: '正在安装，别重复点。' };
    this.installing = true;
    this.installLog = '';
    this.installOk = null;
    void (async () => {
      try {
        // 边跑边写：面板每两秒拉一次 deps，能看到装到哪一步、下载了多少。
        const result = await installDeps(this.logger(), (chunk) => {
          this.installLog = `${this.installLog}${chunk}`.slice(-24_000);
        });
        this.installLog = result.output.slice(-24_000);
        this.installOk = result.ok;
      } catch (error) {
        this.installLog = message(error);
        this.installOk = false;
      } finally {
        this.installing = false;
      }
    })();
    return { ok: true, note: '开始安装。进度会实时显示在下面；装完要重启进程，加密层才会加载。' };
  }

  private encryptionPanel(): Record<string, unknown> {
    const mode = this.opts.cfg.encryption;
    return {
      ok: true,
      mode,
      modeLabel: encryptionModeLabel(mode),
      state: this.cryptoState,
      label: this.cryptoLabel(),
      error: this.cryptoError,
      device: this.crypto?.deviceId ?? '',
      rooms: [...this.roomNames].map(([roomId, name]) => {
        const encrypted = this.roomEncrypted.has(roomId);
        return { roomId, name, encrypted, allowed: mode !== 'strict' || encrypted };
      }),
    };
  }

  private saveEncryptionMode(payload: unknown): Record<string, unknown> {    const body = (payload ?? {}) as { mode?: unknown };
    const mode = body.mode;
    if (mode !== 'strict' && mode !== 'on' && mode !== 'off') {
      return { ok: false, note: '模式只能是 strict / on / off。' };
    }
    this.opts.persist({ encryption: mode });
    this.opts.restart();
    return { ok: true, note: `加密策略已改成「${encryptionModeLabel(mode)}」，正在重启进程使其生效。` };
  }

  private roomsPanel(): Record<string, unknown> {
    const roster = parseRoomRoster(this.opts.cfg.listenRooms);
    return {
      ok: true,
      rooms: [...this.roomNames].map(([roomId, name]) => ({
        roomId,
        name,
        members: this.roomMemberCounts.get(roomId) ?? null,
        alias: this.roomAliases.get(roomId) ?? null,
        encrypted: this.roomEncrypted.has(roomId),
        watched: rosterAllows(roster, roomId) || this.aliasAllowed(roomId),
        reachable: this.status.state === 'online',
      })),
    };
  }

  private stickerList(payload: unknown): Record<string, unknown> {
    const body = (payload ?? {}) as { pack?: unknown; query?: unknown };
    const pack = typeof body.pack === 'string' ? body.pack.trim() : '';
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    const entries = query ? this.stickers.search(query, 60) : this.stickers.list(pack || undefined);
    return {
      ok: true,
      dir: this.stickers.root,
      enabled: this.opts.cfg.sticker.enabled,
      packs: this.stickers.packs(),
      entries: entries.slice(0, 200).map((entry) => ({ id: entry.id, name: entry.name, pack: entry.pack, bytes: entry.bytes })),
      scannedAt: this.stickers.lastScanAt,
    };
  }

  private proactiveStatus(): Record<string, unknown> {
    const cfg = this.opts.cfg.proactive;
    const now = this.clock();
    return {
      enabled: cfg.enabled && this.opts.cfg.receiveRooms,
      maxPerDay: cfg.maxPerDay,
      countToday: this.proactiveCounter.count,
      lastFiredAt: this.proactiveCounter.lastFiredAt || null,
      reason: this.proactiveReason,
      inWindow: { from: cfg.activeFrom, to: cfg.activeTo, minutes: minutesOfDay(this.opts.timezone, now) },
      candidates: this.candidates().map((item) => ({
        roomId: item.roomId,
        name: item.name,
        quietMinutes: Math.round((now - item.lastActivityAt) / 60_000),
      })),
    };
  }

  private async fireProactive(): Promise<Record<string, unknown>> {
    if (!this.opts.cfg.receiveRooms) {
      return { ok: false, note: '房间推送关着，现在不能开口。要往那边开口，先在「连接与开关」里打开。' };
    }
    const now = this.clock();
    this.rollCounters(now);
    const candidates = this.candidates();
    if (candidates.length === 0) {
      return { ok: false, note: '还没有可开口的房间：先让对方说一句，或手动发一条消息。' };
    }
    const pick = candidates[0];
    this.proactiveCounter = markFired(this.proactiveCounter, now, pick.roomId);
    this.proactiveReason = `手动开口：${pick.name}`;
    const host = this.host;
    if (host) {
      await host.pushEvent(
        {
          type: 'matrix.proactive',
          ts: nowIso(this.opts.timezone),
          source: this.id,
          senderKey: conversationKey(pick.roomId),
          text: renderProactive({
            now: this.timeOf(now),
            roomName: pick.name,
            roomId: pick.roomId,
            quietMs: now - pick.lastActivityAt,
            countToday: this.proactiveCounter.count,
            maxPerDay: this.opts.cfg.proactive.maxPerDay,
            alternatives: candidates.slice(1, 4).map((item) => ({ roomName: item.name, roomId: item.roomId })),
          }),
        },
        { trigger: 'flush' },
      );
    }
    return { ok: true, note: `已把开口机会递给 ${pick.name}。` };
  }

  // ---- 杂项 ----

  private logger(): Logger {
    return this.host?.log ?? silentLogger;
  }

  private timeOf(at: number): string {
    return shortTime(this.opts.timezone, new Date(at));
  }

  private roomSummary(): string {
    if (this.roomNames.size === 0) return '';
    const roster = parseRoomRoster(this.opts.cfg.listenRooms);
    const lines = [...this.roomNames].map(([roomId, name]) => {
      const watched = rosterAllows(roster, roomId) || this.aliasAllowed(roomId);
      const members = this.roomMemberCounts.get(roomId);
      return `- 房间「${name}」(${roomId})${members !== undefined ? `，${members} 人` : ''}${watched ? '' : '（不在监听名单）'}${this.roomEncrypted.has(roomId) ? '（已加密）' : ''}`;
    });
    const switches: string[] = [];
    if (!this.opts.cfg.receiveRooms) switches.push('房间推送关着');
    if (this.opts.cfg.onlyMentionInRoom) switches.push('只在被提到或回复时才推送');
    if (switches.length) lines.push(`（${switches.join('；')}）`);
    return lines.join('\n');
  }

  private watchedCount(): number | string {
    const roster = parseRoomRoster(this.opts.cfg.listenRooms);
    if (roster === null) return '全部';
    return roster.size;
  }

  /** sync 位置落盘：重启后从上次的位置续，不重放也不丢。 */
  private get syncFile(): string {
    return this.opts.dataDir ? join(this.opts.dataDir, 'matrix', 'sync.json') : '';
  }

  private async loadSyncToken(): Promise<void> {
    const file = this.syncFile;
    if (!file) return;
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as { nextBatch?: unknown; userId?: unknown; deviceId?: unknown };
      if (typeof parsed.nextBatch === 'string' && parsed.nextBatch) {
        this.nextBatch = parsed.nextBatch;
      }
      this.syncTokenDevice = typeof parsed.deviceId === 'string' ? parsed.deviceId : '';
    } catch {
      // 没有或读不出来：从头同步一次。
    }
  }

  /** 落盘的 sync 位置不属于当前设备时丢掉它，从头同步。 */
  private dropStaleSyncPosition(): void {
    if (!this.nextBatch || !this.selfDeviceId) return;
    if (this.syncTokenDevice === this.selfDeviceId) return;
    // 老版本没写 deviceId：无法证明这个位置属于当前设备，宁可重来一次。
    this.logger().warn(
      this.syncTokenDevice
        ? `同步位置属于设备 ${this.syncTokenDevice}，当前是 ${this.selfDeviceId}；丢弃旧位置，从头同步一次`
        : `同步位置没记录设备，当前是 ${this.selfDeviceId}；丢弃旧位置，从头同步一次`,
    );
    this.nextBatch = '';
    this.saveSyncToken();
  }

  private saveSyncToken(): void {
    const file = this.syncFile;
    if (!file) return;
    const body = JSON.stringify({
      nextBatch: this.nextBatch,
      userId: this.selfUserId,
      deviceId: this.selfDeviceId,
      savedAt: new Date(this.clock()).toISOString(),
    });
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(join(this.opts.dataDir, 'matrix'), { recursive: true });
        await writeFile(file, body, 'utf8');
      })
      .catch(() => {
        // 位置写不进去只会让下次多同步一点，不影响收发。
      });
  }

  private storage(): StoragePart[] {
    return [
      {
        key: 'messages',
        label: '会话记录',
        kind: 'disk',
        location: this.history.file || '（只留内存）',
        note: '清掉后历史工具与引用原文都读不到旧消息；Matrix 上的消息不受影响。',
        stat: () => `${this.history.rooms().length} 个房间`,
        clear: async () => {
          await this.history.clear();
          return '会话记录已清空。';
        },
      },
      {
        key: 'sync-position',
        label: '同步位置',
        kind: 'disk',
        location: this.syncFile || '（不落盘）',
        note: '清掉后下次启动会重新做一次全量同步；已经收到的消息不会重放，记录不受影响。',
        stat: () => (this.nextBatch ? `next_batch ${this.nextBatch.slice(0, 12)}…` : '还没有位置'),
        clear: async () => {
          this.nextBatch = '';
          if (this.syncFile) await rm(this.syncFile, { force: true }).catch(() => {});
          return '同步位置已清空，下次启动会重新全量同步。';
        },
      },
    ];
  }

  private rollCounters(now: number): void {
    const date = localDateKey(this.opts.timezone, now);
    this.proactiveCounter = rollCounter(this.proactiveCounter, date);
  }

  private restoreCounters(): void {
    const date = localDateKey(this.opts.timezone, this.clock());
    this.proactiveCounter = emptyCounter(date);
  }
}

/** 服务端最多挂这么久；再大它会立刻回一帧空响应。 */
const MAX_SYNC_TIMEOUT_MS = 90_000;

/** 给一个可能挂住的调用加时限：加密机的密钥上传没有自己的超时。 */
function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** 加密策略的中文名，状态行与面板共用。 */
function encryptionModeLabel(mode: EncryptionMode): string {
  switch (mode) {
    case 'strict':
      return '强制';
    case 'on':
      return '启用';
    default:
      return '关闭';
  }
}

/** 把配置里的长轮询时长收进服务端认的范围。 */
function syncTimeoutOf(configured: number): number {
  return Math.max(1000, Math.min(MAX_SYNC_TIMEOUT_MS, Math.floor(configured)));
}

/** 这一帧里有没有时间线事件或邀请。 */
function hasTimelineEvents(response: SyncResponse): boolean {
  for (const room of Object.values(response.rooms?.join ?? {})) {
    if ((room.timeline?.events ?? []).length > 0) return true;
  }
  return Object.keys(response.rooms?.invite ?? {}).length > 0;
}

function noticeTypeOf(kind: string): string {
  switch (kind) {
    case 'reaction':
      return 'matrix.reaction';
    case 'redaction':
      return 'matrix.redaction';
    case 'room_name':
    case 'room_topic':
    case 'room_encryption':
      return 'matrix.room';
    default:
      return 'matrix.member';
  }
}

function lampOf(state: SyncStatus['state']): 'online' | 'loading' | 'error' | 'offline' {
  switch (state) {
    case 'online':
      return 'online';
    case 'connecting':
      return 'loading';
    case 'error':
      return 'error';
    default:
      return 'offline';
  }
}

/** 令牌失效、没权限这类错误重试也没用。 */
function isFatal(error: unknown): boolean {
  return error instanceof MatrixError && error.unauthorized;
}

function isStalePosition(error: unknown): boolean {
  return error instanceof MatrixError && error.stalePosition;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** 按字节切开长文本：先按换行与句末标点，仍然超长再按字符硬切。 */
function splitText(text: string, maxBytes: number): string[] {
  const encoder = new TextEncoder();
  const size = (value: string) => encoder.encode(value).length;
  if (size(text) <= maxBytes) return text ? [text] : [];
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current) {
      chunks.push(current);
      current = '';
    }
  };
  for (const piece of text.split(/(?<=[。！？!?\n])/)) {
    if (size(piece) > maxBytes) {
      flush();
      let buffer = '';
      for (const char of piece) {
        if (size(buffer + char) > maxBytes) {
          if (buffer) chunks.push(buffer);
          buffer = char;
        } else {
          buffer += char;
        }
      }
      current = buffer;
      continue;
    }
    if (size(current + piece) > maxBytes) flush();
    current += piece;
  }
  flush();
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function readImageFile(file: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    const data = await readFile(file);
    return data.byteLength > 0 ? { bytes: new Uint8Array(data), mime: 'image/jpeg' } : null;
  } catch {
    return null;
  }
}

const silentLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
} as unknown as Logger;

/** 一个把调用转发到「此刻的」日志的代理：构造时捕获对象的协作者靠它拿到宿主日志。 */
function delegatingLogger(target: () => Logger): Logger {
  const forward = (level: 'trace' | 'debug' | 'info' | 'warn' | 'error') => (text: string, fields?: unknown) => {
    const logger = target();
    (logger[level] as (m: string, f?: unknown) => void)(text, fields);
  };
  const logger: Logger = {
    trace: forward('trace'),
    debug: forward('debug'),
    info: forward('info'),
    warn: forward('warn'),
    error: forward('error'),
    child: () => logger,
  } as unknown as Logger;
  return logger;
}
