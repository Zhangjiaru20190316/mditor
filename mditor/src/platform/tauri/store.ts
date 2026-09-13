// Tauri 平台的 KV 域实现（鸿蒙迁移 v4.11）。
// 与迁移前 lib/store.ts 相同：单例 LazyStore，文件落在 appDataDir/mditor.json，
// 键：settings / recent / workspaces / recentWorkspaces。

import { LazyStore } from "@tauri-apps/plugin-store";
import type { PlatformStore } from "../types";

const STORE_FILE = "mditor.json";

const store = new LazyStore(STORE_FILE);

export const tauriStore: PlatformStore = {
  get: <T>(key: string) => store.get<T>(key),
  set: (key, value) => store.set(key, value),
  delete: async (key) => {
    await store.delete(key);
  },
  save: () => store.save(),
};
