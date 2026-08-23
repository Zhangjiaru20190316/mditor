// devAnomaly 的行为验证：错误代码归类（规则命中/不命中阈值）、心跳趋势
// 判定、冷却合并追踪器，以及「永不抛出」契约（诊断代码不能影响编辑器）。
import { describe, expect, it } from "vitest";
import {
  ALERT_COOLDOWN_MS,
  AnomalyTracker,
  analyzeAnnoEvent,
  analyzeHeartbeats,
  analyzeLogWriteFailure,
  analyzeOpError,
  analyzeRuntimeError,
  analyzeScrollEvent,
  HEAP_TREND_MIN_SPAN_MS,
  type HeartbeatPoint,
} from "./devAnomaly";
import type { AnnoDebugEvent } from "./annoDebug";
import type { OpErrorRecord } from "./opDebug";
import type { ScrollDebugEvent } from "./scrollDebug";

function scrollEvent(
  kind: string,
  level: "info" | "warn" | "error" = "info",
  data?: Record<string, unknown>
): ScrollDebugEvent {
  return { ts: Date.now(), level, kind, msg: `${kind} msg`, data };
}

function annoEvent(
  kind: string,
  level: "info" | "warn" | "error" = "info"
): AnnoDebugEvent {
  return { ts: Date.now(), level, kind, msg: `${kind} msg` };
}

describe("analyzeScrollEvent", () => {
  it("maps ghost sessions to MD-1001", () => {
    const a = analyzeScrollEvent(scrollEvent("session:ghost", "warn", { delta: -30 }));
    expect(a?.code).toBe("MD-1001");
    expect(a?.level).toBe("warn");
  });

  it("maps warn-level viewport shifts to MD-1002, info-level to nothing", () => {
    expect(
      analyzeScrollEvent(scrollEvent("layout:shift", "warn", { delta: -40 }))?.code
    ).toBe("MD-1002");
    expect(
      analyzeScrollEvent(scrollEvent("layout:shift", "info", { delta: -5 }))
    ).toBeNull();
  });

  it("maps only >1s longtasks to MD-1003", () => {
    expect(
      analyzeScrollEvent(scrollEvent("perf:longtask", "warn", { duration: 1500 }))
        ?.code
    ).toBe("MD-1003");
    expect(
      analyzeScrollEvent(scrollEvent("perf:longtask", "warn", { duration: 300 }))
    ).toBeNull();
  });

  it("maps big height jumps to MD-1004, small ones to nothing", () => {
    expect(
      analyzeScrollEvent(scrollEvent("layout:height", "info", { heightDelta: 2000 }))
        ?.code
    ).toBe("MD-1004");
    // 位移与高度突变合并的事件（emit 侧 layout:shift 带 heightDelta）：
    // 位移先命中 MD-1002——它是用户可感知的症状，高度是原因线索。
    expect(
      analyzeScrollEvent(scrollEvent("layout:shift", "warn", { delta: -40, heightDelta: -1800 }))
        ?.code
    ).toBe("MD-1002");
    expect(
      analyzeScrollEvent(scrollEvent("layout:height", "info", { heightDelta: 40 }))
    ).toBeNull();
  });

  it("ignores unrelated kinds", () => {
    expect(analyzeScrollEvent(scrollEvent("watch:attach"))).toBeNull();
    expect(analyzeScrollEvent(scrollEvent("pm:shape", "warn"))).toBeNull();
  });
});

describe("analyzeAnnoEvent / analyzeOpError / runtime / log-write", () => {
  it("maps anno error-level events to MD-3001", () => {
    expect(analyzeAnnoEvent(annoEvent("stream:fail", "error"))?.code).toBe("MD-3001");
    expect(analyzeAnnoEvent(annoEvent("stream:skip", "info"))).toBeNull();
  });

  it("maps memory-guard recreates to MD-4003", () => {
    const a = analyzeAnnoEvent(annoEvent("editor.recreate", "warn"));
    expect(a?.code).toBe("MD-4003");
  });

  it("maps every op error to MD-2001 with op in data", () => {
    const r: OpErrorRecord = { ts: 1, op: "moveBlock", err: "RangeError: x" };
    const a = analyzeOpError(r);
    expect(a?.code).toBe("MD-2001");
    expect(a?.data?.op).toBe("moveBlock");
  });

  it("maps uncaught errors / rejections / log-write failures to MD-5001/5002/5003", () => {
    expect(analyzeRuntimeError("uncaught", "boom")?.code).toBe("MD-5001");
    expect(analyzeRuntimeError("uncaught", "boom")?.level).toBe("error");
    expect(analyzeRuntimeError("rejection", "nope")?.code).toBe("MD-5002");
    expect(analyzeLogWriteFailure("append_log Err")?.code).toBe("MD-5003");
  });
});

describe("analyzeHeartbeats", () => {
  const MB = 1024 * 1024;

  function ramp(
    n: number,
    stepMs: number,
    startUsed: number,
    gainPerStep: number
  ): HeartbeatPoint[] {
    const t0 = 1_700_000_000_000;
    return Array.from({ length: n }, (_, i) => ({
      ts: t0 + i * stepMs,
      used: startUsed + i * gainPerStep,
      prosemirrorViews: 1,
    }));
  }

  it("flags sustained heap growth as MD-4001", () => {
    // 7 点 × 60s = 6 分钟跨度，+120MB → 20MB/分，远超阈值。
    const pts = ramp(7, 60_000, 100 * MB, 20 * MB);
    const codes = analyzeHeartbeats(pts).map((a) => a.code);
    expect(codes).toContain("MD-4001");
  });

  it("does not flag short windows, small gains, or flat heaps", () => {
    // 跨度不足（<3 分钟）。
    expect(
      analyzeHeartbeats(ramp(7, 10_000, 100 * MB, 30 * MB)).map((a) => a.code)
    ).not.toContain("MD-4001");
    // 总增量不足 50MB。
    expect(
      analyzeHeartbeats(ramp(10, 60_000, 100 * MB, 2 * MB)).map((a) => a.code)
    ).not.toContain("MD-4001");
    // 平坦堆。
    expect(
      analyzeHeartbeats(ramp(10, 60_000, 100 * MB, 0)).map((a) => a.code)
    ).not.toContain("MD-4001");
    // 下降（GC 回落）。
    expect(
      analyzeHeartbeats(ramp(10, 60_000, 300 * MB, -10 * MB)).map((a) => a.code)
    ).not.toContain("MD-4001");
  });

  it("flags residual ProseMirror views as MD-4002", () => {
    const pts = ramp(6, 60_000, 100 * MB, 0);
    pts[pts.length - 1].prosemirrorViews = 2;
    expect(analyzeHeartbeats(pts).map((a) => a.code)).toContain("MD-4002");
  });

  it("tolerates null used values (non-Chromium runtime)", () => {
    const pts: HeartbeatPoint[] = Array.from({ length: 10 }, (_, i) => ({
      ts: i * 60_000,
      used: null,
      prosemirrorViews: null,
    }));
    expect(analyzeHeartbeats(pts)).toEqual([]);
    expect(HEAP_TREND_MIN_SPAN_MS).toBeGreaterThan(0);
  });
});

describe("AnomalyTracker 冷却合并", () => {
  it("alerts the first occurrence, merges within cooldown, re-alerts after", () => {
    const t = new AnomalyTracker();
    const a = { code: "MD-1001", level: "warn" as const, title: "ghost", detail: "x" };
    const t0 = 1_000_000;
    expect(t.record(a, t0)).toBe(true);
    expect(t.record(a, t0 + 1000)).toBe(false);
    expect(t.record(a, t0 + ALERT_COOLDOWN_MS - 1)).toBe(false);
    expect(t.record(a, t0 + ALERT_COOLDOWN_MS)).toBe(true);
    // 计数不受冷却影响：4 次都记账。
    expect(t.list()[0]).toMatchObject({ code: "MD-1001", count: 4 });
  });

  it("tracks different codes independently and sorts by recency", () => {
    const t = new AnomalyTracker();
    const t0 = 5_000_000;
    t.record({ code: "MD-5001", level: "error", title: "a", detail: "d1" }, t0);
    t.record({ code: "MD-2001", level: "warn", title: "b", detail: "d2" }, t0 + 10);
    const list = t.list();
    expect(list.map((x) => x.code)).toEqual(["MD-2001", "MD-5001"]);
    expect(list[1].firstTs).toBe(t0);
    expect(list[0].lastDetail).toBe("d2");
  });

  it("reset clears both tracking and cooldown", () => {
    const t = new AnomalyTracker();
    const a = { code: "MD-5003", level: "error" as const, title: "x", detail: "y" };
    t.record(a, 0);
    t.reset();
    expect(t.list()).toEqual([]);
    // 冷却也一并清空：reset 后首次出现重新放行弹窗。
    expect(t.record(a, 1)).toBe(true);
  });
});
