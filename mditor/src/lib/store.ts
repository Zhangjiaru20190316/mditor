// Persistent settings + recent files via @tauri-apps/plugin-store.
//
// The store file lands in the app data dir as `mditor.json`. We keep two keys:
//   settings  -> Settings object
//   recent    -> RecentFile[]
//
// All access is async. The store is lazily loaded and cached for the session.

import { LazyStore } from "@tauri-apps/plugin-store";
import {
  DEFAULT_SETTINGS,
  type AiModelConfig,
  type RecentFile,
  type Settings,
} from "../types";

const STORE_FILE = "mditor.json";

const store = new LazyStore(STORE_FILE);

export async function loadSettings(): Promise<Settings> {
  const partial = (await store.get<Partial<Settings>>("settings")) ?? {};
  const merged = { ...DEFAULT_SETTINGS, ...partial };
  return migrateSettings(merged, partial);
}

/**
 * One-time migration to multi-model config.
 *
 * Older mditor.json files have only the flat fields (aiProvider/aiBaseUrl/
 * aiApiKey/aiModel) and no `aiModels` array. We detect this via `raw` (the
 * pre-merge saved object): if it has no `aiModels`, seed a single entry from
 * the legacy flat fields (so a configured upgrade is invisible), else keep the
 * stored list. Also repairs a stale/empty `aiActiveModelId` by falling back to
 * the first entry. Idempotent and safe to run on every load.
 */
function migrateSettings(s: Settings, raw: Partial<Settings>): Settings {
  const hadModels = Array.isArray(raw.aiModels) && raw.aiModels.length > 0;
  let models = hadModels ? (s.aiModels || []).filter(Boolean) : [];

  // v3.9 降本迁移：aiMaxTokens 旧默认 0（= 不发送字段，长回复输出失控的
  // 隐患）。0 或缺失都视为“未配置”，统一升到新默认 4096；用户显式设置过
  // 的非 0 值原样保留。
  if (!s.aiMaxTokens || s.aiMaxTokens <= 0) {
    s.aiMaxTokens = DEFAULT_SETTINGS.aiMaxTokens;
  }

  // No stored model list: seed from legacy flat fields if the user configured
  // anything (non-empty baseUrl or model).
  const legacyConfigured =
    (typeof s.aiBaseUrl === "string" && s.aiBaseUrl.trim()) ||
    (typeof s.aiModel === "string" && s.aiModel.trim());
  if (models.length === 0 && legacyConfigured) {
    const legacy: AiModelConfig = {
      id: "default",
      name: "默认模型",
      provider: s.aiProvider ?? "custom",
      baseUrl: s.aiBaseUrl ?? "",
      apiKey: s.aiApiKey ?? "",
      model: s.aiModel ?? "",
    };
    models = [legacy];
  }

  // Ensure there is always at least one entry (mirror DEFAULT_SETTINGS).
  if (models.length === 0) {
    models = DEFAULT_SETTINGS.aiModels.map((m) => ({ ...m }));
  }

  // Repair active id: keep it if it resolves, else fall back to the first.
  const activeId =
    typeof s.aiActiveModelId === "string" &&
    models.some((m) => m.id === s.aiActiveModelId)
      ? s.aiActiveModelId
      : models[0].id;

  return { ...s, aiModels: models, aiActiveModelId: activeId };
}

export async function saveSettings(s: Settings): Promise<void> {
  await store.set("settings", s);
  await store.save();
}

// In-memory mirror of the `recent` list: keeps hot-path reads (every save
// pushes here) off the IPC round-trip. The store file stays the source of
// truth across sessions; within one session every mutation flows through the
// functions below, so the cache can't go stale.
let recentCache: RecentFile[] | null = null;

export async function loadRecent(): Promise<RecentFile[]> {
  if (recentCache) return recentCache;
  const stored = await store.get<RecentFile[]>("recent");
  // mditor.json 手工编辑/写坏时 `recent` 可能不是数组；直接放行会让
  // pushRecent 的 list.filter 抛 TypeError，此后每次打开文件都报错。
  recentCache = Array.isArray(stored) ? stored : [];
  return recentCache;
}

export async function pushRecent(file: RecentFile): Promise<void> {
  const list = await loadRecent();
  // Ctrl+S fires this after every save; when the file is ALREADY the most
  // recent entry there is nothing to reorder or persist — skip the whole
  // set+save IPC write (this per-save churn was flagged by the project's own
  // diagnostics as a steady memory-growth contributor).
  if (list[0]?.path === file.path) return;
  const trimmed = [file, ...list.filter((r) => r.path !== file.path)].slice(0, 30);
  recentCache = trimmed;
  await store.set("recent", trimmed);
  await store.save();
}

export async function clearRecentPath(path: string): Promise<void> {
  const list = await loadRecent();
  const trimmed = list.filter((r) => r.path !== path);
  recentCache = trimmed;
  await store.set("recent", trimmed);
  await store.save();
}

export async function getWorkspace(): Promise<string | null> {
  return (await store.get<string>("workspace")) ?? null;
}

export async function setWorkspace(path: string | null): Promise<void> {
  if (path === null) await store.delete("workspace");
  else await store.set("workspace", path);
  await store.save();
}
