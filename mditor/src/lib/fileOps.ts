// Mutating filesystem operations: delete / create / rename.
//
// Deliberately kept separate from tauriFs.ts (which is read/open/save only) so
// the "destructive" surface is easy to audit. Everything here is pure frontend
// — no Rust commands required. The fs plugin permissions (fs:allow-remove /
// fs:allow-rename / fs:allow-mkdir / fs:allow-write-file) are already granted
// globally via capabilities/default.json.

import {
  remove,
  rename,
  mkdir,
  writeTextFile,
  exists,
} from "@tauri-apps/plugin-fs";
import { dirname, join } from "./path-shim";

// Characters forbidden in file names on Windows (and poor practice elsewhere).
// Backslash is intentionally matched via the literal in the class.
// eslint-disable-next-line no-control-regex -- 文件名合法性校验需要显式匹配控制字符
const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
// Windows reserved device names — can't be a file/folder name on their own.
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Validate a single path component (file or folder name). Returns an error
 * message string when invalid, or null when OK. Rules:
 *   * non-empty after trim
 *   * not only dots (avoids `.` / `..` and hidden-file footguns)
 *   * no illegal chars, no trailing dot/space (Windows strips them → confusion)
 *   * not a Windows reserved device name
 */
export function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "名称不能为空";
  if (/^\.+$/.test(trimmed)) return "名称不能仅为点号";
  if (INVALID_NAME_CHARS.test(trimmed))
    return '名称包含非法字符（<>:"/\\|?*）';
  if (/[.\s]$/.test(trimmed)) return "名称不能以点号或空格结尾";
  if (RESERVED_NAMES.test(trimmed))
    return "名称是系统保留字（con/prn/aux/nul/com*/lpt*）";
  return null;
}

/** Remove a single file. */
export async function deleteFile(path: string): Promise<void> {
  await remove(path);
}

/** Remove a directory and everything inside it (like `rm -r`). */
export async function deleteDirRecursive(path: string): Promise<void> {
  await remove(path, { recursive: true });
}

/** Create a directory (and any missing parents). */
export async function createFolder(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** Create an empty (or content-seeded) file. */
export async function createFile(path: string, content = ""): Promise<void> {
  await writeTextFile(path, content);
}

/** Rename / move a file or directory. Overwrites an existing file at the
 * destination (matching OS rename semantics); caller should check first. */
export async function renamePath(oldPath: string, newPath: string): Promise<void> {
  if (oldPath === newPath) return;
  await rename(oldPath, newPath);
}

/** Does a path currently exist on disk? */
export async function pathExists(path: string): Promise<boolean> {
  try {
    return await exists(path);
  } catch {
    return false;
  }
}

/**
 * Replace the name portion of `path` with `newName`, keeping the same parent.
 * Returns the resulting full path. Pure string op — touches no disk.
 */
export function withName(path: string, newName: string): string {
  return join(dirname(path), newName);
}

/**
 * Given a set of selected paths (files and/or folders), return the minimal
 * subset to actually delete: if a folder is selected, its descendants are
 * redundant (the recursive delete handles them). This avoids trying to remove
 * a file that's already gone because its parent was removed first.
 *
 * Operates purely on strings: a path is "covered" by a selected ancestor when
 * an ancestor path + "/" is a prefix of it.
 */
export function dedupNestedPaths(paths: string[]): string[] {
  // Normalize separators to "/" for the prefix check, keep originals for output.
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const items = paths.map((p) => ({ raw: p, n: norm(p) }));
  // Shortest first so ancestors get recorded before their descendants are tested.
  items.sort((a, b) => a.n.length - b.n.length);
  const roots: string[] = [];
  for (const it of items) {
    const covered = roots.some((r) => {
      const rn = norm(r);
      return it.n === rn || it.n.startsWith(rn + "/");
    });
    if (!covered) roots.push(it.raw);
  }
  return roots;
}
