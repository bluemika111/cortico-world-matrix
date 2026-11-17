/**
 * 对真实 homeserver 走一遍这个扩展的客户端：版本、账号、房间、sync、发一条再撤回。
 *
 *   corepack pnpm probe                 # 只读检查
 *   corepack pnpm probe -- --send       # 再发一条消息并撤回
 *
 * 地址、令牌与房间默认取扩展的默认配置，可用 PROBE_HOMESERVER / PROBE_TOKEN /
 * PROBE_ROOM 覆盖。这是手动验证脚本，不进测试。
 */
import { MatrixClient, MatrixError } from '../src/matrix/client.ts';
import { encodeSegment, parseMxc } from '../src/matrix/ids.ts';
import { MATRIX_DEFAULTS } from '../src/config.ts';

const homeserver = process.env.PROBE_HOMESERVER?.trim() || MATRIX_DEFAULTS.homeserver;
const accessToken = process.env.PROBE_TOKEN?.trim() || MATRIX_DEFAULTS.accessToken;
const wantedRoom = process.env.PROBE_ROOM?.trim() || '';
const send = process.argv.includes('--send');

const log = {
  child: () => log,
  info: (text: string, fields?: unknown) => console.log('  ·', text, fields ?? ''),
  warn: (text: string, fields?: unknown) => console.log('  !', text, fields ?? ''),
  error: (text: string, fields?: unknown) => console.log('  ×', text, fields ?? ''),
  debug: () => {},
  trace: () => {},
  emit: () => {},
} as never;

let failures = 0;

function ok(label: string, detail = ''): void {
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

function bad(label: string, detail: string): void {
  failures += 1;
  console.log(`× ${label} — ${detail}`);
}

function ms(started: number): string {
  return `${Date.now() - started}ms`;
}

async function main(): Promise<void> {
  const client = new MatrixClient({ homeserver, accessToken, log });
  console.log(`服务器 ${homeserver}`);
  console.log(`房间号编码示例 ${encodeSegment('!qmJoOujSuYtCORt4ZC:example.org')}`);
  console.log('');

  let started = Date.now();
  try {
    const versions = await client.versions();
    ok('版本端点', `${versions.length} 个，最高 ${versions[versions.length - 1] ?? '未知'}（${ms(started)}）`);
  } catch (error) {
    bad('版本端点', describe(error));
    return;
  }

  started = Date.now();
  let selfUserId = '';
  try {
    const who = await client.whoami();
    selfUserId = who.userId;
    ok('whoami', `${who.userId}${who.deviceId ? ` · 设备 ${who.deviceId}` : ''}（${ms(started)}）`);
  } catch (error) {
    bad('whoami', describe(error));
    return;
  }

  started = Date.now();
  let rooms: string[] = [];
  try {
    rooms = await client.joinedRooms();
    ok('已加入的房间', `${rooms.length} 个（${ms(started)}）`);
    for (const roomId of rooms) console.log(`    ${roomId}`);
  } catch (error) {
    bad('房间列表', describe(error));
  }

  const roomId = wantedRoom || rooms[0] || '';
  if (!roomId) {
    bad('房间', '账号没有加入任何房间');
    return;
  }

  started = Date.now();
  try {
    const name = await client.roomName(roomId);
    ok('房间名', `${name ?? '(没有名字)'}（${ms(started)}）`);
  } catch (error) {
    bad('房间名', describe(error));
  }

  started = Date.now();
  try {
    const members = await client.joinedMembers(roomId);
    ok('成员', `${Object.keys(members).length} 人：${Object.entries(members).map(([id, m]) => `${m.display_name ?? ''}${m.display_name ? ' ' : ''}${id}`).join('、')}（${ms(started)}）`);
  } catch (error) {
    bad('成员', describe(error));
  }

  try {
    const encryption = await client.roomState(roomId, 'm.room.encryption');
    ok('加密', encryption ? `开着（这个扩展读不到内容）${JSON.stringify(encryption)}` : '没开');
  } catch (error) {
    bad('加密状态', describe(error));
  }

  started = Date.now();
  try {
    const first = await client.sync(null, 0);
    ok('首次 sync', `next_batch ${first.next_batch}，房间 ${Object.keys(first.rooms?.join ?? {}).length} 个（${ms(started)}）`);
    started = Date.now();
    const second = await client.sync(first.next_batch, 2000);
    ok('续传 sync', `2 秒内返回，next_batch ${second.next_batch}（${ms(started)}）`);
  } catch (error) {
    bad('sync', describe(error));
  }

  started = Date.now();
  try {
    const events = await client.messages(roomId, 3);
    ok('最近消息', `${events.length} 条（${ms(started)}）`);
    for (const event of events.slice(-3)) {
      const body = String((event.content as { body?: unknown } | undefined)?.body ?? '');
      console.log(`    ${event.sender} ${event.type}${body ? `: ${body.slice(0, 60)}` : ''}`);
      const mxc = String((event.content as { url?: unknown } | undefined)?.url ?? '');
      if (mxc && parseMxc(mxc)) {
        try {
          const media = await client.download(mxc);
          ok('媒体下载', `${mxc} → ${media.bytes.byteLength} 字节，${media.mime || '类型未声明'}`);
        } catch (error) {
          bad('媒体下载', describe(error));
        }
      }
    }
  } catch (error) {
    bad('最近消息', describe(error));
  }

  if (!send) {
    console.log('\n（加 --send 再验证发消息与撤回）');
    return;
  }

  started = Date.now();
  let eventId = '';
  try {
    eventId = await client.sendEvent(roomId, 'm.room.message', {
      msgtype: 'm.text',
      body: '插件自检：这是一条开发时发的消息，马上会撤回。',
    });
    ok('发消息', `${eventId}（${ms(started)}）`);
  } catch (error) {
    bad('发消息', describe(error));
    return;
  }

  started = Date.now();
  try {
    await client.redact(roomId, eventId, '开发自检');
    ok('撤回', `${eventId}（${ms(started)}）`);
  } catch (error) {
    bad('撤回', describe(error));
  }

  started = Date.now();
  try {
    await client.upload(new Uint8Array([137, 80, 78, 71]), 'image/png', 'probe.png');
    ok('上传', `一张 4 字节的图（${ms(started)}）`);
  } catch (error) {
    bad('上传', describe(error));
  }
}

function describe(error: unknown): string {
  if (error instanceof MatrixError) return `${error.errcode} ${error.status}：${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

await main();
console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
process.exitCode = failures === 0 ? 0 : 1;
