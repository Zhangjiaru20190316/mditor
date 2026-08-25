// sysDebug 行为验证：事件总线（环形缓冲/计数器/订阅）+ tracedIo 遥测
//（成功计数、失败重抛、慢调用事件）+「永不抛出」契约。
import { afterEach, describe, expect, it } from "vitest";
import {
  sysCount,
  sysCounters,
  sysDebugClear,
  sysEmit,
  sysEvents,
  sysSubscribe,
} from "./sysDebug";
import { tracedIo } from "./ipcTrace";

afterEach(() => sysDebugClear());

describe("sysDebug 系统链路总线", () => {
  it("counts and buffers events, capacity-capped", () => {
    sysCount("a.b", 2);
    sysEmit("file:read-fail", "读取失败", { level: "error" });
    expect(sysCounters()).toEqual({ "a.b": 2, "file:read-fail": 1 });
    expect(sysEvents()).toHaveLength(1);
    expect(sysEvents()[0].level).toBe("error");
    for (let i = 0; i < 400; i++) sysEmit("bulk", `e${i}`);
    expect(sysEvents().length).toBeLessThanOrEqual(300);
    expect(sysEvents().at(-1)?.msg).toBe("e399");
  });

  it("notifies subscribers and drops throwing ones", () => {
    let got = 0;
    const bad = () => {
      throw new Error("boom");
    };
    sysSubscribe(bad);
    const good = () => got++;
    const unsub = sysSubscribe(good);
    sysEmit("k", "m");
    expect(got).toBe(1);
    unsub();
    sysEmit("k", "m");
    expect(got).toBe(1);
  });

  it("defaults to info level and never throws on weird payloads", () => {
    sysEmit("lifecycle:mode-switch", "切换");
    expect(sysEvents()[0].level).toBe("info");
    // 循环引用 data 不得抛错（JSON.stringify 由消费侧兜底，emit 侧只存引用）。
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => sysEmit("x", "m", { data: circular })).not.toThrow();
  });
});

describe("tracedIo（IO/IPC 边界遥测）", () => {
  function freshClock() {
    let t = 0;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it("success: counts io.<kind> + accumulated ms, no events", async () => {
    const c = freshClock();
    await tracedIo("file:read", "读 a.md", async () => {
      c.advance(30);
      return 42;
    }, { now: c.now });
    const cnt = sysCounters();
    expect(cnt["io.file:read"]).toBe(1);
    expect(cnt["io.ms.file:read"]).toBe(30);
    expect(sysEvents()).toHaveLength(0);
  });

  it("failure: emits <kind>-fail error event and rethrows the original error", async () => {
    const c = freshClock();
    const boom = new Error("disk on fire");
    await expect(
      tracedIo("file:write", "存 a.md", async () => {
        c.advance(5);
        throw boom;
      }, { now: c.now })
    ).rejects.toBe(boom);
    const e = sysEvents().find((x) => x.kind === "file:write-fail");
    expect(e?.level).toBe("error");
    expect(e?.msg).toContain("disk on fire");
    expect(e?.msg).toContain("5ms");
  });

  it("slow: emits <kind>-slow warn event past threshold, silent under it", async () => {
    const c = freshClock();
    await tracedIo("file:read", "读 big.md", async () => {
      c.advance(2500);
    }, { now: c.now });
    const slow = sysEvents().find((x) => x.kind === "file:read-slow");
    expect(slow?.level).toBe("warn");
    expect(slow?.data?.ms).toBe(2500);

    sysDebugClear();
    const c2 = freshClock();
    await tracedIo("file:read", "读 small.md", async () => {
      c2.advance(100);
    }, { now: c2.now });
    expect(sysEvents()).toHaveLength(0);
  });

  it("slowMs: Infinity disables the slow event (dialog/AI paths)", async () => {
    const c = freshClock();
    await tracedIo("ipc:dialog", "打开对话框", async () => {
      c.advance(60_000); // 用户思考一分钟不是异常
    }, { now: c.now, slowMs: Infinity });
    expect(sysEvents()).toHaveLength(0);
    expect(sysCounters()["io.ms.ipc:dialog"]).toBe(60_000);
  });

  it("never throws from its own accounting (clock-safe)", async () => {
    await expect(
      tracedIo("ipc:clipboard", "复制", () => Promise.resolve("ok"))
    ).resolves.toBe("ok");
    expect(sysCounters()["io.ipc:clipboard"]).toBe(1);
  });
});
