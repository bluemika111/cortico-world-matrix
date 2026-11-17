/**
 * 表情包图库：一组本地图片，按子目录分组。
 *
 * 目录就是图库：`<dir>/<分组>/<文件>`。没有图片时 Coo 一个表情也发不出来，
 * 所以这里不内置任何图片，只负责索引、搜索、读字节，以及把房间里收到的表情学进来。
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';

export interface StickerEntry {
  /** 相对图库根的路径，发送时用它指定是哪一张。 */
  id: string;
  /** 文件名的可读形式，模型挑图时看它。 */
  name: string;
  /** 分组：所在子目录的名字。 */
  pack: string;
  /** 参与搜索的词：文件名与分组名拆出来的片段。 */
  tags: string[];
  bytes: number;
}

const IMAGE_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

/** 图库只收这个大小以内的图；再大的上传不进媒体仓库。 */
export const STICKER_MAX_BYTES = 4 * 1024 * 1024;

function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s_\-./\\[\]()（）【】]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function mimeOf(file: string): string | undefined {
  return IMAGE_EXT.get(extname(file).toLowerCase());
}

/** 从图片地址或文件名猜 MIME；猜不出时用给定兜底。 */
export function guessImageMime(source: string, fallback = 'image/png'): string {
  const clean = source.split(/[?#]/)[0] ?? '';
  return IMAGE_EXT.get(extname(clean).toLowerCase()) ?? fallback;
}

export class StickerLibrary {
  private entries: StickerEntry[] = [];
  private scannedAt = 0;
  private scanning: Promise<number> | null = null;

  constructor(
    private readonly opts: { dir: string; log: Logger },
  ) {}

  get root(): string {
    return this.opts.dir;
  }

  get size(): number {
    return this.entries.length;
  }

  /** 最近一次扫描的时刻；0 表示还没扫过。 */
  get lastScanAt(): number {
    return this.scannedAt;
  }

  /** 重新扫描目录；同一时刻只跑一次。 */
  async scan(): Promise<number> {
    if (this.scanning) return this.scanning;
    this.scanning = this.doScan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async doScan(): Promise<number> {
    const entries: StickerEntry[] = [];
    const walk = async (dir: string, pack: string): Promise<void> => {
      let items: string[];
      try {
        items = await readdir(dir);
      } catch {
        return;
      }
      for (const item of items) {
        const full = join(dir, item);
        let info;
        try {
          info = await stat(full);
        } catch {
          continue;
        }
        if (info.isDirectory()) {
          await walk(full, pack || item);
          continue;
        }
        const mime = mimeOf(item);
        if (!mime || info.size > STICKER_MAX_BYTES) continue;
        const name = basename(item, extname(item));
        entries.push({
          id: relative(this.opts.dir, full).split(sep).join('/'),
          name,
          pack: pack || '默认',
          tags: [...new Set([...tokensOf(name), ...tokensOf(pack)])],
          bytes: info.size,
        });
      }
    };
    await walk(this.opts.dir, '');
    entries.sort((a, b) => a.pack.localeCompare(b.pack) || a.name.localeCompare(b.name));
    this.entries = entries;
    this.scannedAt = Date.now();
    return entries.length;
  }

  /** 按关键词挑图；空关键词给一批随机的。 */
  search(query: string, limit = 12): StickerEntry[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return this.sample(limit);
    const words = tokensOf(needle);
    const scored = this.entries
      .map((entry) => {
        const haystack = `${entry.name} ${entry.pack}`.toLowerCase();
        let score = 0;
        if (haystack.includes(needle)) score += 5;
        for (const word of words) {
          if (entry.name.toLowerCase().includes(word)) score += 3;
          else if (entry.tags.includes(word)) score += 2;
          else if (haystack.includes(word)) score += 1;
        }
        return { entry, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
    return scored.slice(0, limit).map((item) => item.entry);
  }

  /** 随机抽几张，用于不知道该发什么时先看一眼图库。 */
  sample(limit: number): StickerEntry[] {
    if (this.entries.length <= limit) return [...this.entries];
    const copy = [...this.entries];
    const out: StickerEntry[] = [];
    for (let i = 0; i < limit && copy.length; i += 1) {
      out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
    }
    return out;
  }

  list(pack?: string): StickerEntry[] {
    if (!pack) return [...this.entries];
    return this.entries.filter((entry) => entry.pack === pack);
  }

  /** 分组与每组张数，面板显示用。 */
  packs(): Array<{ name: string; count: number }> {
    const counts = new Map<string, number>();
    for (const entry of this.entries) counts.set(entry.pack, (counts.get(entry.pack) ?? 0) + 1);
    return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 读一张图的字节；文件不在或太大时返回 null。 */
  async read(id: string): Promise<{ bytes: Uint8Array; mime: string; name: string } | null> {
    const entry = this.entries.find((item) => item.id === id) ?? this.entries.find((item) => item.name === id);
    if (!entry) return null;
    const mime = mimeOf(entry.id);
    if (!mime) return null;
    try {
      const bytes = await readFile(join(this.opts.dir, entry.id.split('/').join(sep)));
      if (bytes.byteLength > STICKER_MAX_BYTES) return null;
      return { bytes: new Uint8Array(bytes), mime, name: entry.name };
    } catch {
      return null;
    }
  }

  /**
   * 把一枚收到的表情学进图库。名字用作文件名，同名时覆盖。
   * 只收图片；下载失败或太大的返回 false。
   */
  async learn(name: string, bytes: Uint8Array, mime: string): Promise<boolean> {
    if (!this.opts.dir || bytes.byteLength === 0 || bytes.byteLength > STICKER_MAX_BYTES) return false;
    const ext = [...IMAGE_EXT.entries()].find(([, type]) => type === mime)?.[0] ?? '.png';
    const safe = name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'learned';
    const dir = join(this.opts.dir, '学来的');
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${safe}${ext}`), bytes);
      await this.scan();
      return true;
    } catch (error) {
      this.opts.log.warn('表情收进图库失败', { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }
}
