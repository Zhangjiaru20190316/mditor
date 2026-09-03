// 引用格式化纯函数（模块 3）：行内引用（numeric / author-year）与文末参考
// 文献表共用这一份实现——编辑器 chip、静态渲染（renderMarkdown）、HTML 导出
// 后处理与 LaTeX 导出全部引用此处，保证「引用渲染 / 编号 / 导出三处一致」
// （模块 3 验收口径）。
//
// 语法（docs/research-features.md 为最终规范）：
//   * [@citekey] / [@citekey, p. 12] / [@k1; @k2] / [@k1; @k2, p. 12]
//   * 定位符（locator）= 最后一个「含空白的逗号后缀」；无空白的逗号视为
//     键分隔（[@k1,k2] 等价 [@k1; @k2]）。
//   * 键大小写不敏感（Zotero citekey 形态多样）。

import {
  bibFieldText,
  findBibEntry,
  initialsOf,
  parseBibAuthors,
  type BibAuthor,
  type BibEntry,
} from "./bibtex";

export type CitationStyle = "numeric" | "author-year";

/** 解析 `[@k1; @k2, p. 12]` 括号内的内容 → { keys, locator }。 */
export function parseCitationInner(inner: string): { keys: string[]; locator: string } | null {
  const t = inner.trim();
  if (!t) return null;
  const segs = t.split(",").map((x) => x.trim());
  let head = t;
  let locator = "";
  if (segs.length > 1 && /\s/.test(segs[segs.length - 1])) {
    locator = segs[segs.length - 1];
    head = segs.slice(0, -1).join(",");
  }
  const keys = head
    .split(/[;]/)
    .flatMap((x) => x.split(","))
    .map((x) => x.trim().replace(/^@/, ""))
    .filter(Boolean);
  if (keys.length === 0) return null;
  return { keys, locator };
}

// ---- 作者格式化 ---------------------------------------------------------------

function cleanAuthors(entry: BibEntry): BibAuthor[] {
  const raw = entry.fields.author ?? entry.fields.editor ?? "";
  return parseBibAuthors(raw);
}

/** 行内短形态的作者名：1 人=Smith；2 人=Smith & Lee；3+ 人=Smith et al.。
 *  无作者时回退标题前几个词（APA 无作者规则）。 */
export function authorShort(entry: BibEntry): string {
  const authors = cleanAuthors(entry);
  if (authors.length === 0) {
    const title = bibFieldText(entry, "title");
    return title.split(/\s+/).slice(0, 3).join(" ") || entry.key;
  }
  if (authors.length === 1) return authors[0].family;
  if (authors.length === 2) return `${authors[0].family} & ${authors[1].family}`;
  return `${authors[0].family} et al.`;
}

/** 参考文献表长形态的作者名：Family, X., & Family, Y.（3+ 加 et al.）。 */
export function authorLong(entry: BibEntry): string {
  const authors = cleanAuthors(entry);
  if (authors.length === 0) return "";
  const fmt = (a: BibAuthor) =>
    a.given ? `${a.family}, ${initialsOf(a.given)}` : a.family;
  if (authors.length === 1) return fmt(authors[0]);
  if (authors.length === 2) return `${fmt(authors[0])}, & ${fmt(authors[1])}`;
  return `${fmt(authors[0])}, et al.`;
}

function yearOf(entry: BibEntry): string {
  const y = bibFieldText(entry, "year") || bibFieldText(entry, "date");
  const m = y.match(/\d{4}/);
  return m ? m[0] : "n.d.";
}

/** 作者-年份行内形态（不含外层括号）："Smith & Lee, 2020"。 */
export function authorYearText(entry: BibEntry): string {
  return `${authorShort(entry)}, ${yearOf(entry)}`;
}

// ---- 行内引用 ----------------------------------------------------------------

/**
 * 行内引用文本。
 *   * numeric："[1]" / "[1, 2]" / "[1, p. 12]"（number 为该键按文档首次出现
 *     序分配的编号；未解析键回退为原文键名，保持可读）。
 *   * author-year："(Smith & Lee, 2020; Lee, 2021, p. 12)"。
 */
export function formatInlineCitation(
  entries: BibEntry[],
  keys: string[],
  locator: string,
  style: CitationStyle,
  numbers: Map<string, number>
): string {
  if (style === "author-year") {
    const parts = keys.map((k) => {
      const e = findBibEntry(entries, k);
      return e ? authorYearText(e) : k;
    });
    const loc = locator ? `, ${locator}` : "";
    return `(${parts.join("; ")}${loc})`;
  }
  const parts = keys.map((k) => {
    const n = numbers.get(k.toLowerCase());
    if (n !== undefined) return String(n);
    const e = findBibEntry(entries, k);
    return e ? e.key : k; // 未编号且未解析：保留键名（可读降级）
  });
  const loc = locator ? `, ${locator}` : "";
  return `[${parts.join(", ")}${loc}]`;
}

/** 按文档出现序分配编号（键小写归一）。调用方应只传入可解析键——未解析
 *  键不占号（正文处保留键名文本，bib 变化时已解析键的编号保持稳定）。 */
export function assignCitationNumbers(keysInOrder: string[]): Map<string, number> {
  const numbers = new Map<string, number>();
  let n = 0;
  for (const k of keysInOrder) {
    const key = k.toLowerCase();
    if (!numbers.has(key)) numbers.set(key, ++n);
  }
  return numbers;
}

// ---- 参考文献表 ----------------------------------------------------------------

/** 出处串（container）：期刊名 / 书名 / 会议名 + 卷期页。 */
function containerOf(entry: BibEntry): string {
  const parts: string[] = [];
  const journal =
    bibFieldText(entry, "journal") ||
    bibFieldText(entry, "booktitle") ||
    bibFieldText(entry, "publisher");
  if (journal) parts.push(`*${journal}*`);
  const volume = bibFieldText(entry, "volume");
  const number = bibFieldText(entry, "number");
  const pages = bibFieldText(entry, "pages").replace(/\s*--\s*/g, "–");
  if (volume) parts.push(number ? `*${volume}*(${number})` : `*${volume}*`);
  if (pages) parts.push(pages);
  const doi = bibFieldText(entry, "doi");
  if (doi) parts.push(`doi:${doi}`);
  return parts.join(", ");
}

/**
 * 单条参考文献（不含编号前缀）。形态（APA 简化）：
 *   Family, X., & Family, Y. (2020). Title. *Journal*, 12(3), 45–67.
 */
export function formatReference(entry: BibEntry): string {
  const segs: string[] = [];
  const authors = authorLong(entry);
  if (authors) segs.push(`${authors} (${yearOf(entry)}).`);
  const title = bibFieldText(entry, "title");
  if (title) segs.push(/[.!?。！？]$/.test(title) ? title : `${title}.`);
  const container = containerOf(entry);
  if (container) segs.push(`${container}.`);
  const url = bibFieldText(entry, "url");
  if (url) segs.push(url);
  return segs.join(" ").replace(/\s{2,}/g, " ").trim();
}

export interface ReferenceItem {
  key: string;
  entry: BibEntry;
  /** numeric 样式的编号（author-year 为 null）。 */
  number: number | null;
  text: string;
}

/**
 * 参考文献表：numeric 按正文引用出现序；author-year 按第一作者 family 名
 * 字母序（无作者按标题）。未解析的键不出现在表里（正文处保留可读原文）。
 */
export function buildReferences(
  entries: BibEntry[],
  keysInOrder: string[],
  style: CitationStyle
): ReferenceItem[] {
  if (style === "numeric") {
    const numbers = assignCitationNumbers(keysInOrder);
    const out: ReferenceItem[] = [];
    const seen = new Set<string>();
    for (const k of keysInOrder) {
      const key = k.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const e = findBibEntry(entries, k);
      if (!e) continue; // 未解析键不进表
      out.push({ key: e.key, entry: e, number: numbers.get(key) ?? null, text: formatReference(e) });
    }
    return out;
  }
  const seen = new Set<string>();
  const out: ReferenceItem[] = [];
  for (const k of keysInOrder) {
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const e = findBibEntry(entries, k);
    if (e) out.push({ key: e.key, entry: e, number: null, text: formatReference(e) });
  }
  out.sort((a, b) => {
    const fa = a.entry.fields.author ?? a.entry.fields.editor ?? a.entry.fields.title ?? "";
    const fb = b.entry.fields.author ?? b.entry.fields.editor ?? b.entry.fields.title ?? "";
    const la = parseBibAuthors(fa)[0]?.family ?? a.key;
    const lb = parseBibAuthors(fb)[0]?.family ?? b.key;
    return la.localeCompare(lb, "en");
  });
  return out;
}

/** 参考文献表标题匹配（# References / # 参考文献，H1/H2，忽略大小写与冒号）。 */
export function isReferencesHeadingText(text: string): boolean {
  const t = text.trim().replace(/[:：]\s*$/, "").toLowerCase();
  return t === "references" || t === "reference" || t === "参考文献" || t === "参考资料";
}
