// IO/IPC 边界计时与失败遥测（v4.3）——tauriFs / fileOps / dialogs /
// clipboard / ai 的统一插桩点：成功只进计数器（次数 + 累计毫秒），失败/超慢
// 发系统总线事件（lib/sysDebug），错误原样向上抛——**绝不改变调用方语义**，
// 只加观测。对话框类不设慢阈值（时长=用户思考时间，不是异常）。
//
// 纯逻辑（时钟注入可测）；诊断纪律：永不抛错、永不重试、永不阻塞。
//
// 发射侧门控（Q1a）：诊断双关闭（记录器与面板，diagRecordingOn 见
// lib/devMode）时不做计时/计数/事件——被包装的 IO 操作本身照常执行，
// 返回值与异常语义和未包装完全一致（只卸观测，不改语义）。

import { sysCount, sysEmit } from "./sysDebug";
import { diagRecordingOn } from "./devMode";

export type IoKind =
  | "file:read"
  | "file:write"
  | "file:mut"
  | "ipc:dialog"
  | "ipc:clipboard"
  | "ipc:invoke"
  | "ai:request"
  | "ai:embed";

/** 慢阈值默认 2s（文件读写/IPC 的卡顿证据）；Infinity = 不判慢。 */
const DEFAULT_SLOW_MS = 2000;

function errMsg(err: unknown): string {
  try {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  } catch {
    return "unformattable error";
  }
}

/**
 * 包一层异步 IO：量耗时、记计数、失败/超慢发系统总线事件后原样重抛。
 * 永不吞错、永不改变返回值——调用方行为与不包完全一致。
 */
export async function tracedIo<T>(
  kind: IoKind,
  label: string,
  run: () => Promise<T>,
  opts: { slowMs?: number; now?: () => number } = {}
): Promise<T> {
  // Q1a 门控：诊断关闭时退化为直接调用——操作必须执行，错误必须原样
  // 向上抛，只是不再计时/计数/发事件。
  if (!diagRecordingOn()) return run();
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  try {
    const r = await run();
    const ms = Math.max(0, Math.round(now() - t0));
    sysCount(`io.${kind}`);
    sysCount(`io.ms.${kind}`, ms);
    const slowMs = opts.slowMs ?? DEFAULT_SLOW_MS;
    if (ms > slowMs) {
      sysEmit(
        `${kind}-slow`,
        `${label} 耗时 ${ms}ms（阈值 ${slowMs}ms）`,
        { level: "warn", data: { label, ms, slowMs } }
      );
    }
    return r;
  } catch (err) {
    const ms = Math.max(0, Math.round(now() - t0));
    sysEmit(
      `${kind}-fail`,
      `${label} 失败（${ms}ms）：${errMsg(err)}`,
      { level: "error", data: { label, ms, err: errMsg(err) } }
    );
    throw err;
  }
}
