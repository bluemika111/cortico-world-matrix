/**
 * 音频落盘与转码。房间里的语音多是 ogg/opus，识别服务吃的是 wav。
 * 这一层只管调 ffmpeg；没有 ffmpeg 时明确报告不可用，由上层决定怎么降级。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 跑一个外部命令，收 stdout/stderr，超时杀掉。 */
export function run(command: string, args: string[], timeoutMs = 60_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: null, stdout, stderr: `${stderr}\n超时(${timeoutMs}ms)` });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      finish({ ok: false, code: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/** 找到能用的 ffmpeg：配置里给的路径优先，其次 PATH。 */
export async function locateFfmpeg(configured: string): Promise<string | null> {
  if (configured.trim()) {
    const path = configured.trim();
    if (!existsSync(path)) return null;
    const probe = await run(path, ['-version'], 10_000);
    return probe.ok ? path : null;
  }
  const which = process.platform === 'win32' ? 'where' : 'which';
  const found = await run(which, ['ffmpeg'], 10_000);
  const first = found.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!found.ok || !first) return null;
  return first;
}

/** 从 ffmpeg 的 stderr 里读时长，单位毫秒；读不出返回 null。 */
export function parseDurationMs(stderr: string): number | null {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
}

/** 问一下音频多长；拿不到 ffmpeg 时返回 null。 */
export async function probeDurationMs(ffmpeg: string, file: string): Promise<number | null> {
  const result = await run(ffmpeg, ['-hide_banner', '-i', file, '-f', 'null', '-'], 30_000);
  return parseDurationMs(result.stderr);
}

/** 任意音频转成识别服务要的 16k 单声道 wav。 */
export async function toWav(ffmpeg: string, source: string, target: string): Promise<boolean> {
  await mkdir(dirname(target), { recursive: true });
  const result = await run(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', target],
    120_000,
  );
  return result.ok;
}

/** 截取前若干秒；用于把超长语音压到上限以内。 */
export async function truncate(ffmpeg: string, source: string, target: string, seconds: number): Promise<boolean> {
  await mkdir(dirname(target), { recursive: true });
  const result = await run(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-t', String(seconds), '-ac', '1', '-ar', '24000', '-b:a', '48k', target],
    120_000,
  );
  return result.ok;
}

/** 把一段音频转成 mp3，尽量压小再上传。 */
export async function toMp3(ffmpeg: string, source: string, target: string): Promise<boolean> {
  await mkdir(dirname(target), { recursive: true });
  const result = await run(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-vn', '-ac', '1', '-ar', '24000', '-b:a', '48k', target],
    120_000,
  );
  return result.ok;
}

/** 读文件成字节；读不出返回 null。 */
export async function readBytes(file: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(file));
  } catch {
    return null;
  }
}

/** 写字节成文件。 */
export async function writeBytes(file: string, bytes: Uint8Array): Promise<boolean> {
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
    return true;
  } catch {
    return false;
  }
}

/** 从 MIME 猜一个扩展名；猜不出时给 .bin。 */
export function extensionOfMime(mime: string): string {
  switch (mime) {
    case 'audio/ogg':
      return '.ogg';
    case 'audio/opus':
      return '.opus';
    case 'audio/mpeg':
      return '.mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav';
    case 'audio/mp4':
    case 'audio/m4a':
      return '.m4a';
    case 'audio/flac':
      return '.flac';
    case 'audio/amr':
      return '.amr';
    default:
      return '.bin';
  }
}
