// KaTeX 渲染结果 LRU 缓存（行内公式渲染泵的直绘层）。
//
// 动机：lazyInlineMath 的离屏降级（demote 回源码占位）意味着回滚视口必须
// 重跑 KaTeX——LaTeX 密集文档滚动时表现为「先源码占位、静止后批量渲染」
// 的闪烁。KaTeX 0.18.4 的 renderToString 输出确定性（同输入同输出，HTML
// 无随机 id/时间戳），字符串跨元素复用安全——静态管线 rehype-katex 本就
// 整篇 innerHTML。缓存后：降级过的公式回滚时命中直绘（Map 查找 + 一次
// innerHTML，<0.1ms），渲染泵滚动中也能对视口内命中条目免预算直绘。
//
// 键 = mathConfigSignature（宏/autoNumber 变化即失效）+ displayMode +
// LaTeX 源码，\u0000 分隔（签名由 0/1、宏名宏体拼接，与源码均不含 NUL，
// 分隔符无歧义——与 renderMarkdown 的 SIG_SEP 同款约定）。
// 双上限 LRU（写法对齐 renderMarkdown.ts 的 HTML_CACHE）：8192 条 + 8MiB
// 字节（键 + 值长度，UTF-16 码元估算），超限从最旧（Map 头部）逐条淘汰；
// 单条超字节上限的巨型公式照常返回，只是立即自我淘汰。
//
// macros 复制后传入 KaTeX：KaTeX 会向 macros 种子对象回写运行期 \def，
// 直接传共享配置对象会污染 getMathRenderConfig().macros 并让签名漂移
// （exportMath.ts 同款防御）。katex 导入的是被 overrides 钉住的全局单
// 实例（0.18.4），与 lazyInlineMath / rehype-katex 同源。

import katex from "katex";
import { getMathRenderConfig, mathConfigSignature } from "./mathConfig";

/** 条数上限：万级行内公式文档的一个视口带通常只涉及数百条，8192 覆盖整篇热点。 */
export const KATEX_CACHE_MAX_ENTRIES = 8192;
/** 字节上限（UTF-16 码元估算）：与 renderMarkdown HTML_CACHE 的第二道上限一致。 */
export const KATEX_CACHE_MAX_BYTES = 8 * 1024 * 1024;

/** 键内分隔符：签名与 LaTeX 源码都不含 NUL，无歧义。 */
const SIG_SEP = "\u0000";

const cache = new Map<string, string>();
let cacheBytes = 0;
// 生产路径恒为默认上限；仅测试钩子可临时覆盖（见下方 test hooks）。
let entryCap = KATEX_CACHE_MAX_ENTRIES;
let byteCap = KATEX_CACHE_MAX_BYTES;

function cacheKey(src: string, displayMode: boolean): string {
  return `${mathConfigSignature()}${SIG_SEP}${displayMode ? "D" : "I"}${SIG_SEP}${src}`;
}

/** 探测缓存（不渲染、不新建条目）：命中返回 KaTeX HTML 字符串并提升为
 *  最近使用，未命中返回 undefined。 */
export function peekCached(src: string, displayMode: boolean): string | undefined {
  const key = cacheKey(src, displayMode);
  const v = cache.get(key);
  if (v !== undefined) {
    // 提升为最近使用（重插到尾部）；字节总数不变。
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}

/** 显式写入缓存（renderToStringCached 内部使用；供已持有 HTML 字符串的
 *  管线复用，避免为写缓存再渲染一次）。 */
export function putCached(src: string, displayMode: boolean, html: string): void {
  const key = cacheKey(src, displayMode);
  const prev = cache.get(key);
  if (prev !== undefined) {
    cacheBytes -= key.length + prev.length;
    cache.delete(key);
  }
  cache.set(key, html);
  cacheBytes += key.length + html.length;
  // 超过条数或字节上限时，从最旧（Map 头部）逐条淘汰直到回到限内。
  while (cache.size > entryCap || cacheBytes > byteCap) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const v = cache.get(oldest);
    cache.delete(oldest);
    if (v !== undefined) cacheBytes -= oldest.length + v.length;
  }
}

/** 渲染（带缓存）：命中直返；未命中 katex.renderToString（throwOnError:
 *  false + 宏配置 + displayMode）后写缓存再返回。KaTeX 异常向上抛（调用
 *  方自行回退占位），失败结果不落缓存。 */
export function renderToStringCached(src: string, displayMode: boolean): string {
  const hit = peekCached(src, displayMode);
  if (hit !== undefined) return hit;
  const { macros } = getMathRenderConfig();
  const html = katex.renderToString(src, {
    ...(macros ? { macros: { ...macros } } : {}),
    displayMode,
    throwOnError: false,
  });
  putCached(src, displayMode, html);
  return html;
}

/** 条数上限的剩余容量（只读；供预热等外部决定还要算多少条——唯一公式数
 *  超过余量时全跑只会把最早算入的条目挤出 LRU。测试钩子临时覆盖的上限
 *  同样生效；字节上限不在此界，由 LRU 自身淘汰兜底）。 */
export function katexCacheRemainingEntries(): number {
  return entryCap - cache.size;
}

// ---- test hooks：仅供 katexCache.test.ts 验证淘汰逻辑 ----------------------
// 生产代码不得调用；两个钩子都会清空缓存，保证字节计数与条目一致。

/** 临时覆盖双上限并清空缓存；返回恢复默认（并再次清空）的函数。 */
export function __setKatexCacheCapsForTests(entries: number, bytes: number): () => void {
  entryCap = entries;
  byteCap = bytes;
  cache.clear();
  cacheBytes = 0;
  return () => {
    entryCap = KATEX_CACHE_MAX_ENTRIES;
    byteCap = KATEX_CACHE_MAX_BYTES;
    cache.clear();
    cacheBytes = 0;
  };
}

/** 读取缓存状态：条数、总字节（键+值长度估算）、按插入序的键列表。 */
export function __getKatexCacheStatsForTests(): {
  size: number;
  bytes: number;
  keys: string[];
} {
  return { size: cache.size, bytes: cacheBytes, keys: [...cache.keys()] };
}
