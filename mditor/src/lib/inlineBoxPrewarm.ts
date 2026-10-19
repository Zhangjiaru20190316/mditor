// R11 原型（P3：预热批渲染态测高——行内公式盒预留预热）——拍板项，默认
// 关闭，未拍板不合入。第三次呈报（R5 留档、R6/R8 呈报）。
//
// 机制（R8 报告 ⑤ 拍板材料 + 本轮 P 归因复核）：1MB 档 cv/公式双预热在用户
// 快滚下追不上（cov .49→.52 随滚缓涨），冷区行内条目首渲发生高度变化 →
// 全树 layout 连锁（layout:block/height ≈1:1 伴随，帧 p95 181~444ms），
// 且冷条目 jump 组因无盒预留降级入队（syncDefer）→ 视口内补绘 = E-b 可见
// 换装（124~134/全程）。盒表（inlineBoxes）的既有消费端已经全面：
//   * 占位端（lazyInlineMath paintPlaceholder）：有盒占位即复刻真身行内
//     盒 → 首渲零高度变化（本模块的主要收益路径）；
//   * 上滚安全直绘门（hasReservedBox，R6 Fix-B）与 jump 组同步直绘。
// 本模块只做一件事：空闲分批把 katexCache 已有渲染态 HTML 的行内公式源码
// 离屏测盒，提前填 inlineBoxes——把"demote 时才学盒"变成"滚到前已学盒"。
//
// 纪律（对齐 mathCachePrewarm）：
//  * 让路：mathPrewarmShouldYield（同一输入时间戳来源）窗口内不派发批次；
//  * 代际令牌顶替旧循环；view.isDestroyed / 非 cv 档退出；
//  * 只测已缓存源码（peekCached 命中）——不触发 KaTeX 冷算（那是
//    mathCachePrewarm 的职责，两模块各跑各的，盒子覆盖率随缓存覆盖渐进）；
//  * 离屏测量上下文：ProseMirror 内 position:absolute + visibility:hidden
//    的一次性 sizer（继承编辑器字体），逐条 innerHTML + 单次强制布局读
//    rect，批内时间预算 cfg.batchMs（默认 6ms）；
//  * 开关：window.__inlineBoxPrewarmCfg = { on: true, batchMs: 6 }；默认关
//    （未设置零行为）。统计出口 window.__inlineBoxPrewarmStats。
//
// 移除路径：删除 useMilkdown 的 import/调用 + 本文件。

import type { EditorView } from "@milkdown/prose/view";
import { peekCached } from "./katexCache";
import { inlineBoxFor, noteInlineBox, lazyInlineMathEnabled, msSinceUserInput } from "./lazyInlineMath";
import { mathPrewarmShouldYield } from "./mathCachePrewarm";

interface InlineBoxPrewarmCfg {
  on: boolean;
  /** 批内时间预算（ms）。 */
  batchMs: number;
}

const DEFAULT_CFG: InlineBoxPrewarmCfg = { on: false, batchMs: 6 };

const stats = {
  measured: 0,
  batches: 0,
  measureMsTotal: 0,
  measureMsMax: 0,
};

let prewarmGen = 0;

function readCfg(): InlineBoxPrewarmCfg {
  try {
    const c = (window as unknown as { __inlineBoxPrewarmCfg?: Partial<InlineBoxPrewarmCfg> })
      .__inlineBoxPrewarmCfg;
    if (!c) return DEFAULT_CFG;
    return {
      on: c.on === true,
      batchMs: typeof c.batchMs === "number" && c.batchMs > 0 ? c.batchMs : DEFAULT_CFG.batchMs,
    };
  } catch {
    return DEFAULT_CFG;
  }
}

const scheduleIdle = (fn: () => void): void => {
  try {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(fn, { timeout: 200 });
      return;
    }
  } catch {
    /* 环境异常退定时器 */
  }
  window.setTimeout(fn, 16);
};

/**
 * 空闲分批把已缓存的行内公式源码离屏测盒填 inlineBoxes（尽力而为）。
 * 与 startMathCachePrewarm 同点位调用；两循环独立（代际各自顶替）。
 */
export function startInlineBoxPrewarm(view: EditorView): void {
  const gen = ++prewarmGen;
  try {
    if (!lazyInlineMathEnabled()) return;
    if (view.isDestroyed) return;
    // 收集惰性化：cfg 在调用时刻可能尚未注入（探针臂在开档后才 set 开关），
    // 首个批次执行时再收集（todo===null 哨兵）。文档序去重；只留"已缓存且
    // 尚无盒"的。
    let todo: string[] | null = null;
    const collect = (): string[] => {
      const seen = new Set<string>();
      const list: string[] = [];
      view.state.doc.descendants((node) => {
        if (node.type.name !== "math_inline") return true;
        const src = node.attrs.value;
        if (typeof src !== "string" || seen.has(src)) return false;
        seen.add(src);
        if (inlineBoxFor(src) === undefined && peekCached(src, false) !== undefined) list.push(src);
        return false;
      });
      return list;
    };
    // 离屏 sizer：挂在 editor host（PM 内容外——不触碰 ProseMirror 的 DOM
    // 观察器）继承编辑器字体；absolute + hidden + contain 限制布局污染。
    // 单个复用，逐条 innerHTML + rect（一次强制布局）。
    let sizer: HTMLSpanElement | null = null;
    const ensureSizer = (): HTMLSpanElement | null => {
      if (sizer && sizer.isConnected) return sizer;
      const host = (view.dom.closest?.(".mditor-editor-host") as HTMLElement | null) ?? (view.dom.parentElement as HTMLElement | null);
      if (!host || !host.isConnected) return null;
      const el = document.createElement("span");
      el.className = "mditor-math-inline-ready";
      el.style.cssText =
        "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;contain:layout style;";
      host.appendChild(el);
      sizer = el;
      return el;
    };
    const dropSizer = (): void => {
      try {
        sizer?.remove();
      } catch {
        /* */
      }
      sizer = null;
    };
    let i = 0;
    const step = (): void => {
      if (gen !== prewarmGen) return dropSizer();
      if (view.isDestroyed) return dropSizer();
      if (!lazyInlineMathEnabled()) return dropSizer();
      if (readCfg().on !== true) return dropSizer();
      if (mathPrewarmShouldYield(msSinceUserInput())) {
        scheduleIdle(step);
        return;
      }
      if (todo === null) {
        todo = collect();
        if (!todo.length) return dropSizer();
      }
      const cfg = readCfg();
      const el = ensureSizer();
      if (!el) return;
      const t0 = performance.now();
      while (i < todo.length) {
        const src = todo[i++];
        try {
          const html = peekCached(src, false);
          if (html !== undefined) {
            el.innerHTML = html;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              noteInlineBox(src, r.width, r.height);
              stats.measured++;
            }
          }
        } catch {
          /* 单条失败跳过 */
        }
        const dt = performance.now() - t0;
        stats.measureMsTotal += dt;
        if (dt > stats.measureMsMax) stats.measureMsMax = dt;
        if (dt >= cfg.batchMs) break;
      }
      stats.batches++;
      if (i < todo.length) scheduleIdle(step);
      else dropSizer();
    };
    scheduleIdle(step);
  } catch {
    /* 尽力而为 */
  }
  try {
    (window as unknown as Record<string, unknown>).__inlineBoxPrewarmStats = () => ({ ...stats });
  } catch {
    /* never throw */
  }
}

/** 仅供测试：重置代际与统计。 */
export function __resetInlineBoxPrewarmForTest(): void {
  prewarmGen++;
  stats.measured = 0;
  stats.batches = 0;
  stats.measureMsTotal = 0;
  stats.measureMsMax = 0;
}
