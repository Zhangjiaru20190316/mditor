// 系统链路诊断总线（v4.3 开发者模式升级）——文件 IO / IPC(Tauri) / AI /
// 生命周期 / 资源加载这条「编辑器之外」的链路，此前完全没有运行时证据：
// 读写失败被上层 catch 吞掉、AI 流式中断只剩 UI 提示、对话框挂死无从定罪。
//
// 形状与 annoDebug / scrollDebug 完全一致（环形缓冲 + 计数器 + 订阅推送，
// 常驻零成本，面板随时打开回看），kind 惯例：
//   * file:*    读/写/结构变更/监听（openMd、saveMd、delete、watch……）
//   * ipc:*     Tauri 边界（对话框、剪贴板、invoke 失败/超慢）
//   * ai:*      AI 链路（请求失败、流式中断/异常结束、响应异常、用户中止）
//   * lifecycle:* 启动/编辑器重建/模式切换/标签切换的阶段耗时
//   * res:*     资源加载失败（图片/webfont/脚本）
// 失败/异常事件 level=error 或 warn，成功路径只进计数器（io.file:read 等）
// ——事件环留给异常，计数器承载「总量与耗时分布」。
//
// 归类规则在 lib/devAnomaly.ts（MD-6xxx 文件 / MD-7xxx IPC / MD-8xxx AI），
// 三处消费与三条既有总线一致：DevAlerts 卡、诊断面板、dev-events.log。
// 纪律同其他总线：所有公开入口 try/catch 永不抛错，绝不影响编辑器。

export type SysDebugLevel = "info" | "warn" | "error";

export interface SysDebugEvent {
  ts: number;
  level: SysDebugLevel;
  kind: string;
  msg: string;
  data?: Record<string, unknown>;
}

const EVENT_CAPACITY = 300;

const events: SysDebugEvent[] = [];
const counters = new Map<string, number>();
const subscribers = new Set<(e: SysDebugEvent) => void>();

export function sysCount(key: string, n = 1): void {
  try {
    counters.set(key, (counters.get(key) ?? 0) + n);
  } catch {
    /* never throw */
  }
}

/** 发一条事件（自动 sysCount(kind)）。诊断链路永不抛错。 */
export function sysEmit(
  kind: string,
  msg: string,
  opts: { level?: SysDebugLevel; data?: Record<string, unknown>; count?: number } = {}
): void {
  try {
    const e: SysDebugEvent = {
      ts: Date.now(),
      level: opts.level ?? "info",
      kind,
      msg,
      data: opts.data,
    };
    events.push(e);
    if (events.length > EVENT_CAPACITY) events.shift();
    sysCount(kind, opts.count);
    for (const fn of subscribers) {
      try {
        fn(e);
      } catch {
        subscribers.delete(fn);
      }
    }
  } catch {
    /* never throw */
  }
}

/** 订阅新事件（开发者模式记录器 / 诊断面板用）。返回退订函数。 */
export function sysSubscribe(fn: (e: SysDebugEvent) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function sysEvents(): readonly SysDebugEvent[] {
  return events;
}

export function sysCounters(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Array.from(counters.entries()).sort(([a], [b]) => (a < b ? -1 : 1))) {
    out[k] = v;
  }
  return out;
}

/** 清空事件与计数器（诊断面板「清空」按钮）。 */
export function sysDebugClear(): void {
  events.length = 0;
  counters.clear();
}

/** DevTools 出口：window.__sysDebug（attachSysDebugGlobal 注册）。 */
export function attachSysDebugGlobal(): void {
  try {
    if (typeof window === "undefined") return;
    (window as unknown as Record<string, unknown>).__sysDebug = {
      events: sysEvents,
      counters: sysCounters,
      clear: sysDebugClear,
    };
  } catch {
    /* SSR / 无 window 环境静默 */
  }
}
