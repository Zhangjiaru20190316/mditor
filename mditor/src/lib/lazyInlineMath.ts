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
// teardown 同款思想）。仅大文档启用（sizeIsBigDocRaw 阈值同 memory.ts，与
// 设置开关无关——默认档正是要救的场景）。
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
import { sizeIsBigDocRaw } from "./memory";

/** 视口观察余量：提前 800px 渲染（快速滚动不闪占位）。 */
const IO_MARGIN = "800px";
/** 离开视口后延迟降级回占位（ms）——快速来回滚动不做抖动式重建。 */
const DEMOTE_DELAY = 2500;

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

function createLazyInlineMathView(node: PMNode): LazyMathView {
  const dom = document.createElement("span");
  dom.dataset.type = "math_inline";
  dom.dataset.value = String(node.attrs.value ?? "");
  dom.className = "mditor-math-inline-lazy";

  let current = node.attrs.value as string;
  let rendered = false;
  let demoteTimer: number | null = null;

  const paintPlaceholder = () => {
    dom.classList.remove("mditor-math-inline-ready");
    dom.textContent = current;
  };

  const render = () => {
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
      render();
    } else if (rendered) {
      // 远离：延迟降级（快速滚动往返不抖动）
      if (demoteTimer != null) window.clearTimeout(demoteTimer);
      demoteTimer = window.setTimeout(() => {
        demoteTimer = null;
        demote();
      }, DEMOTE_DELAY);
    }
  });
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
      const r = dom.getBoundingClientRect();
      void r;
      window.requestAnimationFrame(() => render());
      return true;
    },
    selectNode() {
      render();
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

/** useMilkdown 在建实例/载入时按体量调用（阈值与 memory.ts 大文档判定一致，不经过设置开关）。 */
export function setLazyMathBySize(content: string | null | undefined): void {
  setLazyInlineMathEnabled(sizeIsBigDocRaw(content));
}
