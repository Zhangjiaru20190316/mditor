// 跨文件搜索（V3.6）：在当前工作区递归扫描 .md 文件并按行匹配。
//
// 边界（防大目录失控）：
//   * 跳过 `.`-隐藏目录、node_modules、dist、target、out、build（与文件树同规则 + 构建产物）
//   * 最多扫描 MAX_FILES 个文件、每个文件 > MAX_FILE_BYTES 跳过
//   * 每文件最多 MAX_HITS_PER_FILE 条命中，全局最多 MAX_TOTAL_HITS 条，超出置 truncated
//
// 纯函数部分（matchLine / collectHits）独立导出以便单测。

import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { join, extname, basename } from "./path-shim";

export interface SearchHit {
  /** 0-based 行号。 */
  line: number;
  /** 命中起始列（0-based）。 */
  col: number;
  /** 整行原文（已裁剪到展示窗口）。 */
  text: string;
  /** 未裁剪的整行原文（富文本模式跳转定位用）。 */
  full: string;
}

export interface FileHits {
  path: string;
  name: string;
  hits: SearchHit[];
}

export interface WorkspaceSearchResult {
  files: FileHits[];
  /** 实际读取的文件数（含无命中的）。 */
  scanned: number;
  /** 命中总数（受上限截断）。 */
  totalHits: number;
  /** 任一上限触发时为真（UI 提示结果不完整）。 */
  truncated: boolean;
}

export interface WorkspaceSearchOptions {
  caseSensitive?: boolean;
  /** 「从工作区移除」的路径（文件与目录前缀都过滤）。 */
  excluded?: Set<string>;
  maxFiles?: number;
  maxHitsPerFile?: number;
  maxTotalHits?: number;
}

export const SEARCH_DEFAULTS = {
  maxFiles: 500,
  maxFileBytes: 2 * 1024 * 1024,
  maxHitsPerFile: 50,
  maxTotalHits: 2000,
};

/** 目录名黑名单（在文件树的 `.`-隐藏 + node_modules 之上补充构建产物）。 */
const SKIP_DIRS = new Set(["node_modules", "dist", "target", "out", "build"]);

const MD_EXTS = new Set([".md", ".markdown", ".mdx", ".mdown"]);

/** 单行匹配：返回命中列（-1 = 未命中）。大小写按选项归一。 */
export function matchLine(
  line: string,
  needle: string,
  caseSensitive: boolean
): number {
  if (!needle) return -1;
  const hay = caseSensitive ? line : line.toLowerCase();
  const pat = caseSensitive ? needle : needle.toLowerCase();
  return hay.indexOf(pat);
}

/** 纯文本版本的搜索（供单测与无 Tauri 环境）：按行收集命中。 */
export function collectHits(
  content: string,
  needle: string,
  caseSensitive: boolean,
  maxHits: number
): SearchHit[] {
  const hits: SearchHit[] = [];
  if (!needle) return hits;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
    const col = matchLine(lines[i], needle, caseSensitive);
    if (col >= 0) {
      hits.push({ line: i, col, text: clipLine(lines[i], col), full: lines[i] });
    }
  }
  return hits;
}

/** 命中行裁剪到 ~160 字符的展示窗口（锚定命中位置）。 */
function clipLine(line: string, col: number): string {
  const trimmed = line.replace(/\s+$/, "");
  if (trimmed.length <= 160) return trimmed;
  const start = Math.max(0, col - 60);
  return (start > 0 ? "…" : "") + trimmed.slice(start, start + 159);
}

/** 递归收集工作区内所有 md 文件路径（深度优先、跳过黑名单/排除项）。 */
async function collectMdFiles(
  root: string,
  excluded: Set<string> | undefined,
  maxFiles: number
): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  const isExcluded = (p: string) => {
    if (!excluded || excluded.size === 0) return false;
    for (const e of excluded) {
      if (p === e || p.startsWith(e.endsWith("/") ? e : e + "/") || p.startsWith(e + "\\")) {
        return true;
      }
    }
    return false;
  };
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: Awaited<ReturnType<typeof readDir>>;
    try {
      entries = await readDir(dir);
    } catch {
      continue; // 不可读目录 — 跳过
    }
    const dirs: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (isExcluded(full)) continue;
      if (e.isDirectory) {
        dirs.push(full);
      } else if (MD_EXTS.has(extname(e.name).toLowerCase())) {
        if (out.length < maxFiles) out.push(full);
      }
    }
    // 字母序入栈（反转入栈保证弹出顺序接近字母序）。
    dirs.sort((a, b) => -a.localeCompare(b, "en"));
    stack.push(...dirs);
  }
  return out;
}

/** 在工作区内搜索 `query`。始终 resolves；单个文件读取失败跳过。 */
export async function searchWorkspace(
  root: string | null,
  query: string,
  opts: WorkspaceSearchOptions = {}
): Promise<WorkspaceSearchResult> {
  const empty: WorkspaceSearchResult = {
    files: [],
    scanned: 0,
    totalHits: 0,
    truncated: false,
  };
  if (!root || !query.trim()) return empty;
  const caseSensitive = opts.caseSensitive ?? false;
  const maxFiles = opts.maxFiles ?? SEARCH_DEFAULTS.maxFiles;
  const maxHitsPerFile = opts.maxHitsPerFile ?? SEARCH_DEFAULTS.maxHitsPerFile;
  const maxTotalHits = opts.maxTotalHits ?? SEARCH_DEFAULTS.maxTotalHits;

  const files = await collectMdFiles(root, opts.excluded, maxFiles);
  const truncatedByFiles = files.length >= maxFiles;

  const out: FileHits[] = [];
  let totalHits = 0;
  let truncated = truncatedByFiles;
  for (const path of files) {
    if (totalHits >= maxTotalHits) {
      truncated = true;
      break;
    }
    let content: string;
    try {
      content = await readTextFile(path);
    } catch {
      continue;
    }
    if (content.length > SEARCH_DEFAULTS.maxFileBytes) continue;
    const hits = collectHits(content, query, caseSensitive, maxHitsPerFile);
    if (hits.length >= maxHitsPerFile) truncated = true;
    if (hits.length > 0) {
      out.push({ path, name: basename(path), hits });
      totalHits += hits.length;
    }
  }
  return { files: out, scanned: files.length, totalHits, truncated };
}
