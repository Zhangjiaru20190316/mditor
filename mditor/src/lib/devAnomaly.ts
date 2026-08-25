// 异常分析器（v4.3 开发者模式）——把四条诊断总线（scrollDebug 滚动 /
// annoDebug 批注 / opDebug 编辑命令 / sysDebug 系统链路）的事件流 + 全局
// 运行时错误 + 内存心跳 + 帧统计，归类为带 MD-XXXX 错误代码的异常记录，
// 供三处消费：
//   * DevAlerts 警告卡（subscribeDevAlerts 放行的弹出流）；
//   * 诊断面板「异常记录」小节（AnomalyTracker.list 快照）；
//   * dev-anomalies.log（lib/devMode.ts 每次出现都落盘，附环境/操作上下文）。
//
// ── 错误代码表（稳定 ID，用户反馈时直接引用；旧码语义不变、不回收、
//    不重排，新码向后兼容）──────────────────────────────────────────
//   MD-1xxx 滚动/布局
//     1001 ghost 滚动（页面自己动）· 1002 视口大幅位移 · 1003 长任务 >1s ·
//     1004 文档高度突变 · 1011 PM 顶层块批量替换（remembered size 丢失）
//     （info 事件不产异常：viewport:resize 视口尺寸变化 / session:resize
//      尺寸变化引发的滚动 / layout:clamp 钳制——均不计 ghost）
//   MD-2xxx 编辑命令（按命令类别细分，v4.3）
//     2001 未分类命令静默失败 · 2011 块结构命令 · 2012 行内格式命令 ·
//     2013 文档写入命令（setValue/aiWrite 等）· 2014 应用/窗口命令
//   MD-3xxx 批注（按链路阶段细分，v4.3）
//     3001 未分类批注错误 · 3011 盖章/徽章渲染 · 3012 批注写入（定点/回退）·
//     3013 批注流式 · 3014 批注体检
//   MD-4xxx 内存
//     4001 堆持续增长（泄漏候选）· 4002 ProseMirror 视图残留 ·
//     4003 内存自愈（编辑器重建）· 4011 DOM 节点持续增长（游离 DOM 候选）
//     （cm-editor / KaTeX 计数随文档内容波动，只进心跳上下文不设告警；
//      监听器泄漏无通用测度，不设码）
//   MD-5xxx 运行时（按来源细分，v4.3）
//     5001 未捕获异常 · 5002 未处理 Promise 拒绝 · 5003 诊断日志写入失败 ·
//     5011 渲染层异常（ErrorBoundary）· 5012 资源加载失败（图片/字体/脚本）
//   MD-6xxx 文件与持久化（新大类，v4.3）
//     6001 文件读取失败 · 6002 文件写入/保存失败 · 6003 文件结构操作失败
//     （删除/重命名/新建）· 6004 文件监听异常
//   MD-7xxx Tauri/IPC 边界（新大类，v4.3）
//     7001 IPC 调用失败 · 7002 IO/IPC 调用异常缓慢（>2s）·
//     7003 对话框调用失败 · 7004 剪贴板调用失败
//   MD-8xxx AI 链路（新大类，v4.3）
//     8001 AI 请求失败 · 8002 AI 流式中断/错误 · 8003 AI 流式异常结束 ·
//     8004 AI 响应异常（用户中止 abort 仅记 info 事件，不设码）
//   MD-9xxx 性能/渲染（新大类，v4.3）
//     9001 持续掉帧（心跳窗内 >50ms 帧间隔 ≥10 次）·
//     9002 布局抖动风暴（2s 内 ≥3 次 warn 级视口位移）·
//     9003 输入响应卡顿（心跳窗内按键→帧延迟 >100ms ≥8 次）
//
// ── 级别策略 ──────────────────────────────────────────────────────
//   error（告警卡 + 原生弹窗）：5001 / 5002 / 5003 / 5011
//   warn（仅告警卡）：其余全部异常码
//   info：仅记事件（总线环形缓冲 + dev-events.log），永不产异常记录
// 告警轰炸防线：全部新码与旧码一样过 AnomalyTracker 同码 60s 冷却合并。
//
// 纯函数 + 显式状态的 Tracker（无定时器、无 DOM、无 IPC），node 环境可单测。
// 纪律与各总线相同：所有公开入口 try/catch 永不抛错。

import type { AnnoDebugEvent } from "./annoDebug";
import type { OpErrorRecord } from "./opDebug";
import type { ScrollFrameStats, ScrollDebugEvent } from "./scrollDebug";
import type { SysDebugEvent } from "./sysDebug";

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
    // layout:shift 只有 |delta|>24px 且非用户/尺寸变化引发才是 warn 级
    // （emit 侧约定）；emit 侧对用户刚改布局（500ms 窗）与视口尺寸变化
    // 因果窗内的 shift 已降为 info，userInitiated / cause=resize 检查是
    // 纵深防御——emit 规则漂移也不误弹。
    if (
      e.kind === "layout:shift" &&
      e.level === "warn" &&
      d?.userInitiated !== true &&
      d?.cause !== "resize"
    ) {
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
    // 旧码语义不变：只读 heightDelta（layout:shift 合并事件携带；
    // layout:height 纯高度事件沿用历史行为，不新增触发面）。
    const hd = Number(d?.heightDelta ?? 0);
    if (
      (e.kind === "layout:height" || e.kind === "layout:shift") &&
      Math.abs(hd) > 1500 &&
      d?.userInitiated !== true &&
      d?.cause !== "resize"
    ) {
      return {
        code: "MD-1004",
        level: "warn",
        title: `文档高度突变 ${hd >= 0 ? "+" : ""}${Math.round(hd)}px`,
        detail: e.msg,
        data: e.data,
      };
    }
    if (e.kind === "pm:rebuild" && e.level === "warn") {
      return {
        code: "MD-1011",
        level: "warn",
        title: "PM 顶层块批量替换",
        detail: e.msg,
        data: e.data,
      };
    }
    // pm:root-swap（编辑器重建）由 MD-4003（anno editor.recreate）承载，
    // 此处保持事件级，不重复设码。
    return null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 编辑命令细分（v4.3）：按命令类别给码，未分类兜底 2001                        */
/* -------------------------------------------------------------------------- */

export type OpCategory = "block" | "inline" | "docwrite" | "app" | "other";

/** 命令名 → 类别（纯字符串规则，可单测）。新增命令落错类别只影响码位，
 *  不影响是否报错——任何 noteOpError 都至少落到 2001。 */
export function classifyOpCategory(op: string): OpCategory {
  if (/moveBlock|duplicateBlock|deleteBlock|setBlockType|tableOp|block/i.test(op)) {
    return "block";
  }
  if (
    /toggleMark|toggleInlineCode|setTextColor|clearTextColor|insertLink|updateLinkHref|insertFootnote/i.test(
      op
    )
  ) {
    return "inline";
  }
  if (/setValue|insertValue|updateValue|insertAfter|insertAtPos|revealText|aiWrite/i.test(op)) {
    return "docwrite";
  }
  if (/shutdown|window-close|menu-exit/i.test(op)) {
    return "app";
  }
  return "other";
}

const OP_CODE_BY_CATEGORY: Record<OpCategory, string> = {
  block: "MD-2011",
  inline: "MD-2012",
  docwrite: "MD-2013",
  app: "MD-2014",
  other: "MD-2001",
};

const OP_TITLE_BY_CATEGORY: Record<OpCategory, string> = {
  block: "块结构命令静默失败",
  inline: "行内格式命令静默失败",
  docwrite: "文档写入命令静默失败",
  app: "应用/窗口命令静默失败",
  other: "编辑命令静默失败",
};

/** 编辑命令静默失败归因（每次出现都是异常，按类别细分）。 */
export function analyzeOpError(r: OpErrorRecord): DevAnomaly | null {
  try {
    const cat = classifyOpCategory(r.op);
    return {
      code: OP_CODE_BY_CATEGORY[cat],
      level: "warn",
      title: `${OP_TITLE_BY_CATEGORY[cat]}：${r.op}`,
      detail: r.err,
      data: { op: r.op, err: r.err, category: cat },
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 批注细分（v4.3）：error 级事件按链路阶段给码；重建归 4003                    */
/* -------------------------------------------------------------------------- */

function annoStageCode(kind: string): string {
  if (/^badge\.patch|^stamp/.test(kind)) return "MD-3011";
  if (/^anno\./.test(kind)) return "MD-3012";
  if (/^stream\./.test(kind)) return "MD-3013";
  if (/^health\./.test(kind)) return "MD-3014";
  return "MD-3001";
}

/** 批注事件归因：error 级事件按阶段细分 + 内存自愈重建（useMemoryGuard 发出）。 */
export function analyzeAnnoEvent(e: AnnoDebugEvent): DevAnomaly | null {
  try {
    if (e.level === "error") {
      return {
        code: annoStageCode(e.kind),
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

/* -------------------------------------------------------------------------- */
/* 运行时细分（v4.3）：渲染层 / 资源加载单列                                    */
/* -------------------------------------------------------------------------- */

/** 全局运行时错误（window error / unhandledrejection）。 */
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

/** ErrorBoundary 捕获的渲染异常（React 拦下 window error，须单列溯源）。 */
export function analyzeRenderError(label: string, message: string, stack?: string): DevAnomaly | null {
  try {
    return {
      code: "MD-5011",
      level: "error",
      title: "渲染层异常（ErrorBoundary）",
      detail: message,
      data: { ...(label ? { label } : {}), ...(stack ? { stack } : {}) },
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
/* 系统链路事件归因（v4.3）：文件 / IPC / AI / 资源                             */
/* -------------------------------------------------------------------------- */

/** 系统总线事件 → 异常码。kind 由 ipcTrace / 各插桩点约定：
 *  file:{read,write,mut,watch}-fail、ipc:{invoke,dialog,clipboard}-fail、
 *  *-slow、ai:{request-fail,stream-fail,stream-abnormal-end,response-fail}、
 *  res:load-fail。info 级（lifecycle:* / ai:stream-abort / 成功计数）不产异常。 */
export function analyzeSysEvent(e: SysDebugEvent): DevAnomaly | null {
  try {
    if (e.kind === "file:read-fail") {
      return { code: "MD-6001", level: "warn", title: "文件读取失败", detail: e.msg, data: e.data };
    }
    if (e.kind === "file:write-fail") {
      return { code: "MD-6002", level: "warn", title: "文件写入/保存失败", detail: e.msg, data: e.data };
    }
    if (e.kind === "file:mut-fail") {
      return { code: "MD-6003", level: "warn", title: "文件结构操作失败", detail: e.msg, data: e.data };
    }
    if (e.kind === "file:watch-fail") {
      return { code: "MD-6004", level: "warn", title: "文件监听异常", detail: e.msg, data: e.data };
    }
    if (e.kind === "ipc:invoke-fail") {
      return { code: "MD-7001", level: "warn", title: "IPC 调用失败", detail: e.msg, data: e.data };
    }
    if (e.kind.endsWith("-slow")) {
      return { code: "MD-7002", level: "warn", title: "IO/IPC 调用异常缓慢", detail: e.msg, data: e.data };
    }
    if (e.kind === "ipc:dialog-fail") {
      return { code: "MD-7003", level: "warn", title: "对话框调用失败", detail: e.msg, data: e.data };
    }
    if (e.kind === "ipc:clipboard-fail") {
      return { code: "MD-7004", level: "warn", title: "剪贴板调用失败", detail: e.msg, data: e.data };
    }
    if (e.kind === "ai:request-fail") {
      return { code: "MD-8001", level: "warn", title: "AI 请求失败", detail: e.msg, data: e.data };
    }
    if (e.kind === "ai:stream-fail") {
      return { code: "MD-8002", level: "warn", title: "AI 流式中断", detail: e.msg, data: e.data };
    }
    if (e.kind === "ai:stream-abnormal-end") {
      return { code: "MD-8003", level: "warn", title: "AI 流式异常结束", detail: e.msg, data: e.data };
    }
    if (e.kind === "ai:response-fail") {
      return { code: "MD-8004", level: "warn", title: "AI 响应异常", detail: e.msg, data: e.data };
    }
    if (e.kind === "res:load-fail") {
      return { code: "MD-5012", level: "warn", title: "资源加载失败", detail: e.msg, data: e.data };
    }
    return null;
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
  /** 重 DOM 采样（开发者模式强制开启）下的文档节点数，缺省=未采。 */
  domNodes?: number | null;
}

/** 趋势判定至少需要的窗口跨度（3 分钟）：太短的斜率全是噪声。 */
export const HEAP_TREND_MIN_SPAN_MS = 3 * 60_000;
/** 泄漏候选斜率阈值（MB/分钟）。 */
export const HEAP_TREND_MB_PER_MIN = 2;
/** 除斜率外还要求的最小总增量（MB），过滤 GC 抖动。 */
export const HEAP_TREND_MIN_GAIN_MB = 50;
/** DOM 节点持续增长的最小总增量（节点数）——保守设防：正常编辑远低于此。 */
export const DOM_TREND_MIN_GAIN = 30_000;
/** DOM 节点增长斜率阈值（节点/分钟）。 */
export const DOM_TREND_PER_MIN = 1_500;

/**
 * 心跳窗口检查：末点 ProseMirror 视图残留 + 堆增长趋势 + DOM 节点增长
 * 趋势。points 旧→新，调用方维持环形窗口（devMode 侧 15 分钟）。
 * 返回 0..3 条异常。
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
    const withDom = points.filter(
      (p): p is HeartbeatPoint & { domNodes: number } =>
        p.domNodes != null && p.domNodes > 0
    );
    if (withDom.length >= 6) {
      const first = withDom[0];
      const end = withDom[withDom.length - 1];
      const spanMs = end.ts - first.ts;
      if (spanMs >= HEAP_TREND_MIN_SPAN_MS) {
        const gain = end.domNodes - first.domNodes;
        const spanMin = spanMs / 60_000;
        const slope = gain / spanMin;
        if (gain >= DOM_TREND_MIN_GAIN && slope >= DOM_TREND_PER_MIN) {
          out.push({
            code: "MD-4011",
            level: "warn",
            title: `DOM 节点持续增长 ${Math.round(slope)} 节点/分`,
            detail: `窗口 ${spanMin.toFixed(1)} 分钟内 +${gain} 节点——游离 DOM/重建残留候选`,
            data: { domPerMin: Math.round(slope), gain, spanMin: Number(spanMin.toFixed(1)) },
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
/* 性能/渲染（v4.3）：帧统计差分 + 位移抖动风暴（纯逻辑，可单测）               */
/* -------------------------------------------------------------------------- */

/** 心跳窗内掉帧（>50ms 帧间隔）次数达到此值 → MD-9001。 */
export const JANK_FRAME_THRESHOLD = 10;
/** 心跳窗内输入延迟（按键→帧 >100ms）次数达到此值 → MD-9003。 */
export const INPUT_LAG_THRESHOLD = 8;
/** 位移抖动风暴窗口（ms）。 */
export const SHIFT_BURST_WINDOW_MS = 2000;
/** 窗口内 warn 级视口位移达到此次数 → MD-9002。 */
export const SHIFT_BURST_MIN = 3;

/**
 * 相邻两次帧统计快照的差分（心跳调用）：窗口内掉帧/输入延迟超阈值时给出
 * MD-9001 / MD-9003。prev 晚于 cur（面板清空/记录器重开）→ 无异常。
 */
export function analyzeFrameStatsDelta(
  prev: ScrollFrameStats | null,
  cur: ScrollFrameStats
): DevAnomaly[] {
  try {
    if (!prev) return [];
    const out: DevAnomaly[] = [];
    const jank = cur.jankFrames - prev.jankFrames;
    if (jank >= JANK_FRAME_THRESHOLD) {
      out.push({
        code: "MD-9001",
        level: "warn",
        title: `持续掉帧（>50ms 间隔 ×${jank}）`,
        detail: `本心跳窗内 ${jank} 帧间隔超过 50ms，最坏 ${Math.round(cur.worstGapMs)}ms`,
        data: { jankFrames: jank, worstGapMs: Math.round(cur.worstGapMs) },
      });
    }
    const lag = cur.inputLagEvents - prev.inputLagEvents;
    if (lag >= INPUT_LAG_THRESHOLD) {
      out.push({
        code: "MD-9003",
        level: "warn",
        title: `输入响应卡顿（×${lag}）`,
        detail: `本心跳窗内 ${lag} 次按键→上屏帧延迟超过 100ms，最坏 ${Math.round(cur.worstInputLagMs)}ms`,
        data: { inputLagEvents: lag, worstInputLagMs: Math.round(cur.worstInputLagMs) },
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 位移抖动风暴：warn 级 layout:shift 的时间戳（旧→新）里，最近
 * SHIFT_BURST_WINDOW_MS 内出现 ≥SHIFT_BURST_MIN 次 → MD-9002。
 */
export function analyzeShiftBurst(
  warnShiftTs: readonly number[],
  now: number
): DevAnomaly | null {
  try {
    let burst = 0;
    for (let i = warnShiftTs.length - 1; i >= 0; i--) {
      if (now - warnShiftTs[i] > SHIFT_BURST_WINDOW_MS) break;
      burst += 1;
    }
    if (burst >= SHIFT_BURST_MIN) {
      return {
        code: "MD-9002",
        level: "warn",
        title: `布局抖动风暴（${SHIFT_BURST_WINDOW_MS / 1000}s 内 ×${burst}）`,
        detail: "视口内容连续大幅位移——重排风暴/补偿振荡候选",
        data: { burst, windowMs: SHIFT_BURST_WINDOW_MS },
      };
    }
    return null;
  } catch {
    return null;
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
