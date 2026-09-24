// R1 行内公式视口懒渲染（大文档打开墙的行内侧）。
//
// 背景：math_inline 的 toDOM 对每个节点同步跑 katex.render——1MB 压测副本
// 2.5 万个行内公式 ≈ 3.5~4s 纯 JS，且这些 DOM（每个公式数十节点）参与首屏
// 布局（默认档）与序列化外的所有遍历。content-visibility 只跳过布局，不跳过
// DOM 构建。块级公式已随 code-block 组件的 IntersectionObserver 懒挂载，行内
// 是唯一全量渲染的公式形态。
//
// 机制：nodeview 占位（span 内放公式源码文本）+ IntersectionObserver（余量
// 800px）临近渲染 KaTeX、远离延迟降级回占位（TEARDOWN_DELAY，与 code-block
// teardown 同款思想）。仅 cv 档大文档启用（isBigDocCv：体量 + bigDocViewport；
// 默认档急切渲染——无 content-visibility 时懒渲染的块高变化是全文档回流，
// scroll-abab 实测默认档滚动 p50 4.2→41.7ms，得不偿失）。
//
// 渲染泵（R1b，公式密集文档滚动回归修复）：IO 回调只入队，不同步渲染。
// 滚动进行中（SCROLL_QUIET_MS 内有滚动事件）保持占位——占位是纯文本，
// 无 KaTeX DOM 参与布局；静止后每帧按 PUMP_FRAME_BUDGET_MS 预算逐个补
// 渲染。初版在 IO 回调里同步渲染整批 entries，公式密集文档（1MB 副本
// katex≈1.6 万）快速滚动时一批数百个 katex.render + 连带布局，形成
// 300-700ms 长任务风暴：scroll-abab 实测滚动帧 p50 94-150ms，比关闭懒
// 渲染（A 臂）还差 41%（on 档）~23 倍（off 档）。选中（NodeSelection）
// 与编辑重渲染仍立即执行。
//
// 等价性（红线判定，R1 反向判据）：
//  * Ctrl+F 计数走 markdown 源串（SearchBar regex），与 DOM 无关——恒等价；
//    window.find 侧占位文本=公式源码，与 KaTeX MathML annotation 同样可命中。
//  * 跨视口选区/全选：占位 span 保留完整源码文本，selection/Ctrl+A 语义不变；
//    复制走 PM 文档序列化（不经 DOM）。
//  * 批注 marker 盖章与 math_inline 无交集。
//  * 选中公式（NodeSelection）立即渲染真身（selectNode），LatexInlineTooltip
//    的 shouldShow 读 selection.node——与渲染状态无关。
//  * KaTeX 单实例：import 的是被 overrides 钉住的同一 katex 0.18.4。

import { Plugin, PluginKey } from "@milkdown/prose/state";
import type { NodeView, EditorView } from "@milkdown/prose/view";
import type { Node as PMNode } from "@milkdown/prose/model";
import katex from "katex";
import { $prose } from "@milkdown/utils";
import { getMathRenderConfig } from "./mathConfig";
import { isBigDocCv } from "./memory";

/** 视口观察余量：提前 800px 渲染（慢速滚动不闪占位）。 */
const IO_MARGIN = "800px";
/** 离开视口后延迟降级回占位（ms）——快速来回滚动不做抖动式重建。 */
const DEMOTE_DELAY = 2500;
/** 滚动静止判定窗口（ms）：窗口内出现过滚动事件则渲染/降级均暂缓。
 *  取 400ms：基准滚轮节奏 ~190ms/格仍在滚动中；慢速阅读式滚动（>400ms/格）
 *  不受影响，公式照常提前渲染。 */
const SCROLL_QUIET_MS = 400;
/** 渲染泵单帧预算（ms）：静止后每帧最多花这么多时间补渲染。 */
const PUMP_FRAME_BUDGET_MS = 10;

/** 大文档才启用（模块级开关由 useMilkdown 在载入/建实例时按体量维护）。 */
let lazyEnabled = false;

export function setLazyInlineMathEnabled(v: boolean): void {
  lazyEnabled = v;
}

export function lazyInlineMathEnabled(): boolean {
  return lazyEnabled;
}

interface LazyMathView extends NodeView {
  dom: HTMLElement;
}

/** 视口观察器共享（math_inline 数量级=万，独立 IO 句柄太重）。 */
const callbacks = new WeakMap<Element, (visible: boolean) => void>();
let sharedIO: IntersectionObserver | null = null;

function getIO(): IntersectionObserver {
  if (!sharedIO) {
    sharedIO = new IntersectionObserver(
      (entries) => {
        for (const e of entries) callbacks.get(e.target)?.(e.isIntersecting);
      },
      { rootMargin: `${IO_MARGIN} 0px ${IO_MARGIN} 0px` }
    );
  }
  return sharedIO;
}

// ---- 渲染泵：IO 只入队；滚动静止后按帧预算补渲染 ---------------------------
type PendingRender = { run: () => void };

const pendingRenders: PendingRender[] = [];
let pumpScheduled = false;
let lastScrollAt = -Infinity;
let scrollHooked = false;

/** 仅供测试：重置渲染泵共享态（队列/滚动时间戳/帧调度位）。 */
export function __resetRenderPumpForTest(): void {
  pendingRenders.length = 0;
  pumpScheduled = false;
  lastScrollAt = -Infinity;
}

/** 捕获阶段监听一切滚动（滚动容器是编辑器 host，scroll 不冒泡但可捕获）。 */
function hookScrollOnce(): void {
  if (scrollHooked) return;
  scrollHooked = true;
  document.addEventListener(
    "scroll",
    () => {
      lastScrollAt = performance.now();
    },
    { capture: true, passive: true }
  );
}

function schedulePump(): void {
  if (pumpScheduled) return;
  pumpScheduled = true;
  window.requestAnimationFrame(() => {
    pumpScheduled = false;
    if (!pendingRenders.length) return;
    if (performance.now() - lastScrollAt < SCROLL_QUIET_MS) {
      schedulePump(); // 滚动中：占位即终态，等静止窗口
      return;
    }
    const t0 = performance.now();
    while (pendingRenders.length && performance.now() - t0 < PUMP_FRAME_BUDGET_MS) {
      pendingRenders.shift()!.run();
    }
    if (pendingRenders.length) schedulePump();
  });
}

function enqueueRender(entry: PendingRender): void {
  pendingRenders.push(entry);
  schedulePump();
}

function createLazyInlineMathView(node: PMNode): LazyMathView {
  const dom = document.createElement("span");
  dom.dataset.type = "math_inline";
  dom.dataset.value = String(node.attrs.value ?? "");
  dom.className = "mditor-math-inline-lazy";

  let current = node.attrs.value as string;
  let rendered = false;
  let queued = false;
  let demoteTimer: number | null = null;

  const paintPlaceholder = () => {
    dom.classList.remove("mditor-math-inline-ready");
    dom.textContent = current;
  };

  const render = () => {
    queued = false;
    if (rendered) return;
    rendered = true;
    if (demoteTimer != null) {
      window.clearTimeout(demoteTimer);
      demoteTimer = null;
    }
    dom.textContent = "";
    try {
      katex.render(current, dom, {
        ...(getMathRenderConfig().macros ? { macros: getMathRenderConfig().macros } : {}),
        throwOnError: false,
      });
    } catch {
      /* 渲染失败退回源码占位（与 toDOM throwOnError 同语义） */
      paintPlaceholder();
      rendered = false;
    }
    dom.classList.add("mditor-math-inline-ready");
  };

  const demote = () => {
    if (!rendered) return;
    rendered = false;
    paintPlaceholder();
  };

  callbacks.set(dom, (visible) => {
    if (visible) {
      if (rendered || queued) return;
      queued = true;
      enqueueRender({
        run: () => {
          queued = false;
          if (!dom.isConnected) return; // 已销毁：静默丢弃
          render();
        },
      });
    } else if (rendered) {
      // 远离：延迟降级（快速滚动往返不抖动）。降级改变块高会触发回流
      // （无 cv 档是全文档级），滚动进行中不执行，静止后再降。
      if (demoteTimer != null) window.clearTimeout(demoteTimer);
      demoteTimer = window.setTimeout(() => {
        demoteTimer = null;
        if (performance.now() - lastScrollAt < SCROLL_QUIET_MS) {
          demoteTimer = window.setTimeout(() => {
            demoteTimer = null;
            demote();
          }, DEMOTE_DELAY);
          return;
        }
        demote();
      }, DEMOTE_DELAY);
    }
  });
  hookScrollOnce();
  getIO().observe(dom);

  // 挂载时即不可见（视口外）→ 占位即可，IO 回调稍后接管。
  paintPlaceholder();

  return {
    dom,
    update(n) {
      if (n.type.name !== "math_inline") return false;
      const next = String(n.attrs.value ?? "");
      if (next === current) return true;
      current = next;
      dom.dataset.value = next;
      rendered = false;
      paintPlaceholder();
      // 值变化后若在视口内，下一帧重渲染（IO 不会重复回调同状态）。
      // 编辑路径单公式，直接 rAF 渲染（不过滚动静止门）。
      const r = dom.getBoundingClientRect();
      void r;
      window.requestAnimationFrame(() => render());
      return true;
    },
    selectNode() {
      render(); // 交互选中：立即渲染真身（同步，绕过泵）
      dom.classList.add("PROSE-selected");
    },
    deselectNode() {
      dom.classList.remove("PROSE-selected");
    },
    ignoreMutation() {
      return true;
    },
    destroy() {
      if (demoteTimer != null) window.clearTimeout(demoteTimer);
      sharedIO?.unobserve(dom);
      callbacks.delete(dom);
      // 队列中的残留条目由 run() 的 isConnected 检查静默丢弃
    },
  };
}

export const lazyInlineMathKey = new PluginKey("mditor-lazy-inline-math");

/** nodeViews 工厂（仅 lazyEnabled 时懒化，否则返回 undefined 走 toDOM）。 */
function nodeViewsFor() {
  return {
    math_inline: (node: PMNode, view: EditorView, getPos: () => number | undefined) => {
      void view;
      void getPos;
      if (!lazyEnabled) return undefined;
      try {
        return createLazyInlineMathView(node);
      } catch {
        return undefined; // 任何失败回退 toDOM（crepe 原渲染）
      }
    },
  };
}

/** 工厂导出（$prose 包装，useMilkdown 无条件注册；开关由体量决定）。 */
export function lazyInlineMathPlugin(): Plugin {
  return new Plugin({
    key: lazyInlineMathKey,
    props: {
      nodeViews: nodeViewsFor() as never,
    },
  });
}

export const lazyInlineMath = $prose(() => lazyInlineMathPlugin());

/** useMilkdown 在建实例/载入时按体量+视口档调用。
 *
 * v2 门控（G6 回归修复）：仅 cv 档（content-visibility）懒渲染。默认档无
 * content-visibility，每次懒渲染的块高变化都是全文档级回流——scroll-abab
 * 1MB 副本实测默认档滚动 p50 4.2→41.7ms；默认档恢复急切渲染后打开 12.4s
 * 仍在 G1 ≤18s 门内。减配档（bigDocMode）本就关闭 Latex 特性，无
 * math_inline，门控值对其无实际影响。 */
export function setLazyMathBySize(content: string | null | undefined): void {
  setLazyInlineMathEnabled(isBigDocCv(content));
}
