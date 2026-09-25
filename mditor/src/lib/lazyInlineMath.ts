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
// 渲染泵（R1b，公式密集文档滚动回归修复；R3 接缓存 + 滚动中小额渲染）：
// IO 回调只入队，不同步渲染。滚动进行中（SCROLL_QUIET_MS 内有滚动事件）
// 不再「占位即终态」——那会让 LaTeX 密集文档滚动时整屏行内公式停在源码
// 态、静止后才批量补绘，形成「先源码占位、后公式」的闪烁；现在滚动中
// 每帧按 SCROLL_RENDER_BUDGET_MS 小额预算渲染已进入真实视口的条目（探测
// 仅限 IO 余量带内的条目——带外条目几何上不可能进真实视口或方向带，免
// 探测，探测窗口不被滚动历史里的旧条目占满；另有封顶兜底），katexCache
// 命中的视口内条目直绘成本 <0.1ms，绕过滚动门与预算但受单帧条数软上限
// 约束（暖缓存快速回滚也不掉帧）。滚动中出队优先级：视口内 > 滚动方向
// （wheel deltaY / touch 相邻位移符号；键盘滚动无方向可推断，复位为无
// 偏好）前方 800px 带内 > 其余。离屏降级回占位前记录渲染态高度，占位以
// minHeight 撑住原行高（回滚时命中缓存直绘，无重跑 KaTeX 的二次闪烁）。
// 静止后维持每帧 PUMP_FRAME_BUDGET_MS 预算的全量补渲染。初版在 IO 回调
// 里同步渲染整批 entries，公式密集文档（1MB 副本 katex≈1.6 万）快速滚动
// 时形成 300-700ms 长任务风暴：scroll-abab 实测滚动帧 p50 94-150ms，比
// 关闭懒渲染（A 臂）还差 41%（on 档）~23 倍（off 档）——教训是别回退成
// 同步渲染，不是别在滚动中渲染。选中（NodeSelection）与编辑重渲染仍立
// 即执行。
//
// R4 两项叠加：
//  ① 滚动帧预算富余时顺带渲染方向前方带内条目：视口内组处理完后，若同一
//    t0 时钟仍有富余（< SCROLL_RENDER_BUDGET_MS），band 组继续用该时钟
//    渲染——命中走直绘（hitPaints 软上限与视口内共用计数），未命中在剩余
//    预算内冷算 KaTeX；预算耗尽或软上限打满即停，band 剩余回插队首（出队
//    优先级维持 视口内未绘完 > band 剩余 > 其余）。富余是 band 专属的补充
//    预算，视口内 5ms 语义不变，band 绝不挤占视口内。仅向下滚动启用：band
//    在视口下方，首渲高度变化（冷算与命中直绘同）只向下生长、不影响视口
//    内容。向上滚动时 band 在视口上方，首渲高度变化会上移视口内容，而编
//    辑器滚动容器明确关闭 overflow-anchor（global.css：Chromium 锚定会把
//    局部布局位移放大成视口来回跳的历史教训；anchor-comp 亦只在静止帧补
//    偿）——没有锚定补偿可依赖，上方 band 维持留队走静止补渲染路径（demote
//    记录的 minHeight 与命中直绘届时自然兜底）。
//  ② 空闲后台预热（lib/mathCachePrewarm.ts）在载入后把整篇公式源码算进
//    katexCache，冷路径在滚到之前已被消灭。本模块导出 msSinceUserInput
//    作为输入时间戳的单一来源（渲染泵静止门与预热让路窗口共用，预热模块
//    不得另挂一份监听）。
//
// 等价性（红线判定，R1 反向判据）：
//  * Ctrl+F 计数走 markdown 源串（SearchBar regex），与 DOM 无关——恒等价；
//    window.find 侧占位文本=公式源码，与 KaTeX MathML annotation 同样可命中。
//  * 跨视口选区/全选：占位 span 保留完整源码文本，selection/Ctrl+A 语义不变；
//    复制走 PM 文档序列化（不经 DOM）。
//  * 批注 marker 盖章与 math_inline 无交集。
//  * 选中公式（NodeSelection）立即渲染真身（selectNode），LatexInlineTooltip
//    的 shouldShow 读 selection.node——与渲染状态无关。
//  * KaTeX 单实例：渲染经 katexCache 走被 overrides 钉住的同一 katex
//    0.18.4（renderToString 与原 katex.render 同 options 同输出）。

import { Plugin, PluginKey } from "@milkdown/prose/state";
import type { NodeView, EditorView } from "@milkdown/prose/view";
import type { Node as PMNode } from "@milkdown/prose/model";
import { $prose } from "@milkdown/utils";
import { peekCached, renderToStringCached } from "./katexCache";
import { isBigDocCv } from "./memory";

/** 视口观察余量：提前 800px 渲染（慢速滚动不闪占位）。 */
const IO_MARGIN = "800px";
/** 离开视口后延迟降级回占位（ms）——快速来回滚动不做抖动式重建。 */
const DEMOTE_DELAY = 2500;
/** 滚动静止判定窗口（ms）：窗口内出现过滚动事件则全量渲染暂缓。
 *  取 400ms：基准滚轮节奏 ~190ms/格仍在滚动中；慢速阅读式滚动（>400ms/格）
 *  不受影响，公式照常提前渲染。 */
const SCROLL_QUIET_MS = 400;
/** 渲染泵单帧预算（ms）：静止后每帧最多花这么多时间补渲染。 */
const PUMP_FRAME_BUDGET_MS = 10;
/** 滚动中视口内小额渲染预算（ms）：滚动未静止时每帧只花这么多渲染已进入
 *  真实视口的条目（KaTeX 未命中路径）；缓存命中直绘不受此预算约束。取 5ms
 *  与输入事件合并的帧预算同量级——滚动中主诉是不掉帧，不是补齐公式。 */
const SCROLL_RENDER_BUDGET_MS = 5;
/** 滚动中方向性出队的前方带宽（px）：与 IO_MARGIN 同宽——IO 入队的本就是
 *  800px 余量带内的条目，静止补渲染时方向前方（即将滚到的一侧）优先。 */
const FORWARD_BAND_PX = 800;
/** 滚动中每帧最多做多少次 getBoundingClientRect 判定：读阶段批量探测后
 *  统一进入写阶段（避免逐条读写交替触发布局抖动）。探测只针对 IO 余量带
 *  内的条目（带内数量有几何上界，与滚动历史无关），此上限仅作兜底——
 *  超出部分按原序视作「其余」留在队尾。 */
const MAX_RECT_PROBES_PER_FRAME = 256;
/** 滚动中单帧缓存命中直绘的条数软上限：命中虽廉价（Map 查找 + innerHTML
 *  ≈0.1ms/条），探测上限内的命中全部直绘在暖缓存快速回滚（本特性主场景）
 *  时单帧可累计十余毫秒仍掉帧；超出部分回插队首下一帧再绘（命中路径不
 *  跑 KaTeX，多等一帧视觉无感）。 */
export const SCROLL_HIT_PAINT_CAP = 64;
/** 键盘滚动键（方向复位用）：这些键驱动滚动但无从推断方向，按下即把
 *  scrollDir 复位为无偏好，避免沿用上一次滚轮的方向把带内优先级指错侧。 */
const KEY_SCROLL_KEYS = new Set([
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  "ArrowUp",
  "ArrowDown",
]);

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

// ---- 渲染泵：IO 只入队；滚动中视口内小额渲染，静止后按帧预算全量补渲染 ----
type PendingRender = {
  /** 目标元素：滚动中按 getBoundingClientRect 判定视口/方向带；探测前用
   *  isConnected 廉价丢弃已销毁的残留条目（disconnected 元素 rect 全 0，
   *  向上滚动时会被误分类进带内长期占位）。 */
  el: HTMLElement;
  /** IO 余量带内（800px）可见性（活读——条目在队期间元素可能滚出带再滚
   *  回）：带外条目几何上不可能进真实视口或方向带，免探测直接归「其余」，
   *  探测窗口与滚动历史解耦。 */
  ioVisible: () => boolean;
  /** 缓存命中探测（纯查不绘）：命中走 run() 的直绘路径（绕过滚动门与时
   *  钟预算，受单帧条数软上限约束）。 */
  isCached: () => boolean;
  run: () => void;
};

const pendingRenders: PendingRender[] = [];
let pumpScheduled = false;
let lastUserInputAt = -Infinity;
let userInputHooked = false;
/** 最近一次滚动方向：1 向下（内容上移，前方=视口下方）、-1 向上、0 未知
 *  （键盘滚动/初始态——无方向偏好，出队只分视口内/其余）。 */
let scrollDir: 0 | 1 | -1 = 0;
/** 上一次 touchmove 的 Y：touch 无 deltaY，用相邻两次位移符号推方向。 */
let lastTouchY: number | null = null;

/** 仅供测试：重置渲染泵共享态（队列/输入时间戳/帧调度位/滚动方向）。 */
export function __resetRenderPumpForTest(): void {
  pendingRenders.length = 0;
  pumpScheduled = false;
  lastUserInputAt = -Infinity;
  scrollDir = 0;
  lastTouchY = null;
}

/** 用户输入源（wheel/touch/键）标记静止窗口。不监听 scroll 事件：程序化
 *  scrollTop 写入（prewarm-comp 高度补偿、ghost 锚定、恢复落位）也会触发
 *  scroll，会把整个预热补偿期误判成"滚动中"，公式一直被门在占位态
 *  （实测滚到公式带后 ready 23→10 回落）。wheel/touchmove 打点处顺带记录
 *  滚动方向（deltaY 符号 / 相邻 touch 位移符号）供方向性出队；键盘滚动
 *  无方向可推断，翻页/首末/空格/方向键复位方向为无偏好。 */
function hookUserInputOnce(): void {
  if (userInputHooked) return;
  userInputHooked = true;
  const mark = (): void => {
    lastUserInputAt = performance.now();
  };
  window.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      mark();
      if (e.deltaY > 0) scrollDir = 1;
      else if (e.deltaY < 0) scrollDir = -1;
    },
    { capture: true, passive: true }
  );
  window.addEventListener(
    "touchmove",
    (e: TouchEvent) => {
      mark();
      const y = e.touches[0]?.clientY;
      if (y === undefined) return;
      if (lastTouchY !== null && y !== lastTouchY) scrollDir = lastTouchY > y ? 1 : -1;
      lastTouchY = y;
    },
    { capture: true, passive: true }
  );
  // 手势结束/取消重锚：下一次 touchmove 的首帧不做方向判定（无基准，
  // touchcancel 不重锚会跨手势用陈旧锚点判向）。
  const resetTouchAnchor = (): void => {
    lastTouchY = null;
  };
  window.addEventListener("touchend", resetTouchAnchor, { capture: true, passive: true });
  window.addEventListener("touchcancel", resetTouchAnchor, { capture: true, passive: true });
  window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      mark();
      if (KEY_SCROLL_KEYS.has(e.key)) scrollDir = 0;
    },
    { capture: true, passive: true }
  );
}

function scrollQuiet(now: number): boolean {
  return now - lastUserInputAt >= SCROLL_QUIET_MS;
}

/** 距最近一次用户输入（wheel/touchmove/keydown）的毫秒数；从未有过输入
 *  为 Infinity。渲染泵静止门（scrollQuiet）与公式缓存预热的让路窗口
 *  （mathCachePrewarm）共用——输入时间戳单一来源，预热模块不得另挂监听。
 *  首次调用确保监听已挂（hookUserInputOnce 幂等）。 */
export function msSinceUserInput(): number {
  hookUserInputOnce();
  return performance.now() - lastUserInputAt;
}

/** 视口分类（读阶段，每元素一次 rect）：2 视口内 / 1 滚动方向前方带内 /
 *  0 其余。视口判定用真实视口（无余量）——IO 的 800px 余量带负责提前入队，
 *  这里负责「用户此刻正看着的」。 */
function classifyEntry(el: HTMLElement): 0 | 1 | 2 {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  if (r.top < vh && r.bottom > 0) return 2;
  if (scrollDir === 1) {
    return r.top >= vh && r.top < vh + FORWARD_BAND_PX ? 1 : 0;
  }
  if (scrollDir === -1) {
    return r.bottom <= 0 && r.bottom > -FORWARD_BAND_PX ? 1 : 0;
  }
  return 0;
}

/** 滚动中帧：视口内条目小额渲染（缓存命中直绘受单帧软上限），预算仍有
 *  富余时方向前方带内条目也顺带渲染（仅向下滚动，见头注释 R4-①），其余
 *  按方向优先级重排留队。探测仅针对 IO 余量带内的条目，已销毁的残留条目
 *  在探测前廉价丢弃。读阶段（rect 探测）与写阶段（innerHTML）分离，避免
 *  逐条读写交替触发布局抖动。 */
function pumpScrollFrame(): void {
  const viewport: PendingRender[] = [];
  const band: PendingRender[] = [];
  const rest: PendingRender[] = [];
  let probes = 0;
  for (const entry of pendingRenders) {
    if (!entry.el.isConnected) continue; // 已销毁残留：出队丢弃
    if (entry.ioVisible() && probes < MAX_RECT_PROBES_PER_FRAME) {
      probes++;
      const cls = classifyEntry(entry.el);
      if (cls === 2) {
        viewport.push(entry);
        continue;
      }
      if (cls === 1) {
        band.push(entry);
        continue;
      }
    }
    rest.push(entry);
  }
  const deferred: PendingRender[] = [];
  const t0 = performance.now();
  let hitPaints = 0;
  for (const entry of viewport) {
    if (entry.isCached()) {
      if (hitPaints >= SCROLL_HIT_PAINT_CAP) {
        deferred.push(entry); // 命中但超软上限：回插队首，下一滚动帧再绘
        continue;
      }
      hitPaints++;
      entry.run(); // 命中：render 内 peek 直绘（<0.1ms，免时钟预算）
      continue;
    }
    if (performance.now() - t0 < SCROLL_RENDER_BUDGET_MS) entry.run();
    else deferred.push(entry); // 预算耗尽：回插队首（最紧迫），下一滚动帧再试
  }
  // 方向前方带：视口内处理完后时钟仍有富余才动（同一 t0 时钟——富余是
  // band 专属补充预算，视口内 5ms 语义不变）。仅向下滚动：band 在视口下
  // 方，首渲高度变化只向下生长、不影响视口内容；向上滚动的 band 在视口
  // 上方，首渲高度变化会上移视口且没有锚定补偿可依赖（滚动容器刻意关闭
  // overflow-anchor，见头注释 R4-①），维持留队走静止路径。命中走直绘
  // （hitPaints 与视口内共用软上限计数）；未命中在剩余预算内冷算 KaTeX；
  // 预算耗尽或软上限打满即止步，band 剩余回插队首（仍先于其余）。
  let bandIdx = 0;
  if (
    scrollDir === 1 &&
    band.length > 0 &&
    performance.now() - t0 < SCROLL_RENDER_BUDGET_MS
  ) {
    for (; bandIdx < band.length; bandIdx++) {
      const entry = band[bandIdx];
      if (entry.isCached()) {
        if (hitPaints >= SCROLL_HIT_PAINT_CAP) break; // 软上限打满：band 止步
        hitPaints++;
        entry.run();
        continue;
      }
      if (performance.now() - t0 < SCROLL_RENDER_BUDGET_MS) entry.run();
      else break; // 剩余预算耗尽
    }
  }
  // 出队优先级：视口内未绘完 > 方向前方带剩余 > 其余（各组内保持原序稳定）。
  const next: PendingRender[] = [];
  for (const e of deferred) next.push(e);
  for (; bandIdx < band.length; bandIdx++) next.push(band[bandIdx]);
  for (const e of rest) next.push(e);
  pendingRenders.length = 0;
  for (const e of next) pendingRenders.push(e);
}

function schedulePump(): void {
  if (pumpScheduled) return;
  pumpScheduled = true;
  window.requestAnimationFrame(() => {
    pumpScheduled = false;
    if (!pendingRenders.length) return;
    if (scrollQuiet(performance.now())) {
      // 静止：全量补渲染（原 R1b 行为，帧预算 10ms）。
      const t0 = performance.now();
      while (pendingRenders.length && performance.now() - t0 < PUMP_FRAME_BUDGET_MS) {
        pendingRenders.shift()!.run();
      }
    } else {
      // 滚动中：视口内小额渲染 + 方向优先重排，不再空转等待静止窗口。
      pumpScrollFrame();
    }
    if (pendingRenders.length) schedulePump();
  });
}

function enqueueRender(entry: PendingRender): void {
  pendingRenders.push(entry);
  schedulePump();
}

/** demote 前记录的渲染态高度（border-box）：paintPlaceholder 以 minHeight
 *  撑住，消除占位（源码文本行高）↔ 真身（KaTeX 行高）切换的行高跳动。 */
const renderedHeights = new WeakMap<HTMLElement, number>();

function createLazyInlineMathView(node: PMNode): LazyMathView {
  const dom = document.createElement("span");
  dom.dataset.type = "math_inline";
  dom.dataset.value = String(node.attrs.value ?? "");
  dom.className = "mditor-math-inline-lazy";

  let current = node.attrs.value as string;
  let rendered = false;
  let queued = false;
  let demoteTimer: number | null = null;
  /** 当前是否在 IO 余量带（800px）内：滚动帧只探测带内条目（见
   *  PendingRender.ioVisible）。 */
  let ioVisible = false;

  const paintPlaceholder = () => {
    dom.classList.remove("mditor-math-inline-ready");
    dom.textContent = current;
    // 有渲染态高度记录则撑住原行高（占位文本通常矮于 KaTeX 真身）。
    const h = renderedHeights.get(dom);
    if (h !== undefined && h > 0) dom.style.minHeight = `${h}px`;
  };

  /** 落绘真身 HTML：清占位文本与高度预留，写 innerHTML，维护 ready 类名。
   *  缓存命中路径的全部 DOM 成本集中在此（katexCache 直复用 HTML 字符串）。 */
  const applyRenderedHtml = (html: string): void => {
    dom.textContent = "";
    dom.style.minHeight = "";
    dom.innerHTML = html;
    dom.classList.add("mditor-math-inline-ready");
  };

  const render = () => {
    queued = false;
    if (rendered) return;
    rendered = true;
    if (demoteTimer != null) {
      window.clearTimeout(demoteTimer);
      demoteTimer = null;
    }
    const cached = peekCached(current, false);
    if (cached !== undefined) {
      applyRenderedHtml(cached);
      return;
    }
    try {
      applyRenderedHtml(renderToStringCached(current, false));
    } catch {
      /* 渲染失败退回源码占位（与 toDOM throwOnError 同语义）。ready 类
       *  的维护全部在 applyRenderedHtml/paintPlaceholder 内——此处不得
       *  再无条件补加，否则失败占位会带 ready 样式。 */
      paintPlaceholder();
      rendered = false;
    }
  };

  const demote = () => {
    if (!rendered) return;
    rendered = false;
    // 降级前记录渲染态高度：占位撑住原行高，回滚重渲染前不跳行。
    renderedHeights.set(dom, dom.getBoundingClientRect().height);
    paintPlaceholder();
  };

  callbacks.set(dom, (visible) => {
    ioVisible = visible;
    if (visible) {
      if (rendered || queued) return;
      queued = true;
      enqueueRender({
        el: dom,
        ioVisible: () => ioVisible,
        isCached: () => peekCached(current, false) !== undefined,
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
        if (!scrollQuiet(performance.now())) {
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
  hookUserInputOnce();
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
