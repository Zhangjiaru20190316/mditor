// 文件预读缓存（LRU）：文件树 hover 时预读 markdown 文件，openPath 命中缓存
// 则跳过 readTextFile，让切换近乎瞬时。预读不阻塞、失败静默，绝不污染错误态。
// 只缓存 ≤1MB 的 Markdown 文件；超出上限按 LRU 淘汰最久未访问的项。
//
// 新鲜度（v3.9.1 数据丢失修复）：缓存条目同时记录预读时的 size+mtime。
// readFresh 命中缓存时先 stat 比对，不一致（本应用保存或外部程序改写）则
// 重读磁盘；保存/外部重载路径还会调用 invalidatePrefetch 主动删除条目。
// 双保险确保缓存永远不会把旧内容写回磁盘覆盖新内容。

import { readTextFile, stat } from "@tauri-apps/plugin-fs";
import { extname } from "./path-shim";
import { MD_EXTS } from "./tauriFs";

const CAPACITY = 20;
const MAX_BYTES = 1 * 1024 * 1024; // 1 MiB —— 超过此大小不预读（避免占用过多内存）

interface CacheEntry {
  content: string;
  /** 预读时 stat 采样的文件大小与修改时间，readFresh 用于过期校验。 */
  size: number;
  mtime: number | null;
}

// Map 保持插入序：首个 entry 即最久未访问，用作 LRU 淘汰对象。
const cache = new Map<string, CacheEntry>();
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
  return v != null && v.content.length >= minChars ? v.content : null;
}

/** 主动失效：保存成功 / 外部程序重载后调用，删除对应缓存条目。 */
export function invalidatePrefetch(path: string): void {
  cache.delete(path);
}

async function statFingerprint(path: string): Promise<{ size: number; mtime: number | null } | null> {
  try {
    const info = await stat(path);
    return { size: info.size, mtime: info.mtime != null ? info.mtime.getTime() : null };
  } catch {
    return null;
  }
}

/**
 * 读取文件内容，优先复用预读缓存。缓存命中时先 stat 比对 size+mtime：
 * 一致才采用缓存内容，否则重读磁盘并更新缓存。任何一步失败都回退 readTextFile
 * 的正常（失败）路径，让 openPath 的错误处理接管。
 */
export async function readFresh(path: string): Promise<string> {
  const entry = cache.get(path);
  if (entry !== undefined) {
    const fp = await statFingerprint(path);
    if (fp !== null && fp.size === entry.size && fp.mtime === entry.mtime) {
      // 命中且未过期：LRU 刷新后返回缓存内容。
      cache.delete(path);
      cache.set(path, entry);
      return entry.content;
    }
    // 过期（保存/外部修改）或 stat 异常：按未命中处理，重读磁盘。
    cache.delete(path);
  }
  const content = await readTextFile(path);
  return content;
}

/** 预读一个路径并存入缓存。跳过大文件（>1MB）与非 md 文件；失败静默。 */
export async function prefetchFile(path: string): Promise<void> {
  lastHoverPath = path;
  if (cache.has(path)) return;
  if (!isPrefetchable(path)) return;
  try {
    const info = await stat(path);
    if (info.size > MAX_BYTES) return; // 大文件不预读，留给 openPath 正常读取
    const fingerprint = {
      size: info.size,
      mtime: info.mtime != null ? info.mtime.getTime() : null,
    };
    const content = await readTextFile(path);
    // 异步期间可能已被别处写入，再次确认后写入。
    if (!cache.has(path)) {
      cache.set(path, { content, ...fingerprint });
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
