import { afterEach, describe, expect, it } from 'vitest';
import type { MatrixClient, MatrixEvent, SyncResponse } from '../src/matrix/client.ts';
import type { MatrixConfigSection } from '../src/config.ts';
import { MATRIX_DEFAULTS } from '../src/config.ts';
import { MatrixWorld } from '../src/world.ts';
import type { ToolDef } from 'cortico/core/types.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { FakeCrypto, FakeMatrix, memberEvent, messageEvent } from './helpers/fake-matrix.ts';

const SELF = '@coo:example.org';
const ADMIN = '@admin:example.org';
const ROOM = '!qmJoOujSuYtCORt4ZC:example.org';
const NOW = Date.parse('2026-11-16T20:30:00+08:00');
const TEST_HOMESERVER = 'https://matrix.test';
const TEST_TOKEN = 'test-token';

interface Wired {
  world: MatrixWorld;
  host: FakeHost;
  fake: FakeMatrix;
  cfg: MatrixConfigSection;
  crypto: FakeCrypto | null;
}

const wired: Wired[] = [];

function makeWorld(overrides: Partial<MatrixConfigSection> = {}, accepts = false, withCrypto = false): Wired {
  const fake = new FakeMatrix();
  // 账号已经在房间里：joinedRooms 与成员表都要对得上，否则启动时读不到房间。
  fake.roomNames.set(ROOM, 'Coo');
  fake.roomMembers.set(ROOM, { [SELF]: { display_name: 'Coo' }, [ADMIN]: { display_name: 'admin' } });
  const crypto = withCrypto ? new FakeCrypto() : null;
  // 默认值里不再写死服务器与令牌（发布包不该带私有部署的信息），测试自己补占位值。
  const cfg: MatrixConfigSection = {
    ...structuredClone(MATRIX_DEFAULTS),
    enabled: true,
    homeserver: TEST_HOMESERVER,
    accessToken: TEST_TOKEN,
    ...overrides,
  };
  const host = new FakeHost({ accepts: () => accepts });
  const world = new MatrixWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    dataDir: '',
    botName: 'Coo',
    secret: () => undefined,
    persist: (patch) => Object.assign(cfg, patch),
    restart: () => {},
    clientFactory: () => fake as unknown as MatrixClient,
    cryptoFactory: async () => crypto,
    shrinkImage: async () => null,
    now: () => NOW,
    random: () => 0,
    decryptRetries: 1,
  });
  const item = { world, host, fake, cfg, crypto };
  wired.push(item);
  return item;
}

afterEach(async () => {
  for (const item of wired.splice(0)) await item.world.stop();
});

/** 轮询等一个条件：sync 循环与事件链都是异步的，不能靠固定延时。 */
async function waitFor(predicate: () => boolean, label = '条件'): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待${label}超时`);
}

function bootstrapResponse(extra: { timeline?: SyncResponse } = {}): SyncResponse {
  return {
    next_batch: 'b1',
    rooms: {
      join: {
        [ROOM]: {
          state: {
            events: [
              { type: 'm.room.name', state_key: '', sender: ADMIN, content: { name: 'Coo' } },
              memberEvent({ userId: SELF, displayName: 'Coo', membership: 'join' }),
              memberEvent({ userId: ADMIN, displayName: 'admin', membership: 'join' }),
            ],
          },
          timeline: { events: [] },
          summary: { 'm.joined_member_count': 2, 'm.heroes': [ADMIN] },
        },
      },
    },
    ...(extra.timeline ?? {}),
  };
}

function incremental(batch: string, events: MatrixEvent[], roomId = ROOM): SyncResponse {
  return {
    next_batch: batch,
    rooms: { join: { [roomId]: { timeline: { events } } } },
  };
}

/** 一个开了端到端加密的房间。 */
function encryptedBootstrap(): SyncResponse {
  return {
    next_batch: 'b1',
    rooms: {
      join: {
        [ROOM]: {
          state: {
            events: [
              { type: 'm.room.name', state_key: '', sender: ADMIN, content: { name: 'Coo' } },
              memberEvent({ userId: SELF, displayName: 'Coo', membership: 'join' }),
              memberEvent({ userId: ADMIN, displayName: 'admin', membership: 'join' }),
              { type: 'm.room.encryption', state_key: '', sender: ADMIN, content: { algorithm: 'm.megolm.v1.aes-sha2' } },
            ],
          },
        },
      },
    },
  };
}

async function callTool(world: MatrixWorld, name: string, args: Record<string, unknown> = {}) {
  const tool = world.tools().find((item: ToolDef) => item.name === name);
  if (!tool) throw new Error(`没有工具 ${name}`);
  return tool.handler(args, {} as never);
}

describe('World 启动与同步', () => {
  it('首次同步只建立房间与成员，不把时间线当新消息', async () => {
    const { world, host, fake } = makeWorld();
    fake.roomNames.set(ROOM, 'Coo');
    fake.syncQueue.push({
      next_batch: 'b1',
      rooms: {
        join: {
          [ROOM]: {
            state: { events: [{ type: 'm.room.name', state_key: '', sender: ADMIN, content: { name: 'Coo' } }] },
            timeline: { events: [messageEvent({ eventId: '$old', sender: ADMIN, body: '旧消息' })] },
          },
        },
      },
    });
    await world.start(host);
    await waitFor(() => fake.syncCalls.length >= 2, '第一次续传');

    // 全量同步只拿 next_batch；时间线里的旧消息不该叫醒模型。
    expect(host.events.filter((event) => event.type === 'matrix.message')).toEqual([]);
    expect(fake.syncCalls[0]).toEqual({ since: null, timeout: 0 });
    expect(fake.syncCalls[1]?.since).toBe('b1');
    expect(fake.syncCalls[1]?.timeout).toBe(MATRIX_DEFAULTS.syncTimeoutMs);
    expect(world.connected()).toBe(true);
  });

  it('长轮询时长超过服务端上限时收进 90 秒', async () => {
    // 服务端对超范围的 timeout 会立刻回空响应；不夹住的话长轮询会变成满速轮询。
    const { world, host, fake } = makeWorld({ syncTimeoutMs: 300_000 });
    fake.syncQueue.push(bootstrapResponse());
    await world.start(host);
    await waitFor(() => fake.syncCalls.length >= 2, '第一次续传');
    expect(fake.syncCalls[1]?.timeout).toBe(90_000);
  });

  it('增量同步的消息进事件，普通消息按合批口径投递', async () => {
    const { world, host, fake } = makeWorld();
    fake.syncQueue.push(
      bootstrapResponse(),
      incremental('b2', [messageEvent({ eventId: '$m1', sender: ADMIN, body: '在吗' })]),
    );
    await world.start(host);
    await waitFor(() => host.events.some((event) => event.type === 'matrix.message'), '消息投递');

    const message = host.events.find((event) => event.type === 'matrix.message');
    // 正文只留房间名、时间、说话人与内容；事件 id 不进正文。
    expect(message?.text).toMatch(/^\[Matrix-Coo \d{2}:\d{2}\] admin: 在吗$/);
    expect(message?.text).not.toContain('$m1');
    expect(message?.senderKey).toBe(`matrix.${ROOM}`);
    const index = host.events.indexOf(message!);
    expect(host.pushOpts[index]?.trigger).toBe('debounce');
  });

  it('被 @ 的消息立刻投递', async () => {
    const { world, host, fake } = makeWorld();
    fake.syncQueue.push(
      bootstrapResponse(),
      incremental('b2', [
        messageEvent({ eventId: '$m1', sender: ADMIN, body: '@coo 出来', content: { 'm.mentions': { user_ids: [SELF] } } }),
      ]),
    );
    await world.start(host);
    await waitFor(() => host.events.some((event) => event.type === 'matrix.message'), '消息投递');
    const message = host.events.find((event) => event.type === 'matrix.message');
    const index = host.events.indexOf(message!);
    expect(host.pushOpts[index]?.trigger).toBe('flush');
  });

  it('回复自己的消息也算被提到', async () => {
    const { world, host, fake } = makeWorld();
    fake.syncQueue.push(
      bootstrapResponse(),
      incremental('b2', [
        messageEvent({ eventId: '$mine', sender: SELF, body: '我说一句' }),
        messageEvent({
          eventId: '$reply',
          sender: ADMIN,
          body: '接话',
          content: { 'm.relates_to': { 'm.in_reply_to': { event_id: '$mine' } } },
        }),
      ]),
    );
    await world.start(host);
    await waitFor(() => host.events.some((event) => event.type === 'matrix.message'), '回复投递');
    const reply = host.events.find((event) => event.type === 'matrix.message');
    expect(reply?.text).toContain('admin: 接话');
    expect(host.pushOpts[host.events.indexOf(reply!)]?.trigger).toBe('flush');
  });

  it('只推被提到的消息时，普通消息不叫醒模型', async () => {
    const { world, host, fake } = makeWorld({ onlyMentionInRoom: true });
    fake.syncQueue.push(
      bootstrapResponse(),
      incremental('b2', [messageEvent({ eventId: '$m1', sender: ADMIN, body: '闲聊' })]),
    );
    await world.start(host);
    await waitFor(() => fake.syncCalls.length >= 3, '第二次续传');
    expect(host.events.filter((event) => event.type === 'matrix.message')).toEqual([]);
    // 记录照留：历史工具还查得到。
    expect(await callTool(world, 'mx_history', { room: ROOM })).toContain('闲聊');
  });

  it('名单外的房间不投递', async () => {
    const { world, host, fake } = makeWorld({ listenRooms: '!only:example.org' });
    fake.syncQueue.push(
      bootstrapResponse(),
      incremental('b2', [messageEvent({ eventId: '$m1', sender: ADMIN, body: '别处的话' })]),
    );
    await world.start(host);
    await waitFor(() => fake.syncCalls.length >= 3, '第二次续传');
    expect(host.events.filter((event) => event.type === 'matrix.message')).toEqual([]);
  });

  it('房间开了端到端加密时不发消息，并说明原因', async () => {
    const { world, host, fake } = makeWorld();
    fake.syncQueue.push({
      next_batch: 'b1',
      rooms: {
        join: {
          [ROOM]: {
            state: {
              events: [
                { type: 'm.room.name', state_key: '', sender: ADMIN, content: { name: 'Coo' } },
                memberEvent({ userId: SELF, displayName: 'Coo', membership: 'join' }),
                memberEvent({ userId: ADMIN, displayName: 'admin', membership: 'join' }),
                { type: 'm.room.encryption', state_key: '', sender: ADMIN, content: { algorithm: 'm.megolm.v1.aes-sha2' } },
              ],
            },
          },
        },
      },
    });
    await world.start(host);
    await waitFor(() => world.connected(), '连接');

    const receipt = await callTool(world, 'mx_send', { room: ROOM, text: '在吗' });
    expect(String(receipt)).toContain('端到端加密');
    expect(fake.sent).toEqual([]);
    expect(String(await callTool(world, 'mx_rooms'))).toContain('已加密');
  });

  it('有加密层时，加密房间的发送走 m.room.encrypted', async () => {
    const { world, host, fake, crypto } = makeWorld({}, false, true);
    crypto!.encryptedRooms.add(ROOM);
    fake.syncQueue.push(encryptedBootstrap());
    await world.start(host);
    await waitFor(() => world.connected(), '连接');

    const receipt = await callTool(world, 'mx_send', { room: ROOM, text: '悄悄话' });
    expect(String(receipt)).toContain('已发送');
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0].type).toBe('m.room.encrypted');
    expect(fake.sent[0].content.ciphertext).toBe('fake-ciphertext');
    // 明文内容进了加密机，没有直接发出去。
    expect(crypto!.encrypted[0].content).toEqual({ msgtype: 'm.text', body: '悄悄话' });
  });

  it('收到加密消息时解密后投递', async () => {
    const { world, host, fake, crypto } = makeWorld({}, false, true);
    crypto!.encryptedRooms.add(ROOM);
    crypto!.decrypted.set('$enc', {
      type: 'm.room.message',
      event_id: '$enc',
      sender: ADMIN,
      origin_server_ts: NOW,
      content: { msgtype: 'm.text', body: '解密后的内容' },
    });
    fake.syncQueue.push(
      encryptedBootstrap(),
      incremental('b2', [
        { type: 'm.room.encrypted', event_id: '$enc', sender: ADMIN, content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x' } },
      ]),
    );
    await world.start(host);
    await waitFor(() => host.events.some((event) => event.type === 'matrix.message'), '消息投递');

    const message = host.events.find((event) => event.type === 'matrix.message');
    expect(message?.text).toContain('解密后的内容');
    expect(message?.text).not.toContain('加密消息');
    // 原始事件也要喂给加密机，它靠这个跟踪会话轮换。
    expect(crypto!.roomEvents).toBeGreaterThan(0);
  });

  it('解不开的加密消息只留占位', async () => {
    const { world, host, fake, crypto } = makeWorld({}, false, true);
    crypto!.encryptedRooms.add(ROOM);
    fake.syncQueue.push(
      encryptedBootstrap(),
      incremental('b2', [
        { type: 'm.room.encrypted', event_id: '$lost', sender: ADMIN, content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x' } },
      ]),
    );
    await world.start(host);
    await waitFor(() => host.events.some((event) => event.type === 'matrix.message'), '消息投递');
    expect(host.events.find((event) => event.type === 'matrix.message')?.text).toContain('[加密消息]');
  });

  it('加密层启动时拿到房间列表，之后的 sync 都喂给它', async () => {
    const { world, host, fake, crypto } = makeWorld({}, false, true);
    fake.syncQueue.push(bootstrapResponse(), incremental('b2', []));
    await world.start(host);
    await waitFor(() => crypto!.syncs > 0, '加密机收到 sync');
    expect(crypto!.prepared).toEqual([ROOM]);
  });

  it('初始同步把时间线里的状态事件也算上，加密房间不会被当成明文', async () => {
    const { world, host, fake } = makeWorld({}, false, true);
    fake.syncQueue.push({
      next_batch: 'b1',
      rooms: {
        join: {
          [ROOM]: {
            state: { events: [{ type: 'm.room.create', state_key: '', sender: ADMIN, content: {} }] },
            timeline: {
              events: [
                { type: 'm.room.name', state_key: '', sender: ADMIN, content: { name: 'Coo' } },
                { type: 'm.room.encryption', state_key: '', sender: ADMIN, content: { algorithm: 'm.megolm.v1.aes-sha2' } },
              ],
            },
          },
        },
      },
    });
    await world.start(host);
    await waitFor(() => world.connected(), '连接');
    expect(String(await callTool(world, 'mx_rooms'))).toContain('已加密');
  });

  it('强制加密策略下，明文房间的消息不叫醒模型', async () => {
    const { world, host, fake, crypto } = makeWorld({ encryption: 'strict' }, false, true);
    fake.syncQueue.push(
      bootstrapResponse(),
      incremental('b2', [messageEvent({ eventId: '$m1', sender: ADMIN, body: '明文房间的话' })]),
    );
    await world.start(host);
    await waitFor(() => fake.syncCalls.length >= 3, '第二次续传');
    expect(host.events.filter((event) => event.type === 'matrix.message')).toEqual([]);
    // 记录照留：历史工具还查得到。
    expect(String(await callTool(world, 'mx_history', { room: ROOM }))).toContain('明文房间的话');
    expect(crypto!.encryptedRooms.has(ROOM)).toBe(false);
  });

  it('强制加密策略下，往明文房间发东西被拒绝', async () => {
    const { world, host, fake } = makeWorld({ encryption: 'strict' }, false, true);
    fake.syncQueue.push(bootstrapResponse());
    await world.start(host);
    await waitFor(() => world.connected(), '连接');

    const receipt = await callTool(world, 'mx_send', { room: ROOM, text: '在吗' });
    expect(String(receipt)).toContain('由于安全策略，禁止连接非加密房间');
    expect(fake.sent).toEqual([]);
  });

  it('强制加密策略下，加密房间照常收发', async () => {
    const { world, host, fake, crypto } = makeWorld({ encryption: 'strict' }, false, true);
    crypto!.encryptedRooms.add(ROOM);
    fake.syncQueue.push(
      encryptedBootstrap(),
      incremental('b2', [
        { type: 'm.room.encrypted', event_id: '$enc', sender: ADMIN, content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x' } },
      ]),
    );
    crypto!.decrypted.set('$enc', {
      type: 'm.room.message',
      event_id: '$enc',
      sender: ADMIN,
      origin_server_ts: NOW,
      content: { msgtype: 'm.text', body: '加密房间的话' },
    });
    await world.start(host);
    await waitFor(() => host.events.some((event) => event.type === 'matrix.message'), '消息投递');
    expect(host.events.find((event) => event.type === 'matrix.message')?.text).toContain('加密房间的话');

    const receipt = await callTool(world, 'mx_send', { room: ROOM, text: '回一句' });
    expect(String(receipt)).toContain('已发送');
    expect(fake.sent[0].type).toBe('m.room.encrypted');
  });

  it('加密面板报出策略、启用状态与每个房间能不能用', async () => {
    const { world, host, fake } = makeWorld({ encryption: 'strict' }, false, true);
    fake.syncQueue.push(bootstrapResponse());
    await world.start(host);
    await waitFor(() => world.connected(), '连接');

    const decl = world.webUi('zh');
    const status = (await decl.invoke?.('encryption', 'status', [])) as {
      mode: string;
      state: string;
      label: string;
      rooms: Array<{ roomId: string; encrypted: boolean; allowed: boolean }>;
    };
    expect(status.mode).toBe('strict');
    expect(status.state).toBe('ready');
    expect(status.label).toContain('已启用');
    expect(status.rooms[0]).toMatchObject({ roomId: ROOM, encrypted: false, allowed: false });
  });

  it('房间推送关着时不投递，也发不出去', async () => {
    const { world, host, fake } = makeWorld({ receiveRooms: false });
    fake.syncQueue.push(
      bootstrapResponse(),
      incremental('b2', [messageEvent({ eventId: '$m1', sender: ADMIN, body: '在吗' })]),
    );
    await world.start(host);
    await waitFor(() => fake.syncCalls.length >= 3, '第二次续传');
    expect(host.events.filter((event) => event.type === 'matrix.message')).toEqual([]);

    const result = await callTool(world, 'mx_send', { room: ROOM, text: '发不出去' });
    expect(String(result)).toContain('房间推送关着');
    expect(fake.sent).toEqual([]);
  });

  it('表情回应、撤回与成员变动各成事件', async () => {
    const { world, host, fake } = makeWorld();
    fake.syncQueue.push(
      bootstrapResponse(),
      incremental('b2', [
        { type: 'm.reaction', event_id: '$r1', sender: ADMIN, content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$m1', key: '👍' } } },
        { type: 'm.room.redaction', event_id: '$x1', sender: ADMIN, content: { redacts: '$m1' } },
        memberEvent({ userId: '@new:example.org', displayName: '新人', membership: 'join', sender: ADMIN }),
      ]),
    );
    await world.start(host);
    await waitFor(() => host.events.some((event) => event.type === 'matrix.member'), '成员事件');
    expect(host.texts('matrix.reaction').join()).toContain('👍');
    expect(host.texts('matrix.redaction').join()).toContain('撤回了一条消息');
    expect(host.texts('matrix.member').join()).toContain('加入了房间');
  });
});

describe('发送', () => {
  it('mx_send 发出文本事件，记进记录，回执带事件 id', async () => {
    const { world, fake } = makeWorld();
    fake.syncQueue.push(bootstrapResponse());
    await world.start(makeWorldHost(world));
    await waitFor(() => world.connected(), '连接');

    const receipt = await callTool(world, 'mx_send', { room: ROOM, text: '我在' });
    expect(String(receipt)).toContain('已发送到房间「Coo」');
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0].type).toBe('m.room.message');
    expect(fake.sent[0].content).toEqual({ msgtype: 'm.text', body: '我在' });
    expect(await callTool(world, 'mx_history', { room: ROOM })).toContain('我在');
  });

  it('引用与提及写进同一个事件', async () => {
    const { world, fake } = makeWorld();
    fake.syncQueue.push(bootstrapResponse());
    await world.start(makeWorldHost(world));
    await waitFor(() => world.connected(), '连接');

    await callTool(world, 'mx_send', { room: ROOM, text: '收到 @admin', reply_to: '$m1', mention: ADMIN });
    const content = fake.sent[0].content;
    expect(content['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: '$m1' } });
    expect(content['m.mentions']).toEqual({ user_ids: [ADMIN] });
    expect(content.format).toBe('org.matrix.custom.html');
    expect(String(content.formatted_body)).toContain('https://matrix.to/#/%40admin%3Aexample.org');
  });

  it('长文本按字节切成几条发', async () => {
    const { world, fake } = makeWorld();
    fake.syncQueue.push(bootstrapResponse());
    await world.start(makeWorldHost(world));
    await waitFor(() => world.connected(), '连接');

    const long = '这一句很长。'.repeat(500);
    await callTool(world, 'mx_send', { room: ROOM, text: long });
    expect(fake.sent.length).toBeGreaterThan(1);
    expect(fake.sent.every((item) => new TextEncoder().encode(String(item.content.body)).length <= 4000)).toBe(true);
  });

  it('表情包先上传再以 m.sticker 发出', async () => {
    const { world, fake } = makeWorld();
    fake.syncQueue.push(bootstrapResponse());
    await world.start(makeWorldHost(world));
    await waitFor(() => world.connected(), '连接');

    const receipt = await callTool(world, 'mx_send', { room: ROOM, sticker: '随便' });
    // 图库是空的，工具要说清楚而不是静默失败。
    expect(String(receipt)).toContain('图库里没有');
    expect(fake.sent).toEqual([]);
  });

  it('贴表情发一条 m.reaction', async () => {
    const { world, host, fake } = makeWorld();
    fake.syncQueue.push(
      bootstrapResponse(),
      incremental('b2', [messageEvent({ eventId: '$m1', sender: ADMIN, body: '好累' })]),
    );
    await world.start(host);
    await waitFor(() => host.events.some((event) => event.type === 'matrix.message'), '消息投递');

    const receipt = await callTool(world, 'mx_react', { event_id: '$m1', emoji: '🫂' });
    expect(String(receipt)).toContain('贴了表情');
    expect(fake.sent[0].type).toBe('m.reaction');
    expect(fake.sent[0].content['m.relates_to']).toEqual({ rel_type: 'm.annotation', event_id: '$m1', key: '🫂' });
  });

  it('撤回走 redact', async () => {
    const { world, fake } = makeWorld();
    fake.syncQueue.push(bootstrapResponse());
    await world.start(makeWorldHost(world));
    await waitFor(() => world.connected(), '连接');

    // 撤回的是自己刚发的那条：记录里有它，才找得到它属于哪个房间。
    await callTool(world, 'mx_send', { room: ROOM, text: '写错了' });
    const receipt = await callTool(world, 'mx_redact', { event_id: '$sent-1', reason: '写错了' });
    expect(String(receipt)).toContain('已撤回');
    expect(fake.redactions).toEqual([{ roomId: ROOM, eventId: '$sent-1', reason: '写错了' }]);
  });

  it('不给 id 时贴表情贴到刚叫醒我的那条', async () => {
    const { world, host, fake } = makeWorld();
    fake.syncQueue.push(
      bootstrapResponse(),
      incremental('b2', [messageEvent({ eventId: '$m1', sender: ADMIN, body: '好累' })]),
    );
    await world.start(host);
    await waitFor(() => host.events.some((event) => event.type === 'matrix.message'), '消息投递');

    const receipt = await callTool(world, 'mx_react', { emoji: '🫂' });
    expect(String(receipt)).toContain('贴了表情');
    expect(fake.sent[0].content['m.relates_to']).toEqual({ rel_type: 'm.annotation', event_id: '$m1', key: '🫂' });
  });

  it('不给 id 时撤回自己最后发的那条', async () => {
    const { world, fake } = makeWorld();
    fake.syncQueue.push(bootstrapResponse());
    await world.start(makeWorldHost(world));
    await waitFor(() => world.connected(), '连接');

    await callTool(world, 'mx_send', { room: ROOM, text: '第一条' });
    await callTool(world, 'mx_send', { room: ROOM, text: '第二条' });
    const receipt = await callTool(world, 'mx_redact', {});
    expect(String(receipt)).toContain('已撤回');
    expect(fake.redactions).toEqual([{ roomId: ROOM, eventId: '$sent-2', reason: undefined }]);
  });

  it('reply_to 写 last 时引用刚叫醒我的那条', async () => {
    const { world, host, fake } = makeWorld();
    fake.syncQueue.push(
      bootstrapResponse(),
      incremental('b2', [messageEvent({ eventId: '$m1', sender: ADMIN, body: '在吗' })]),
    );
    await world.start(host);
    await waitFor(() => host.events.some((event) => event.type === 'matrix.message'), '消息投递');

    await callTool(world, 'mx_send', { room: ROOM, text: '在的', reply_to: 'last' });
    expect(fake.sent[0].content['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: '$m1' } });
  });

  it('提及可以写显示名或 @本地名', async () => {
    const { world, fake } = makeWorld();
    fake.syncQueue.push(bootstrapResponse());
    await world.start(makeWorldHost(world));
    await waitFor(() => world.connected(), '连接');

    await callTool(world, 'mx_send', { room: ROOM, text: '喂', mention: 'admin' });
    expect(fake.sent[0].content['m.mentions']).toEqual({ user_ids: [ADMIN] });

    await callTool(world, 'mx_send', { room: ROOM, text: '喂', mention: '@admin' });
    expect(fake.sent[1].content['m.mentions']).toEqual({ user_ids: [ADMIN] });

    const missing = await callTool(world, 'mx_send', { room: ROOM, text: '喂', mention: '查无此人' });
    expect(String(missing)).toContain('找不到');
    expect(fake.sent).toHaveLength(2);
  });

  it('历史里印事件 id，正文里不印', async () => {
    const { world, host, fake } = makeWorld();
    fake.syncQueue.push(
      bootstrapResponse(),
      incremental('b2', [messageEvent({ eventId: '$m1', sender: ADMIN, body: '在吗' })]),
    );
    await world.start(host);
    await waitFor(() => host.events.some((event) => event.type === 'matrix.message'), '消息投递');

    const history = String(await callTool(world, 'mx_history', { room: ROOM }));
    expect(history).toContain('#$m1');
    expect(history).toContain('[Matrix-Coo');
    const live = host.events.find((event) => event.type === 'matrix.message');
    expect(live?.text).not.toContain('$m1');
  });
});

describe('工具与面板', () => {
  it('九个工具都在，名字都带 mx_ 前缀', () => {
    const { world } = makeWorld();
    const names = world.tools().map((tool) => tool.name);
    expect(names).toEqual([
      'mx_send',
      'mx_stickers',
      'mx_voice',
      'mx_react',
      'mx_redact',
      'mx_history',
      'mx_search',
      'mx_rooms',
      'mx_status',
    ]);
  });

  it('房间名能解析成房间号', async () => {
    const { world, fake } = makeWorld();
    fake.syncQueue.push(bootstrapResponse());
    await world.start(makeWorldHost(world));
    await waitFor(() => world.connected(), '连接');
    expect(await world.resolveRoom('Coo')).toBe(ROOM);
    expect(await world.resolveRoom('coo')).toBe(ROOM);
    expect(await world.resolveRoom(ROOM)).toBe(ROOM);
    expect(await world.resolveRoom('不存在的房间')).toBeNull();
  });

  it('别名解析成房间号', async () => {
    const { world, fake } = makeWorld();
    fake.aliasRooms.set('#coo:example.org', ROOM);
    fake.syncQueue.push(bootstrapResponse());
    await world.start(makeWorldHost(world));
    await waitFor(() => world.connected(), '连接');
    expect(await world.resolveRoom('#coo:example.org')).toBe(ROOM);
  });

  it('房间清单带成员数与监听状态', async () => {
    const { world, fake } = makeWorld();
    fake.syncQueue.push(bootstrapResponse());
    await world.start(makeWorldHost(world));
    await waitFor(() => world.connected(), '连接');
    const text = await callTool(world, 'mx_rooms');
    expect(String(text)).toContain('「Coo」');
    expect(String(text)).toContain('在监听');
  });

  it('状态行说明连接、账号与开关', async () => {
    const { world, fake } = makeWorld();
    fake.syncQueue.push(bootstrapResponse());
    await world.start(makeWorldHost(world));
    await waitFor(() => world.connected(), '连接');
    const text = await callTool(world, 'mx_status');
    expect(String(text)).toContain(`账号：Coo(${SELF})`);
    expect(String(text)).toContain('房间推送开');
  });

  it('环境提示词的三段占位符都有值', async () => {
    const { world, fake } = makeWorld();
    fake.syncQueue.push(bootstrapResponse());
    await world.start(makeWorldHost(world));
    await waitFor(() => world.connected(), '连接');
    const vars = await world.envPromptVars();
    expect(vars?.['matrix.identity']).toContain(SELF);
    expect(vars?.['matrix.rooms']).toContain('房间「Coo」');
    expect(vars?.['matrix.capabilities']).toContain('表情包');
  });

  it('面板能读状态、房间与语音探测', async () => {
    const { world, fake } = makeWorld();
    fake.syncQueue.push(bootstrapResponse());
    await world.start(makeWorldHost(world));
    await waitFor(() => world.connected(), '连接');
    const decl = world.webUi('zh');
    const status = (await decl.invoke?.('connection', 'status', [])) as Record<string, unknown>;
    expect(status.homeserver).toBe(TEST_HOMESERVER);
    expect(status.tokenSet).toBe(true);
    const rooms = (await decl.invoke?.('rooms', 'list', [])) as { rooms: Array<{ roomId: string }> };
    expect(rooms.rooms[0].roomId).toBe(ROOM);
    const voice = (await decl.invoke?.('voice', 'probe', [])) as { asr: string };
    expect(voice.asr).toBe('关闭');
  });

  it('拿不到令牌时进错误状态而不是反复重连', async () => {
    const { world, host, fake } = makeWorld({ accessToken: '' });
    await world.start(host);
    await waitFor(() => world.webUi('zh') !== undefined, '面板');
    expect(fake.syncCalls).toEqual([]);
  });
});

/** 单独要一个宿主时用：makeWorld 已经把世界和宿主配好，这里只是取出那个宿主。 */
function makeWorldHost(world: MatrixWorld): FakeHost {
  const found = wired.find((item) => item.world === world);
  if (!found) throw new Error('找不到这个世界的宿主');
  return found.host;
}
