import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { MATRIX_DEFAULTS, type MatrixConfigSection } from './config.ts';
import { MATRIX_TOOL_DECLS } from './tools.ts';
import { MatrixWorld } from './world.ts';

export const MATRIX: WorldDefinition<MatrixConfigSection> = {
  id: 'matrix',
  label: 'Matrix',
  // 默认值里有嵌套对象：每次给一份深拷贝，实例之间不共享。
  defaults: () => structuredClone(MATRIX_DEFAULTS),
  create: (ctx) =>
    new MatrixWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      dataDir: ctx.dataDir,
      botName: ctx.botName,
      secret: (name) => ctx.secret(name),
      persist: (patch) => ctx.persist(patch),
      restart: () => void ctx.restart(),
    }),
  describe: {
    tools: describeTools(MATRIX_TOOL_DECLS, {
      mx_send: { zh: '往房间发一条消息，可以带表情包、图片、语音或引用。', en: 'Sends one message into a room, with a sticker, image, voice or quote.' },
      mx_stickers: { zh: '列出或搜索 Coo 自己的表情包图库；前几张会连同图片一起给出来。', en: 'Lists or searches the sticker library Coo owns; the first few matches come with their images.' },
      mx_voice: { zh: '把一句话合成语音发出去。', en: 'Synthesises a line and sends it as a voice message.' },
      mx_react: { zh: '给一条消息贴一个表情。', en: 'Attaches an emoji to a message as a reaction.' },
      mx_redact: { zh: '撤回自己发的一条消息。', en: 'Deletes one of its own messages.' },
      mx_history: { zh: '读某个房间的近期记录，或某条消息前后的一段。', en: 'Reads recent messages of a room, or a window around one message.' },
      mx_search: { zh: '按关键词搜已记录的会话消息。', en: 'Searches recorded messages by keyword.' },
      mx_rooms: { zh: '列出已加入的房间、成员数与加密状态。', en: 'Lists joined rooms with member counts and encryption state.' },
      mx_status: { zh: '报连接状态、账号与正在监听的房间。', en: 'Reports the connection, the account and the watched rooms.' },
    }),
    events: [
      {
        type: 'matrix.message',
        description: {
          zh: '监听的房间里来了一条消息；被 @ 或被回复时立即投递。',
          en: 'A message in a watched room; delivered at once when the bot is mentioned or replied to.',
        },
      },
      {
        type: 'matrix.reaction',
        description: { zh: '有人给一条消息贴了表情。', en: 'Someone reacted to a message with an emoji.' },
      },
      {
        type: 'matrix.redaction',
        description: { zh: '有人撤回了一条消息。', en: 'Someone redacted a message.' },
      },
      {
        type: 'matrix.member',
        description: { zh: '有人加入、离开、被邀请或移出了房间。', en: 'Someone joined, left, was invited to or was removed from a room.' },
      },
      {
        type: 'matrix.room',
        description: { zh: '房间改名、改主题或打开了端到端加密。', en: 'A room was renamed, got a new topic, or turned encryption on.' },
      },
      {
        type: 'matrix.transcript',
        description: { zh: '一条语音的转写结果，或没能转写的原因。', en: 'The transcript of a voice message, or why transcription failed.' },
      },
      {
        type: 'matrix.proactive',
        description: {
          zh: '主动开口的机会：某个房间安静够了，说不说由模型决定。',
          en: 'A proactive opening: one room has been quiet long enough; whether to speak is the model call.',
        },
      },
      {
        type: 'matrix.status',
        description: { zh: '与服务器的同步建立或断开。', en: 'The sync with the homeserver came up or went down.' },
      },
    ],
  },
};
