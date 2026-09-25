// @vitest-environment jsdom
// 空闲公式缓存预热（lib/mathCachePrewarm.ts）：idle 分批推进（批内 8ms 预算）、
// 代际令牌顶替中止、用户输入 500ms 窗口让路、源码去重、已缓存跳过、
// LRU 容量界（余量截断/缓存已满不干活）、非 cv 档不干活、view 已销毁即退出。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorView } from "@milkdown/prose/view";
import {
  __getMathPrewarmQueueForTest,
  mathPrewarmShouldYield,
  startMathCachePrewarm,
} from "./mathCachePrewarm";
import { __setKatexCacheCapsForTests, peekCached, renderToStringCached } from "./katexCache";
import {
  __resetRenderPumpForTest,
  msSinceUserInput,
  setLazyInlineMathEnabled,
} from "./lazyInlineMath";

// ---- idle stub：手动逐批驱动预热循环 ----------------------------------------
let idleCbs: (() => void)[] = [];

beforeEach(() => {
  idleCbs = [];
  (globalThis as unknown as Record<string, unknown>).requestIdleCallback = (
    cb: () => void
  ) => {
    idleCbs.push(cb);
    return idleCbs.length;
  };
});

/** 排空 n 轮 idle 回调（step 在轮末可能再排程，先取当前批再执行）。 */
function flushIdles(rounds = 1): void {
  for (let r = 0; r < rounds; r++) {
    const batch = idleCbs;
    idleCbs = [];
    for (const cb of batch) cb();
  }
}

// ---- 时间源：假 performance.now（冻结 / 逐调用递增）------------------------
let fakeNow = 0;
let tick = 0;
let stepMs = 0;

/** 冻结时钟：让路判定只看 fakeNow，批内预算恒不超。重置泵共享态——
 *  lastUserInputAt 是跨用例存留的模块级状态，不重置会让前序用例派发的
 *  wheel 把本用例永远判进让路窗口。 */
function useFrozenClock(): void {
  fakeNow = 0;
  tick = 0;
  stepMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => fakeNow);
  __resetRenderPumpForTest();
}

/** 逐调用递增时钟：每次 performance.now() 前进 stepMs——批内预算约束可被
 *  确定性观测（6ms 步长下「首条必算 + 检查即断批」每批恰 2 条）。 */
function useTickingClock(step: number): void {
  fakeNow = 0;
  tick = 0;
  stepMs = step;
  vi.spyOn(performance, "now").mockImplementation(() => fakeNow + tick++ * stepMs);
  __resetRenderPumpForTest();
}

function advance(ms: number): void {
  fakeNow += ms;
}

// ---- 假文档 / 假视图 --------------------------------------------------------
interface FakeDocNode {
  type: { name: string };
  attrs: { value?: unknown };
}

const math = (value: string): FakeDocNode => ({
  type: { name: "math_inline" },
  attrs: { value },
});
const para = (): FakeDocNode => ({ type: { name: "paragraph" }, attrs: {} });

function fakeView(nodes: FakeDocNode[], destroyed = false): EditorView {
  const doc = {
    descendants(cb: (n: FakeDocNode) => boolean): void {
      for (const n of nodes) cb(n);
    },
  };
  return { state: { doc }, isDestroyed: destroyed } as unknown as EditorView;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as Record<string, unknown>).requestIdleCallback;
  setLazyInlineMathEnabled(false);
  __setKatexCacheCapsForTests(8192, 8 * 1024 * 1024)(); // 清缓存并恢复默认上限
});

describe("mathCachePrewarm：空闲公式缓存预热", () => {
  it("让路判定纯函数：窗口内让路，边界与从未输入（Infinity）不让", () => {
    expect(mathPrewarmShouldYield(0)).toBe(true);
    expect(mathPrewarmShouldYield(499)).toBe(true);
    expect(mathPrewarmShouldYield(500)).toBe(false);
    expect(mathPrewarmShouldYield(Infinity)).toBe(false); // 从未有过用户输入
    expect(mathPrewarmShouldYield(-1)).toBe(false); // 时钟回退防御
  });

  it("idle 分批推进：批内 8ms 预算逐条冷算，批间让出直至跑完", () => {
    useTickingClock(6); // 每次 now() +6ms：首条必算后检查即断批 → 每批恰 2 条
    setLazyInlineMathEnabled(true);
    const view = fakeView([math("p1"), math("p2"), math("p3"), math("p4"), math("p5")]);
    startMathCachePrewarm(view);
    expect(idleCbs.length).toBe(1); // 已排程首批，未派发
    flushIdles(1); // 批 1：p1、p2
    expect(peekCached("p1", false)).toContain("katex");
    expect(peekCached("p2", false)).toContain("katex");
    expect(peekCached("p3", false)).toBeUndefined();
    flushIdles(1); // 批 2：p3、p4
    expect(peekCached("p3", false)).toContain("katex");
    expect(peekCached("p4", false)).toContain("katex");
    expect(peekCached("p5", false)).toBeUndefined();
    flushIdles(1); // 批 3：p5 收尾（不再排程）
    expect(peekCached("p5", false)).toContain("katex");
    expect(idleCbs.length).toBe(0);
  });

  it("代际令牌顶替：新预热启动后旧循环在批边界静默退出，旧剩余条目不再入缓存", () => {
    useTickingClock(6);
    setLazyInlineMathEnabled(true);
    const view1 = fakeView([math("g1"), math("g2"), math("g3"), math("g4")]);
    startMathCachePrewarm(view1);
    flushIdles(1); // 批 1：g1、g2
    expect(peekCached("g1", false)).toBeTruthy();
    expect(peekCached("g2", false)).toBeTruthy();
    // 换文档重调：gen 自增顶替，旧 step（已重排）与新 step 同批执行
    const view2 = fakeView([math("h1")]);
    startMathCachePrewarm(view2);
    flushIdles(3);
    expect(peekCached("h1", false)).toBeTruthy(); // 新循环照常推进
    expect(peekCached("g3", false)).toBeUndefined(); // 旧循环剩余条目永不入缓存
    expect(peekCached("g4", false)).toBeUndefined();
  });

  it("用户输入让路：最近输入 500ms 窗口内不派发批次只重排 idle，窗口过后恢复", () => {
    useFrozenClock();
    setLazyInlineMathEnabled(true);
    expect(msSinceUserInput()).toBe(Infinity); // 首次调用挂输入监听（单一来源）
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 })); // lastUserInputAt = 0
    const view = fakeView([math("y1")]);
    startMathCachePrewarm(view);
    flushIdles(3); // 全部让路（0ms < 500ms 窗口）：只重排不派发
    expect(peekCached("y1", false)).toBeUndefined();
    expect(idleCbs.length).toBe(1); // 仍有一轮待办（让路重排）
    advance(600); // 输入窗口过去
    flushIdles(1);
    expect(peekCached("y1", false)).toContain("katex");
  });

  it("收集：源码 Set 去重保序、非公式节点跳过、已缓存条目不进队列", () => {
    useFrozenClock();
    setLazyInlineMathEnabled(true);
    renderToStringCached("warm_x", false); // 预置缓存：收集时应跳过
    const view = fakeView([
      math("\\alpha"),
      para(),
      math("\\beta"),
      math("\\alpha"), // 重复源码：全篇只算一次
      math("warm_x"), // 已缓存：跳过
    ]);
    startMathCachePrewarm(view);
    expect(__getMathPrewarmQueueForTest()).toEqual(["\\alpha", "\\beta"]);
  });

  it("LRU 容量界：冷条数截断到条数上限余量（文档序头部优先），截断尾不入缓存", () => {
    useFrozenClock();
    setLazyInlineMathEnabled(true);
    const restore = __setKatexCacheCapsForTests(4, 8 * 1024 * 1024); // 条数上限 4
    renderToStringCached("pre_1", false); // 已占 1 条 → 余量 3
    const view = fakeView([math("q1"), math("q2"), math("q3"), math("q4"), math("q5"), math("q6")]);
    startMathCachePrewarm(view);
    expect(__getMathPrewarmQueueForTest()).toEqual(["q1", "q2", "q3"]); // 文档序截断
    flushIdles(4);
    expect(peekCached("q3", false)).toBeTruthy();
    expect(peekCached("q4", false)).toBeUndefined(); // 截断尾不烧空闲 CPU
    restore();
  });

  it("LRU 容量界：缓存已满（余量 0）时不收集不排程", () => {
    useFrozenClock();
    setLazyInlineMathEnabled(true);
    const restore = __setKatexCacheCapsForTests(1, 8 * 1024 * 1024);
    renderToStringCached("full_1", false); // 唯一容量已占
    const view = fakeView([math("z1"), math("z2")]);
    startMathCachePrewarm(view);
    expect(__getMathPrewarmQueueForTest()).toEqual([]);
    expect(idleCbs.length).toBe(0);
    restore();
  });

  it("非 cv 档（lazyEnabled=false）不干活：不收集不排程不入缓存", () => {
    useFrozenClock();
    setLazyInlineMathEnabled(false);
    const view = fakeView([math("n1"), math("n2")]);
    startMathCachePrewarm(view);
    expect(__getMathPrewarmQueueForTest()).toEqual([]);
    expect(idleCbs.length).toBe(0);
    flushIdles(2);
    expect(peekCached("n1", false)).toBeUndefined();
    expect(peekCached("n2", false)).toBeUndefined();
  });

  it("view 已销毁即退出：不收集不排程", () => {
    useFrozenClock();
    setLazyInlineMathEnabled(true);
    const view = fakeView([math("d1")], true);
    startMathCachePrewarm(view);
    expect(idleCbs.length).toBe(0);
    flushIdles(2);
    expect(peekCached("d1", false)).toBeUndefined();
  });
});
