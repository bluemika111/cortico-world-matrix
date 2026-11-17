/**
 * 真机验证端到端加密：连上、上传设备密钥、等密钥分发、解密房间里已有的加密消息。
 *
 *   corepack pnpm probe:e2ee [房间号]
 *
 * 第一次跑通常解不开——新设备要等对方客户端把 megolm 会话发过来。脚本会多等几轮，
 * 密钥到了就能解开。这是手动验证脚本，不进测试。
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MATRIX_DEFAULTS } from '../src/config.ts';
import { MatrixClient, type MatrixEvent } from '../src/matrix/client.ts';
import { loadCrypto } from '../src/matrix/crypto.ts';

const homeserver = process.env.PROBE_HOMESERVER?.trim() || MATRIX_DEFAULTS.homeserver;
const accessToken = process.env.PROBE_TOKEN?.trim() || MATRIX_DEFAULTS.accessToken;
const wanted = process.argv[2]?.trim() || '';

const log = {
  child: () => log,
  info: (text: string, fields?: unknown) => console.log('  ·', text, fields ?? ''),
  warn: (text: string, fields?: unknown) => console.log('  !', text, fields ?? ''),
  error: (text: string, fields?: unknown) => console.log('  ×', text, fields ?? ''),
  debug: () => {},
  trace: () => {},
  emit: () => {},
} as never;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const dataDir = await mkdtemp(join(tmpdir(), 'matrix-e2ee-'));
const client = new MatrixClient({ homeserver, accessToken, log });
const rooms = await client.joinedRooms();
const crypto = await loadCrypto({ homeserver, accessToken, dataDir, log });
if (!crypto) {
  console.log('× 加密层没起来：没装 matrix-bot-sdk 或原生模块加载失败');
  process.exit(1);
}

await crypto.prepare(rooms);
console.log(`✓ 加密层就绪，设备 ${crypto.deviceId}`);

const encryptedRooms: string[] = [];
for (const roomId of rooms) {
  if (await crypto.isRoomEncrypted(roomId)) encryptedRooms.push(roomId);
}
console.log(`✓ 加密房间：${encryptedRooms.length} 个${encryptedRooms.length ? `（${encryptedRooms.join('、')}）` : ''}`);
if (encryptedRooms.length === 0) {
  console.log('× 没有加密房间可测：先在客户端里建一个加密房间并发一条消息');
  process.exit(1);
}

const roomId = wanted || encryptedRooms[0];
const events = await client.messages(roomId, 20);
const encrypted = events.filter((event) => event.type === 'm.room.encrypted');
console.log(`· 房间 ${roomId} 里有 ${encrypted.length} 条加密消息`);

// 多轮 sync + 重试：密钥是通过 to-device 异步送来的。
let since: string | null = null;
let decrypted: MatrixEvent | null = null;
for (let round = 1; round <= 6 && !decrypted; round += 1) {
  const response = await client.sync(since, round === 1 ? 0 : 5000);
  since = response.next_batch;
  await crypto.onSync(response);
  for (const event of encrypted) {
    const plain = await crypto.decryptEvent(roomId, event);
    if (plain) {
      decrypted = plain;
      break;
    }
  }
  if (!decrypted) {
    console.log(`· 第 ${round} 轮还没解开，等 3 秒再试`);
    await wait(3000);
  }
}

if (decrypted) {
  const content = decrypted.content ?? {};
  console.log(`✓ 解密成功：${String(content.body ?? JSON.stringify(content)).slice(0, 120)}`);
} else {
  console.log('· 已有的消息解不开（对方客户端不在线时正常），改测自己发一条再读回来');
}

// 自己发一条加密消息再读回来：这条不依赖对方客户端，验的是加密与解密两条路。
const sentId = await client.sendEvent(
  roomId,
  'm.room.encrypted',
  await crypto.encryptEvent(roomId, 'm.room.message', { msgtype: 'm.text', body: '端到端加密自检' }),
);
console.log(`· 已发出一条加密消息 ${sentId}`);

let roundTrip: MatrixEvent | null = null;
for (let round = 1; round <= 6 && !roundTrip; round += 1) {
  const response = await client.sync(since, round === 1 ? 0 : 3000);
  since = response.next_batch;
  await crypto.onSync(response);
  const fresh = await client.messages(roomId, 5);
  const mine = fresh.find((event) => event.event_id === sentId);
  if (mine) roundTrip = await crypto.decryptEvent(roomId, mine);
  if (!roundTrip) await wait(2000);
}

if (roundTrip) {
  const body = String((roundTrip.content ?? {}).body ?? '');
  console.log(`✓ 自己发的加密消息解回来了：${body}`);
} else {
  console.log('× 自己发的加密消息也解不开，加密层有问题');
}

// 收拾现场：把自检消息撤回。
try {
  await client.redact(roomId, sentId, '加密自检');
  console.log('· 已撤回自检消息');
} catch (error) {
  console.log(`! 撤回失败：${error instanceof Error ? error.message : String(error)}`);
}

process.exit(roundTrip ? 0 : 1);
