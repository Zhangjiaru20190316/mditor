import { afterEach, describe, expect, it } from "vitest";
import {
  classifyPmBatch,
  diffBlocks,
  longtaskBlockedSince,
  noteLongtaskSpan,
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
    // 默认远离底部（scrollTop 5000 / 上限 19200）：不构成贴底钳制。
    scrollTop: 5_000,
    scrollHeight: 20_000,
    clientHeight: 800,
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
    // 大位移但不贴底（默认 scrollTop 5000 远离上限）→ 仍走 ghost（真实
    // 滚动量，不是 clamping）。
    const big = stepSession(idle, input({ delta: 30, heightDelta: -51 }));
    expect(big.verdict.type).toBe("ghost");
  });

  it("bottom clamp of any magnitude → clamp(forced)，不是 ghost（2026-08-23 用户反馈误报）", () => {
    // 点击按钮改排版/开合面板 → 内容收缩 1000px → 浏览器把贴底 scrollTop
    // 压回新上限（19200→18200）：「不得不滚动」的合理钳制，幅度不限。
    const r = stepSession(
      idle,
      input({
        delta: -600,
        scrollTop: 18_200,
        scrollHeight: 19_000,
        heightDelta: -1_000,
      })
    );
    expect(r.verdict).toEqual({
      type: "clamp",
      delta: -600,
      heightDelta: -1_000,
      forced: true,
    });
    // 同幅收缩但旧位置本就低于新上限、位移也没停在上限 → 不明来源，ghost。
    const g = stepSession(
      idle,
      input({
        delta: -600,
        scrollTop: 4_400,
        scrollHeight: 19_000,
        heightDelta: -1_000,
      })
    );
    expect(g.verdict.type).toBe("ghost");
    // 停在「新上限 ±1px」以内才算钳制（sub-pixel 容差）：差 1px 过、2px 不过。
    const near = stepSession(
      idle,
      input({
        delta: -599,
        scrollTop: 18_201,
        scrollHeight: 19_000,
        heightDelta: -1_000,
      })
    );
    expect(near.verdict.type).toBe("clamp");
    const off = stepSession(
      idle,
      input({
        delta: -598,
        scrollTop: 18_202,
        scrollHeight: 19_000,
        heightDelta: -1_000,
      })
    );
    expect(off.verdict.type).toBe("ghost");
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

describe("stepSession × longtask 补偿（P2-5：写入窗跨 longtask 不过期）", () => {
  const idle: SessionState = { tag: null, stillFrames: 99 };
  const input = (over: Partial<Parameters<typeof stepSession>[1]>) => ({
    now: 10_000,
    delta: 40,
    heightDelta: 0,
    scrollTop: 5_000,
    scrollHeight: 20_000,
    clientHeight: 800,
    userIntentAt: 0,
    lastWrite: null,
    smoothJumpActive: false,
    ...over,
  });

  it("写入后跨 longtask：扣除阻塞时长后仍在窗内 → write，不再误判 ghost", () => {
    // 复现 2026-08-23 大文档事件：anchor-comp 写入后主线程被 500~1200ms
    // longtask 阻塞，rAF 恢复时墙钟年龄 1500ms 已超 250ms 窗 → 曾判 ghost
    // （↓3132px，heightDelta=0、非贴底）。扣除 1450ms 阻塞后真实空闲仅
    // 50ms → 归 write。
    const r = stepSession(
      idle,
      input({
        lastWrite: { tag: "anchor-comp", at: 8_500 },
        longtaskDebt: 1_450,
      })
    );
    expect(r.verdict).toEqual({ type: "write", tag: "anchor-comp" });
    expect(r.state.tag).toBe("write:anchor-comp");
  });

  it("真实空闲超窗（无 longtask / longtask 在写入之前结束）→ 仍 ghost", () => {
    const a = stepSession(
      idle,
      input({ lastWrite: { tag: "anchor-comp", at: 8_500 } })
    );
    expect(a.verdict.type).toBe("ghost");
    const b = stepSession(
      idle,
      input({ lastWrite: { tag: "anchor-comp", at: 8_500 }, longtaskDebt: 0 })
    );
    expect(b.verdict.type).toBe("ghost");
    // 只有部分被阻塞：真实空闲 1000ms 仍超窗。
    const c = stepSession(
      idle,
      input({ lastWrite: { tag: "anchor-comp", at: 8_500 }, longtaskDebt: 500 })
    );
    expect(c.verdict.type).toBe("ghost");
  });

  it("阻塞时长计入后窗内的小位移同样归 write（↓10400px 场景候选）", () => {
    const r = stepSession(
      idle,
      input({
        delta: -10_400,
        lastWrite: { tag: "rebuild-restore", at: 9_900 },
        longtaskDebt: 1_100,
      })
    );
    expect(r.verdict.type).toBe("write");
  });
});

describe("longtaskBlockedSince（区间重叠累计）", () => {
  it("counts only the overlap with [since, now]; spans accumulate", () => {
    noteLongtaskSpan(1_000, 800); // [1000, 1800)
    expect(longtaskBlockedSince(1_500, 3_000)).toBe(300);
    expect(longtaskBlockedSince(500, 3_000)).toBe(800);
    expect(longtaskBlockedSince(2_000, 3_000)).toBe(0);
    noteLongtaskSpan(1_600, 400); // [1600, 2000)
    expect(longtaskBlockedSince(1_500, 3_000)).toBe(700);
  });

  it("ignores invalid spans; clear() wipes the log", () => {
    noteLongtaskSpan(1_000, 0);
    noteLongtaskSpan(1_000, -5);
    expect(longtaskBlockedSince(0, 5_000)).toBe(0);
    noteLongtaskSpan(1_000, 100);
    expect(longtaskBlockedSince(0, 5_000)).toBe(100);
    scrollDebugClear();
    expect(longtaskBlockedSince(0, 5_000)).toBe(0);
  });
});

describe("stepSession resize 归因（v4.3 视口尺寸变化）", () => {
  const idle: SessionState = { tag: null, stillFrames: 99 };
  const input = (over: Partial<Parameters<typeof stepSession>[1]>) => ({
    now: 10_000,
    delta: 40,
    heightDelta: 0,
    scrollTop: 5_000,
    scrollHeight: 20_000,
    clientHeight: 800,
    userIntentAt: 0,
    lastWrite: null,
    smoothJumpActive: false,
    ...over,
  });

  it("resize 因果窗内、无输入无写入 → resize（不计 ghost）", () => {
    const r = stepSession(
      idle,
      input({ resizeAt: 9_700, resizeDelta: { dw: -180, dh: 0 } })
    );
    expect(r.verdict.type).toBe("resize");
    if (r.verdict.type === "resize") {
      expect(r.verdict.dw).toBe(-180);
      expect(r.verdict.dh).toBe(0);
      expect(r.verdict.delta).toBe(40);
    }
    expect(r.state.tag).toBe("resize");
  });

  it("灵敏度红线：resize 过期（>500ms）仍判 ghost", () => {
    const r = stepSession(
      idle,
      input({ resizeAt: 9_300, resizeDelta: { dw: -180, dh: 0 } })
    );
    expect(r.verdict.type).toBe("ghost");
  });

  it("灵敏度红线：无 resize 信号的不明滚动仍判 ghost（旧输入形状兼容）", () => {
    const r = stepSession(idle, input({}));
    expect(r.verdict.type).toBe("ghost");
    const r2 = stepSession(idle, input({ resizeAt: null, resizeDelta: null }));
    expect(r2.verdict.type).toBe("ghost");
  });

  it("优先级：用户输入 > resize", () => {
    const r = stepSession(
      idle,
      input({ userIntentAt: 9_900, resizeAt: 9_700, resizeDelta: { dw: -5, dh: 0 } })
    );
    expect(r.verdict.type).toBe("user");
  });

  it("优先级：已知程序写入 > resize", () => {
    const r = stepSession(
      idle,
      input({
        lastWrite: { tag: "anchor-comp", at: 9_800 },
        resizeAt: 9_700,
        resizeDelta: { dw: -5, dh: 0 },
      })
    );
    expect(r.verdict.type).toBe("write");
  });

  it("resize 归因先于钳制：贴底钳制签名在 resize 窗内也归 resize", () => {
    // 内容收缩 900px、旧位置越界、落在新上限——若无 resize 是 forced clamp。
    const r = stepSession(
      idle,
      input({
        delta: -900,
        heightDelta: -900,
        scrollTop: 18_300,
        resizeAt: 9_900,
        resizeDelta: { dw: -200, dh: 0 },
      })
    );
    expect(r.verdict.type).toBe("resize");
  });

  it("resize 会话延续：静止未达确认阈值时同会话不重判", () => {
    const a = stepSession(
      idle,
      input({ resizeAt: 9_700, resizeDelta: { dw: -180, dh: 0 } })
    );
    expect(a.verdict.type).toBe("resize");
    // 下一帧仍动：会话存活延续（tag=resize），不重判成 ghost。
    const b = stepSession(a.state, input({}));
    expect(b.verdict.type).not.toBe("ghost");
    expect(b.state.tag).toBe("resize");
  });

  it("连续帧序列：最大化还原场景（大幅滚动紧跟 resize）全程无 ghost", () => {
    let st: SessionState = { tag: null, stillFrames: 99 };
    // t=10000 resize（窗口 1600→1200），t=10016 起连滚 3 帧，之后静止确认。
    const frames: Array<Partial<Parameters<typeof stepSession>[1]>> = [
      { now: 10_016, delta: 220, scrollTop: 5_220 },
      { now: 10_032, delta: 150, scrollTop: 5_370 },
      { now: 10_048, delta: 60, scrollTop: 5_430 },
      { now: 10_064, delta: 0, scrollTop: 5_430 },
      { now: 10_080, delta: 0, scrollTop: 5_430 },
    ];
    let sawResize = false;
    let sawGhost = false;
    for (const f of frames) {
      const r = stepSession(st, input({ resizeAt: 10_000, resizeDelta: { dw: -400, dh: 0 }, ...f }));
      if (r.verdict.type === "resize") sawResize = true;
      if (r.verdict.type === "ghost") sawGhost = true;
      st = r.state;
    }
    expect(sawResize).toBe(true);
    expect(sawGhost).toBe(false);
  });
});
