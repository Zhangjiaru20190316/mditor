// 设置归一与切片（Q4「types 必是类型」拆分：normalizeSyncSettings /
// pickEditorSettings 自 src/types.ts 迁来；默认值常量在 defaults.ts，
// 类型在 types.ts）。纯数据操作，鸿蒙运行同样无副作用。

import { DEFAULT_SYNC_SETTINGS, SYNC_PROVIDER_IDS } from "./defaults";
import type { EditorSettings, Settings, SyncSettings } from "./types";

/**
 * sync 设置的幂等归一（migrateSettings 每次加载都会跑）：缺失补默认、
 * prefix 规范化（非空时以 / 结尾且不以 / 开头）、非法 interval 归 10、
 * 非法 provider 归 custom。纯数据操作，鸿蒙运行同样无副作用。
 */
export function normalizeSyncSettings(raw: unknown): SyncSettings {
  const d = DEFAULT_SYNC_SETTINGS;
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<SyncSettings>;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" ? v : fallback;
  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === "boolean" ? v : fallback;

  // prefix：去空白 → 去前导 / → 非空补尾随 /（空串 = 无前缀，合法）。
  let prefix = str(s.prefix, d.prefix).trim().replace(/^\/+/, "");
  if (prefix !== "" && !prefix.endsWith("/")) prefix += "/";

  const interval = Number(s.autoSyncIntervalMin);
  return {
    enabled: bool(s.enabled, d.enabled),
    provider:
      typeof s.provider === "string" && SYNC_PROVIDER_IDS.has(s.provider)
        ? s.provider
        : d.provider,
    endpoint: str(s.endpoint, d.endpoint),
    region: str(s.region, d.region),
    bucket: str(s.bucket, d.bucket),
    accessKeyId: str(s.accessKeyId, d.accessKeyId),
    secretAccessKey: str(s.secretAccessKey, d.secretAccessKey),
    sessionToken: str(s.sessionToken, d.sessionToken ?? ""),
    pathStyle: bool(s.pathStyle, d.pathStyle),
    prefix,
    autoSync: bool(s.autoSync, d.autoSync),
    autoSyncIntervalMin:
      Number.isFinite(interval) && interval >= 0 ? Math.floor(interval) : d.autoSyncIntervalMin,
    syncOnStart: bool(s.syncOnStart, d.syncOnStart),
  };
}

export function pickEditorSettings(s: Settings): EditorSettings {
  return {
    autosaveIntervalMs: s.autosaveIntervalMs,
    memoryGuard: s.memoryGuard,
    memoryGuardThresholdMb: s.memoryGuardThresholdMb,
    spellcheck: s.spellcheck,
    typewriterMode: s.typewriterMode,
    fontFamily: s.fontFamily,
    monoFontFamily: s.monoFontFamily,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    paragraphSpacing: s.paragraphSpacing,
    mathMacros: s.mathMacros,
    bigDocPerformance: s.bigDocPerformance,
    bigDocViewport: s.bigDocViewport,
  };
}
