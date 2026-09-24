// @vitest-environment jsdom
// R1 行内公式懒渲染：占位/渲染/降级/等价性（源文本保留、开关按体量、
// update/destroy 生命周期）+ R1b 渲染泵（滚动静止门控、帧预算补渲染、
// 选中/编辑立即渲染）。
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Node as PMNode } from "@milkdown/prose/model";
import {
  lazyInlineMathEnabled,
  setLazyInlineMathEnabled,
  setLazyMathBySize,
  lazyInlineMathPlugin,
  __resetRenderPumpForTest,
} from "./lazyInlineMath";
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

/** 模拟一次滚动（捕获阶段的 document scroll 监听应更新静止时间戳）。 */
function fireScroll(): void {
  document.dispatchEvent(new Event("scroll"));
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

function usePumpTimers(): void {
  fakeNow = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockImplementation(() => fakeNow);
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

  it("渲染泵：滚动进行中保持占位（无渲染成本），静止后才补渲染", () => {
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const view = makeView("\\alpha+\\beta");
    setVisibility(true);
    // 持续滚动：泵每帧都看到静止窗口未满 → 一直占位
    for (let i = 0; i < 5; i++) {
      fireScroll();
      flushFrames(1);
      expect(view.dom.querySelector(".katex")).toBeFalsy();
      advance(40);
    }
    // 停止滚动，静止窗口（400ms）过去 → 渲染落定
    advance(450);
    flushFrames(1);
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    expect(view.dom.textContent).toContain("\\alpha+\\beta");
    view.destroy();
    useRealPumpTimers();
    setLazyInlineMathEnabled(false);
  });

  it("渲染泵：选中（交互）绕过泵立即渲染；销毁后队列残留静默丢弃", () => {
    usePumpTimers();
    setLazyInlineMathEnabled(true);
    const a = makeView("a^2");
    const b = makeView("b^2");
    fireScroll(); // 滚动中入队
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
    fireScroll(); // t=0
    setVisibility(false);
    advance(2400);
    fireScroll(); // t=2400（到期前 100ms 的新滚动）
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
