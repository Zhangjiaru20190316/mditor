// 异常分析器（v4.2 开发者模式）——把三条诊断总线的事件流 + 全局运行时错误
// + 内存心跳，归类为带 MD-XXXX 错误代码的异常记录，供三处消费：
//   * DevAlerts 警告卡（subscribeDevAlerts 放行的弹出流）；
//   * 诊断面板「异常记录」小节（AnomalyTracker.list 快照）；
//   * dev-anomalies.log（lib/devMode.ts 每次出现都落盘）。
//
// 错误代码表（稳定 ID，用户反馈时直接引用）：
//   MD-1xxx 滚动/布局  1001 ghost 滚动 · 1002 视口大幅位移 · 1003 长任务
//                      >1s · 1004 文档高度突变
//   MD-2xxx 编辑命令    2001 命令静默失败（被 facade 吞掉的异常）
//   MD-3xxx 批注        3001 批注链路 error 级事件
//   MD-4xxx 内存        4001 堆持续增长（泄漏候选）· 4002 ProseMirror 视图
//                      残留 · 4003 内存自愈（编辑器重建）
//   MD-5xxx 运行时      5001 未捕获异常 · 5002 未处理 Promise 拒绝 ·
//                      5003 诊断日志写入自身失败
//
// 纯函数 + 显式状态的 Tracker（无定时器、无 DOM、无 IPC），node 环境可单测。
// 纪律与 annoDebug/scrollDebug 相同：所有公开入口 try/catch 永不抛错。

import type { AnnoDebugEvent } from "./annoDebug";
import type { OpErrorRecord } from "./opDebug";
import type { ScrollDebugEvent } from "./scrollDebug";

export type AnomalyLevel = "warn" | "error";

/** 一条被规则命中的异常。code 是稳定错误代码，title 面向用户。 */
export interface DevAnomaly {
  code: string;
  level: AnomalyLevel;
  title: string;
  detail: string;
  data?: Record<string, unknown>;
}

/** scroll 事件归因。数据形状见 scrollDebug.ts 的各 emit 点。 */
export function analyzeScrollEvent(e: ScrollDebugEvent): DevAnomaly | null {
  try {
    const d = e.data as Record<string, unknown> | undefined;
    if (e.kind === "session:ghost") {
      return {
        code: "MD-1001",
        level: "warn",
        title: "ghost 滚动（页面自己动）",
        detail: e.msg,
        data: e.data,
      };
    }
    // layout:shift 只有 |delta|>24px 才是 warn 级（emit 侧约定）。
    if (e.kind === "layout:shift" && e.level === "warn") {
      return {
        code: "MD-1002",
        level: "warn",
        title: `视口内容大幅位移 ${Math.abs(Number(d?.delta ?? 0))}px`,
        detail: e.msg,
        data: e.data,
      };
    }
    if (e.kind === "perf:longtask") {
      const dur = Number(d?.duration ?? 0);
      // >1s 才算异常（>150ms 的 warn 事件太常见，全部弹出只会造成轰炸）。
      if (dur > 1000) {
        return {
          code: "MD-1003",
          level: "warn",
          title: `主线程阻塞 ${dur}ms`,
          detail: e.msg,
          data: e.data,
        };
      }
      return null;
    }
    const hd = Number(d?.heightDelta ?? 0);
    if (
      (e.kind === "layout:height" || e.kind === "layout:shift") &&
      Math.abs(hd) > 1500
    ) {
      return {
        code: "MD-1004",
        level: "warn",
        title: `文档高度突变 ${hd >= 0 ? "+" : ""}${Math.round(hd)}px`,
        detail: e.msg,
        data: e.data,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 批注事件归因：error 级事件 + 内存自愈重建（useMemoryGuard 发出）。 */
export function analyzeAnnoEvent(e: AnnoDebugEvent): DevAnomaly | null {
  try {
    if (e.level === "error") {
      return {
        code: "MD-3001",
        level: "warn",
        title: `批注链路错误：${e.kind}`,
        detail: e.msg,
        data: e.data,
      };
    }
    if (e.kind === "editor.recreate") {
      return {
        code: "MD-4003",
        level: "warn",
        title: "内存自愈：编辑器重建",
        detail: e.msg,
        data: e.data,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 编辑命令静默失败归因（每次出现都是异常）。 */
export function analyzeOpError(r: OpErrorRecord): DevAnomaly | null {
  try {
    return {
      code: "MD-2001",
      level: "warn",
      title: `编辑命令静默失败：${r.op}`,
      detail: r.err,
      data: { op: r.op, err: r.err },
    };
  } catch {
    return null;
  }
}

/** 全局运行时错误（window error / unhandledrejection / ErrorBoundary）。 */
export function analyzeRuntimeError(
  source: "uncaught" | "rejection",
  message: string,
  stack?: string
): DevAnomaly | null {
  try {
    return source === "uncaught"
      ? {
          code: "MD-5001",
          level: "error",
          title: "未捕获异常",
          detail: message,
          data: stack ? { stack } : undefined,
        }
      : {
          code: "MD-5002",
          level: "error",
          title: "未处理的 Promise 拒绝",
          detail: message,
          data: stack ? { stack } : undefined,
        };
  } catch {
    return null;
  }
}

/** 诊断日志写入自身失败（自监控——append_log 的 Err 不该再被无声吞掉）。 */
export function analyzeLogWriteFailure(detail: string): DevAnomaly | null {
  try {
    return {
      code: "MD-5003",
      level: "error",
      title: "诊断日志写入失败",
      detail,
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 内存心跳趋势（纯逻辑，可单测）                                              */
/* -------------------------------------------------------------------------- */

/** 心跳窗口的单点（lib/devMode.ts 每 30s 采一次并维护环形窗口）。 */
export interface HeartbeatPoint {
  ts: number;
  used: number | null;
  prosemirrorViews: number | null;
}

/** 趋势判定至少需要的窗口跨度（3 分钟）：太短的斜率全是噪声。 */
export const HEAP_TREND_MIN_SPAN_MS = 3 * 60_000;
/** 泄漏候选斜率阈值（MB/分钟）。 */
export const HEAP_TREND_MB_PER_MIN = 2;
/** 除斜率外还要求的最小总增量（MB），过滤 GC 抖动。 */
export const HEAP_TREND_MIN_GAIN_MB = 50;

/**
 * 心跳窗口检查：末点 ProseMirror 视图残留 + 堆增长趋势。points 旧→新，
 * 调用方维持环形窗口（devMode 侧 15 分钟）。返回 0..2 条异常。
 */
export function analyzeHeartbeats(points: HeartbeatPoint[]): DevAnomaly[] {
  try {
    const out: DevAnomaly[] = [];
    const last = points.length ? points[points.length - 1] : null;
    if (last && last.prosemirrorViews != null && last.prosemirrorViews > 1) {
      out.push({
        code: "MD-4002",
        level: "warn",
        title: `ProseMirror 视图残留（${last.prosemirrorViews} 个，应为 1）`,
        detail: "编辑器重建后旧视图 DOM 未释放——重建泄漏的标志",
        data: { prosemirrorViews: last.prosemirrorViews },
      });
    }
    const withUsed = points.filter(
      (p): p is HeartbeatPoint & { used: number } => p.used != null
    );
    if (withUsed.length >= 6) {
      const first = withUsed[0];
      const end = withUsed[withUsed.length - 1];
      const spanMs = end.ts - first.ts;
      if (spanMs >= HEAP_TREND_MIN_SPAN_MS) {
        const gainMb = (end.used - first.used) / (1024 * 1024);
        const spanMin = spanMs / 60_000;
        const slope = gainMb / spanMin;
        if (gainMb >= HEAP_TREND_MIN_GAIN_MB && slope >= HEAP_TREND_MB_PER_MIN) {
          out.push({
            code: "MD-4001",
            level: "warn",
            title: `堆内存持续增长 ${slope.toFixed(1)} MB/分`,
            detail: `窗口 ${spanMin.toFixed(1)} 分钟内 +${gainMb.toFixed(0)}MB——泄漏候选`,
            data: { slopeMbPerMin: Number(slope.toFixed(2)), gainMb: Math.round(gainMb), spanMin: Number(spanMin.toFixed(1)) },
          });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* 冷却合并追踪器                                                              */
/* -------------------------------------------------------------------------- */

/** 同代码告警冷却窗：窗口内每次出现都记账/落盘，但只放行一次「弹窗」。 */
export const ALERT_COOLDOWN_MS = 60_000;

/** 一类异常的累计视图（诊断面板 / 复制报告用）。 */
export interface TrackedAnomaly {
  code: string;
  level: AnomalyLevel;
  title: string;
  /** 自 tracker 创建/重置以来的总出现次数。 */
  count: number;
  firstTs: number;
  lastTs: number;
  lastDetail: string;
  lastData?: Record<string, unknown>;
}

/**
 * 同代码冷却合并：每次出现都记账（count/首末时间/最近详情），但只有过了
 * ALERT_COOLDOWN_MS 冷却窗才放行一次弹窗——异常风暴时用户 60s 至多见同
 * 代码一张卡，而日志/面板计数照常累计。
 */
export class AnomalyTracker {
  private tracked = new Map<string, TrackedAnomaly>();
  private lastAlertAt = new Map<string, number>();

  /** 记一次出现；返回是否应弹出（过了冷却窗）。 */
  record(a: DevAnomaly, now = Date.now()): boolean {
    try {
      let t = this.tracked.get(a.code);
      if (!t) {
        t = {
          code: a.code,
          level: a.level,
          title: a.title,
          count: 0,
          firstTs: now,
          lastTs: now,
          lastDetail: a.detail,
        };
        this.tracked.set(a.code, t);
      }
      t.count += 1;
      t.lastTs = now;
      t.lastDetail = a.detail;
      t.lastData = a.data;
      // undefined = 从未告警（不能用 ?? 0：小时间戳下 0 会被当成
      // 「epoch 0 已告警」，首次出现被误抑制）。
      const last = this.lastAlertAt.get(a.code);
      if (last === undefined || now - last >= ALERT_COOLDOWN_MS) {
        this.lastAlertAt.set(a.code, now);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** 快照（最近发生优先）。 */
  list(): TrackedAnomaly[] {
    try {
      return [...this.tracked.values()].sort((a, b) => b.lastTs - a.lastTs);
    } catch {
      return [];
    }
  }

  reset(): void {
    this.tracked.clear();
    this.lastAlertAt.clear();
  }
}
