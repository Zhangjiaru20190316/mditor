// Tauri 平台的应用域实现（鸿蒙迁移 v4.11）：invoke 命令 / 事件总线 /
// 窗口操作 / 插件能力的收口。全部是既有调用点的搬运，语义不变。
//
// 注意：getCurrentWindow() 必须惰性求值——vitest（node 环境）会经
// platform/index 静态 import 本模块，模块顶层调用它会在无 window 的
// 环境里直接抛错拖垮所有单测。

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { exit } from "@tauri-apps/plugin-process";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import type { PlatformApp, PlatformWindow } from "../types";

let windowCache: PlatformWindow | null = null;

function tauriWindow(): PlatformWindow {
  windowCache ??= (() => {
    const w = getCurrentWindow();
    return {
      label: w.label,
      minimize: () => w.minimize(),
      toggleMaximize: () => w.toggleMaximize(),
      close: () => w.close(),
      destroy: () => w.destroy(),
      setTitle: (title) => w.setTitle(title),
      isMaximized: () => w.isMaximized(),
      onResized: (handler) => w.onResized(handler),
      isFullscreen: () => w.isFullscreen(),
      setFullscreen: (flag) => w.setFullscreen(flag),
      onDragDropEvent: (handler) => w.onDragDropEvent(handler),
      onCloseRequested: (handler) => w.onCloseRequested(handler),
      onFocusChanged: (handler) => w.onFocusChanged(handler),
    };
  })();
  return windowCache;
}

export const tauriApp: PlatformApp = {
  invoke: (command, args) => invoke(command, args),
  appDataDir: () => invoke<string>("app_data_dir"),
  appendLog: (path, line, maxBytes) =>
    invoke("append_log", { path, line, maxBytes }),
  version: () => getVersion(),
  getPendingFile: () => invoke<string | null>("get_pending_file"),
  // S1：运行时路径授权（对话框选择/启动恢复/双击打开/拖放的收口点调用）。
  grantFsScope: (paths, recursive) =>
    invoke("grant_fs_scope", { paths, recursive }).then(() => undefined),
  // S2：系统凭据存储（Windows Credential Manager，Rust secrets.rs）。
  secretSet: (key, value) =>
    invoke("secret_set", { key, value }).then(() => undefined),
  secretGet: (key) => invoke<string | null>("secret_get", { key }),
  secretDel: (key) => invoke("secret_del", { key }).then(() => undefined),
  trashFile: (path) => invoke("trash_file", { path }),
  fetchImage: async (url) =>
    new Uint8Array(await invoke<ArrayBuffer>("fetch_image", { url })),
  convertFileSrc: (path) => convertFileSrc(path),
  openExternal: (target) => shellOpen(target),
  exitApp: (code = 0) => exit(code),
  webviewWindowCount: () => WebviewWindow.getAll().then((ws) => ws.length),
  createDocWindow: (path, handoff) =>
    invoke<string>("create_doc_window", { path, handoff }),
  stashTabPayload: (payloadJson) =>
    invoke<string>("stash_tab_payload", { payload: payloadJson }),
  takeTabPayload: (id) => invoke<string | null>("take_tab_payload", { id }),
  listen: (event, handler) => listen(event, handler),
  emit: (event, payload) => emit(event, payload),
  get window() {
    return tauriWindow();
  },
};
