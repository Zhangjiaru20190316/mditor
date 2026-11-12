// MC 轮（公式导出截断修复）回归锚定：墨迹盒测量 / 补丁墨迹覆盖 / 公式块
// 原子分页 / 超宽公式缩放归一 / 工厂无滚动媒体 CSS / DOCX 栅格化墨盒。
//
// 定罪基线（Edge headless 实测，perf/mathclip/results/baseline.json）：
//   * 超宽 display 公式（nowrap）溢出版心 403px → 光栅窗口硬裁右侧；
//   * 块公式墨迹越出布局盒上方 5px、行内高公式上方 24px/下方 14px →
//     按布局盒裁剪的补丁/栅格化窗口削笔画；
//   * aligned/cases 行盒间 2px 缝 → 分页刀口可落进公式内部。
// jsdom 无布局：全部沿用 exportPdfPipeline.test 的原型级 rect 注入手法。

// @vitest-environment jsdom
import { describe, expect, it, afterEach, vi } from "vitest";
import { inkRectOf, padAndClampInkRect, INK_PAD_PX } from "./exportInk";
import { measureBlocks, collectPatchPlan } from "./exportPdfPipeline";
import { buildFactoryDocumentHtml, normalizeOverwideMath } from "./exportRenderFactory";
import type { RenderFactoryHandle } from "./exportRenderFactory";

const restoreFns: Array<() => void> = [];
afterEach(() => {
  while (restoreFns.length) restoreFns.pop()!();
});

/** 原型级 rect 注入：Text 节点的 Range 矩形与元素盒由表驱动。 */
function injectGeometry(o: {
  /** content 容器视口顶/左。 */
  contentTop?: number;
  contentLeft?: number;
  /** 元素选择器 → rect（视口坐标）。 */
  elRects?: Array<{ match: (el: Element) => boolean; rect: { left: number; top: number; right: number; bottom: number } }>;
  /** 文本内容 → Range 客户端矩形列表（视口坐标）。 */
  textRects?: Array<{ text: string; rects: Array<{ left: number; top: number; right: number; bottom: number }> }>;
}): void {
  const origGBCR = Element.prototype.getBoundingClientRect;
  const origGCR = Range.prototype.getClientRects;
  const rectify = (r: { left: number; top: number; right: number; bottom: number }) => ({
    ...r,
    width: r.right - r.left,
    height: r.bottom - r.top,
    x: r.left,
    y: r.top,
    toJSON: () => ({}),
  });
  (Element.prototype as unknown as Record<string, unknown>).getBoundingClientRect =
    function (this: Element) {
      for (const e of o.elRects ?? []) if (e.match(this)) return rectify(e.rect);
      return rectify({ left: 0, top: 0, right: 0, bottom: 0 });
    };
  (Range.prototype as unknown as Record<string, unknown>).getClientRects =
    function (this: Range) {
      const t = this.startContainer.textContent ?? "";
      for (const e of o.textRects ?? []) if (e.text === t) return e.rects.map(rectify);
      return [];
    };
  restoreFns.push(() => {
    (Element.prototype as unknown as Record<string, unknown>).getBoundingClientRect = origGBCR;
    (Range.prototype as unknown as Record<string, unknown>).getClientRects = origGCR;
  });
}

function mkHandle(doc: Document, content: HTMLElement): RenderFactoryHandle {
  return {
    iframe: {} as HTMLIFrameElement,
    doc,
    content,
    issues: [],
    timedOut: false,
    destroy: () => {},
  } as unknown as RenderFactoryHandle;
}

// ---------------------------------------------------------------------------
// exportInk：墨迹联合矩形。
// ---------------------------------------------------------------------------
describe("inkRectOf", () => {
  it("文本 run 矩形 + svg 盒的联合；.katex-mathml 与空白文本不计", () => {
    const doc = document.implementation.createHTMLDocument("t");
    const root = doc.createElement("span");
    root.className = "katex";
    const vis = doc.createElement("span");
    vis.textContent = "ab"; // 墨迹 [-5, 10, 30, 26]
    const mml = doc.createElement("span");
    mml.className = "katex-mathml";
    mml.textContent = "ab"; // 同文本但应被跳过
    const pad = doc.createElement("span");
    pad.textContent = "  ";
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    root.append(vis, mml, pad, svg);
    doc.body.appendChild(root);
    injectGeometry({
      elRects: [{ match: (el) => el.tagName === "svg", rect: { left: 8, top: 2, right: 40, bottom: 22 } }],
      textRects: [{ text: "ab", rects: [{ left: -5, top: 10, right: 30, bottom: 26 }] }],
    });
    const ink = inkRectOf(root)!;
    expect(ink).toEqual({ left: -5, top: 2, right: 40, bottom: 26 });
  });

  it("无墨迹（空元素）返回 null", () => {
    const doc = document.implementation.createHTMLDocument("t");
    const el = doc.createElement("div");
    doc.body.appendChild(el);
    expect(inkRectOf(el)).toBeNull();
  });

  it("元素自身是 svg：自盒计入（querySelectorAll 不含自身）", () => {
    const doc = document.implementation.createHTMLDocument("t");
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    doc.body.appendChild(svg);
    injectGeometry({
      elRects: [{ match: (el) => el === svg, rect: { left: 3, top: 4, right: 9, bottom: 12 } }],
    });
    expect(inkRectOf(svg)).toEqual({ left: 3, top: 4, right: 9, bottom: 12 });
  });
});

describe("padAndClampInkRect", () => {
  it("四边外扩护量，横向钳在版心内", () => {
    const r = padAndClampInkRect({ left: 10, top: 100, right: 200, bottom: 150 }, 680);
    expect(r.x).toBeCloseTo(10 - INK_PAD_PX, 5);
    expect(r.w).toBeCloseTo(190 + 2 * INK_PAD_PX, 5);
    expect(r.y).toBeCloseTo(100 - INK_PAD_PX, 5);
    expect(r.h).toBeCloseTo(50 + 2 * INK_PAD_PX, 5);
    // 左越界 → 钳 0；右越界 → 钳 680
    const c = padAndClampInkRect({ left: -20, top: 0, right: 900, bottom: 10 }, 680);
    expect(c.x).toBe(0);
    expect(c.x + c.w).toBe(680);
  });
});

// ---------------------------------------------------------------------------
// Fix-A：块级公式原子分页（keepTogether）。
// ---------------------------------------------------------------------------
describe("measureBlocks：md-math-block 原子分页（MC Fix-A）", () => {
  const setup = (rectHeight: number) => {
    const doc = document.implementation.createHTMLDocument("fac");
    const content = doc.createElement("div");
    const math = doc.createElement("div");
    math.className = "md-math-block";
    math.textContent = "∑公式";
    content.appendChild(math);
    doc.body.appendChild(content);
    const vpTop = 50;
    injectGeometry({
      elRects: [
        { match: (el) => el === content, rect: { left: 0, top: vpTop, right: 680, bottom: vpTop + 2000 } },
        { match: (el) => el === math, rect: { left: 0, top: vpTop + 400, right: 680, bottom: vpTop + 400 + rectHeight } },
      ],
      // 行盒：墨迹上溢 5px（vlist 零高盒形态）
      textRects: [{ text: "∑公式", rects: [{ left: 10, top: vpTop + 395, right: 300, bottom: vpTop + 400 + rectHeight - 4 }] }],
    });
    return { handle: mkHandle(doc, content), math };
  };

  it("公式块标记 keepTogether 且行盒照常测量（墨迹链仍成立）", () => {
    const { handle } = setup(100);
    const blocks = measureBlocks(handle, { contentHeightPx: 1009 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].keepTogether).toBe(true);
    expect(blocks[0].lines!.length).toBeGreaterThan(0);
  });

  it("高于一页的公式块放行按行切分（完整性优先）", () => {
    const { handle } = setup(1400);
    const blocks = measureBlocks(handle, { contentHeightPx: 1009 });
    expect(blocks[0].keepTogether).toBeUndefined();
  });

  it("不传 contentHeightPx（调试/AB 路径）：保持原子", () => {
    const { handle } = setup(1400);
    expect(measureBlocks(handle)[0].keepTogether).toBe(true);
  });

  it("普通段落不受影响（无 keepTogether）", () => {
    const doc = document.implementation.createHTMLDocument("fac");
    const content = doc.createElement("div");
    const p = doc.createElement("p");
    p.textContent = "正文";
    content.appendChild(p);
    doc.body.appendChild(content);
    injectGeometry({
      elRects: [
        { match: (el) => el === content, rect: { left: 0, top: 0, right: 680, bottom: 2000 } },
        { match: (el) => el === p, rect: { left: 0, top: 0, right: 680, bottom: 44 } },
      ],
      textRects: [{ text: "正文", rects: [{ left: 0, top: 4, right: 40, bottom: 24 }] }],
    });
    expect(measureBlocks(mkHandle(doc, content), { contentHeightPx: 1009 })[0].keepTogether).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fix-B：补丁矩形 = 元素盒 ∪ 墨迹盒（+护量，横向钳版心）。
// ---------------------------------------------------------------------------
describe("collectPatchPlan：公式补丁墨迹覆盖（MC Fix-B）", () => {
  const setup = () => {
    const doc = document.implementation.createHTMLDocument("fac");
    const content = doc.createElement("div");
    const math = doc.createElement("div");
    math.className = "md-math-block";
    const display = doc.createElement("span");
    display.className = "katex-display";
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    display.appendChild(svg);
    math.appendChild(display);
    content.appendChild(math);
    doc.body.appendChild(content);
    const vpTop = 30;
    const blockRect = { left: 0, top: vpTop + 400, right: 680, bottom: vpTop + 500 }; // 布局盒
    const inkRect = { left: 200, top: vpTop + 395, right: 480, bottom: vpTop + 505 }; // 墨迹上溢 5 下溢 5
    injectGeometry({
      elRects: [
        { match: (el) => el === content, rect: { left: 0, top: vpTop, right: 680, bottom: vpTop + 2000 } },
        { match: (el) => el === math, rect: blockRect },
        { match: (el) => el === svg, rect: inkRect },
      ],
    });
    return { handle: mkHandle(doc, content), math };
  };

  it("块补丁覆盖墨迹越盒区（含 svg 的块：并集 + 护量）", () => {
    const { handle, math } = setup();
    // 顶层 kid 是含 svg 的块 → 块补丁；矩形应覆盖 [395-护量, 505+护量]
    const plan = collectPatchPlan(handle);
    expect(plan.blockPatches).toHaveLength(1);
    const p = plan.blockPatches[0];
    expect(p.y).toBeLessThanOrEqual(400 - 5);
    expect(p.y + p.h).toBeGreaterThanOrEqual(500 + 5);
    expect(math).toBeTruthy();
  });

  it("纯 pre 块（无 katex/svg）保持元素盒原语义（零开销路径）", () => {
    const doc = document.implementation.createHTMLDocument("fac");
    const content = doc.createElement("div");
    const pre = doc.createElement("pre");
    pre.textContent = "code line";
    content.appendChild(pre);
    doc.body.appendChild(content);
    injectGeometry({
      elRects: [
        { match: (el) => el === content, rect: { left: 0, top: 0, right: 680, bottom: 2000 } },
        { match: (el) => el === pre, rect: { left: 0, top: 100, right: 680, bottom: 200 } },
      ],
    });
    const plan = collectPatchPlan(mkHandle(doc, content));
    expect(plan.blockPatches).toEqual([{ x: 0, y: 100, w: 680, h: 100 }]);
  });

  it("行内公式补丁覆盖越盒墨迹（上 24px/下 14px 形态）", () => {
    const doc = document.implementation.createHTMLDocument("fac");
    const content = doc.createElement("div");
    const p = doc.createElement("p");
    p.textContent = "段";
    const span = doc.createElement("span");
    span.setAttribute("data-type", "math_inline");
    const katex = doc.createElement("span");
    katex.className = "katex";
    katex.textContent = "F"; // 行内公式字形
    span.appendChild(katex);
    p.appendChild(span);
    content.appendChild(p);
    doc.body.appendChild(content);
    const vpTop = 10;
    injectGeometry({
      elRects: [
        { match: (el) => el === content, rect: { left: 0, top: vpTop, right: 680, bottom: vpTop + 2000 } },
        { match: (el) => el === p, rect: { left: 0, top: vpTop + 100, right: 680, bottom: vpTop + 140 } },
        // .katex 布局盒（40~64）；墨迹（Range）上溢 24、下溢 14
        { match: (el) => el === katex, rect: { left: 100, top: vpTop + 40, right: 160, bottom: vpTop + 64 } },
      ],
      textRects: [{ text: "F", rects: [{ left: 100, top: vpTop + 16, right: 160, bottom: vpTop + 78 }] }],
    });
    const plan = collectPatchPlan(mkHandle(doc, content));
    expect(plan.inlinePatches).toHaveLength(1);
    const patch = plan.inlinePatches[0];
    // 补丁顶 ≤ 墨迹顶（墨迹 viewport 顶 16+vpTop=26 → content 相对 16），底 ≥ 墨迹底（88−10=78）
    expect(patch.y).toBeLessThanOrEqual(16 + 0.01);
    expect(patch.y + patch.h).toBeGreaterThanOrEqual(78 - 0.01);
  });
});

// ---------------------------------------------------------------------------
// Fix-C：超宽公式缩放归一（exportRenderFactory）。
// ---------------------------------------------------------------------------
describe("normalizeOverwideMath（MC Fix-C）", () => {
  const setup = (inkWidth: number) => {
    const doc = document.implementation.createHTMLDocument("fac");
    const content = doc.createElement("div");
    const math = doc.createElement("div");
    math.className = "md-math-block";
    const display = doc.createElement("span");
    display.className = "katex-display";
    const inner = doc.createElement("span");
    inner.className = "katex";
    inner.textContent = "W";
    display.appendChild(inner);
    math.appendChild(display);
    content.appendChild(math);
    doc.body.appendChild(content);
    const vpTop = 0;
    const boxW = 680;
    const inkLeft = 0;
    injectGeometry({
      elRects: [
        { match: (el) => el === content, rect: { left: 0, top: vpTop, right: boxW, bottom: vpTop + 2000 } },
        { match: (el) => el === display, rect: { left: 0, top: vpTop + 100, right: boxW, bottom: vpTop + 150 } },
        { match: (el) => el === inner, rect: { left: 0, top: vpTop + 100, right: boxW, bottom: vpTop + 150 } },
      ],
      textRects: [
        { text: "W", rects: [{ left: inkLeft, top: vpTop + 105, right: inkLeft + inkWidth, bottom: vpTop + 145 }] },
      ],
    });
    return { content, inner, display };
  };

  it("超宽 display 公式：内层缩放（scale<1）+ 高度补偿；中点平移对齐版心", () => {
    const { content, inner, display } = setup(1083); // 版心 680
    const n = normalizeOverwideMath(content);
    expect(n).toBe(1);
    const m = /scale\(([\d.]+)\)/.exec(inner.style.transform ?? "");
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeCloseTo(680 / 1083, 3);
    expect(inner.style.transformOrigin).toBeTruthy();
    expect(display.style.height).toBeTruthy();
    // 平移 dx = 版心中点 − 墨迹中点（0+340 − 541.5 = −201.5）
    const dx = /translate\((-?[\d.]+)px/.exec(inner.style.transform ?? "");
    expect(Number(dx![1])).toBeCloseTo(-201.5, 1);
  });

  it("版心内公式：零改动", () => {
    const { content, inner } = setup(300);
    expect(normalizeOverwideMath(content)).toBe(0);
    expect(inner.style.transform).toBe("");
  });

  it("超宽行内公式（非 display 内）：锚左下角缩放、不动高度", () => {
    const doc = document.implementation.createHTMLDocument("fac");
    const content = doc.createElement("div");
    const p = doc.createElement("p");
    const katex = doc.createElement("span");
    katex.className = "katex";
    katex.textContent = "L";
    p.appendChild(katex);
    content.appendChild(p);
    doc.body.appendChild(content);
    injectGeometry({
      elRects: [
        { match: (el) => el === content, rect: { left: 0, top: 0, right: 680, bottom: 2000 } },
        { match: (el) => el === katex, rect: { left: 0, top: 40, right: 100, bottom: 64 } },
      ],
      textRects: [{ text: "L", rects: [{ left: 0, top: 20, right: 800, bottom: 78 }] }],
    });
    const n = normalizeOverwideMath(content);
    expect(n).toBe(1);
    expect(katex.style.transform).toContain("scale(0.85"); // 680/800
    // 行内锚左下：origin y = 墨迹底 78 − 盒底 64 = 14
    expect(katex.style.transformOrigin).toContain("14px");
  });
});

// ---------------------------------------------------------------------------
// 工厂 CSS：无滚动媒体面（代码回行/表格/svg 钳宽）。
// ---------------------------------------------------------------------------
describe("buildFactoryDocumentHtml：无滚动媒体规则（MC Fix-C）", () => {
  it("pre 按字符回行、表格钳版心、svg max-width——PDF/PNG 工厂注入", () => {
    const html = buildFactoryDocumentHtml("<p>x</p>", { contentWidthPx: 680, css: "" });
    expect(html).toContain(".vditor-reset pre { white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: visible; }");
    expect(html).toContain(".vditor-reset table { max-width: 100%; }");
    expect(html).toContain(".vditor-reset svg { max-width: 100%; }");
  });
});

// ---------------------------------------------------------------------------
// DOCX 栅格化墨盒（exportMath.rasterizeFormulas）：包裹壳内边距覆盖墨迹越盒。
// ---------------------------------------------------------------------------
describe("rasterizeFormulas：墨迹盒外扩（MC Fix-B DOCX 面）", () => {
  it("包裹壳内边距 = 墨迹越盒量 + 护量；栅格化窗口用壳尺寸", async () => {
    const domToPng = vi.fn(
      async (_el: unknown, _o?: { width?: number; height?: number }) =>
        "data:image/png;base64,AAAA"
    );
    vi.doMock("modern-screenshot", () => ({ domToPng }));
    const { rasterizeFormulas } = await import("./exportMath");
    const doc = document;
    const host = doc.createElement("div");
    doc.body.appendChild(host);
    restoreFns.push(() => host.remove());
    // 行内高公式：布局盒 [0,40,120,64]；墨迹（Range）上溢 24、下溢 14
    const span = doc.createElement("span");
    span.setAttribute("data-type", "math_inline");
    span.className = "k";
    span.textContent = "T";
    host.appendChild(span);
    const origGBCR = Element.prototype.getBoundingClientRect;
    (Element.prototype as unknown as Record<string, unknown>).getBoundingClientRect =
      function (this: Element) {
        // 公式节点（rasterizeFormulas 内部重解析 HTML，克隆体与原 span 不同一
        // ——按属性匹配）：布局盒 [0,40,120,64]
        if ((this as HTMLElement).getAttribute?.("data-type") === "math_inline") {
          return { left: 0, top: 40, right: 120, bottom: 64, width: 120, height: 24, x: 0, y: 40, toJSON: () => ({}) };
        }
        // 包裹壳（cssText 含 inline-block）：读取发生在 padding 写入之后——
        // 按「布局盒 + padding」回放（jsdom 会把四值 padding 规范化成
        // 三值/两值形态，解析按 CSS 1-4 值语义展开）
        if ((this as HTMLElement).style?.cssText?.includes("inline-block")) {
          const v = ((this as HTMLElement).style.padding.match(/(-?[\d.]+)px/g) ?? []).map((s) =>
            Number(s.replace("px", ""))
          );
          const [a = 0, b = a, c = a, d = b] = v; // top right bottom left
          return {
            left: 0 - d, top: 40 - a, right: 120 + b, bottom: 64 + c,
            width: 120 + b + d, height: 24 + a + c,
            x: 0, y: 40 - a, toJSON: () => ({}),
          };
        }
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
      };
    const origGCR = Range.prototype.getClientRects;
    (Range.prototype as unknown as Record<string, unknown>).getClientRects =
      function () {
        return [{ left: 0, top: 16, right: 120, bottom: 78, width: 120, height: 62, x: 0, y: 16, toJSON: () => ({}) }];
      };
    restoreFns.push(() => {
      (Element.prototype as unknown as Record<string, unknown>).getBoundingClientRect = origGBCR;
      (Range.prototype as unknown as Record<string, unknown>).getClientRects = origGCR;
      vi.doUnmock("modern-screenshot");
    });
    const out = await rasterizeFormulas(host.innerHTML);
    expect(domToPng).toHaveBeenCalled();
    const arg = domToPng.mock.calls[0]?.[1];
    // 栅格化窗口 = 壳（布局盒 + 墨迹越盒 24/14/0/0 + 各向护量 3）
    expect(arg?.width).toBe(120 + 2 * INK_PAD_PX);
    expect(arg?.height).toBe(24 + 24 + 14 + 2 * INK_PAD_PX);
    expect(out).toContain("<img");
  });
});
