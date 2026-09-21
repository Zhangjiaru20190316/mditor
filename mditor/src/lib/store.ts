// Persistent settings + recent files（持久 KV 的唯一业务入口）。
//
// The store file lands in the app data dir as `mditor.json`. We keep two keys:
//   settings  -> Settings object
//   recent    -> RecentFile[]
//
// All access is async. The store is lazily loaded and cached for the session.
// 鸿蒙迁移 v4.11：底层经平台适配层（Tauri=plugin-store；鸿蒙=沙箱
// filesDir/mditor.json，键与格式完全一致），函数签名不变。

import { getAdapter } from "../platform";
import { DEFAULT_SETTINGS } from "../defaults";
import { normalizeSyncSettings } from "../settingsNormalize";
import type { AiModelConfig, RecentFile, Settings } from "../types";
import { normalizeStoredWorkspaces } from "./workspaces";
import { sysEmit } from "./sysDebug";

// ---- S2：密钥系统凭据存储（keychain）----------------------------------------
//
// Settings 内嵌的密钥字段（aiModels[].apiKey / ragEmbedApiKey /
// sync.secretAccessKey / sync.sessionToken）不再明文进 mditor.json：
//   * saveSettings：先把密钥写入系统凭据库（Tauri secret_set → Windows
//     Credential Manager / DPAPI），全部成功后把 JSON 里的密钥字段替换为
//     KEYCHAIN_MARK 再落盘；凭据库不可用（非 Windows 桌面/预览）时回退明文
//     并留 warn 诊断——兼容优先于拒绝保存。
//   * loadSettings：从凭据库水合密钥（凭据库优先；JSON 里残留的明文视为
//     旧版数据，触发一次性迁移重写——迁移后磁盘不再有密钥）。
//   * 槽位命名：ai.key.<modelId>（模型 id 稳定）/ rag.key / sync.secret /
//     sync.token。已知残留：删除模型后其凭据槽位不主动清理（无枚举 API），
//     槽位残留无害（仅本机 DPAPI 加密的孤立条目）。

/** JSON 里的密钥引用标记（非密钥本体；水合时若凭据库无值则视为空）。 */
const KEYCHAIN_MARK = "@keychain";

type SecretSlots = Array<{ slot: string; get: () => string; set: (v: string) => void }>;

/** 收集一份（可变的）settings 副本上的全部密钥槽位。 */
function secretSlotsOf(s: Settings): SecretSlots {
  const slots: SecretSlots = [];
  for (const m of s.aiModels) {
    if (!m?.id) continue;
    slots.push({
      slot: `ai.key.${m.id}`,
      get: () => m.apiKey ?? "",
      set: (v) => (m.apiKey = v),
    });
  }
  slots.push({
    slot: "rag.key",
    get: () => s.ragEmbedApiKey ?? "",
    set: (v) => (s.ragEmbedApiKey = v),
  });
  slots.push({
    slot: "sync.secret",
    get: () => s.sync?.secretAccessKey ?? "",
    set: (v) => (s.sync = { ...s.sync, secretAccessKey: v }),
  });
  slots.push({
    slot: "sync.token",
    get: () => s.sync?.sessionToken ?? "",
    set: (v) => (s.sync = { ...s.sync, sessionToken: v }),
  });
  return slots;
}

export async function loadSettings(): Promise<Settings> {
  const partial = (await getAdapter().store.get<Partial<Settings>>("settings")) ?? {};
  const merged = { ...DEFAULT_SETTINGS, ...partial };
  const migrated = await migrateSettings(merged, partial);
  return hydrateSecrets(migrated);
}

/**
 * S2：从系统凭据库水合密钥字段（凭据库优先）。凭据库不可用或读取失败时按
 * 磁盘明文现状继续（不阻断启动）。检测到磁盘明文（旧版本写入）时触发一次
 * 性迁移：把密钥转入凭据库并重写脱敏 JSON。
 */
async function hydrateSecrets(s: Settings): Promise<Settings> {
  const secretGet = getAdapter().app.secretGet;
  if (!secretGet) return s; // 平台无凭据库：明文兼容路径
  const out: Settings = {
    ...s,
    aiModels: s.aiModels.map((m) => ({ ...m })),
    sync: { ...s.sync },
  };
  const slots = secretSlotsOf(out);
  let plaintextFound = false;
  try {
    const values = await Promise.all(
      slots.map((x) => secretGet(x.slot).catch(() => null))
    );
    slots.forEach((x, i) => {
      const fromVault = values[i];
      if (typeof fromVault === "string" && fromVault) {
        x.set(fromVault);
      } else if (x.get() && x.get() !== KEYCHAIN_MARK) {
        plaintextFound = true; // 旧版明文：留在内存，落盘时由迁移清除
      } else if (x.get() === KEYCHAIN_MARK) {
        x.set("");
      }
    });
  } catch {
    return s; // 凭据库整体不可读：按现状继续
  }
  if (plaintextFound) {
    // 一次性迁移：写入凭据库 + 脱敏重写 mditor.json。内联 await（只发生在
    // 升级后首启，数十 ms）；失败不致命（下次启动重试），但必须留诊断。
    try {
      await saveSettings(out);
    } catch (e) {
      sysEmit("settings:secret-migrate", `密钥迁移系统凭据库失败：${String(e).slice(0, 120)}`, {
        level: "warn",
        data: {},
      });
    }
  }
  return out;
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

  // v4.9 Agent：面板模式与写入策略。缺失由 DEFAULT_SETTINGS 合并兜底，
  // 这里归一非法值（手改 mditor.json 等）。
  if (s.aiPanelMode !== "agent") s.aiPanelMode = "chat";
  if (s.agentWriteMode !== "auto") s.agentWriteMode = "confirm";

  // v4.12 云同步：sync 子对象幂等归一（缺失补默认 / prefix 规范化 / 非法
  // interval 归 10）。纯数据操作，鸿蒙运行同样无副作用。
  s.sync = normalizeSyncSettings(s.sync);

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
  // S2：密钥先进系统凭据库；全部成功后 JSON 只落引用标记。任一失败 → 本轮
  // 回退明文落盘（兼容优先），留 warn 诊断供定位。
  let toPersist: Settings = s;
  const { secretSet, secretDel } = getAdapter().app;
  if (secretSet && secretDel) {
    try {
      for (const x of secretSlotsOf(s)) {
        const v = x.get();
        if (v && v !== KEYCHAIN_MARK) await secretSet(x.slot, v);
        else await secretDel(x.slot).catch(() => undefined); // 清空输入 = 删槽位
      }
      toPersist = {
        ...s,
        aiModels: s.aiModels.map((m) =>
          m.apiKey ? { ...m, apiKey: KEYCHAIN_MARK } : m
        ),
        ragEmbedApiKey: s.ragEmbedApiKey ? KEYCHAIN_MARK : s.ragEmbedApiKey,
        sync: {
          ...s.sync,
          secretAccessKey: s.sync.secretAccessKey ? KEYCHAIN_MARK : s.sync.secretAccessKey,
          sessionToken: s.sync.sessionToken ? KEYCHAIN_MARK : s.sync.sessionToken,
        },
      };
    } catch (e) {
      sysEmit(
        "settings:secret-vault",
        `密钥写入系统凭据库失败，本轮回退明文存储：${String(e).slice(0, 120)}`,
        { level: "warn", data: {} }
      );
    }
  }
  const store = getAdapter().store;
  await store.set("settings", toPersist);
  await store.save();
  // v4.8 多窗口同步：落盘成功后广播。各窗 useSettings 监听后幂等重载磁盘
  // 设置（主题等即时一致；自己收到自己的回声也无害——盘上内容与内存相同）。
  // emit 失败静默：单窗口或事件层异常时维持各自现状，不影响保存本身。
  await getAdapter().app.emit("settings-changed").catch(() => undefined);
}

// In-memory mirror of the `recent` list: keeps hot-path reads (every save
// pushes here) off the IPC round-trip. The store file stays the source of
// truth across sessions; within one session every mutation flows through the
// functions below, so the cache can't go stale.
let recentCache: RecentFile[] | null = null;

export async function loadRecent(): Promise<RecentFile[]> {
  if (recentCache) return recentCache;
  const stored = await getAdapter().store.get<RecentFile[]>("recent");
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
  const store = getAdapter().store;
  await store.set("recent", trimmed);
  await store.save();
}

export async function clearRecentPath(path: string): Promise<void> {
  const list = await loadRecent();
  const trimmed = list.filter((r) => r.path !== path);
  recentCache = trimmed;
  const store = getAdapter().store;
  await store.set("recent", trimmed);
  await store.save();
}

// ---- 工作区（v4.4 起多根：`workspaces: string[]`） --------------------------
//
// 旧版只存单值 `workspace: string`。读取时优先用新键；新键缺失则做一次性
// 迁移（旧值 → [旧值]，写回新键并删除旧键），幂等 —— 迁移后旧键不存在，
// 再次启动直接命中新键。

export async function getWorkspaces(): Promise<string[]> {
  const store = getAdapter().store;
  const raw = await store.get<unknown>("workspaces");
  const list = normalizeStoredWorkspaces(raw);
  if (list !== null) return list;
  // 旧版单值迁移（新键未写入或写坏时回落）。
  const legacy = await store.get<string>("workspace");
  if (typeof legacy === "string" && legacy.trim() !== "") {
    await store.set("workspaces", [legacy]);
    await store.delete("workspace");
    await store.save();
    return [legacy];
  }
  return [];
}

export async function setWorkspaces(paths: string[]): Promise<void> {
  const store = getAdapter().store;
  await store.set("workspaces", paths);
  await store.save();
}

// 最近工作区（快速重开）：与 `recent` 相同的内存镜像 + 去重置顶模式，
// 只是列表短得多（8 条足够常用库轮换）。
let recentWsCache: string[] | null = null;

export async function loadRecentWorkspaces(): Promise<string[]> {
  if (recentWsCache) return recentWsCache;
  const stored = await getAdapter().store.get<string[]>("recentWorkspaces");
  recentWsCache = Array.isArray(stored) ? stored : [];
  return recentWsCache;
}

export async function pushRecentWorkspace(path: string): Promise<void> {
  const list = await loadRecentWorkspaces();
  if (list[0] === path) return;
  const trimmed = [path, ...list.filter((p) => p !== path)].slice(0, 8);
  recentWsCache = trimmed;
  const store = getAdapter().store;
  await store.set("recentWorkspaces", trimmed);
  await store.save();
}
