/**
 * 用真实服务器把整个 World 跑一遍：连上、同步、回填、解析房间、跑工具。
 * 宿主是假的（事件只打印出来），Matrix 那头是真的。
 *
 *   corepack pnpm probe:world              # 只读
 *   corepack pnpm probe:world -- --send    # 再发一条消息并撤回
 *
 * 这是手动验证脚本，不进测试。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope, WorldHost } from 'cortico/core/types.ts';
import { MATRIX_DEFAULTS } from '../src/config.ts';
import { MatrixWorld } from '../src/world.ts';

const send = process.argv.includes('--send');
const keepData = process.argv.includes('--keep');

class PrintHost implements WorldHost {
  events: EventEnvelope[] = [];
  pushDeferred(): void {}
  store = { get: () => undefined, latestCursor: () => 0, range: () => [], around: () => [], grep: () => [] } as unknown as WorldHost['store'];
  blob = () => null;
  modelFacts = { model: () => 'probe', accepts: () => false, contextWindow: () => 128000 } as unknown as WorldHost['modelFacts'];
  log = { child: () => this.log, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, emit: () => {} } as unknown as WorldHost['log'];
  async pushEvent(event: Omit<EventEnvelope, 'cursor'>, opts?: { trigger?: string }): Promise<EventEnvelope> {
    const full = { ...event, cursor: this.events.length + 1 } as EventEnvelope;
    this.events.push(full);
    console.log(`\n[事件 ${full.type} · ${opts?.trigger ?? 'default'}]`);
    console.log(full.text);
    return full;
  }
  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }
  reportUsage(): void {}
}

const dataDir = await mkdtemp(join(tmpdir(), 'matrix-world-'));
const cfg = { ...structuredClone(MATRIX_DEFAULTS), enabled: true };
const host = new PrintHost();
const world = new MatrixWorld({
  cfg,
  timezone: 'Asia/Shanghai',
  dataDir,
  botName: 'Coo',
  secret: () => undefined,
  persist: (patch) => Object.assign(cfg, patch),
  restart: () => {},
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let failures = 0;
function bad(label: string, detail: string): void {
  failures += 1;
  console.log(`× ${label} — ${detail}`);
}
function ok(label: string, detail = ''): void {
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

try {
  const started = Date.now();
  await world.start(host);
  // sync 的首轮要等 identify + 全量同步 + 回填，给足时间。
  for (let i = 0; i < 100 && !world.connected(); i += 1) await wait(100);
  if (!world.connected()) bad('连接', '10 秒内没有连上');
  else ok('连接', `${Date.now() - started}ms`);

  console.log('\n--- mx_status ---');
  console.log(await tool('mx_status'));
  console.log('\n--- mx_rooms ---');
  console.log(await tool('mx_rooms'));
  console.log('\n--- 历史工具 ---');
  console.log(await tool('mx_history', { limit: 6 }));

  const vars = await world.envPromptVars();
  console.log('\n--- 环境提示词变量 ---');
  for (const [key, value] of Object.entries(vars ?? {})) console.log(`${key}: ${value}`);

  const rooms = await tool('mx_rooms');
  const firstRoom = [...rooms.matchAll(/![\w-]+:[\w.-]+/g)].map((match) => match[0])[0];
  if (!firstRoom) bad('房间', '工具输出里没有房间号');
  else {
    ok('房间解析', `${firstRoom} → ${await world.resolveRoom(firstRoom)}`);
    const status = await tool('mx_status');
    const name = /房间「([^」]+)」/.exec(status)?.[1];
    if (name) ok('按名字解析', `${name} → ${await world.resolveRoom(name)}`);
  }

  if (send && firstRoom) {
    console.log('\n--- 发一条并撤回 ---');
    const receipt = await tool('mx_send', { room: firstRoom, text: '插件自检：World 走通了。' });
    console.log(receipt);
    const eventId = /事件 id (\S+?)。/.exec(String(receipt))?.[1];
    if (!eventId) bad('发消息', '回执里没有事件 id');
    else {
      ok('发消息', eventId);
      console.log(await tool('mx_redact', { event_id: eventId, reason: '开发自检' }));
    }
  }
} finally {
  await world.stop();
  if (!keepData) await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  else console.log(`\n数据留在 ${dataDir}`);
}

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
process.exitCode = failures === 0 ? 0 : 1;

async function tool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const found = world.tools().find((item) => item.name === name);
  if (!found) throw new Error(`没有工具 ${name}`);
  const result = await found.handler(args, { role: 'probe', log: host.log } as never);
  return typeof result === 'string' ? result : result.text;
}
