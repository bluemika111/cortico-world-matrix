/**
 * 会话记录：把收到和发出的消息留在内存里，并追加到部署数据目录的一个 jsonl。
 *
 * 记录有两个用处：历史工具回答「刚才聊了什么」，以及引用回复取回被引用的原文。
 * 只保留最近的若干个房间与每个房间最近若干条，重启后从文件读回。
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { conversationKey } from './policy.ts';

/** 记录里的一条消息。 */
export interface StoredMessage {
  /** 记录内的递增序号，历史工具用它定位。 */
  seq: number;
  /** Matrix 事件 id，引用回复、贴表情与撤回都按它找。 */
  eventId: string;
  roomId: string;
  /** 发言人 userId。 */
  userId: string;
  /** 发言人显示名。 */
  userName: string;
  at: string;
  /** 渲染后的正文，图片与语音在这里是占位。 */
  text: string;
  /** 是不是 bot 自己发的。 */
  self: boolean;
  /** 房间显示名。 */
  roomName: string;
}

export interface MessageLogOptions {
  /** 部署数据目录；空串表示只留内存，不落盘。 */
  dataDir: string;
  /** 每个房间保留的条数；给函数时每次裁剪按当前配置读。 */
  perConversation: number | (() => number);
  /** 最多保留多少个房间。 */
  conversations: number | (() => number);
}

/** 裁剪时读一次上限，函数形式让它跟着配置走。 */
function limitOf(value: number | (() => number)): number {
  return Math.max(1, Math.floor(typeof value === 'function' ? value() : value));
}

const FILE_NAME = 'messages.jsonl';

export class MessageLog {
  private readonly byRoom = new Map<string, StoredMessage[]>();
  private readonly byEventId = new Map<string, StoredMessage>();
  private readonly roomNames = new Map<string, string>();
  private seq = 0;
  private lastAt = 0;
  private readonly lastAtByRoom = new Map<string, number>();
  private writing: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly opts: MessageLogOptions) {}

  /** 记录文件的位置，测试与面板都要看。 */
  get file(): string {
    return this.opts.dataDir ? join(this.opts.dataDir, 'matrix', FILE_NAME) : '';
  }

  /** 读回上次运行留下的记录。文件不在时就是空记录。 */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        this.insert(JSON.parse(line) as StoredMessage);
      } catch {
        // 半行或损坏的行直接跳过：记录不是契约数据。
      }
    }
    this.trim();
  }

  append(message: Omit<StoredMessage, 'seq'>): StoredMessage {
    const stored: StoredMessage = { ...message, seq: ++this.seq };
    this.insert(stored);
    this.trim();
    this.persist(stored);
    return stored;
  }

  /** 某个房间最近的消息，按时间升序。 */
  recent(ref: { roomId?: string }, limit: number): StoredMessage[] {
    const all = this.byRoom.get(conversationKey(ref.roomId ?? '')) ?? [];
    return limit >= all.length ? [...all] : all.slice(all.length - limit);
  }

  /** 一条消息前后各若干条；找不到时返回空数组。 */
  around(eventId: string, before: number, after: number): StoredMessage[] {
    const hit = this.byEventId.get(eventId);
    if (!hit) return [];
    const all = this.byRoom.get(conversationKey(hit.roomId)) ?? [];
    const index = all.findIndex((m) => m.eventId === eventId);
    if (index < 0) return [];
    return all.slice(Math.max(0, index - before), index + after + 1);
  }

  find(eventId: string): StoredMessage | undefined {
    return this.byEventId.get(eventId);
  }

  /** 按关键词搜全部房间，每处命中带前后几条。 */
  search(keyword: string, context: number, limit: number): Array<{ hits: StoredMessage[]; at: StoredMessage }> {
    const needle = keyword.trim().toLowerCase();
    if (!needle) return [];
    const out: Array<{ hits: StoredMessage[]; at: StoredMessage }> = [];
    for (const all of this.byRoom.values()) {
      for (let i = 0; i < all.length; i += 1) {
        const message = all[i];
        if (!message.text.toLowerCase().includes(needle)) continue;
        out.push({ at: message, hits: all.slice(Math.max(0, i - context), i + context + 1) });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** 最近一条消息的时刻，主动说话用它判断安静了多久。 */
  lastActivityAt(roomId?: string): number {
    if (!roomId) return this.lastAt;
    return this.lastAtByRoom.get(conversationKey(roomId)) ?? 0;
  }

  /** 记录里出现过的房间，最近的在前，供主动说话挑目标。 */
  rooms(): Array<{ roomId: string; name: string; lastAt: number }> {
    const out: Array<{ roomId: string; name: string; lastAt: number }> = [];
    for (const [key, messages] of this.byRoom) {
      const roomId = key.slice('matrix.'.length);
      const last = messages[messages.length - 1];
      if (!last) continue;
      out.push({
        roomId,
        name: this.roomNames.get(key) ?? roomId,
        lastAt: Date.parse(last.at) || 0,
      });
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  /** 清空记录，连同磁盘上的那份。 */
  async clear(): Promise<void> {
    this.byRoom.clear();
    this.byEventId.clear();
    this.roomNames.clear();
    this.lastAtByRoom.clear();
    this.lastAt = 0;
    this.seq = 0;
    if (!this.file) return;
    // 已经排队的追加先落完，再把它清掉；否则那次追加会写在清空之后。
    await this.writing;
    try {
      await writeFile(this.file, '', 'utf8');
    } catch {
      // 文件不在时无需清理。
    }
  }

  /** 房间显示名的更新（房间改名）。 */
  rememberName(roomId: string, name: string): void {
    if (!name) return;
    this.roomNames.set(conversationKey(roomId), name);
  }

  /** 等排队的追加落盘；停机与测试收尾用它。 */
  async flush(): Promise<void> {
    await this.writing;
  }

  nameOf(roomId: string): string | undefined {
    return this.roomNames.get(conversationKey(roomId));
  }

  /** 某个房间最后一条消息的发言人；表情回应默认指向他。 */
  lastSender(roomId: string): string | undefined {
    const list = this.byRoom.get(conversationKey(roomId));
    const last = list?.[list.length - 1];
    return last && !last.self ? last.userId : undefined;
  }

  private insert(message: StoredMessage): void {
    const key = conversationKey(message.roomId);
    let list = this.byRoom.get(key);
    if (!list) {
      list = [];
      this.byRoom.set(key, list);
    }
    if (!message.eventId) return;
    // 已经有的消息（重启后重复读、sync 与发送路径各记一次）不重复插入。
    if (this.byEventId.has(message.eventId)) return;
    list.push(message);
    this.byEventId.set(message.eventId, message);
    this.seq = Math.max(this.seq, message.seq || 0);
    if (message.roomName) this.roomNames.set(key, message.roomName);
    const at = Date.parse(message.at) || 0;
    if (at > this.lastAt) this.lastAt = at;
    const before = this.lastAtByRoom.get(key) ?? 0;
    if (at > before) this.lastAtByRoom.set(key, at);
  }

  private trim(): void {
    const perConversation = limitOf(this.opts.perConversation);
    for (const [key, list] of this.byRoom) {
      if (list.length <= perConversation) continue;
      const dropped = list.splice(0, list.length - perConversation);
      for (const message of dropped) this.byEventId.delete(message.eventId);
      const last = list[list.length - 1];
      if (last) this.lastAtByRoom.set(key, Date.parse(last.at) || 0);
    }
    const rooms = limitOf(this.opts.conversations);
    if (this.byRoom.size <= rooms) return;
    const ranked = [...this.byRoom.entries()].sort((a, b) => {
      const left = a[1][a[1].length - 1]?.at ?? '';
      const right = b[1][b[1].length - 1]?.at ?? '';
      return left.localeCompare(right);
    });
    for (const [key, list] of ranked.slice(0, this.byRoom.size - rooms)) {
      for (const message of list) this.byEventId.delete(message.eventId);
      this.byRoom.delete(key);
      this.lastAtByRoom.delete(key);
    }
    this.lastAt = Math.max(0, ...[...this.byRoom.values()].map((list) => Date.parse(list[list.length - 1]?.at ?? '') || 0));
  }

  private persist(message: StoredMessage): void {
    if (!this.file) return;
    const line = `${JSON.stringify(message)}\n`;
    this.writing = this.writing
      .then(async () => {
        await mkdir(join(this.opts.dataDir, 'matrix'), { recursive: true });
        await appendFile(this.file, line, 'utf8');
      })
      .catch(() => {
        // 记录写不进去不影响收发；下一次写会再试。
      });
  }

  /** 让裁剪生效：把内存里的内容整体重写回磁盘。 */
  async compact(): Promise<void> {
    if (!this.file) return;
    await this.writing.catch(() => {});
    const lines: string[] = [];
    for (const list of this.byRoom.values()) for (const message of list) lines.push(JSON.stringify(message));
    await mkdir(join(this.opts.dataDir, 'matrix'), { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    await rename(temp, this.file);
  }
}
