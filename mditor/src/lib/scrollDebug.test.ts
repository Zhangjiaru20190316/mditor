import { afterEach, describe, expect, it } from "vitest";
import {
  classifyPmBatch,
  diffBlocks,
  scrollCount,
  scrollCounters,
  scrollDebugClear,
  scrollEmit,
  scrollEvents,
  scrollSubscribe,
  type BlockRow,
} from "./scrollDebug";

afterEach(() => scrollDebugClear());

describe("scrollDebug event bus", () => {
  it("counts and buffers events, capacity-capped", () => {
    scrollCount("a.b", 2);
    scrollEmit("x.y", "hello", { data: { id: 1 } });
    expect(scrollCounters()).toEqual({ "a.b": 2, "x.y": 1 });
    expect(scrollEvents()).toHaveLength(1);
    expect(scrollEvents()[0].msg).toBe("hello");
    for (let i = 0; i < 400; i++) scrollEmit("bulk", `e${i}`);
    expect(scrollEvents().length).toBeLessThanOrEqual(300);
    expect(scrollEvents().at(-1)?.msg).toBe("e399");
  });

  it("notifies subscribers and drops throwing ones", () => {
    let got = 0;
    const bad = () => {
      throw new Error("boom");
    };
    scrollSubscribe(bad);
    const good = () => got++;
    const unsub = scrollSubscribe(good);
    scrollEmit("k", "m");
    expect(got).toBe(1);
    unsub();
    scrollEmit("k", "m");
    expect(got).toBe(1);
  });
});

describe("diffBlocks（layout:block 块级归因）", () => {
  const rows = (...hs: number[]): BlockRow[] =>
    hs.map((h) => ({ el: { tag: `el-${Math.random()}` } as unknown as Element, h }));
  const withEl = (el: unknown, h: number): BlockRow => ({
    el: el as Element,
    h,
  });

  it("reports height changes for identity-stable rows only", () => {
    const a = rows(100, 200, 300);
    const next = [
      withEl(a[0].el, 100),
      withEl(a[1].el, 152), // +52：c-v 变现
      withEl(a[2].el, 300),
    ];
    const d = diffBlocks(a, next);
    expect(d.replaced).toBe(false);
    expect(d.changes).toEqual([{ index: 1, from: 200, to: 152 }]);
    expect(d.lenDelta).toBe(0);
  });

  it("ignores sub-pixel drift (<0.5px)", () => {
    const a = rows(100);
    const d = diffBlocks(a, [withEl(a[0].el, 100.3)]);
    expect(d.changes).toHaveLength(0);
  });

  it("flags replacement when identity shifts mid-list (PM rebuild)", () => {
    const a = rows(100, 200, 300);
    const next = [a[0], rows(999)[0], a[2]].map((r, i) =>
      withEl(r.el, [100, 48, 300][i])
    );
    const d = diffBlocks(a, next);
    expect(d.replaced).toBe(true);
  });

  it("reports tail append/remove as lenDelta without replacement", () => {
    const a = rows(100, 200);
    const grown = [...a, ...rows(300)];
    expect(diffBlocks(a, grown)).toEqual({
      replaced: false,
      changes: [],
      lenDelta: 1,
    });
    expect(diffBlocks(grown, a).lenDelta).toBe(-1);
  });

  it("empty-to-empty and first baseline are inert", () => {
    expect(diffBlocks([], [])).toEqual({ replaced: false, changes: [], lenDelta: 0 });
  });
});

describe("classifyPmBatch（pm:rebuild 检测）", () => {
  it("mass same-slot swap → rebuild（H1 签名：-N/+N 成对）", () => {
    expect(classifyPmBatch(14, 14)).toBe("rebuild");
    expect(classifyPmBatch(3, 3)).toBe("rebuild");
  });

  it("daily edits → edit（只计数不发事件）", () => {
    expect(classifyPmBatch(0, 0)).toBe("edit");
    expect(classifyPmBatch(1, 1)).toBe("edit");
    expect(classifyPmBatch(2, 2)).toBe("edit");
  });

  it("large pure append/remove → shape", () => {
    expect(classifyPmBatch(0, 9)).toBe("shape");
    expect(classifyPmBatch(9, 0)).toBe("shape");
  });
});
