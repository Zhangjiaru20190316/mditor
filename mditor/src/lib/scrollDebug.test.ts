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
  stepSession,
  type BlockRow,
  type SessionState,
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

describe("stepSession（会话归因状态机，v3.9.5）", () => {
  const idle: SessionState = { tag: null, stillFrames: 99 };
  const input = (over: Partial<Parameters<typeof stepSession>[1]>) => ({
    now: 10_000,
    delta: 40,
    heightDelta: 0,
    userIntentAt: 0,
    lastWrite: null,
    smoothJumpActive: false,
    ...over,
  });

  it("user input within 200ms wins over everything", () => {
    const r = stepSession(idle, input({ userIntentAt: 9_900 }));
    expect(r.verdict).toEqual({ type: "user" });
    expect(r.state.tag).toBe("user");
  });

  it("marked write within 250ms → write:<tag>", () => {
    const r = stepSession(idle, input({ lastWrite: { tag: "typewriter", at: 9_800 } }));
    expect(r.verdict).toEqual({ type: "write", tag: "typewriter" });
    expect(r.state.tag).toBe("write:typewriter");
  });

  it("no signal → ghost", () => {
    const r = stepSession(idle, input({}));
    expect(r.verdict.type).toBe("ghost");
    expect(r.state.tag).toBe("ghost");
  });

  it("smooth-jump tail beyond 250ms stays attributed while the jump cycle lives", () => {
    // 复现 2026-08-22 证据：outline-jump@1494ms 前的 1px 尾段。
    // (a) smoothJump 标志仍在位（scrollend 未到/超时未到）→ write。
    const a = stepSession(
      idle,
      input({
        delta: 1,
        lastWrite: { tag: "outline-jump", at: 8_506 },
        smoothJumpActive: true,
      })
    );
    expect(a.verdict).toEqual({ type: "write", tag: "outline-jump" });
    // (b) 标志已清但仍在 1250ms 对齐窗内 → write。
    const b = stepSession(
      idle,
      input({
        delta: 1,
        lastWrite: { tag: "anno-jump", at: 9_000 },
        smoothJumpActive: false,
      })
    );
    expect(b.verdict.type).toBe("write");
    // (c) 窗外且无标志 → 不再归 write。
    const c = stepSession(
      idle,
      input({
        delta: 1,
        lastWrite: { tag: "outline-jump", at: 8_500 },
        smoothJumpActive: false,
      })
    );
    expect(c.verdict.type).not.toBe("write");
  });

  it("non-smooth tags never get the extended window", () => {
    const r = stepSession(
      idle,
      input({ lastWrite: { tag: "typewriter", at: 9_000 }, smoothJumpActive: true })
    );
    expect(r.verdict.type).toBe("ghost");
  });

  it("sub-2px displacement with same-frame height change → clamp, not ghost", () => {
    const r = stepSession(idle, input({ delta: 1, heightDelta: -51 }));
    expect(r.verdict.type).toBe("clamp");
    // 无高度变化的 1px 位移仍走 ghost（真正不明）。
    const g = stepSession(idle, input({ delta: 1, heightDelta: 0 }));
    expect(g.verdict.type).toBe("ghost");
    // 有高度变化的大位移也走 ghost（真实滚动量，不是 clamping）。
    const big = stepSession(idle, input({ delta: 30, heightDelta: -51 }));
    expect(big.verdict.type).toBe("ghost");
  });

  it("clamp session closes immediately so a following real ghost is not swallowed", () => {
    const c = stepSession(idle, input({ delta: 1, heightDelta: -51 }));
    const next = stepSession(c.state, input({ delta: 40, heightDelta: 0 }));
    expect(next.verdict.type).toBe("ghost");
  });

  it("stillness confirmation: session survives 1-4 still frames（longtask 尾段恢复）", () => {
    // 平滑滚动进行中 → 静止 3 帧 → 1px 尾段：必须延续 write 会话，不得重判。
    let st: SessionState = { tag: "write:outline-jump", stillFrames: 0 };
    for (let i = 0; i < 3; i++) {
      st = stepSession(st, input({ delta: 0 })).state;
      expect(st.tag).toBe("write:outline-jump");
    }
    const resume = stepSession(st, input({ delta: 1, lastWrite: { tag: "outline-jump", at: 8_000 } }));
    expect(resume.verdict.type).toBe("continue");
    expect(resume.state.tag).toBe("write:outline-jump");
  });

  it("session closes after STILL_CONFIRM_FRAMES still frames and reclassifies", () => {
    let st: SessionState = { tag: "user", stillFrames: 0 };
    for (let i = 0; i < 5; i++) st = stepSession(st, input({ delta: 0 })).state;
    expect(st.tag).toBeNull();
    const fresh = stepSession(st, input({ userIntentAt: 9_950 }));
    expect(fresh.verdict.type).toBe("user");
  });
});
