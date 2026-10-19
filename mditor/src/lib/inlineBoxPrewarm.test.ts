// inlineBoxPrewarm（R11 P3 原型：预热批渲染态测高）单测。
// 默认关零行为；开启后：已缓存源码被离屏测盒填入 inlineBoxes（占位端
// paintPlaceholder 消费）；未缓存源码不触发 KaTeX 冷算。
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetInlineBoxPrewarmForTest, startInlineBoxPrewarm } from "./inlineBoxPrewarm";
import { clearInlineBoxes, inlineBoxFor, setLazyInlineMathEnabled } from "./lazyInlineMath";
import { renderToStringCached } from "./katexCache";

interface FakeView {
  isDestroyed: boolean;
  dom: HTMLElement;
  state: {
    doc: {
      descendants: (fn: (node: { type: { name: string }; attrs: { value?: string } }) => boolean) => void;
    };
  };
}

function makeFakeView(sources: string[]): FakeView {
  const host = document.createElement("div");
  host.className = "mditor-editor-host";
  const pm = document.createElement("div");
  pm.className = "ProseMirror";
  host.appendChild(pm);
  document.body.appendChild(host);
  return {
    isDestroyed: false,
    dom: pm,
    state: {
      doc: {
        descendants: (fn) => {
          for (const src of sources) fn({ type: { name: "math_inline" }, attrs: { value: src } });
        },
      },
    },
  };
}

describe("inlineBoxPrewarm 原型（P3，默认关）", () => {
  beforeEach(() => {
    __resetInlineBoxPrewarmForTest();
    clearInlineBoxes();
    setLazyInlineMathEnabled(true);
    document.body.innerHTML = "";
    (window as unknown as Record<string, unknown>).__inlineBoxPrewarmCfg = undefined;
  });

  it("未开开关：不测量、不落盒", async () => {
    const cached = "\\alpha";
    renderToStringCached(cached, false);
    const view = makeFakeView([cached]);
    startInlineBoxPrewarm(view as never);
    await new Promise((r) => setTimeout(r, 60));
    expect(inlineBoxFor(cached)).toBeUndefined();
  });

  it("开启后：已缓存源码离屏测盒填 inlineBoxes", async () => {
    const cached = "\\beta_1+\\gamma";
    renderToStringCached(cached, false); // 填 katexCache
    (window as unknown as Record<string, unknown>).__inlineBoxPrewarmCfg = { on: true, batchMs: 50 };
    const view = makeFakeView([cached]);
    // jsdom 无布局：桩掉 sizer 的 rect（挂到 host 后由模块查询）。
    const orig = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { top: 0, left: 0, right: 24, bottom: 12, width: 24, height: 12, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    try {
      startInlineBoxPrewarm(view as never);
      await new Promise((r) => setTimeout(r, 80));
    } finally {
      HTMLElement.prototype.getBoundingClientRect = orig;
    }
    const box = inlineBoxFor(cached);
    expect(box).toBeDefined();
    expect(box?.w).toBe(24);
    expect(box?.h).toBe(12);
    const stats = (window as unknown as { __inlineBoxPrewarmStats?: () => { measured: number } }).__inlineBoxPrewarmStats?.();
    expect(stats?.measured).toBe(1);
    // sizer 收尾清理
    expect(document.querySelector("span.mditor-math-inline-ready[style*='-99999px']")).toBeNull();
  });

  it("未缓存源码不测量（不触发 KaTeX 冷算）", async () => {
    const cold = "\\delta_{未渲染过}";
    (window as unknown as Record<string, unknown>).__inlineBoxPrewarmCfg = { on: true, batchMs: 50 };
    const view = makeFakeView([cold]);
    const spy = vi.spyOn(await import("./katexCache"), "renderToStringCached");
    startInlineBoxPrewarm(view as never);
    await new Promise((r) => setTimeout(r, 80));
    expect(inlineBoxFor(cold)).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
