// @vitest-environment jsdom
// R1 行内公式懒渲染：占位/渲染/降级/等价性（源文本保留、开关按体量、
// update/destroy 生命周期）。
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Node as PMNode } from "@milkdown/prose/model";
import {
  lazyInlineMathEnabled,
  setLazyInlineMathEnabled,
  setLazyMathBySize,
  lazyInlineMathPlugin,
} from "./lazyInlineMath";

// ---- IntersectionObserver stub：手动派发可见性 --------------------------------
interface IOEntry {
  target: Element;
  isIntersecting: boolean;
}
const observers: {
  cb: (es: IOEntry[]) => void;
  els: Set<Element>;
}[] = [];

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
});

/** 把最后一个观察器的目标设为可见/不可见（模拟滚入/滚出）。 */
function setVisibility(intersecting: boolean): void {
  const obs = observers[observers.length - 1];
  expect(obs).toBeTruthy();
  const entries = [...obs.els].map((target) => ({ target, isIntersecting: intersecting }));
  obs.cb(entries);
}

const fakeNode = (value: string): PMNode =>
  ({ type: { name: "math_inline" }, attrs: { value } }) as unknown as PMNode;

describe("R1 行内公式懒渲染", () => {
  it("开关按体量（阈值同 memory.ts，与设置无关）", () => {
    setLazyMathBySize("x".repeat(100));
    expect(lazyInlineMathEnabled()).toBe(false);
    setLazyMathBySize("x".repeat(600_000));
    expect(lazyInlineMathEnabled()).toBe(true);
    setLazyMathBySize(null);
    expect(lazyInlineMathEnabled()).toBe(false);
  });

  it("占位保留源文本（window.find/选区/复制语义），滚入渲染 KaTeX，滚出延迟降级", () => {
    vi.useFakeTimers();
    setLazyInlineMathEnabled(true);
    lazyInlineMathPlugin(); // 触发插件构造（nodeViews 注册路径）
    const node = fakeNode("x^2+y_2");
    // 经 nodeViews 工厂拿 view：直接从插件的 props.nodeViews 取
    const plugin = lazyInlineMathPlugin();
    const views = (plugin.spec.props as { nodeViews: Record<string, (n: PMNode, v: unknown, g: () => number | undefined) => unknown> }).nodeViews;
    const view = views.math_inline(node, {} as never, () => 0) as {
      dom: HTMLElement;
      update: (n: PMNode) => boolean;
      selectNode: () => void;
      destroy: () => void;
    };
    expect(view).toBeTruthy();
    // 占位态：源文本完整保留
    expect(view.dom.dataset.type).toBe("math_inline");
    expect(view.dom.textContent).toBe("x^2+y_2");
    // 滚入 → 渲染（KaTeX 真身，含 MathML annotation）
    setVisibility(true);
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    expect(view.dom.textContent).toContain("x^2+y_2"); // annotation 内保留源码
    // 滚出 → 延迟降级回占位
    setVisibility(false);
    expect(view.dom.querySelector(".katex")).toBeTruthy(); // 未到期不降
    vi.advanceTimersByTime(2600);
    expect(view.dom.querySelector(".katex")).toBeFalsy();
    expect(view.dom.textContent).toBe("x^2+y_2");
    // update：值变化回到占位并（rAF 后）重渲染
    setVisibility(true);
    expect(view.update(fakeNode("z^3"))).toBe(true);
    expect(view.dom.textContent).toBe("z^3");
    expect(view.update({ type: { name: "paragraph" }, attrs: {} } as unknown as PMNode)).toBe(false);
    // 选中立即渲染
    view.selectNode();
    expect(view.dom.querySelector(".katex")).toBeTruthy();
    view.destroy();
    vi.useRealTimers();
    setLazyInlineMathEnabled(false);
  });

  it("开关关闭时工厂返回 undefined（走 crepe 原 toDOM）", () => {
    setLazyInlineMathEnabled(false);
    const plugin = lazyInlineMathPlugin();
    const views = (plugin.spec.props as { nodeViews: Record<string, (n: PMNode, v: unknown, g: () => number | undefined) => unknown> }).nodeViews;
    expect(views.math_inline(fakeNode("a"), {} as never, () => 0)).toBeUndefined();
  });

  it("跨视口全选语义：全文档占位与真身的 textContent 都含源码（等价判据）", () => {
    setLazyInlineMathEnabled(true);
    const plugin = lazyInlineMathPlugin();
    const views = (plugin.spec.props as { nodeViews: Record<string, (n: PMNode, v: unknown, g: () => number | undefined) => unknown> }).nodeViews;
    const a = views.math_inline(fakeNode("\\frac{a}{b}"), {} as never, () => 0) as {
      dom: HTMLElement;
      destroy?: () => void;
    };
    const b = views.math_inline(fakeNode("e^{i\\pi}"), {} as never, () => 1) as {
      dom: HTMLElement;
      destroy?: () => void;
    };
    // 一个占位、一个渲染态：全选复制的可见文本都包含各自源码
    expect(a.dom.textContent).toContain("\\frac{a}{b}");
    setVisibility(true); // 只影响最后注册的观察器（b）
    expect(b.dom.textContent).toContain("e^{i\\pi}");
    a.destroy?.();
    b.destroy?.();
    setLazyInlineMathEnabled(false);
  });
});
