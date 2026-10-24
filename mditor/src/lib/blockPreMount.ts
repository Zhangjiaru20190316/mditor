// R11 E-a 块级主动预挂载（限速）——2026-10-20 拍板默认开启：用户实测
// 5.0.4-beta 反馈"公式块闪烁优化没效果"，归因为原型彼时默认关（安装包零
// 行为），拍板指令"继续优化"即开启；参数维持阶段五实测值（bandPx 800 /
// perFrame 1）。
//
// R12（2026-10-24）上滚冷块首挂放开：R11 收口时"上滚首挂不放开"使冷块
// （从未挂载，dataset.mnt 未标）上滚只能走 IO 原路径——cv 档布局延迟派发
// 使挂载完成落在视口内：换装闪刷 + 占位→真实高度突变（实测 +63~78px/块）
// 推挤视口内容，anchor-comp 两帧确认补偿迟到（位移帧与补偿帧错开 = 抽
// 搐）。实测对照（perf/results/r12-upscroll-*.json，解题技巧档 6000px 慢
// 滚）：up 臂 skippedUp=28、首挂入视口 3/3 全换装可见、anchor-comp 24 次；
// down 臂全预挂视口外、零可见零真实跳位。修复 = 上滚首挂同样预挂，但
// **同步高度差补偿**：挂载后把 scrollTop 补上新旧高度差（premount-comp），
// 视口内容视觉零位移。两段实现（补丁侧 updateLanguage 的语言加载是
// Promise——KaTeX 预览高度在 trigger 返回后才定型）：
//  ① 微任务段：trigger 后 queueMicrotask 里读最终高度并补偿——语言包
//     缓存命中（常态）时 reconfigure 在微任务完成，补偿与高度变化都在
//     paint 前提交，浏览器只 paint 最终态，零帧可见窗口（对齐 cvMemory
//     prewarm-comp R7 Fix-B v3 的同步化纪律）。
//  ② recheck 段：语言包首次加载（动态 import，网络延迟）时微任务段拿
//     的是中间态高度——挂载后连续 N 帧重校验，残余差再补（1 帧可见窗
//     口，仍远快于 anchor-comp 的两帧确认+错开）。
// 防护：块顶文档坐标校验（挂载不动上方内容）+ 补偿上限（PREMOUNT_COMP_
// MAX）+ 滚动边界放弃，异常形态留给 anchor-comp 兜底。
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
//  * 上滚安全（R4-①/R6 Fix-B 语义的 R12 演进）：上滚侧曾挂载块（dataset.mnt
//    已标，teardown 冻结高在）重挂零高度变化，直接预挂；**冷块首挂带同步
//    高度差补偿**（见 R12 段）——补偿后视口内容视觉零位移，安全语义等价
//    于"高度预留"。
//  * IO 兜底保留：预挂载只是提前，IO 回调照常（先到者幂等）——M3 块挂载率
//    100% 硬门不受影响。
//  * 开关：默认开启（cv 档 + setBlockPreMountEnabled 才挂钩）；测量基线臂用
//    window.__blockPreMountCfg = { on: false } 显式关闭（ABAB 语义保留）。
//    统计出口 window.__blockPreMountStats。
//
// 移除路径：删除 useMilkdown 的 import/安装两行 + 本文件 + 补丁侧
// __codeBlockPreMount 注册块。

import { noteScrollWrite, scrollCount } from "./scrollDebug";

/** 原型配置（window.__blockPreMountCfg；字段缺省回退默认）。 */
interface BlockPreMountCfg {
  on: boolean;
  /** 预测带宽（px，视口沿以外）。 */
  bandPx: number;
  /** 每帧最多预挂数（限速硬上限）。 */
  perFrame: number;
}

const DEFAULT_CFG: BlockPreMountCfg = { on: true, bandPx: 800, perFrame: 1 };

interface BlockPreMountStats {
  sweeps: number;
  /** 触发预挂（调用触发器且返回 true）次数。 */
  triggered: number;
  /** 预挂执行（真正从占位进入挂载）次数。 */
  mounted: number;
  /** 上滚侧被安全门跳过的候选数（R11 语义；R12 放开冷块首挂后恒 0，字段
   *  保留供历史基线/探针（__blockPreMountStats）对照兼容）。 */
  skippedUp: number;
  /** 上滚冷块首挂的同步高度差补偿次数（premount-comp 写入）。 */
  compCount: number;
  /** 补偿放弃：块顶文档坐标漂移（挂载不应动上方内容，异常形态不补）。 */
  compSkippedDrift: number;
  /** 补偿放弃：滚动边界（补偿后越界，残余留给 anchor-comp 兜底）。 */
  compSkippedClamp: number;
  mountMsTotal: number;
  mountMsMax: number;
  lastMountMs: number[];
}

const stats: BlockPreMountStats = {
  sweeps: 0,
  triggered: 0,
  mounted: 0,
  skippedUp: 0,
  compCount: 0,
  compSkippedDrift: 0,
  compSkippedClamp: 0,
  mountMsTotal: 0,
  mountMsMax: 0,
  lastMountMs: [],
};

/** 单块首挂补偿限幅：正常块级公式高度差实测 ≤~100px，超限只可能是几何
 *  异常（c-v 重估/重建毛刺），照搬会放大成视口大跳——放弃并留给 anchor-comp。 */
const PREMOUNT_COMP_MAX = 400;

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
  // recheck 段先行：上一帧（或更早）挂载的冷块语言包迟到的高度差再补。
  processUpPending(host);
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
    // R12：上滚冷块首挂带同步高度差补偿（此前直接跳过 → 换装+高度突变落
    // 在视口内 = 闪刷抽搐，见头注释）；曾挂载块（mnt=1，冻结高在）重挂零
    // 高度变化，无需补偿。
    const coldUp = up && (el as HTMLElement).dataset.mnt !== "1";
    const st0 = host.scrollTop;
    const top0 = r.top + st0; // 块顶文档坐标（挂载不应改变上方内容）
    const h0 = r.height;
    const t0 = performance.now();
    const ok = trigger(el);
    const dt = performance.now() - t0;
    stats.triggered++;
    if (!ok) continue;
    stats.mounted++;
    stats.mountMsTotal += dt;
    if (dt > stats.mountMsMax) stats.mountMsMax = dt;
    stats.lastMountMs.push(Math.round(dt));
    if (stats.lastMountMs.length > 64) stats.lastMountMs.shift();
    mounted++;
    if (coldUp) {
      // 微任务段：语言包缓存命中时补丁侧 updateLanguage 的 reconfigure
      // 在微任务完成（KaTeX 预览高度定型），补偿与高度变化同在 paint 前
      // 提交——零帧可见窗口。
      queueMicrotask(() => {
        compensateUpMount(host, el, top0, h0);
      });
    }
  }
  // 带内仍有候选且预算未尽，或冷块补偿 recheck 未收敛 → 下一帧继续。
  if (mounted >= cfg.perFrame || upCompPending.length > 0) scheduleSweep();
}

/** 上滚冷块补偿的 recheck 挂起项（语言包首次加载的中间态高度兜底）。 */
interface UpCompPending {
  el: Element;
  /** 挂载时块顶文档坐标（漂移校验基准）。 */
  top0: number;
  /** 已认定的块高（含已补偿量）——recheck 与此比差。 */
  expectedH: number;
  tries: number;
}
const upCompPending: UpCompPending[] = [];
/** recheck 最大帧数：语言 reconfigure 最迟数帧内完成，超限交 anchor-comp。 */
const UP_COMP_RECHECK_FRAMES = 6;

/** 上滚冷块首挂的高度差补偿：把 scrollTop 补上新旧高度差，视口内容视觉
 *  零位移（微任务/paint 前提交）。返回实际补偿量（0 = 未补）。
 *  防护：块顶文档坐标漂移 >2px（挂载动了上方内容 = 几何异常）或差值超
 *  PREMOUNT_COMP_MAX 或补偿越滚动边界 → 放弃，残余位移由 scrollDebug
 *  anchor-comp 两帧确认兜底（恢复旧水位，不放大）。 */
function compensateUpMount(
  host: HTMLElement,
  el: Element,
  top0: number,
  h0: number
): number {
  try {
    const r1 = el.getBoundingClientRect();
    const dh = r1.height - h0;
    if (Math.abs(dh) <= 1) {
      // 高度未变（或语言包仍未到）——挂 recheck 兜底语言迟到的定型。
      enqueueUpRecheck(el, top0, r1.height);
      return 0;
    }
    const top1 = r1.top + host.scrollTop;
    if (Math.abs(top1 - top0) > 2) {
      stats.compSkippedDrift++;
      return 0;
    }
    if (Math.abs(dh) > PREMOUNT_COMP_MAX) {
      stats.compSkippedClamp++;
      return 0;
    }
    const target = host.scrollTop + dh;
    if (target < 0 || target > host.scrollHeight - host.clientHeight) {
      stats.compSkippedClamp++;
      return 0;
    }
    noteScrollWrite("premount-comp");
    host.scrollTop = target;
    scrollCount("premount.comp");
    stats.compCount++;
    enqueueUpRecheck(el, top0, r1.height);
    return dh;
  } catch {
    /* never throw */
    return 0;
  }
}

function enqueueUpRecheck(el: Element, top0: number, expectedH: number): void {
  // 同块去重（补偿段已挂过则只更新期望高度）。
  const p = upCompPending.find((x) => x.el === el);
  if (p) {
    p.expectedH = expectedH;
    p.tries = 0;
    return;
  }
  if (upCompPending.length > 64) return; // 防御性上限
  upCompPending.push({ el, top0, expectedH, tries: 0 });
  // 入队发生在补偿微任务（晚于本帧 sweep 的续帧判定）——自行驱动 recheck 链。
  scheduleSweep();
}

/** 每帧重校验挂起的冷块：语言包迟到的高度定型残余差再补（1 帧可见窗口，
 *  仍远快于 anchor-comp 两帧确认）。高度未变（dh≈0）无法区分"未定型"与
 *  "已定型"——不提前收敛，挂满 UP_COMP_RECHECK_FRAMES 帧或出现位移补差
 *  后（tries 重置）再等同样帧数，超限摘除交 anchor-comp 兜底。 */
function processUpPending(host: HTMLElement): void {
  for (let i = upCompPending.length - 1; i >= 0; i--) {
    const p = upCompPending[i];
    if (!p.el.isConnected) {
      upCompPending.splice(i, 1);
      continue;
    }
    if (++p.tries > UP_COMP_RECHECK_FRAMES) {
      upCompPending.splice(i, 1);
      continue;
    }
    const r = p.el.getBoundingClientRect();
    const dh = r.height - p.expectedH;
    if (Math.abs(dh) <= 1) continue; // 未定型/已定型不可分——继续等
    const top1 = r.top + host.scrollTop;
    if (Math.abs(top1 - p.top0) > 2) {
      stats.compSkippedDrift++;
      upCompPending.splice(i, 1);
      continue;
    }
    if (Math.abs(dh) > PREMOUNT_COMP_MAX) {
      stats.compSkippedClamp++;
      upCompPending.splice(i, 1);
      continue;
    }
    const target = host.scrollTop + dh;
    if (target < 0 || target > host.scrollHeight - host.clientHeight) {
      stats.compSkippedClamp++;
      upCompPending.splice(i, 1);
      continue;
    }
    noteScrollWrite("premount-comp");
    host.scrollTop = target;
    scrollCount("premount.comp");
    stats.compCount++;
    p.expectedH = r.height;
    p.tries = 0;
  }
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
  upCompPending.length = 0;
  stats.sweeps = 0;
  stats.triggered = 0;
  stats.mounted = 0;
  stats.skippedUp = 0;
  stats.compCount = 0;
  stats.compSkippedDrift = 0;
  stats.compSkippedClamp = 0;
  stats.mountMsTotal = 0;
  stats.mountMsMax = 0;
  stats.lastMountMs.length = 0;
}
