// 开发者模式记录器（v4.2 建立 / v4.3 全面升级）——排查 bug 的运行时黑匣子。
//
// 开启（App.tsx effect 调 enableDevRecorder）后：
//   * 全量订阅四条诊断总线：scrollDebug / annoDebug（订阅推送）+ opDebug
//     （opSubscribe）+ sysDebug（系统链路：文件/IPC/AI/生命周期/资源），
//     事件流逐条写入 dev-events.log（JSONL，经 LogBatcher 批量合并，满 50
//     行或每秒一次 append_log，2MB 轮转）；
//   * 捕获 window「error」与「unhandledrejection」；ErrorBoundary 捕获的
//     渲染异常经 noteRenderError 接入（React 会拦下 window error 事件）；
//     资源加载失败（图片/字体/脚本）由 capture 版 error 监听单列（5012）；
//   * 环境与操作上下文（v4.3）：window 级捕获监听记录最近点击/快捷键，
//     App 注册文档概况 provider——每条异常落盘时附 ctx（环境快照 + 最近
//     操作 + 文档概况），不看代码也能定位场景；
//   * 30s 心跳：sampleMemory（联动 setDiagForced 开启重 DOM 采样）+ 四总
//     线计数器 + 环境/文档/帧统计快照 + 记录器自监控（写入/丢弃/合并数）
//     ，维护 15 分钟环形窗口供堆/DOM 趋势分析，帧统计差分与位移抖动风暴
//     在此判定（MD-9xxx）；
//   * 每条输入同时过 lib/devAnomaly 规则，命中即写 dev-anomalies.log 并按
//     60s 冷却放行一次弹窗（DevAlerts 订阅）。
//
// 关闭（disableDevRecorder）= 全退订 + 移除钩子 + 冲尾批，零残留开销。
// 纪律与各总线相同：诊断代码绝不影响编辑器——所有公开入口 try/catch；
// append_log 失败只计数并报一次 MD-5003，绝不重试阻塞。

import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { joinAbs } from "./path-shim";
import { ensureDir } from "./tauriFs";
import { sampleMemory, setDiagForced } from "./diagnostics";
import { annoCounters, annoSubscribe, type AnnoDebugEvent } from "./annoDebug";
import {
  scrollCounters,
  scrollFrameStats,
  scrollSubscribe,
  type ScrollDebugEvent,
  type ScrollFrameStats,
} from "./scrollDebug";
import { opErrorStats, opSubscribe, type OpErrorRecord } from "./opDebug";
import { sysCounters, sysEmit, sysSubscribe, type SysDebugEvent } from "./sysDebug";
import {
  buildDevContext,
  devEnvSnapshot,
  noteUserAction,
} from "./devContext";
import { LogBatcher } from "./logBatcher";
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
 * 记一条异常：每次出现都落盘 + 记账（附环境/操作/文档上下文，v4.3——异常
 * 记录拿到手即可定位场景）；过了冷却窗才推送弹窗（异常风暴时 60s 至多一
 * 张同代码卡，计数照常累计）。
 */
function noteAnomaly(a: DevAnomaly | null): void {
  if (!a) return;
  try {
    let enriched = a;
    try {
      const ctx = buildDevContext();
      enriched = { ...a, data: { ...(a.data ?? {}), ctx } };
    } catch {
      /* 上下文失败不阻断记录本体 */
    }
    anomaliesBatcher?.append(
      line("anomaly", {
        code: enriched.code,
        level: enriched.level,
        title: enriched.title,
        detail: enriched.detail,
        data: enriched.data,
      })
    );
    if (tracker.record(enriched)) {
      for (const fn of alertSubs) {
        try {
          fn(enriched);
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
    // 位移抖动风暴（MD-9002）的素材：warn 级 layout:shift 时间戳环。
    if (e.kind === "layout:shift" && e.level === "warn") {
      warnShiftTs.push(Date.now());
      if (warnShiftTs.length > 8) warnShiftTs.shift();
    }
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

/** 系统链路总线（v4.3）：文件/IPC/AI/生命周期/资源事件 → 事件日志 + 归类。 */
function onSys(e: SysDebugEvent): void {
  if (!enabled) return;
  try {
    eventsBatcher?.append(
      line("sys", { level: e.level, kind: e.kind, msg: e.msg, data: e.data })
    );
    noteAnomaly(analyzeSysEvent(e));
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
 * 这类异常，window「error」监听收不到——必须显式送进记录器（v4.3 起单列
 * MD-5011 渲染层异常，与 window onerror 的 5001 区分来源）。
 */
export function noteRenderError(label: string, err: unknown): void {
  if (!enabled) return;
  try {
    const f = formatErr(err);
    const message = `[render${label ? "/" + label : ""}] ${f.message}`;
    eventsBatcher?.append(
      line("runtime", { kind: "error-boundary", msg: message, data: { stack: f.stack } })
    );
    noteAnomaly(analyzeRenderError(label, message, f.stack));
  } catch {
    /* never throw */
  }
}

/* --------------------------------------------------------------------------
 * 环境与操作上下文捕获（v4.3）：最近点击 / 快捷键 / 打字，随异常附盘。
 * ------------------------------------------------------------------------ */

/** 生成点击目标的简短描述符（叶子/浅层元素才读 textContent，避免大子树遍历）。 */
function describeClickTarget(t: EventTarget | null): string {
  try {
    const el = t as Element | null;
    if (!el || typeof (el as Element).tagName !== "string") return "pointerdown";
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls =
      typeof el.className === "string" && el.className
        ? `.${el.className.trim().split(/\s+/)[0]}`
        : "";
    let text = "";
    if (el.childElementCount <= 2) {
      text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 16);
    }
    return `${tag}${id}${cls}${text ? `「${text}」` : ""}`;
  } catch {
    return "pointerdown";
  }
}

/** 上一次「typing」动作时刻：连续打字合并成一条，避免冲掉操作环。 */
let lastTypingAt = 0;

const onActionPointerDown = (e: PointerEvent): void => {
  try {
    noteUserAction("click", describeClickTarget(e.target));
  } catch {
    /* never throw */
  }
};

const onActionKey = (e: KeyboardEvent): void => {
  try {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      const mods = `${e.ctrlKey ? "Ctrl+" : ""}${e.metaKey ? "Meta+" : ""}${e.altKey ? "Alt+" : ""}`;
      noteUserAction("key", `${mods}${e.key}`);
      return;
    }
    // 普通打字不记键名（噪声），2s 合并成一条「typing」。
    const now = Date.now();
    if (now - lastTypingAt > 2000) noteUserAction("key", "typing");
    lastTypingAt = now;
  } catch {
    /* never throw */
  }
};

/** 资源加载失败（图片/webfont/脚本，capture 版 error，target 是元素而非
 *  window）——懒加载图片失败、字体拉取失败在此留痕（MD-5012）。常驻监听
 * （与总线同口径：环形缓冲永远可回看），持久化由 onSys 按 enable 决定。 */
const onResourceError = (ev: Event): void => {
  try {
    const t = ev.target as Element | null;
    if (!t || !t.tagName || t === (window as unknown as Element)) return;
    const tag = t.tagName.toLowerCase();
    const src = String(
      (t as HTMLImageElement).currentSrc ||
        (t as HTMLImageElement).src ||
        (t as HTMLLinkElement).href ||
        ""
    );
    sysEmit("res:load-fail", `资源加载失败：${tag} ${src.slice(0, 120)}`, {
      level: "warn",
      data: { tag, src: src.slice(0, 300) },
    });
  } catch {
    /* never throw */
  }
};

/* --------------------------------------------------------------------------
 * 心跳（30s）：内存 / 环境快照 / 文档概况 / 帧统计差分 / 四总线计数器 /
 * 记录器自监控——一条心跳即一份「当时的世界」快照。
 * ------------------------------------------------------------------------ */

/** warn 级视口位移时间戳环（MD-9002 抖动风暴判定素材）。 */
const warnShiftTs: number[] = [];
/** 上一次帧统计快照（差分用；null = 本会话首拍）。 */
let prevFrameStats: ScrollFrameStats | null = null;

function onHeartbeat(): void {
  if (!enabled) return;
  try {
    const s = sampleMemory();
    const op = opErrorStats();
    const fs = scrollFrameStats();
    const frameAnoms = analyzeFrameStatsDelta(prevFrameStats, fs);
    prevFrameStats = fs;
    const burst = analyzeShiftBurst(warnShiftTs, Date.now());
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
        env: devEnvSnapshot(),
        doc: buildDevContext().doc,
        frame: {
          frames: fs.frames,
          jankFrames: fs.jankFrames,
          worstGapMs: Math.round(fs.worstGapMs),
          inputLagEvents: fs.inputLagEvents,
          worstInputLagMs: Math.round(fs.worstInputLagMs),
        },
        opTotal: op.total,
        counters: {
          ...scrollCounters(),
          ...annoCounters(),
          ...sysCounters(),
        },
        self: {
          events: eventsBatcher?.snapshot() ?? null,
          anomalies: anomaliesBatcher?.snapshot() ?? null,
          writeFailures,
          mergedAlerts,
          uptimeMs: startedAt != null ? Date.now() - startedAt : null,
        },
      })
    );
    heartbeats.push({
      ts: s.ts,
      used: s.used,
      prosemirrorViews: s.prosemirrorViews,
      domNodes: s.domNodes ?? null,
    });
    if (heartbeats.length > HEARTBEAT_WINDOW) heartbeats.shift();
    for (const a of analyzeHeartbeats(heartbeats)) noteAnomaly(a);
    for (const a of frameAnoms) noteAnomaly(a);
    if (burst) noteAnomaly(burst);
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
    warnShiftTs.length = 0;
    prevFrameStats = null;
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
        data: {
          ua: typeof navigator !== "undefined" ? navigator.userAgent : null,
          env: devEnvSnapshot(),
        },
      })
    );

    unsubs = [
      scrollSubscribe(onScroll),
      annoSubscribe(onAnno),
      opSubscribe(onOp),
      sysSubscribe(onSys),
    ];
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onResourceError, true);
    window.addEventListener("pointerdown", onActionPointerDown, {
      capture: true,
      passive: true,
    });
    window.addEventListener("keydown", onActionKey, true);
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
    window.removeEventListener("error", onResourceError, true);
    window.removeEventListener("pointerdown", onActionPointerDown, true);
    window.removeEventListener("keydown", onActionKey, true);
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
        const env = devEnvSnapshot();
        const lines: string[] = [
          `开发者模式：${s.enabled ? "开" : "关"}${
            s.startedAt ? `，自 ${new Date(s.startedAt).toISOString()}` : ""
          }`,
          `环境：v${env.ver} ${env.platform} ${env.win ? `${env.win.w}×${env.win.h}@${env.dpr}x` : ""} 主题=${env.theme ?? "?"} 模式=${env.mode ?? "?"} big=${env.big} 最大化=${env.maximized}`,
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
        const sys = sysCounters();
        const sysKeys = Object.keys(sys).filter((k) => k.startsWith("io."));
        if (sysKeys.length) {
          lines.push(`IO/IPC 计数：${sysKeys.map((k) => `${k}=${sys[k]}`).join(" ")}`);
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
