import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageLog, type StoredMessage } from '../src/history.ts';

const ROOM = '!room:example.org';
const OTHER = '!other:example.org';

function record(overrides: Partial<StoredMessage> & { eventId: string }): Omit<StoredMessage, 'seq'> {
  return {
    eventId: overrides.eventId,
    roomId: overrides.roomId ?? ROOM,
    userId: overrides.userId ?? '@admin:example.org',
    userName: overrides.userName ?? 'admin',
    at: overrides.at ?? '2026-11-16T13:00:00.000Z',
    text: overrides.text ?? '你好',
    self: overrides.self ?? false,
    roomName: overrides.roomName ?? 'Coo',
  };
}

describe('MessageLog', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'matrix-log-'));
  });

  afterEach(async () => {
    // Windows 上追加写可能还没放开文件句柄，删目录要重试。
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });

  it('按房间归并，最近的消息在最后', () => {
    const log = new MessageLog({ dataDir: dir, perConversation: 10, conversations: 5 });
    log.append(record({ eventId: '$1', text: '第一句' }));
    log.append(record({ eventId: '$2', text: '第二句' }));
    log.append(record({ eventId: '$3', roomId: OTHER, text: '别处' }));
    expect(log.recent({ roomId: ROOM }, 10).map((item) => item.text)).toEqual(['第一句', '第二句']);
    expect(log.recent({ roomId: ROOM }, 1).map((item) => item.text)).toEqual(['第二句']);
  });

  it('同一个事件 id 只记一次', () => {
    const log = new MessageLog({ dataDir: dir, perConversation: 10, conversations: 5 });
    log.append(record({ eventId: '$1' }));
    log.append(record({ eventId: '$1', text: '重复的' }));
    expect(log.recent({ roomId: ROOM }, 10)).toHaveLength(1);
  });

  it('按事件 id 找前后文', () => {
    const log = new MessageLog({ dataDir: dir, perConversation: 10, conversations: 5 });
    for (const id of ['$1', '$2', '$3', '$4']) log.append(record({ eventId: id, text: id }));
    expect(log.around('$3', 1, 1).map((item) => item.text)).toEqual(['$2', '$3', '$4']);
    expect(log.around('$missing', 1, 1)).toEqual([]);
  });

  it('按关键词搜，带上前后几条', () => {
    const log = new MessageLog({ dataDir: dir, perConversation: 10, conversations: 5 });
    log.append(record({ eventId: '$1', text: '今晚吃火锅' }));
    log.append(record({ eventId: '$2', text: '好耶' }));
    const hits = log.search('火锅', 1, 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].at.eventId).toBe('$1');
    expect(hits[0].hits.map((item) => item.eventId)).toEqual(['$1', '$2']);
  });

  it('超出条数时丢掉最旧的', () => {
    const log = new MessageLog({ dataDir: dir, perConversation: 2, conversations: 5 });
    for (const id of ['$1', '$2', '$3']) log.append(record({ eventId: id, text: id }));
    expect(log.recent({ roomId: ROOM }, 10).map((item) => item.text)).toEqual(['$2', '$3']);
    expect(log.find('$1')).toBeUndefined();
  });

  it('记住房间名，最近活跃时间按房间分开', () => {
    const log = new MessageLog({ dataDir: dir, perConversation: 10, conversations: 5 });
    log.rememberName(ROOM, 'Coo');
    log.append(record({ eventId: '$1', at: '2026-11-16T13:00:00.000Z' }));
    log.append(record({ eventId: '$2', roomId: OTHER, at: '2026-11-16T14:00:00.000Z' }));
    expect(log.nameOf(ROOM)).toBe('Coo');
    expect(log.lastActivityAt(ROOM)).toBe(Date.parse('2026-11-16T13:00:00.000Z'));
    expect(log.lastActivityAt()).toBe(Date.parse('2026-11-16T14:00:00.000Z'));
    expect(log.rooms().map((room) => room.roomId)).toEqual([OTHER, ROOM]);
  });

  it('写进 jsonl 再读回来', async () => {
    const first = new MessageLog({ dataDir: dir, perConversation: 10, conversations: 5 });
    first.append(record({ eventId: '$1', text: '留下来的' }));
    await first.compact();

    const second = new MessageLog({ dataDir: dir, perConversation: 10, conversations: 5 });
    await second.load();
    expect(second.recent({ roomId: ROOM }, 10).map((item) => item.text)).toEqual(['留下来的']);
    const raw = await readFile(join(dir, 'matrix', 'messages.jsonl'), 'utf8');
    expect(raw).toContain('留下来的');
  });

  it('清空后文件也空', async () => {
    const log = new MessageLog({ dataDir: dir, perConversation: 10, conversations: 5 });
    log.append(record({ eventId: '$1' }));
    await log.clear();
    expect(log.recent({ roomId: ROOM }, 10)).toEqual([]);
    expect(log.rooms()).toEqual([]);
  });

  it('dataDir 为空时只留内存', () => {
    const log = new MessageLog({ dataDir: '', perConversation: 10, conversations: 5 });
    expect(log.file).toBe('');
    log.append(record({ eventId: '$1' }));
    expect(log.recent({ roomId: ROOM }, 10)).toHaveLength(1);
  });
});
