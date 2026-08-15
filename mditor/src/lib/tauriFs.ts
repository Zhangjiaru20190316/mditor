// Filesystem helpers wrapping @tauri-apps/plugin-fs and plugin-dialog.
//
// All paths are absolute. Filters default to Markdown (.md/.markdown/.mdx).

import { open, save } from "@tauri-apps/plugin-dialog";
import {
  readTextFile,
  writeTextFile,
  readDir,
  exists,
  mkdir,
} from "@tauri-apps/plugin-fs";
import { dirname, basename, join, extname } from "./path-shim";

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
}

const MD_FILTERS = [
  { name: "Markdown", extensions: ["md", "markdown", "mdx", "mdown"] },
];

/** 单一来源的 Markdown 扩展名集合。Rust lib.rs 的 MD_EXTS 与 tauri.conf.json
 *  的 bundle.fileAssociations 是无法共享的镜像，改动时需三处同步。 */
export const MD_EXTS = new Set([".md", ".markdown", ".mdx", ".mdown"]);

/** 名字是否以 Markdown 扩展名结尾（导出文件名去后缀等场景）。 */
export const MD_EXT_RE = /\.(md|markdown|mdx|mdown)$/i;

export function isMarkdown(name: string): boolean {
  return MD_EXTS.has(extname(name).toLowerCase());
}

/** Show an open-file dialog and return {path, content} or null if cancelled. */
export async function openMd(): Promise<{ path: string; content: string } | null> {
  const path = await open({ multiple: false, filters: MD_FILTERS });
  if (!path || typeof path !== "string") return null;
  const content = await readTextFile(path);
  return { path, content };
}

/** Pick a workspace folder. Returns absolute path or null. */
export async function pickFolder(): Promise<string | null> {
  const p = await open({ directory: true, multiple: false });
  if (!p || typeof p !== "string") return null;
  return p;
}

/** Save text to an existing path. */
export async function saveMd(path: string, content: string): Promise<void> {
  await writeTextFile(path, content);
}

/**
 * Save-as: prompt for a destination, write the file, return the chosen path
 * (or null if the user cancelled). Defaults the filename to the current one.
 */
export async function saveMdAs(
  content: string,
  suggestedName = "untitled.md"
): Promise<string | null> {
  const path = await save({
    defaultPath: suggestedName,
    filters: MD_FILTERS,
  });
  if (!path) return null;
  await writeTextFile(path, content);
  return path;
}

/**
 * Read a SINGLE level of `dir` (non-recursive) for the lazy file tree.
 *
 * Skips `.`-hidden entries, `node_modules`, and excludedPaths; keeps only `.md`
 * files + directories. Directories are returned with `children: undefined` —
 * their contents are loaded on demand when expanded (see FileTree). Directories
 * are always included (even ones that may be empty) so the user can expand them
 * to find out; emptiness is revealed at expand time rather than hiding the
 * folder outright.
 */
export async function readDirLevel(
  dir: string,
  exclude?: Set<string>
): Promise<TreeNode[]> {
  if (!(await exists(dir))) return [];
  const out: TreeNode[] = [];
  let entries: Awaited<ReturnType<typeof readDir>>;
  try {
    entries = await readDir(dir);
  } catch {
    return out; // not a directory, or unreadable
  }
  const sorted = [...entries].sort((a, b) =>
    a.name.localeCompare(b.name, "en", { numeric: true })
  );
  for (const e of sorted) {
    if (e.name.startsWith(".")) continue;
    if (e.name === "node_modules") continue;
    const fullPath = join(dir, e.name);
    if (exclude?.has(fullPath)) continue;
    if (e.isDirectory) {
      // children deferred — lazy-loaded when the folder is expanded.
      out.push({ name: e.name, path: fullPath, isDir: true });
    } else if (isMarkdown(e.name)) {
      out.push({ name: e.name, path: fullPath, isDir: false });
    }
  }
  return out;
}

/**
 * Collect every markdown file path under `path` from DISK (recursive). Correct
 * even when the tree is lazily loaded and a directory's children aren't in
 * memory yet.
 *
 * Used before a delete so the App notification (close the buffer if the open
 * file vanished, prune the recent list) gets the COMPLETE set of removed md
 * paths regardless of which folders were expanded in the tree.
 *
 * `hintIsDir` (when known) skips the directory auto-detect probe; left
 * undefined, it is inferred by attempting to read `path` as a directory.
 */
export async function collectMdPathsFromDisk(
  path: string,
  hintIsDir?: boolean
): Promise<string[]> {
  // Determine whether `path` is a directory. With a hint we trust it; otherwise
  // we probe by reading it (readDir rejects on a non-directory path).
  let isDir: boolean;
  let firstEntries: Awaited<ReturnType<typeof readDir>>;
  if (hintIsDir !== undefined) {
    isDir = hintIsDir;
    firstEntries = [] as unknown as Awaited<ReturnType<typeof readDir>>;
  } else {
    try {
      firstEntries = await readDir(path);
      isDir = true;
    } catch {
      isDir = false;
      firstEntries = [] as unknown as Awaited<ReturnType<typeof readDir>>;
    }
  }

  if (!isDir) {
    return isMarkdown(path) ? [path] : [];
  }

  // Walk the directory tree iteratively (skip `.`-hidden + node_modules, same
  // filtering as readDirLevel, but NO excludedPaths — every md file actually
  // being deleted must be reported so App can clean up).
  const out: string[] = [];
  const stack: Array<{ dir: string; entries?: Awaited<ReturnType<typeof readDir>> }> = [
    { dir: path, entries: firstEntries },
  ];
  while (stack.length > 0) {
    const { dir, entries } = stack.pop()!;
    let es: Awaited<ReturnType<typeof readDir>>;
    if (entries) {
      es = entries;
    } else {
      try {
        es = await readDir(dir);
      } catch {
        continue; // unreadable subdir — skip
      }
    }
    for (const e of es) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = join(dir, e.name);
      if (e.isDirectory) stack.push({ dir: full });
      else if (isMarkdown(e.name)) out.push(full);
    }
  }
  return out;
}

/** Return the directory portion of a path (cross-platform). */
export function dirOf(path: string): string {
  return dirname(path);
}

/** Return the file name portion of a path. */
export function baseName(path: string): string {
  return basename(path);
}

/** Ensure a directory exists, creating it (and parents) if needed. */
export async function ensureDir(path: string): Promise<void> {
  if (!(await exists(path))) await mkdir(path, { recursive: true });
}
