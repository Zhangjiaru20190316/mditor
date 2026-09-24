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
//   1. 加载后空闲预热（startCvPrewarm）：视口优先、先下后上、按时间预算
//      分批临时 content-visibility:visible 强制渲染 → 量高 → 记表 → 换下
//      一批；等 webfont 上屏后开量。冷启动首跳即准确，且预热全程不推视口。
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
import { scrollCount, scrollEmit, noteScrollWrite } from "./scrollDebug";

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

/**
 * R2 分片重建的区间替换：清掉 [fromPos,toPos) 内的旧装饰，重算并加回。
 * 区间外的装饰对象实例原样保留（区别于 buildDecos 的全量新集——那会让
 * prosemirror-view 对全部顶层块重做装饰对账，1MB 档 300-500ms 单长任务）。
 */
function updateSlice(
  decos: DecorationSet,
  doc: PMNode,
  fromPos: number,
  toPos: number
): DecorationSet {
  const fresh: Decoration[] = [];
  doc.forEach((node, offset) => {
    if (offset < fromPos || offset >= toPos) return;
    const size = cvSizeFor(hashNode(node));
    if (!size) return;
    fresh.push(
      Decoration.node(offset, offset + node.nodeSize, {
        style: intrinsicStyleOf(size.w, size.h),
      })
    );
  });
  // 本版本 prosemirror-view 的 DecorationSet 无 update()——用 find+remove+add
  // 组合实现区间替换（remove 按对象引用删，区间外实例原样保留）。
  // find 的命中是「相触即中」——切片边界上邻居块的装饰也会被扫进来；
  // 直接 remove 会把它删掉且本片不会补回（它不在片内）。按装饰起点严格
  // 过滤到 [fromPos, toPos)。
  const stale = decos
    .find(fromPos, toPos)
    .filter((d) => d.from >= fromPos && d.from < toPos);
  const next = stale.length ? decos.remove(stale) : decos;
  return fresh.length ? next.add(doc, fresh) : next;
}

/* -------------------------------------------------------------------------- */
/* 插件（decoration 承载 + 视口学习调度）                                       */
/* -------------------------------------------------------------------------- */

type CvMeta =
  | { type: "learned" }
  | { type: "rebuild-slice"; from: number; to: number }
  | { type: "rebuild-end" }
  | { type: "prewarm"; from: number; to: number }
  | { type: "prewarm-end" };

export const cvIntrinsicKey = new PluginKey<DecorationSet>("mditor-cv-intrinsic");

/** 学习节流：文档变化/触发后的最小量取间隔（ms）。 */
const LEARN_MIN_INTERVAL = 300;
/** 学习到新高度后，装饰重建 dispatch 的防抖（ms）。 */
const REBUILD_DEBOUNCE = 350;
/** docChanged 后「延迟整体重建」的防抖（ms）：apply 只做 O(变更) 的增量映射，
 *  停顿超过此窗口才补一次整树重建——修复 map 语义丢不掉的装饰（撤销重做/
 *  粘贴已知尺寸块经删除映射后不会复活）。打字连击期间永不触发；224KB 档
 *  重建 ~2ms、1MB 档 ~300-500ms，落在停键后的空闲段。 */
const REBUILD_AFTER_EDIT_DEBOUNCE = 1200;
/** 视口带学习余量（px）：视口上下各扩这么多仍算「已渲染」。 */
const LEARN_MARGIN = 600;

let learnTimer: number | null = null;
let rebuildTimer: number | null = null;
/** 自上次整树重建后文档是否被编辑过（apply 置位；重建 dispatch 后清除）。 */
let editSinceRebuild = false;
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

/** 整树重建的调度入口（R2：分片推进）。两种来源共用一个定时器：学习到
 *  新高度（REBUILD_DEBOUNCE）与编辑停顿（REBUILD_AFTER_EDIT_DEBOUNCE）。
 *  尾随语义：新调度重置挂起定时器——打字连击期间永不触发。到点后不再单笔
 *  dispatch 整树（1MB 档 buildDecos+视图对账是一次 300-500ms 长任务），而是
 *  按块区间分片：每片一次 idle 回调、8ms 预算、DecorationSet.update 局部
 *  替换（未触碰区间的装饰对象保持实例稳定，视图对账只看变更区间）。 */
function scheduleRebuild(view: EditorView, delay = REBUILD_DEBOUNCE): void {
  if (rebuildTimer != null) window.clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => {
    rebuildTimer = null;
    try {
      if (!view.dom.isConnected) return;
      startSlicedRebuild(view);
    } catch {
      /* never throw */
    }
  }, delay);
}

/** 分片重建的代际令牌：新的重建序列（或销毁）取代旧循环。 */
let rebuildGen = 0;
/** 分片重建单步的块数上限（自适应前的起始值；8ms 预算断片）。 */
const REBUILD_SLICE_BLOCKS = 400;

/** 分片整树重建：按块区间推进 rebuild-slice meta。文档被编辑（doc 引用
 *  变化）即中止——增量映射已保持可用，下一次停顿重来。 */
function startSlicedRebuild(view: EditorView): void {
  const gen = ++rebuildGen;
  const doc0 = view.state.doc;
  const total = doc0.childCount;
  // 顶层块位置表（分片期间的稳定索引）
  const posOf: number[] = new Array(total);
  {
    let pos = 0;
    for (let i = 0; i < total; i++) {
      posOf[i] = pos;
      pos += doc0.child(i).nodeSize;
    }
  }
  let i = 0;
  // 自适应片大小：dispatch（含视图对账）实测可超纯装饰构建耗时数倍，
  // 超预算即减半下片（同 prewarm nextChunkSize 思想），下限 25 块。
  let chunk = REBUILD_SLICE_BLOCKS;
  const step = (): void => {
    try {
      if (gen !== rebuildGen) return;
      if (!view.dom.isConnected) return;
      if (view.state.doc !== doc0) {
        rebuildGen++; // 文档被编辑：让位（增量映射足够，下次停顿重来）
        return;
      }
      const t0 = performance.now();
      let lastMs = 0;
      while (i < total) {
        const from = posOf[i];
        const toK = Math.min(total, i + chunk);
        const to = posOf[toK - 1] + doc0.child(toK - 1).nodeSize;
        view.dispatch(
          view.state.tr.setMeta(cvIntrinsicKey, { type: "rebuild-slice", from, to })
        );
        lastMs = performance.now() - t0;
        i = toK;
        if (lastMs > 8 && i < total) break;
      }
      if (lastMs > 8) chunk = Math.max(25, Math.ceil(chunk / 2));
      if (i < total) {
        scheduleRebuildIdle(step);
      } else {
        try {
          view.dispatch(view.state.tr.setMeta(cvIntrinsicKey, { type: "rebuild-end" }));
        } catch {
          /* never throw */
        }
      }
    } catch {
      /* 分片失败：已完成的片保持有效，剩余由下次停顿/学习重建补齐 */
    }
  };
  scheduleRebuildIdle(step);
}

const scheduleRebuildIdle = (fn: () => void): void => {
  try {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(fn, { timeout: 300 });
      return;
    }
  } catch {
    /* 环境异常退回定时器 */
  }
  window.setTimeout(fn, 16);
};

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
 *  渲染管线写入（绝不事后直写 PM DOM）。仅在 big 模式注册。
 *  工厂单独导出（createCvIntrinsicPlugin）供单测直接构造 EditorState。 */
export function createCvIntrinsicPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
  key: cvIntrinsicKey,
  state: {
    init: (_, state) => buildDecos(state.doc, null),
    apply(tr, decos, _oldState, newState) {
      const meta = tr.getMeta(cvIntrinsicKey) as CvMeta | undefined;
      if (meta) {
        if (meta.type === "prewarm") {
          return buildDecos(newState.doc, { fromPos: meta.from, toPos: meta.to });
        }
        if (meta.type === "rebuild-slice") {
          // R2 分片重建：只重算 [from,to) 块区间的装饰，其余实例原样保留
          // （DecorationSet.update 的 filter+add——视图对账只看变更区间，
          // 未触碰块的装饰对象恒等 ⇒ 零成本）。
          return updateSlice(decos, newState.doc, meta.from, meta.to);
        }
        if (meta.type === "rebuild-end") {
          editSinceRebuild = false;
          return decos;
        }
        editSinceRebuild = false;
        return buildDecos(newState.doc, null);
      }
      if (tr.docChanged) {
        // 大文档（1MB/1.16 万块）实测：整树重建 DecorationSet 会让
        // prosemirror-view 对每个键事务做全树装饰对账（takeSpansForNode/
        // forChild/valid 合计 ~500ms/键，占打字剖面 50%）。改为增量映射
        // （O(变更)）：被编辑块的旧尺寸装饰保留到停顿后的延迟整体重建
        // （view.update → scheduleRebuild）修正——旧值比 3em 缺省占位更
        // 接近真值，且撤销/粘贴丢失的装饰也由该重建复活。
        editSinceRebuild = true;
        return decos.map(tr.mapping, tr.doc);
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
          // 增量映射丢不掉的装饰（撤销/粘贴）在编辑停顿后补一次整树重建。
          if (editSinceRebuild) scheduleRebuild(v, REBUILD_AFTER_EDIT_DEBOUNCE);
        }
      },
      destroy() {
        if (learnTimer != null) window.clearTimeout(learnTimer);
        learnTimer = null;
        if (rebuildTimer != null) window.clearTimeout(rebuildTimer);
        rebuildTimer = null;
        rebuildGen++; // 在飞的分片重建序列随之作废
        editSinceRebuild = false;
      },
    };
  },
});
}

export const cvIntrinsicPlugin = $prose(() => createCvIntrinsicPlugin());


/* -------------------------------------------------------------------------- */
/* 加载后空闲预热：视口优先、先下后上、按时间预算分批（2026-08-23 P0 重构）      */
/* -------------------------------------------------------------------------- */

/** 单步量测时间预算（ms）：预算内尽力多量，超出即断批让出主线程——消灭固
 *  定 100 块/批造成的 300~1200ms longtask（大文档事件 MD-1003 ×2 实锤）。 */
export const PREWARM_MEASURE_BUDGET_MS = 8;
/** 批大小自适应：起始 / 上限 / 下限（块）。 */
export const PREWARM_START_CHUNK = 12;
export const PREWARM_MAX_CHUNK = 100;
export const PREWARM_MIN_CHUNK = 1;
/** 视口带余量（屏）：当前视口向下先量 N 屏（视口上方由「由近到远」的第
 *  三阶段天然覆盖，不需要单独的带）。 */
export const PREWARM_BAND_SCREENS = 2;
/** 预热前等 webfont 的上限（ms）：fallback 度量 → 字体上屏 → 二次批量高度
 *  变化的来源。 */
export const PREWARM_FONTS_WAIT_MAX_MS = 3000;

/** 预热推进顺序（纯函数，可单测）：视口带 [bandStart, bandEnd) → 带末向下
 *  到文末（视口下方块变现不推移视口内容）→ 视口上方由近到远回到文首。
 *  三段拼接恰好覆盖 [0, total)，无重无漏；带越界自动夹取，空带退化为纯
 *  自顶向下（旧行为）。 */
export function prewarmOrder(
  total: number,
  bandStart: number,
  bandEnd: number
): number[] {
  const bs = Math.max(0, Math.min(total, bandStart));
  const be = Math.max(bs, Math.min(total, bandEnd));
  const order: number[] = [];
  for (let i = bs; i < be; i++) order.push(i); // ① 视口带（恢复落点）
  for (let i = be; i < total; i++) order.push(i); // ② 向下到文末
  for (let i = bs - 1; i >= 0; i--) order.push(i); // ③ 向上到文首（由近到远）
  return order;
}

/** 批大小自适应（纯函数）：量测耗时 < 预算一半 → 翻倍提效；超预算 → 减半
 *  让出；其余保持。夹取 [PREWARM_MIN_CHUNK, PREWARM_MAX_CHUNK]。 */
export function nextChunkSize(
  cur: number,
  elapsedMs: number,
  budgetMs: number
): number {
  let n = cur;
  if (elapsedMs < budgetMs / 2) n = cur * 2;
  else if (elapsedMs > budgetMs) n = Math.ceil(cur / 2);
  return Math.max(PREWARM_MIN_CHUNK, Math.min(PREWARM_MAX_CHUNK, n));
}

/** 等 webfont 上屏（带上限）：resolve 值为实际等待 ms。已加载/无字体接口
 *  的环境同步返回，不拖慢小文档路径。 */
function waitForFonts(maxMs: number): Promise<number> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(performance.now() - t0);
    };
    try {
      const fonts = document.fonts;
      if (!fonts || fonts.status === "loaded") {
        finish();
        return;
      }
      void fonts.ready.then(finish, finish);
      window.setTimeout(finish, maxMs);
    } catch {
      finish();
    }
  });
}

/** 预热期视口上方块变现的预补偿限幅（同 scrollDebug ANCHOR_COMP_MAX 语义，
 *  各自持常量防单侧漂移）。 */
const PREWARM_COMP_MAX = 8000;

/** children 元素 → doc 顶层块索引（posOf 二分）；widget/内层元素返回 -1。 */
function topLevelIndexOf(
  view: EditorView,
  el: Element,
  posOf: number[]
): number {
  try {
    const pos = view.posAtDOM(el, 0);
    const $p = view.state.doc.resolve(pos);
    if ($p.depth < 1) return -1;
    const nodePos = $p.before(1);
    if (view.nodeDOM(nodePos) !== el) return -1;
    let lo = 0;
    let hi = posOf.length - 1;
    let r = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (posOf[mid] <= nodePos) {
        r = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return r;
  } catch {
    return -1;
  }
}

/** 当前视口所在的顶层块索引带 [start, end)：children 按文档序 rect 单调，
 *  二分定位视口顶块，向后走 PREWARM_BAND_SCREENS 屏。经 posAtDOM 精确映
 *  射回 doc 索引（Crepe 顶层 widget 会打破 children 与块的一一对齐）。
 *  任何失败 → [0,0)（退化为纯自顶向下）。只读，不写 DOM。 */
function findViewportBand(
  view: EditorView,
  posOf: number[]
): { start: number; end: number } {
  try {
    const dom = view.dom as HTMLElement;
    const kids = dom.children;
    const n = kids.length;
    if (n === 0 || posOf.length === 0) return { start: 0, end: 0 };
    const vh = dom.ownerDocument?.defaultView?.innerHeight ?? 800;
    const reach = PREWARM_BAND_SCREENS * vh;
    let lo = 0;
    let hi = n - 1;
    let first = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (kids[mid].getBoundingClientRect().bottom > 0) {
        first = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    if (first < 0) return { start: 0, end: 0 };
    let last = first;
    while (last < n - 1 && kids[last].getBoundingClientRect().top <= vh + reach) {
      last++;
    }
    // widget 错位防御：从边界向内最多跳 6 个元素找真正的顶层块
    const idxOfEl = (startIdx: number, dir: 1 | -1): number => {
      for (
        let c = startIdx, hops = 0;
        c >= 0 && c < n && hops < 6;
        c += dir, hops++
      ) {
        const i = topLevelIndexOf(view, kids[c], posOf);
        if (i >= 0) return i;
      }
      return -1;
    };
    const vs = idxOfEl(first, 1);
    if (vs < 0) return { start: 0, end: 0 };
    const veRaw = idxOfEl(last, 1);
    const start = Math.min(vs, posOf.length - 1);
    const end = Math.min(posOf.length, Math.max(start + 1, veRaw + 1));
    return { start, end };
  } catch {
    return { start: 0, end: 0 };
  }
}

/** 预热代际令牌：新一次预热（新文档/新实例）取代旧循环，旧循环静默退出。 */
let prewarmGen = 0;

const nextFrame = () =>
  new Promise<void>((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r()))
  );

/** 批间让出：空闲优先（不与输入/渲染抢主线程），200ms 超时兜底保推进。 */
const scheduleIdle = (fn: () => void): void => {
  try {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(fn, { timeout: 200 });
      return;
    }
  } catch {
    /* 环境异常退回定时器 */
  }
  window.setTimeout(fn, 16);
};

// ---- 预热让路（G6）：用户滚动进行中不交错派发批次 ---------------------------
// 剖面证据（tmp-profile-scroll，1MB 副本 cv 档滚动 10s）：两臂的主导负载都是
// 预热批次的 PM 装饰派发（DecorationSet forChild 8.9-9.2s + takeSpansForNode
// 7.3-7.7s / 60s 窗）与连带布局——预热在重 fixture 上 >45s 跑不完，整个滚动
// 期都在与用户交错。滚动源监听 wheel/touchmove/keydown（程序化 scrollTop
// 写入不触发，prewarm-comp 不会自锁）。
/** 用户滚动静止窗口（ms）：窗口内有 wheel/touch/键 → 预热批次让出。 */
const PREWARM_USER_YIELD_MS = 500;

let lastUserScrollAt = 0;
let userScrollHooked = false;

function hookUserScrollOnce(): void {
  if (userScrollHooked) return;
  userScrollHooked = true;
  const mark = (): void => {
    lastUserScrollAt = performance.now();
  };
  window.addEventListener("wheel", mark, { capture: true, passive: true });
  window.addEventListener("touchmove", mark, { capture: true, passive: true });
  window.addEventListener("keydown", mark, { capture: true, passive: true });
}

/** 预热让路判定（纯函数供单测）：用户滚动窗口内 → true（step 让出不派发）。 */
export function prewarmShouldYield(lastUserScrollAt: number, now: number): boolean {
  return now - lastUserScrollAt >= 0 && now - lastUserScrollAt < PREWARM_USER_YIELD_MS;
}

/**
 * 分块预热整篇文档的块高度（P0 重构：视口优先、先下后上、按时间预算）。
 *
 * 推进顺序：① 视口块起 +2 屏带（恢复落点/当前阅读区先量，冷启动首跳目
 * 的地立即可信）；② 带末向下推进到文末——视口下方块变现不推移视口内容；
 * ③ 视口上方由近到远收尾——每批 dispatch 前记录批内旧渲染高度、量后按
 * 差值同步补写滚动容器 scrollTop（prewarm-comp，限幅 8000px），视口画面
 * 静止；未覆盖的残差由 scrollDebug anchor-comp 兜底。时间预算：单步量测
 * 超 8ms 断批让出，批大小 1~100 自适应。开量前等 webfont（上限 3s）。
 * 文档被编辑 → 中止（视口学习自然覆盖）；实例销毁 → 中止；新预热启动 →
 * 旧循环让位。
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
    void runPrewarm(view, gen, dom, doc0, total, posOf);
  } catch {
    /* 预热是尽力而为：失败静默，视口学习兜底 */
  }
}

async function runPrewarm(
  view: EditorView,
  gen: number,
  dom: HTMLElement,
  doc0: PMNode,
  total: number,
  posOf: number[]
): Promise<void> {
  hookUserScrollOnce();
  // P0-3：等 webfont 上屏再量——fallback 度量会让高度表整批错误，字体上屏
  // 后再测是「二次批量高度变化」的直接来源。
  const fontWaitMs = await waitForFonts(PREWARM_FONTS_WAIT_MAX_MS);
  if (gen !== prewarmGen) return;
  if (!dom.isConnected) return;
  if (fontWaitMs >= 100) {
    scrollEmit(
      "prewarm.fonts",
      `预热等待 webfont ${Math.round(fontWaitMs)}ms 后开量（防 fallback 度量二次重排）`
    );
  }

  const band = findViewportBand(view, posOf);
  const order = prewarmOrder(total, band.start, band.end);
  // 三段在 order 里的分界（批不得跨界：down→up 跨界批会把 [带首, 文末]
  // 整段一次性 visible，等于把灾难性大批量重排又请回来）。
  const seg1 = Math.max(0, band.end - band.start);
  const seg2 = total - band.end;

  const abort = (reason: string): void => {
    try {
      if (view.dom.isConnected) {
        view.dispatch(
          view.state.tr.setMeta(cvIntrinsicKey, { type: "prewarm-end" })
        );
      }
      scrollEmit("prewarm.abort", `预热中止：${reason}`);
    } catch {
      /* 中止失败不追查：下一次预热自然覆盖 */
    }
  };

  let k = 0; // order 游标（只越过已量测的块；预算断批的剩余块下批重派）
  let chunk = PREWARM_START_CHUNK;
  const t0 = performance.now();
  let batches = 0;
  let learned = 0;
  let lastEmitAt = 0;

  const step = (): void => {
    try {
      if (gen !== prewarmGen) return;
      if (!view.dom.isConnected) {
        abort("实例销毁");
        return;
      }
      if (view.state.doc !== doc0) {
        abort("文档被编辑");
        return;
      }
      // G6 让路：用户滚动进行中不派发批次（装饰派发+量测与滚动交错是
      // 重 fixture 滚动期长任务的共同主导——见模块头剖面证据）。
      if (prewarmShouldYield(lastUserScrollAt, performance.now())) {
        scrollCount("prewarm.yield");
        scheduleIdle(step);
        return;
      }
      if (k >= order.length) {
        const ms = Math.round(performance.now() - t0);
        view.dispatch(
          view.state.tr.setMeta(cvIntrinsicKey, { type: "prewarm-end" })
        );
        scrollEmit(
          "prewarm.done",
          `预热完成：新学 ${learned} 块 / 覆盖 ${order.length}/${total}，${batches} 批，${ms}ms`,
          { data: { learned, blocks: order.length, total, batches, ms } }
        );
        scrollCount("prewarm.done");
        return;
      }
      const fromK = k;
      const segEnd =
        fromK < seg1 ? seg1 : fromK < seg1 + seg2 ? seg1 + seg2 : order.length;
      const toK = Math.min(segEnd, fromK + chunk);
      const upPhase = fromK >= seg1 + seg2;
      const iLo = Math.min(order[fromK], order[toK - 1]);
      const iHi = Math.max(order[fromK], order[toK - 1]);
      const from = posOf[iLo];
      const to = posOf[iHi] + doc0.child(iHi).nodeSize;

      // up 阶段：dispatch 前记录批内各块的当前渲染高度（布局缓存读取），
      // 量测后的差值之和即本批给视口内容带来的位移量。
      let oldH: number[] | null = null;
      if (upPhase) {
        oldH = new Array(toK - fromK).fill(-1);
        for (let j = fromK; j < toK; j++) {
          try {
            const el = view.nodeDOM(posOf[order[j]]) as HTMLElement | null;
            if (el && el.nodeType === 1) {
              oldH[j - fromK] = el.getBoundingClientRect().height;
            }
          } catch {
            /* 单块旧高读取失败 → 差值缺失，残差由 anchor-comp 兜底 */
          }
        }
      }

      view.dispatch(
        view.state.tr.setMeta(cvIntrinsicKey, { type: "prewarm", from, to })
      );
      void nextFrame().then(() => {
        try {
          if (gen !== prewarmGen) return;
          if (!view.dom.isConnected || view.state.doc !== doc0) {
            abort(view.dom.isConnected ? "文档被编辑" : "实例销毁");
            return;
          }
          const tM0 = performance.now();
          let lastDone = fromK - 1;
          let shiftPx = 0;
          for (let j = fromK; j < toK; j++) {
            lastDone = j; // 不可量测的块（widget/空宽）也算处理过，防游标卡死
            const el = view.nodeDOM(posOf[order[j]]) as HTMLElement | null;
            if (!el || el.nodeType !== 1) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            const node = doc0.child(order[j]);
            if (noteCvSize(hashNode(node), r.width, el.offsetHeight)) learned++;
            if (oldH != null && oldH[j - fromK] >= 0) {
              shiftPx += r.height - oldH[j - fromK];
            }
            if (
              performance.now() - tM0 > PREWARM_MEASURE_BUDGET_MS &&
              j + 1 < toK
            ) {
              break;
            }
          }
          k = lastDone + 1;
          const elapsed = performance.now() - tM0;
          chunk = nextChunkSize(chunk, elapsed, PREWARM_MEASURE_BUDGET_MS);
          batches++;
          scrollCount("prewarm.chunk");
          const now = performance.now();
          if (now - lastEmitAt >= 800) {
            lastEmitAt = now;
            scrollEmit(
              "prewarm.chunk",
              `预热推进 ${k}/${order.length} 块（批 ${batches}，本批 ${toK - fromK} 块 ${Math.round(elapsed)}ms，下批 ${chunk}）`,
              {
                data: {
                  cursor: k,
                  blocks: order.length,
                  batches,
                  chunk,
                  ms: Math.round(now - t0),
                },
              }
            );
          }
          // up 阶段预补偿：视口上方块变现把下方内容整体推移 shiftPx，在下一
          // 帧观察到「位移」之前同步补写 scrollTop，视口画面静止。恢复梯子
          // （smoothJump）在位期间跳过——由梯子自己的锚块精落地收口。
          if (oldH != null && Math.abs(shiftPx) >= 1) {
            try {
              const host = dom.closest<HTMLElement>(".mditor-editor-host");
              if (host && host.dataset.smoothJump === undefined) {
                const comp = Math.max(
                  -PREWARM_COMP_MAX,
                  Math.min(PREWARM_COMP_MAX, shiftPx)
                );
                noteScrollWrite("prewarm-comp");
                host.scrollTop += comp;
                scrollCount("prewarm.comp");
              }
            } catch {
              /* 补偿失败由 anchor-comp 兜底 */
            }
          }
          scheduleIdle(step);
        } catch {
          scheduleIdle(step);
        }
      });
    } catch {
      /* 单步失败：预热是尽力而为，视口学习兜底 */
    }
  };
  scheduleIdle(step);
}
