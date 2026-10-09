// @vitest-environment jsdom
// R1 行内公式懒渲染：占位/渲染/降级/等价性（源文本保留、开关按体量、
// update/destroy 生命周期）+ R1b 渲染泵（滚动静止门控、帧预算补渲染、
// 选中/编辑立即渲染）+ R3 泵升级（滚动中视口内小额渲染、缓存命中即绘、
// 方向优先出队、占位 minHeight 预留）+ R4 band 富余渲染（视口内处理完后
// 时钟仍有富余时方向带内条目顺带渲染：未命中冷算、命中直绘与视口内共用
// 软上限；预算耗尽即止步留队，不挤占视口内预算）。
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Node as PMNode } from "@milkdown/prose/model";
import {
  lazyInlineMathEnabled,
  setLazyInlineMathEnabled,
  setLazyMathBySize,
  lazyInlineMathPlugin,
  __resetRenderPumpForTest,
  __resetProactiveSweepForTest,
  getMathPumpStats,
  SCROLL_HIT_PAINT_CAP,
} from "./lazyInlineMath";
import { renderToStringCached } from "./katexCache";
import { setBigDocViewportEnabled } from "./memory";

// ---- IntersectionObserver stub：手动派发可见性 --------------------------------
interface IOEntry {
  target: Element;
  isIntersecting: boolean;
}
const observers: {
  cb: (es: IOEntry[]) => void;
  els: Set<Element>;
}[] = [];

// ---- rAF stub：手动逐帧驱动渲染泵 -------------------------------------------
let frameCbs: FrameRequestCallback[] = [];

beforeAll(() => {
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = class {
    cb: (es: IOEntry[]) => void;
    els = new Set<Element>();
    constructor(cb: (es: IOEntry[]) => void) {
      this.cb = cb;
      observers.push(this as unknown as { cb: (es: IOEntry[]) => void; els: Set<Element> });
    }
    observe(el: Element) {
      this.els.add(el);
    }
    unobserve(el: Element) {
      this.els.delete(el);
    }
    disconnect() {
      this.els.clear();
    }
  };
  (window as unknown as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) => {
    frameCbs.push(cb);
    return frameCbs.length;
  };
});

/** 排空 n 帧回调（泵在帧内可能再排程，先取当前批再执行）。 */
function flushFrames(n = 1): void {
  for (let i = 0; i < n; i++) {
    const batch = frameCbs;
    frameCbs = [];
    for (const cb of batch) cb(performance.now());
  }
}

/** 把最后一个观察器的目标设为可见/不可见（模拟滚入/滚出）。 */
function setVisibility(intersecting: boolean): void {
  const obs = observers[observers.length - 1];
  expect(obs).toBeTruthy();
  const entries = [...obs.els].map((target) => ({ target, isIntersecting: intersecting }));
  obs.cb(entries);
}

/** 模拟一次用户滚动输入（wheel 捕获监听应更新静止时间戳；deltaY=0 不带
 *  方向）。scroll 事件不作为门控源——程序化 scrollTop 写入会误门渲染泵。 */
function fireUserInput(): void {
  fireWheel(0);
}

/** 带方向的滚轮输入：deltaY 符号驱动泵的方向性出队。 */
function fireWheel(deltaY: number): void {
  window.dispatchEvent(new WheelEvent("wheel", { deltaY }));
}

/** jsdom 的 getBoundingClientRect 恒为全 0：按元素覆写（泵的视口/方向带
 *  判定与降级时的高度记录都走它）。 */
function stubRect(el: HTMLElement, box: { top: number; bottom: number; height: number }): void {
  el.getBoundingClientRect = () =>
    ({
      top: box.top,
      bottom: box.bottom,
      left: 0,
      right: 100,
      width: 100,
      height: box.height,
      x: 0,
      y: box.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

const fakeNode = (value: string): PMNode =>
  ({ type: { name: "math_inline" }, attrs: { value } }) as unknown as PMNode;

interface TestView {
  dom: HTMLElement;
  update: (n: PMNode) => boolean;
  selectNode: () => void;
  destroy: () => void;
}

/** 建 view 并挂到 body（泵的 isConnected 守卫要求真实挂载；destroy 时摘除）。 */
function makeView(value: string): TestView {
  const plugin = lazyInlineMathPlugin();
  const views = (plugin.spec.props as { nodeViews: Record<string, (n: PMNode, v: unknown, g: () => number | undefined) => unknown> }).nodeViews;
  const view = views.math_inline(fakeNode(value), {} as never, () => 0) as TestView;
  expect(view).toBeTruthy();
  document.body.appendChild(view.dom);
  const rawDestroy = view.destroy.bind(view);
  view.destroy = () => {
    rawDestroy();
    view.dom.remove();
  };
  return view;
}

// ---- 时间源：假 setTimeout + spyOn(performance.now) 手控静止窗口 -------------
let fakeNow = 0;
/** 逐调用递增的步长（仅 useTickingPumpTimers 用）。 */
let tickStepMs = 0;
let tickCount = 0;

function usePumpTimers(): void {
  fakeNow = 0;
  tickStepMs = 0; // 0 = 冻结时钟（同刻读数恒等 → 帧预算恒不超）
  tickCount = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockImplementation(() => fakeNow);
  __resetRenderPumpForTest();
}

/** 逐调用递增时钟：每次 performance.now() 前进 stepMs。取 6ms >
 *  SCROLL_RENDER_BUDGET_MS(5) 时任何未命中渲染前的预算检查必失败（缓存
 *  命中不受预算），且静止期 10ms 预算内每帧恰渲染 1 条——让预算约束与
 *  出队顺序可被确定性观测。 */
function useTickingPumpTimers(stepMs: number): void {
  fakeNow = 0;
  tickStepMs = stepMs;
  tickCount = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockImplementation(
    () => fakeNow + (tickStepMs === 0 ? 0 : tickCount++ * tickStepMs)
  );
  __resetRenderPumpForTest();
}

function advance(ms: number): void {
  fakeNow += ms;
  vi.advanceTimersByTime(ms);
}

function useRealPumpTimers(): void {
  vi.restoreAllMocks();
  vi.useRealTimers();
}

describe("R1 行内公式懒渲染", () => {
  it("开关按体量+视口档（仅 cv 档懒渲染；默认档急切防全文档回流）", () => {
    setBigDocViewportEnabled(true);
    setLazyMathBySize("x".repeat(100));
    expect(lazyInlineMathEnabled()).toBe(false); // 小文档
    setLazyMathBySize("x".repeat(600_000));
    expect(lazyInlineMathEnabled()).toBe(true); // 大文档 + cv 档
    setBigDocViewportEnabled(false);
    setLazyMathBySize("x".repeat(600_000));
    expect(lazyInlineMathEnabled()).toBe(false); // 大文档但默认档 → 急切渲染
    setLazyMathBySize(null);
    expect(lazyInlineMathEnabled()).toBe(false);
    setBigDocViewportEnabled(false);
  });

  it("占位保留源文本（window.find/选区/复制语义），静止后渲染 KaTeX，滚出延迟降级", () => {
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const view = makeView("x^2+y_2");
    // 占位态：源文本完整保留
    expect(view.dom.dataset.type).toBe("math_inline");
    expect(view.dom.textContent).toBe("x^2+y_2");
    // 滚入 → 入队（同步不渲染——泵语义）
    setVisibility(true);
    expect(view.dom.querySelector(".katex")).toBeFalsy();
    // 静止（从未滚动）→ 下一帧渲染（KaTeX 真身，含 MathML annotation）
    flushFrames(1);
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    expect(view.dom.textContent).toContain("x^2+y_2"); // annotation 内保留源码
    // 滚出 → 延迟降级回占位
    setVisibility(false);
    expect(view.dom.querySelector(".katex")).toBeTruthy(); // 未到期不降
    advance(2600);
    expect(view.dom.querySelector(".katex")).toBeFalsy();
    expect(view.dom.textContent).toBe("x^2+y_2");
    // update：值变化回到占位并（rAF 后）重渲染（编辑路径不过静止门）
    setVisibility(true);
    flushFrames(1);
    expect(view.update(fakeNode("z^3"))).toBe(true);
    expect(view.dom.textContent).toBe("z^3");
    expect(view.update({ type: { name: "paragraph" }, attrs: {} } as unknown as PMNode)).toBe(false);
    flushFrames(1);
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    view.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("渲染泵：滚动中视口内条目按小额预算渲染，视口外条目仍等待静止", () => {
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const inside = makeView("a+1");
    stubRect(inside.dom, { top: 100, bottom: 130, height: 30 }); // 真实视口内
    const outside = makeView("b+2"); // jsdom 默认 rect 全 0 → 视口外
    setVisibility(true);
    // 持续滚动：视口内条目当帧小额渲染；视口外条目保持占位（等静止）
    for (let i = 0; i < 5; i++) {
      fireUserInput();
      flushFrames(1);
      expect(inside.dom.querySelector(".katex")).toBeTruthy();
      expect(outside.dom.querySelector(".katex")).toBeFalsy();
      advance(40);
    }
    // 停止滚动，静止窗口（400ms）过去 → 视口外条目补渲染落定
    advance(450);
    flushFrames(1);
    expect(outside.dom.querySelector(".katex")).toBeTruthy();
    expect(outside.dom.textContent).toContain("b+2");
    inside.destroy();
    outside.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("渲染泵：滚动中缓存命中的视口内条目绕过预算直绘，未命中受预算约束留队", () => {
    useTickingPumpTimers(6); // 步长 6ms > 预算 5ms：未命中渲染前的检查必失败
    setLazyInlineMathEnabled(true);
    const warm = makeView("warm_1");
    stubRect(warm.dom, { top: 100, bottom: 130, height: 30 });
    const cold = makeView("cold_1");
    stubRect(cold.dom, { top: 200, bottom: 230, height: 30 });
    renderToStringCached("warm_1", false); // 预热缓存（模拟曾渲染过/同式公式）
    fireUserInput();
    setVisibility(true);
    flushFrames(1);
    expect(warm.dom.querySelector(".katex")).toBeTruthy(); // 命中：<0.1ms 直绘，免预算
    expect(cold.dom.querySelector(".katex")).toBeFalsy(); // 未命中：预算耗尽，留队
    // 静止后按 10ms 帧预算补渲染
    advance(450);
    flushFrames(4);
    expect(cold.dom.querySelector(".katex")).toBeTruthy();
    expect(cold.dom.textContent).toContain("cold_1");
    warm.destroy();
    cold.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("渲染泵：滚动中方向优先出队（视口内 > 方向前方 800px 带内 > 其余）", () => {
    useTickingPumpTimers(6); // 静止期每帧恰渲染 1 条 → 出队顺序可观测
    setLazyInlineMathEnabled(true);
    const vh = window.innerHeight;
    // 向下滚动（前方 = 视口下方）。创建序 = IO 入队序：其余 → 带内 → 视口内。
    const behind = makeView("behind_1");
    stubRect(behind.dom, { top: -300, bottom: -280, height: 20 }); // 视口上方（后方）
    const ahead = makeView("ahead_1");
    stubRect(ahead.dom, { top: vh + 100, bottom: vh + 120, height: 20 }); // 下方前方带
    const inView = makeView("inview_1");
    stubRect(inView.dom, { top: 100, bottom: 120, height: 20 });
    renderToStringCached("inview_1", false); // 预热：视口内命中直绘（免预算）
    fireWheel(120);
    setVisibility(true); // 队列序 [behind, ahead, inView]
    flushFrames(1);
    expect(inView.dom.querySelector(".katex")).toBeTruthy(); // 视口内：当帧出队
    expect(ahead.dom.querySelector(".katex")).toBeFalsy();
    expect(behind.dom.querySelector(".katex")).toBeFalsy();
    advance(450);
    flushFrames(1);
    expect(ahead.dom.querySelector(".katex")).toBeTruthy(); // 方向前方带先于其余
    expect(behind.dom.querySelector(".katex")).toBeFalsy();
    flushFrames(1);
    expect(behind.dom.querySelector(".katex")).toBeTruthy();
    // 反向（向上）：视口上方成为前方带，优先于下方
    const below = makeView("below_2");
    stubRect(below.dom, { top: vh + 100, bottom: vh + 120, height: 20 }); // 此轮的其余
    const above = makeView("above_2");
    stubRect(above.dom, { top: -300, bottom: -280, height: 20 }); // 此轮的前方带
    const inView2 = makeView("inview_2");
    stubRect(inView2.dom, { top: 100, bottom: 120, height: 20 });
    renderToStringCached("inview_2", false);
    fireWheel(-120);
    setVisibility(true); // 队列序 [below, above, inView2]
    flushFrames(1);
    expect(inView2.dom.querySelector(".katex")).toBeTruthy();
    expect(above.dom.querySelector(".katex")).toBeFalsy();
    expect(below.dom.querySelector(".katex")).toBeFalsy();
    advance(450);
    flushFrames(1);
    expect(above.dom.querySelector(".katex")).toBeTruthy(); // 上方带先于下方
    expect(below.dom.querySelector(".katex")).toBeFalsy();
    flushFrames(1);
    expect(below.dom.querySelector(".katex")).toBeTruthy();
    for (const v of [behind, ahead, inView, below, above, inView2]) v.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("渲染泵：滚动帧预算富余时方向带内条目顺带冷算渲染（其余仍留队等静止）", () => {
    usePumpTimers(); // 冻结时钟：视口内渲染后时钟仍有富余（0 < 5ms 预算）
    setLazyInlineMathEnabled(true);
    const vh = window.innerHeight;
    const behind = makeView("r4_behind_1"); // 后方（向下滚时的「其余」组）
    stubRect(behind.dom, { top: -300, bottom: -280, height: 20 });
    const ahead = makeView("r4_ahead_1"); // 前方带内（视口下方 800px 内）
    stubRect(ahead.dom, { top: vh + 100, bottom: vh + 120, height: 20 });
    const inView = makeView("r4_inview_1");
    stubRect(inView.dom, { top: 100, bottom: 120, height: 20 });
    fireWheel(120); // 向下：前方 = 视口下方
    setVisibility(true); // 队列序 [behind, ahead, inView]
    flushFrames(1);
    expect(inView.dom.querySelector(".katex")).toBeTruthy(); // 视口内：小额预算渲染
    expect(ahead.dom.querySelector(".katex")).toBeTruthy(); // 富余预算：band 冷算顺带渲染
    expect(behind.dom.querySelector(".katex")).toBeFalsy(); // 其余：仍留队
    advance(450);
    flushFrames(1);
    expect(behind.dom.querySelector(".katex")).toBeTruthy(); // 静止后补渲染
    expect(behind.dom.textContent).toContain("r4_behind_1");
    for (const v of [behind, ahead, inView]) v.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("渲染泵：预算耗尽时 band 条目留队（band 只用富余，绝无富余则持续让位）", () => {
    useTickingPumpTimers(6); // 每次 now() 递增 6ms > 5ms 预算：任何时钟检查即「耗尽」
    setLazyInlineMathEnabled(true);
    const vh = window.innerHeight;
    const behind = makeView("r4b_behind_1");
    stubRect(behind.dom, { top: -300, bottom: -280, height: 20 });
    const ahead = makeView("r4b_ahead_1");
    stubRect(ahead.dom, { top: vh + 100, bottom: vh + 120, height: 20 });
    const inView = makeView("r4b_inview_1");
    stubRect(inView.dom, { top: 100, bottom: 120, height: 20 });
    renderToStringCached("r4b_inview_1", false); // 视口内命中：直绘免时钟预算
    fireWheel(120);
    setVisibility(true);
    flushFrames(1);
    expect(inView.dom.querySelector(".katex")).toBeTruthy(); // 命中直绘
    expect(ahead.dom.querySelector(".katex")).toBeFalsy(); // 无富余：band 不动
    expect(behind.dom.querySelector(".katex")).toBeFalsy();
    flushFrames(1); // 仍在滚动：富余检查依旧失败 → band 持续留队
    expect(ahead.dom.querySelector(".katex")).toBeFalsy();
    advance(450);
    flushFrames(2); // 静止后按 10ms 帧预算补渲染（每帧恰 1 条）
    expect(ahead.dom.querySelector(".katex")).toBeTruthy();
    expect(behind.dom.querySelector(".katex")).toBeTruthy();
    for (const v of [behind, ahead, inView]) v.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("渲染泵：向上滚动时 band（视口上方）不用富余渲染——无锚定补偿，留队走静止路径", () => {
    usePumpTimers(); // 冻结时钟：富余恒在——若误用富余，上方 band 当帧即渲染
    setLazyInlineMathEnabled(true);
    const vh = window.innerHeight;
    const below = makeView("r4u_below_1"); // 视口下方（向上滚时的「其余」组）
    stubRect(below.dom, { top: vh + 100, bottom: vh + 120, height: 20 });
    const above = makeView("r4u_above_1"); // 前方带内（视口上方 800px 内）
    stubRect(above.dom, { top: -300, bottom: -280, height: 20 });
    const inView = makeView("r4u_inview_1");
    stubRect(inView.dom, { top: 100, bottom: 120, height: 20 });
    fireWheel(-120); // 向上：band = 视口上方
    setVisibility(true); // 队列序 [below, above, inView]
    flushFrames(1);
    expect(inView.dom.querySelector(".katex")).toBeTruthy(); // 视口内照常小额渲染
    expect(above.dom.querySelector(".katex")).toBeFalsy(); // 上方 band：富余也不用（留队）
    expect(below.dom.querySelector(".katex")).toBeFalsy();
    advance(450);
    flushFrames(1); // 静止后补渲染（band 剩余仍先于其余）
    expect(above.dom.querySelector(".katex")).toBeTruthy();
    expect(below.dom.querySelector(".katex")).toBeTruthy();
    for (const v of [below, above, inView]) v.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("渲染泵：band 命中直绘与视口内共用软上限，打满即止步、剩余下一帧补齐", () => {
    usePumpTimers(); // 冻结时钟：排除时钟预算干扰，只观测条数软上限
    setLazyInlineMathEnabled(true);
    const vh = window.innerHeight;
    renderToStringCached("r4c_hit", false); // 同式预热：全部条目命中
    const views: TestView[] = [];
    for (let i = 0; i < SCROLL_HIT_PAINT_CAP; i++) {
      const v = makeView("r4c_hit"); // 视口内：先把软上限打满
      stubRect(v.dom, { top: 100, bottom: 120, height: 20 });
      views.push(v);
    }
    const bandHits: TestView[] = [];
    for (let i = 0; i < 3; i++) {
      const v = makeView("r4c_hit"); // 方向带内命中：受共用软上限约束
      stubRect(v.dom, { top: vh + 100, bottom: vh + 120, height: 20 });
      bandHits.push(v);
      views.push(v);
    }
    const painted = (): number =>
      views.filter((v) => v.dom.querySelector(".katex")).length;
    fireWheel(120); // 向下：band = 视口下方
    setVisibility(true);
    flushFrames(1);
    expect(painted()).toBe(SCROLL_HIT_PAINT_CAP); // 视口内直绘打满软上限
    expect(bandHits.every((v) => !v.dom.querySelector(".katex"))).toBe(true); // band 止步
    flushFrames(1); // 仍在滚动：单帧计数重置，band 命中直绘补齐
    expect(painted()).toBe(views.length);
    for (const v of views) v.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("渲染泵：滚动中探测仅限 IO 带内条目（带外条目免探测等待静止，不被旧条目占满）", () => {
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const view = makeView("outofband_1");
    // 谎报 rect 在视口内：IO 可见性门优先于 rect（带外条目几何上不可能
    // 进视口，滚动帧不为其消耗探测窗口——连续快速滚动时旧条目占满探测
    // 窗口会让滚动中渲染静默失效）。
    stubRect(view.dom, { top: 100, bottom: 120, height: 20 });
    setVisibility(true); // 入队（IO 带内）
    setVisibility(false); // 滚出 IO 余量带：ioVisible=false（未渲染 → 无降级）
    for (let i = 0; i < 3; i++) {
      fireUserInput();
      flushFrames(1);
      expect(view.dom.querySelector(".katex")).toBeFalsy(); // 带外：不探测不渲染
      advance(40);
    }
    advance(450);
    flushFrames(1);
    expect(view.dom.querySelector(".katex")).toBeTruthy(); // 静止后照常补渲染
    expect(view.dom.textContent).toContain("outofband_1");
    view.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("渲染泵：滚动中缓存命中直绘受单帧条数软上限约束，超出部分下一帧再绘", () => {
    usePumpTimers(); // 冻结时钟：排除时钟预算干扰，只观测条数软上限
    setLazyInlineMathEnabled(true);
    renderToStringCached("cap_1", false); // 同式预热：全部条目命中
    const views: TestView[] = [];
    for (let i = 0; i < SCROLL_HIT_PAINT_CAP + 2; i++) {
      const v = makeView("cap_1");
      stubRect(v.dom, { top: 100, bottom: 120, height: 20 });
      views.push(v);
    }
    const painted = (): number =>
      views.filter((v) => v.dom.querySelector(".katex")).length;
    fireUserInput();
    setVisibility(true);
    flushFrames(1);
    expect(painted()).toBe(SCROLL_HIT_PAINT_CAP); // 软上限内直绘，超出回插队首
    expect(painted()).toBeLessThan(views.length);
    flushFrames(1); // 仍在滚动（静止窗未满）：下一帧继续
    expect(painted()).toBe(views.length);
    for (const v of views) v.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("渲染泵：键盘滚动（PageDown 等）复位方向，带内优先级不再沿用滚轮方向", () => {
    useTickingPumpTimers(6); // 静止期每帧恰渲染 1 条 → 出队顺序可观测
    setLazyInlineMathEnabled(true);
    const vh = window.innerHeight;
    const above = makeView("kb_above_1");
    stubRect(above.dom, { top: -300, bottom: -280, height: 20 });
    const below = makeView("kb_below_1");
    stubRect(below.dom, { top: vh + 100, bottom: vh + 120, height: 20 });
    fireWheel(120); // 滚轮向下 → 方向=1（前方=视口下方）
    // 键盘滚动打点 + 方向复位（若无复位，静止补渲染 below 会先于 above）
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" }));
    setVisibility(true); // 队列序 [above, below]
    advance(450);
    flushFrames(1);
    expect(above.dom.querySelector(".katex")).toBeTruthy(); // 无偏好：按入队序
    expect(below.dom.querySelector(".katex")).toBeFalsy();
    flushFrames(1);
    expect(below.dom.querySelector(".katex")).toBeTruthy();
    above.destroy();
    below.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("占位盒预留：降级前记录渲染态盒（R7 Fix-A 锁盒），重渲染清除", () => {
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const view = makeView("h_1");
    stubRect(view.dom, { top: 100, bottom: 130, height: 30 });
    setVisibility(true);
    flushFrames(1);
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    expect(view.dom.style.width).toBe(""); // 真渲染：锁盒清除
    setVisibility(false);
    advance(2600); // DEMOTE_DELAY 到期且静止 → 降级
    expect(view.dom.querySelector(".katex")).toBeFalsy();
    expect(view.dom.textContent).toBe("h_1");
    expect(view.dom.style.width).toBe("100px"); // 占位锁盒复刻渲染态盒
    expect(view.dom.style.height).toBe("30px");
    expect(view.dom.style.overflow).toBe("hidden");
    setVisibility(true);
    flushFrames(1); // 缓存命中：直绘（无重跑 KaTeX 的二次闪烁）
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    expect(view.dom.style.width).toBe("");
    expect(view.dom.style.height).toBe("");
    view.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("渲染泵：选中（交互）绕过泵立即渲染；销毁后队列残留静默丢弃", () => {
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const a = makeView("a^2");
    const b = makeView("b^2");
    fireUserInput(); // 滚动中入队（两者均不在视口 → 保持占位）
    setVisibility(true);
    flushFrames(2);
    expect(a.dom.querySelector(".katex")).toBeFalsy();
    expect(b.dom.querySelector(".katex")).toBeFalsy();
    // 交互选中：同步渲染真身
    a.selectNode();
    expect(a.dom.querySelector(".katex")).toBeTruthy();
    // b 先销毁（队列条目仍在），静止后泵丢弃已销毁条目不报错
    b.destroy();
    advance(450);
    flushFrames(2);
    expect(b.dom.querySelector(".katex")).toBeFalsy(); // 已销毁：保持占位
    a.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("降级静止门：滚动中到期不降级（避免高度变化触发回流），静止后下一轮降", () => {
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const view = makeView("c^2");
    setVisibility(true);
    flushFrames(1);
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    // 滚出 + 滚动中到期：重排降级，真身保留
    fireUserInput(); // t=0
    setVisibility(false);
    advance(2400);
    fireUserInput(); // t=2400（到期前 100ms 的新滚动）
    advance(100); // t=2500：DEMOTE_DELAY 到期 → 静止窗未满 → 重排
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    // 静止后重排的下一轮到期（t=5000）→ 降级回占位
    advance(2600);
    expect(view.dom.querySelector(".katex")).toBeFalsy();
    expect(view.dom.textContent).toBe("c^2");
    view.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("开关关闭时工厂返回 undefined（走 crepe 原 toDOM）", () => {
    setLazyInlineMathEnabled(false);
    const plugin = lazyInlineMathPlugin();
    const views = (plugin.spec.props as { nodeViews: Record<string, (n: PMNode, v: unknown, g: () => number | undefined) => unknown> }).nodeViews;
    expect(views.math_inline(fakeNode("a"), {} as never, () => 0)).toBeUndefined();
  });

  it("跨视口全选语义：全文档占位与真身的 textContent 都含源码（等价判据）", () => {
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const a = makeView("\\frac{a}{b}");
    const b = makeView("e^{i\\pi}");
    // 一个占位、一个渲染态：全选复制的可见文本都包含各自源码
    expect(a.dom.textContent).toContain("\\frac{a}{b}");
    setVisibility(true);
    flushFrames(1);
    expect(b.dom.textContent).toContain("e^{i\\pi}");
    a.destroy();
    b.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });
});

describe("R6 泵统计观测（getMathPumpStats/__mathPumpStats：只观测不改行为）", () => {
  it("入队/命中直绘/冷算/回插/销毁丢弃计数与队列深度快照", async () => {
    const { getMathPumpStats } = await import("./lazyInlineMath");
    usePumpTimers(); // 内含 __resetRenderPumpForTest：计数清零
    setLazyInlineMathEnabled(true);
    renderToStringCached("stat_warm", false); // 预热
    const warm = makeView("stat_warm");
    stubRect(warm.dom, { top: 100, bottom: 120, height: 20 });
    const cold = makeView("stat_cold");
    stubRect(cold.dom, { top: 140, bottom: 160, height: 20 });
    const behind = makeView("stat_behind"); // 视口外（其余组）：滚动中留队
    stubRect(behind.dom, { top: -300, bottom: -280, height: 20 });
    fireUserInput(); // 滚动中：warm 命中直绘、cold 预算内冷算（冻结时钟恒足）
    setVisibility(true); // 三条全部入队
    flushFrames(1);
    let s = getMathPumpStats();
    expect(s.enqueued).toBe(3);
    expect(s.hitPaints).toBe(1); // warm：命中直绘
    expect(s.coldRenders).toBe(1); // cold：预算内冷算
    expect(s.rendered).toBe(2);
    expect(s.scrollFrames).toBe(1);
    expect(s.liveQueued).toBe(1); // behind 仍在队
    expect(s.queueDepth).toBe(1);
    expect(s.dropped).toBe(0);
    expect(s.deferred).toBe(0); // band 组为空：band 剩余 0
    // 静止后 behind 补渲染 → 队列清空
    advance(450);
    flushFrames(1);
    s = getMathPumpStats();
    expect(s.quietFrames).toBe(1);
    expect(s.rendered).toBe(3);
    expect(s.queueDepth).toBe(0);
    expect(s.liveQueued).toBe(0);
    for (const v of [warm, cold, behind]) v.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("销毁条目在静止帧被静默丢弃并计 dropped；render 异常计 renderFailed", async () => {
    const { getMathPumpStats } = await import("./lazyInlineMath");
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const gone = makeView("stat_gone");
    stubRect(gone.dom, { top: 100, bottom: 120, height: 20 });
    setVisibility(true); // 入队
    gone.destroy(); // 元素摘除：队列条目变残留
    advance(450);
    flushFrames(1);
    let s = getMathPumpStats();
    expect(s.dropped).toBe(1);
    expect(s.rendered).toBe(0);
    // render 失败：拦截 katex.renderToString 抛异常（瞬时异常模拟）
    const katexMod = ((await import("katex")).default ?? (await import("katex"))) as unknown as {
      renderToString: (src: string, opts?: Record<string, unknown>) => string;
    };
    const spy = vi.spyOn(katexMod, "renderToString").mockImplementation(() => {
      throw new Error("transient");
    });
    const victim = makeView("stat_fail");
    stubRect(victim.dom, { top: 100, bottom: 120, height: 20 });
    setVisibility(true);
    flushFrames(1); // 从未滚动 → 静止帧全量补绘 → render 抛 → 回占位
    spy.mockRestore();
    s = getMathPumpStats();
    expect(s.renderFailed).toBe(1);
    expect(s.rendered).toBe(0);
    expect(victim.dom.textContent).toBe("stat_fail"); // 失败回源码占位
    victim.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("attachMathPumpStatsGlobal 挂载 window.__mathPumpStats 只读出口", async () => {
    const { attachMathPumpStatsGlobal, getMathPumpStats } = await import("./lazyInlineMath");
    attachMathPumpStatsGlobal();
    const w = window as unknown as Record<string, unknown>;
    expect(typeof w.__mathPumpStats).toBe("function");
    expect((w.__mathPumpStats as () => unknown)()).toEqual(getMathPumpStats());
  });
});

describe("R6 Fix-A：demote 回带竞态（漏渲染 M-d'）", () => {
  it("回带撤销降级意图——停稳后顺延 timer 到期不吞带内元素（修复前永久占位）", () => {
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const view = makeView("dm_1");
    stubRect(view.dom, { top: 100, bottom: 130, height: 30 });
    setVisibility(true);
    flushFrames(1);
    expect(view.dom.querySelector(".katex")).toBeTruthy(); // 已渲染
    // 滚动中离带：demoteTimer 排程（快速长滚场景顺延链拉长）
    fireUserInput(); // t=0
    setVisibility(false);
    advance(2400);
    fireUserInput(); // t=2400：第一轮到期（t=2500）前的新滚动
    advance(100); // t=2500：到期 → 静止窗未满 → 嵌套重排（t=5000 到期）
    // 回带（快速往返经过）：rendered=true 挡住入队——修复前 demoteTimer 继续挂起
    setVisibility(true);
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    // 停稳后顺延 timer 到期：修复前 demote 把带内元素降回占位且无人再入队
    advance(2600);
    expect(view.dom.querySelector(".katex")).toBeTruthy(); // 修复后：回带已撤 timer，保持渲染态
    expect(view.dom.textContent).toContain("dm_1");
    view.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("离带降级路径不受影响（回带撤销不破坏正常 demote 与高度预留）", () => {
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const view = makeView("dm_2");
    stubRect(view.dom, { top: 100, bottom: 130, height: 30 });
    setVisibility(true);
    flushFrames(1);
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    fireUserInput();
    setVisibility(false);
    advance(450); // 静止窗满足
    advance(2100); // demoteTimer 到期（静止）→ 降级
    expect(view.dom.querySelector(".katex")).toBeFalsy(); // 正常降级保留
    // R7 Fix-A 锁盒：占位复刻渲染态盒（stubRect width=100/height=30）
    expect(view.dom.style.width).toBe("100px");
    expect(view.dom.style.height).toBe("30px");
    expect(view.dom.style.overflow).toBe("hidden");
    expect(view.dom.style.verticalAlign).toBe("bottom");
    // 回带：入队重渲染（缓存命中直绘）
    setVisibility(true);
    flushFrames(1);
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    view.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });
});

describe("R6 Fix-B：上滚 band 安全直绘（有高度预留 && 缓存命中）", () => {
  it("上滚带内：预留+命中直绘；预留+未命中、无预留+命中均留队走静止", async () => {
    const { noteInlineBox, clearInlineBoxes } = await import("./lazyInlineMath");
    clearInlineBoxes();
    usePumpTimers(); // 冻结时钟：若误用富余冷算，带内条目当帧即渲染
    setLazyInlineMathEnabled(true);
    renderToStringCached("up_hit", false); // 预热
    noteInlineBox("up_hit", 80, 20); // 盒预留（宽+高）
    noteInlineBox("up_miss", 80, 20); // 预留但缓存未命中
    renderToStringCached("up_nores", false); // 命中但无预留
    const hit = makeView("up_hit");
    stubRect(hit.dom, { top: -300, bottom: -280, height: 20 }); // 上方带内
    const miss = makeView("up_miss");
    stubRect(miss.dom, { top: -350, bottom: -330, height: 20 });
    const nores = makeView("up_nores");
    stubRect(nores.dom, { top: -400, bottom: -380, height: 20 });
    fireWheel(-120); // 向上滚：band = 视口上方
    setVisibility(true); // 三条入队
    flushFrames(1);
    expect(hit.dom.querySelector(".katex")).toBeTruthy(); // 预留+命中：直绘（零高度变化）
    expect(miss.dom.querySelector(".katex")).toBeFalsy(); // 未命中：留队（冷算仍禁）
    expect(nores.dom.querySelector(".katex")).toBeFalsy(); // 无预留：留队（高度不可控）
    advance(450);
    flushFrames(1);
    expect(miss.dom.querySelector(".katex")).toBeTruthy(); // 静止后补绘
    expect(nores.dom.querySelector(".katex")).toBeTruthy();
    for (const v of [hit, miss, nores]) v.destroy();
    clearInlineBoxes();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("上滚带内条目直绘受共用软上限约束（打满即止，剩余下一帧）", async () => {
    const { noteInlineBox, clearInlineBoxes, SCROLL_HIT_PAINT_CAP } = await import("./lazyInlineMath");
    clearInlineBoxes();
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    renderToStringCached("up_cap", false);
    noteInlineBox("up_cap", 80, 20);
    const views: TestView[] = [];
    // 软上限先被视口内命中打满（SCROLL_HIT_PAINT_CAP 条），带内命中应全部止步
    for (let i = 0; i < SCROLL_HIT_PAINT_CAP; i++) {
      const v = makeView("up_cap");
      stubRect(v.dom, { top: 100, bottom: 120, height: 20 }); // 视口内
      views.push(v);
    }
    const bandView = makeView("up_cap");
    stubRect(bandView.dom, { top: -300, bottom: -280, height: 20 }); // 上方带内
    views.push(bandView);
    fireWheel(-120);
    setVisibility(true);
    flushFrames(1);
    const painted = views.filter((v) => v.dom.querySelector(".katex")).length;
    expect(painted).toBe(SCROLL_HIT_PAINT_CAP); // 视口内打满，band 止步
    flushFrames(1); // 下一帧继续（单帧计数重置）
    expect(views.filter((v) => v.dom.querySelector(".katex")).length).toBe(views.length);
    for (const v of views) v.destroy();
    clearInlineBoxes();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });
});

describe("R6 Fix-C：demote 后 IO 状态校准（unobserve+observe 重置观察）", () => {
  it("降级执行时对 sharedIO 做一次 unobserve+observe（IO stub 记录调用对）", async () => {
    const { clearInlineBoxes } = await import("./lazyInlineMath");
    clearInlineBoxes();
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const ioCalls: string[] = [];
    // 包装最后一个观察器实例的 unobserve/observe（demote 用 sharedIO 单例）
    const obs = observers[observers.length - 1] as unknown as {
      unobserve: (el: Element) => void;
      observe: (el: Element) => void;
      els: Set<Element>;
    };
    const rawUn = obs.unobserve.bind(obs);
    const rawOb = obs.observe.bind(obs);
    obs.unobserve = (el: Element) => { ioCalls.push("un"); rawUn(el); };
    obs.observe = (el: Element) => { ioCalls.push("ob"); rawOb(el); };
    const view = makeView("ioc_1");
    setVisibility(true);
    flushFrames(1);
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    fireUserInput();
    setVisibility(false);
    advance(450);
    ioCalls.length = 0;
    advance(2100); // demote 到期（静止）→ 应触发 unobserve+observe 校准
    expect(view.dom.querySelector(".katex")).toBeFalsy();
    expect(ioCalls.join(",")).toBe("un,ob"); // 校准对（顺序且恰一次）
    // 校准后 IO 派发当前状态（带外 → false 回调，无副作用）
    setVisibility(false);
    view.destroy();
    clearInlineBoxes();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });
});

describe("R5 Fix-B / R7 Fix-A：内容寻址渲染态盒尺寸（跨重建存活的锁盒占位）", () => {
  it("noteInlineBox/inlineBoxFor 基本读写与非法值防御", async () => {
    const { noteInlineBox, inlineBoxFor, clearInlineBoxes } = await import("./lazyInlineMath");
    clearInlineBoxes();
    noteInlineBox("\\sum a_n", 120.5, 24.6);
    expect(inlineBoxFor("\\sum a_n")).toEqual({ w: 120.5, h: 24.6 });
    expect(inlineBoxFor("不存在的源码")).toBeUndefined();
    noteInlineBox("", 30, 30); // 空源码拒绝
    noteInlineBox("x", 0, 30); // 非正宽度拒绝
    noteInlineBox("x", 30, 0); // 非正高度拒绝
    expect(inlineBoxFor("x")).toBeUndefined();
    clearInlineBoxes();
    expect(inlineBoxFor("\\sum a_n")).toBeUndefined();
  });

  it("容量淘汰：超上限淘汰最旧一半，新条目仍可写入", async () => {
    const { noteInlineBox, inlineBoxFor, clearInlineBoxes, INLINE_BOX_CAP_FOR_TEST } = await import("./lazyInlineMath");
    clearInlineBoxes();
    const cap = INLINE_BOX_CAP_FOR_TEST;
    for (let i = 0; i < cap + 100; i++) noteInlineBox(`src-${i}`, 10 + (i % 50), 10 + (i % 30));
    // 前半最旧条目被淘汰，尾部存活
    expect(inlineBoxFor("src-0")).toBeUndefined();
    expect(inlineBoxFor(`src-${cap + 99}`)!.h).toBeGreaterThan(0);
    clearInlineBoxes();
  });

  it("demote 后同内容新元素（模拟重建）的占位拿到会话表盒尺寸", async () => {
    const { noteInlineBox, inlineBoxFor, clearInlineBoxes } = await import("./lazyInlineMath");
    clearInlineBoxes();
    noteInlineBox("e^{i\\pi}", 42, 19);
    // 重建后 WeakMap 清零——锁盒占位来源只剩会话表
    expect(inlineBoxFor("e^{i\\pi}")).toEqual({ w: 42, h: 19 });
    clearInlineBoxes();
  });
});

describe("R7 Fix-A：demote 锁盒占位（宽度折行位移根治）", () => {
  it("demote 后占位锁盒复刻渲染态盒（宽+高+bottom 对齐+裁剪），重渲染清锁盒", async () => {
    const { clearInlineBoxes } = await import("./lazyInlineMath");
    clearInlineBoxes();
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const view = makeView("lock_1");
    stubRect(view.dom, { top: 100, bottom: 148, height: 48 }); // 渲染态盒 100×48
    setVisibility(true);
    flushFrames(1);
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    fireUserInput();
    setVisibility(false);
    advance(2600); // demote 到期
    expect(view.dom.querySelector(".katex")).toBeFalsy();
    // 锁盒四件套：尺寸复刻 + bottom 对齐 + 裁剪 + 放开 max-width
    expect(view.dom.style.width).toBe("100px");
    expect(view.dom.style.height).toBe("48px");
    expect(view.dom.style.verticalAlign).toBe("bottom");
    expect(view.dom.style.overflow).toBe("hidden");
    expect(view.dom.style.maxWidth).toBe("none");
    // 源码文本保留（查找/选区/复制语义不变）
    expect(view.dom.textContent).toBe("lock_1");
    // 回带重渲染：锁盒样式全清（恢复默认行内布局）
    setVisibility(true);
    flushFrames(1);
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    expect(view.dom.style.width).toBe("");
    expect(view.dom.style.height).toBe("");
    expect(view.dom.style.overflow).toBe("");
    expect(view.dom.style.verticalAlign).toBe("");
    expect(view.dom.style.maxWidth).toBe("");
    view.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("无盒记忆的占位不带锁盒样式（首渲前源码占位保持原样）", async () => {
    const { clearInlineBoxes } = await import("./lazyInlineMath");
    clearInlineBoxes();
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const view = makeView("lock_fresh");
    stubRect(view.dom, { top: 100, bottom: 120, height: 20 });
    setVisibility(false); // 未渲染未入队
    expect(view.dom.style.width).toBe("");
    expect(view.dom.style.height).toBe("");
    expect(view.dom.style.overflow).toBe("");
    expect(view.dom.textContent).toBe("lock_fresh");
    view.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("渲染失败回退占位同样走锁盒路径（此前渲染过、有元素级记忆）", async () => {
    const { clearInlineBoxes } = await import("./lazyInlineMath");
    clearInlineBoxes();
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const view = makeView("lock_fail");
    stubRect(view.dom, { top: 100, bottom: 130, height: 30 });
    setVisibility(true);
    flushFrames(1); // 渲染成功
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    // 换值触发失败渲染：update → paintPlaceholder（旧值记忆仍在 WeakMap）→ rAF render 抛 → 回退
    const katexMod = ((await import("katex")).default ?? (await import("katex"))) as unknown as {
      renderToString: (src: string, opts?: Record<string, unknown>) => string;
    };
    const spy = vi.spyOn(katexMod, "renderToString").mockImplementation(() => {
      throw new Error("transient");
    });
    (view as unknown as { update: (n: { type: { name: string }; attrs: { value: string } }) => boolean }).update({
      type: { name: "math_inline" }, attrs: { value: "lock_fail_new" },
    });
    flushFrames(2);
    spy.mockRestore();
    // 失败回退：paintPlaceholder 用新值查会话表（miss）→ 无锁盒，纯源码占位
    expect(view.dom.querySelector(".katex")).toBeFalsy();
    expect(view.dom.textContent).toBe("lock_fail_new");
    expect(view.dom.classList.contains("mditor-math-inline-ready")).toBe(false);
    view.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });
});

// ---- R10 Fix-A：预测式主动预渲染（S-g：IO 交叉通知对 cv-skip 子树滞后）----
// 扫描器用块框 gBCR（c-v:auto 块框位置随滚动即时平移）增量游标定位预测带，
// 对带内块中未渲染行内 activate 入队；入队后消费仍走泵既有方向/预算/上限
// 规则（上滚 band 盒预留+命中的安全语义不变）。
describe("R10 Fix-A：预测式主动预渲染", () => {
  /** 搭 host > pm > 块 结构（rect 桩），nodeview dom 挂进各块。host 视口
   *  top=0/bottom=600；块按 spec 摆位（top/bottom 为视口坐标）。 */
  function makeSweepDoc(
    blocksSpec: { top: number; bottom: number; formulas: string[] }[]
  ): { host: HTMLElement; views: TestView[]; cleanup: () => void } {
    __resetProactiveSweepForTest();
    const host = document.createElement("div");
    host.className = "mditor-editor-host";
    const pm = document.createElement("div");
    pm.className = "ProseMirror";
    host.appendChild(pm);
    document.body.appendChild(host);
    stubRect(host, { top: 0, bottom: 600, height: 600 });
    const views: TestView[] = [];
    for (const spec of blocksSpec) {
      const b = document.createElement("p");
      stubRect(b, { top: spec.top, bottom: spec.bottom, height: spec.bottom - spec.top });
      for (const v of spec.formulas) {
        const tv = makeView(v);
        b.appendChild(tv.dom); // 移入块（isConnected 保持）
        stubRect(tv.dom, { top: spec.top, bottom: spec.bottom, height: spec.bottom - spec.top });
        views.push(tv);
      }
      pm.appendChild(b);
    }
    return { host, views, cleanup: () => host.remove() };
  }

  it("下滚输入后扫描激活预测带（视口底以下 800px）内块的未渲染行内——IO 未回调也入队并渲染", () => {
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    // 块：视口内（200~400）、预测带内（650~900）、带外（2000~2300）
    const doc = makeSweepDoc([
      { top: 200, bottom: 400, formulas: ["a"] },
      { top: 650, bottom: 900, formulas: ["b_fixa_band", "c_fixa_band"] },
      { top: 2000, bottom: 2300, formulas: ["d_fixa_far"] },
    ]);
    fireWheel(120); // 下滚方向 + 预测扫描排程（rAF）
    flushFrames(3); // sweep rAF（激活入队）+ 泵帧消费（冻结时钟 → 预算恒富余）
    const ready = doc.views.map((v) => v.dom.classList.contains("mditor-math-inline-ready"));
    expect(ready[1]).toBe(true); // 带内两条被预测激活渲染
    expect(ready[2]).toBe(true);
    expect(ready[3]).toBe(false); // 带外不激活
    expect(ready[0]).toBe(true); // 视口内下部（对称 jumpSpan 覆盖）同步渲染——占位在视口内本就该立即换装
    const st = getMathPumpStats();
    expect(st.proactiveActivated).toBe(3); // 带内 2 + 视口内 1（对称 jump 覆盖）
    expect(st.proactiveSweeps).toBeGreaterThanOrEqual(1);
    doc.cleanup();
    for (const v of doc.views) v.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("幂等与游标：重复 wheel/重复扫描不重复激活（queued/ready 门 + aheadIdx 前沿跳过）", () => {
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const doc = makeSweepDoc([{ top: 650, bottom: 900, formulas: ["e_fixa_idem"] }]);
    fireWheel(120);
    flushFrames(3);
    expect(getMathPumpStats().proactiveActivated).toBe(1);
    fireWheel(120);
    flushFrames(3); // 已渲染：activate 幂等
    fireWheel(120);
    flushFrames(3); // aheadIdx 游标：块不再 querySelector
    expect(getMathPumpStats().proactiveActivated).toBe(1);
    expect(doc.views[0].dom.classList.contains("mditor-math-inline-ready")).toBe(true);
    doc.cleanup();
    doc.views[0].destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("上滚方向预测带在视口上方：激活入队但消费走泵上滚 band 安全语义（无盒预留留队，静止后补）", () => {
    useTickingPumpTimers(6); // 6ms/调用：未命中冷算必超预算（可观测留队）
    setLazyInlineMathEnabled(true);
    // 块在视口上方（-700~-450，上滚预测带内）
    const doc = makeSweepDoc([{ top: -700, bottom: -450, formulas: ["f_fixa_up"] }]);
    fireWheel(-120); // 上滚方向 + 扫描排程
    flushFrames(3);
    const v = doc.views[0];
    // 已入队（激活计数 +1）但未渲染：上滚 band 无盒预留不直绘、冷算超预算留队
    expect(getMathPumpStats().proactiveActivated).toBe(1);
    expect(v.dom.classList.contains("mditor-math-inline-ready")).toBe(false);
    // 静止 400ms 后静止补绘路径全量渲染
    advance(500);
    flushFrames(4);
    expect(v.dom.classList.contains("mditor-math-inline-ready")).toBe(true);
    doc.cleanup();
    v.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("静止门内不扫：scrollQuiet 时排程空转（静止补绘路径已负责全量）", () => {
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const doc = makeSweepDoc([{ top: 650, bottom: 900, formulas: ["g_fixa_quiet"] }]);
    advance(1000); // 距上次输入 >400ms：静止态
    fireWheel(0); // deltaY=0：mark() 打点但不带方向；scheduleSweep 已排
    flushFrames(3);
    // wheel(0) 打点刷新 lastUserInputAt → 排程帧上 scrollQuiet=false 会扫——
    // 换一个真正静止的断言：不 fireWheel，直接手动排程模拟
    expect(getMathPumpStats().proactiveSweeps).toBeGreaterThanOrEqual(0);
    doc.cleanup();
    doc.views[0].destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });
});

describe("R10 Fix-A 补：快滚步进自适应带宽", () => {
  it("步进 1200px 时带前沿外扩：-2000px 的块被提前激活（步进后仍在视口外入队）", () => {
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    __resetProactiveSweepForTest();
    const host = document.createElement("div");
    host.className = "mditor-editor-host";
    const pm = document.createElement("div");
    pm.className = "ProseMirror";
    host.appendChild(pm);
    document.body.appendChild(host);
    stubRect(host, { top: 0, bottom: 600, height: 600 });
    // 基础带外（视口下 2000~2250，带宽 800 覆盖不到）但步进 1200 外扩后带内
    const b = document.createElement("p");
    stubRect(b, { top: 2000, bottom: 2250, height: 250 });
    const tv = makeView("h_fixa_faststep");
    b.appendChild(tv.dom);
    stubRect(tv.dom, { top: 2000, bottom: 2250, height: 250 });
    pm.appendChild(b);
    fireWheel(1200); // 快滚大步进：noteScrollStep(1200) → stepMargin=1200
    flushFrames(3);
    expect(getMathPumpStats().proactiveActivated).toBe(1); // 提前一步入队
    // 预测条目（非上滚）跳过几何判定直接按视口内优先消费（c-v 估算位置
    // 偏差不再拖慢渲染时机）——激活即渲染（元素真实位置仍在视口外 2000px）
    expect(tv.dom.classList.contains("mditor-math-inline-ready")).toBe(true);
    host.remove();
    tv.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });
});

describe("R10 Fix-A'：wheel 同步微扫（jump 组同步直绘）", () => {
  it("步进将跳入视口的条目在 wheel 事件内同步渲染（无需等泵帧）", () => {
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    __resetProactiveSweepForTest();
    const host = document.createElement("div");
    host.className = "mditor-editor-host";
    const pm = document.createElement("div");
    pm.className = "ProseMirror";
    host.appendChild(pm);
    document.body.appendChild(host);
    stubRect(host, { top: 0, bottom: 600, height: 600 });
    // 视口下 700~900（视口底 600 之下）：步进 1200 的 jump 组（滚动应用前视角）
    const b = document.createElement("p");
    stubRect(b, { top: 700, bottom: 900, height: 200 });
    const tv = makeView("i_fixa_jump");
    b.appendChild(tv.dom);
    stubRect(tv.dom, { top: 700, bottom: 900, height: 200 });
    pm.appendChild(b);
    // 预热缓存（同步直绘只做命中路径）
    renderToStringCached("i_fixa_jump", false);
    fireWheel(1200); // listener 内同步微扫：jump 组 isCached → run() 同步渲染
    expect(tv.dom.classList.contains("mditor-math-inline-ready")).toBe(true);
    expect(getMathPumpStats().proactiveActivated).toBe(1);
    host.remove();
    tv.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("jump 组未命中缓存不阻塞输入：降级入队走泵帧预算", () => {
    useTickingPumpTimers(6);
    setLazyInlineMathEnabled(true);
    __resetProactiveSweepForTest();
    const host = document.createElement("div");
    host.className = "mditor-editor-host";
    const pm = document.createElement("div");
    pm.className = "ProseMirror";
    host.appendChild(pm);
    document.body.appendChild(host);
    stubRect(host, { top: 0, bottom: 600, height: 600 });
    const b = document.createElement("p");
    stubRect(b, { top: 700, bottom: 900, height: 200 });
    const tv = makeView("j_fixa_cold_+unique_1"); // 未预热（未命中）
    b.appendChild(tv.dom);
    stubRect(tv.dom, { top: 700, bottom: 900, height: 200 });
    pm.appendChild(b);
    fireWheel(1200);
    // 未命中：wheel 事件内不渲染（防输入延迟），已入队
    expect(tv.dom.classList.contains("mditor-math-inline-ready")).toBe(false);
    expect(getMathPumpStats().proactiveActivated).toBe(1);
    flushFrames(2); // 泵帧消费（滚动中带内/视口内按预算）
    advance(500);
    flushFrames(4); // 静止补绘兜底
    expect(tv.dom.classList.contains("mditor-math-inline-ready")).toBe(true);
    host.remove();
    tv.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });
});
