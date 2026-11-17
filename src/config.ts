import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';

/** 端到端加密策略。 */
export type EncryptionMode = 'strict' | 'on' | 'off';

/** 语音超过 `maxSeconds` 时的处置。 */
export type VoiceOverlong = 'truncate' | 'text';

/** 一个语音服务的接入参数。`provider` 为 `none` 时这一项不工作。 */
export interface VoiceSpeaker {
  provider: 'none' | 'openai' | 'sapi';
  /** OpenAI 兼容端点基址：识别走 `{baseUrl}/audio/transcriptions`，合成走 `{baseUrl}/audio/speech`。 */
  baseUrl: string;
  model: string;
  /** 音色名，只有供应商支持时才有意义。 */
  voice: string;
  /** 密钥所在的环境变量名，空串表示不带密钥（本地服务）。 */
  apiKeySecret: string;
}

export interface MatrixVoiceConfig {
  /** 语音收发总开关。 */
  enabled: boolean;
  /** 收到语音自动转写。 */
  autoTranscribe: boolean;
  /** 临时目录；空串表示 `<部署数据目录>/voice`。 */
  tempDir: string;
  /** 一条语音的时长上限（秒）。 */
  maxSeconds: number;
  /** 超过上限时截断还是回落成文字。 */
  overlong: VoiceOverlong;
  /** ffmpeg 可执行文件；空串表示从 PATH 里找。 */
  ffmpegPath: string;
  asr: VoiceSpeaker;
  tts: VoiceSpeaker;
}

/**
 * config.json 的 `worlds.matrix` 节。
 * 监听名单是输入框里的文本：逗号、空格或换行分隔，空串表示监听全部房间。
 */
export interface MatrixConfigSection {
  enabled: boolean;
  /** 客户端-服务器 API 的基址，不带末尾斜杠。 */
  homeserver: string;
  /** 长期访问令牌；写在这里也写在部署的 .env 里都行，这一项优先。 */
  accessToken: string;
  /** 用密码登录时记住的账号，只作提示；密码本身不落盘。 */
  loginUser: string;
  /** 密码登录时给这个设备起的名字；空串表示 `Coopanion@<主机名>`。 */
  loginDeviceName: string;
  /** sync 长轮询的 timeout，毫秒。服务端最多挂这么久才回。 */
  syncTimeoutMs: number;
  /**
   * 端到端加密策略。
   * `strict`：只连加密房间——明文房间的消息不叫醒 Coo，往明文房间发东西直接拒绝。
   * `on`：加密房间与明文房间都能用；加密层起不来时退回明文并报出原因。
   * `off`：不加载加密层，加密房间里的消息只显示占位。
   */
  encryption: EncryptionMode;

  /** 房间消息推给 Coo 的开关。 */
  receiveRooms: boolean;
  /** 房间里只在被 @、被回复时才推送。 */
  onlyMentionInRoom: boolean;
  /** 只监听这些房间；空串监听全部。 */
  listenRooms: string;
  /** 把图片下载下来作为模型附件；模型不接受图片时只写占位。 */
  imageToModel: boolean;
  /** 每个房间在记录里保留的消息条数。 */
  historyLimit: number;
  /** 记录里保留的房间数。 */
  historyConversations: number;
  /** 首次启动时从服务端回填多少条历史进记录；0 关闭。 */
  backfillLimit: number;

  sticker: {
    /** 表情包开关：关掉后发表情包的工具不可用。 */
    enabled: boolean;
    /** 表情包目录；空串表示 `<部署数据目录>/stickers`。 */
    dir: string;
    /** 收到别人发的表情包时收进图库，供以后复用。 */
    learnFromMatrix: boolean;
  };

  proactive: {
    /** 主动说话状态机开关。 */
    enabled: boolean;
    /** 每天自动发起对话的次数上限。 */
    maxPerDay: number;
    /** 安静多久之后才考虑开口。 */
    quietMinutes: number;
    /** 两次主动开口之间的最小间隔。 */
    minIntervalMinutes: number;
    /** 每次检查时开口的概率，0–1。 */
    chance: number;
    /** 状态机检查间隔。 */
    tickSec: number;
    /** 允许开口的时段，24 小时制，可跨午夜。 */
    activeFrom: string;
    activeTo: string;
  };

  voice: MatrixVoiceConfig;
}

export const MATRIX_DEFAULTS: MatrixConfigSection = {
  enabled: false,
  homeserver: '',
  // 令牌由「用密码登录」写入，也可以手动填。这里不留任何真实令牌。
  accessToken: '',
  loginUser: '',
  loginDeviceName: '',
  // 服务端最多挂 90 秒；再大它会立刻回一帧空响应，长轮询就退化成满速轮询。
  syncTimeoutMs: 90_000,
  encryption: 'on',

  receiveRooms: true,
  onlyMentionInRoom: false,
  listenRooms: '',
  imageToModel: true,
  historyLimit: 200,
  historyConversations: 50,
  backfillLimit: 20,

  sticker: { enabled: true, dir: '', learnFromMatrix: true },
  proactive: {
    enabled: false,
    maxPerDay: 6,
    quietMinutes: 90,
    minIntervalMinutes: 120,
    chance: 0.25,
    tickSec: 300,
    activeFrom: '09:00',
    activeTo: '23:30',
  },
  voice: {
    enabled: false,
    autoTranscribe: true,
    tempDir: '',
    maxSeconds: 60,
    overlong: 'truncate',
    ffmpegPath: '',
    asr: {
      provider: 'none',
      baseUrl: 'https://api.openai.com/v1',
      model: 'whisper-1',
      voice: '',
      apiKeySecret: 'VOICE_API_KEY',
    },
    tts: {
      provider: 'none',
      baseUrl: 'https://api.openai.com/v1',
      model: 'tts-1',
      voice: 'alloy',
      apiKeySecret: 'VOICE_API_KEY',
    },
  },
};

/** 配置组的 owner 与配置段前缀。 */
export const MATRIX_SECTION = 'worlds.matrix';

export function matrixConfigGroup(language: Language): ConfigGroup {
  const zh = language !== 'en';
  const t = (zhText: string, enText: string) => (zh ? zhText : enText);
  const path = (name: string) => `${MATRIX_SECTION}.${name}`;
  return {
    id: 'world:matrix',
    owner: 'world:matrix',
    schema: {
      type: 'object',
      title: t('Matrix 接入', 'Matrix'),
      properties: {
        [path('homeserver')]: {
          type: 'string',
          title: t('服务器地址', 'Homeserver'),
          description: t(
            '客户端-服务器 API 的基址，如 https://im.example.org，不带末尾斜杠。改这一项要重启进程。',
            'Base URL of the client-server API, no trailing slash. Changing it restarts the world.',
          ),
          'x-hot': false,
        },
        [path('accessToken')]: {
          type: 'string',
          title: t('访问令牌', 'Access token'),
          description: t(
            '长期访问令牌。填了「用密码登录」之后会自动写入这里；也可以手动填。令牌失效时账号会被踢下线，页面的状态行会写明。',
            'Long-lived access token. Filled automatically when you log in with a password, or you can paste one. When it is revoked the world stops and the status line says so.',
          ),
          'x-hot': false,
        },
        [path('loginUser')]: {
          type: 'string',
          title: t('账号', 'Account'),
          description: t(
            '用密码登录时记住的账号，只用来回填输入框；密码不会写入配置。',
            'The account remembered after a password login, used only to prefill the form. The password is never stored in the config.',
          ),
          'x-hot': false,
        },
        [path('loginDeviceName')]: {
          type: 'string',
          title: t('设备名', 'Device name'),
          description: t(
            '登录时给这台机器起的设备名，在客户端的设备列表里显示。留空就用「Coopanion@主机名」——多台机器各登录一次时，这个名字能一眼分清谁是谁。',
            'Device name shown in clients\' device list. Empty means "Coopanion@<hostname>". Each machine logging in separately gets its own device, which is what keeps their encryption keys from overwriting each other.',
          ),
          'x-hot': false,
        },
        [path('syncTimeoutMs')]: {
          type: 'integer',
          title: t('长轮询时长', 'Sync timeout'),
          description: t(
            'sync 请求最长挂多久；服务端有新事件时会立刻返回。服务端最多挂 90 秒，填更大反而会立刻回空响应。反代读超时必须比它大。',
            'How long a sync request may hang; the server returns early when something happens. Servers cap this at 90 seconds and answer at once above that. The reverse proxy read timeout must be larger.',
          ),
          minimum: 1000,
          maximum: 90000,
          'x-suffix': t('毫秒', 'ms'),
          'x-hot': true,
        },
        [path('encryption')]: {
          type: 'string',
          enum: ['strict', 'on', 'off'],
          title: t('端到端加密', 'End-to-end encryption'),
          description: t(
            '强制：只连加密房间，明文房间的消息不叫醒 Coo，往明文房间发东西直接拒绝。启用：加密与明文房间都能用，加密层起不来时退回明文并报出原因。关闭：不加载加密层。',
            'Strict: encrypted rooms only; plaintext rooms never wake the model and sending there is refused. On: both kinds work, and a failed crypto start falls back to plaintext with the reason shown. Off: never load the crypto layer.',
          ),
          'x-hot': false,
        },
        [path('receiveRooms')]: {
          type: 'boolean',
          title: t('接收房间消息', 'Receive room messages'),
          description: t('关掉后消息照样记录，但不叫醒 Coo，也发不出任何东西。', 'When off, messages are still recorded but do not wake the model, and nothing can be sent.'),
          'x-hot': true,
        },
        [path('onlyMentionInRoom')]: {
          type: 'boolean',
          title: t('只在被提到时推送', 'Mentions only'),
          description: t('打开后只有被 @、被回复时才叫醒 Coo。', 'Only mentions and replies wake the model.'),
          'x-hot': true,
        },
        [path('listenRooms')]: {
          type: 'string',
          title: t('监听房间', 'Watched rooms'),
          description: t(
            '房间号（!xxx:server）或别名，逗号/空格/换行分隔；留空监听全部已加入的房间。',
            'Room ids or aliases separated by commas, spaces or newlines; empty watches every joined room.',
          ),
          'x-hot': true,
        },
        [path('imageToModel')]: {
          type: 'boolean',
          title: t('图片交给模型', 'Images to the model'),
          description: t('把图片下载下来作为附件；当前模型不接受图片时正文只留占位。', 'Downloads images as attachments when the current model accepts them.'),
          'x-hot': true,
        },
        [path('historyLimit')]: {
          type: 'integer',
          title: t('每房间保留条数', 'Messages per room'),
          description: t('历史工具与引用原文读到的是这份记录。', 'The history tools and quote resolution read this record.'),
          minimum: 20,
          maximum: 5000,
          'x-hot': true,
        },
        [path('historyConversations')]: {
          type: 'integer',
          title: t('保留房间数', 'Rooms kept'),
          description: t('超出的最旧房间从记录里丢掉。', 'The oldest rooms beyond this are dropped.'),
          minimum: 1,
          maximum: 500,
          'x-hot': true,
        },
        [path('backfillLimit')]: {
          type: 'integer',
          title: t('首次回填条数', 'Backfill on first start'),
          description: t(
            '第一次连上（或记录被清空）时，从服务端拉每个房间最近多少条进记录。回填不会叫醒 Coo。0 表示不拉。',
            'On the first connection, how many recent events per room to pull into the record. Backfill never wakes the model. 0 disables it.',
          ),
          minimum: 0,
          maximum: 200,
          'x-hot': true,
        },
        [path('sticker.enabled')]: {
          type: 'boolean',
          title: t('表情包', 'Stickers'),
          description: t('打开后 Coo 可以发表情包。', 'Lets the model send stickers.'),
          'x-hot': true,
        },
        [path('sticker.dir')]: {
          type: 'string',
          title: t('表情包目录', 'Sticker directory'),
          description: t('放图片的目录，按子目录分组；留空用部署数据目录下的 stickers。', 'Images grouped by subdirectory; empty uses stickers/ under the deployment data directory.'),
          'x-hot': true,
        },
        [path('sticker.learnFromMatrix')]: {
          type: 'boolean',
          title: t('学收到的表情包', 'Learn incoming stickers'),
          description: t('收到表情包时存进图库，供以后复用。', 'Stores incoming stickers so they can be reused later.'),
          'x-hot': true,
        },
        [path('proactive.enabled')]: {
          type: 'boolean',
          title: t('主动说话', 'Proactive chat'),
          description: t('按状态机在安静一段时间后自己找话题，说什么由 Coo 决定。', 'After a quiet stretch the state machine hands the model an opening; what to say is the model call.'),
          'x-hot': true,
        },
        [path('proactive.maxPerDay')]: {
          type: 'integer',
          title: t('每日上限', 'Per-day cap'),
          description: t('每天自动发起对话的次数上限。', 'Proactive openings allowed per day.'),
          minimum: 0,
          maximum: 200,
          'x-hot': true,
        },
        [path('proactive.quietMinutes')]: {
          type: 'integer',
          title: t('安静多久', 'Quiet for'),
          description: t('最后一条消息之后过这么久才考虑开口。', 'No message for this long before an opening is considered.'),
          minimum: 1,
          maximum: 1440,
          'x-suffix': t('分钟', 'min'),
          'x-hot': true,
        },
        [path('proactive.minIntervalMinutes')]: {
          type: 'integer',
          title: t('两次间隔', 'Between openings'),
          description: t('两次主动开口之间至少隔这么久。', 'Minimum gap between two proactive openings.'),
          minimum: 1,
          maximum: 1440,
          'x-suffix': t('分钟', 'min'),
          'x-hot': true,
        },
        [path('proactive.chance')]: {
          type: 'number',
          title: t('概率', 'Chance'),
          description: t('每次检查时开口的概率，0–1。', 'Probability of an opening per tick, 0–1.'),
          minimum: 0,
          maximum: 1,
          'x-hot': true,
        },
        [path('proactive.tickSec')]: {
          type: 'integer',
          title: t('检查间隔', 'Tick'),
          description: t('状态机多久看一次。', 'How often the state machine looks.'),
          minimum: 30,
          maximum: 3600,
          'x-suffix': t('秒', 's'),
          'x-hot': true,
        },
        [path('proactive.activeFrom')]: {
          type: 'string',
          title: t('时段从', 'Active from'),
          description: t('24 小时制 HH:MM。', 'HH:MM, 24-hour.'),
          'x-hot': true,
        },
        [path('proactive.activeTo')]: {
          type: 'string',
          title: t('时段到', 'Active to'),
          description: t('24 小时制 HH:MM，可以早于「从」，表示跨午夜。', 'May be earlier than the start, meaning it wraps midnight.'),
          'x-hot': true,
        },
        [path('voice.enabled')]: {
          type: 'boolean',
          title: t('语音', 'Voice'),
          description: t('收语音转文字、把回复念成语音。', 'Transcribes incoming voice and can speak replies.'),
          'x-hot': true,
        },
        [path('voice.autoTranscribe')]: {
          type: 'boolean',
          title: t('自动转写', 'Transcribe automatically'),
          description: t('收到语音就转写；关掉后只有工具问起才转。', 'Transcribes every incoming voice; when off only the tool triggers it.'),
          'x-hot': true,
        },
        [path('voice.tempDir')]: {
          type: 'string',
          title: t('临时目录', 'Temp directory'),
          description: t('下载与转码中间文件的落点；留空用部署数据目录下的 voice。', 'Where downloaded and transcoded audio lands; empty uses voice/ under the deployment data directory.'),
          'x-hot': false,
        },
        [path('voice.maxSeconds')]: {
          type: 'integer',
          title: t('最长语音', 'Longest voice'),
          description: t('发出的语音时长上限，超过按下面的方式处置。', 'Cap for outgoing voice; anything longer follows the setting below.'),
          minimum: 5,
          maximum: 300,
          'x-suffix': t('秒', 's'),
          'x-hot': true,
        },
        [path('voice.overlong')]: {
          type: 'string',
          enum: ['truncate', 'text'],
          title: t('超长处置', 'When too long'),
          description: t('截断语音，或回落成文字发出。', 'Truncate the audio, or send text instead.'),
          'x-hot': true,
        },
        [path('voice.ffmpegPath')]: {
          type: 'string',
          title: t('ffmpeg 路径', 'ffmpeg path'),
          description: t('留空从 PATH 里找；ogg/opus 转 wav 与截断都靠它。', 'Empty searches PATH; ogg/opus decoding and truncation need it.'),
          'x-hot': false,
        },
        [path('voice.asr.provider')]: {
          type: 'string',
          enum: ['none', 'openai'],
          title: t('识别服务', 'ASR provider'),
          description: t('none 关闭识别；openai 走 OpenAI 兼容的 /audio/transcriptions。', 'none disables it; openai uses an OpenAI-compatible /audio/transcriptions.'),
          'x-hot': false,
        },
        [path('voice.asr.baseUrl')]: {
          type: 'string',
          title: t('识别地址', 'ASR base URL'),
          description: t('OpenAI 兼容端点基址。', 'OpenAI-compatible endpoint base.'),
          'x-hot': false,
        },
        [path('voice.asr.model')]: {
          type: 'string',
          title: t('识别模型', 'ASR model'),
          description: t('如 whisper-1。', 'For example whisper-1.'),
          'x-hot': false,
        },
        [path('voice.asr.apiKeySecret')]: {
          type: 'string',
          title: t('识别密钥', 'ASR key'),
          description: t('密钥所在的环境变量名；本地服务留空。', 'Environment variable holding the key; empty for a local service.'),
          'x-hot': false,
        },
        [path('voice.tts.provider')]: {
          type: 'string',
          enum: ['none', 'openai', 'sapi'],
          title: t('合成服务', 'TTS provider'),
          description: t('none 关闭；openai 走 /audio/speech；sapi 用 Windows 自带语音。', 'none disables it; openai uses /audio/speech; sapi uses the Windows voice.'),
          'x-hot': false,
        },
        [path('voice.tts.baseUrl')]: {
          type: 'string',
          title: t('合成地址', 'TTS base URL'),
          description: t('OpenAI 兼容端点基址；sapi 不用。', 'OpenAI-compatible base; unused by sapi.'),
          'x-hot': false,
        },
        [path('voice.tts.model')]: {
          type: 'string',
          title: t('合成模型', 'TTS model'),
          description: t('如 tts-1。', 'For example tts-1.'),
          'x-hot': false,
        },
        [path('voice.tts.voice')]: {
          type: 'string',
          title: t('音色', 'Voice'),
          description: t('供应商支持时填写，如 alloy；sapi 填系统语音名，留空用默认。', 'Provider voice name; for sapi, a Windows voice name.'),
          'x-hot': false,
        },
        [path('voice.tts.apiKeySecret')]: {
          type: 'string',
          title: t('合成密钥', 'TTS key'),
          description: t('密钥所在的环境变量名；本地服务留空。', 'Environment variable holding the key; empty for a local service.'),
          'x-hot': false,
        },
      },
    },
  };
}
