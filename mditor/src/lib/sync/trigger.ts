// 同步触发器与装配（§5.5，仅 main 窗口）。
//
// 职责：手动/保存后防抖/定时/启动触发、同根互斥、offline 判定与恢复补跑、
// sync-request 转发监听（非 main 窗口的手动同步请求）。多根工作区逐根串行。
//
// 鸿蒙零装配（§7.5.2）：assembleSyncTrigger() 入口先判 isSyncSupported()，
// 不支持直接返回 null——不创建定时器、不注册任何监听、不挂 onSaved 钩子。
// App 的装配点据此短路，与 D8 的多窗口转发逻辑互不影响（装配点只有 main
// 一处，叠加运行时判定即可）。

import { getAdapter } from "../../platform";
import type { Settings } from "../../types";
import { sysEmit } from "../sysDebug";
import { createDefaultSyncIO, syncWorkspace } from "./engine";
import { isSyncSupported, parseSyncError, syncConfigPayload, SYNC_ERROR_CODES } from "./s3";
import { publishSyncState } from "./status";
import type { SyncSummary, SyncStateEvent } from "./types";
import { EMPTY_SYNC_SUMMARY } from "./types";

/** 保存后防抖（保存链路高频，避免风暴）。 */
const SAVE_DEBOUNCE_MS = 5_000;
/** 启动延迟（避开启动性能竞争）。 */
const STARTUP_DELAY_MS = 15_000;
/** offline 恢复探测间隔（不受 autoSyncIntervalMin=0 影响——恢复即自动补跑）。 */
const OFFLINE_RETRY_MS = 60_000;
/** 连续网络类错误 ≥2 次转入 offline。 */
const OFFLINE_THRESHOLD = 2;

export interface SyncTriggerOptions {
  /** 读最新设置（App 经 ref 提供稳定回调）。 */
  getSettings: () => Settings;
  /** 读当前工作区根列表。 */
  getRoots: () => string[];
}

export interface SyncTrigger {
  /** 保存成功后调用（防抖 5s；autoSync 关闭时为 no-op）。 */
  onSaved(): void;
  /** 立即同步全部根（互斥：进行中则静默跳过）。 */
  syncNow(reason?: string): Promise<void>;
  dispose(): void;
}

/**
 * 装配同步触发器。前置条件（App 装配点保证）：main 窗口 + sync.enabled。
 * 返回 null = 当前运行时不支持（鸿蒙）——调用方不得注册任何东西。
 */
export function assembleSyncTrigger(opts: SyncTriggerOptions): SyncTrigger | null {
  // 唯一判定入口（§7.5.1）：不支持的运行时零装配直接返回。
  if (!isSyncSupported()) return null;

  let disposed = false;
  let running = false;
  let netErrorStreak = 0;
  let offline = false;
  // interval 与 timeout 分开收（规范上 id 空间独立，清理要各归各）。
  const intervals: number[] = [];
  const timeouts: number[] = [];

  const enabled = () => opts.getSettings().sync.enabled;

  /** 同步全部根（串行）。互斥：running 期间再触发静默跳过（§5.4）。 */
  async function syncAll(): Promise<void> {
    if (disposed || running || !enabled()) return;
    running = true;
    const s = opts.getSettings().sync;
    const roots = opts.getRoots();
    const cfg = syncConfigPayload(s);
    const total: SyncSummary = { ...EMPTY_SYNC_SUMMARY, notes: [] };
    let fatal: { code: string; message: string } | null = null;

    try {
      for (const root of roots) {
        if (disposed) return;
        await publishSyncState({ status: "syncing", phase: "scan", root, done: 0, total: 0 });
        try {
          const outcome = await syncWorkspace(root, s.prefix, createDefaultSyncIO(cfg), {
            onState: (e) => {
              void publishSyncState({
                status: "syncing",
                phase: e.phase,
                root,
                done: e.done,
                total: e.total,
                currentFile: e.currentFile,
              });
            },
            warn: (msg) => {
              sysEmit("sync:file-warn", `云同步警告：${msg}`, { level: "warn", data: { root } });
              total.notes.push(msg);
            },
          });
          accumulate(total, outcome.summary);
          netErrorStreak = 0; // 任一根成功即视为链路可用
        } catch (e) {
          const info = parseSyncError(e);
          // 根级失败（List/凭证/网络）——诊断 + 计数；单根失败不中断其余根。
          sysEmit("sync:run-fail", `云同步失败（${info.code}）：${info.message}`, {
            level: "warn",
            data: { root, code: info.code },
          });
          total.failed++;
          fatal = fatal ?? info;
          if (info.code === SYNC_ERROR_CODES.NETWORK || info.code === SYNC_ERROR_CODES.TIMEOUT) {
            netErrorStreak++;
          }
        }
      }

      // offline 判定：连续网络类错误达阈值转入；任何成功即恢复（本轮已补跑）。
      if (netErrorStreak >= OFFLINE_THRESHOLD && !offline) {
        offline = true;
        sysEmit("sync:offline", "云同步转入离线状态（连续网络错误）", { data: {} });
        armOfflineRetry();
      }
      if (offline && netErrorStreak === 0) offline = false;

      const evt: SyncStateEvent = offline
        ? { status: "offline", root: roots[0] ?? "", done: 0, total: 0, error: fatal ?? undefined }
        : fatal && total.failed > 0 && total.uploaded + total.downloaded === 0
          ? { status: "error", root: roots[0] ?? "", done: 0, total: 0, error: fatal }
          : { status: "idle", done: 0, total: 0, lastSyncAt: Date.now() };
      await publishSyncState(evt);
      if (evt.status === "idle") {
        sysEmit("sync:done", "云同步完成", {
          data: {
            roots: roots.length,
            up: total.uploaded,
            down: total.downloaded,
            conflicts: total.conflicts,
            failed: total.failed,
          },
        });
      }
    } finally {
      running = false;
    }
  }

  function accumulate(into: SyncSummary, s: SyncSummary): void {
    into.uploaded += s.uploaded;
    into.downloaded += s.downloaded;
    into.deletedLocal += s.deletedLocal;
    into.deletedRemote += s.deletedRemote;
    into.conflicts += s.conflicts;
    into.skipped += s.skipped;
    into.failed += s.failed;
    into.notes.push(...s.notes);
    into.lastSyncAt = s.lastSyncAt;
  }

  /** offline 恢复探测：每 60s 试跑一次，成功（netErrorStreak 归零 → offline
   *  置 false）即自动补跑完成；本轮探测本身走 syncAll 全量。 */
  let offlineRetryTimer: number | null = null;
  function armOfflineRetry(): void {
    if (offlineRetryTimer != null || disposed) return;
    offlineRetryTimer = setInterval(() => {
      if (!offline || disposed) {
        if (offlineRetryTimer != null) clearInterval(offlineRetryTimer);
        offlineRetryTimer = null;
        return;
      }
      void syncAll();
    }, OFFLINE_RETRY_MS);
    intervals.push(offlineRetryTimer);
  }

  // ---- 触发源装配 -----------------------------------------------------------

  // 保存后防抖（仅 autoSync 开启时生效）。
  let saveTimer: number | null = null;
  const onSaved = (): void => {
    if (disposed || !opts.getSettings().sync.autoSync) return;
    if (saveTimer != null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void syncAll();
    }, SAVE_DEBOUNCE_MS);
  };

  // 定时（0 = 关闭；装配点在设置变化时 dispose + 重建，这里只按当次值挂）。
  const intervalMin = opts.getSettings().sync.autoSyncIntervalMin;
  if (opts.getSettings().sync.autoSync && intervalMin > 0) {
    intervals.push(setInterval(() => void syncAll(), intervalMin * 60_000));
  }

  // 启动延迟一次。
  if (opts.getSettings().sync.syncOnStart) {
    timeouts.push(setTimeout(() => void syncAll(), STARTUP_DELAY_MS));
  }

  // 非 main 窗口的手动同步请求转发（D8；main 收到自己的 echo 无害——互斥挡住）。
  const unlistenP = getAdapter().app.listen("sync-request", () => {
    void syncAll();
  });

  return {
    onSaved,
    syncNow: async () => {
      await syncAll();
    },
    dispose(): void {
      disposed = true;
      for (const t of intervals) clearInterval(t);
      for (const t of timeouts) clearTimeout(t);
      if (saveTimer != null) clearTimeout(saveTimer);
      void unlistenP.then((fn) => fn());
    },
  };
}
