// HN 轮阶段 2：HTML 笔记搜索索引（纯主线程，jsdom/WebView2 的 DOMParser
// 行为一致）。DOMParser 解析不执行脚本，抽取过程安全。
//
// 设计约束（与 workspaceSearch 对齐）：
//   * 只抽 textContent（纯文本，无任何标记——进主 DOM 由 React 文本节点
//     自动转义承载，不需要也不经过 HTML 白名单）；
//   * <h1>-<h6> 抽大纲（预留给结果跳转/展示）；
//   * 超长文档（> MAX_FILE_BYTES）跳过，防大文件卡顿；
//   * script/style/noscript/template 不参与文本抽取。

import { getAdapter } from "../platform";
import type { DirEntry } from "../platform/types";
import { join, extname, basename } from "./path-shim";
import { isHtmlNote } from "./htmlNote";
import { matchLine, type FileHits, type SearchHit } from "./workspaceSearch";

export interface HtmlNoteIndex {
  /** <title> 或首个 <h1>；都无时 null（调用方回退文件名）。 */
  title: string | null;
  /** <h1>-<h6> 大纲（文档序）。 */
  outline: Array<{ level: number; text: string }>;
  /** 全文纯文本（已压缩空白；长度上限见 MAX_FILE_BYTES 的调用方裁剪）。 */
  text: string;
}

const SKIP_TAGS = "script,style,noscript,template";

/** 抽取 HTML 笔记的纯文本索引（纯函数，DOMParser 不执行脚本）。 */
export function extractHtmlNoteIndex(html: string): HtmlNoteIndex {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(SKIP_TAGS).forEach((el) => el.remove());
  const outline: HtmlNoteIndex["outline"] = [];
  for (const h of doc.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    const text = (h.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) outline.push({ level: Number(h.tagName[1]), text });
  }
  const title = (doc.title ?? "").trim() || outline[0]?.text || null;
  const text = (doc.body?.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  return { title, outline, text };
}

/** 文本命中 → 展示用摘录（锚定命中位置，~160 字符窗口）。 */
function excerpt(text: string, col: number): string {
  const line = text.slice(col).split("\n")[0] ?? "";
  const trimmed = line.trim();
  if (trimmed.length <= 160) return trimmed;
  return trimmed.slice(0, 159) + "…";
}

/** 在已抽好的纯文本上收集命中（纯函数）。maxHits 缺省 20。 */
export function collectHtmlHits(
  text: string,
  needle: string,
  caseSensitive: boolean,
  maxHits = 20
): SearchHit[] {
  const hits: SearchHit[] = [];
  if (!needle) return hits;
  let from = 0;
  while (hits.length < maxHits) {
    const col = matchLine(text.slice(from), needle, caseSensitive);
    if (col < 0) break;
    const abs = from + col;
    hits.push({ line: 0, col: abs, text: excerpt(text, abs), full: text.slice(abs, abs + 200) });
    from = abs + needle.length;
  }
  return hits;
}

// ---- 磁盘扫描（对齐 workspaceSearch.collectMdFiles 的跳过规则）-------------

const SKIP_DIRS = new Set(["node_modules", "dist", "target", "out", "build"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

async function collectHtmlFiles(
  root: string,
  excluded: Set<string> | undefined,
  maxFiles: number
): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
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
    let entries: DirEntry[];
    try {
      entries = await getAdapter().fs.readDir(dir);
    } catch {
      continue;
    }
    const dirs: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (isExcluded(full)) continue;
      if (e.isDirectory) dirs.push(full);
      else if (isHtmlNote(e.name) && extname(e.name).toLowerCase() !== "") {
        if (out.length < maxFiles) out.push(full);
      }
    }
    dirs.sort((a, b) => -a.localeCompare(b, "en"));
    stack.push(...dirs);
  }
  return out;
}

export interface HtmlSearchOptions {
  caseSensitive?: boolean;
  excluded?: Set<string>;
  maxFiles?: number;
  maxHitsPerFile?: number;
}

export interface HtmlSearchResult {
  files: FileHits[];
  scanned: number;
  totalHits: number;
  truncated: boolean;
}

/** 在工作区 HTML 笔记中做纯文本搜索（结果与 md 搜索在 UI 层合并展示）。 */
export async function searchHtmlNotes(
  roots: string[],
  query: string,
  opts: HtmlSearchOptions = {}
): Promise<HtmlSearchResult> {
  const empty: HtmlSearchResult = { files: [], scanned: 0, totalHits: 0, truncated: false };
  const validRoots = roots.filter((r) => typeof r === "string" && r.trim() !== "");
  if (validRoots.length === 0 || !query.trim()) return empty;
  const caseSensitive = opts.caseSensitive ?? false;
  const maxFiles = opts.maxFiles ?? 200;
  const maxHitsPerFile = opts.maxHitsPerFile ?? 20;

  let truncated = false;
  const files: string[] = [];
  for (const root of validRoots) {
    const got = await collectHtmlFiles(root, opts.excluded, maxFiles - files.length);
    files.push(...got);
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
  }

  const out: FileHits[] = [];
  let totalHits = 0;
  for (const f of files) {
    let content: string;
    try {
      content = await getAdapter().fs.readTextFile(f);
    } catch {
      continue;
    }
    if (content.length > MAX_FILE_BYTES) {
      truncated = true;
      continue;
    }
    const idx = extractHtmlNoteIndex(content);
    const hits = collectHtmlHits(idx.text, query, caseSensitive, maxHitsPerFile);
    if (hits.length >= maxHitsPerFile) truncated = true;
    if (hits.length > 0) {
      out.push({ path: f, name: basename(f), hits });
      totalHits += hits.length;
    }
  }
  return { files: out, scanned: files.length, totalHits, truncated };
}
