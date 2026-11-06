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
  // HN 轮：Windows spike 结论 A（docs/html-note-spike-report.md）。
  htmlNoteView: true,
  // MF 轮：pdfjs / docx-preview 桌面直读（字节经 fs.readFile 二进制通道）。
  pdfNoteView: true,
  docxNoteView: true,
  // DE 轮：docx 结构化编辑 + 文字 PDF 微编辑（spike 闸门已过，见
  // docs/doc-note-edit-spike-report.md）。
  docNoteEdit: true,
  // PI2（应用内打印）：PrintDialog + 自研 PDF 管线排版 + Rust GDI 直打
  // （printing.rs），全程应用内完成、全仓零 webview print 调用。
  print: true,
};

export const tauriAdapter: PlatformAdapter = {
  runtime: "tauri",
  fs: tauriFs,
  dialog: tauriDialog,
  store: tauriStore,
  app: tauriApp,
  capabilities: ALL_TRUE,
};
