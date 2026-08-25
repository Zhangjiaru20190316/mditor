// 大文档恢复落点的「锚块」精确定位（P1-4，2026-08-23 大文档事件追修）。
//
// 旧恢复路径（tab-restore / rebuild-restore）直接把上次会话的 scrollTop
// 写进滚动容器——但 big 模式重建后视口上方全是 3em 占位块（48px/块），
// 同一 scrollTop 指向的内容与捕获时相差可达数千 px；250ms×N 重试梯子只
// 能等「文档够高」，修不了「内容错位」。
//
// 根修：按「块身份」恢复。捕获时记录视口顶所在顶层块的文本指纹 + children
// 索引 + 顶边偏移；恢复时先写近似 scrollTop 落到大致区域，再按指纹找回锚
// 块（索引先验，±32 邻域由近及远扫描），把锚块顶边精确拉回捕获时的视口
// 偏移——与上方占位高度完全解耦，一次落位。此后上方块逐批变现的残余位移
// 由 cvMemory prewarm-comp / scrollDebug anchor-comp 兜底。
//
// 纪律：只读 PM DOM（getBoundingClientRect / textContent）；写操作仅限滚
// 动容器 scrollTop（照常 noteScrollWrite 打点）；全入口 try/catch。

import { noteScrollWrite } from "./scrollDebug";

/** 视口锚点（随 per-tab 滚动记忆存取，会话级）。 */
export interface ViewportAnchor {
  /** 锚块规范化文本指纹（前 64 字符，空白折叠）。 */
  text: string;
  /** 锚块在 .ProseMirror 顶层 children 中的索引（恢复先验，失配邻域扫描）。 */
  index: number;
  /** 捕获时锚块顶边相对滚动容器视口顶的偏移（px）。 */
  offset: number;
}

/** 指纹长度上限（块首 64 字符足够区分，控制邻域扫描的 textContent 成本）。 */
const FINGERPRINT_LEN = 64;

/** 规范化块文本指纹（capture 与 match 共用同一实现，保证可匹配）。 */
function anchorFingerprint(el: Element): string | null {
  try {
    const t = (el.textContent ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, FINGERPRINT_LEN);
    return t || null;
  } catch {
    return null;
  }
}

/**
 * 纯函数：按指纹定位锚块索引。先验记录索引，随后 ±window 邻域由近及远扫
 * 描（恢复前上方有过编辑会平移 children 索引）；找不回 → -1（调用方退回
 * 纯 scrollTop 恢复梯子）。
 */
export function matchAnchorIndex(
  getText: (i: number) => string | null,
  anchor: { text: string; index: number },
  window = 32
): number {
  if (!anchor.text) return -1;
  if (getText(anchor.index) === anchor.text) return anchor.index;
  for (let d = 1; d <= window; d++) {
    const hi = anchor.index + d;
    if (getText(hi) === anchor.text) return hi;
    const lo = anchor.index - d;
    if (getText(lo) === anchor.text) return lo;
  }
  return -1;
}

/** 捕获当前视口顶所在的锚块（.ProseMirror 顶层 children 二分定位，只读）。 */
export function captureViewportAnchor(
  host: HTMLElement | null
): ViewportAnchor | null {
  try {
    if (!host) return null;
    const pm = host.querySelector(".ProseMirror");
    if (!pm) return null;
    const kids = pm.children;
    const n = kids.length;
    if (n === 0) return null;
    let lo = 0;
    let hi = n - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (kids[mid].getBoundingClientRect().bottom > 0) {
        found = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    if (found < 0) return null;
    const el = kids[found];
    const text = anchorFingerprint(el);
    if (!text) return null;
    return {
      text,
      index: found,
      offset: Math.round(
        el.getBoundingClientRect().top - host.getBoundingClientRect().top
      ),
    };
  } catch {
    return null;
  }
}

/** 把锚块顶边拉回捕获时的视口偏移（精确落位）。失败返回 false，调用方走
 *  旧的 scrollTop 重试梯子。 */
export function scrollToViewportAnchor(
  host: HTMLElement,
  anchor: ViewportAnchor,
  writeTag: string
): boolean {
  try {
    const pm = host.querySelector(".ProseMirror");
    if (!pm) return false;
    const kids = pm.children;
    const idx = matchAnchorIndex((i) => {
      const el = i >= 0 && i < kids.length ? kids[i] : null;
      return el ? anchorFingerprint(el) : null;
    }, anchor);
    if (idx < 0) return false;
    const el = kids[idx];
    const target =
      host.scrollTop +
      (el.getBoundingClientRect().top - host.getBoundingClientRect().top) -
      anchor.offset;
    noteScrollWrite(writeTag);
    host.scrollTop = target;
    return true;
  } catch {
    return false;
  }
}
