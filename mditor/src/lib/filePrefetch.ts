// 文件预读缓存（LRU）：文件树 hover 时预读 markdown 文件，openPath 命中缓存
// 则跳过 readTextFile，让切换近乎瞬时。预读不阻塞、失败静默，绝不污染错误态。
// 只缓存 ≤1MB 的 Markdown 文件；超出上限按 LRU 淘汰最久未访问的项。

import { readTextFile, stat } from "@tauri-apps/plugin-fs";
import { extname } from "./path-shim";
import { MD_EXTS } from "./tauriFs";

const CAPACITY = 20;
const MAX_BYTES = 1 * 1024 * 1024; // 1 MiB —— 超过此大小不预读（避免占用过多内存）

// Map 保持插入序：首个 entry 即最久未访问，用作 LRU 淘汰对象。
const cache = new Map<string, string>();
// 最近一次 hover 预读的路径（空闲预解析的目标提示；见 peekHoverContent）。
let lastHoverPath: string | null = null;

/** 是否值得预读：所有受支持的 Markdown 扩展名（与 tauriFs.MD_EXTS 同源）。 */
export function isPrefetchable(path: string): boolean {
  return MD_EXTS.has(extname(path).toLowerCase());
}

/** 空闲预解析目标提示：最后 hover 预读且已进缓存的大文档内容。
 *  不是大文档 / 未缓存返回 null（parsePipeline 会再做缓存命中与预算检查）。 */
export function peekHoverContent(minChars: number): string | null {
  if (!lastHoverPath) return null;
  const v = cache.get(lastHoverPath);
  return v != null && v.length >= minChars ? v : null;
}

/** 命中缓存则返回内容，否则 undefined（命中时刷新到队尾 = 最近访问）。 */
export function readCached(path: string): string | undefined {
  const v = cache.get(path);
  if (v !== undefined) {
    // LRU 刷新：删除后重新插入，使其成为最新访问项。
    cache.delete(path);
    cache.set(path, v);
  }
  return v;
}

/** 预读一个路径并存入缓存。跳过大文件（>1MB）与非 md 文件；失败静默。 */
export async function prefetchFile(path: string): Promise<void> {
  lastHoverPath = path;
  if (cache.has(path)) return;
  if (!isPrefetchable(path)) return;
  try {
    const info = await stat(path);
    if (info.size > MAX_BYTES) return; // 大文件不预读，留给 openPath 正常读取
    const content = await readTextFile(path);
    // 异步期间可能已被别处写入，再次确认后写入。
    if (!cache.has(path)) {
      cache.set(path, content);
      // LRU 淘汰：超出容量时删除最旧项。
      if (cache.size > CAPACITY) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    }
  } catch {
    // 预读失败静默：不污染错误态，openPath 会走原逻辑重读。
  }
}
