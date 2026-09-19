// S2 回归：密钥系统凭据存储——saveSettings 脱敏落盘（JSON 无密钥本体）、
// loadSettings 从凭据库水合、旧版明文触发一次性迁移重写、无凭据库平台走
// 明文兼容路径。T2：store.ts 首批单测。
import { beforeEach, describe, expect, it, vi } from "vitest";

// 内存 KV 模拟 plugin-store；凭据库模拟 Windows Credential Manager 语义。
const kv = new Map<string, unknown>();
const vault = new Map<string, string>();

vi.mock("../platform", () => ({
  detectRuntime: () => "tauri",
  getAdapter: () => ({
    store: {
      get: async <T>(k: string) => kv.get(k) as T | undefined,
      set: async (k: string, v: unknown) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
      save: async () => undefined,
    },
    app: {
      emit: async () => undefined,
      secretSet: async (key: string, value: string) => {
        vault.set(key, value);
      },
      secretGet: async (key: string) => vault.get(key) ?? null,
      secretDel: async (key: string) => {
        vault.delete(key);
      },
    },
  }),
}));

import { DEFAULT_SETTINGS, type Settings } from "../types";
import { loadSettings, saveSettings } from "./store";

function settingsWithKeys(): Settings {
  return JSON.parse(JSON.stringify({
    ...DEFAULT_SETTINGS,
    aiModels: [
      { id: "m1", name: "A", provider: "custom", baseUrl: "https://a/v1", apiKey: "sk-aaa", model: "a" },
      { id: "m2", name: "B", provider: "custom", baseUrl: "https://b/v1", apiKey: "", model: "b" },
    ],
    ragEmbedApiKey: "rag-secret",
    sync: { ...DEFAULT_SETTINGS.sync, secretAccessKey: "s3-secret", sessionToken: "tok-1" },
  }));
}

beforeEach(() => {
  kv.clear();
  vault.clear();
});

describe("S2 密钥凭据存储（store.ts）", () => {
  it("saveSettings：密钥入凭据库，mditor.json 只留 @keychain 标记", async () => {
    await saveSettings(settingsWithKeys());
    expect(vault.get("ai.key.m1")).toBe("sk-aaa");
    expect(vault.has("ai.key.m2")).toBe(false); // 空密钥不占槽位
    expect(vault.get("rag.key")).toBe("rag-secret");
    expect(vault.get("sync.secret")).toBe("s3-secret");
    expect(vault.get("sync.token")).toBe("tok-1");
    const saved = kv.get("settings") as Settings;
    expect(saved.aiModels[0].apiKey).toBe("@keychain");
    expect(saved.aiModels[1].apiKey).toBe(""); // 原本就空
    expect(saved.ragEmbedApiKey).toBe("@keychain");
    expect(saved.sync.secretAccessKey).toBe("@keychain");
    expect(saved.sync.sessionToken).toBe("@keychain");
    const raw = JSON.stringify(saved);
    expect(raw).not.toContain("sk-aaa");
    expect(raw).not.toContain("s3-secret");
  });

  it("loadSettings：凭据库值水合回内存 settings", async () => {
    await saveSettings(settingsWithKeys());
    const loaded = await loadSettings();
    expect(loaded.aiModels[0].apiKey).toBe("sk-aaa");
    expect(loaded.aiModels[1].apiKey).toBe("");
    expect(loaded.ragEmbedApiKey).toBe("rag-secret");
    expect(loaded.sync.secretAccessKey).toBe("s3-secret");
    expect(loaded.sync.sessionToken).toBe("tok-1");
  });

  it("迁移：旧版明文 mditor.json 首次加载即转入凭据库并脱敏重写", async () => {
    const legacy = settingsWithKeys(); // 未过凭据库的明文形态
    kv.set("settings", legacy);
    const loaded = await loadSettings();
    // 内存中可用（明文在场被保留），凭据库已收编（迁移内联完成）
    expect(loaded.aiModels[0].apiKey).toBe("sk-aaa");
    expect(vault.get("ai.key.m1")).toBe("sk-aaa");
    expect(vault.get("sync.secret")).toBe("s3-secret");
    // JSON 已脱敏重写
    const saved = kv.get("settings") as Settings;
    expect(JSON.stringify(saved)).not.toContain("sk-aaa");
    expect(saved.aiModels[0].apiKey).toBe("@keychain");
  });

  it("密钥清空 = 删槽位（输入框清空保存后凭据库不残留）", async () => {
    await saveSettings(settingsWithKeys());
    expect(vault.get("ai.key.m1")).toBe("sk-aaa");
    const cleared = settingsWithKeys();
    cleared.aiModels[0].apiKey = "";
    cleared.sync.sessionToken = "";
    await saveSettings(cleared);
    expect(vault.has("ai.key.m1")).toBe(false);
    expect(vault.has("sync.token")).toBe(false);
    const saved = kv.get("settings") as Settings;
    expect(saved.aiModels[0].apiKey).toBe("");
  });

  it("凭据库标记但库中无值 → 水合为空串（不残留 @keychain 字面量到 UI）", async () => {
    const s = settingsWithKeys();
    s.aiModels[0].apiKey = "@keychain"; // 库被外部清掉的情形
    kv.set("settings", s);
    const loaded = await loadSettings();
    expect(loaded.aiModels[0].apiKey).toBe("");
  });
});
