// 云同步状态订阅（v4.12，§5.6 / §7.5.2；v4.13 起鸿蒙同路径装配）。
//
// 所有窗口渲染同一份 sync-state（引擎在 main 广播）。不支持的运行时
// （browser 预览）恒 { status: "idle", supported: false }——不注册监听
// （零装配红线），消费方据此隐藏指示器。手动同步统一 emit("sync-request")：
// 非 main 窗口由 main 引擎转发执行（D8）；main 窗口收到自己的 echo 由互斥
// 挡住重复。

import { useCallback, useEffect, useState } from "react";
import { getAdapter } from "../platform";
import { isSyncSupported } from "../lib/sync/s3";
import {
  getLastSyncState,
  subscribeSyncState,
} from "../lib/sync/status";
import type { SyncStateEvent, SyncStatus } from "../lib/sync/types";

export interface SyncApi {
  /** 当前状态（不支持的平台恒 idle）。 */
  status: SyncStatus;
  /** 当前运行时是否支持云同步（harmony=false——消费方据此不渲染入口）。 */
  supported: boolean;
  /** 最近一次状态事件（悬浮显示上次同步时间/摘要/错误详情用）。 */
  last: SyncStateEvent | null;
  /** 触发手动同步（转发语义，见文件头）。不支持的平台 no-op。 */
  syncNow: () => void;
}

export function useSync(): SyncApi {
  const supported = isSyncSupported();
  const [last, setLast] = useState<SyncStateEvent | null>(() => getLastSyncState());

  useEffect(() => {
    if (!supported) return; // 零装配红线：不支持的平台不注册任何监听
    const unlistenP = subscribeSyncState((evt) => setLast(evt));
    return () => {
      void unlistenP.then((fn) => fn());
    };
  }, [supported]);

  const syncNow = useCallback(() => {
    if (!supported) return;
    void getAdapter().app.emit("sync-request").catch(() => undefined);
  }, [supported]);

  return {
    status: supported ? (last?.status ?? "idle") : "idle",
    supported,
    last,
    syncNow,
  };
}
