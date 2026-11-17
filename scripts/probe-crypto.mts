/**
 * 验证加密层能不能在真实服务器上起来：加载 matrix-bot-sdk、上传设备密钥、读房间加密状态。
 * 不需要加密房间——这一步验的是「加密机连得上、密钥传得上去」。
 *
 *   corepack pnpm probe:crypto
 *
 * 这是手动验证脚本，不进测试。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MATRIX_DEFAULTS } from '../src/config.ts';
import { MatrixClient } from '../src/matrix/client.ts';
import { loadCrypto } from '../src/matrix/crypto.ts';

const homeserver = process.env.PROBE_HOMESERVER?.trim() || MATRIX_DEFAULTS.homeserver;
const accessToken = process.env.PROBE_TOKEN?.trim() || MATRIX_DEFAULTS.accessToken;

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

const dataDir = await mkdtemp(join(tmpdir(), 'matrix-crypto-'));
try {
  const client = new MatrixClient({ homeserver, accessToken, log });
  const rooms = await client.joinedRooms();
  ok('房间', `${rooms.length} 个`);

  const started = Date.now();
  let crypto: Awaited<ReturnType<typeof loadCrypto>> = null;
  try {
    crypto = await loadCrypto({ homeserver, accessToken, dataDir, log });
  } catch (error) {
    bad('加载加密层', error instanceof Error ? error.message : String(error));
    bad('下一步', '跑 node node_modules\\@matrix-org\\matrix-sdk-crypto-nodejs\\download-lib.js 补上原生模块');
  }
  if (!crypto) {
    if (failures === 0) bad('加载加密层', '返回 null：没装 matrix-bot-sdk');
  } else {
    ok('加载加密层', `${Date.now() - started}ms`);

    const prepared = Date.now();
    await crypto.prepare(rooms);
    ok('上传设备密钥', `设备 ${crypto.deviceId}（${Date.now() - prepared}ms）`);

    for (const roomId of rooms) {
      const encrypted = await crypto.isRoomEncrypted(roomId);
      ok('房间加密状态', `${roomId} → ${encrypted ? '已加密' : '明文'}`);
    }

    // 再加载一次：密钥应该从 sqlite 里读回来，设备 id 不变。
    const again = await loadCrypto({ homeserver, accessToken, dataDir, log });
    if (!again) bad('二次加载', '返回 null');
    else {
      await again.prepare(rooms);
      ok('二次加载', `设备 ${again.deviceId}${again.deviceId === crypto.deviceId ? '（一致）' : '（变了，密钥没持久化）'}`);
      await again.stop();
    }
    await crypto.stop();
  }
} finally {
  // rust-sdk 的句柄不会自己释放，sqlite 文件还占着：清理交给系统，别在这里等。
  void rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
}

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
// 同上：探针跑完直接退，不等句柄。
process.exit(failures === 0 ? 0 : 1);
