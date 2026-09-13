// Tauri 平台的 fs 域实现（鸿蒙迁移 v4.11）：@tauri-apps/plugin-fs 的薄直通。
// 参数原样透传——与迁移前的直接调用逐字节一致，桌面零回归的根基。

import {
  readTextFile,
  readFile,
  writeTextFile,
  writeFile,
  readDir,
  mkdir,
  exists,
  stat,
  rename,
  remove,
  watch,
} from "@tauri-apps/plugin-fs";
import type { PlatformFs } from "../types";

export const tauriFs: PlatformFs = {
  readTextFile: (p) => readTextFile(p),
  readFile: (p) => readFile(p),
  writeTextFile: (p, contents) => writeTextFile(p, contents),
  writeFile: (p, data) => writeFile(p, data),
  readDir: (p) => readDir(p),
  mkdir: (p, options) => mkdir(p, options),
  exists: (p) => exists(p),
  stat: (p) => stat(p),
  rename: (oldPath, newPath) => rename(oldPath, newPath),
  remove: (p, options) => remove(p, options),
  watch: (path, handler, options) =>
    watch(path, handler as never, options) as Promise<() => void>,
};
