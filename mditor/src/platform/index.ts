// 平台适配层入口（鸿蒙迁移 v4.11）。
//
// 运行时检测（不依赖 UA——ArkWeb 默认 UA 含 HarmonyOS 标识但不可靠）：
//   * window.__TAURI_INTERNALS__      → tauri（Tauri 注入）
//   * window.__MDITOR_HARMONY__       → harmony（ArkTS 在 document start 注入）
//   * 皆无                            → browser（npm run dev 纯浏览器预览）
//   * 无 window（vitest node 环境）   → 按 tauri 处理，维持既有单测里
//     vi.mock 的 Tauri 模块拦截语义（零回归的安全网）。
//
// browser 运行时仍由 tauri 适配器兜底（调用行为与迁移前的静默失败完全
// 一致），另由 main.tsx 显示明确的预览提示条。

import type { PlatformAdapter, RuntimeName } from "./types";
import { tauriAdapter } from "./tauri";
import { harmonyAdapter } from "./harmony";

export type { PlatformAdapter, RuntimeName } from "./types";
export { UnsupportedError } from "./errors";

let cachedRuntime: RuntimeName | null = null;
let cachedAdapter: PlatformAdapter | null = null;

export function detectRuntime(): RuntimeName {
  if (cachedRuntime) return cachedRuntime;
  if (typeof window === "undefined") {
    cachedRuntime = "tauri"; // vitest node 环境（见上）
  } else if ("__TAURI_INTERNALS__" in window) {
    cachedRuntime = "tauri";
  } else if (
    (window as { __MDITOR_HARMONY__?: unknown }).__MDITOR_HARMONY__
  ) {
    cachedRuntime = "harmony";
  } else {
    cachedRuntime = "browser";
  }
  return cachedRuntime;
}

/** 取当前平台的适配器（进程级单例；业务代码唯一入口）。 */
export function getAdapter(): PlatformAdapter {
  cachedAdapter ??= detectRuntime() === "harmony" ? harmonyAdapter : tauriAdapter;
  return cachedAdapter;
}
