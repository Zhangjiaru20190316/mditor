// 内容寻址的 content-visibility 高度记忆（大文档「页面自己动」根修）。
//
// 根因（2026-08-22 浏览器复现实锤，r2.phaseA/B 证据链）：big 模式对
// ProseMirror 顶层块启用 content-visibility:auto + contain-intrinsic-size:
// auto 3em（global.css）。Chromium 对离开视口相关区的块会驱逐 last
// remembered size —— 同一 DOM 元素在「3em 占位 ↔ 真实高度」间往返：
//   * 滚动经过：块身后塌缩 -64px（H2 112→48）、图片变现 +472px —— 用户所
//     见 ±N 成对震荡（92 次）的全部来源；PM 顶层块零替换（pm.childlist=0，
//     H1 无罪），stamp/图片属性循环都不是触发源；
//   * 大纲平滑跳转：沿路成批变现（单次 123 个 layout:height），文档总高
//     在飞行中涨 15k+ px，动画目的地按起跳时占位高度计算 → 落点差
//     14633px，落定后内容再位移 15389px。
//
// 根修：给每个顶层块装饰「按内容寻址的真实高度」——
//   contain-intrinsic-size: <w>px <h>px（inline style，由 PM decoration
//   承载，PM 自己写入 DOM，无 DOMObserver 战争）。占位 = 真实 → 变现/
//   塌缩的 delta ≈ 0，震荡消失、跳转目的地按真实高度计算。
// 高度来源（三层）：
//   1. 加载后空闲预热（startCvPrewarm）：分块临时 content-visibility:
//      visible 强制渲染 → 量高 → 记入表 → 换下一块。冷启动首跳即准确。
//      预热自顶向下推进，块在视口下方变现不影响视口位置。
//   2. 视口学习（plugin view）：文档变化/滚动后节流量取视口带内已渲染块
//      的真实高度（二分定位，O(log n + k)），持续修正。
//   3. 会话级内容寻址表（Map<hash,{w,h}>）：键 = FNV-1a(node 类型 + 文本)，
//      同内容任何位置同高度；跨编辑器重建存活（内存守护 recreate 后无需
//      重新预热）。
// 纪律：绝不直接写 PM 管辖 DOM（decoration 是 PM 官方通道）；全入口
// try/catch；预热分块让出主线程；表容量有上限。

import { Plugin, PluginKey } from "@milkdown/prose/state";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import type { EditorView } from "@milkdown/prose/view";
import type { Node as PMNode } from "@milkdown/prose/model";
import { $prose } from "@milkdown/utils";

/* -------------------------------------------------------------------------- */
/* 纯逻辑：内容寻址高度表（可单测）                                             */
/* -------------------------------------------------------------------------- */

export interface CvSize {
  w: number;
  h: number;
}

const store = new Map<string, CvSize>();
/** 会话级容量上限（超出按插入序淘汰最旧的一半，防长会话无界增长）。 */
export const CV_STORE_CAP = 20000;

/** FNV-1a 32 位哈希（node 类型 + 全文），内容寻址键。 */
export function cvHash(type: string, text: string): string {
  let h = 0x811c9dc5;
  const s = `${type}\u0000${text}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 记录一条高度。返回 true 表示新增或数值变化（调用方据此重建装饰）。 */
export function noteCvSize(hash: string, w: number, h: number): boolean {
  try {
    if (!hash || !(w > 0) || !(h >= 0)) return false;
    const prev = store.get(hash);
    if (prev && Math.abs(prev.w - w) < 2 && Math.abs(prev.h - h) < 2) return false;
    if (!prev && store.size >= CV_STORE_CAP) {
      // Map 保持插入序：淘汰最旧一半（重新 set 不刷新顺序，近似 LRU 够用）。
      const drop = store.size - (CV_STORE_CAP >> 1);
      let i = 0;
      for (const k of store.keys()) {
        if (i++ >= drop) break;
        store.delete(k);
      }
    }
    store.set(hash, { w, h });
    return true;
  } catch {
    return false;
  }
}

export function cvSizeFor(hash: string): CvSize | undefined {
  return store.get(hash);
}

export function cvStoreSize(): number {
  return store.size;
}

/** 清空（测试用）。 */
export function cvClearStore(): void {
  store.clear();
}

/** 装饰用的 inline style（双值：宽占位 + 高占位）。 */
export function intrinsicStyleOf(w: number, h: number): string {
  const ww = Math.max(1, Math.round(w));
  const hh = Math.max(0, Math.round(h));
  return `contain-intrinsic-size: ${ww}px ${hh}px`;
}

/* -------------------------------------------------------------------------- */
/* PM 节点哈希缓存（节点不可变 → WeakMap 免重复 O(block) 取文本）               */
/* -------------------------------------------------------------------------- */

const hashCache = new WeakMap<PMNode, string>();

function hashNode(node: PMNode): string {
  let h = hashCache.get(node);
  if (h === undefined) {
    h = cvHash(node.type.name, node.textContent);
    hashCache.set(node, h);
  }
  return h;
}

/* -------------------------------------------------------------------------- */
/* 装饰构建                                                                    */
/* -------------------------------------------------------------------------- */

interface PrewarmRange {
  fromPos: number;
  toPos: number;
}

/** 预热期间被强制渲染的块区间（预热驱动器维护；apply 重建时读取）。 */
let prewarmRange: PrewarmRange | null = null;

function buildDecos(doc: PMNode, range: PrewarmRange | null): DecorationSet {
  const decos: Decoration[] = [];
  doc.forEach((node, offset) => {
    const size = cvSizeFor(hashNode(node));
    const inRange =
      range != null && offset >= range.fromPos && offset < range.toPos;
    if (!size && !inRange) return;
    const intrinsic = size ? intrinsicStyleOf(size.w, size.h) : "";
    const style = inRange
      ? `${intrinsic}${intrinsic ? "; " : ""}content-visibility: visible`
      : intrinsic;
    decos.push(Decoration.node(offset, offset + node.nodeSize, { style }));
  });
  return DecorationSet.create(doc, decos);
}

/* -------------------------------------------------------------------------- */
/* 插件（decoration 承载 + 视口学习调度）                                       */
/* -------------------------------------------------------------------------- */

type CvMeta =
  | { type: "learned" }
  | { type: "prewarm"; from: number; to: number }
  | { type: "prewarm-end" };

export const cvIntrinsicKey = new PluginKey<DecorationSet>("mditor-cv-intrinsic");

/** 学习节流：文档变化/触发后的最小量取间隔（ms）。 */
const LEARN_MIN_INTERVAL = 300;
/** 学习到新高度后，装饰重建 dispatch 的防抖（ms）。 */
const REBUILD_DEBOUNCE = 350;
/** 视口带学习余量（px）：视口上下各扩这么多仍算「已渲染」。 */
const LEARN_MARGIN = 600;

let learnTimer: number | null = null;
let rebuildTimer: number | null = null;
let lastLearnAt = 0;

function scheduleLearn(view: EditorView, delay = 0): void {
  if (learnTimer != null) return;
  learnTimer = window.setTimeout(() => {
    learnTimer = null;
    try {
      if (!view.dom.isConnected) return;
      lastLearnAt = performance.now();
      if (learnVisibleSizes(view)) scheduleRebuild(view);
    } catch {
      /* 诊断/优化永不抛错 */
    }
  }, delay);
}

function scheduleRebuild(view: EditorView): void {
  if (rebuildTimer != null) return;
  rebuildTimer = window.setTimeout(() => {
    rebuildTimer = null;
    try {
      if (!view.dom.isConnected) return;
      view.dispatch(view.state.tr.setMeta(cvIntrinsicKey, { type: "learned" }));
    } catch {
      /* never throw */
    }
  }, REBUILD_DEBOUNCE);
}

/** 量取视口带内已渲染块的真实高度（二分定位 + 线性扫 O(log n + k)）。
 *  返回 true 表示学到了新高度。DOM 子元素与 doc 顶层块不能按索引对齐
 *  （Crepe 会在 .ProseMirror 顶层插 widget / nodeview 包裹，实测首子元素
 *  是 DIV.ProseMirror-widget —— 索引错位会把图片块量成邻居段落的 56px，
 *  v4.0.1 预热首版即栽在此），一律经 view.nodeDOM(pos) 精确取块本体。 */
function topLevelNodeOf(view: EditorView, el: Element): PMNode | null {
  try {
    const pos = view.posAtDOM(el, 0);
    const $p = view.state.doc.resolve(pos);
    if ($p.depth < 1) return null;
    const nodePos = $p.before(1);
    if (view.nodeDOM(nodePos) !== el) return null; // widget / 内层元素：非顶层块本体
    return $p.node(1);
  } catch {
    return null;
  }
}

function learnVisibleSizes(view: EditorView): boolean {
  const dom = view.dom as HTMLElement;
  const kids = dom.children;
  const n = kids.length;
  if (n === 0) return false;
  const vh = window.innerHeight;
  let lo = 0;
  let hi = n - 1;
  let i0 = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = kids[mid].getBoundingClientRect();
    if (r.bottom > -LEARN_MARGIN) {
      i0 = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (i0 < 0) return false;
  let learned = false;
  for (let i = i0; i < n; i++) {
    const el = kids[i] as HTMLElement;
    const r = el.getBoundingClientRect();
    if (r.top > vh + LEARN_MARGIN) break;
    if (r.width === 0) continue;
    const node = topLevelNodeOf(view, el);
    if (!node) continue;
    learned =
      noteCvSize(hashNode(node), r.width, el.offsetHeight) || learned;
  }
  return learned;
}

/** 大文档 c-v 高度记忆插件：decoration 承载 contain-intrinsic-size，随 PM
 *  渲染管线写入（绝不事后直写 PM DOM）。仅在 big 模式注册。 */
export const cvIntrinsicPlugin = $prose(
  () =>
    new Plugin<DecorationSet>({
  key: cvIntrinsicKey,
  state: {
    init: (_, state) => buildDecos(state.doc, null),
    apply(tr, decos, _oldState, newState) {
      const meta = tr.getMeta(cvIntrinsicKey) as CvMeta | undefined;
      if (meta) {
        if (meta.type === "prewarm") {
          return buildDecos(newState.doc, { fromPos: meta.from, toPos: meta.to });
        }
        return buildDecos(newState.doc, null);
      }
      if (tr.docChanged) {
        // WeakMap 缓存下整体重建 ≈ O(n) 次查表，亚毫秒级。
        return buildDecos(newState.doc, prewarmRange);
      }
      return decos;
    },
  },
  props: {
    decorations(state) {
      return cvIntrinsicKey.getState(state);
    },
  },
  view(view: EditorView) {
    scheduleLearn(view, LEARN_MIN_INTERVAL);
    return {
      update(v: EditorView, prev) {
        if (v.state.doc !== prev.doc) {
          scheduleLearn(v, Math.max(0, LEARN_MIN_INTERVAL - (performance.now() - lastLearnAt)));
        }
      },
      destroy() {
        if (learnTimer != null) window.clearTimeout(learnTimer);
        learnTimer = null;
        if (rebuildTimer != null) window.clearTimeout(rebuildTimer);
        rebuildTimer = null;
        prewarmRange = null;
      },
    };
  },
}));


/* -------------------------------------------------------------------------- */
/* 加载后空闲预热：分块强制渲染 → 量高 → 记表 → 收回                             */
/* -------------------------------------------------------------------------- */

/** 每块预热的顶层块数（一 chunk 一次渲染+一次测量，随后让出主线程）。 */
export const PREWARM_CHUNK = 100;

/** 预热代际令牌：新一次预热（新文档/新实例）取代旧循环，旧循环静默退出。 */
let prewarmGen = 0;

const nextFrame = () =>
  new Promise<void>((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r()))
  );

/**
 * 分块预热整篇文档的块高度。自顶向下推进；块在当前视口下方变现不影响视
 * 口位置（块高度只推移其后内容）。文档在预热中被编辑 → 中止（视口学习会
 * 自然覆盖）；编辑器被销毁 → 中止；新一次预热启动 → 旧循环让位。
 */
export function startCvPrewarm(view: EditorView): void {
  try {
    const gen = ++prewarmGen;
    const dom = view.dom as HTMLElement;
    if (!dom.isConnected || dom.offsetParent === null) return; // sv 隐藏态不量
    const doc0 = view.state.doc;
    const total = doc0.childCount;
    if (total === 0) return;
    // 顶层块的 doc 位置表（预热期间文档不变才有数；变了即中止）
    const posOf: number[] = new Array(total);
    {
      let pos = 0;
      for (let i = 0; i < total; i++) {
        posOf[i] = pos;
        pos += doc0.child(i).nodeSize;
      }
    }
    // 覆盖率快路径：会话内已量过（重复打开同一文档）→ 不再预热。
    {
      let known = 0;
      for (let i = 0; i < total; i++) {
        if (cvSizeFor(hashNode(doc0.child(i)))) known++;
      }
      if (known / total >= 0.95) return;
    }
    let idx = 0;
    const step = () => {
      try {
        if (gen !== prewarmGen) return;
        if (!view.dom.isConnected || view.state.doc !== doc0) {
          // 编辑/重建打断：收回强制渲染，结束预热
          prewarmRange = null;
          if (view.dom.isConnected) {
            view.dispatch(view.state.tr.setMeta(cvIntrinsicKey, { type: "prewarm-end" }));
          }
          return;
        }
        if (idx >= total) {
          prewarmRange = null;
          view.dispatch(view.state.tr.setMeta(cvIntrinsicKey, { type: "prewarm-end" }));
          return;
        }
        const fromIdx = idx;
        const toIdx = Math.min(total, idx + PREWARM_CHUNK);
        idx = toIdx;
        const from = posOf[fromIdx];
        const to = posOf[toIdx - 1] + doc0.child(toIdx - 1).nodeSize;
        prewarmRange = { fromPos: from, toPos: to };
        view.dispatch(
          view.state.tr.setMeta(cvIntrinsicKey, { type: "prewarm", from, to })
        );
        void nextFrame().then(() => {
          try {
            for (let i = fromIdx; i < toIdx; i++) {
              // nodeDOM 精确映射（索引对齐会被顶层 widget/nodeview 打破）
              const el = view.nodeDOM(posOf[i]) as HTMLElement | null;
              if (!el || el.nodeType !== 1) continue;
              const r = el.getBoundingClientRect();
              if (r.width === 0) continue;
              noteCvSize(hashNode(doc0.child(i)), r.width, el.offsetHeight);
            }
          } catch {
            /* 单块量取失败不阻断预热 */
          }
          window.setTimeout(step, 0);
        });
      } catch {
        prewarmRange = null;
      }
    };
    window.setTimeout(step, 0);
  } catch {
    /* 预热是尽力而为：失败静默，视口学习兜底 */
  }
}
