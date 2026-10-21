// RV 轮阶段三纯逻辑单测：补丁窗口放置（跨页切开）与纵向矩形合并
// （残留影子文本的补丁缝消除）。

import { describe, expect, it } from "vitest";
import {
  mergeRectsVertically,
  patchWindowSeg,
  patchesToPagePlacements,
  unionRects,
} from "./exportVectorPatch";

describe("patchWindowSeg", () => {
  it("窗口内/跨界/窗口外三分", () => {
    expect(patchWindowSeg(10, 10, 0, 100)).toEqual([10, 20]);
    expect(patchWindowSeg(-10, 60, 0, 100)).toEqual([0, 50]);
    expect(patchWindowSeg(80, 70, 0, 100)).toEqual([80, 100]);
    expect(patchWindowSeg(150, 50, 0, 100)).toBeNull();
  });

  it("边界含入（补丁恰起于刀口：续页从窗口顶起）", () => {
    expect(patchWindowSeg(100, 20, 100, 200)).toEqual([100, 120]);
    expect(patchWindowSeg(50, 50, 0, 100)).toEqual([50, 100]);
  });
});

describe("patchesToPagePlacements", () => {
  const pages = [
    { top: 0, bottom: 100 },
    { top: 100, bottom: 200 },
  ];

  it("公式块跨页：切给两页，页内坐标相对各自窗口顶", () => {
    const out = patchesToPagePlacements([{ x: 10, y: 60, w: 200, h: 100 }], pages);
    expect(out[0]).toEqual([{ x: 10, y: 60, w: 200, h: 40 }]);
    expect(out[1]).toEqual([{ x: 10, y: 0, w: 200, h: 60 }]);
  });

  it("零尺寸补丁丢弃；多补丁独立放置", () => {
    const out = patchesToPagePlacements(
      [
        { x: 0, y: 10, w: 0, h: 50 },
        { x: 5, y: 10, w: 30, h: 20 },
        { x: 5, y: 40, w: 30, h: 20 },
      ],
      pages
    );
    expect(out[0]).toHaveLength(2);
  });
});

describe("mergeRectsVertically", () => {
  it("纵向间隙 ≤6px 合并；>6px 分开；横向取并集", () => {
    const out = mergeRectsVertically(
      [
        { x: 0, y: 0, w: 50, h: 20 },
        { x: 100, y: 24, w: 50, h: 20 }, // 间隙 4 → 合并
        { x: 0, y: 80, w: 50, h: 20 }, // 间隙 36 → 分开
      ],
      6
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ x: 0, y: 0, w: 150, h: 44 });
    expect(out[1]).toEqual({ x: 0, y: 80, w: 50, h: 20 });
  });

  it("空数组与单矩形", () => {
    expect(mergeRectsVertically([])).toEqual([]);
    expect(mergeRectsVertically([{ x: 1, y: 2, w: 3, h: 4 }])).toEqual([
      { x: 1, y: 2, w: 3, h: 4 },
    ]);
  });
});

describe("unionRects", () => {
  it("并集盒", () => {
    expect(
      unionRects([
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 20, y: 5, w: 10, h: 30 },
      ])
    ).toEqual({ x: 0, y: 0, w: 30, h: 35 });
  });
});
