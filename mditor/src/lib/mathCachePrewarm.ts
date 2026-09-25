// 空闲时后台预计算整篇行内公式进 katexCache（滚动冷路径的另一半消灭）。
//
// 背景：katexCache + 渲染泵已让「回滚命中」零闪烁，但「第一次滚到的公式」
// 仍是冷缓存——滚动帧 5ms 预算冷算 KaTeX 只够画少数几条，用户先见源码占位
// 后见公式。本模块在文档载入后的空闲窗口把整篇 math_inline 源码逐条算进
// katexCache（纯算 HTML 字符串，不碰 DOM）：之后滚动帧的视口内与方向带内
// 条目全走命中直绘，冷路径在用户滚到之前已被消灭。1MB 压测副本 katex≈1.6
// 万条纯算约 2-4s，idle 分批实际 10-30s 跑完——跑不完也无妨（渐进命中即
// 可），绝不为跑完而抢占交互。
//
// 机制（对齐 cvMemory 预热的让路纪律）：
//  * 收集：view.state.doc.descendants 全篇 math_inline 的 attrs.value，Set
//    去重保序（短公式如 \alpha 全篇重复率高，同一源码只算一次）；已在缓
//    存的（peekCached 命中）直接跳过，只算冷条目。唯一冷公式数超过
//    katexCache 条数上限余量时按文档序截断——超量全跑会把最早算入的顶部
//    条目从 LRU 最旧端挤出，跑完全量后最先滚到的区域反而回冷。
//  * 执行：requestIdleCallback 分批，批内时间预算 ~8ms（对齐 cvMemory 的
//    PREWARM_MEASURE_BUDGET_MS），批间让出（idle timeout 200ms 兜底推进，
//    缺席环境退 16ms 定时器）。
//  * 让路：最近用户输入（wheel/touchmove/keydown）500ms 窗口内不派发批次，
//    只重排 idle。输入时间戳单一来源：lazyInlineMath 的 msSinceUserInput
//    （读其 lastUserInputAt）——本模块不得另挂一份监听。
//  * 中止与门控：代际令牌 gen——每次调用自增，新一次预热（换文档后重调）
//    自然顶替旧循环，旧循环在批边界检测 gen 变化即静默退出；view.isDestroyed
//    或 lazyEnabled 关闭（非 cv 档）同样退出。每批至少算一条，防时钟粒度
//    粗于预算时死循环空转。
//  * 范围：仅行内公式。块级公式不在此列——其挂载成本主要在 CodeMirror+Vue
//    实例，KaTeX 只占小头，收益不配改动面。

import type { EditorView } from "@milkdown/prose/view";
import { katexCacheRemainingEntries, peekCached, renderToStringCached } from "./katexCache";
import { lazyInlineMathEnabled, msSinceUserInput } from "./lazyInlineMath";

/** 批内时间预算（ms）：对齐 cvMemory 的 PREWARM_MEASURE_BUDGET_MS。 */
const PREWARM_BATCH_BUDGET_MS = 8;
/** 批间让出的 idle 超时（ms）：空闲优先，超时兜底保推进（cvMemory 同款）。 */
const PREWARM_IDLE_TIMEOUT_MS = 200;
/** 用户输入让路窗口（ms）：窗口内不派发批次，只重排 idle。 */
const PREWARM_USER_YIELD_MS = 500;

/** 预热代际令牌：新一次预热（新文档/新实例）取代旧循环，旧循环静默退出。
 *  每次调用（含各早退分支）都自增——早退也顶替旧循环，不留僵尸批次。 */
let prewarmGen = 0;

/** 批间让出：空闲优先（不与输入/渲染抢主线程），超时兜底保推进。 */
const scheduleIdle = (fn: () => void): void => {
  try {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(fn, { timeout: PREWARM_IDLE_TIMEOUT_MS });
      return;
    }
  } catch {
    /* 环境异常退回定时器 */
  }
  window.setTimeout(fn, 16);
};

/** 让路判定（纯函数供单测）：距最近用户输入的毫数在窗口内 → true（本批
 *  不派发，重排 idle）。从未有过输入（Infinity）恒不让路。 */
export function mathPrewarmShouldYield(msSinceInput: number): boolean {
  return msSinceInput >= 0 && msSinceInput < PREWARM_USER_YIELD_MS;
}

/** 仅供测试：最近一次预热收集到的冷源码队列快照（验证源码去重与已缓存
 *  跳过——两者的运行期行为与「命中缓存不再算」不可区分，须从收集产物观测）。 */
let lastQueue: string[] = [];

export function __getMathPrewarmQueueForTest(): string[] {
  return [...lastQueue];
}

/**
 * 空闲分批把整篇行内公式算进 katexCache（尽力而为：任何失败静默，滚动帧
 * 渲染与静止补渲染自然兜底）。仅 cv 档（lazyInlineMathEnabled）有意义——
 * 默认档行内公式本就急切渲染，缓存由正常渲染路径自然填充。
 */
export function startMathCachePrewarm(view: EditorView): void {
  // 先顶替再门控：早退分支同样消耗旧循环的代际令牌。
  const gen = ++prewarmGen;
  lastQueue = [];
  try {
    if (!lazyInlineMathEnabled()) return;
    if (view.isDestroyed) return;
    // 收集：全篇 math_inline 源码，Set 去重保序，跳过已缓存条目。
    const seen = new Set<string>();
    const cold: string[] = [];
    view.state.doc.descendants((node) => {
      if (node.type.name !== "math_inline") return true;
      const src = node.attrs.value;
      if (typeof src !== "string" || seen.has(src)) return false;
      seen.add(src);
      if (peekCached(src, false) === undefined) cold.push(src);
      return false;
    });
    if (!cold.length) return;
    // LRU 容量界：唯一冷公式数超过条数上限余量即按文档序截断（头部/视口
    // 热区天然优先）。超量全跑只会把最早算入的顶部条目从最旧逐条挤出
    // （8192 条上限），跑完全量后用户最先滚到的区域反而回到冷路径——白烧
    // 空闲 CPU。
    const room = katexCacheRemainingEntries();
    if (room <= 0) return;
    if (cold.length > room) cold.length = room;
    lastQueue = cold;
    let i = 0;
    const step = (): void => {
      if (gen !== prewarmGen) return; // 新预热顶替：批边界静默退出
      if (view.isDestroyed) return;
      if (!lazyInlineMathEnabled()) return;
      if (mathPrewarmShouldYield(msSinceUserInput())) {
        scheduleIdle(step); // 用户输入窗口内让路：不派发批次
        return;
      }
      const t0 = performance.now();
      while (i < cold.length) {
        const src = cold[i++];
        try {
          renderToStringCached(src, false); // 纯算 HTML 进缓存，不碰 DOM
        } catch {
          /* KaTeX 失败：跳过该条（失败结果照常不落缓存） */
        }
        if (performance.now() - t0 >= PREWARM_BATCH_BUDGET_MS) break;
      }
      if (i < cold.length) scheduleIdle(step);
    };
    scheduleIdle(step);
  } catch {
    /* 预热是尽力而为：失败静默 */
  }
}
