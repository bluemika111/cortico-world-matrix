/**
 * 加密依赖的体检与安装。
 *
 * `matrix-bot-sdk` 是可选的：没装也能跑，只是加密房间读不到。装它有两个坑——
 * 包本身要 `pnpm add`，原生 crypto 模块还要单独下载（pnpm 10+ 默认拦掉依赖的
 * postinstall）。
 *
 * 目录不靠猜：用 `createRequire` 解析原生包的真实位置。扩展可能被应用打包进
 * bot 的构建目录，`import.meta.url` 与 `WorldContext.packageDir` 都指不到它。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'cortico/core/types.ts';

const PACKAGE = 'matrix-bot-sdk';
const NATIVE = '@matrix-org/matrix-sdk-crypto-nodejs';

const require = createRequire(import.meta.url);

/** 扩展自己的包目录：这个文件在 `<包>/src/matrix/deps.ts`。 */
export function packageRoot(): string {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  return existsSync(join(root, 'package.json')) ? root : '';
}

/** 原生包装在哪；解析不到时返回空串。 */
export function nativeDir(): string {
  try {
    return dirname(require.resolve(`${NATIVE}/package.json`));
  } catch {
    return '';
  }
}

/** `matrix-bot-sdk` 装在哪；解析不到时返回空串。 */
export function sdkDir(): string {
  try {
    return dirname(require.resolve(`${PACKAGE}/package.json`));
  } catch {
    return '';
  }
}

export interface DepsStatus {
  /** 安装动作执行的位置：有原生包时是它，否则是扩展目录。 */
  packageDir: string;
  declared: boolean;
  installed: boolean;
  version: string;
  nativeInstalled: boolean;
  loadable: boolean;
  error: string;
}

/** 原生模块的 .node 文件；没有时返回空串。 */
async function nativeBinary(dir: string): Promise<string> {
  if (!dir) return '';
  try {
    const files = await readdir(dir);
    return files.find((name) => name.endsWith('.node')) ?? '';
  } catch {
    return '';
  }
}

/** 体检：声明、安装、原生模块、能否加载，四件事分开报。 */
export async function inspectDeps(): Promise<DepsStatus> {
  const sdk = sdkDir();
  const native = nativeDir();
  const status: DepsStatus = {
    packageDir: native || sdk || packageRoot(),
    declared: false,
    installed: Boolean(sdk),
    version: '',
    nativeInstalled: false,
    loadable: false,
    error: '',
  };

  if (sdk) {
    try {
      const raw = await readFile(join(sdk, 'package.json'), 'utf8');
      status.version = String((JSON.parse(raw) as { version?: unknown }).version ?? '');
      status.declared = true;
    } catch {
      // 读不到版本不影响能不能用。
    }
  }

  status.nativeInstalled = Boolean(await nativeBinary(native));

  try {
    // 它是 CJS 包（入口在 lib/index.js）。动态 import() 在扩展的 TS loader 下会被解析成
    // 包根下的 index.js，报「Cannot find package '…\index.js'」——用 require 走 CJS 解析才对。
    require(PACKAGE);
    status.loadable = true;
  } catch (error) {
    status.error = error instanceof Error ? error.message : String(error);
  }
  return status;
}

export interface InstallResult {
  ok: boolean;
  output: string;
}

interface RunResult {
  ok: boolean;
  output: string;
}

/** 跑一条命令，收 stdout/stderr，超时杀掉。`env` 里的变量追加到子进程环境；`onChunk` 边跑边回传。 */
function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: Record<string, string> = {},
  onChunk?: (text: string) => void,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      // Windows 上 `shell: true` 会经 cmd.exe 再起一层：只设 windowsHide 挡不住它弹窗，
      // 再加 detached（DETACHED_PROCESS）让它不继承控制台，那个黑窗口才不会冒出来。
      // 输入一律不给：pnpm 在非 TTY 下不画进度条，输出是干净的文本，正好直接转给面板。
      windowsHide: true,
      detached: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, ...env },
    });
    let output = '';
    let settled = false;
    const finish = (ok: boolean, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, output: `${output}${extra}`.trim() });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false, `\n超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      onChunk?.(text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      onChunk?.(text);
    });
    child.on('error', (error) => finish(false, `\n${error.message}`));
    child.on('close', (code) => finish(code === 0, code === 0 ? '' : `\n退出码 ${code}`));
  });
}

/** napi 的平台后缀：win32 用 msvc，linux 用 gnu，darwin 不带。 */
function platformSuffix(): string {
  const abi = process.platform === 'win32' ? 'msvc' : process.platform === 'linux' ? 'gnu' : '';
  return [process.platform, process.arch, abi].filter(Boolean).join('-');
}

/**
 * 把原生模块摆成 `index.js` 认得的形状。
 *
 * 它只认两条路：同目录下叫 `matrix-sdk-crypto.<platform>-<arch>[-abi].node` 的文件，
 * 或者 `@matrix-org/matrix-sdk-crypto-nodejs-<platform>-<arch>[-abi]` 这个包。
 * 后者在 npm 上并不存在，而下载脚本存下来的文件名也不一定带平台后缀——两条都补齐。
 */
async function prepareNative(dir: string): Promise<string[]> {
  const notes: string[] = [];
  if (!dir) return notes;
  const suffix = platformSuffix();
  const expected = `matrix-sdk-crypto.${suffix}.node`;
  const binary = await nativeBinary(dir);
  if (!binary) return notes;
  if (binary !== expected) {
    await copyFile(join(dir, binary), join(dir, expected));
    notes.push(`原生模块补了标准文件名：${binary} → ${expected}`);
  }
  const shimDir = join(dirname(dir), `matrix-sdk-crypto-nodejs-${suffix}`);
  if (!existsSync(join(shimDir, 'package.json'))) {
    await mkdir(shimDir, { recursive: true });
    await copyFile(join(dir, expected), join(shimDir, expected));
    const manifest = {
      name: `${NATIVE}-${suffix}`,
      version: '0.4.0',
      os: [process.platform],
      cpu: [process.arch],
      main: expected,
    };
    await writeFile(join(shimDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    notes.push(`平台包桩：${shimDir}`);
  }
  return notes;
}

/**
 * 装依赖。包已经能解析时只补原生模块——那是最常见的失败点，
 * 而且不需要知道扩展装在哪。
 */
export async function installDeps(log: Logger, onProgress?: (text: string) => void): Promise<InstallResult> {
  const steps: string[] = [];
  let ok = true;
  // 一行一行往回吐：面板每两秒拉一次，用户能看到装到哪一步、下载了多少。
  const say = (line: string) => {
    steps.push(line);
    onProgress?.(`${line}\n`);
  };
  const step = async (
    label: string,
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    env?: Record<string, string>,
  ): Promise<RunResult> => {
    say(label);
    const result = await run(command, args, cwd, timeoutMs, env ?? {}, onProgress);
    steps.push(result.output || '(无输出)');
    return result;
  };

  if (!sdkDir()) {
    // 包都没有：装进扩展自己的目录，这样从扩展源码里的 import 才解析得到。
    const target = packageRoot();
    if (!target) {
      say('× 定位不到扩展目录，装不了依赖');
      ok = false;
    } else {
      // 有 pnpm-workspace.yaml 的目录里，不加 -w 会被拒；反过来，解压出来的独立包目录
      // 加了 -w 又会报「--workspace-root may only be used inside a workspace」。
      // 按目录里有没有 workspace 文件决定，再留一次兜底重试。
      const attempt = (withRoot: boolean) =>
        step(
          `$ corepack ${withRoot ? `pnpm add -w ${PACKAGE}` : `pnpm add ${PACKAGE}`}（在 ${target}）`,
          'corepack',
          withRoot ? ['pnpm', 'add', '-w', PACKAGE] : ['pnpm', 'add', PACKAGE],
          target,
          600_000,
        );
      let usedWorkspaceRoot = existsSync(join(target, 'pnpm-workspace.yaml'));
      let add = await attempt(usedWorkspaceRoot);
      if (!add.ok && !usedWorkspaceRoot && /ERR_PNPM_ADDING_TO_ROOT/i.test(add.output)) {
        usedWorkspaceRoot = true;
        add = await attempt(true);
      }
      // pnpm 10+ 会因为「有构建脚本被拦」返回 1，但包其实装上了：以解析得到为准。
      if (!sdkDir()) ok = false;
    }
  } else {
    say(`· ${PACKAGE} 已在 ${sdkDir()}，跳过安装`);
  }

  const dir = nativeDir();
  if (!dir) {
    say(`× 找不到 ${NATIVE}：先装 ${PACKAGE}`);
    ok = false;
  } else if (await nativeBinary(dir)) {
    say(`· 原生模块已在 ${dir}`);
  } else {
    // 下载脚本走 GitHub，杀毒软件或代理的 TLS 中间人会让证书链验不过
    // （UNABLE_TO_VERIFY_LEAF_SIGNATURE）。这一步只拉一个官方二进制，关掉校验换能下下来；
    // 装完这个变量随子进程一起结束，不影响别处。
    const download = await step(
      `$ node download-lib.js（在 ${dir}，证书校验已关：这个下载脚本走 GitHub，TLS 中间人会挡住）`,
      process.execPath,
      [join(dir, 'download-lib.js')],
      dir,
      300_000,
      { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    );
    if (!download.ok) ok = false;
  }

  // 无论刚下完还是文件早就在，都把文件名与平台包桩补齐：index.js 只认那两种形状。
  for (const note of await prepareNative(nativeDir())) say(`· ${note}`);

  const after = await inspectDeps();
  say(
    after.loadable
      ? `✓ 依赖可用：${PACKAGE} ${after.version || '(版本未知)'}`
      : `× 装完仍然加载不了：${after.error || '原因未知'}`,
  );
  if (!after.loadable) ok = false;

  log.info('加密依赖安装结束', { ok, version: after.version });
  return { ok, output: steps.join('\n\n') };
}
