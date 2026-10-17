// PDF 管线纯函数面单测（EX 轮阶段三）：纸张数学 / 片段→页窗口归属 /
// dataURL 字节。布局依赖面（测量/光栅/组装编排）由 dev 实例 CDP 验收
// （perf/ex3-*）。

// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import {
  PDF_PAPERS,
  blockIntersectsWindow,
  dataUrlToBytes,
  fragmentsToPageRuns,
  measureBlocks,
  mmToPt,
  pageSlicePlan,
  pageSliceSourceY,
  pearsonBestLag,
  type PdfExportProgress,
} from "./exportPdfPipeline";
import type { PageWindow } from "./exportPaginator";
import type { RenderFactoryHandle } from "./exportRenderFactory";

// ---------------------------------------------------------------------------
// HX P-α 回归锚定：measureBlocks 行盒坐标系。
// 缺陷形态（8da2982 定罪）：lineBoxes/tableRows 用视口绝对 rect 减 content
// 相对 blockTop——content 容器视口原点 ≠ 0（首块塌陷 margin 等）时行盒整体
// 偏移，分页刀口切进视觉行内部。测试注入「视口原点=100」的几何，断言行盒
// 回到 content 相对坐标。
// ---------------------------------------------------------------------------

interface FakeGeometry {
  /** content 容器的视口顶（缺陷触发条件：≠0）。 */
  contentViewportTop: number;
  /** P 块相对 content 的顶。 */
  blockTopRel: number;
  /** 文本行矩形（相对 P 顶）[top, bottom][]。 */
  lineRectsRel: Array<[number, number]>;
}

/** 最小工厂句柄 + 原型级 rect 注入（jsdom 无布局，视口系 rect 全部可控）。 */
function fakeFactory(g: FakeGeometry): RenderFactoryHandle {
  const doc = document.implementation.createHTMLDocument("fac");
  const content = doc.createElement("div");
  const p = doc.createElement("p");
  p.textContent = "第一行 第二行";
  content.appendChild(p);
  doc.body.appendChild(content);
  const vpTop = g.contentViewportTop;
  const blockVpTop = vpTop + g.blockTopRel;
  const lineBottomRel = Math.max(...g.lineRectsRel.map(([, b]) => b));
  const rectsFor = () =>
    g.lineRectsRel.map(([t, b]) => ({
      top: blockVpTop + t,
      bottom: blockVpTop + b,
      height: b - t,
      width: 40,
      left: 0,
      right: 40,
      x: 0,
      y: blockVpTop + t,
      toJSON: () => ({}),
    }));
  const origGBCR = Element.prototype.getBoundingClientRect;
  const origGCR = Range.prototype.getClientRects;
  (Element.prototype as unknown as Record<string, unknown>).getBoundingClientRect =
    function (this: Element) {
      if (this === content) {
        return { top: vpTop, bottom: vpTop + 1000, height: 1000, width: 680, left: 0, right: 680, x: 0, y: vpTop, toJSON: () => ({}) };
      }
      if (this === p) {
        return { top: blockVpTop, bottom: blockVpTop + lineBottomRel + 16, height: lineBottomRel + 16, width: 680, left: 0, right: 680, x: 0, y: blockVpTop, toJSON: () => ({}) };
      }
      return { top: 0, bottom: 0, height: 0, width: 0, left: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) };
    };
  (Range.prototype as unknown as Record<string, unknown>).getClientRects =
    function () {
      return rectsFor();
    };
  restoreFns.push(() => {
    (Element.prototype as unknown as Record<string, unknown>).getBoundingClientRect = origGBCR;
    (Range.prototype as unknown as Record<string, unknown>).getClientRects = origGCR;
  });
  return {
    iframe: {} as HTMLIFrameElement,
    doc,
    content,
    issues: [],
    timedOut: false,
    destroy: () => {},
  } as unknown as RenderFactoryHandle;
}

const restoreFns: Array<() => void> = [];
afterEach(() => {
  while (restoreFns.length) restoreFns.pop()!();
});

// HX P-γ 回归锚定：KaTeX vlist 零高盒的墨迹会超出块 border 盒（实测上溢
// 3.2px）；块间刀口落在下一块 border 顶时切进上溢墨迹。修复语义：块坐标
// 基准重定到「墨迹顶」（min(border 顶, 首行盒顶)），高度链随之 ink 对齐。
describe("measureBlocks 墨迹感知 rebase（HX P-γ：块首墨迹上溢不出刀）", () => {
  it("下一块首行墨迹上溢 border 顶：高度链覆盖到墨迹顶，行盒 rel 到墨迹基", () => {
    const doc = document.implementation.createHTMLDocument("fac");
    const content = doc.createElement("div");
    const pa = doc.createElement("p");
    pa.textContent = "前块";
    const pb = doc.createElement("p");
    pb.textContent = "含公式行";
    content.append(pa, pb);
    doc.body.appendChild(content);
    const vpTop = 100;
    const aBorder = vpTop + 400;
    const bBorder = vpTop + 500;
    const OVER = 3.2; // 公式墨迹上溢
    const origGBCR = Element.prototype.getBoundingClientRect;
    (Element.prototype as unknown as Record<string, unknown>).getBoundingClientRect =
      function (this: Element) {
        if (this === content) {
          return { top: vpTop, bottom: vpTop + 1000, height: 1000, width: 680, left: 0, right: 680, x: 0, y: vpTop, toJSON: () => ({}) };
        }
        if (this === pa) {
          return { top: aBorder, bottom: aBorder + 44, height: 44, width: 680, left: 0, right: 680, x: 0, y: aBorder, toJSON: () => ({}) };
        }
        if (this === pb) {
          return { top: bBorder, bottom: bBorder + 44, height: 44, width: 680, left: 0, right: 680, x: 0, y: bBorder, toJSON: () => ({}) };
        }
        return { top: 0, bottom: 0, height: 0, width: 0, left: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) };
      };
    const origGCR = Range.prototype.getClientRects;
    (Range.prototype as unknown as Record<string, unknown>).getClientRects =
      function (this: Range) {
        const node = this.startContainer;
        const t = node.textContent ?? "";
        // 前块行 [4,24]；后块首行墨迹 [−3.2, 20]（上溢 border 顶）
        if (t === "前块") {
          return [{ top: aBorder + 4, bottom: aBorder + 24, height: 20, width: 40, left: 0, right: 40, x: 0, y: aBorder + 4, toJSON: () => ({}) }];
        }
        return [{ top: bBorder - OVER, bottom: bBorder + 20, height: 20 + OVER, width: 40, left: 0, right: 40, x: 0, y: bBorder - OVER, toJSON: () => ({}) }];
      };
    restoreFns.push(() => {
      (Element.prototype as unknown as Record<string, unknown>).getBoundingClientRect = origGBCR;
      (Range.prototype as unknown as Record<string, unknown>).getClientRects = origGCR;
    });
    const h = { iframe: {}, doc, content, issues: [], timedOut: false, destroy: () => {} } as unknown as RenderFactoryHandle;
    const blocks = measureBlocks(h);
    // 高度链：块 A 高度覆盖到块 B 墨迹顶（500−3.2），不再止于 B border 顶
    expect(blocks[0].height).toBeCloseTo(96.8, 5);
    // 块 B 行盒 rel 到墨迹基（首行 top=0），行盒底含自适应护量（末行 +4）
    expect(blocks[1].lines![0].top).toBeCloseTo(0, 5);
    expect(blocks[1].lines![0].height).toBeCloseTo(27.2, 5);
  });
});

describe("measureBlocks 行盒坐标系（HX P-α 回归：视口 rect → content 相对）", () => {
  it("content 视口原点≠0 时行盒不随偏移（demo 实测几何：原点 21.4/两行 [4,24]+[32,52]）", () => {
    const h = fakeFactory({
      contentViewportTop: 21.4,
      blockTopRel: 945.9,
      lineRectsRel: [
        [4, 24],
        [32, 52],
      ],
    });
    const blocks = measureBlocks(h);
    expect(blocks).toHaveLength(1);
    // 行盒底含自适应墨迹护量（P-γ 补全：间隙 8px → 首行 +3.75、末行 +4）
    expect(blocks[0].lines).toEqual([
      { top: 4, height: 23.75 },
      { top: 32, height: 24 },
    ]);
  });

  it("视口原点=0（旧隐含假设）结果不变——修复对既有几何零扰动", () => {
    const h = fakeFactory({
      contentViewportTop: 0,
      blockTopRel: 945.9,
      lineRectsRel: [
        [4, 24],
        [32, 52],
      ],
    });
    const blocks = measureBlocks(h);
    expect(blocks[0].lines).toEqual([
      { top: 4, height: 23.75 },
      { top: 32, height: 24 },
    ]);
  });

  it("表格行盒同款坐标系（行 rect 视口系 → content 相对，不加墨迹护量）", () => {
    const doc = document.implementation.createHTMLDocument("fac");
    const content = doc.createElement("div");
    const table = doc.createElement("table");
    const tr1 = doc.createElement("tr");
    const tr2 = doc.createElement("tr");
    table.append(tr1, tr2);
    content.appendChild(table);
    doc.body.appendChild(content);
    const vpTop = 33.3;
    const blockVpTop = vpTop + 500;
    const origGBCR = Element.prototype.getBoundingClientRect;
    (Element.prototype as unknown as Record<string, unknown>).getBoundingClientRect =
      function (this: Element) {
        if (this === content) {
          return { top: vpTop, bottom: vpTop + 1000, height: 1000, width: 680, left: 0, right: 0, x: 0, y: vpTop, toJSON: () => ({}) };
        }
        if (this === table) {
          return { top: blockVpTop, bottom: blockVpTop + 60, height: 60, width: 680, left: 0, right: 680, x: 0, y: blockVpTop, toJSON: () => ({}) };
        }
        if (this === tr1) {
          return { top: blockVpTop, bottom: blockVpTop + 30, height: 30, width: 680, left: 0, right: 680, x: 0, y: blockVpTop, toJSON: () => ({}) };
        }
        if (this === tr2) {
          return { top: blockVpTop + 30, bottom: blockVpTop + 60, height: 30, width: 680, left: 0, right: 680, x: 0, y: blockVpTop + 30, toJSON: () => ({}) };
        }
        return { top: 0, bottom: 0, height: 0, width: 0, left: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) };
      };
    restoreFns.push(() => {
      (Element.prototype as unknown as Record<string, unknown>).getBoundingClientRect = origGBCR;
    });
    const h = { iframe: {}, doc, content, issues: [], timedOut: false, destroy: () => {} } as unknown as RenderFactoryHandle;
    const blocks = measureBlocks(h);
    // vpTop=33.3 引入浮点 epsilon：语义断言用 toBeCloseTo（偏移量级 ≫ 1e-6）。
    expect(blocks[0].rows).toHaveLength(2);
    expect(blocks[0].rows![0].top).toBeCloseTo(0, 6);
    expect(blocks[0].rows![0].height).toBe(30);
    expect(blocks[0].rows![1].top).toBeCloseTo(30, 6);
    expect(blocks[0].rows![1].height).toBe(30);
  });
});

describe("pageSliceSourceY（HX P-β 回归：变高页切片位 = 页真实窗口顶）", () => {
  it("chunk 内页高不齐（首页提前收尾）时切片位跟随页顶，不按定高网格漂移", () => {
    // demo.md 实测几何：page1 只装到 991.3（split 后提前收尾），page2 从 991.3 续。
    // 旧网格切片给 [0, 1009, 2018]×scale——page2 起累计漂移 17.7px+。
    const chunkTop = 0;
    const tops = [0, 991.3, 1980.6];
    const scale = 2;
    expect(tops.map((t) => pageSliceSourceY(t, chunkTop, scale))).toEqual([
      0,
      1983, // round(991.3 × 2)——跟随真实页顶，而非 1009×2=2018
      3961,
    ]);
  });

  it("chunk 顶非 0（后续 chunk）：切片位相对本 chunk 首页顶", () => {
    // chunk1 首页 top=4036（chunk 边界重置），chunk 内页 [4036, 4894.1, 5859.5]
    const chunkTop = 4036;
    const tops = [4036, 4894.1, 5859.5];
    expect(tops.map((t) => pageSliceSourceY(t, chunkTop, 2))).toEqual([
      0,
      1716, // round(858.1 × 2)
      3647, // round(1823.5 × 2)
    ]);
  });

  it("整 chunk 页高恰满（无提前收尾）时与定高网格一致——旧正确场景零扰动", () => {
    const tops = [0, 1009, 2018, 3027];
    expect(tops.map((t) => pageSliceSourceY(t, 0, 2))).toEqual(
      tops.map((_, i) => Math.round(i * 1009 * 2))
    );
  });

  it("页切片计划按变高页拼接：相邻页 [sy, sy+sh) 连续零缝隙零重叠（无窗口重叠重复）", () => {
    // 变高页：page1 只到 991.3（提前收尾），page2 从 991.3 续，page3 到 1980.6。
    // 若每页仍取满 1009 高（窗口 [top, top+1009)），page1 与 page2 窗口重叠
    // 17.7px——重叠区内容跨页重复且页 1 底缘切在下页内容上。
    const pages: PageWindow[] = [
      { top: 0, bottom: 991.3, segments: [] },
      { top: 991.3, bottom: 1980.6, segments: [] },
      { top: 1980.6, bottom: 2989.6, segments: [] },
    ];
    const plan = pageSlicePlan(pages, 0, 2);
    // 拼接不变量：sy 逐页推进，且 sy_{i+1} = sy_i + sh_i（零缝隙零重叠）
    for (let i = 0; i + 1 < plan.length; i++) {
      expect(plan[i + 1].sy).toBe(plan[i].sy + plan[i].sh);
    }
    // 短页高度 = 拼接边差（round(991.3×2)=1983），不是满页 2018
    expect(plan[0].sh).toBe(1983);
    expect(plan[1].sh).toBe(1978); // round(1980.6×2)=3961 − 1983
    // 末页不足满高时按 bottom 截断（2989.6−1980.6=1009 恰满则满）
    expect(plan[2].sh).toBe(2018);
  });
});

describe("blockIntersectsWindow（分块序列化裁剪判定）", () => {
  it("窗口内/窗口外/骑线块：骑线必留（分页刀口可落在块内部）", () => {
    const wTop = 1000;
    const wBottom = 1000 + 4036;
    // 完全在窗口上方/下方 → 不留
    expect(blockIntersectsWindow(0, 100, wTop, wBottom)).toBe(false);
    expect(blockIntersectsWindow(wBottom + 500, wBottom + 600, wTop, wBottom)).toBe(false);
    // 完全在窗口内 → 留
    expect(blockIntersectsWindow(1200, 1300, wTop, wBottom)).toBe(true);
    // 骑上缘/骑下缘 → 留
    expect(blockIntersectsWindow(900, 1100, wTop, wBottom)).toBe(true);
    expect(blockIntersectsWindow(wBottom - 50, wBottom + 50, wTop, wBottom)).toBe(true);
    // 纯边接触（区间半开 + eps）→ 不留
    expect(blockIntersectsWindow(0, wTop, wTop, wBottom)).toBe(false);
    expect(blockIntersectsWindow(wBottom, wBottom + 10, wTop, wBottom)).toBe(false);
  });
});

describe("纸张数学", () => {
  it("mm→pt 换算（25.4mm = 72pt）", () => {
    expect(mmToPt(25.4)).toBeCloseTo(72, 5);
    expect(mmToPt(15)).toBeCloseTo(42.52, 2);
  });

  it("A4 内容盒（15mm 边距）≈ 680×958px（版心宽=纸宽−边距，构造无裁边）", () => {
    const marginPt = mmToPt(15);
    const w = (PDF_PAPERS.A4.widthPt - 2 * marginPt) / 0.75;
    const h = (PDF_PAPERS.A4.heightPt - 2 * marginPt) / 0.75;
    expect(Math.round(w)).toBeGreaterThan(600);
    expect(Math.round(w)).toBeLessThan(760);
    expect(Math.round(h)).toBeGreaterThan(900);
  });

  it("纸张表：Letter 短边 612pt、A3 长边 1190.55pt", () => {
    expect(PDF_PAPERS.Letter.widthPt).toBe(612);
    expect(PDF_PAPERS.A3.heightPt).toBeCloseTo(1190.55, 1);
  });
});

describe("fragmentsToPageRuns（页窗口二分归属）", () => {
  const pages: PageWindow[] = [
    { top: 0, bottom: 100, segments: [] },
    { top: 100, bottom: 200, segments: [] },
    { top: 200, bottom: 300, segments: [] },
  ];
  const frag = (over: {
    text: string;
    x: number;
    top: number;
    height: number;
    size: number;
    baselineY: number;
    advances: number[];
  }) => over;

  it("片段整行落在单页：唯一归属，基线换算为页内坐标", () => {
    const runs = fragmentsToPageRuns(
      [
        frag({
          text: "无穷级数",
          x: 20,
          top: 50,
          height: 20,
          size: 17,
          baselineY: 65,
          advances: [17, 17, 17, 17],
        }),
      ],
      pages,
      100
    );
    expect(runs[0]).toHaveLength(1);
    expect(runs[1]).toHaveLength(0);
    expect(runs[0][0]).toEqual({
      text: "无穷级数",
      x: 20,
      baselineY: 65,
      size: 17,
      advances: [17, 17, 17, 17],
    });
  });

  it("第二页片段：baselineY 减去页顶偏移", () => {
    const runs = fragmentsToPageRuns(
      [
        frag({
          text: "ab",
          x: 0,
          top: 150,
          height: 18,
          size: 16,
          baselineY: 163,
          advances: [8, 8],
        }),
      ],
      pages,
      100
    );
    expect(runs[1]).toHaveLength(1);
    expect(runs[1][0].baselineY).toBe(63);
    expect(runs[0]).toHaveLength(0);
  });

  it("页边界骑线片段（理论不出现，防浮点）：归属重叠最多的一页且只归一页", () => {
    const runs = fragmentsToPageRuns(
      [
        frag({
          text: "x",
          x: 0,
          top: 99.8,
          height: 18,
          size: 16,
          baselineY: 112,
          advances: [8],
        }),
      ],
      pages,
      100
    );
    const total = runs.reduce((n, r) => n + r.length, 0);
    expect(total).toBe(1);
  });

  it("大量片段不丢不重（计数守恒）", () => {
    const frags = Array.from({ length: 500 }, (_, i) =>
      frag({
        text: "行" + i,
        x: (i % 40) * 16,
        top: (i * 7) % 290,
        height: 18,
        size: 16,
        baselineY: ((i * 7) % 290) + 14,
        advances: [16, 16],
      })
    );
    const runs = fragmentsToPageRuns(frags, pages, 100);
    expect(runs.reduce((n, r) => n + r.length, 0)).toBe(500);
  });
});

describe("dataUrlToBytes", () => {
  it("解出原始字节（PNG 头四字节 0x89 50 4E 47）", () => {
    // 1×1 PNG。
    const url =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ";
    const b = dataUrlToBytes(url);
    expect(Array.from(b.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe("pearsonBestLag（调试 A/B 行剖面互相关）", () => {
  const mkProfile = (peaks: number[], n = 400): number[] => {
    const a = new Array<number>(n).fill(0);
    for (const p of peaks) for (let d = -2; d <= 2; d++) a[p + d] = 10 - Math.abs(d) * 2;
    return a;
  };

  it("b 比 a 整体下移 8px：lag=8 且 r≈1", () => {
    const a = mkProfile([50, 120, 210, 300]);
    const b = mkProfile([58, 128, 218, 308]);
    const r = pearsonBestLag(a, b, 24);
    expect(r.lag).toBe(8);
    expect(r.r).toBeGreaterThan(0.999);
  });

  it("零位移：lag=0 且 r=1", () => {
    const a = mkProfile([40, 130, 260]);
    expect(pearsonBestLag(a, a.slice(), 24)).toEqual({ lag: 0, r: 1 });
  });

  it("滞后超出搜索窗：不再强行对齐（|lag| ≤ maxLag 且 r 有界）", () => {
    const a = mkProfile([30, 200]);
    const b = mkProfile([130, 300]); // 下移 100px > maxLag 24
    const r = pearsonBestLag(a, b, 24);
    expect(Math.abs(r.lag)).toBeLessThanOrEqual(24);
    expect(r.r).toBeLessThan(0.5);
  });
});

// 进度面：类型契约编译即验证（此处仅引用防止未用告警）。
export type _ProgressSmoke = PdfExportProgress;
