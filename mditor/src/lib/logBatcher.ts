// 批量落盘队列（v4.2 开发者模式）——把高频诊断行合并成尽量少的 append_log
// IPC 调用：满 flushAfterLines 行立即冲、或每 flushIntervalMs 冲一次，多次
// 合并为一次 write（行间补 \n）。队列上限 maxQueue，溢出丢最旧并计数——
// 记录器宁可丢旧行也绝不阻塞编辑器。
//
// 纯逻辑（写入器/定时器/时钟全部可注入），node 环境可单测；生产组装在
// lib/devMode.ts（write = invoke append_log）。

export interface LogBatcherStats {
  /** 当前滞留队列行数。 */
  queued: number;
  /** 成功写出的总行数。 */
  written: number;
  /** 队列溢出丢弃的行数。 */
  dropped: number;
  /** flush 次数（含空冲不计数）。 */
  flushes: number;
  /** write 失败次数（该批已丢， onFailure 上报）。 */
  failures: number;
}

export interface LogBatcherOptions {
  maxQueue: number;
  /** 队列达到该行数立即冲（不等周期）。 */
  flushAfterLines: number;
  /** 周期冲的间隔。 */
  flushIntervalMs: number;
  /** 合并后的多行文本（行间已补 \n、含结尾换行）。失败时 reject。 */
  write: (lines: string) => Promise<void>;
  /** write 失败回调（err + 本批被丢弃的行数）。 */
  onFailure?: (err: unknown, droppedLines: number) => void;
  /** 定时器注入点（默认 setTimeout，测试用）。 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export class LogBatcher {
  private queue: string[] = [];
  private timer: unknown = null;
  private running = false;
  private flushing = false;
  private readonly o: LogBatcherOptions;
  private readonly setTimer: NonNullable<LogBatcherOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<LogBatcherOptions["clearTimer"]>;
  private stats: LogBatcherStats = {
    queued: 0,
    written: 0,
    dropped: 0,
    flushes: 0,
    failures: 0,
  };

  constructor(opts: LogBatcherOptions) {
    this.o = opts;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      opts.clearTimer ?? ((id) => clearTimeout(id as number | undefined));
  }

  /** 启动周期冲刷（幂等）。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.arm();
  }

  /** 停止周期冲刷（不清队列——调用方可再 flush 收尾）。 */
  stop(): void {
    this.running = false;
    if (this.timer != null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** 追加一行（不含换行）。满 flushAfterLines 立即异步冲。永不抛出。 */
  append(line: string): void {
    if (this.queue.length >= this.o.maxQueue) {
      this.queue.shift();
      this.stats.dropped += 1;
    }
    this.queue.push(line);
    if (this.queue.length >= this.o.flushAfterLines) void this.flush();
  }

  /** 立即冲刷（周期与收尾共用）。并发安全（flushing 期间的新行等下一轮）。 */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await this.o.write(batch.join("\n") + "\n");
      this.stats.written += batch.length;
      this.stats.flushes += 1;
    } catch (err) {
      this.stats.failures += 1;
      try {
        this.o.onFailure?.(err, batch.length);
      } catch {
        /* onFailure 自身也永不抛出 */
      }
    } finally {
      this.flushing = false;
    }
  }

  /** 统计快照（queued 实时，其余为累计）。 */
  snapshot(): LogBatcherStats {
    return { ...this.stats, queued: this.queue.length };
  }

  private arm(): void {
    this.timer = this.setTimer(() => {
      void this.flush().finally(() => {
        if (this.running) this.arm();
      });
    }, this.o.flushIntervalMs);
  }
}
