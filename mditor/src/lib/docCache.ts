// 标签级解析结果缓存（阶段 1 核心）：按内容指纹缓存「markdown → ProseMirror
// 文档 JSON」，LRU + 字节预算。
//
// 解决的问题：切回看过的（未改动）大标签时，旧路径每次都要整篇 remark 重解
// 析（1MB 文档数百 ms 起的主线程长任务）。缓存命中后 useMilkdown.setValue
// 只做 Node.fromJSON + EditorState.create——纯数据构建，远廉价于解析。
//
// 失效策略：
//   * 内容失效——指纹不匹配即未命中（标签被编辑后指纹自然变化，旧条目等
//     LRU 淘汰），无显式失效协议、无路径过期问题；
//   * schema 失效——编辑器重建（recreate / big-doc 档位翻转）会换 Schema，
//     条目携带 schema 签名，不匹配即弃用；
//   * 内存压力——useMemoryGuard 的 10s tick 发现堆超阈值时整体清空
//     （clearDocCache），这是最廉价的回收手段，优先于重建编辑器。
//
// 预算：与文档大小成比例（按源文本字符数近似），总量 ~16MB 源文本、至多
// MAX_ENTRIES 条——只缓存大文档（parse 代价才值得缓存），小文档解析本就
// 不可感知，不占预算。

import { contentFingerprint } from "./parseShared";

/** 单条目以源文本字符数计的预算近似（UTF-16 下 ~2×该值的堆占用）。 */
const MAX_TOTAL_CHARS = 8_000_000;
/** 最多缓存的文档数（再多说明在频繁切换大文档，命中率让位于内存）。 */
const MAX_ENTRIES = 6;
/** 单文档上限（超出说明是极端巨型文本，缓存它不如省着内存）。 */
const MAX_ENTRY_CHARS = 4_000_000;
/** 参与缓存/查询的最小长度：低于此解析本就瞬时，不值得指纹与 JSON 开销。 */
const MIN_CACHED_CHARS = 200_000;

export interface DocCacheEntry {
  /** 源内容指纹（键）。 */
  fp: string;
  /** ProseMirror 文档 JSON（Node.fromJSON 的输入，纯数据）。 */
  json: unknown;
  /** 源文本长度（预算近似）。 */
  chars: number;
  /** 创建该条目时的编辑器 schema 签名。 */
  schemaSig: string;
}

/** Map 保持插入序：首个 entry 即最久未访问，用作 LRU 淘汰对象。 */
const cache = new Map<string, DocCacheEntry>();
let totalChars = 0;

function evictToBudget(): void {
  while (cache.size > 0 && (cache.size > MAX_ENTRIES || totalChars > MAX_TOTAL_CHARS)) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const entry = cache.get(oldest);
    cache.delete(oldest);
    if (entry) totalChars -= entry.chars;
  }
}

/** 是否值得缓存/查询（只管大文档）。 */
export function cacheWorthy(content: string): boolean {
  return content.length >= MIN_CACHED_CHARS;
}

/** 存入解析结果。超出单条上限静默跳过；同指纹重复写入按 LRU 刷新。 */
export function putDoc(content: string, json: unknown, schemaSig: string): void {
  if (content.length > MAX_ENTRY_CHARS) return;
  const fp = contentFingerprint(content);
  const existing = cache.get(fp);
  if (existing) {
    cache.delete(fp);
    totalChars -= existing.chars;
  }
  cache.set(fp, { fp, json, chars: content.length, schemaSig });
  totalChars += content.length;
  evictToBudget();
}

/** 命中则返回文档 JSON（并刷新 LRU），否则 null。schema 签名不匹配视为未命中。 */
export function takeDoc(content: string, schemaSig: string): unknown | null {
  const fp = contentFingerprint(content);
  const entry = cache.get(fp);
  if (!entry) return null;
  if (entry.schemaSig !== schemaSig) {
    cache.delete(fp);
    totalChars -= entry.chars;
    return null;
  }
  // LRU 刷新：删除后重新插入，使其成为最新访问项。
  cache.delete(fp);
  cache.set(fp, entry);
  return entry.json;
}

/** 该内容是否已有缓存条目（用于预解析去重，不刷新 LRU）。 */
export function hasDoc(content: string, schemaSig: string): boolean {
  const entry = cache.get(contentFingerprint(content));
  return !!entry && entry.schemaSig === schemaSig;
}

/** 内存压力回收（useMemoryGuard 超阈值 tick 调用）：清空全部条目。 */
export function clearDocCache(): number {
  const n = cache.size;
  cache.clear();
  totalChars = 0;
  return n;
}

/** 测试/诊断用。 */
export function docCacheStats(): { entries: number; totalChars: number } {
  return { entries: cache.size, totalChars };
}
