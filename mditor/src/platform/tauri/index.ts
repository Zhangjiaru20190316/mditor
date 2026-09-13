// Tauri 平台适配器组装（鸿蒙迁移 v4.11）。
// Windows 桌面版一切能力可用——能力矩阵全 true，行为与迁移前一致。

import type { PlatformAdapter, PlatformCapabilities } from "../types";
import { tauriFs } from "./fs";
import { tauriDialog } from "./dialog";
import { tauriStore } from "./store";
import { tauriApp } from "./app";

const ALL_TRUE: PlatformCapabilities = {
  ai: true,
  multiWindow: true,
  watch: true,
  trash: true,
  pdfExport: true,
  richExport: true,
  remoteImageProxy: true,
  windowControls: true,
};

export const tauriAdapter: PlatformAdapter = {
  runtime: "tauri",
  fs: tauriFs,
  dialog: tauriDialog,
  store: tauriStore,
  app: tauriApp,
  capabilities: ALL_TRUE,
};
