// 操作级遥测（v3.9.5）——编辑命令的「静默失败」从此永远可见。
//
// 起因：blockCommands 的 dispatchScrolled 自递归让 6 条块命令的事务从不
// 派发（RangeError 被 facade 的空 catch 吞掉），用户只看到「块操作编辑
// 存不下来」，而控制台 / 日志 / 诊断面板没有任何错误痕迹——静默吞掉的
// 异常是最难排查的失败形态。本模块给 facade 所有「编辑类」命令的空
// catch 接上遥测：计数 + 限频 console.warn + 环形缓冲，DevTools 出口
// window.__opDebug。返回 false/null 的 catch（调用方有回退逻辑）不属于
// 静默失败，不接入。
//
// 纪律与 annoDebug/scrollDebug 相同：诊断代码绝不能影响编辑器——所有
// 公开入口 try/catch，控制台输出限频（每个 op 首次必报，其后 10s 一次）。

export interface OpErrorRecord {
  ts: number;
  op: string;
  /** err.toString()，足够定位（RangeError/TypeError + 消息）。 */
  err: string;
}

const counters = new Map<string, number>();
const firstSeenAt = new Map<string, number>();
const lastWarnAt = new Map<string, number>();
/** 每个操作保留最近一条（面板/出口按 op 汇总，环形无必要）。 */
const lastError = new Map<string, OpErrorRecord>();
const subscribers = new Set<(r: OpErrorRecord) => void>();

const WARN_INTERVAL_MS = 10_000;

/** 记录一个被吞掉的编辑命令异常。永不抛出。 */
export function noteOpError(op: string, err: unknown): void {
  try {
    const now = Date.now();
    counters.set(op, (counters.get(op) ?? 0) + 1);
    const msg =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const rec: OpErrorRecord = { ts: now, op, err: msg };
    lastError.set(op, rec);
    // 订阅推送（开发者模式记录器用）；回调异常自动摘除，同 annoDebug。
    for (const fn of subscribers) {
      try {
        fn(rec);
      } catch {
        subscribers.delete(fn);
      }
    }
    const last = lastWarnAt.get(op) ?? 0;
    if (now - last >= WARN_INTERVAL_MS) {
      lastWarnAt.set(op, now);
      // 首次出现打 info 级醒目前缀；此后限频。任何被吞的异常至少要
      // 在控制台出现过一次——这是本次bug排查时缺失的最低保障。
      const first = !firstSeenAt.has(op);
      firstSeenAt.set(op, now);
      console.warn(
        `[mditor:op] 编辑命令「${op}」异常被吞（第 ${counters.get(op)} 次）：${msg}`
      );
      if (first) {
        console.warn(
          `[mditor:op] 该操作首次失败。若为持续性失败请用 window.__opDebug.report() 收集证据。`
        );
      }
    }
  } catch {
    /* never throw */
  }
}

/** 订阅静默失败推送（开发者模式记录器用）。返回退订函数。 */
export function opSubscribe(fn: (r: OpErrorRecord) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** 出口/面板读取：按 op 汇总的失败统计与最近错误。 */
export function opErrorStats(): {
  total: number;
  ops: Array<{ op: string; count: number; last: OpErrorRecord | null }>;
} {
  try {
    const ops = [...counters.entries()].map(([op, count]) => ({
      op,
      count,
      last: lastError.get(op) ?? null,
    }));
    ops.sort((a, b) => b.count - a.count);
    return { total: ops.reduce((s, o) => s + o.count, 0), ops };
  } catch {
    return { total: 0, ops: [] };
  }
}

/** DevTools 出口：window.__opDebug（attachOpDebugGlobal 注册）。 */
export function attachOpDebugGlobal(): void {
  try {
    if (typeof window === "undefined") return;
    (window as unknown as Record<string, unknown>).__opDebug = {
      stats: opErrorStats,
      report: () => {
        const s = opErrorStats();
        const lines = s.ops.map(
          (o) =>
            `${o.op}: ${o.count}× 最近 ${o.last ? new Date(o.last.ts).toISOString() : "-"} ${o.last?.err ?? ""}`
        );
        const text = s.total
          ? `被吞的编辑命令异常 ${s.total} 次：\n${lines.join("\n")}`
          : "无被吞的编辑命令异常";
        console.log(text);
        return text;
      },
    };
  } catch {
    /* never throw */
  }
}
