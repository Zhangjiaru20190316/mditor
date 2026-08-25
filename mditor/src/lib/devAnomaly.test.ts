// devAnomaly 的行为验证：错误代码归类（规则命中/不命中阈值）、心跳趋势
// 判定、冷却合并追踪器，以及「永不抛出」契约（诊断代码不能影响编辑器）。
import { describe, expect, it } from "vitest";
import {
  ALERT_COOLDOWN_MS,
  AnomalyTracker,
  analyzeAnnoEvent,
  analyzeFrameStatsDelta,
  analyzeHeartbeats,
  analyzeLogWriteFailure,
  analyzeOpError,
  analyzeRenderError,
  analyzeRuntimeError,
  analyzeScrollEvent,
  analyzeShiftBurst,
  analyzeSysEvent,
  classifyOpCategory,
  HEAP_TREND_MIN_SPAN_MS,
  INPUT_LAG_THRESHOLD,
  JANK_FRAME_THRESHOLD,
  SHIFT_BURST_MIN,
  type HeartbeatPoint,
} from "./devAnomaly";
import type { AnnoDebugEvent } from "./annoDebug";
import type { OpErrorRecord } from "./opDebug";
import type { ScrollDebugEvent, ScrollFrameStats } from "./scrollDebug";
import type { SysDebugEvent } from "./sysDebug";

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

  it("skips MD-1002/MD-1004 for user-initiated reflows（点击按钮改布局，2026-08-23）", () => {
    // emit 侧对用户刚改布局（500ms 窗）的 shift 已降 info，此处验证纵深
    // 防御：即使 warn 级事件带 userInitiated 标记也不弹；无标记的照常命中。
    expect(
      analyzeScrollEvent(
        scrollEvent("layout:shift", "warn", { delta: -40, userInitiated: true })
      )
    ).toBeNull();
    expect(
      analyzeScrollEvent(
        scrollEvent("layout:height", "info", { heightDelta: 2000, userInitiated: true })
      )
    ).toBeNull();
    expect(
      analyzeScrollEvent(scrollEvent("layout:height", "info", { heightDelta: 2000 }))
        ?.code
    ).toBe("MD-1004");
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

  it("maps unclassified op errors to MD-2001 with op in data (fallback unchanged)", () => {
    const r: OpErrorRecord = { ts: 1, op: "brand-new-op", err: "RangeError: x" };
    const a = analyzeOpError(r);
    expect(a?.code).toBe("MD-2001");
    expect(a?.data?.op).toBe("brand-new-op");
  });

  it("maps uncaught errors / rejections / log-write failures to MD-5001/5002/5003", () => {
    expect(analyzeRuntimeError("uncaught", "boom")?.code).toBe("MD-5001");
    expect(analyzeRuntimeError("uncaught", "boom")?.level).toBe("error");
    expect(analyzeRuntimeError("rejection", "nope")?.code).toBe("MD-5002");
    expect(analyzeLogWriteFailure("append_log Err")?.code).toBe("MD-5003");
  });
});

describe("v4.3 细分：滚动新码 + resize 抑制（纵深防御）", () => {
  it("pm:rebuild warn → MD-1011；pm:root-swap 不产异常（由 4003 承载）", () => {
    expect(analyzeScrollEvent(scrollEvent("pm:rebuild", "warn", { removed: 5, added: 5 }))?.code).toBe("MD-1011");
    expect(analyzeScrollEvent(scrollEvent("pm:root-swap", "warn"))).toBeNull();
  });

  it("cause=resize 的 warn 级位移不再触发 MD-1002（emit 侧漂移的兜底）", () => {
    expect(
      analyzeScrollEvent(scrollEvent("layout:shift", "warn", { delta: -40, cause: "resize" }))
    ).toBeNull();
    expect(
      analyzeScrollEvent(scrollEvent("layout:shift", "warn", { delta: -40 }))
    ).not.toBeNull();
  });

  it("cause=resize 的高度突变不再触发 MD-1004", () => {
    expect(
      analyzeScrollEvent(scrollEvent("layout:shift", "warn", { delta: 0, heightDelta: -4000, cause: "resize" }))
    ).toBeNull();
    expect(
      analyzeScrollEvent(scrollEvent("layout:shift", "warn", { delta: 0, heightDelta: -4000 }))
    ).not.toBeNull();
  });
});

describe("v4.3 细分：编辑命令按类别给码", () => {
  it("classifyOpCategory covers known op families", () => {
    expect(classifyOpCategory("moveBlock")).toBe("block");
    expect(classifyOpCategory("tableOp")).toBe("block");
    expect(classifyOpCategory("setBlockType")).toBe("block");
    expect(classifyOpCategory("toggleMark:bold")).toBe("inline");
    expect(classifyOpCategory("insertFootnote")).toBe("inline");
    expect(classifyOpCategory("setTextColor")).toBe("inline");
    expect(classifyOpCategory("setValue")).toBe("docwrite");
    expect(classifyOpCategory("aiWriteDoc")).toBe("docwrite");
    expect(classifyOpCategory("revealText")).toBe("docwrite");
    expect(classifyOpCategory("shutdown-flush")).toBe("app");
    expect(classifyOpCategory("window-close")).toBe("app");
    expect(classifyOpCategory("mystery-op")).toBe("other");
  });

  it("analyzeOpError maps categories to 2011/2012/2013/2014, unknown falls back to 2001", () => {
    const rec = (op: string): OpErrorRecord => ({ ts: 1, op, err: "E: x" });
    expect(analyzeOpError(rec("deleteBlock"))?.code).toBe("MD-2011");
    expect(analyzeOpError(rec("toggleMark:italic"))?.code).toBe("MD-2012");
    expect(analyzeOpError(rec("insertValue"))?.code).toBe("MD-2013");
    expect(analyzeOpError(rec("menu-exit"))?.code).toBe("MD-2014");
    expect(analyzeOpError(rec("mystery-op"))?.code).toBe("MD-2001");
    // 语义不变的兜底：任何失败都至少落到 2001 家族。
    expect(analyzeOpError(rec("mystery-op"))?.level).toBe("warn");
  });
});

describe("v4.3 细分：批注按链路阶段给码", () => {
  it("error 级事件按 kind 前缀映射 3011/3012/3013/3014，未知回 3001", () => {
    expect(analyzeAnnoEvent(annoEvent("badge.patch.error", "error"))?.code).toBe("MD-3011");
    expect(analyzeAnnoEvent(annoEvent("stamp.bare-after-load", "error"))?.code).toBe("MD-3011");
    expect(analyzeAnnoEvent(annoEvent("anno.append.full", "error"))?.code).toBe("MD-3012");
    expect(analyzeAnnoEvent(annoEvent("stream.degraded", "error"))?.code).toBe("MD-3013");
    expect(analyzeAnnoEvent(annoEvent("health.error", "error"))?.code).toBe("MD-3014");
    expect(analyzeAnnoEvent(annoEvent("mystery.kind", "error"))?.code).toBe("MD-3001");
  });

  it("非 error 级不产异常（告警轰炸防线）", () => {
    expect(analyzeAnnoEvent(annoEvent("anno.finalize.full", "warn"))).toBeNull();
    expect(analyzeAnnoEvent(annoEvent("stream.degraded", "info"))).toBeNull();
  });

  it("渲染层异常单列 MD-5011（error 级）", () => {
    const a = analyzeRenderError("Editor", "TypeError: render boom", "stack…");
    expect(a?.code).toBe("MD-5011");
    expect(a?.level).toBe("error");
    expect(a?.data?.label).toBe("Editor");
  });
});

describe("v4.3 新大类：analyzeSysEvent（文件/IPC/AI/资源）", () => {
  const sys = (kind: string, level: "info" | "warn" | "error" = "error"): SysDebugEvent => ({
    ts: 1,
    level,
    kind,
    msg: `${kind} msg`,
  });

  it("file failures map to 6001/6002/6003/6004", () => {
    expect(analyzeSysEvent(sys("file:read-fail"))?.code).toBe("MD-6001");
    expect(analyzeSysEvent(sys("file:write-fail"))?.code).toBe("MD-6002");
    expect(analyzeSysEvent(sys("file:mut-fail"))?.code).toBe("MD-6003");
    expect(analyzeSysEvent(sys("file:watch-fail"))?.code).toBe("MD-6004");
  });

  it("ipc failures/slowness map to 7001/7002/7003/7004", () => {
    expect(analyzeSysEvent(sys("ipc:invoke-fail"))?.code).toBe("MD-7001");
    expect(analyzeSysEvent(sys("file:read-slow", "warn"))?.code).toBe("MD-7002");
    expect(analyzeSysEvent(sys("ipc:dialog-slow", "warn"))?.code).toBe("MD-7002");
    expect(analyzeSysEvent(sys("ipc:dialog-fail"))?.code).toBe("MD-7003");
    expect(analyzeSysEvent(sys("ipc:clipboard-fail"))?.code).toBe("MD-7004");
  });

  it("ai failures map to 8001/8002/8003/8004; abort stays info", () => {
    expect(analyzeSysEvent(sys("ai:request-fail"))?.code).toBe("MD-8001");
    expect(analyzeSysEvent(sys("ai:stream-fail"))?.code).toBe("MD-8002");
    expect(analyzeSysEvent(sys("ai:stream-abnormal-end", "warn"))?.code).toBe("MD-8003");
    expect(analyzeSysEvent(sys("ai:response-fail", "warn"))?.code).toBe("MD-8004");
    expect(analyzeSysEvent(sys("ai:stream-abort", "info"))).toBeNull();
  });

  it("resource load failures map to MD-5012; lifecycle/unknown produce nothing", () => {
    expect(analyzeSysEvent(sys("res:load-fail", "warn"))?.code).toBe("MD-5012");
    expect(analyzeSysEvent(sys("lifecycle:editor-ready", "info"))).toBeNull();
    expect(analyzeSysEvent(sys("mystery", "warn"))).toBeNull();
  });
});

describe("v4.3：心跳 DOM 趋势（MD-4011）", () => {
  it("sustained domNodes growth fires MD-4011; flat does not", () => {
    const base = Date.now() - 10 * 60_000;
    const pts: HeartbeatPoint[] = Array.from({ length: 10 }, (_, i) => ({
      ts: base + i * 60_000,
      used: 100 * 1024 * 1024,
      prosemirrorViews: 1,
      domNodes: 10_000 + i * 8_000,
    }));
    const out = analyzeHeartbeats(pts);
    expect(out.map((a) => a.code)).toContain("MD-4011");

    const flat = pts.map((p, i) => ({ ...p, domNodes: 10_000 + (i % 2) }));
    expect(analyzeHeartbeats(flat).map((a) => a.code)).not.toContain("MD-4011");
  });

  it("domNodes absent (未开启重采样) → 不判定", () => {
    const base = Date.now() - 10 * 60_000;
    const pts: HeartbeatPoint[] = Array.from({ length: 10 }, (_, i) => ({
      ts: base + i * 60_000,
      used: 100 * 1024 * 1024,
      prosemirrorViews: 1,
    }));
    expect(analyzeHeartbeats(pts)).toEqual([]);
  });
});

describe("v4.3：帧统计差分与位移抖动风暴（MD-9001/9002/9003）", () => {
  const fs = (over: Partial<ScrollFrameStats>): ScrollFrameStats => ({
    frames: 1800,
    jankFrames: 0,
    worstGapMs: 0,
    inputLagEvents: 0,
    worstInputLagMs: 0,
    ...over,
  });

  it("jank delta ≥ threshold → MD-9001；低于阈值不报", () => {
    const prev = fs({});
    const cur = fs({ jankFrames: 12, worstGapMs: 400 });
    const out = analyzeFrameStatsDelta(prev, cur);
    expect(out.map((a) => a.code)).toContain("MD-9001");
    expect(analyzeFrameStatsDelta(prev, fs({ jankFrames: JANK_FRAME_THRESHOLD - 1 }))).toEqual([]);
  });

  it("input lag delta ≥ threshold → MD-9003", () => {
    const prev = fs({});
    const cur = fs({ inputLagEvents: 9, worstInputLagMs: 300 });
    expect(analyzeFrameStatsDelta(prev, cur).map((a) => a.code)).toContain("MD-9003");
    expect(INPUT_LAG_THRESHOLD).toBeGreaterThan(0);
  });

  it("首拍（prev=null）不判定；倒退快照不判定", () => {
    expect(analyzeFrameStatsDelta(null, fs({ jankFrames: 99 }))).toEqual([]);
    expect(analyzeFrameStatsDelta(fs({ jankFrames: 50 }), fs({ jankFrames: 10 }))).toEqual([]);
  });

  it("warn 位移 2s 内 ≥3 次 → MD-9002；分散不报", () => {
    const now = 1_000_000;
    expect(analyzeShiftBurst([now - 100, now - 700, now - 1300], now)?.code).toBe("MD-9002");
    expect(analyzeShiftBurst([now - 100, now - 700, now - 2600], now)).toBeNull();
    expect(analyzeShiftBurst([now - 100, now - 700], now)).toBeNull();
    expect(SHIFT_BURST_MIN).toBe(3);
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
