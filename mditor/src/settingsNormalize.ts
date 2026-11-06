// 设置归一与切片（Q4「types 必是类型」拆分：normalizeSyncSettings /
// pickEditorSettings 自 src/types.ts 迁来；默认值常量在 defaults.ts，
// 类型在 types.ts）。纯数据操作，鸿蒙运行同样无副作用。

import { DEFAULT_SYNC_SETTINGS, NOTE_KINDS, SYNC_PROVIDER_IDS } from "./defaults";
import type { EditorSettings, NoteKind, RootSyncOptions, Settings, SyncSettings, WorkspaceOptions } from "./types";

/** v5.3 每根范围配置的容量上限（UI 校验提示与归一逻辑共用）。 */
export const SYNC_EXCLUDED_DIRS_MAX = 512;
export const SYNC_EXCLUDE_PATTERNS_MAX = 64;
export const SYNC_EXCLUDE_PATTERN_LEN_MAX = 256;
export const SYNC_PURGE_LIST_MAX = 2000;

/**
 * relPath 消毒（v5.3 共用）：posix 化（反斜杠 → /）、去首尾 /、拒空段、
 * `.`/`..` 段与控制字符。合法返回归一后的 posix 路径，非法返回 null。
 */
export function sanitizeSyncRelPath(v: unknown, maxLen = 1024): string | null {
  if (typeof v !== "string") return null;
  const p = v.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (p === "" || p.length > maxLen) return null;
  if (p.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  // eslint-disable-next-line no-control-regex -- 控制字符正是要拒绝的目标
  if (/[\x00-\x1f]/.test(p)) return null;
  return p;
}

/**
 * 单根范围配置归一（v5.3）：只保留「有意义」的字段——与默认等价的字段
 * 一律剔除，整个对象为空则返回 undefined（调用方据此把键从 Record 里删掉，
 * 保持 mditor.json 干净、且「缺省 = 跟随全局默认」语义不被空对象扰动）。
 */
function normalizeRootOptions(raw: unknown): RootSyncOptions | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<RootSyncOptions>;
  const out: RootSyncOptions = {};

  if (r.enabled === false) out.enabled = false;

  // extensions：小写、去点前后缀、去重。custom 且列表为空 → 回落 default
  // （空白名单 = 什么都不同步，语义危险，归一层直接拒绝）。
  const exts: string[] = [];
  if (Array.isArray(r.extensions)) {
    const seen = new Set<string>();
    for (const v of r.extensions) {
      if (typeof v !== "string") continue;
      const e = v.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
      if (e !== "" && !seen.has(e)) {
        seen.add(e);
        exts.push(e);
      }
    }
  }
  if (r.extensionMode === "custom" && exts.length > 0) {
    out.extensionMode = "custom";
    out.extensions = exts;
  }

  if (Array.isArray(r.excludedDirs)) {
    const seen = new Set<string>();
    for (const v of r.excludedDirs) {
      if (seen.size >= SYNC_EXCLUDED_DIRS_MAX) break;
      const p = sanitizeSyncRelPath(v);
      if (p !== null && !seen.has(p)) seen.add(p);
    }
    if (seen.size > 0) out.excludedDirs = [...seen];
  }

  if (Array.isArray(r.excludePatterns)) {
    const seen = new Set<string>();
    for (const v of r.excludePatterns) {
      if (seen.size >= SYNC_EXCLUDE_PATTERNS_MAX) break;
      if (typeof v !== "string") continue;
      const t = v.trim();
      if (t === "" || t.length > SYNC_EXCLUDE_PATTERN_LEN_MAX || seen.has(t)) continue;
      seen.add(t);
    }
    if (seen.size > 0) out.excludePatterns = [...seen];
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

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

  // remoteDirs：仅收字符串值，trim 后空值剔除（键 = 工作区根路径原样）。
  const remoteDirs: Record<string, string> = {};
  const rawDirs: unknown = s.remoteDirs;
  if (rawDirs && typeof rawDirs === "object") {
    for (const [k, v] of Object.entries(rawDirs as Record<string, unknown>)) {
      if (typeof v !== "string") continue;
      const t = v.trim();
      if (t !== "") remoteDirs[k] = t;
    }
  }

  // rootOptions / pendingPurges：逐键归一（v5.3），归一后为空的键剔除
  // （缺省 = 跟随全局默认；空队列无意义）。
  const rootOptions: Record<string, RootSyncOptions> = {};
  const rawRootOptions: unknown = s.rootOptions;
  if (rawRootOptions && typeof rawRootOptions === "object") {
    for (const [k, v] of Object.entries(rawRootOptions as Record<string, unknown>)) {
      const o = normalizeRootOptions(v);
      if (o) rootOptions[k] = o;
    }
  }
  const pendingPurges: Record<string, string[]> = {};
  const rawPurges: unknown = s.pendingPurges;
  if (rawPurges && typeof rawPurges === "object") {
    for (const [k, v] of Object.entries(rawPurges as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const seen = new Set<string>();
      for (const p of v) {
        if (seen.size >= SYNC_PURGE_LIST_MAX) break;
        const clean = sanitizeSyncRelPath(p);
        if (clean !== null && !seen.has(clean)) seen.add(clean);
      }
      if (seen.size > 0) pendingPurges[k] = [...seen];
    }
  }

  const interval = Number(s.autoSyncIntervalMin);
  // v5.2：方向/冲突策略白名单归一（未知字符串回落默认——配置可能来自
  // 手改的 mditor.json 或未来版本移除的枚举值）。
  const DIRECTIONS: readonly string[] = ["bidirectional", "uploadOnly", "downloadOnly"];
  const POLICIES: readonly string[] = ["newestWins", "localFirst", "remoteFirst"];
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
    remoteDirs,
    rootOptions,
    pendingPurges,
    syncDirection: DIRECTIONS.includes(s.syncDirection as string)
      ? (s.syncDirection as SyncSettings["syncDirection"])
      : d.syncDirection,
    conflictPolicy: POLICIES.includes(s.conflictPolicy as string)
      ? (s.conflictPolicy as SyncSettings["conflictPolicy"])
      : d.conflictPolicy,
  };
}

/**
 * workspaceOptions 逐键归一（v5.3，migrateSettings 每次加载都会跑）：
 * fileTypes 白名单子集（NOTE_KINDS）+ 去重；空表或**全选四类** → 剔除键
 * （等价默认行为，保持 mditor.json 干净）；非法结构整键剔除。幂等。
 */
export function normalizeWorkspaceOptions(
  raw: unknown
): Record<string, WorkspaceOptions> {
  const out: Record<string, WorkspaceOptions> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Partial<WorkspaceOptions>;
    if (!Array.isArray(r.fileTypes)) continue;
    const seen = new Set<string>();
    for (const t of r.fileTypes) {
      if (typeof t === "string" && (NOTE_KINDS as readonly string[]).includes(t) && !seen.has(t)) {
        seen.add(t);
      }
    }
    if (seen.size === 0 || seen.size === NOTE_KINDS.length) continue;
    out[k] = { fileTypes: [...seen] as NoteKind[] };
  }
  return out;
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
