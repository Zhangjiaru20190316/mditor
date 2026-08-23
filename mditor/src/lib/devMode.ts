// 开发者模式记录器（v4.2，设置项 devMode）——排查 bug 的运行时黑匣子。
//
// 开启（App.tsx effect 调 enableDevRecorder）后：
//   * 全量订阅三条诊断总线：scrollDebug / annoDebug（订阅推送）+ opDebug
//     （opSubscribe），事件流逐条写入 dev-events.log（JSONL，经 LogBatcher
//     批量合并，满 50 行或每秒一次 append_log，2MB 轮转）；
//   * 捕获 window「error」与「unhandledrejection」；ErrorBoundary 捕获的
//     渲染异常经 noteRenderError 接入（React 会拦下 window error 事件）；
//   * 30s 心跳：sampleMemory（联动 setDiagForced 开启重 DOM 采样）+ 三总线
//     计数器快照，维护 15 分钟环形窗口供堆趋势分析；
//   * 每条输入同时过 lib/devAnomaly 规则，命中即写 dev-anomalies.log 并按
//     60s 冷却放行一次弹窗（DevAlerts 订阅）。
//
// 关闭（disableDevRecorder）= 全退订 + 移除钩子 + 冲尾批，零残留开销。
// 纪律与 annoDebug/scrollDebug 相同：诊断代码绝不影响编辑器——所有公开
// 入口 try/catch；append_log 失败只计数并报一次 MD-5003，绝不重试阻塞。

import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { joinAbs } from "./path-shim";
import { ensureDir } from "./tauriFs";
import { sampleMemory, setDiagForced } from "./diagnostics";
import { annoCounters, annoSubscribe, type AnnoDebugEvent } from "./annoDebug";
import {
  scrollCounters,
  scrollSubscribe,
  type ScrollDebugEvent,
} from "./scrollDebug";
import { opErrorStats, opSubscribe, type OpErrorRecord } from "./opDebug";
import { LogBatcher } from "./logBatcher";
import {
  ALERT_COOLDOWN_MS,
  AnomalyTracker,
  analyzeAnnoEvent,
  analyzeHeartbeats,
  analyzeLogWriteFailure,
  analyzeOpError,
  analyzeRuntimeError,
  analyzeScrollEvent,
  type DevAnomaly,
  type HeartbeatPoint,
  type TrackedAnomaly,
} from "./devAnomaly";

const EVENTS_LOG = "dev-events.log";
const ANOMALIES_LOG = "dev-anomalies.log";
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;
/** 心跳趋势窗口：30 点 × 30s = 15 分钟。 */
const HEARTBEAT_WINDOW = 30;
/** 单行上限：栈轨迹截断，防一条异常撑爆整批写入。 */
const MAX_LINE_CHARS = 4000;

export interface DevModeStats {
  enabled: boolean;
  startedAt: number | null;
  events: ReturnType<LogBatcher["snapshot"]> | null;
  anomalies: ReturnType<LogBatcher["snapshot"]> | null;
  /** append_log 总失败次数（两个 batcher 合计）。 */
  writeFailures: number;
  /** 弹窗冷却窗内被合并掉的出现次数（tracker 侧累计）。 */
  mergedAlerts: number;
}

let enabled = false;
let startedAt: number | null = null;
let writeFailures = 0;
let mergedAlerts = 0;
let unsubs: Array<() => void> = [];
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let eventsBatcher: LogBatcher | null = null;
let anomaliesBatcher: LogBatcher | null = null;
const tracker = new AnomalyTracker();
const heartbeats: HeartbeatPoint[] = [];
const alertSubs = new Set<(a: DevAnomaly) => void>();

function nowIso(): string {
  return new Date().toISOString();
}

let logsDirPromise: Promise<string> | null = null;

/** 解析（缓存）logs 目录绝对路径，不存在则创建。 */
function logsDir(): Promise<string> {
  if (!logsDirPromise) {
    logsDirPromise = (async () => {
      const ad = await invoke<string>("app_data_dir");
      const dir = joinAbs(ad, "logs");
      await ensureDir(dir);
      return dir;
    })();
  }
  return logsDirPromise;
}

/** 解析（每次 enable 各一次）日志文件绝对路径，确保 logs 目录存在。 */
async function resolveLogPath(file: string): Promise<string> {
  return joinAbs(await logsDir(), file);
}

function makeWriter(pathPromise: Promise<string>) {
  return async (text: string): Promise<void> => {
    const path = await pathPromise;
    await invoke("append_log", { path, line: text, maxBytes: LOG_MAX_BYTES });
  };
}

/** 统一的 JSONL 行构造（截断超长栈）。 */
function line(src: string, payload: Record<string, unknown>): string {
  let s: string;
  try {
    s = JSON.stringify({ ts: nowIso(), src, ...payload });
  } catch {
    s = JSON.stringify({ ts: nowIso(), src, msg: "unserializable payload" });
  }
  return s.length > MAX_LINE_CHARS
    ? s.slice(0, MAX_LINE_CHARS) + "…"
    : s;
}

/**
 * 记一条异常：每次出现都落盘 + 记账；过了冷却窗才推送弹窗（异常风暴时
 * 60s 至多一张同代码卡，计数照常累计）。
 */
function noteAnomaly(a: DevAnomaly | null): void {
  if (!a) return;
  try {
    anomaliesBatcher?.append(
      line("anomaly", {
        code: a.code,
        level: a.level,
        title: a.title,
        detail: a.detail,
        data: a.data,
      })
    );
    if (tracker.record(a)) {
      for (const fn of alertSubs) {
        try {
          fn(a);
        } catch {
          alertSubs.delete(fn);
        }
      }
    } else {
      mergedAlerts += 1;
    }
  } catch {
    /* never throw */
  }
}

function onScroll(e: ScrollDebugEvent): void {
  if (!enabled) return;
  try {
    eventsBatcher?.append(
      line("scroll", { level: e.level, kind: e.kind, msg: e.msg, data: e.data })
    );
    noteAnomaly(analyzeScrollEvent(e));
  } catch {
    /* never throw */
  }
}

function onAnno(e: AnnoDebugEvent): void {
  if (!enabled) return;
  try {
    eventsBatcher?.append(
      line("anno", { level: e.level, kind: e.kind, msg: e.msg, data: e.data })
    );
    noteAnomaly(analyzeAnnoEvent(e));
  } catch {
    /* never throw */
  }
}

function onOp(r: OpErrorRecord): void {
  if (!enabled) return;
  try {
    eventsBatcher?.append(
      line("op", { kind: r.op, msg: r.err, data: { op: r.op } })
    );
    noteAnomaly(analyzeOpError(r));
  } catch {
    /* never throw */
  }
}

function formatErr(err: unknown): { message: string; stack?: string } {
  try {
    if (err instanceof Error) {
      return {
        message: `${err.name}: ${err.message}`,
        stack: err.stack,
      };
    }
    return { message: String(err) };
  } catch {
    return { message: "unformattable error" };
  }
}

function onWindowError(ev: ErrorEvent | Event): void {
  if (!enabled) return;
  try {
    const e = ev as ErrorEvent;
    const where =
      typeof e.filename === "string" && e.filename
        ? `${e.filename}:${e.lineno ?? 0}`
        : "";
    const f = formatErr(e.error ?? e.message);
    const message = where ? `${where} ${f.message}` : f.message;
    eventsBatcher?.append(
      line("runtime", { kind: "window.onerror", msg: message, data: { stack: f.stack } })
    );
    noteAnomaly(analyzeRuntimeError("uncaught", message, f.stack));
  } catch {
    /* never throw */
  }
}

function onRejection(ev: PromiseRejectionEvent): void {
  if (!enabled) return;
  try {
    const f = formatErr((ev as PromiseRejectionEvent).reason);
    eventsBatcher?.append(
      line("runtime", { kind: "unhandledrejection", msg: f.message, data: { stack: f.stack } })
    );
    noteAnomaly(analyzeRuntimeError("rejection", f.message, f.stack));
  } catch {
    /* never throw */
  }
}

/**
 * ErrorBoundary 捕获的渲染异常接入（componentDidCatch 调用）。React 拦下了
 * 这类异常，window「error」监听收不到——必须显式送进记录器。
 */
export function noteRenderError(label: string, err: unknown): void {
  if (!enabled) return;
  try {
    const f = formatErr(err);
    const message = `[render${label ? "/" + label : ""}] ${f.message}`;
    eventsBatcher?.append(
      line("runtime", { kind: "error-boundary", msg: message, data: { stack: f.stack } })
    );
    noteAnomaly(analyzeRuntimeError("uncaught", message, f.stack));
  } catch {
    /* never throw */
  }
}

function onHeartbeat(): void {
  if (!enabled) return;
  try {
    const s = sampleMemory();
    const op = opErrorStats();
    eventsBatcher?.append(
      line("heartbeat", {
        mem: {
          used: s.used,
          total: s.total,
          limit: s.limit,
          prosemirrorViews: s.prosemirrorViews,
          domNodes: s.domNodes ?? null,
          cmEditors: s.cmEditors ?? null,
          katexNodes: s.katexNodes ?? null,
        },
        opTotal: op.total,
        counters: { ...scrollCounters(), ...annoCounters() },
      })
    );
    heartbeats.push({ ts: s.ts, used: s.used, prosemirrorViews: s.prosemirrorViews });
    if (heartbeats.length > HEARTBEAT_WINDOW) heartbeats.shift();
    for (const a of analyzeHeartbeats(heartbeats)) noteAnomaly(a);
  } catch {
    /* never throw */
  }
}

/** 开启记录器（幂等；App 在 devMode 设置变化时调用）。 */
export function enableDevRecorder(): void {
  if (enabled) return;
  try {
    enabled = true;
    startedAt = Date.now();
    writeFailures = 0;
    mergedAlerts = 0;
    tracker.reset();
    heartbeats.length = 0;
    // 开发者模式顺带拿到重 DOM 指标（domNodes/cmEditors/katex）。
    setDiagForced(true);

    const eventsPath = resolveLogPath(EVENTS_LOG);
    const anomaliesPath = resolveLogPath(ANOMALIES_LOG);
    const onEventsFailure = (_e: unknown, dropped: number): void => {
      writeFailures += 1;
      noteAnomaly(
        analyzeLogWriteFailure(
          `dev-events.log append_log 失败（本批丢弃 ${dropped} 行）`
        )
      );
    };
    eventsBatcher = new LogBatcher({
      maxQueue: 500,
      flushAfterLines: 50,
      flushIntervalMs: 1000,
      write: makeWriter(eventsPath),
      onFailure: onEventsFailure,
    });
    anomaliesBatcher = new LogBatcher({
      maxQueue: 200,
      // 异常低频且重要：来一条就冲，不等批。
      flushAfterLines: 1,
      flushIntervalMs: 2000,
      write: makeWriter(anomaliesPath),
      // 异常日志自身写失败只计数——报给谁都会自激励。
      onFailure: () => {
        writeFailures += 1;
      },
    });
    eventsBatcher.start();
    anomaliesBatcher.start();

    eventsBatcher.append(
      line("session", {
        kind: "dev-mode",
        msg: "enabled",
        data: { ua: typeof navigator !== "undefined" ? navigator.userAgent : null },
      })
    );

    unsubs = [
      scrollSubscribe(onScroll),
      annoSubscribe(onAnno),
      opSubscribe(onOp),
    ];
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onRejection);
    heartbeatTimer = setInterval(onHeartbeat, HEARTBEAT_MS);
    onHeartbeat(); // 立即采第一帧，趋势窗口尽早起算。
  } catch {
    /* never throw */
  }
}

/** 关闭记录器（幂等）：全退订 + 移除钩子 + 冲尾批。 */
export function disableDevRecorder(): void {
  if (!enabled) return;
  try {
    enabled = false;
    for (const u of unsubs) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    unsubs = [];
    window.removeEventListener("error", onWindowError);
    window.removeEventListener("unhandledrejection", onRejection);
    if (heartbeatTimer != null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    setDiagForced(false);
    const eb = eventsBatcher;
    const ab = anomaliesBatcher;
    eventsBatcher = null;
    anomaliesBatcher = null;
    eb?.append(line("session", { kind: "dev-mode", msg: "disabled" }));
    void eb?.flush().finally(() => eb.stop());
    void ab?.flush().finally(() => ab.stop());
    startedAt = null;
  } catch {
    /* never throw */
  }
}

export function devModeEnabled(): boolean {
  return enabled;
}

/** 异常累计快照（诊断面板 / 复制报告用；最近发生优先）。 */
export function recentAnomalies(): TrackedAnomaly[] {
  return tracker.list();
}

/** 订阅「过了冷却窗应弹出」的异常（DevAlerts 用）。返回退订函数。 */
export function subscribeDevAlerts(fn: (a: DevAnomaly) => void): () => void {
  alertSubs.add(fn);
  return () => alertSubs.delete(fn);
}

export function devModeStats(): DevModeStats {
  return {
    enabled,
    startedAt,
    events: eventsBatcher ? eventsBatcher.snapshot() : null,
    anomalies: anomaliesBatcher ? anomaliesBatcher.snapshot() : null,
    writeFailures,
    mergedAlerts,
  };
}

/** 手动冲刷（出口/测试用）。 */
export async function flushDevLogs(): Promise<void> {
  await eventsBatcher?.flush();
  await anomaliesBatcher?.flush();
}

/**
 * 在系统资源管理器打开 logs 目录（诊断面板「日志」按钮）。失败（如 shell
 * 权限被收回）时返回 null，调用方可回退为提示路径。
 */
export async function openLogsDir(): Promise<string | null> {
  try {
    const dir = await logsDir();
    await shellOpen(dir);
    return dir;
  } catch {
    return null;
  }
}

/** DevTools 出口：window.__devMode（attachDevModeGlobal 注册）。 */
export function attachDevModeGlobal(): void {
  try {
    if (typeof window === "undefined") return;
    (window as unknown as Record<string, unknown>).__devMode = {
      enabled: devModeEnabled,
      stats: devModeStats,
      anomalies: recentAnomalies,
      flush: flushDevLogs,
      report: () => {
        const s = devModeStats();
        const lines: string[] = [
          `开发者模式：${s.enabled ? "开" : "关"}${
            s.startedAt ? `，自 ${new Date(s.startedAt).toISOString()}` : ""
          }`,
          `事件日志：写入 ${s.events?.written ?? 0} 行 / 丢弃 ${
            s.events?.dropped ?? 0
          } / 失败 ${s.writeFailures}`,
          `异常（冷却 ${ALERT_COOLDOWN_MS / 1000}s，合并 ${s.mergedAlerts} 次）：`,
        ];
        for (const t of tracker.list()) {
          lines.push(
            `- ${t.code} ×${t.count} ${t.title}｜最近 ${new Date(
              t.lastTs
            ).toISOString()}：${t.lastDetail}`
          );
        }
        const text = lines.join("\n");
        console.log(text);
        return text;
      },
    };
  } catch {
    /* never throw */
  }
}
