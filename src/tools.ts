/**
 * 工具声明与实现。
 *
 * 工具不自己连 Matrix：房间解析、发送、记录、图库与语音都从 `ToolContext` 取，
 * 这样 World 负责连接与分发，工具只负责把一次调用翻译成动作和一句回执。
 */
import type { ToolCallContext, ToolDef, ToolOutcome } from 'cortico/core/types.ts';
import type { MatrixConfigSection } from './config.ts';

/** 出站的一段内容。文字与媒体各成一条消息。 */
export type OutgoingPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; bytes: Uint8Array; mime: string; name: string; sticker?: boolean }
  | { kind: 'audio'; bytes: Uint8Array; mime: string; name: string; durationMs?: number | null };

export interface SendRequest {
  roomId: string;
  /** 按顺序发出；每段一条事件。 */
  parts: OutgoingPart[];
  /** 记进会话记录用的正文，与段数组对应。 */
  text: string;
  /** 引用这条事件。 */
  replyTo?: string;
  /** 把这个人写成提及（它显示成 @名字 的高亮）。 */
  mention?: string;
}

export interface SendResult {
  ok: boolean;
  eventIds?: string[];
  error?: string;
}

/** 工具需要 World 提供的能力。 */
export interface ToolContext {
  config(): MatrixConfigSection;
  timezone: string;
  selfId(): string;
  connected(): boolean;
  statusText(): string;
  /** 解析房间号、别名或 `here`；解析不出时返回 null。 */
  resolveRoom(token: unknown): Promise<string | null>;
  /** 最近一次叫醒模型的房间。 */
  lastRoom(): string | null;
  roomLabel(roomId: string): string;
  send(request: SendRequest): Promise<SendResult>;
  react(roomId: string, eventId: string, emoji: string): Promise<SendResult>;
  redact(roomId: string, eventId: string, reason?: string): Promise<SendResult>;
  /** 事件所属的房间；记录里没有时返回 null。 */
  roomOfEvent(eventId: string): string | null;
  /** 最近一条叫醒过模型的消息；`roomId` 省略时用 `here`。 */
  lastIncomingEvent(roomId?: string): { roomId: string; eventId: string } | null;
  /** 自己在这个房间最后发出去的那条。 */
  lastSelfEvent(roomId?: string): { roomId: string; eventId: string } | null;
  /** 把 userId、`@本地名` 或显示名解成完整 userId。 */
  resolveUserId(token: string, roomId: string): string | null;
  stickerSearch(query: string, limit: number): Promise<Array<{ id: string; name: string; pack: string }>>;
  readSticker(id: string): Promise<{ bytes: Uint8Array; mime: string; name: string } | null>;
  /** 当前模型收不收这种图；决定回执要不要附图。 */
  takesImages(mime?: string): boolean;
  /** 把 http(s) 地址或本地路径读成字节。 */
  imageBytes(source: string): Promise<{ bytes: Uint8Array; mime: string; name: string } | null>;
  speak(roomId: string, text: string): Promise<SendResult>;
  historyText(roomId: string | null, limit: number, around?: string): string;
  searchText(keyword: string, context: number, limit: number): string;
  roomsText(): string;
}

const ROOM_SCHEMA = 'Room id (`!opaque:server`), an alias (`#alias:server`), a room name, or `here` for the room that last woke you (not merely the last one with activity).';

/** 全部工具的声明；`definition.ts` 的自描述与 `tools()` 都取它。 */
export const MATRIX_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'mx_send',
    description:
      'Send a message into a Matrix room. This and the other mx_ tools are the only way a person on Matrix sees anything you say; a pet bubble or the console stays on this computer. Give at most one of text, sticker and image, or voice for an audio message; reply_to and mention may accompany text. Returns the event id. Ask the operator before sending something they have not asked for.',
    tags: ['speak'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['room'],
      properties: {
        room: { type: 'string', description: ROOM_SCHEMA },
        text: { type: 'string', description: 'What to say.' },
        sticker: { type: 'string', description: 'Sticker name or id from mx_stickers; sent as a sticker image.' },
        image: { type: 'string', description: 'http(s) URL or absolute local path of an image. It is uploaded to the homeserver first.' },
        voice: { type: 'string', description: 'Text to synthesise and send as a voice message instead of text.' },
        mention: { type: 'string', description: 'Who to mention: a userId, `@localpart`, or a display name from the room.' },
        reply_to: { type: 'string', description: 'Event id to quote, or `last` for the message that last woke you.' },
      },
    },
  },
  {
    name: 'mx_stickers',
    description:
      'List or search the sticker library Coo owns. Empty query returns a sample; results carry the name to pass to mx_send. When the current model accepts images, the first few matches come back as attachments, so pick by looking at them rather than by name alone. Read-only.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Words to match against sticker names and packs.' },
        limit: { type: 'integer', minimum: 1, maximum: 40, description: 'How many to return. Default 12.' },
      },
    },
  },
  {
    name: 'mx_voice',
    description:
      'Speak a line into a room as a voice message, using the configured voice service. Falls back to text when synthesis is off, fails, or the audio is too long.',
    tags: ['speak'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['room', 'text'],
      properties: {
        room: { type: 'string', description: ROOM_SCHEMA },
        text: { type: 'string', description: 'What to say out loud.' },
      },
    },
  },
  {
    name: 'mx_react',
    description:
      'Attach an emoji reaction to a message. Matrix reactions are emoji only; the reaction is visible to everyone in the room. Without an event id it reacts to the message that last woke you.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['emoji'],
      properties: {
        event_id: { type: 'string', description: 'Event id from mx_history. Omit to react to the message that last woke you.' },
        emoji: { type: 'string', description: 'One emoji, for example 👍.' },
      },
    },
  },
  {
    name: 'mx_redact',
    description:
      'Delete one of your own messages. The deletion is visible to everyone in the room and cannot be undone. Without an event id it deletes the last message you sent in that room.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        event_id: { type: 'string', description: 'Event id of your own message, from mx_history. Omit to delete the last message you sent in that room.' },
        reason: { type: 'string', description: 'Reason shown in the room settings after the deletion.' },
      },
    },
  },
  {
    name: 'mx_history',
    description:
      "Read recent messages from a watched room, or a window around one event id, from this World's record. Each line starts with the event id, which is what mx_react, mx_redact and reply_to take. Read-only.",
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        room: { type: 'string', description: `${ROOM_SCHEMA} Omit to read the room behind your current context.` },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many recent messages. Default 30.' },
        around_event_id: { type: 'string', description: 'Centre the window on this event id instead.' },
      },
    },
  },
  {
    name: 'mx_search',
    description: 'Search the recorded messages of watched rooms by keyword, with a few messages around each hit. Read-only.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['keyword'],
      properties: {
        keyword: { type: 'string', description: 'Plain text, matched case-insensitively.' },
        context: { type: 'integer', minimum: 0, maximum: 10, description: 'Messages before and after each hit. Default 2.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many hits. Default 5.' },
      },
    },
  },
  {
    name: 'mx_rooms',
    description:
      'List the rooms this account has joined, with room id, members, whether encryption is on, and which ones are watched. Read-only; use it to choose the room for mx_send or to find who to mention.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'mx_status',
    description: 'Report the connection state, the signed-in account, and which rooms are being watched. Read-only; do not poll it.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function targetOf(ctx: ToolContext, token: unknown): Promise<string> {
  const resolved = await ctx.resolveRoom(token);
  if (!resolved) {
    throw new Error(`无法识别的房间「${String(token ?? '')}」：写成 !房间号:服务器、#别名:服务器，或用 here。`);
  }
  return resolved;
}

/** 事件的房间：记录里查；查不到时用最近叫醒模型的那个，并在回执里说清楚。 */
function roomForEvent(ctx: ToolContext, eventId: string): { roomId: string; guessed: boolean } | null {
  const known = ctx.roomOfEvent(eventId);
  if (known) return { roomId: known, guessed: false };
  const last = ctx.lastRoom();
  return last ? { roomId: last, guessed: true } : null;
}

/** 要动手的那条消息：给了 id 就按 id 找，没给就用最近叫醒模型的那条。 */
function eventTarget(ctx: ToolContext, explicit: string): { roomId: string; eventId: string; guessed: boolean } | null {
  if (explicit) {
    const where = roomForEvent(ctx, explicit);
    return where ? { roomId: where.roomId, eventId: explicit, guessed: where.guessed } : null;
  }
  const last = ctx.lastIncomingEvent();
  return last ? { ...last, guessed: false } : null;
}

export function buildTools(ctx: ToolContext): ToolDef[] {
  const send = tool('mx_send', async (args) => {
    const roomId = await targetOf(ctx, args.room);
    const text = asText(args.text);
    const voice = asText(args.voice);
    const sticker = asText(args.sticker);
    const image = asText(args.image);
    const mentionToken = asText(args.mention);
    let replyTo = asText(args.reply_to);
    const notes: string[] = [];

    if (voice) {
      const spoken = await ctx.speak(roomId, voice);
      return spoken.ok
        ? `已在${ctx.roomLabel(roomId)}发出语音，事件 id ${spoken.eventIds?.[0] ?? '未知'}。`
        : `语音没发出去：${spoken.error ?? '未知原因'}。`;
    }

    // 正文里不印事件 id，所以「引用刚说的那条」要能直接说 last。
    if (replyTo === 'last') {
      replyTo = ctx.lastIncomingEvent(roomId)?.eventId ?? '';
      if (!replyTo) notes.push('没有可引用的消息');
    }
    let mention = '';
    if (mentionToken) {
      mention = ctx.resolveUserId(mentionToken, roomId) ?? '';
      if (!mention) return `房间里找不到「${mentionToken}」这个人：用 mx_rooms 看看成员。`;
    }

    const parts: OutgoingPart[] = [];
    if (sticker) {
      const found = await ctx.stickerSearch(sticker, 1);
      const hit = found[0];
      if (!hit) return `图库里没有「${sticker}」这张表情。用 mx_stickers 看看有哪些。`;
      const data = await ctx.readSticker(hit.id);
      if (!data) return `表情「${hit.name}」的图片读不出来。`;
      parts.push({ kind: 'image', bytes: data.bytes, mime: data.mime, name: hit.name, sticker: true });
      notes.push(`表情：${hit.name}`);
    } else if (image) {
      const data = await ctx.imageBytes(image);
      if (!data) return `图片「${image}」读不出来：给一个 http(s) 地址，或这台机器上存在的图片路径。`;
      parts.push({ kind: 'image', bytes: data.bytes, mime: data.mime, name: data.name });
      notes.push('图片');
    }
    if (text) parts.push({ kind: 'text', text });
    if (parts.length === 0) return '没有可发的内容：text、sticker、image、voice 里至少给一个。';

    const result = await ctx.send({
      roomId,
      parts,
      text: text || (sticker ? `[表情包:${sticker}]` : '[图片]'),
      replyTo: replyTo || undefined,
      mention: mention || undefined,
    });
    if (!result.ok) return `没发出去：${result.error ?? '未知原因'}。`;
    const ids = result.eventIds ?? [];
    const where = ctx.roomLabel(roomId);
    const idText = ids.length === 1 ? `事件 id ${ids[0]}` : `事件 id ${ids.join('、')}`;
    return `已发送到${where}，${idText}${notes.length ? `（${notes.join('、')}）` : ''}。`;
  });

  const stickers = tool('mx_stickers', async (args) => {
    const query = asText(args.query);
    const limit = Math.min(40, Math.max(1, asNumber(args.limit, 12)));
    const found = await ctx.stickerSearch(query, limit);
    if (found.length === 0) {
      return query
        ? `图库里没有匹配「${query}」的表情。把图片放进表情目录后，用这个工具重新查。`
        : '图库是空的。把表情图片放进配置的表情目录（子目录作分组），再查一次。';
    }
    const lines = found.map((entry) => `- ${entry.name}（分组：${entry.pack}，id：${entry.id}）`);
    const listText = `表情包（${found.length} 张）：\n${lines.join('\n')}\n发的时候把名字传给 mx_send 的 sticker。`;

    // 只给名字的话模型是在盲选：把前几张图作为附件递过去，它才知道自己发的是什么。
    if (!ctx.takesImages('image/png')) return listText;
    const blobs: Array<{ bytes: Uint8Array; mime: string; name: string; fallbackText: string }> = [];
    for (const entry of found.slice(0, 4)) {
      const data = await ctx.readSticker(entry.id);
      if (!data || !ctx.takesImages(data.mime)) continue;
      // 太大的图会挤占上下文，只带小的。
      if (data.bytes.byteLength > 1024 * 1024) continue;
      blobs.push({ bytes: data.bytes, mime: data.mime, name: `sticker-${entry.name}`, fallbackText: `[表情包:${entry.name}]` });
    }
    if (blobs.length === 0) return listText;
    return {
      text: `${listText}\n附件里是其中 ${blobs.length} 张的图，按顺序对应列表的前 ${blobs.length} 项。`,
      blobs,
    };
  });

  const voice = tool('mx_voice', async (args) => {
    const roomId = await targetOf(ctx, args.room);
    const text = asText(args.text);
    if (!text) return '要念的内容是空的。';
    const result = await ctx.speak(roomId, text);
    return result.ok
      ? `已在${ctx.roomLabel(roomId)}发出语音，事件 id ${result.eventIds?.[0] ?? '未知'}。`
      : `语音没发出去：${result.error ?? '未知原因'}。`;
  });

  const react = tool('mx_react', async (args) => {
    const emoji = asText(args.emoji);
    if (!emoji) return 'emoji 是空的。';
    const where = eventTarget(ctx, asText(args.event_id));
    if (!where) return '没有可贴表情的消息：记录里没有这条，也没有最近叫醒我的消息。';
    const result = await ctx.react(where.roomId, where.eventId, emoji);
    const guess = where.guessed ? '（记录里没有这条消息，按最近叫醒我的房间发）' : '';
    return result.ok
      ? `已给${ctx.roomLabel(where.roomId)}里那条消息贴了表情 ${emoji}${guess}。`
      : `贴表情失败：${result.error ?? '未知原因'}${guess}。`;
  });

  const redact = tool('mx_redact', async (args) => {
    const explicit = asText(args.event_id);
    const where = explicit ? eventTarget(ctx, explicit) : ctx.lastSelfEvent();
    if (!where) {
      return explicit
        ? `记录里没有 #${explicit}，也没有最近叫醒我的房间，判断不了这条消息在哪个房间。`
        : '没有可撤回的消息：这个房间里我还没发过东西。';
    }
    const result = await ctx.redact(where.roomId, where.eventId, asText(args.reason) || undefined);
    const guess = 'guessed' in where && where.guessed ? '（记录里没有这条消息，按最近叫醒我的房间发）' : '';
    return result.ok ? `已撤回${ctx.roomLabel(where.roomId)}里那条消息${guess}。` : `撤回失败：${result.error ?? '未知原因'}${guess}。`;
  });

  const history = tool('mx_history', async (args) => {
    const limit = Math.min(200, Math.max(1, asNumber(args.limit, 30)));
    const around = asText(args.around_event_id);
    const roomId =
      args.room === undefined || args.room === ''
        ? ctx.lastRoom()
        : await targetOf(ctx, args.room);
    return ctx.historyText(roomId, limit, around || undefined);
  });

  const search = tool('mx_search', async (args) => {
    const keyword = asText(args.keyword);
    if (!keyword) return '关键词是空的。';
    const context = Math.min(10, Math.max(0, asNumber(args.context, 2)));
    const limit = Math.min(20, Math.max(1, asNumber(args.limit, 5)));
    return ctx.searchText(keyword, context, limit);
  });

  const rooms = tool('mx_rooms', async () => ctx.roomsText());

  const status = tool('mx_status', async () => ctx.statusText());

  return [send, stickers, voice, react, redact, history, search, rooms, status];
}

function tool(
  name: string,
  handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolOutcome>,
): ToolDef {
  const decl = MATRIX_TOOL_DECLS.find((item) => item.name === name);
  if (!decl) throw new Error(`工具声明缺少 ${name}`);
  return { ...decl, handler: (args, call) => handler(args, call) };
}
