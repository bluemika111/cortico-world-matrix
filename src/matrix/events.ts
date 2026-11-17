/**
 * 入站事件的渲染。
 *
 * 只做一件事：把一条 Matrix 事件变成模型能读的一行正文，并挑出要不要下载的媒体。
 * 加密事件不解析——这个部署关掉了端到端加密，收到加密事件说明配置和预期不一致。
 */
import type { MatrixEvent } from './client.ts';
import { localpart } from './ids.ts';

/** 一条事件里带的媒体。 */
export interface MediaRef {
  mxc: string;
  /** 显示名：图片取事件正文里的文件名，表情包取表情名。 */
  name: string;
  mimetype?: string;
  size?: number;
  /** 表情包：既可以学进图库，也可以直接发。 */
  sticker: boolean;
  /** 加密附件：`file` 里有解密要用的 key/iv/hashes，`mxc` 是密文地址。 */
  file?: Record<string, unknown>;
}

export interface RenderedIncoming {
  text: string;
  /** 消息里 @ 了 bot 自己。 */
  mentionedSelf: boolean;
  /** 引用了另一条消息，被引用事件的 id。 */
  replyToId?: string;
  /** 这条是编辑，指向被改写的那条事件。 */
  editOf?: string;
  /** 这条属于一个线程。 */
  threadOf?: string;
  images: MediaRef[];
  audio: MediaRef[];
  files: MediaRef[];
  stickers: MediaRef[];
  /** 原始消息类型，记录与回执用。 */
  msgtype: string;
}

export interface RenderOptions {
  selfUserId: string;
  /** 调用方认识的显示名（自己的昵称），正文里匹配 @ 用。 */
  selfName?: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 一条事件的关系字段：回复、编辑、线程。 */
export interface Relates {
  replyToId?: string;
  editOf?: string;
  threadOf?: string;
}

export function relatesOf(content: Record<string, unknown>): Relates {
  const relates = obj(content['m.relates_to']);
  const out: Relates = {};
  const relType = str(relates.rel_type);
  if (relType === 'm.replace') out.editOf = str(relates.event_id) || undefined;
  if (relType === 'm.thread') out.threadOf = str(relates.event_id) || undefined;
  const reply = obj(relates['m.in_reply_to']);
  const replyId = str(reply.event_id);
  if (replyId) out.replyToId = replyId;
  return out;
}

/** 内容里的 `m.mentions.user_ids` 是否点了这些人。 */
export function mentionsUser(content: Record<string, unknown>, userId: string): boolean {
  if (!userId) return false;
  const mentions = obj(content['m.mentions']);
  const ids = Array.isArray(mentions.user_ids) ? mentions.user_ids : [];
  return ids.some((id) => String(id) === userId);
}

/**
 * 正文里有没有写到自己。Matrix 的提及有两种表示：新客户端写 `m.mentions`，
 * 老客户端只写 `@localpart`。两种都要认，否则被 @ 了却不叫醒。
 */
export function bodyMentions(body: string, selfUserId: string, selfName?: string): boolean {
  if (!body) return false;
  const needles = [`@${localpart(selfUserId)}`];
  if (selfName && selfName.trim()) needles.push(`@${selfName.trim()}`);
  const lower = body.toLowerCase();
  return needles.some((needle) => needle.length > 1 && lower.includes(needle.toLowerCase()));
}

function mimetypeOf(content: Record<string, unknown>): { mime?: string; size?: number } {
  const info = obj(content.info);
  const mime = str(info.mimetype) || undefined;
  const size = Number(info.size);
  return { mime, size: Number.isFinite(size) && size > 0 ? size : undefined };
}

/** 一条 `m.room.message` 或 `m.sticker` 能不能渲染成正文；不能时返回 null。 */
export function renderEvent(event: MatrixEvent, opts: RenderOptions): RenderedIncoming | null {
  const content = obj(event.content);
  // 编辑事件把新内容放在 m.new_content 里，外层 body 只是给老客户端的降级文本。
  const relates = relatesOf(content);
  const effective = relates.editOf ? { ...obj(content['m.new_content']), ...relatesToOf(content) } : content;

  if (event.type === 'm.room.encrypted') {
    return {
      text: '[加密消息]',
      mentionedSelf: false,
      images: [],
      audio: [],
      files: [],
      stickers: [],
      msgtype: 'm.room.encrypted',
    };
  }

  // 撤回过的消息在 /messages 里内容已经被服务端抹掉，只剩一个标记。
  if (event.unsigned?.redacted_because) {
    return {
      text: '[已撤回]',
      mentionedSelf: false,
      images: [],
      audio: [],
      files: [],
      stickers: [],
      msgtype: 'm.room.message',
    };
  }

  if (event.type === 'm.sticker') {
    const mime = mimetypeOf(effective);
    const name = str(effective.body) || '表情包';
    const file = obj(effective.file);
    const encrypted = str(file.url) ? file : undefined;
    const url = encrypted ? str(file.url) : str(effective.url);
    const sticker: MediaRef = { mxc: url, name, mimetype: mime.mime, size: mime.size, sticker: true, file: encrypted };
    return {
      text: `[表情包:${name}]`,
      mentionedSelf: false,
      images: url ? [sticker] : [],
      audio: [],
      files: [],
      stickers: url ? [sticker] : [],
      msgtype: 'm.sticker',
    };
  }

  if (event.type !== 'm.room.message') return null;

  const msgtype = str(effective.msgtype) || 'm.unknown';
  const body = str(effective.body);
  const self = { selfUserId: opts.selfUserId, selfName: opts.selfName };
  const mentionedSelf = mentionsUser(effective, opts.selfUserId) || bodyMentions(body, self.selfUserId, self.selfName);
  const base: RenderedIncoming = {
    text: '',
    mentionedSelf,
    replyToId: relates.replyToId,
    editOf: relates.editOf,
    threadOf: relates.threadOf,
    images: [],
    audio: [],
    files: [],
    stickers: [],
    msgtype,
  };

  const media = (kind: string): MediaRef => {
    const mime = mimetypeOf(effective);
    // 加密附件把地址与解密参数放在 `file` 里，顶层没有 url。
    const file = obj(effective.file);
    const encrypted = str(file.url) ? file : undefined;
    const mxc = encrypted ? str(file.url) : str(effective.url);
    return {
      mxc,
      name: body || kind,
      mimetype: mime.mime,
      size: mime.size,
      sticker: false,
      file: encrypted,
    };
  };

  switch (msgtype) {
    case 'm.text':
      base.text = body;
      break;
    case 'm.emote':
      base.text = body ? `* ${body}` : '*';
      break;
    case 'm.notice':
      base.text = body;
      break;
    case 'm.image': {
      const ref = media('image');
      if (ref.mxc) base.images.push(ref);
      // 文件名多是 image.png 这种，写进正文只是噪声；图片本身会作为附件给出去。
      base.text = '[图片]';
      break;
    }
    case 'm.audio': {
      const ref = media('audio');
      if (ref.mxc) base.audio.push(ref);
      base.text = '[语音]';
      break;
    }
    case 'm.video': {
      const ref = media('video');
      if (ref.mxc) base.files.push(ref);
      base.text = '[视频]';
      break;
    }
    case 'm.file': {
      const ref = media('file');
      if (ref.mxc) base.files.push(ref);
      base.text = body ? `[文件:${body}]` : '[文件]';
      break;
    }
    case 'm.location': {
      const geo = str(effective.geo_uri);
      base.text = geo ? `[位置:${body || geo}]` : '[位置]';
      break;
    }
    default:
      base.text = body || `[${msgtype}]`;
      break;
  }
  return base;
}

/** 编辑事件保留外层的关系字段，新内容里不一定有。 */
function relatesToOf(content: Record<string, unknown>): Record<string, unknown> {
  const relates = content['m.relates_to'];
  return relates ? { 'm.relates_to': relates } : {};
}
