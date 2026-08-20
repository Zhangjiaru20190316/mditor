// 滚动诊断体系（v3.9.4）——「页面自己动 / 滚动卡顿」的运行时证据采集。
//
// 背景：滚动异常已多轮修复仍复发（打字机让位、overflow-anchor、图片懒加
// 载、盖章战争……），但始终缺少运行时证据来区分到底是哪条链路在动滚动
// 位置。本模块把滚动相关的关键事实收进环形缓冲 + 计数器：
//
//  1. 滚动会话归因（session:*）：每次「滚动从静止开始动」判定发起者——
//     用户输入（wheel/触摸/滚动键/滚动条拖拽）200ms 内 → user；
//     已知程序写入（noteScrollWrite 打点）250ms 内 → write:<tag>；
//     两者都不是 → ghost（「页面自己动」实锤，附最近一次写入 tag 供排查）。
//     惯性滚动天然归属其发起会话（会话期间持续位移不重判）。
//  2. 视口内容位移（layout:shift）：scrollTop 没变、但视口顶部哨兵块的
//     文档坐标变了 → 内容在自己动（content-visibility 高度重估 / 图片加载
//     / 盖章行内化 / PM 重排），这是 scrollTop 写入检测抓不到的另一半
//     「自己动」。哨兵用二分选取，失效自动重选。
//  3. 文档高度突变（layout:height）：scrollHeight 变化 >8px——c-v 块首次
//     进入视口时 3em 占位 → 实际高度的跳变证据。
//  4. 长任务（perf:longtask）：主线程阻塞 >50ms（滚动卡顿的直接证据）。
//
// 接入：Editor.tsx 挂载 attachScrollWatch(滚动容器)——富文本/IR 模式是根
// div .mditor-editor-host（真正 overflow:auto 的那层）；sv 模式它不滚
// （.cm-scroller 内部滚，哨兵也绑 ProseMirror），观察器自然休眠，sv 不在
// 覆盖范围。所有写 scrollTop / scrollIntoView 的路径先 noteScrollWrite("<tag>") 打点。
// 出口：window.__scrollDebug = { events, counters, clear, recent }。
//
// 纪律：诊断代码绝不能影响编辑器——所有公开入口 try/catch，每帧成本为
// 常数次属性读取（亚毫秒级）。

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
 *  pointerdown（滚动条拖拽起点无法区分目标，全部计入）。 */
const USER_INPUT_KEYS = new Set([
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  " ",
]);

export interface ScrollWatchStats {
  /** 最近一次 ghost 的摘要（面板展示 / 排查入口）。 */
  lastGhost: ScrollDebugEvent | null;
  /** 观察器是否在跑。 */
  watching: boolean;
}

const stats: ScrollWatchStats = { lastGhost: null, watching: false };

export function scrollWatchStats(): ScrollWatchStats {
  return stats;
}

/**
 * 在主编辑滚动容器上挂观察器（Editor 挂载时调用一次，返回卸载函数）。
 * rAF 每帧：读 scrollTop / scrollHeight / 哨兵 rect（均为布局缓存读取，
 * 不主动触发强制布局），做会话归因与位移检测。
 */
export function attachScrollWatch(host: HTMLElement): () => void {
  if (stats.watching) return () => undefined;
  stats.watching = true;

  let userIntentAt = 0;
  let prevSt = host.scrollTop;
  let prevH = host.scrollHeight;
  let prevMoving = false;
  // 会话归因（延续期间不重判，惯性自动归属发起者）。
  let sessionTag: string | null = null;
  // 哨兵：视口顶部的 ProseMirror 顶层块（element + 上帧文档坐标 top）。
  let sentinel: { el: Element; docTop: number } | null = null;
  let raf = 0;
  let disposed = false;

  const onUserIntent = () => {
    userIntentAt = performance.now();
  };
  const onKey = (e: KeyboardEvent) => {
    if (USER_INPUT_KEYS.has(e.key)) userIntentAt = performance.now();
  };

  host.addEventListener("wheel", onUserIntent, { passive: true, capture: true });
  host.addEventListener("touchstart", onUserIntent, { passive: true, capture: true });
  host.addEventListener("pointerdown", onUserIntent, { passive: true, capture: true });
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

      // --- 滚动会话归因：从静止转动的第一帧判定发起者。
      if (moving && !prevMoving) {
        if (now - userIntentAt < 200) {
          sessionTag = "user";
          scrollCount("session.user");
        } else if (recentWrite && now - recentWrite.at < 250) {
          sessionTag = `write:${recentWrite.tag}`;
          scrollCount(`session.write.${recentWrite.tag}`);
        } else {
          // 既无用户输入也无已知写入 —— 「页面自己动」的实锤。
          sessionTag = "ghost";
          const e: ScrollDebugEvent = {
            ts: Date.now(),
            level: "warn",
            kind: "session:ghost",
            msg: `检测到不明来源滚动 ${st - prevSt >= 0 ? "↓" : "↑"} ${Math.abs(st - prevSt).toFixed(0)}px`,
            data: {
              delta: Math.round(st - prevSt),
              scrollTop: Math.round(st),
              lastWrite: recentWrite
                ? `${recentWrite.tag}@${Math.round(now - recentWrite.at)}ms前`
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
        }
      }
      if (!moving) sessionTag = null;

      // --- 文档高度突变（c-v 高度重估 / 图片加载 / 大改写）。
      if (Math.abs(h - prevH) > 8) {
        scrollEmit("layout:height", `文档高度 ${prevH} → ${h}（${h - prevH >= 0 ? "+" : ""}${Math.round(h - prevH)}px）`, {
          level: "info",
          data: {
            delta: Math.round(h - prevH),
            scrollTop: Math.round(st),
            session: sessionTag,
          },
        });
      }

      // --- 视口内容位移（scrollTop 不变而哨兵文档坐标变了）。
      if (!moving && Math.abs(st - prevSt) < 0.5) {
        if (
          !sentinel ||
          !sentinel.el.isConnected ||
          sentinel.el.getBoundingClientRect().width === 0
        ) {
          sentinel = pickSentinel();
        } else {
          const r = sentinel.el.getBoundingClientRect();
          const docTop = r.top + st;
          const shift = docTop - sentinel.docTop;
          if (Math.abs(shift) > 2) {
            scrollEmit(
              "layout:shift",
              `视口内容位移 ${shift >= 0 ? "↓" : "↑"} ${Math.abs(shift).toFixed(0)}px（scrollTop 未变）`,
              {
                level: Math.abs(shift) > 24 ? "warn" : "info",
                data: {
                  delta: Math.round(shift),
                  scrollTop: Math.round(st),
                  height: Math.round(h),
                  tag: sentinel.el.tagName,
                },
              }
            );
            // 位移后重选哨兵：块可能已被重建/换位，旧 docTop 不再可比。
            sentinel = pickSentinel();
          } else {
            sentinel.docTop = docTop;
          }
        }
      }

      prevSt = st;
      prevH = h;
      prevMoving = moving;
    } catch {
      /* 诊断永不抛错 */
    }
  };
  raf = requestAnimationFrame(tick);

  // 长任务（主线程阻塞 >50ms）：滚动卡顿的直接证据。
  let po: PerformanceObserver | null = null;
  try {
    po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
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
    data: { scrollTop: Math.round(host.scrollTop), scrollHeight: host.scrollHeight },
  });

  return () => {
    disposed = true;
    stats.watching = false;
    cancelAnimationFrame(raf);
    host.removeEventListener("wheel", onUserIntent, { capture: true });
    host.removeEventListener("touchstart", onUserIntent, { capture: true });
    host.removeEventListener("pointerdown", onUserIntent, { capture: true });
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
    };
  } catch {
    /* never throw */
  }
}
