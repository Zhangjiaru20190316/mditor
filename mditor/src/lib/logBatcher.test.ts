// LogBatcher 的行为验证：批量合并（行数触发/周期触发/手动）、队列溢出丢
// 最旧、写失败上报与计数、start/stop 定时器管理——全部用注入的定时器/
// 写入器，node 环境确定性运行，不碰真实 IPC。
import { describe, expect, it, vi } from "vitest";
import { LogBatcher, type LogBatcherOptions } from "./logBatcher";

interface Harness {
  writes: string[];
  failures: Array<{ err: unknown; dropped: number }>;
  timerFn: (() => void) | null;
  opts: Partial<LogBatcherOptions> & { write: LogBatcherOptions["write"] };
}

function makeHarness(fail = false): Harness {
  const h: Harness = {
    writes: [],
    failures: [],
    timerFn: null,
    opts: {
      write: fail
        ? vi.fn(async () => {
            throw new Error("append_log Err");
          })
        : vi.fn(async (text: string) => {
            h.writes.push(text);
          }),
    },
  };
  h.opts.onFailure = (err, dropped) => h.failures.push({ err, dropped });
  h.opts.setTimer = (fn) => {
    h.timerFn = fn;
    return 1;
  };
  h.opts.clearTimer = () => {
    h.timerFn = null;
  };
  return h;
}

function makeBatcher(h: Harness, over: Partial<LogBatcherOptions> = {}): LogBatcher {
  return new LogBatcher({
    maxQueue: 5,
    flushAfterLines: 3,
    flushIntervalMs: 1000,
    ...h.opts,
    ...over,
  } as LogBatcherOptions);
}

describe("LogBatcher", () => {
  it("queues lines below the flush threshold without writing", async () => {
    const h = makeHarness();
    const b = makeBatcher(h);
    b.append('{"a":1}');
    b.append('{"a":2}');
    expect(b.snapshot().queued).toBe(2);
    await Promise.resolve();
    expect(h.writes).toEqual([]);
  });

  it("flushes joined lines (trailing newline) when the threshold is hit", async () => {
    const h = makeHarness();
    const b = makeBatcher(h);
    b.append('{"a":1}');
    b.append('{"a":2}');
    b.append('{"a":3}');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.writes).toEqual(['{"a":1}\n{"a":2}\n{"a":3}\n']);
    const s = b.snapshot();
    expect(s.written).toBe(3);
    expect(s.queued).toBe(0);
    expect(s.flushes).toBe(1);
  });

  it("drops the oldest lines on queue overflow and counts them", async () => {
    const h = makeHarness();
    // 阈值调高，专门观察溢出。
    const b = makeBatcher(h, { flushAfterLines: 99 });
    b.append("1");
    b.append("2");
    b.append("3");
    b.append("4");
    b.append("5");
    b.append("6"); // 溢出：丢 1
    expect(b.snapshot().queued).toBe(5);
    expect(b.snapshot().dropped).toBe(1);
    await b.flush();
    expect(h.writes[0].split("\n")[0]).toBe("2");
  });

  it("reports write failures with the dropped line count", async () => {
    const h = makeHarness(true);
    const b = makeBatcher(h, { flushAfterLines: 2 });
    b.append("1");
    b.append("2");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.failures).toEqual([{ err: expect.any(Error), dropped: 2 }]);
    const s = b.snapshot();
    expect(s.failures).toBe(1);
    expect(s.written).toBe(0);
    expect(s.queued).toBe(0); // 失败即丢，绝不无限重排
  });

  it("re-arms the periodic timer only while running", async () => {
    const h = makeHarness();
    const b = makeBatcher(h, { flushAfterLines: 99 });
    b.start();
    expect(h.timerFn).not.toBeNull();
    b.append("x");
    // 手动触发一次「到期」：写完应重新武装。
    h.timerFn!();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.writes).toEqual(["x\n"]);
    expect(h.timerFn).not.toBeNull();
    b.stop();
    expect(h.timerFn).toBeNull();
  });

  it("manual flush is safe when idle (empty queue no-ops)", async () => {
    const h = makeHarness();
    const b = makeBatcher(h);
    await expect(b.flush()).resolves.toBeUndefined();
    expect(h.writes).toEqual([]);
    expect(b.snapshot().flushes).toBe(0);
  });
});
