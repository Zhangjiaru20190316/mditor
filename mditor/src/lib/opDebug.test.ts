// opDebug 的行为验证：计数聚合、最近错误记录、限频告警的确定性部分，
// 订阅推送（v4.2 开发者模式记录器用），以及「永不抛出」契约（诊断代码
// 不能影响编辑器）。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { noteOpError, opErrorStats, opSubscribe } from "./opDebug";

describe("opDebug", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts per-op occurrences and records the latest error", () => {
    noteOpError("moveBlock", new RangeError("Maximum call stack size exceeded"));
    noteOpError("moveBlock", new TypeError("boom-2"));
    noteOpError("setValue", new Error("other-op"));
    const s = opErrorStats();
    const mv = s.ops.find((o) => o.op === "moveBlock");
    expect(mv?.count).toBe(2);
    expect(mv?.last?.err).toContain("boom-2");
    expect(s.total).toBe(3);
    // 次数多的排前面（报告可读性）。
    expect(s.ops[0].op).toBe("moveBlock");
  });

  it("stringifies non-Error throwables without crashing", () => {
    expect(() => noteOpError("x", "plain string")).not.toThrow();
    expect(() => noteOpError("x", undefined)).not.toThrow();
    expect(opErrorStats().ops.find((o) => o.op === "x")?.count).toBe(2);
  });

  it("console.warns at most once per op within the rate-limit window", () => {
    noteOpError("opA", new Error("1"));
    noteOpError("opA", new Error("2"));
    noteOpError("opA", new Error("3"));
    // 首次必报 + 首次附带的说明行；后续 10s 内静默只计数。
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(opErrorStats().ops.find((o) => o.op === "opA")?.count).toBe(3);
  });

  it("pushes every occurrence to subscribers and removes throwing ones", () => {
    const got: string[] = [];
    const unsub = opSubscribe((r) => got.push(`${r.op}:${r.err}`));
    // 抛错的订阅者被自动摘除，不影响其他订阅者。
    let throwOnce = true;
    opSubscribe(() => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("bad subscriber");
      }
    });
    noteOpError("moveBlock", new Error("e1"));
    noteOpError("moveBlock", new Error("e2"));
    expect(got).toEqual(["moveBlock:Error: e1", "moveBlock:Error: e2"]);
    unsub();
    noteOpError("moveBlock", new Error("e3"));
    expect(got).toHaveLength(2);
  });
});
