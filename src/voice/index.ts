/**
 * 语音收发。
 *
 * 接收：房间里的 `m.audio` 由 World 下载成字节交给这里 → ffmpeg 转 16k wav → 识别服务 → 文字。
 * 没有 ffmpeg 时把原始字节直接送去识别，多数服务自己认 ogg/opus。
 *
 * 发送：合成一条音频 → 探测时长 → 超过上限就截断或回落成文字 → 由 World 上传并发出 `m.audio`。
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'cortico/core/types.ts';
import type { MatrixVoiceConfig } from '../config.ts';
import {
  type CommandResult,
  extensionOfMime,
  locateFfmpeg,
  probeDurationMs,
  readBytes,
  run,
  toWav,
  truncate,
  writeBytes,
} from './audio.ts';

export interface VoiceDeps {
  cfg: () => MatrixVoiceConfig;
  dataDir: string;
  log: Logger;
  /** 从环境变量或部署的 .env 里取密钥。 */
  secret: (name: string) => string | undefined;
}

export type TranscribeResult = { ok: true; text: string } | { ok: false; reason: string };

export type SynthesizeResult =
  | { ok: true; bytes: Uint8Array; mime: string; durationMs: number | null; truncated: boolean }
  | { ok: true; fallbackText: true; reason: string }
  | { ok: false; reason: string };

/** 识别服务与合成服务共用的探测结果，面板要显示。 */
export interface VoiceProbe {
  ffmpeg: string | null;
  ffmpegDetail: string;
  asr: string;
  tts: string;
}

/** 识别服务的 multipart 需要 MIME；从原始 MIME 透传，认不出时按二进制。 */
function recognizeMime(mime: string): string {
  return mime && mime.startsWith('audio/') ? mime : 'application/octet-stream';
}

function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export class VoiceService {
  private ffmpegPath: string | null = null;
  private ffmpegChecked = false;

  constructor(private readonly deps: VoiceDeps) {}

  private get tempDir(): string {
    const configured = this.deps.cfg().tempDir.trim();
    return configured || join(this.deps.dataDir, 'voice');
  }

  /** 找一次 ffmpeg，之后缓存结果。 */
  async ffmpeg(): Promise<string | null> {
    if (this.ffmpegChecked) return this.ffmpegPath;
    this.ffmpegChecked = true;
    this.ffmpegPath = await locateFfmpeg(this.deps.cfg().ffmpegPath);
    if (!this.ffmpegPath) this.deps.log.warn('没有可用的 ffmpeg，语音转写与截断都不可用');
    return this.ffmpegPath;
  }

  async probe(): Promise<VoiceProbe> {
    const cfg = this.deps.cfg();
    const ffmpeg = await this.ffmpeg();
    return {
      ffmpeg,
      ffmpegDetail: ffmpeg ?? '没找到 ffmpeg：装一个并放进 PATH，或在配置里填路径',
      asr: cfg.asr.provider === 'none' ? '关闭' : `${cfg.asr.provider} · ${cfg.asr.model || '(未填模型)'}`,
      tts: cfg.tts.provider === 'none' ? '关闭' : `${cfg.tts.provider} · ${cfg.tts.model || cfg.tts.voice || '(默认音色)'}`,
    };
  }

  /** 把一条收到的语音转成文字。`id` 只用于临时文件名。 */
  async transcribe(bytes: Uint8Array, mime: string, id: string): Promise<TranscribeResult> {
    const cfg = this.deps.cfg();
    if (!cfg.enabled) return { ok: false, reason: '语音功能没打开' };
    if (cfg.asr.provider === 'none') return { ok: false, reason: '没有配置识别服务' };
    if (bytes.byteLength === 0) return { ok: false, reason: '这条语音是空的' };

    const stamp = `${Date.now()}-${id.replace(/[^\w.-]/g, '').slice(0, 24)}`;
    const raw = join(this.tempDir, `${stamp}${extensionOfMime(mime)}`);
    const wav = join(this.tempDir, `${stamp}.wav`);
    try {
      const ffmpeg = await this.ffmpeg();
      if (ffmpeg) {
        if (!(await writeBytes(raw, bytes))) return { ok: false, reason: '语音文件写不进临时目录' };
        const converted = await toWav(ffmpeg, raw, wav);
        if (!converted) return { ok: false, reason: 'ffmpeg 解不开这条语音' };
        return await this.recognize(await readBytes(wav), 'audio/wav');
      }
      // 没有 ffmpeg：把原样字节交出去，识别服务多半自己认 ogg/opus。
      return await this.recognize(bytes, recognizeMime(mime));
    } finally {
      void rm(raw, { force: true }).catch(() => {});
      void rm(wav, { force: true }).catch(() => {});
    }
  }

  /** 合成一条语音。超过上限时按配置截断或要求调用方回落成文字。 */
  async synthesize(text: string): Promise<SynthesizeResult> {
    const cfg = this.deps.cfg();
    if (!cfg.enabled) return { ok: false, reason: '语音功能没打开' };
    if (!text.trim()) return { ok: false, reason: '要念的内容是空的' };
    if (cfg.tts.provider === 'none') return { ok: false, reason: '没有配置合成服务' };

    const stamp = `${Date.now()}`;
    const raw = join(this.tempDir, `${stamp}-tts.bin`);
    const ready = join(this.tempDir, `${stamp}-tts.out`);
    try {
      const made = await this.speak(text, raw);
      if (!made.ok) return { ok: false, reason: made.reason };

      const ffmpeg = await this.ffmpeg();
      const limitMs = Math.max(1, cfg.maxSeconds) * 1000;
      let durationMs = ffmpeg ? await probeDurationMs(ffmpeg, raw) : null;
      let target = raw;
      let truncated = false;

      if (durationMs !== null && durationMs > limitMs) {
        if (cfg.overlong === 'text') return { ok: true, fallbackText: true, reason: '语音超过上限，改成文字' };
        if (!ffmpeg) return { ok: true, fallbackText: true, reason: '语音超过上限又没有 ffmpeg 可以截断，改成文字' };
        const cut = await truncate(ffmpeg, raw, ready, cfg.maxSeconds);
        if (!cut) return { ok: true, fallbackText: true, reason: '截断失败，改成文字' };
        target = ready;
        durationMs = limitMs;
        truncated = true;
      }

      const bytes = await readBytes(target);
      if (!bytes || bytes.byteLength === 0) return { ok: false, reason: '合成的音频读不出来' };
      return { ok: true, bytes, mime: truncated ? 'audio/mpeg' : made.mime, durationMs, truncated };
    } finally {
      void rm(raw, { force: true }).catch(() => {});
      void rm(ready, { force: true }).catch(() => {});
    }
  }

  /** OpenAI 兼容的 /audio/transcriptions。 */
  private async recognize(bytes: Uint8Array | null, mime: string): Promise<TranscribeResult> {
    if (!bytes || bytes.byteLength === 0) return { ok: false, reason: '语音字节读不出来' };
    const cfg = this.deps.cfg();
    const base = trimBase(cfg.asr.baseUrl);
    if (!base) return { ok: false, reason: '识别地址是空的' };
    const key = cfg.asr.apiKeySecret ? this.deps.secret(cfg.asr.apiKeySecret) : undefined;
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), `audio${extensionOfMime(mime)}`);
    form.append('model', cfg.asr.model || 'whisper-1');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    timer.unref?.();
    try {
      const response = await fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: key ? { Authorization: `Bearer ${key}` } : undefined,
        body: form,
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) return { ok: false, reason: `识别服务回了 ${response.status}：${body.slice(0, 200)}` };
      let text = '';
      try {
        const parsed = JSON.parse(body) as { text?: unknown; result?: unknown };
        text = typeof parsed.text === 'string' ? parsed.text : typeof parsed.result === 'string' ? parsed.result : '';
      } catch {
        text = body.trim();
      }
      text = text.trim();
      return text ? { ok: true, text } : { ok: false, reason: '识别服务返回了空文本' };
    } catch (error) {
      return { ok: false, reason: `识别请求失败：${error instanceof Error ? error.message : String(error)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 合成：OpenAI 兼容 /audio/speech，或 Windows 自带语音。 */
  private async speak(text: string, target: string): Promise<{ ok: true; mime: string } | { ok: false; reason: string }> {
    const cfg = this.deps.cfg();
    if (cfg.tts.provider === 'sapi') return this.speakSapi(text, target);

    const base = trimBase(cfg.tts.baseUrl);
    if (!base) return { ok: false, reason: '合成地址是空的' };
    const key = cfg.tts.apiKeySecret ? this.deps.secret(cfg.tts.apiKeySecret) : undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    timer.unref?.();
    try {
      const response = await fetch(`${base}/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.tts.model || 'tts-1',
          input: text,
          voice: cfg.tts.voice || 'alloy',
          response_format: 'mp3',
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text();
        return { ok: false, reason: `合成服务回了 ${response.status}：${body.slice(0, 200)}` };
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!(await writeBytes(target, bytes))) return { ok: false, reason: '合成的音频写不进临时目录' };
      return { ok: true, mime: 'audio/mpeg' };
    } catch (error) {
      return { ok: false, reason: `合成请求失败：${error instanceof Error ? error.message : String(error)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Windows 自带的 System.Speech：把文本写文件，脚本合成到 wav。 */
  private async speakSapi(text: string, target: string): Promise<{ ok: true; mime: string } | { ok: false; reason: string }> {
    if (process.platform !== 'win32') return { ok: false, reason: 'SAPI 只在 Windows 上有' };
    const cfg = this.deps.cfg();
    const script = fileURLToPath(new URL('./sapi-tts.ps1', import.meta.url));
    const textFile = `${target}.txt`;
    const wav = `${target}.wav`;
    await writeBytes(textFile, new TextEncoder().encode(text));
    try {
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-TextFile', textFile, '-OutFile', wav];
      if (cfg.tts.voice.trim()) args.push('-Voice', cfg.tts.voice.trim());
      const result: CommandResult = await run('powershell.exe', args, 120_000);
      if (!result.ok) return { ok: false, reason: `系统语音合成失败：${result.stderr.slice(-300)}` };
      const bytes = await readBytes(wav);
      if (!bytes) return { ok: false, reason: '系统语音没有写出文件' };
      if (!(await writeBytes(target, bytes))) return { ok: false, reason: '合成的音频写不进临时目录' };
      return { ok: true, mime: 'audio/wav' };
    } catch (error) {
      return { ok: false, reason: `系统语音合成失败：${error instanceof Error ? error.message : String(error)}` };
    } finally {
      void rm(textFile, { force: true }).catch(() => {});
      void rm(wav, { force: true }).catch(() => {});
    }
  }
}
