// 滚动诊断体系（v3.9.6）——「页面自己动 / 滚动卡顿」的运行时证据采集。
//
// 背景：滚动异常已多轮修复仍复发（打字机让位、overflow-anchor、图片懒加
// 载、盖章战争……），但始终缺少运行时证据来区分到底是哪条链路在动滚动
// 位置。本模块把滚动相关的关键事实收进环形缓冲 + 计数器：
//
//  1. 滚动会话归因（session:*，v3.9.5 状态机化）：每次「滚动从静止开始
//     动」判定发起者——用户输入（wheel/触摸/滚动键/滚动条拖拽/host 外任意
//     点击/Ctrl·Alt·Meta 快捷键，v4.2.1 扩展：按钮改布局引发的钳制/重排
//     属用户主动行为）200ms 内 → user；已知程序写入（noteScrollWrite 打点）
//     250ms 内 → write:<tag>（写入年龄扣除其后被 longtask 阻塞的时长，P2-5），
//     平滑跳转类 tag（outline-jump / anno-jump /
//     sv-jump）的归因窗与 App 侧 smoothJump 抑制窗口对齐（scrollend /
//     用户 wheel / 1200ms 超时，标志在位或 1250ms 内均归属写入方）；浏览器
//     钳制 → layout:clamp（不计 ghost）——两类签名：|delta|<2px 且同帧有
//     高度变化的微位移；任意幅度的「贴底钳制」（内容收缩使旧位置越过新上
//     限、scrollTop 恰被压回 scrollHeight-clientHeight，点击按钮改排版/开
//     合面板所致，v4.2.1 前曾误判 ghost）；都不是 → ghost。会话以「连续
//     5 帧静止」确认关闭——longtask 阻断 rAF 后的平滑滚动尾段恢复不再被
//     拦腰判成 ghost（2026-08-22 复现：outline-jump 尾段 1px 被误标
//     ghost，lastWrite@1494ms 前超窗）。惯性滚动天然归属其发起会话。
//  2. 视口内容位移（layout:shift）：scrollTop 没变、但视口顶部哨兵块的
//     文档坐标变了 → 内容在自己动（content-visibility 高度重估 / 图片加载
//     / 盖章行内化 / PM 重排），这是 scrollTop 写入检测抓不到的另一半
//     「自己动」。哨兵用二分选取，失效自动重选。连续静止帧确认制（单帧
//     瞬态不报）；与文档高度突变同帧发生时合并为一条事件输出（位移的原因
//     大概率就是同帧的高度变化）。data-big 模式下确认过的持续位移由
//     anchor-comp 同步补偿（scrollTop += 位移，写入打点 write:anchor-comp，
//     限幅 8000px/次）——这是「补偿」不是「劫持」，仅补内容位移，不碰用户
//     滚动（运动帧不参与），也不重新启用 overflow-anchor（历史教训：
//     它把盖章位移放大成视口来回跳，global.css:1082-1085 保持关闭）。
//  3. 文档高度突变（layout:height）：scrollHeight 变化 >8px——c-v 块首次
//     进入视口时 3em 占位 → 实际高度的跳变证据。
//  4. 长任务（perf:longtask）：主线程阻塞 >50ms（滚动卡顿的直接证据）。
//  5. 块级高度归因（layout:block，v3.9.5）：layout:height 只报文档总高
//     delta，定不了罪。ghost / 位移 / 高度突变触发后的短窗口（2s）内逐
//     块比对 ProseMirror 顶层块高度，定位 ±N 变化发生在哪个块（索引 +
//     tagName + 首行摘要 + delta）；平时休眠，big 模式（data-big）下至多
//     1s 一次静默刷新基线，触发窗口内 100ms 一次比对——常驻路径每帧仍
//     只有常数次属性读取。
//  6. PM 重建检测（pm:rebuild / pm:shape，v3.9.5）：对 .ProseMirror 挂只
//     读 MutationObserver（仅顶层 childList）。顶层块成批同位替换（H1：
//     DOM 替换 → contain-intrinsic-size 的 remembered size 随元素消亡丢
//     失 → 回落 3em 占位 → 批量 -N 塌缩）与块身份不变的高度往返（H2：图
//     片占位 ↔ 真实高度）由此一锤定音。PM 根节点被整体替换（编辑器重建）
//     单独报 pm:root-swap。
//  7. 换行波定罪探针（v3.9.6）：layout:width（.ProseMirror 内容宽度，
//     ResizeObserver）/ font:loaded（webfont 上屏）/ host:attr（祖先
//     style/class 翻转带旧值）——针对「32 块同身份 ±1 行、数秒后回退」
//     的全文换行波，三个候选源一次定罪。
//  8. 视口尺寸变化（v4.3 一等信号）：host 上的 ResizeObserver 记录
//     viewport:resize（含 窗口级/容器级 来源判定）。滚动归因新增
//     「尺寸变化引发」类别（优先级：用户输入 > 已知程序写入 > resize >
//     钳制 > ghost）——侧栏开合/最大化还原/排版设置改版式引发的滚动是
//     布局变化的合理结果（session:resize，info，不计 ghost 不弹告警）；
//     尺寸未变、无输入、无写入的不明滚动仍判 ghost（灵敏度不降）。
//     resize 因果窗内的 layout:shift / layout:height 同样降为 info 并带
//     cause=resize 标记（分析器双重防御）。
//  9. 帧统计（v4.3）：tick 顺带累计帧数 / >50ms 卡顿帧 / 最坏帧间隔 /
//     按键→下一帧延迟（输入响应），scrollFrameStats() 快照供开发者模式
//     心跳采样（相邻快照差分→MD-9xxx 性能异常）。常驻成本每帧几次加减。
//
// 接入：Editor.tsx 挂载 attachScrollWatch(滚动容器)——富文本/IR 模式是根
// div .mditor-editor-host（真正 overflow:auto 的那层）；sv 模式它不滚
// （.cm-scroller 内部滚，哨兵也绑 ProseMirror），观察器自然休眠，sv 不在
// 覆盖范围。所有写 scrollTop / scrollIntoView 的路径先 noteScrollWrite("<tag>") 打点。
// 出口：window.__scrollDebug = { events, counters, clear, recent }。
//
// 纪律：诊断代码绝不能影响编辑器——所有公开入口 try/catch，MutationObserver
// 只读（绝不写 PM 管辖 DOM，写它就是触发重渲、污染证据），每帧成本为
// 常数次属性读取（亚毫秒级）；逐块详细比对只在触发后的短窗口按 100ms
// 步频开启。

/** 事件级别（面板按级别着色）。 */
export type ScrollDebugLevel = "info" | "warn" | "error";

export interface ScrollDebugEvent {
  ts: number;
  level: ScrollDebugLevel;
  kind: string;
  msg: string;
  data?: Record<string, unknown>;
}

const EVENT_CAPACITY = 300;

const events: ScrollDebugEvent[] = [];
const counters = new Map<string, number>();
const subscribers = new Set<(e: ScrollDebugEvent) => void>();

export function scrollCount(key: string, n = 1): void {
  try {
    counters.set(key, (counters.get(key) ?? 0) + n);
  } catch {
    /* never throw */
  }
}

export function scrollEmit(
  kind: string,
  msg: string,
  opts: { level?: ScrollDebugLevel; data?: Record<string, unknown> } = {}
): void {
  try {
    const e: ScrollDebugEvent = {
      ts: Date.now(),
      level: opts.level ?? "info",
      kind,
      msg,
      data: opts.data,
    };
    events.push(e);
    if (events.length > EVENT_CAPACITY) events.shift();
    scrollCount(kind);
    for (const fn of subscribers) {
      try {
        fn(e);
      } catch {
        subscribers.delete(fn);
      }
    }
  } catch {
    /* never throw */
  }
}

export function scrollSubscribe(fn: (e: ScrollDebugEvent) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function scrollEvents(): readonly ScrollDebugEvent[] {
  return events;
}

export function scrollCounters(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Array.from(counters.entries()).sort(([a], [b]) =>
    a < b ? -1 : 1
  )) {
    out[k] = v;
  }
  return out;
}

export function scrollDebugClear(): void {
  events.length = 0;
  counters.clear();
  longtaskLog.length = 0;
  frameStats.frames = 0;
  frameStats.jankFrames = 0;
  frameStats.worstGapMs = 0;
  frameStats.inputLagEvents = 0;
  frameStats.worstInputLagMs = 0;
  lastTickAt = 0;
  lastKeyAt = 0;
  keyLagPending = false;
}

/* -------------------------------------------------------------------------- */
/* 纯逻辑：块高度比对 / PM 批次分类（可单测，无 DOM 依赖）                      */
/* -------------------------------------------------------------------------- */

/** 顶层块快照行（layout:block 归因用）：el 身份 + 上次高度。 */
export interface BlockRow {
  el: Element;
  h: number;
}

/** diffBlocks 产物。 */
export interface BlockDiff {
  /** 同位元素身份变化（PM 重建）——高度比对失效，调用方需整体重基线，
   *  替换原因由 pm:rebuild / pm:shape 事件给出。 */
  replaced: boolean;
  /** 高度发生变化的块（仅身份保持的行，按索引升序）。 */
  changes: Array<{ index: number; from: number; to: number }>;
  /** 顶层块数量变化（尾部增删，正 = 增）。 */
  lenDelta: number;
}

/** 比对两份顶层块快照：身份保持的行报高度变化，身份变化整体标记 replaced。 */
export function diffBlocks(prev: BlockRow[], next: BlockRow[]): BlockDiff {
  const n = Math.min(prev.length, next.length);
  const changes: BlockDiff["changes"] = [];
  let replaced = false;
  for (let i = 0; i < n; i++) {
    if (prev[i].el !== next[i].el) {
      replaced = true;
      continue;
    }
    if (Math.abs(prev[i].h - next[i].h) > 0.5) {
      changes.push({ index: i, from: prev[i].h, to: next[i].h });
    }
  }
  return { replaced, changes, lenDelta: next.length - prev.length };
}

/** PM 顶层 childList 突变批次分类：
 *  * rebuild —— 同批大量删除 + 大量新增（同位替换）：H1（PM 重渲批量替换
 *    顶层块）的签名，remembered size 随旧元素消亡而丢失；
 *  * shape —— 大量纯增删（粘贴/大段删除），块身份本来就该变；
 *  * edit —— 日常编辑（拆段/合段 1~2 个），只计数不发事件。 */
export function classifyPmBatch(removed: number, added: number): "edit" | "shape" | "rebuild" {
  if (removed >= 3 && added >= 3) return "rebuild";
  if (removed + added >= 8) return "shape";
  return "edit";
}

/* -------------------------------------------------------------------------- */
/* 纯逻辑：滚动会话状态机（v3.9.5，可单测）                                    */
/* -------------------------------------------------------------------------- */

/** 会话静止确认帧数：连续 N 帧不动才关闭会话。单帧静止即复位（旧行为）会把
 *  longtask 阻断后的平滑滚动尾段拦腰判成新会话 → 超窗误标 ghost。 */
export const STILL_CONFIRM_FRAMES = 5;
/** 用户输入归因窗。 */
export const USER_WINDOW_MS = 200;
/** 用户改布局动作（点击/快捷键/拖拽）后的告警降级窗：窗口内的
 *  layout:shift / layout:height 视为用户主动引发的重排——照常记录（info
 *  级 + userInitiated 标记），但不再升为告警。 */
export const LAYOUT_INTENT_WINDOW_MS = 500;
/** 常规程序写入归因窗。 */
export const WRITE_WINDOW_MS = 250;
/**
 * 视口尺寸变化的滚动归因窗（v4.3）：侧栏开合/最大化还原等布局变化引发的
 * 滚动/位移通常在尺寸变化后 1~2 帧内发生；CSS 过渡期间 ResizeObserver
 * 每帧刷新 lastResize，窗口自然顺延。与 LAYOUT_INTENT_WINDOW_MS 同为
 * 500ms 量级——窗外的不明滚动仍判 ghost（灵敏度红线）。
 */
export const RESIZE_CAUSAL_WINDOW_MS = 500;

/* --------------------------------------------------------------------------
 * longtask 跨写入窗补偿（P2-5，2026-08-23 大文档定罪）：程序写入（如
 * anchor-comp）之后主线程常被预热期 500~1200ms longtask 阻塞，rAF 恢复时
 * 墙钟年龄已超 WRITE_WINDOW_MS，同一次写入的尾段被误归 ghost（MD-1001
 * ↓3132px 实锤：lastWrite="anchor-comp@13464ms前"、heightDelta=0、非贴底）。
 * 记录 longtask 时间区间，归因时从写入年龄中扣除被阻塞的时长——只有「真
 * 实流逝的空闲时间」参与窗口判定（阻塞期与空闲期天然互补，无需上限）。
 * ------------------------------------------------------------------------ */

interface LongtaskSpan {
  start: number;
  end: number;
}

const longtaskLog: LongtaskSpan[] = [];
/** longtask 区间保留时长（ms）。 */
const LONGTASK_LOG_MS = 5000;

/** PerformanceObserver longtask 回调里逐条登记（startTime 与
 *  performance.now() 同源）。诊断纪律：永不抛错。 */
export function noteLongtaskSpan(start: number, durationMs: number): void {
  try {
    if (!(durationMs > 0)) return;
    longtaskLog.push({ start, end: start + durationMs });
    const cutoff = performance.now() - LONGTASK_LOG_MS;
    while (longtaskLog.length > 0 && longtaskLog[0].end < cutoff) {
      longtaskLog.shift();
    }
  } catch {
    /* never throw */
  }
}

/** [since, now] 区间内被 longtask 阻塞的总时长（ms，区间重叠累计）。 */
export function longtaskBlockedSince(
  since: number,
  now: number = performance.now()
): number {
  let sum = 0;
  for (const sp of longtaskLog) {
    sum += Math.max(0, Math.min(sp.end, now) - Math.max(sp.start, since));
  }
  return sum;
}

/** 平滑跳转类写入的归因窗：覆盖 App/svCodeMirror 侧 smoothJump 抑制窗口
 *  （scrollend / 用户 wheel / 1200ms 超时）全程 + 尾段余量。 */
export const SMOOTH_JUMP_WINDOW_MS = 1250;
/** 平滑跳转类 tag（与 smoothJump 生命周期对齐，见 App.tsx jumpToHeading /
 * jumpToAnnotation、svCodeMirror.ts jumpToLine）。 */
const SMOOTH_JUMP_TAGS = new Set(["outline-jump", "anno-jump", "sv-jump"]);

export function isSmoothJumpTag(tag: string): boolean {
  return SMOOTH_JUMP_TAGS.has(tag);
}

/** 会话状态：当前归因 tag + 连续静止帧数。 */
export interface SessionState {
  tag: string | null;
  stillFrames: number;
}

/** 单帧输入（时间 / 位移 / 高度变化 / 用户与写入信号，均由调用方采集）。 */
export interface SessionInput {
  now: number;
  /** 本帧 scrollTop 位移（相对上帧）。 */
  delta: number;
  /** 本帧 scrollHeight 变化（相对上帧）。 */
  heightDelta: number;
  /** 当前帧绝对 scrollTop（贴底钳制判定：收缩后是否恰停在新滚动上限）。 */
  scrollTop: number;
  /** 当前帧 scrollHeight / clientHeight（新滚动上限 = scrollHeight - clientHeight）。 */
  scrollHeight: number;
  clientHeight: number;
  userIntentAt: number;
  lastWrite: { tag: string; at: number } | null;
  /** 写入以来被 longtask 阻塞的时长（ms，调用方按 longtaskBlockedSince 计
   *  算）：写入年龄扣除它之后才是真实的空闲流逝时间（P2-5）。 */
  longtaskDebt?: number;
  /** 最近一次视口尺寸变化的时刻（performance.now 同源；null/缺省 = 无）。 */
  resizeAt?: number | null;
  /** 该次尺寸变化量（px，contentRect 口径）。 */
  resizeDelta?: { dw: number; dh: number } | null;
  /** App 侧 smoothJump 抑制标志当前是否在位（host.dataset.smoothJump）。 */
  smoothJumpActive: boolean;
}

/** 会话判定结果。continue = 会话跨短暂静止（未达确认阈值）延续，不重判、
 *  不计数——longtask 阻断后恢复 / 平滑动画帧间停顿的尾段归属靠它。
 *  resize = 视口尺寸变化引发的滚动（v4.3）：布局变化的合理结果，不计
 *  ghost、不弹告警（info 事件保留研究价值）。 */
export type SessionVerdict =
  | { type: "none" }
  | { type: "continue" }
  | { type: "user" }
  | { type: "write"; tag: string }
  | { type: "resize"; dw: number; dh: number; delta: number }
  | { type: "clamp"; delta: number; heightDelta: number; forced: boolean }
  | { type: "ghost" };

/**
 * 推进一帧会话状态机：静止帧累计静止确认；运动帧在会话存活时延续，否则
 * 分类新会话（user > write > resize > clamp > ghost）。clamp 分微位移与贴底
 * 钳制两类（见下方分支注释），会话均立即关闭（钳制是单帧事件，紧随其后
 * 的其余位移需要独立分类，避免吞掉真 ghost）。
 */
export function stepSession(
  state: SessionState,
  input: SessionInput
): { state: SessionState; verdict: SessionVerdict } {
  const moving = Math.abs(input.delta) > 0.5;
  if (!moving) {
    const stillFrames = state.stillFrames + 1;
    const tag = stillFrames >= STILL_CONFIRM_FRAMES ? null : state.tag;
    return { state: { tag, stillFrames }, verdict: { type: "none" } };
  }
  if (state.tag != null && state.tag !== "clamp") {
    // 会话存活（静止未达确认阈值或连续运动中）→ 延续，不重判。
    return {
      state: { tag: state.tag, stillFrames: 0 },
      verdict: state.stillFrames > 0 ? { type: "continue" } : { type: "none" },
    };
  }
  if (input.now - input.userIntentAt < USER_WINDOW_MS) {
    return { state: { tag: "user", stillFrames: 0 }, verdict: { type: "user" } };
  }
  const w = input.lastWrite;
  const smoothAlive =
    w != null &&
    isSmoothJumpTag(w.tag) &&
    (input.smoothJumpActive || input.now - w.at < SMOOTH_JUMP_WINDOW_MS);
  // 写入年龄扣除 longtask 阻塞时长（P2-5）：写入后主线程被阻塞期间不算
  // 「流逝」——rAF 恢复时补偿尾段仍归属写入方，不再误判 ghost。
  const writeAge =
    input.now - (w?.at ?? input.now) - (input.longtaskDebt ?? 0);
  if (w && (writeAge < WRITE_WINDOW_MS || smoothAlive)) {
    return {
      state: { tag: `write:${w.tag}`, stillFrames: 0 },
      verdict: { type: "write", tag: w.tag },
    };
  }
  // 视口尺寸变化引发的滚动（v4.3）：优先级在用户输入与已知写入之后、
  // 钳制与 ghost 之前。侧栏开合/最大化还原/排版变更 → 重排 → 浏览器调
  // 整 scrollTop，是布局变化的合理结果，不是「页面自己动」。窗口内的
  // 滚动记 resize 会话（info 事件），窗外或无尺寸变化的仍走钳制/ghost
  // 分支——本分支只消费「确有尺寸变化」这一硬信号，不会吞掉真 ghost。
  if (
    input.resizeAt != null &&
    input.now - input.resizeAt < RESIZE_CAUSAL_WINDOW_MS
  ) {
    return {
      state: { tag: "resize", stillFrames: 0 },
      verdict: {
        type: "resize",
        dw: input.resizeDelta?.dw ?? 0,
        dh: input.resizeDelta?.dh ?? 0,
        delta: input.delta,
      },
    };
  }
  // 浏览器钳制（不计 ghost）两类签名：
  //  * 微位移——|delta|<2px 且同帧高度变化 ≥1px（亚像素/收缩回弹噪音）；
  //  * 贴底钳制（forced，任意幅度）——内容收缩（heightDelta≤-1）使旧位置
  //    越过新滚动上限，scrollTop 被浏览器压回并恰好停在新上限。这个组合
  //    只可能由 clamping 产生：点击按钮改排版/开合侧栏 → 全文重排收缩 →
  //    页面「不得不滚动」，属合理行为（2026-08-23 用户反馈曾误判 ghost）。
  //    停在其余位置的位移仍判 ghost（真有不明来源）。
  const maxScroll = Math.max(0, input.scrollHeight - input.clientHeight);
  const prevSt = input.scrollTop - input.delta;
  const micro = Math.abs(input.delta) < 2 && Math.abs(input.heightDelta) >= 1;
  const forced =
    input.heightDelta <= -1 &&
    prevSt > maxScroll + 0.5 &&
    Math.abs(input.scrollTop - maxScroll) <= 1;
  if (micro || forced) {
    return {
      state: { tag: "clamp", stillFrames: STILL_CONFIRM_FRAMES },
      verdict: {
        type: "clamp",
        delta: input.delta,
        heightDelta: input.heightDelta,
        forced,
      },
    };
  }
  return { state: { tag: "ghost", stillFrames: 0 }, verdict: { type: "ghost" } };
}

/* -------------------------------------------------------------------------- */
/* 写入打点                                                                    */
/* -------------------------------------------------------------------------- */

/** 最近一次程序写入（tag + 时间）。ghost 判定用它区分「已知写入」与「不明
 *  来源」；tag 即写入方身份（typewriter / outline-jump / restore …）。 */
let recentWrite: { tag: string; at: number } | null = null;

/** 在任何写 scrollTop / scrollIntoView 的语句前调用。 */
export function noteScrollWrite(tag: string): void {
  recentWrite = { tag, at: performance.now() };
  scrollCount(`write.${tag}`);
}

/** 供 ghost 事件附带的归因上下文 / __scrollDebug 出口。 */
export function lastScrollWrite(): { tag: string; at: number } | null {
  return recentWrite;
}

/* -------------------------------------------------------------------------- */
/* 滚动观察器                                                                  */
/* -------------------------------------------------------------------------- */

/** 用户输入意图信号（真用户滚动必然先于滚动发生）：wheel / 触摸 / 滚动键 /
 *  pointerdown。v4.2.1 起 pointerdown 提到 window 级——点 host 外的按钮
 *  （侧栏开合/排版设置/焦点模式……）改布局引发的钳制/重排同样属用户主动
 *  行为；Ctrl·Alt·Meta 快捷键（Ctrl+\ 开侧栏等）同理。普通打字键不算：
 *  打字引发的重排由钳制分类兜底，保持 ghost 对不明滚动的灵敏度。 */
const USER_INPUT_KEYS = new Set([
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  " ",
]);

/** ghost / 位移 / 高度突变触发后，逐块比对窗口的时长。 */
const BLOCK_WINDOW_MS = 2000;
/** 触发窗口内的比对步频（ms/次）。 */
const BLOCK_WALK_WINDOW_MS = 100;
/** 休眠期（big 模式）基线刷新步频（ms/次）。 */
const BLOCK_WALK_IDLE_MS = 1000;
/** 单块高度变化的报告阈值（px），过滤亚像素/边框级噪音。 */
const BLOCK_MIN_DELTA = 4;
/** 一次 layout:block 事件最多列出的块数。 */
const BLOCK_MAX_LISTED = 8;

/** anchor-comp 单次补偿限幅：确认过的持续位移全量补偿，但单写不超过此值
 *  （防哨兵异常导致的灾难性误补偿；更大的漂移按帧收敛）。 */
const ANCHOR_COMP_MAX = 8000;
/** 位移确认阈值：连续静止帧同一哨兵位移 ≥ 此值才视为真实位移（单帧瞬态
 *  ——预热/重建期间的哨兵毛刺——不补偿也不报事件）。 */
const SHIFT_CONFIRM_MIN = 4;

export interface ScrollWatchStats {
  /** 最近一次 ghost 的摘要（面板展示 / 排查入口）。 */
  lastGhost: ScrollDebugEvent | null;
  /** 观察器是否在跑。 */
  watching: boolean;
}

const stats: ScrollWatchStats = { lastGhost: null, watching: false };

/* --------------------------------------------------------------------------
 * 帧统计（v4.3）：tick 顺带累计（常驻成本每帧几次加减），快照只读不清零
 * ——消费者（开发者模式心跳）用相邻快照差分得到窗口内指标。
 * ------------------------------------------------------------------------ */

export interface ScrollFrameStats {
  /** tick 帧数（rAF 空转也计——后台/失焦时自然趋零）。 */
  frames: number;
  /** 帧间隔 >50ms 的次数（掉帧卡顿证据）。 */
  jankFrames: number;
  /** 最坏帧间隔（ms）。 */
  worstGapMs: number;
  /** 按键→下一帧延迟 >100ms 的次数（输入响应卡顿证据）。 */
  inputLagEvents: number;
  /** 最坏按键→帧延迟（ms）。 */
  worstInputLagMs: number;
}

const frameStats: ScrollFrameStats = {
  frames: 0,
  jankFrames: 0,
  worstGapMs: 0,
  inputLagEvents: 0,
  worstInputLagMs: 0,
};
/** 输入延迟判定线：按键后下一帧超过此值才算「输入响应卡顿」。 */
const INPUT_LAG_MS = 100;
/** 卡顿帧判定线（与 longtask 的 50ms 门槛一致）。 */
const JANK_GAP_MS = 50;

let lastTickAt = 0;
let lastKeyAt = 0;
let keyLagPending = false;

/** 帧统计快照（累计值；心跳侧自行差分）。 */
export function scrollFrameStats(): ScrollFrameStats {
  return { ...frameStats };
}

export function scrollWatchStats(): ScrollWatchStats {
  return stats;
}

/** 会话内观察器挂载序号（watch:attach 事件携带；>1 即存在重复挂载/重建链路）。 */
let attachSeq = 0;

/**
 * 在主编辑滚动容器上挂观察器（Editor 挂载时调用一次，返回卸载函数）。
 * rAF 每帧：读 scrollTop / scrollHeight / 哨兵 rect（均为布局缓存读取，
 * 不主动触发强制布局），做会话归因与位移检测。
 */
export function attachScrollWatch(host: HTMLElement): () => void {
  if (stats.watching) return () => undefined;
  stats.watching = true;
  const seq = ++attachSeq;

  let userIntentAt = 0;
  let prevSt = host.scrollTop;
  let prevH = host.scrollHeight;
  // 会话归因（延续期间不重判，惯性自动归属发起者）。
  let sessionTag: string | null = null;
  let sessionStill = 0;
  // 哨兵：视口顶部的 ProseMirror 顶层块（element + 上帧文档坐标 top）。
  let sentinel: { el: Element; docTop: number } | null = null;
  // 位移确认武装：第一帧检出位移时记录 {el, docTop}，下一静止帧复核。
  let compArmed: { el: Element; docTop: number } | null = null;
  let raf = 0;
  let disposed = false;

  // --- layout:block：顶层块高度基线 + 触发窗口 ------------------------------
  let blockBase: BlockRow[] | null = null;
  let blockWalkAt = 0;
  let blockWindowUntil = 0;

  const openBlockWindow = () => {
    try {
      blockWindowUntil = performance.now() + BLOCK_WINDOW_MS;
    } catch {
      /* never throw */
    }
  };

  const blockLabel = (el: Element | undefined): string => {
    if (!el) return "";
    try {
      return (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 24);
    } catch {
      return "";
    }
  };

  /** 逐块比对（步频受控：窗口内 100ms、休眠 1s；非 big 且无窗口时休眠并
   *  释放基线）。只读 offsetHeight（布局缓存读取），绝不写 DOM。 */
  const walkBlocks = (now: number) => {
    const windowActive = now < blockWindowUntil;
    const big = host.dataset.big !== undefined;
    if (!windowActive && !big) {
      blockBase = null;
      return;
    }
    const cadence = windowActive ? BLOCK_WALK_WINDOW_MS : BLOCK_WALK_IDLE_MS;
    if (now - blockWalkAt < cadence) return;
    blockWalkAt = now;
    const pm = host.querySelector(".ProseMirror");
    if (!pm) {
      blockBase = null;
      return;
    }
    const kids = pm.children;
    const cur: BlockRow[] = new Array(kids.length);
    for (let i = 0; i < kids.length; i++) {
      cur[i] = { el: kids[i], h: (kids[i] as HTMLElement).offsetHeight };
    }
    const base = blockBase;
    blockBase = cur;
    if (!base) return;
    const d = diffBlocks(base, cur);
    if (d.replaced) {
      // 顶层块身份变化：高度比对无意义，重基线。替换原因由同刻的
      // pm:rebuild / pm:shape 事件（MutationObserver）给出。
      scrollCount("block.rebase");
      return;
    }
    const changes = d.changes.filter(
      (c) => Math.abs(c.to - c.from) >= BLOCK_MIN_DELTA
    );
    if (changes.length === 0 && d.lenDelta === 0) return;
    const parts: string[] = [];
    const shown = changes.slice(0, BLOCK_MAX_LISTED);
    for (const c of shown) {
      const el = cur[c.index]?.el;
      const delta = c.to - c.from;
      parts.push(
        `#${c.index} ${el?.tagName ?? "?"}「${blockLabel(el)}」${c.from}→${c.to}（${delta >= 0 ? "+" : ""}${Math.round(delta)}px）`
      );
    }
    if (changes.length > shown.length) {
      parts.push(`…另有 ${changes.length - shown.length} 块`);
    }
    if (d.lenDelta !== 0) {
      parts.push(`块数 ${base.length}→${cur.length}（${d.lenDelta >= 0 ? "+" : ""}${d.lenDelta}）`);
    }
    scrollEmit(
      "layout:block",
      `块高度变化 ${changes.length} 处：${parts.join("；")}`,
      {
        level: changes.length >= 3 ? "warn" : "info",
        data: { changes: changes.length, lenDelta: d.lenDelta },
      }
    );
  };

  // --- pm:rebuild：只读观察 ProseMirror 顶层 childList ----------------------
  let pmObs: MutationObserver | null = null;
  let pmObsRoot: Element | null = null;
  let pmProbeAt = 0;

  const sampleText = (n: Node): string => {
    try {
      return (n.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 32);
    } catch {
      return "";
    }
  };

  /** 惰性挂接 PM 根（挂载时 PM 可能尚不存在；编辑器重建换根时自动跟进，
   *  并报 pm:root-swap）。探测按 500ms 节流，常驻每帧只花一次 isConnected。 */
  const ensurePmObserver = (now: number) => {
    if (pmObs && pmObsRoot && pmObsRoot.isConnected) return;
    if (now - pmProbeAt < 500) return;
    pmProbeAt = now;
    const pm = host.querySelector(".ProseMirror");
    if (!pm || pm === pmObsRoot) return;
    if (pmObsRoot != null) {
      scrollEmit("pm:root-swap", "ProseMirror 根节点被替换（编辑器重建）", {
        level: "warn",
      });
    }
    pmObs?.disconnect();
    pmObsRoot = pm;
    pmObs = new MutationObserver((records) => {
      try {
        let removed = 0;
        let added = 0;
        const rmSamples: string[] = [];
        const addSamples: string[] = [];
        for (const r of records) {
          if (r.type !== "childList") continue;
          for (const n of r.removedNodes) {
            removed++;
            if (rmSamples.length < 3) rmSamples.push(sampleText(n));
          }
          for (const n of r.addedNodes) {
            added++;
            if (addSamples.length < 3) addSamples.push(sampleText(n));
          }
        }
        if (removed === 0 && added === 0) return;
        scrollCount("pm.childlist");
        const verdict = classifyPmBatch(removed, added);
        if (verdict === "edit") return;
        if (verdict === "rebuild") {
          scrollEmit(
            "pm:rebuild",
            `PM 顶层块批量替换 -${removed}/+${added}（remembered size 随旧元素消亡丢失 → 回落 3em 占位）如「${rmSamples[0] ?? ""}」`,
            {
              level: "warn",
              data: { removed, added, rmSamples, addSamples },
            }
          );
        } else {
          scrollEmit("pm:shape", `PM 顶层块大量增删 -${removed}/+${added}`, {
            data: { removed, added, rmSamples, addSamples },
          });
        }
      } catch {
        /* 诊断永不抛错 */
      }
    });
    pmObs.observe(pm, { childList: true });
    attachWidthProbe(pm);
  };

  // --- 定罪探针 v3.9.6：±24px 全文换行波的三个候选源 ------------------------
  // layout:width —— .ProseMirror 内容宽度变化（ResizeObserver，事件驱动零
  //   轮询）。宽度变化 ⇒ 全部近边界文本块同时 ±1 行（2026-08-22 实测 32 块
  //   ±24~52px、总高 ±1114px、7 秒后回退的波），此探针给出量级与时刻。
  // font:loaded —— webfont 异步上屏（FontFaceSet loadingdone），字体度量
  //   变化同样引发全文重排换行。
  // host:attr —— html/body/host 的 style/class 属性翻转（带旧值），直接
  //   定位是谁在写排版变量（applyToDom / applyProseVars / 主题切换……）。
  //   三者均只读、try/catch、不参与任何布局写入，符合诊断纪律。
  let widthObs: ResizeObserver | null = null;
  let widthObsRoot: Element | null = null;
  const attachWidthProbe = (pm: Element): void => {
    if (widthObsRoot === pm) return;
    try {
      widthObs?.disconnect();
      widthObsRoot = pm;
      let lastW = -1;
      widthObs = new ResizeObserver((entries) => {
        try {
          for (const en of entries) {
            const w = en.contentRect.width;
            if (lastW >= 0 && Math.abs(w - lastW) > 0.5) {
              scrollEmit(
                "layout:width",
                `内容宽度 ${lastW.toFixed(0)} → ${w.toFixed(0)}（${w - lastW >= 0 ? "+" : ""}${(w - lastW).toFixed(1)}px）——换行重排定罪`,
                { data: { from: Math.round(lastW), to: Math.round(w) } }
              );
              openBlockWindow();
            }
            lastW = w;
          }
        } catch {
          /* never throw */
        }
      });
      widthObs.observe(pm);
    } catch {
      /* 环境不支持 ResizeObserver 则跳过 */
    }
  };

  const onFontsDone = (e: Event): void => {
    try {
      const faces = (e as FontFaceSetLoadEvent).fontfaces
        .map((f) => f.family)
        .slice(0, 4)
        .join("、");
      scrollEmit("font:loaded", `webfont 上屏：${faces || "未知"}（字体度量变化 → 全文重排候选）`);
    } catch {
      /* never throw */
    }
  };
  try {
    document.fonts.addEventListener("loadingdone", onFontsDone);
  } catch {
    /* 环境无 document.fonts 则跳过 */
  }

  let attrObs: MutationObserver | null = null;
  try {
    attrObs = new MutationObserver((records) => {
      try {
        for (const r of records) {
          const name = r.attributeName ?? "?";
          const el = r.target as Element;
          const where =
            el === document.documentElement
              ? "html"
              : el === document.body
                ? "body"
                : el === host
                  ? "host"
                  : el.tagName;
          const oldV = (r.oldValue ?? "").replace(/\s+/g, " ").slice(0, 40);
          const newV = (el.getAttribute(name) ?? "").replace(/\s+/g, " ").slice(0, 40);
          scrollEmit(
            "host:attr",
            `${where} 的 ${name} 翻转：「${oldV || "∅"}」→「${newV || "∅"}」`,
            { data: { where, attr: name, from: oldV, to: newV } }
          );
        }
      } catch {
        /* never throw */
      }
    });
    attrObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class", "data-theme", "data-motion", "data-big", "data-mode"],
      attributeOldValue: true,
    });
    attrObs.observe(document.body, {
      attributes: true,
      attributeFilter: ["style", "class"],
      attributeOldValue: true,
    });
    attrObs.observe(host, {
      attributes: true,
      attributeFilter: ["style", "class", "data-big", "data-mode"],
      attributeOldValue: true,
    });
  } catch {
    /* never throw */
  }

  let pointerHeld = false;
  const onUserIntent = () => {
    userIntentAt = performance.now();
  };
  const onPointerDown = () => {
    pointerHeld = true;
    userIntentAt = performance.now();
  };
  const onPointerUp = () => {
    pointerHeld = false;
  };
  // 按住拖拽（resizer 调宽等）期间持续刷新意图：长拖拽远超 200ms 归因窗，
  // 每帧重排都该归属用户。e.buttons===0 说明按键已在窗外松开（无 pointerup
  // 兜底），复位防「卡按住」长期压制告警。
  const onPointerMove = (e: PointerEvent) => {
    if (!pointerHeld) return;
    if (e.buttons === 0) {
      pointerHeld = false;
      return;
    }
    userIntentAt = performance.now();
  };
  const onKey = (e: KeyboardEvent) => {
    if (USER_INPUT_KEYS.has(e.key) || e.ctrlKey || e.metaKey || e.altKey) {
      userIntentAt = performance.now();
    }
    // 帧统计的输入延迟采样：普通打字键/滚动键记时刻，下一帧 tick 结算
    // 「按键→上屏帧」延迟（输入响应卡顿证据，v4.3）。
    if (e.key.length === 1 || USER_INPUT_KEYS.has(e.key)) {
      lastKeyAt = performance.now();
      keyLagPending = true;
    }
  };

  // --- 视口尺寸变化（v4.3 一等信号）：host 上的 ResizeObserver。
  // lastResize 每次回调都刷新（归因窗跟着过渡逐帧顺延）；事件发射按
  // 300ms 节流（拖拽侧栏时 RO 每帧触发，不节流会冲掉事件环），原始次数
  // 由 viewport:resize 计数器承载。来源判定：同帧 window 内宽高也变了
  // → 窗口级（最大化/还原/DPI），否则容器级（侧栏/面板开合）。
  let lastResize: {
    at: number;
    dw: number;
    dh: number;
    source: "window" | "container";
  } | null = null;
  let sizeObs: ResizeObserver | null = null;
  let sizeW = -1;
  let sizeH = -1;
  let lastWinW = -1;
  let lastWinH = -1;
  let lastResizeEmitAt = 0;
  try {
    sizeObs = new ResizeObserver((entries) => {
      try {
        for (const en of entries) {
          const w = en.contentRect.width;
          const h = en.contentRect.height;
          if (sizeW >= 0 && (Math.abs(w - sizeW) > 0.5 || Math.abs(h - sizeH) > 0.5)) {
            const winChanged =
              lastWinW >= 0 &&
              (Math.abs(window.innerWidth - lastWinW) > 0.5 ||
                Math.abs(window.innerHeight - lastWinH) > 0.5);
            const source = winChanged ? "window" : "container";
            lastResize = {
              at: performance.now(),
              dw: Math.round((w - sizeW) * 10) / 10,
              dh: Math.round((h - sizeH) * 10) / 10,
              source,
            };
            scrollCount("viewport:resize");
            const now = performance.now();
            if (now - lastResizeEmitAt >= 300) {
              lastResizeEmitAt = now;
              scrollEmit(
                "viewport:resize",
                `滚动视口尺寸 ${Math.round(sizeW)}×${Math.round(sizeH)} → ${Math.round(w)}×${Math.round(h)}（${lastResize.dw >= 0 ? "+" : ""}${lastResize.dw}×${lastResize.dh >= 0 ? "+" : ""}${lastResize.dh}，${source === "window" ? "窗口级" : "容器级"}）`,
                {
                  data: {
                    from: { w: Math.round(sizeW), h: Math.round(sizeH) },
                    to: { w: Math.round(w), h: Math.round(h) },
                    dw: lastResize.dw,
                    dh: lastResize.dh,
                    source,
                  },
                }
              );
              openBlockWindow();
            }
          }
          sizeW = w;
          sizeH = h;
          lastWinW = window.innerWidth;
          lastWinH = window.innerHeight;
        }
      } catch {
        /* never throw */
      }
    });
    sizeObs.observe(host);
  } catch {
    /* 环境不支持 ResizeObserver 则跳过（resize 归因降级为无信号） */
  }


  host.addEventListener("wheel", onUserIntent, { passive: true, capture: true });
  host.addEventListener("touchstart", onUserIntent, { passive: true, capture: true });
  window.addEventListener("pointerdown", onPointerDown, { passive: true, capture: true });
  window.addEventListener("pointermove", onPointerMove, { passive: true, capture: true });
  window.addEventListener("pointerup", onPointerUp, { passive: true, capture: true });
  window.addEventListener("pointercancel", onPointerUp, { passive: true, capture: true });
  window.addEventListener("keydown", onKey, true);

  /** 二分找第一个底边越过视口顶的顶层块（ProseMirror 子块按文档序排列，
   *  rect.top 单调不减）。O(log n) 次 rect 读取，c-v 块只读边界不布局子树。 */
  const pickSentinel = (): { el: Element; docTop: number } | null => {
    const pm = host.querySelector(".ProseMirror");
    if (!pm) return null;
    const blocks = pm.children;
    const n = blocks.length;
    if (n === 0) return null;
    let lo = 0;
    let hi = n - 1;
    let found = -1;
    let foundRect: DOMRect | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = blocks[mid].getBoundingClientRect();
      if (r.bottom > 0) {
        found = mid;
        foundRect = r;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    if (found < 0 || !foundRect) return null;
    return { el: blocks[found], docTop: foundRect.top + host.scrollTop };
  };

  const tick = () => {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    try {
      const now = performance.now();
      const st = host.scrollTop;
      const h = host.scrollHeight;
      const moving = Math.abs(st - prevSt) > 0.5;

      // --- 帧统计（v4.3）：帧间隔 / 卡顿帧 / 输入→帧延迟（纯计数，常驻）。
      if (lastTickAt > 0) {
        const gap = now - lastTickAt;
        frameStats.frames += 1;
        if (gap > JANK_GAP_MS) frameStats.jankFrames += 1;
        if (gap > frameStats.worstGapMs) frameStats.worstGapMs = gap;
      }
      lastTickAt = now;
      if (keyLagPending && lastKeyAt > 0) {
        const lag = now - lastKeyAt;
        if (lag >= 0 && lag < 5000) {
          if (lag > INPUT_LAG_MS) frameStats.inputLagEvents += 1;
          if (lag > frameStats.worstInputLagMs) frameStats.worstInputLagMs = lag;
        }
        keyLagPending = false;
      }

      ensurePmObserver(now);

      // --- 滚动会话归因（v3.9.5 状态机 + v4.3 resize 类）：静止→运动的
      // 第一帧判定发起者；会话以连续 STILL_CONFIRM_FRAMES 帧静止确认关闭
      // （longtask 阻断后的尾段恢复、平滑动画帧间停顿不再重判），微位移与
      // 平滑跳转尾段有专属分类（clamp / 扩展归因窗），视口尺寸变化引发
      // 的滚动记 resize 会话，ghost 只留给真正不明的滚动。
      const resizeActive =
        lastResize != null && now - lastResize.at < RESIZE_CAUSAL_WINDOW_MS;
      const step = stepSession(
        { tag: sessionTag, stillFrames: sessionStill },
        {
          now,
          delta: st - prevSt,
          heightDelta: h - prevH,
          scrollTop: st,
          scrollHeight: h,
          clientHeight: host.clientHeight,
          userIntentAt,
          lastWrite: recentWrite,
          longtaskDebt: recentWrite
            ? longtaskBlockedSince(recentWrite.at, now)
            : 0,
          resizeAt: resizeActive ? lastResize!.at : null,
          resizeDelta: resizeActive
            ? { dw: lastResize!.dw, dh: lastResize!.dh }
            : null,
          smoothJumpActive: host.dataset.smoothJump !== undefined,
        }
      );
      sessionTag = step.state.tag;
      sessionStill = step.state.stillFrames;
      // 大幅位移帧（跳转/焦点瞬移）：旧哨兵的 docTop 已失义（瞬移后同帧
      // docTop 差 = 瞬移量，会被误报成内容位移），作废重选。
      if (moving && Math.abs(st - prevSt) > 500) {
        sentinel = null;
        compArmed = null;
      }
      if (step.verdict.type === "user") {
        scrollCount("session.user");
      } else if (step.verdict.type === "write") {
        scrollCount(`session.write.${step.verdict.tag}`);
      } else if (step.verdict.type === "resize") {
        // 视口尺寸变化引发的滚动（v4.3）：布局变化的合理结果——照常记录
        // （info，保留研究价值），不计 ghost、不弹告警。
        scrollCount("session.resize");
        scrollEmit(
          "session:resize",
          `视口尺寸变化引发滚动 ${step.verdict.delta >= 0 ? "↓" : "↑"} ${Math.abs(step.verdict.delta).toFixed(0)}px（视口 ${step.verdict.dw >= 0 ? "+" : ""}${step.verdict.dw}×${step.verdict.dh >= 0 ? "+" : ""}${step.verdict.dh}，不计 ghost）`,
          {
            data: {
              delta: Math.round(step.verdict.delta),
              dw: step.verdict.dw,
              dh: step.verdict.dh,
              scrollTop: Math.round(st),
              lastWrite: recentWrite
                ? `${recentWrite.tag}@${Math.round(now - recentWrite.at)}ms前`
                : null,
            },
          }
        );
        openBlockWindow();
      } else if (step.verdict.type === "clamp") {
        scrollEmit(
          "layout:clamp",
          step.verdict.forced
            ? `贴底钳制 ${step.verdict.delta >= 0 ? "↓" : "↑"}${Math.abs(step.verdict.delta).toFixed(0)}px（内容收缩 ${Math.round(step.verdict.heightDelta)}px，scrollTop 被压回新上限，不计 ghost）`
            : `微位移 ${step.verdict.delta >= 0 ? "↓" : "↑"}${Math.abs(step.verdict.delta).toFixed(1)}px（同帧高度 ${step.verdict.heightDelta >= 0 ? "+" : ""}${Math.round(step.verdict.heightDelta)}px，clamping 型，不计 ghost）`,
          {
            data: {
              delta: Math.round(step.verdict.delta),
              heightDelta: Math.round(step.verdict.heightDelta),
              forced: step.verdict.forced,
              scrollTop: Math.round(st),
              lastWrite: recentWrite
                ? `${recentWrite.tag}@${Math.round(now - recentWrite.at)}ms前`
                : null,
            },
          }
        );
        openBlockWindow();
      } else if (step.verdict.type === "ghost") {
        // 既无用户输入也无已知写入 —— 「页面自己动」的实锤。
        const e: ScrollDebugEvent = {
          ts: Date.now(),
          level: "warn",
          kind: "session:ghost",
          msg: `检测到不明来源滚动 ${st - prevSt >= 0 ? "↓" : "↑"} ${Math.abs(st - prevSt).toFixed(0)}px`,
          data: {
            delta: Math.round(st - prevSt),
            scrollTop: Math.round(st),
            // v3.9.5：定罪上下文——同帧高度变化量（clamping 型位移的标志）
            // 与是否贴底（浏览器 scrollHeight 收缩时的强制回弹）。
            heightDelta: Math.round(h - prevH),
            atBottom: st + host.clientHeight >= h - 2,
            lastWrite: recentWrite
              ? `${recentWrite.tag}@${Math.round(now - recentWrite.at)}ms前`
              : null,
            // v4.3：定罪上下文补充——最近一次视口尺寸变化（窗口外远处则
            // 不带，证明「非 resize 因果窗内」）。
            resize: resizeActive
              ? `viewport:resize@${Math.round(now - lastResize!.at)}ms前`
              : null,
          },
        };
        events.push(e);
        if (events.length > EVENT_CAPACITY) events.shift();
        scrollCount("session.ghost");
        stats.lastGhost = e;
        for (const fn of subscribers) {
          try {
            fn(e);
          } catch {
            subscribers.delete(fn);
          }
        }
        openBlockWindow();
      }

      // --- 视口内容位移（scrollTop 不变而哨兵文档坐标变了）。
      // v3.9.5：连续静止帧确认制——单帧瞬态（重建/预热期间的哨兵毛刺）不
      // 报也不补；确认后的持续位移在 data-big 下由 anchor-comp 全量补偿
      //（内容下移 S → scrollTop += S，视口内容视觉位置不变），补偿写入
      // 打点 write:anchor-comp。
      let shift: number | null = null;
      let shiftTag: string | undefined;
      let shiftCompensated = 0;
      if (!moving && Math.abs(st - prevSt) < 0.5) {
        if (
          !sentinel ||
          !sentinel.el.isConnected ||
          sentinel.el.getBoundingClientRect().width === 0
        ) {
          sentinel = pickSentinel();
          compArmed = null;
        } else {
          const r = sentinel.el.getBoundingClientRect();
          const docTop = r.top + st;
          // 哨兵按构造是视口顶的块（docTop ≈ scrollTop ± 块高）。差出数千
          // px 只可能是失效哨兵（瞬移/重建/空矩形），重选而不比对——否则
          // 会把瞬移量误报成内容位移（实测跳转点击瞬间的 ↓172037px 伪影）。
          if (Math.abs(docTop - st) > 3000) {
            sentinel = pickSentinel();
            compArmed = null;
          } else {
            const s = docTop - sentinel.docTop;
            if (Math.abs(s) > 2) {
              if (
                compArmed &&
                compArmed.el === sentinel.el &&
                Math.abs(docTop - compArmed.docTop) >= SHIFT_CONFIRM_MIN
              ) {
                // 第二帧确认：位移真实且持续 → 报告（+补偿）。
                shift = docTop - compArmed.docTop;
                shiftTag = sentinel.el.tagName;
                const big = host.dataset.big !== undefined;
                // 平滑跳转动画进行中（App 的 smoothJump 标志）绝不补偿：动画
                // 中途写 scrollTop 会掐断 scrollIntoView（longtask 阻断帧造成
                // 的「静止」不算静止）；残余位移等跳转收尾后再确认补偿。
                if (big && host.dataset.smoothJump === undefined) {
                  const comp = Math.max(-ANCHOR_COMP_MAX, Math.min(ANCHOR_COMP_MAX, shift));
                  if (comp !== 0) {
                    noteScrollWrite("anchor-comp");
                    host.scrollTop += comp;
                    shiftCompensated = comp;
                    scrollCount("anchor.comp");
                  }
                }
                compArmed = null;
                // 位移后重选哨兵：块可能已被重建/换位，旧 docTop 不再可比。
                sentinel = pickSentinel();
              } else {
                // 第一帧：只武装不动作——下一静止帧再确认。
                compArmed = { el: sentinel.el, docTop: sentinel.docTop };
              }
            } else {
              sentinel.docTop = docTop;
              compArmed = null;
            }
          }
        }
      } else {
        compArmed = null;
      }

      // --- 文档高度突变（c-v 高度重估 / 图片加载 / 大改写）；与同帧位移合并。
      // 用户刚改过布局（点击/快捷键/拖拽中，500ms 内）或视口刚发生尺寸变化
      // （v4.3：侧栏开合/最大化还原等，窗口外无点击也能命中）：随后的重排
      // 位移/高度变化是预期结果——照常记录（日志/面板可见），但降为 info
      // 不弹告警卡（userInitiated / cause=resize 标记供分析器兜底，防 emit
      // 侧规则漂移）。
      const userInitiated =
        pointerHeld || now - userIntentAt < LAYOUT_INTENT_WINDOW_MS;
      const resizeCaused = resizeActive;
      const hDelta = h - prevH;
      const heightHit = Math.abs(hDelta) > 8;
      if (shift != null && heightHit) {
        // 位移的原因大概率就是同帧的高度变化：合并为一条，双计数器保持口径。
        scrollEmit(
          "layout:shift",
          `视口内容位移 ${shift >= 0 ? "↓" : "↑"} ${Math.abs(shift).toFixed(0)}px（scrollTop 未变）· 同帧文档高度 ${prevH} → ${h}（${hDelta >= 0 ? "+" : ""}${Math.round(hDelta)}px）${shiftCompensated ? ` · 已补偿 ${Math.round(shiftCompensated)}px` : ""}`,
          {
            level:
              Math.abs(shift) > 24 && !userInitiated && !resizeCaused
                ? "warn"
                : "info",
            data: {
              delta: Math.round(shift),
              heightDelta: Math.round(hDelta),
              scrollTop: Math.round(st),
              height: Math.round(h),
              tag: shiftTag,
              session: sessionTag,
              compensated: shiftCompensated || undefined,
              userInitiated: userInitiated || undefined,
              cause: resizeCaused ? "resize" : undefined,
            },
          }
        );
        scrollCount("layout:height");
        openBlockWindow();
      } else {
        if (heightHit) {
          scrollEmit(
            "layout:height",
            `文档高度 ${prevH} → ${h}（${hDelta >= 0 ? "+" : ""}${Math.round(hDelta)}px）`,
            {
              level: "info",
              data: {
                delta: Math.round(hDelta),
                scrollTop: Math.round(st),
                session: sessionTag,
                userInitiated: userInitiated || undefined,
                cause: resizeCaused ? "resize" : undefined,
              },
            }
          );
          openBlockWindow();
        }
        if (shift != null) {
          scrollEmit(
            "layout:shift",
            `视口内容位移 ${shift >= 0 ? "↓" : "↑"} ${Math.abs(shift).toFixed(0)}px（scrollTop 未变）${shiftCompensated ? ` · 已补偿 ${Math.round(shiftCompensated)}px` : ""}`,
            {
              level:
                Math.abs(shift) > 24 && !userInitiated && !resizeCaused
                  ? "warn"
                  : "info",
              data: {
                delta: Math.round(shift),
                scrollTop: Math.round(st),
                height: Math.round(h),
                tag: shiftTag,
                compensated: shiftCompensated || undefined,
                userInitiated: userInitiated || undefined,
                cause: resizeCaused ? "resize" : undefined,
              },
            }
          );
          openBlockWindow();
        }
      }

      walkBlocks(now);

      prevSt = st;
      prevH = h;
    } catch {
      /* 诊断永不抛错 */
    }
  };
  raf = requestAnimationFrame(tick);

  // 长任务（主线程阻塞 >50ms）：滚动卡顿的直接证据；区间同步登记进
  // longtaskLog，供写入归因窗扣除被阻塞时长（P2-5）。
  let po: PerformanceObserver | null = null;
  try {
    po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        noteLongtaskSpan(entry.startTime, entry.duration);
        scrollEmit("perf:longtask", `主线程阻塞 ${Math.round(entry.duration)}ms`, {
          level: entry.duration > 150 ? "warn" : "info",
          data: { duration: Math.round(entry.duration), name: entry.name },
        });
      }
    });
    po.observe({ entryTypes: ["longtask"] });
  } catch {
    /* 环境不支持 longtask 则跳过 */
  }

  scrollEmit("watch:attach", "滚动观察器已挂载", {
    data: {
      seq,
      scrollTop: Math.round(host.scrollTop),
      scrollHeight: Math.round(host.scrollHeight),
    },
  });

  return () => {
    disposed = true;
    stats.watching = false;
    blockBase = null;
    cancelAnimationFrame(raf);
    pmObs?.disconnect();
    pmObs = null;
    pmObsRoot = null;
    widthObs?.disconnect();
    widthObs = null;
    widthObsRoot = null;
    sizeObs?.disconnect();
    sizeObs = null;
    attrObs?.disconnect();
    attrObs = null;
    try {
      document.fonts.removeEventListener("loadingdone", onFontsDone);
    } catch {
      /* never throw */
    }
    host.removeEventListener("wheel", onUserIntent, { capture: true });
    host.removeEventListener("touchstart", onUserIntent, { capture: true });
    window.removeEventListener("pointerdown", onPointerDown, { capture: true });
    window.removeEventListener("pointermove", onPointerMove, { capture: true });
    window.removeEventListener("pointerup", onPointerUp, { capture: true });
    window.removeEventListener("pointercancel", onPointerUp, { capture: true });
    window.removeEventListener("keydown", onKey, true);
    po?.disconnect();
  };
}

/** 控制台出口：window.__scrollDebug（attachScrollDebugGlobal() 注册）。 */
export function attachScrollDebugGlobal(): void {
  try {
    (window as unknown as Record<string, unknown>).__scrollDebug = {
      events: scrollEvents,
      counters: scrollCounters,
      clear: scrollDebugClear,
      recent: lastScrollWrite,
      stats: scrollWatchStats,
      frameStats: scrollFrameStats,
    };
  } catch {
    /* never throw */
  }
}
