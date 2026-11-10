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
// R13（2026-11-08）输入全类型预挂载收口：用户终检"第一次滑动到公式块时
// 肯定公式块刷新、要求提前刷新渲染好"。R12 归因探针（perf/results/
// r13-inputs-*.json，解题技巧档 24 块级公式）实锤：R12 只修了 wheel/touch
// 剖面（jumpWheel 0 可见），而滚动条拖拽（scrollTop 步进 2 / 真实拖拽 1）、
// 键盘翻页（PgDn 4）、程序化大跳（End 2）全部 premount sweeps=0——冷块走
// IO 原路径在视口内换装可见；快滚（fastWheel 1）为 perFrame=1 限速追不上
// 的残差。修复四件：
//  * 驱动源扩展：window capture scroll 监听（宿主滚动体才驱动），scrollTop
//    差分推方向/步进——滚动条拖拽、PgDn/End/方向键、大纲/查找/恢复等一切
//    程序化滚动统一进预测带路径。本模块自写的 premount-comp 补偿也会产生
//    scroll 事件：写入前登记 pendingSelfWrite（期望值+时间），事件匹配即
//    吞掉（不驱动、不污染方向）。平滑滚动（大纲 smooth 跳转）以增量事件
//    进同一通道，飞行沿途带内块逐帧预挂。
//  * 跳落点例外（"打开即渲染"口径）：单次 |ΔscrollTop| ≥ max(480, 半视口)
//    判为跳转（PgDn/End/目录跳转/恢复梯子首写/开档落位），rAF 内把**落点
//    视口内**冷块当帧挂完（paint 前提交，首帧即成品）——结构性"带内预挂
//    永远早于到达"覆盖不了的场景（跳转一步把冷块直接放进视口），在报告
//    单列例外口径。视口内挂载不做高度补偿（生长只推下方内容，视口顶锚
//    不动）；上方冷块若遇 host[data-smooth-jump]（恢复梯子/平滑跳转在飞）
//    让位不挂——补偿写 scrollTop 会打断梯子的 untouched 判据，idle 轮询
//    稍后补齐。
//  * 无输入闲置兜底：武装后常驻 idle 轮询（setTimeout+rAF，300ms 起指数
//    退避至 2.5s 封顶），把视口 ±bandPx 双侧带内冷块按帧预算清零——开档/
//    恢复位置后无输入的窗口（H4）、AI 写入新公式块，都在用户第一滚之前
//    预挂完。带深刻意 = bandPx（= IO rootMargin 保鲜窗）：带内挂载块 IO
//    恒报 intersecting → cancelTeardown，**不产生挂了又拆的 churn**；带外
//    （wheel stepMargin 扩出的远带）teardown 15s 后冻高回收，idle 轮询带
//    只有 ±800px 不会重挂它们。预挂 ≠ 永挂：常驻实例上界 = 带内块密度
//    （实测 ≤ 数块/屏），内存语义与 R11/R12 滚动预挂完全一致。
//  * 限速自适应：perFrame=1 → 帧预算制（默认单帧累计挂载 ≥8ms 或
//    perFrameMax=6 块即停，首块必挂），快滚簇连续进带时一帧多挂追平。
//    cfg.perFrame 显式提供时作为硬上限兼容读取（历史探针语义）。
// 档位门（阶段 2 重审）：dataset.big 早退移除，武装位点改为 !isBigDoc
// （CodeMirror/Latex 特性激活的档位；降级档根本无 code-block 组件，查询
// 自然空转）。默认档（无 c-v）IO 派发及时，sweep 只在快滚/主线程忙时兜
// 底，代价 O(块数)/帧可忽略。
//
// 机制背景（r10-phase4-attribution.md S-a/S-g）：块公式（Crepe 把 math 改写
// 为 code_block(language:"LaTeX")）与代码块共用 @milkdown/components 的
// code-block nodeview：IO 进带（rootMargin 800px）才 initializeCodeMirror()
// （CodeMirror+Vue+KaTeX 同步重活）。cv 档 content-visibility:auto 跳过视口
// 外块布局 → IO 交叉计算对无几何目标不报进带 → 块进入浏览器预渲染窗（≈视口
// 外 0~400px）被布局后 IO 才派发 → 挂载完成落在视口内 = 首现闪刷（解题技巧
// down-slow 24/24 全可见，R10/R11 实测）。行内侧由 R10 Fix-A + R13 同款
// scroll 驱动扩展（lazyInlineMath）修复；本模块是块级侧。
//
// 设计（对齐 Fix-A 的边界纪律）：
//  * 发现：wheel/touch/scroll 输入驱动，rAF 帧内扫描滚动方向前方预测带
//    （视口沿 + bandPx + 最近步进余量）内仍是占位 pre 的 .milkdown-code-block，
//    经 window.__codeBlockPreMount（补丁侧受控触发器）走与 IO 进带完全相同的
//    路径（cancelTeardown + initializeCodeMirror，initialized 幂等）。
//  * 限速（红线 17）：帧预算制（见 R13 段），实测单块挂载耗时入 stats（§8
//    最坏帧预算证明）；绝不在 wheel/scroll/IO 回调里同步挂载。
//  * 上滚安全（R4-①/R6 Fix-B 语义的 R12 演进）：上滚侧曾挂载块（dataset.mnt
//    已标，teardown 冻结高在）重挂零高度变化，直接预挂；**上方冷块首挂带同步
//    高度差补偿**（R12 段；R13 起条件方向无关化——idle 双侧带同样会挂上方
//    冷块，判据统一为"块整体在视口顶上方 && 未挂载过"）——补偿后视口内容
//    视觉零位移，安全语义等价于"高度预留"。
//  * IO 兜底保留：预挂载只是提前，IO 回调照常（先到者幂等）——M3 块挂载率
//    100% 硬门不受影响。
//  * 开关：默认开启（!big 档 + setBlockPreMountEnabled 才挂钩）；测量基线臂用
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
  /** 兼容字段：显式提供（≥1）时作为每帧挂载硬上限（历史探针语义）。 */
  perFrame: number;
  /** 帧预算（ms）：单帧挂载累计耗时上限（首块必挂，超限续帧）。 */
  frameBudgetMs: number;
  /** 每帧挂载硬上限（自适应限速默认值；perFrame 显式提供时被其顶替）。 */
  perFrameMax: number;
  /** 解析后的每帧硬上限（perFrame ?? perFrameMax）。 */
  maxN: number;
}

const DEFAULT_CFG: BlockPreMountCfg = {
  on: true,
  bandPx: 800,
  perFrame: 0,
  frameBudgetMs: 8,
  perFrameMax: 6,
  maxN: 6,
};

interface BlockPreMountStats {
  sweeps: number;
  /** 触发预挂（调用触发器且返回 true）次数。 */
  triggered: number;
  /** 预挂执行（真正从占位进入挂载）次数（sweep/idle/landing 合计）。 */
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
  /** R13：scroll 事件驱动的 sweep 排程次数（滚动条拖拽/键滚/程序化滚动剖面）。 */
  scrollMarks: number;
  /** R13：idle 轮询帧数与 idle 路径挂载数。 */
  idleSweeps: number;
  idleMounted: number;
  /** R13：跳落点例外（大位移 → 落点视口内冷块同帧挂）触发帧数与挂载数。 */
  landingRenders: number;
  landingMounted: number;
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
  scrollMarks: 0,
  idleSweeps: 0,
  idleMounted: 0,
  landingRenders: 0,
  landingMounted: 0,
};

/** 单块首挂补偿限幅：正常块级公式高度差实测 ≤~100px，超限只可能是几何
 *  异常（c-v 重估/重建毛刺），照搬会放大成视口大跳——放弃并留给 anchor-comp。 */
const PREMOUNT_COMP_MAX = 400;

/** 跳落点判定门槛（px）：单次 scroll 位移 ≥ max(此值, 半视口高) 视为跳转
 *  （PgDn ≈ 0.9 视口、End/目录跳转/恢复首写为大位移；拖拽步进与平滑滚动
 *  的增量事件远小于此）。 */
const JUMP_PX_MIN = 480;
/** 自写补偿（premount-comp）产生的 scroll 事件抑制窗（ms）：事件值与登记
 *  期望值匹配（±2px）即吞掉。 */
const SELF_WRITE_MATCH_MS = 250;
/** idle 轮询间隔：有活干 300ms 连续清，带清零后指数退避到此上限。 */
const IDLE_POLL_MIN_MS = 300;
const IDLE_POLL_MAX_MS = 2500;

let enabled = false;
let hooked = false;
let rafScheduled = false;
/** 上一次 wheel/touch/scroll 步进幅度（近 5 次最大值，对齐 lazyInlineMath 语义）。 */
const recentSteps: number[] = [];
let stepMargin = 0;
let scrollDir: 0 | 1 | -1 = 0;
/** R13 scroll 驱动：宿主 scrollTop 差分基线（null = 首事件只建基线）。 */
let lastScrollTop: number | null = null;
/** 本模块补偿写入的期望值登记（抑制其 scroll 事件被当用户滚动）。 */
let pendingSelfWrite: { top: number; at: number } | null = null;
/** idle 轮询排程句柄与当前退避间隔。 */
let idleTimer: number | null = null;
let idleRaf: number | null = null;
let idleDelayMs = IDLE_POLL_MIN_MS;
/** 跳落点例外的 rAF 句柄。 */
let landingRaf: number | null = null;

function readCfg(): BlockPreMountCfg {
  try {
    const c = (window as unknown as { __blockPreMountCfg?: Partial<BlockPreMountCfg> })
      .__blockPreMountCfg;
    if (!c) return DEFAULT_CFG;
    const frameBudgetMs =
      typeof c.frameBudgetMs === "number" && c.frameBudgetMs > 0 ? c.frameBudgetMs : DEFAULT_CFG.frameBudgetMs;
    const perFrameMax =
      typeof c.perFrameMax === "number" && c.perFrameMax >= 1
        ? Math.floor(c.perFrameMax)
        : DEFAULT_CFG.perFrameMax;
    const perFrame = typeof c.perFrame === "number" && c.perFrame >= 1 ? Math.floor(c.perFrame) : 0;
    return {
      on: c.on === true,
      bandPx: typeof c.bandPx === "number" && c.bandPx > 0 ? c.bandPx : DEFAULT_CFG.bandPx,
      perFrame,
      frameBudgetMs,
      perFrameMax,
      maxN: perFrame >= 1 ? perFrame : perFrameMax,
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

function findHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".mditor-editor-host");
}

/** rich 编辑面是否可见：sv（源码）模式下 .mditor-milkdown 仅 hidden（实例
 *  常驻、块 nodeview 不销毁）——隐藏子树 gBCR 全 0，会被带判定误收并
 *  反复挂载-拆装（IO 对隐藏块恒不 intersecting → 15s teardown churn）。
 *  sweep/idle/landing 一律以此门禁。 */
function richVisible(): boolean {
  const m = document.querySelector<HTMLElement>(".mditor-editor-host > .mditor-milkdown");
  return !!m && !m.hidden;
}

function getTrigger(): ((el: Element) => boolean) | null {
  const t = (window as unknown as { __codeBlockPreMount?: (el: Element) => boolean })
    .__codeBlockPreMount;
  return typeof t === "function" ? t : null;
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
  // R13：滚动条拖拽 / 键盘滚动 / 程序化滚动（目录跳转、查找定位、恢复梯子、
  // 打开落位）都不产生 wheel/touch——宿主滚动体的 scroll 事件是这些输入的
  // 公共信号。capture 挂 window：scroll 不冒泡但捕获相可达；只认宿主（及
  // document 兜底）作为滚动源，代码块内滚/侧栏滚动不驱动。
  window.addEventListener(
    "scroll",
    (e: Event) => {
      if (!enabled) return;
      const host = findHost();
      if (!host) return;
      const t = e.target;
      if (t !== host && t !== document && t !== document.scrollingElement) return;
      const y = host.scrollTop;
      if (lastScrollTop === null) {
        lastScrollTop = y;
        // 无基线的首事件（enable 时宿主未就绪等）：无从算 Δ——防御性按跳落
        // 点处理（幂等：落点视口内无冷块即 no-op），不给「生命期首个 scroll
        // 事件是开档/恢复首写」留洞（R13 复测 dragDown 臂残余即此洞）。
        scheduleLandingRender();
        scheduleSweep();
        return;
      }
      const dy = y - lastScrollTop;
      lastScrollTop = y;
      // 自写补偿抑制：premount-comp 刚写入的值——不是用户滚动，吞掉
      //（方向/步进会被补偿差值污染）。
      const now = performance.now();
      if (
        pendingSelfWrite &&
        now - pendingSelfWrite.at < SELF_WRITE_MATCH_MS &&
        Math.abs(y - pendingSelfWrite.top) <= 2
      ) {
        pendingSelfWrite = null;
        return;
      }
      if (dy === 0) return;
      scrollDir = dy > 0 ? 1 : -1;
      noteStep(Math.abs(dy));
      stats.scrollMarks++;
      // 跳落点：单次大位移一步把冷块直接放进视口（PgDn/End/瞬时跳转/恢复
      // 首写）——带内预挂结构性覆盖不了，落点例外当帧挂完视口内冷块。
      if (Math.abs(dy) >= Math.max(JUMP_PX_MIN, host.clientHeight * 0.5)) {
        scheduleLandingRender();
      }
      scheduleSweep();
    },
    { capture: true, passive: true }
  );
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

/** 挂载统计（三种来源共用）。 */
function recordMount(dt: number): void {
  stats.triggered++;
  stats.mounted++;
  stats.mountMsTotal += dt;
  if (dt > stats.mountMsMax) stats.mountMsMax = dt;
  stats.lastMountMs.push(Math.round(dt));
  if (stats.lastMountMs.length > 64) stats.lastMountMs.shift();
}

/** 补偿写 scrollTop（统一走此口：登记期望值供 scroll 抑制 + scrollDebug 打点）。 */
function writeCompScroll(host: HTMLElement, target: number): void {
  pendingSelfWrite = { top: target, at: performance.now() };
  noteScrollWrite("premount-comp");
  host.scrollTop = target;
  scrollCount("premount.comp");
  stats.compCount++;
}

interface MountRun {
  count: number;
  /** 因上限/预算截断（带内可能仍有候选 → 需续帧）。 */
  capped: boolean;
}

/** 带内占位块挂载循环（sweep/idle/landing 共用）。
 *  纪律：绝不同步于输入回调——调用方都在 rAF 回调里；帧预算（首块必挂，
 *  之后累计 ≥budgetMs 即停）+ 硬上限 maxN 双重限速。
 *  上方冷块（整体在视口顶上方 && mnt 未标）首挂带同步高度差补偿；恢复
 *  梯子/平滑跳转在飞（data-smooth-jump）时让位（补偿写会打断梯子 untouched
 *  判据），idle 轮询稍后补。 */
function mountInRange(
  host: HTMLElement,
  hostRect: DOMRect,
  lo: number,
  hi: number,
  opts: { maxN: number; budgetMs: number; allowViewport: boolean; kind: "sweep" | "idle" | "landing" }
): MountRun {
  const trigger = getTrigger();
  if (!trigger) return { count: 0, capped: false };
  const t0 = performance.now();
  let mounted = 0;
  let capped = false;
  for (const el of document.querySelectorAll(".milkdown-code-block")) {
    if (mounted >= opts.maxN) {
      capped = true;
      break;
    }
    if (mounted > 0 && performance.now() - t0 >= opts.budgetMs) {
      capped = true;
      break;
    }
    if (!isPlaceholder(el)) continue;
    const r = el.getBoundingClientRect();
    // 零矩形 = 无布局信息（display:none 子树）：跳过（sv 模式常驻实例的
    // 隐藏块；正常占位块即使 c-v 跳过布局也有估算框）。
    if (r.top === 0 && r.bottom === 0) continue;
    if (r.bottom <= lo || r.top >= hi) continue;
    if (!opts.allowViewport && r.top < hostRect.bottom && r.bottom > hostRect.top) {
      // 已在视口内：留给 IO 原路径（预挂目标是"移出可视区"，不是抢修；
      // 跳落点例外走 allowViewport 单独口径）。
      continue;
    }
    // R13：上方冷块补偿条件方向无关化（idle 双侧带同样会挂上方冷块）。
    const coldAbove = r.bottom <= hostRect.top && (el as HTMLElement).dataset.mnt !== "1";
    if (coldAbove && host.dataset.smoothJump !== undefined) continue; // 梯子在飞：让位
    const top0 = r.top + host.scrollTop; // 块顶文档坐标（挂载不应改变上方内容）
    const h0 = r.height;
    const tMount = performance.now();
    const ok = trigger(el);
    const dt = performance.now() - tMount;
    if (!ok) continue;
    recordMount(dt);
    if (opts.kind === "idle") stats.idleMounted++;
    else if (opts.kind === "landing") stats.landingMounted++;
    mounted++;
    if (coldAbove) {
      // 微任务段：语言包缓存命中时补丁侧 updateLanguage 的 reconfigure
      // 在微任务完成（KaTeX 预览高度定型），补偿与高度变化同在 paint 前
      // 提交——零帧可见窗口。
      queueMicrotask(() => {
        compensateUpMount(host, el, top0, h0);
      });
    }
  }
  return { count: mounted, capped };
}

function sweep(): void {
  if (!enabled) return;
  const cfg = readCfg();
  if (!cfg.on) return;
  const host = findHost();
  if (!host || !richVisible() || !getTrigger()) return;
  stats.sweeps++;
  // recheck 段先行：上一帧（或更早）挂载的冷块语言包迟到的高度差再补。
  processUpPending(host);
  const hostRect = host.getBoundingClientRect();
  const up = scrollDir === -1;
  // 预测带：滚动方向前方（下滚=视口底以下；上滚=视口顶以上）。
  const near = up ? hostRect.top + 40 : hostRect.bottom - 40;
  const far = up ? hostRect.top - cfg.bandPx - stepMargin : hostRect.bottom + cfg.bandPx + stepMargin;
  const run = mountInRange(host, hostRect, Math.min(near, far), Math.max(near, far), {
    maxN: cfg.maxN,
    budgetMs: cfg.frameBudgetMs,
    allowViewport: false,
    kind: "sweep",
  });
  // 带内仍有候选且预算未尽，或冷块补偿 recheck 未收敛 → 下一帧继续。
  if (run.capped || upCompPending.length > 0) scheduleSweep();
}

// ---- R13：无输入闲置兜底 ----------------------------------------------------

function scheduleIdle(delayMs: number): void {
  if (idleTimer != null || idleRaf != null) return;
  idleDelayMs = Math.max(IDLE_POLL_MIN_MS, Math.min(IDLE_POLL_MAX_MS, delayMs));
  idleTimer = window.setTimeout(() => {
    idleTimer = null;
    idleRaf = window.requestAnimationFrame(() => {
      idleRaf = null;
      idleSweepFrame();
    });
  }, idleDelayMs);
}

/** idle 轮询帧：双侧带（视口 ±bandPx，不含 stepMargin——刻意停在 IO 保鲜
 *  窗内，挂载块恒 intersecting 不被 teardown，无 churn）。有活干保持最短
 *  间隔连续清；带清零指数退避。cfg.on=false（基线臂）时只维持轮询不干活。 */
function idleSweepFrame(): void {
  if (!enabled) return;
  const cfg = readCfg();
  let delay = Math.min(IDLE_POLL_MAX_MS, idleDelayMs * 2);
  if (cfg.on) {
    const host = findHost();
    if (host && richVisible()) {
      stats.idleSweeps++;
      processUpPending(host);
      const hostRect = host.getBoundingClientRect();
      const run = mountInRange(host, hostRect, hostRect.top - cfg.bandPx, hostRect.bottom + cfg.bandPx, {
        maxN: cfg.maxN,
        budgetMs: cfg.frameBudgetMs,
        allowViewport: false,
        kind: "idle",
      });
      if (run.count > 0 || run.capped) delay = IDLE_POLL_MIN_MS;
    }
  }
  scheduleIdle(delay);
}

// ---- R13：跳落点例外（"打开即渲染"口径） -----------------------------------

function scheduleLandingRender(): void {
  if (landingRaf != null) return;
  landingRaf = window.requestAnimationFrame(() => {
    landingRaf = null;
    landingRender();
  });
}

/** 跳转落点：视口内冷块当帧挂完（rAF 在本帧 paint 前执行，首帧即成品）。
 *  视口内挂载不做高度补偿（生长只推下方内容，视口顶锚不动）。预算截断则
 *  续帧；带外冷块交 sweep/idle 轮询。 */
function landingRender(): void {
  if (!enabled) return;
  const cfg = readCfg();
  if (!cfg.on) return;
  const host = findHost();
  if (!host || !richVisible()) return;
  stats.landingRenders++;
  const hostRect = host.getBoundingClientRect();
  const run = mountInRange(host, hostRect, hostRect.top, hostRect.bottom, {
    maxN: cfg.maxN,
    budgetMs: cfg.frameBudgetMs,
    allowViewport: true,
    kind: "landing",
  });
  if (run.capped) scheduleLandingRender();
  // 落点周围的带下一帧跟上（scrollDir 保持跳转差分方向——下跳扫下方带
  // 即用户的前进方向；idle 轮询双侧兜底另一侧）。
  scheduleSweep();
  scheduleIdle(IDLE_POLL_MIN_MS);
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

/** 上方冷块首挂的高度差补偿：把 scrollTop 补上新旧高度差，视口内容视觉
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
    writeCompScroll(host, target);
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
    writeCompScroll(host, target);
    p.expectedH = r.height;
    p.tries = 0;
  }
}

/** useMilkdown 建实例/载入时按档位调用（R13：CodeMirror/Latex 特性激活档
 *  = !isBigDoc；降级档无 code-block 组件，armed 亦空转）。 */
export function setBlockPreMountEnabled(v: boolean): void {
  enabled = v;
  if (v) {
    hookOnce();
    // 种子差分基线：开档后的首个程序化滚动（恢复梯子首写/探针跳转）就能算
    // 出 Δ 直达跳落点路径（否则首个 scroll 事件只建基线、落点冷块走 IO）。
    const h = findHost();
    lastScrollTop = h ? h.scrollTop : null;
    // H4：开档/重建后无输入窗口——idle 轮询立即起步，预测带在用户第一滚
    // 之前清零。
    scheduleIdle(IDLE_POLL_MIN_MS);
  } else {
    lastScrollTop = null;
    pendingSelfWrite = null;
    if (idleTimer != null) {
      window.clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (idleRaf != null) {
      window.cancelAnimationFrame(idleRaf);
      idleRaf = null;
    }
    if (landingRaf != null) {
      window.cancelAnimationFrame(landingRaf);
      landingRaf = null;
    }
  }
}

/** 仅供测试。 */
export function __resetBlockPreMountForTest(): void {
  enabled = false;
  rafScheduled = false;
  recentSteps.length = 0;
  stepMargin = 0;
  scrollDir = 0;
  lastScrollTop = null;
  pendingSelfWrite = null;
  if (idleTimer != null) {
    window.clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (idleRaf != null) {
    window.cancelAnimationFrame(idleRaf);
    idleRaf = null;
  }
  idleDelayMs = IDLE_POLL_MIN_MS;
  if (landingRaf != null) {
    window.cancelAnimationFrame(landingRaf);
    landingRaf = null;
  }
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
  stats.scrollMarks = 0;
  stats.idleSweeps = 0;
  stats.idleMounted = 0;
  stats.landingRenders = 0;
  stats.landingMounted = 0;
}
