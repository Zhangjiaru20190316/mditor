// sync-state 事件的订阅/发布（§5.6）。
//
// 引擎（main 窗口装配）经 publishSyncState → 适配层 app.emit 全窗口广播；
// 所有窗口 useSync 经 subscribeSyncState 订阅渲染。鸿蒙零装配（引擎不装、
// 不注册监听），本模块代码不运行。

import { getAdapter } from "../../platform";
import type { SyncStateEvent } from "./types";

/** 进程内最近一次状态（useSync 挂载时同步初始化用，避免首帧空窗）。 */
let lastState: SyncStateEvent | null = null;

export function getLastSyncState(): SyncStateEvent | null {
  return lastState;
}

/** 广播一次同步状态（emit 失败静默——状态事件丢失不影响同步本身）。 */
export async function publishSyncState(evt: SyncStateEvent): Promise<void> {
  lastState = evt;
  await getAdapter().app.emit("sync-state", evt).catch(() => undefined);
}

/** 订阅同步状态；返回取消函数。 */
export function subscribeSyncState(
  handler: (evt: SyncStateEvent) => void
): Promise<() => void> {
  return getAdapter().app.listen<SyncStateEvent>("sync-state", (ev) => {
    lastState = ev.payload;
    handler(ev.payload);
  });
}
