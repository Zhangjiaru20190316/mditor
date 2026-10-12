// 自研分页器纯函数单测（EX 轮阶段三）：断点选择 / keep-together / 表格行断 /
// 孤儿寡妇 / 标题随文 / 续页恢复。全部合成数据（无 DOM）。

import { describe, expect, it } from "vitest";
import {
  MIN_SPLIT_LINES,
  paginateBlocks,
  type MeasuredBlock,
  type SplitLine,
} from "./exportPaginator";

/** n 行、每行高 lh 的可断段落块（块高 = n*lh，间距 0——纯数据约定）。 */
function para(blockId: number, lines: number, lh: number): MeasuredBlock {
  const ls: SplitLine[] = Array.from({ length: lines }, (_, i) => ({
    top: i * lh,
    height: lh,
  }));
  return { blockId, height: lines * lh, lines: ls, orphanControl: true };
}

/** n 行、每行高 rh 的表格块。 */
function table(blockId: number, rows: number, rh: number): MeasuredBlock {
  const rs: SplitLine[] = Array.from({ length: rows }, (_, i) => ({
    top: i * rh,
    height: rh,
  }));
  return { blockId, height: rows * rh, rows: rs };
}

function kt(blockId: number, height: number): MeasuredBlock {
  return { blockId, height, keepTogether: true };
}

/** 不变量：页窗口首尾衔接（下页 top = 上页 bottom），内容无丢失无重叠。 */
function assertContiguous(r: ReturnType<typeof paginateBlocks>): void {
  for (let i = 1; i < r.pages.length; i++) {
    expect(r.pages[i].top).toBeCloseTo(r.pages[i - 1].bottom, 6);
  }
}

describe("paginateBlocks 基础", () => {
  it("空内容 → 单空页（空文档导出一页白纸）", () => {
    const r = paginateBlocks([], 800);
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0].segments).toEqual([]);
    expect(r.stats.pages).toBe(1);
  });

  it("contentHeight 非正抛错（调用方契约）", () => {
    expect(() => paginateBlocks([para(1, 2, 20)], 0)).toThrow();
    expect(() => paginateBlocks([para(1, 2, 20)], -5)).toThrow();
  });

  it("全部放得下 → 单页整块", () => {
    const r = paginateBlocks([para(1, 10, 20), kt(2, 100), para(3, 5, 20)], 800);
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0].segments.map((s) => s.blockId)).toEqual([1, 2, 3]);
    expect(r.pages[0].segments[0]).toEqual({ blockId: 1, clipTop: 0, clipBottom: 200 });
    expect(r.stats.splits).toBe(0);
  });
});

describe("断页与续页", () => {
  it("溢出 → 两页，第二页从第一页刀口继续", () => {
    // 页高 100：块1（0..80）放下，块2（80..180）放不下 → 页1 只剩块1。
    const r = paginateBlocks([para(1, 8, 10), kt(2, 100)], 100);
    expect(r.pages).toHaveLength(2);
    assertContiguous(r);
    expect(r.pages[0].segments.map((s) => s.blockId)).toEqual([1]);
    expect(r.pages[1].segments.map((s) => s.blockId)).toEqual([2]);
    expect(r.stats.pushedKeepTogether).toBe(1);
  });

  it("长段落跨三页：行级断点 + 续页恢复（resume 不回卷）", () => {
    // 30 行 × 10px = 300px，页高 100 → 每页 10 行（无孤儿问题，行多）。
    const r = paginateBlocks([para(1, 30, 10)], 100);
    expect(r.pages).toHaveLength(3);
    assertContiguous(r);
    expect(r.stats.splits).toBe(2);
    expect(r.pages[0].segments[0]).toEqual({ blockId: 1, clipTop: 0, clipBottom: 100 });
    expect(r.pages[1].segments[0]).toEqual({ blockId: 1, clipTop: 100, clipBottom: 200 });
    expect(r.pages[2].segments[0]).toEqual({ blockId: 1, clipTop: 200, clipBottom: 300 });
  });

  it("keep-together 块永不内断（图/公式块语义）", () => {
    const r = paginateBlocks([para(1, 30, 10), kt(2, 50), para(3, 30, 10)], 100);
    for (const page of r.pages) {
      for (const seg of page.segments) {
        if (seg.blockId === 2) {
          expect(seg.clipTop).toBe(0);
          expect(seg.clipBottom).toBe(50);
        }
      }
    }
    // 块 2 独占性地完整出现在某一页。
    const p2 = r.pages.find((p) => p.segments.some((s) => s.blockId === 2));
    expect(p2).toBeDefined();
    assertContiguous(r);
  });

  it("表格按行断，不触发段落孤儿控制", () => {
    const r = paginateBlocks([table(1, 25, 10)], 100);
    expect(r.pages).toHaveLength(3);
    assertContiguous(r);
    expect(r.pages[1].segments[0].clipTop).toBe(100);
    expect(r.pages[1].segments[0].clipBottom).toBe(200);
    expect(r.stats.orphanWidowPushes).toBe(0);
  });
});

describe("孤儿寡妇控制", () => {
  it(`断后剩余 < ${MIN_SPLIT_LINES} 行 → 寡妇回收（刀口前移）`, () => {
    // 12 行 × 10，页高 105：第一刀拟切 10 行剩 2 行（合法）；页高 115 时
    // 拟切 11 行剩 1 行 → 回收到 10 行。
    const r = paginateBlocks([para(1, 12, 10)], 115);
    expect(r.pages).toHaveLength(2);
    assertContiguous(r);
    expect(r.pages[0].segments[0].clipBottom).toBe(100); // 而非 110
    expect(r.pages[1].segments[0]).toEqual({ blockId: 1, clipTop: 100, clipBottom: 120 });
  });

  it(`页尾只能挂 1 行 → 孤儿回收（整块/剩余段下移）`, () => {
    // 块1 90px + 块2（4 行 40px）：页高 100 → 块2 只能挂 1 行（10px）< 2 →
    // 块2 整体下移，页 1 仅块 1。
    const r = paginateBlocks([para(1, 9, 10), para(2, 4, 10)], 100);
    expect(r.pages[0].segments.map((s) => s.blockId)).toEqual([1]);
    expect(r.stats.orphanWidowPushes + r.stats.pushedKeepTogether).toBeGreaterThanOrEqual(1);
    assertContiguous(r);
  });

  it("短段落（≤3 行）宁可整块下移也不撕", () => {
    // 3 行段落：任何断法两侧都凑不足 2 行 → 整块放页 2。
    const r = paginateBlocks([para(1, 10, 10), para(2, 3, 10)], 105);
    const p1 = r.pages[0];
    // 页 1 不含块 2 的部分片段（要么没有，要么不可能只有 1 行）。
    const seg2 = p1.segments.find((s) => s.blockId === 2);
    if (seg2) expect(seg2.clipBottom - seg2.clipTop).toBe(30); // 整块
    else expect(r.stats.orphanWidowPushes).toBe(1);
    assertContiguous(r);
  });
});

describe("标题随文", () => {
  it("页尾孤标题 → 标题推下页", () => {
    // 块1 80px，标题 20px（80..100），正文 500px 放不下 → 标题应随正文下移。
    const blocks: MeasuredBlock[] = [
      para(1, 8, 10),
      { blockId: 2, height: 20, keepWithNext: true, keepTogether: true },
      para(3, 50, 10),
    ];
    const r = paginateBlocks(blocks, 100);
    expect(r.pages[0].segments.map((s) => s.blockId)).not.toContain(2);
    expect(r.stats.headingPushes).toBe(1);
    expect(r.pages[1].segments[0].blockId).toBe(2);
    assertContiguous(r);
  });

  it("标题 + 下块前两行放得下 → 不推（排版惯例）", () => {
    const blocks: MeasuredBlock[] = [
      para(1, 7, 10), // 70
      { blockId: 2, height: 20, keepWithNext: true, keepTogether: true }, // 70..90
      para(3, 50, 10), // 90..590：前两行 90..110 > 100 放不下？→ 推
    ];
    // 页高 100：标题底 90，正文前两行需到 110 > 100 → 推标题。
    const a = paginateBlocks(blocks, 100);
    expect(a.stats.headingPushes).toBe(1);
    // 页高 130：标题底 90 + 两行 = 110 ≤ 130 → 不推；正文可断，标题页带正文前几行。
    const b = paginateBlocks(blocks, 130);
    expect(b.stats.headingPushes).toBe(0);
    expect(b.pages[0].segments.slice(0, 2).map((s) => s.blockId)).toEqual([1, 2]);
    expect(b.pages[0].segments[2].blockId).toBe(3);
    expect(b.pages[0].segments[2].clipBottom).toBeGreaterThan(0);
    expect(b.stats.splits).toBeGreaterThan(0);
    assertContiguous(a);
    assertContiguous(b);
  });
});

describe("病态与鲁棒", () => {
  it("不可断块高于整页 → 独占页并标记 clipped（保进度不死循环）", () => {
    const r = paginateBlocks([para(1, 5, 10), kt(2, 250), para(3, 5, 10)], 100);
    expect(r.stats.clippedSegments).toBe(1);
    const p2 = r.pages.find((p) => p.segments.some((s) => s.blockId === 2));
    expect(p2?.segments).toEqual([{ blockId: 2, clipTop: 0, clipBottom: 250 }]);
    expect(r.pages[r.pages.length - 1].segments.some((s) => s.blockId === 3)).toBe(true);
    assertContiguous(r);
  });

  it("行高大于页高的可断块 → 逐行前进（每页至少一行）", () => {
    const big: MeasuredBlock = {
      blockId: 1,
      height: 3 * 50,
      lines: [
        { top: 0, height: 50 },
        { top: 50, height: 50 },
        { top: 100, height: 50 },
      ],
      orphanControl: true,
    };
    const r = paginateBlocks([big], 30);
    expect(r.pages.length).toBeLessThanOrEqual(3);
    expect(r.pages.length).toBeGreaterThanOrEqual(1);
    // 每页都前进。
    for (let i = 1; i < r.pages.length; i++) {
      expect(r.pages[i].top).toBeGreaterThan(r.pages[i - 1].top);
    }
  });

  it("大规模：2 万块 800 页量级不失控且不变量成立", () => {
    const blocks: MeasuredBlock[] = [];
    for (let i = 0; i < 20_000; i++) {
      blocks.push(i % 10 === 0 ? kt(i, 40 + (i % 7) * 3) : para(i, 3 + (i % 9), 12));
    }
    const r = paginateBlocks(blocks, 900);
    expect(r.stats.pages).toBeGreaterThan(50);
    assertContiguous(r);
    // 最后一块完整落在最后一页（C1「末块内容完整」的纯函数面）。
    const last = r.pages[r.pages.length - 1];
    const lastSeg = last.segments[last.segments.length - 1];
    expect(lastSeg.blockId).toBe(19_999);
    expect(lastSeg.clipBottom).toBe(blocks[19_999].height);
  });
});
