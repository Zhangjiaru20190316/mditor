// RV 轮阶段二纯逻辑单测：装饰页映射（裁剪 + 跨页表格断口补线）、下划线/
// 删除线几何。断页补线是验收硬条款（跨页表格断口闭合）的计算面。

import { describe, expect, it } from "vitest";
import {
  clipLineToWindow,
  decorationLineGeometry,
  decorationsToPageDecos,
} from "./exportVectorDecor";

const C = { r: 200, g: 200, b: 200 };

describe("clipLineToWindow", () => {
  it("完全在窗口内：原样；跨界：clamp 到窗口", () => {
    expect(clipLineToWindow(10, 20, 0, 100)).toEqual([10, 20]);
    expect(clipLineToWindow(-10, 50, 0, 100)).toEqual([0, 50]);
    expect(clipLineToWindow(80, 150, 0, 100)).toEqual([80, 100]);
    expect(clipLineToWindow(150, 200, 0, 100)).toBeNull();
  });

  it("边界刀口（y 恰在窗口边）：含入（断口补线两侧页都要画）", () => {
    expect(clipLineToWindow(100, 100, 0, 100)).toEqual([100, 100]);
    expect(clipLineToWindow(100, 120, 100, 200)).toEqual([100, 120]);
  });
});

describe("decorationsToPageDecos", () => {
  it("rect 跨页切开：两页各得可见段（引用块跨页）", () => {
    const pages = [
      { top: 0, bottom: 100 },
      { top: 100, bottom: 200 },
    ];
    const out = decorationsToPageDecos(
      { rects: [{ x: 10, y: 50, w: 300, h: 120, color: C }], lines: [], tables: [] },
      pages
    );
    expect(out[0].rects).toEqual([{ x: 10, y: 50, w: 300, h: 50, color: C }]);
    expect(out[1].rects).toEqual([{ x: 10, y: 0, w: 300, h: 70, color: C }]);
  });

  it("竖线跨页切开（单元格右边线）：两页各得可见段", () => {
    const pages = [
      { top: 0, bottom: 100 },
      { top: 100, bottom: 200 },
    ];
    const out = decorationsToPageDecos(
      { rects: [], lines: [{ x1: 50, y1: 30, x2: 50, y2: 150, width: 1, color: C }], tables: [] },
      pages
    );
    expect(out[0].lines[0]).toMatchObject({ y1: 30, y2: 100 });
    expect(out[1].lines[0]).toMatchObject({ y1: 0, y2: 50 });
  });

  it("跨页表格断口补线：刀口切在表格纵向范围内 → 两侧页切口各补一条横线", () => {
    const pages = [
      { top: 0, bottom: 100 },
      { top: 100, bottom: 200 },
      { top: 200, bottom: 300 },
    ];
    const out = decorationsToPageDecos(
      {
        rects: [],
        lines: [],
        tables: [{ x1: 10, x2: 400, top: 40, bottom: 260, borderWidth: 1, color: C }],
      },
      pages
    );
    // 页 0 底刀口 100：补线在 y=100（页内坐标 = 100）
    const p0cut = out[0].lines.find((l) => l.y1 === 100 && l.x1 === 10 && l.x2 === 400);
    expect(p0cut).toBeTruthy();
    // 页 1 顶刀口 100：补线在 y=0（页内坐标）；底刀口 200：y=100
    const p1top = out[1].lines.find((l) => l.y1 === 0 && l.x1 === 10);
    const p1bot = out[1].lines.find((l) => l.y1 === 100 && l.x1 === 10);
    expect(p1top).toBeTruthy();
    expect(p1bot).toBeTruthy();
    // 页 2 顶刀口 200：y=0
    const p2top = out[2].lines.find((l) => l.y1 === 0 && l.x1 === 10);
    expect(p2top).toBeTruthy();
  });

  it("刀口在表格范围外（表首/表尾外）不补线；页 0 顶/末页底不是刀口不补", () => {
    const pages = [
      { top: 0, bottom: 100 },
      { top: 100, bottom: 200 },
    ];
    const out = decorationsToPageDecos(
      {
        rects: [],
        lines: [],
        // 表格只占 [40, 80]，完全在页 0 内 → 无任何刀口切进表格
        tables: [{ x1: 10, x2: 400, top: 40, bottom: 80, borderWidth: 1, color: C }],
      },
      pages
    );
    expect(out[0].lines).toHaveLength(0);
    expect(out[1].lines).toHaveLength(0);
  });
});

describe("decorationLineGeometry（近似位）", () => {
  it("underline 在基线下 0.10em；line-through 在基线上 0.30em；线宽下限 1px", () => {
    const u = decorationLineGeometry(100, 16, "underline");
    expect(u.y).toBeCloseTo(101.6, 5);
    const s = decorationLineGeometry(100, 16, "line-through");
    expect(s.y).toBeCloseTo(95.2, 5);
    const thin = decorationLineGeometry(100, 8, "underline");
    expect(thin.thickness).toBe(1); // max(1, 8*0.047=0.376)
    const big = decorationLineGeometry(100, 40, "underline");
    expect(big.thickness).toBeCloseTo(40 * 0.047, 5);
  });
});
