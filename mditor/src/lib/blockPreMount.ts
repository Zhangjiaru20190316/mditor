// R11 原型（E-a 块级主动预挂载，限速）——拍板项，默认关闭，未拍板不合入。
//
// 机制背景（r10-phase4-attribution.md S-a/S-g）：块公式（Crepe 把 math 改写
// 为 code_block(language:"LaTeX")）与代码块共用 @milkdown/components 的
// code-block nodeview：IO 进带（rootMargin 800px）才 initializeCodeMirror()
// （CodeMirror+Vue+KaTeX 同步重活）。cv 档 content-visibility:auto 跳过视口
// 外块布局 → IO 交叉计算对无几何目标不报进带 → 块进入浏览器预渲染窗（≈视口
// 外 0~400px）被布局后 IO 才派发 → 挂载完成落在视口内 = 首现闪刷（解题技巧
// down-slow 24/24 全可见，R10/R11 实测）。行内侧已由 R10 Fix-A 预测式扫描
// 修复（1/1/0）；本模块把同款"滚动输入驱动的预测式发现"扩展到块级。
//
// 设计（对齐 Fix-A 的边界纪律）：
//  * 发现：wheel/touch 输入驱动，rAF 帧内扫描滚动方向前方预测带（视口沿 +
//    bandPx + 最近步进余量）内仍是占位 pre 的 .milkdown-code-block，经
//    window.__codeBlockPreMount（补丁侧受控触发器）走与 IO 进带完全相同的
//    路径（cancelTeardown + initializeCodeMirror，initialized 幂等）。
//  * 限速（红线 17）：每帧最多 perFrame 块（默认 1），实测单块挂载耗时入
//    stats（§8 最坏帧预算证明）；绝不在 wheel/IO 回调里同步挂载。
//  * 上滚安全（R4-①/R6 Fix-B 语义）：视口上方首挂的高度变化会上移视口内容
//    且无 overflow-anchor 补偿——上滚侧只预挂"曾挂载过"的块（dataset.mnt
//    已标 + teardown 冻结高仍在），首挂块一律留给 IO 原路径。
//  * IO 兜底保留：预挂载只是提前，IO 回调照常（先到者幂等）——M3 块挂载率
//    100% 硬门不受影响。
//  * 开关：window.__blockPreMountCfg = { on: true, bandPx: 800, perFrame: 1 }；
//    默认关闭（未设置即零行为）。统计出口 window.__blockPreMountStats。
//
// 移除路径：删除 useMilkdown 的 import/安装两行 + 本文件 + 补丁侧
// __codeBlockPreMount 注册块。

/** 原型配置（window.__blockPreMountCfg；字段缺省回退默认）。 */
interface BlockPreMountCfg {
  on: boolean;
  /** 预测带宽（px，视口沿以外）。 */
  bandPx: number;
  /** 每帧最多预挂数（限速硬上限）。 */
  perFrame: number;
}

const DEFAULT_CFG: BlockPreMountCfg = { on: false, bandPx: 800, perFrame: 1 };

interface BlockPreMountStats {
  sweeps: number;
  /** 触发预挂（调用触发器且返回 true）次数。 */
  triggered: number;
  /** 预挂执行（真正从占位进入挂载）次数。 */
  mounted: number;
  /** 上滚侧被安全门跳过的候选数。 */
  skippedUp: number;
  mountMsTotal: number;
  mountMsMax: number;
  lastMountMs: number[];
}

const stats: BlockPreMountStats = {
  sweeps: 0,
  triggered: 0,
  mounted: 0,
  skippedUp: 0,
  mountMsTotal: 0,
  mountMsMax: 0,
  lastMountMs: [],
};

let enabled = false;
let hooked = false;
let rafScheduled = false;
/** 上一次 wheel/touch 步进幅度（近 5 次最大值，对齐 lazyInlineMath 语义）。 */
const recentSteps: number[] = [];
let stepMargin = 0;
let scrollDir: 0 | 1 | -1 = 0;

function readCfg(): BlockPreMountCfg {
  try {
    const c = (window as unknown as { __blockPreMountCfg?: Partial<BlockPreMountCfg> })
      .__blockPreMountCfg;
    if (!c) return DEFAULT_CFG;
    return {
      on: c.on === true,
      bandPx: typeof c.bandPx === "number" && c.bandPx > 0 ? c.bandPx : DEFAULT_CFG.bandPx,
      perFrame:
        typeof c.perFrame === "number" && c.perFrame >= 1 ? Math.floor(c.perFrame) : DEFAULT_CFG.perFrame,
    };
  } catch {
    return DEFAULT_CFG;
  }
}

/** 占位判定：未挂载 = 占位 pre 仍在（initializeCodeMirror 会移除它）。 */
function isPlaceholder(el: Element): boolean {
  return !!el.querySelector(":scope > pre.milkdown-code-block-placeholder");
}

function noteStep(px: number): void {
  if (px <= 0) return;
  recentSteps.push(px);
  if (recentSteps.length > 5) recentSteps.shift();
  stepMargin = Math.min(2400, Math.max(...recentSteps));
}

function hookOnce(): void {
  if (hooked) return;
  hooked = true;
  const mark = (dir: 0 | 1 | -1, step: number): void => {
    scrollDir = dir;
    if (step > 0) noteStep(step);
    scheduleSweep();
  };
  window.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      if (!enabled) return;
      mark(e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0, Math.abs(e.deltaY));
    },
    { capture: true, passive: true }
  );
  window.addEventListener(
    "touchmove",
    (e: TouchEvent) => {
      if (!enabled) return;
      const y = e.touches[0]?.clientY;
      if (y === undefined) return;
      if (lastTouchY !== null && y !== lastTouchY) {
        mark(lastTouchY > y ? 1 : -1, Math.abs(y - lastTouchY));
      }
      lastTouchY = y;
    },
    { capture: true, passive: true }
  );
  const resetAnchor = (): void => {
    lastTouchY = null;
  };
  window.addEventListener("touchend", resetAnchor, { capture: true, passive: true });
  window.addEventListener("touchcancel", resetAnchor, { capture: true, passive: true });
  try {
    (window as unknown as Record<string, unknown>).__blockPreMountStats = () => ({ ...stats });
  } catch {
    /* never throw */
  }
}
let lastTouchY: number | null = null;

function scheduleSweep(): void {
  if (rafScheduled) return;
  rafScheduled = true;
  window.requestAnimationFrame(() => {
    rafScheduled = false;
    sweep();
  });
}

function sweep(): void {
  if (!enabled) return;
  const cfg = readCfg();
  if (!cfg.on) return;
  const host = document.querySelector<HTMLElement>(".mditor-editor-host");
  if (!host || host.dataset.big === undefined) return;
  const trigger = (window as unknown as { __codeBlockPreMount?: (el: Element) => boolean })
    .__codeBlockPreMount;
  if (typeof trigger !== "function") return;
  stats.sweeps++;
  const hostRect = host.getBoundingClientRect();
  const up = scrollDir === -1;
  // 预测带：滚动方向前方（下滚=视口底以下；上滚=视口顶以上）。
  const near = up ? hostRect.top + 40 : hostRect.bottom - 40;
  const far = up ? hostRect.top - cfg.bandPx - stepMargin : hostRect.bottom + cfg.bandPx + stepMargin;
  const lo = Math.min(near, far);
  const hi = Math.max(near, far);
  let mounted = 0;
  for (const el of document.querySelectorAll(".milkdown-code-block")) {
    if (mounted >= cfg.perFrame) break;
    if (!isPlaceholder(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom <= lo || r.top >= hi) continue;
    if (r.top < hostRect.bottom && r.bottom > hostRect.top) {
      // 已在视口内：留给 IO 原路径（预挂目标是"移出可视区"，不是抢修）。
      continue;
    }
    if (up && (el as HTMLElement).dataset.mnt !== "1") {
      // 上滚侧首挂无高度预留（R4-①/R6 Fix-B 安全语义）——跳过。
      stats.skippedUp++;
      continue;
    }
    const t0 = performance.now();
    const ok = trigger(el);
    const dt = performance.now() - t0;
    stats.triggered++;
    if (ok) {
      stats.mounted++;
      stats.mountMsTotal += dt;
      if (dt > stats.mountMsMax) stats.mountMsMax = dt;
      stats.lastMountMs.push(Math.round(dt));
      if (stats.lastMountMs.length > 64) stats.lastMountMs.shift();
      mounted++;
    }
  }
  // 带内仍有候选且预算未尽 → 下一帧继续（限速链）。
  if (mounted >= cfg.perFrame) scheduleSweep();
}

/** useMilkdown 建实例/载入时按体量调用（对齐 setLazyMathBySize 位点）。 */
export function setBlockPreMountEnabled(v: boolean): void {
  enabled = v;
  if (v) hookOnce();
}

/** 仅供测试。 */
export function __resetBlockPreMountForTest(): void {
  enabled = false;
  rafScheduled = false;
  recentSteps.length = 0;
  stepMargin = 0;
  scrollDir = 0;
  stats.sweeps = 0;
  stats.triggered = 0;
  stats.mounted = 0;
  stats.skippedUp = 0;
  stats.mountMsTotal = 0;
  stats.mountMsMax = 0;
  stats.lastMountMs.length = 0;
}
