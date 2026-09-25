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

  it("占位高度预留：降级前记录渲染态高度，占位以 minHeight 撑住，重渲染清除", () => {
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const view = makeView("h_1");
    stubRect(view.dom, { top: 100, bottom: 130, height: 30 });
    setVisibility(true);
    flushFrames(1);
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    expect(view.dom.style.minHeight).toBe(""); // 真渲染：清除预留
    setVisibility(false);
    advance(2600); // DEMOTE_DELAY 到期且静止 → 降级
    expect(view.dom.querySelector(".katex")).toBeFalsy();
    expect(view.dom.textContent).toBe("h_1");
    expect(view.dom.style.minHeight).toBe("30px"); // 占位撑住渲染态高度
    setVisibility(true);
    flushFrames(1); // 缓存命中：直绘（无重跑 KaTeX 的二次闪烁）
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    expect(view.dom.style.minHeight).toBe("");
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
