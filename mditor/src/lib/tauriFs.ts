// Filesystem helpers — 打开/保存/目录树的统一入口（鸿蒙迁移 v4.11 起内部
// 转发平台适配层 platform/，函数签名与语义不变；Tauri 路径行为逐字节一致）。
//
// All paths are absolute. Filters default to Markdown (.md/.markdown/.mdx).

import { getAdapter } from "../platform";
import type { DirEntry } from "../platform/types";
import { dirname, basename, join, extname } from "./path-shim";
import { tracedIo } from "./ipcTrace";
import { isHtmlNote, HTML_EXTS } from "./htmlNote";
import { isDocNote, PDF_EXTS, DOCX_EXTS } from "./docNote";
import type { NoteKind } from "../types";
import { NOTE_KINDS } from "../defaults";

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
}

const MD_FILTERS = [
  { name: "Markdown", extensions: ["md", "markdown", "mdx", "mdown"] },
];

/** HTML 笔记选择器的过滤组（HN 轮）。 */
export const HTML_FILTERS = [
  { name: "HTML", extensions: ["html", "htm"] },
];

/** 多格式笔记选择器的过滤组（MF 轮）。不含 .doc——前端解析不可行，明确
 *  不支持（对话框层面引导用户先转存 .docx）。 */
export const DOC_FILTERS = [
  { name: "PDF", extensions: ["pdf"] },
  { name: "Word", extensions: ["docx"] },
];

/** 单一来源的 Markdown 扩展名集合。Rust lib.rs 的 MD_EXTS、tauri.conf.json
 *  的 bundle.fileAssociations、docNote.ts 的 PDF/DOCX 集合与 sync/ignore.ts
 *  的同步白名单是无法共享的镜像，改动时需五处同步。 */
export const MD_EXTS = new Set([".md", ".markdown", ".mdx", ".mdown"]);

/** 名字是否以 Markdown 扩展名结尾（导出文件名去后缀等场景）。 */
export const MD_EXT_RE = /\.(md|markdown|mdx|mdown)$/i;

export function isMarkdown(name: string): boolean {
  return MD_EXTS.has(extname(name).toLowerCase());
}

/**
 * 笔记类型 → 扩展名集合（v5.3 按工作区选文件树类型）。键与 types.NoteKind
 * / defaults.NOTE_KINDS 一一对应；md 桶复用 MD_EXTS（md 家族四扩展名归一
 * 类），其余桶与各自模块的单一事实源同源。
 */
export const NOTE_KIND_EXTS: Record<NoteKind, ReadonlySet<string>> = {
  md: MD_EXTS,
  html: HTML_EXTS,
  pdf: PDF_EXTS,
  docx: DOCX_EXTS,
};

/**
 * 文件名 → 笔记类型（v5.3.x 外部关联用）：扩展名命中哪个类型的集合就归哪
 * 类；非四类扩展名（.png 等）返回 null。大小写不敏感。
 */
export function kindOfName(name: string): NoteKind | null {
  const ext = extname(name).toLowerCase();
  for (const k of NOTE_KINDS) {
    if (NOTE_KIND_EXTS[k].has(ext)) return k;
  }
  return null;
}

/**
 * 类型子集 → 文件树过滤用的扩展名并集。undefined / 空表 / 覆盖全部四类
 * → 返回 undefined（= 不过滤，readDirLevel 走既有三谓词并集，既有行为
 * 零变化）。白名单外的类型忽略。
 */
export function resolveTreeExts(
  kinds?: readonly string[]
): ReadonlySet<string> | undefined {
  if (!kinds || kinds.length === 0) return undefined;
  const valid = kinds.filter((k): k is NoteKind =>
    (NOTE_KINDS as readonly string[]).includes(k)
  );
  if (valid.length === 0 || valid.length === NOTE_KINDS.length) return undefined;
  const out = new Set<string>();
  for (const k of valid) {
    for (const ext of NOTE_KIND_EXTS[k]) out.add(ext);
  }
  return out;
}

/** Show an open-file dialog and return {path, content} or null if cancelled. */
export async function openMd(): Promise<{ path: string; content: string } | null> {
  const path = await tracedIo(
    "ipc:dialog",
    "openMd:打开文件对话框",
    () => getAdapter().dialog.pickOpenFile(MD_FILTERS),
    { slowMs: Infinity }
  );
  if (!path || typeof path !== "string") return null;
  const content = await tracedIo("file:read", `读取 ${basename(path)}`, () =>
    getAdapter().fs.readTextFile(path)
  );
  return { path, content };
}

/**
 * 打开笔记对话框（file_open 统一入口，MF 轮扩）：过滤器并入 PDF/Word 档
 * （DOC_FILTERS）。Markdown 正常读文本内容；pdf/docx 只返回路径
 * （content=null）——由调用方路由到只读预览标签（App.openNoteAny），
 * 不进文本读取管线。HTML 笔记沿用 HN 轮「导入」流，不在此列。
 */
export async function openNoteFromDialog(): Promise<{
  path: string;
  content: string | null;
} | null> {
  const path = await tracedIo(
    "ipc:dialog",
    "openNoteFromDialog:打开文件对话框",
    () => getAdapter().dialog.pickOpenFile([...MD_FILTERS, ...DOC_FILTERS]),
    { slowMs: Infinity }
  );
  if (!path || typeof path !== "string") return null;
  if (isDocNote(path)) return { path, content: null };
  const content = await tracedIo("file:read", `读取 ${basename(path)}`, () =>
    getAdapter().fs.readTextFile(path)
  );
  return { path, content };
}

/** Pick a workspace folder. Returns absolute path or null. */
export async function pickFolder(): Promise<string | null> {
  const p = await tracedIo(
    "ipc:dialog",
    "pickFolder:选择文件夹对话框",
    () => getAdapter().dialog.pickDirectory(),
    { slowMs: Infinity }
  );
  if (!p || typeof p !== "string") return null;
  return p;
}

/** Save text to an existing path. */
export async function saveMd(path: string, content: string): Promise<void> {
  await tracedIo("file:write", `保存 ${basename(path)}`, () =>
    getAdapter().fs.writeTextFile(path, content)
  );
}

/**
 * Save-as: prompt for a destination, write the file, return the chosen path
 * (or null if the user cancelled). Defaults the filename to the current one.
 */
export async function saveMdAs(
  content: string,
  suggestedName = "untitled.md"
): Promise<string | null> {
  const path = await tracedIo(
    "ipc:dialog",
    "saveMdAs:另存为对话框",
    () => getAdapter().dialog.pickSaveFile(suggestedName, MD_FILTERS),
    { slowMs: Infinity }
  );
  if (!path) return null;
  await tracedIo("file:write", `另存 ${basename(path)}`, () =>
    getAdapter().fs.writeTextFile(path, content)
  );
  return path;
}

/**
 * Read a SINGLE level of `dir` (non-recursive) for the lazy file tree.
 *
 * Skips `.`-hidden entries, `node_modules`, and excludedPaths; keeps only `.md`
 * files + directories（HN 轮：外加 .html/.htm 笔记；MF 轮：外加 .pdf/.docx
 * 多格式笔记——文件树是各体系的汇合面，图标由 FileTree 按扩展名区分）.
 * Directories are returned with
 * `children: undefined` — their contents are loaded on demand when expanded
 * (see FileTree). Directories are always included (even ones that may be empty)
 * so the user can expand them to find out; emptiness is revealed at expand time
 * rather than hiding the folder outright.
 */
export async function readDirLevel(
  dir: string,
  exclude?: Set<string>,
  /** v5.3 按工作区选文件树类型：允许显示的扩展名集合（resolveTreeExts
   *  产物）。undefined = 不过滤（三谓词并集，既有行为）。仅影响文件分支
   *  ——目录恒保留；删除收集（collectMdPathsFromDisk）不受此参数影响。 */
  allowed?: ReadonlySet<string>
): Promise<TreeNode[]> {
  if (!(await getAdapter().fs.exists(dir))) return [];
  const out: TreeNode[] = [];
  let entries: DirEntry[];
  try {
    entries = await tracedIo("file:read", `列目录 ${basename(dir)}`, () =>
      getAdapter().fs.readDir(dir)
    );
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
    } else if (
      allowed
        ? allowed.has(extname(e.name).toLowerCase())
        : isMarkdown(e.name) || isHtmlNote(e.name) || isDocNote(e.name)
    ) {
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
 * HN 轮：同时收集 .html/.htm；MF 轮：外加 .pdf/.docx（只读标签同样要在
 * 删除后关闭）——函数名保留（调用方语义「收集受影响的笔记」不变）。
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
  let firstEntries: DirEntry[];
  if (hintIsDir !== undefined) {
    isDir = hintIsDir;
    firstEntries = [] as DirEntry[];
  } else {
    try {
      firstEntries = await getAdapter().fs.readDir(path);
      isDir = true;
    } catch {
      isDir = false;
      firstEntries = [] as DirEntry[];
    }
  }

  if (!isDir) {
    return isMarkdown(path) || isHtmlNote(path) || isDocNote(path) ? [path] : [];
  }

  // Walk the directory tree iteratively (skip `.`-hidden + node_modules, same
  // filtering as readDirLevel, but NO excludedPaths — every md file actually
  // being deleted must be reported so App can clean up).
  const out: string[] = [];
  const stack: Array<{ dir: string; entries?: DirEntry[] }> = [
    { dir: path, entries: firstEntries },
  ];
  while (stack.length > 0) {
    const { dir, entries } = stack.pop()!;
    let es: DirEntry[];
    if (entries) {
      es = entries;
    } else {
      try {
        es = await getAdapter().fs.readDir(dir);
      } catch {
        continue; // unreadable subdir — skip
      }
    }
    for (const e of es) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = join(dir, e.name);
      if (e.isDirectory) stack.push({ dir: full });
      else if (isMarkdown(e.name) || isHtmlNote(e.name) || isDocNote(e.name))
        out.push(full);
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
  const fs = getAdapter().fs;
  if (!(await fs.exists(path))) await tracedIo("file:mut", `建目录 ${path}`, () => fs.mkdir(path, { recursive: true }));
}
