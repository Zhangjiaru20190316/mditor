// 导出链路的引用降级（铁律 6，模块 3）：编辑器 getHTML() 里的行内引用是
// `<span class="citation" data-citation="k1;k2" data-locator="…">chip 文本</span>`。
// 导出产物离开本工具必须可读：
//   * 行内 chip → 按文档出现序编号后的纯文本（numeric "[1]" / author-year
//     "(Smith, 2020)"，未解析键保留原文键名）；
//   * References/参考文献 标题下注入（或替换既有列表为）自动生成的参考
//     文献表 `<ol>`。
//
// 与 lib/wikiLinkExport 同款纪律：纯字符串后处理（DOM 无关），HTML/PDF/DOCX
// 三条导出路径共用；编号/格式化与静态渲染（renderMarkdown→remarkCitation）
// 共用 lib/citation 的同一份纯函数——三处一致（模块 3 验收口径）。

import { assignCitationNumbers, buildReferences, formatInlineCitation, isReferencesHeadingText } from "./citation";
import { bibliography } from "./bibliography";

const CITATION_TAG_RE = /<span class="citation" data-citation="([^"]*)"(?: data-locator="([^"]*)")?[^>]*>([\s\S]*?)<\/span>/g;

function decodeAttr(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface CitationExportResult {
  html: string;
  /** 文档序收集到的引用键（供参考文献表排序；resolveCitationsInHtml 产物）。 */
  keysInOrder: string[];
}

/**
 * 把导出 HTML 里的引用 chip 降级为编号纯文本。返回改写后的 HTML 与文档序
 * 引用键（injectReferencesHtml 复用，避免二次扫描）。
 */
export function resolveCitationsInHtml(html: string): CitationExportResult {
  const entries = bibliography.all();
  const style = bibliography.getStyle();
  const keysInOrder: string[] = [];
  const numbers = new Map<string, number>();
  if (!html.includes('class="citation"')) return { html, keysInOrder };

  const out = html.replace(CITATION_TAG_RE, (whole, rawKeys: string, rawLocator: string) => {
    const keys = decodeAttr(rawKeys)
      .split(";")
      .map((k) => k.trim())
      .filter(Boolean);
    if (keys.length === 0) return whole;
    const locator = decodeAttr(rawLocator ?? "");
    for (const k of keys) keysInOrder.push(k);
    if (entries.length === 0) {
      // 未配置/未加载文献库：保留原文形态（[@key]）——可读降级。
      return escapeHtml(`[@${keys.join("; ")}${locator ? `, ${locator}` : ""}]`);
    }
    // 编号只发给可解析键（与静态渲染 remarkCitation 同规则）。
    for (const k of keys) {
      const key = k.toLowerCase();
      if (numbers.has(key)) continue;
      const resolvable = entries.some((e) => e.key.toLowerCase() === key);
      if (resolvable) numbers.set(key, numbers.size + 1);
    }
    return escapeHtml(formatInlineCitation(entries, keys, locator, style, numbers));
  });
  return { html: out, keysInOrder };
}

const HEADING_RE = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g;

function headingText(inner: string): string {
  return inner.replace(/<[^>]+>/g, "").trim();
}

/** 诸 needle 在 html 中自 from 起最早出现的位置（-1 = 无）。 */
function earliest(html: string, from: number, needles: string[]): { idx: number; len: number } {
  let best = { idx: -1, len: 0 };
  for (const n of needles) {
    const i = html.indexOf(n, from);
    if (i >= 0 && (best.idx < 0 || i < best.idx)) best = { idx: i, len: n.length };
  }
  return best;
}

/** 找到平衡的列表闭合位置（从 `<ul`/`<ol` 起点起，嵌套计数）。 */
function findListEnd(html: string, start: number): number {
  let depth = 0;
  let i = start;
  for (;;) {
    const open = earliest(html, i, ["<ul", "<ol"]);
    const close = earliest(html, i, ["</ul>", "</ol>"]);
    if (close.idx < 0) return -1;
    if (open.idx >= 0 && open.idx < close.idx) {
      depth++;
      i = open.idx + open.len;
    } else {
      depth--;
      if (depth <= 0) return close.idx + close.len;
      i = close.idx + close.len;
    }
  }
}

/**
 * 在 References/参考文献 标题下注入自动生成的文献表；标题后已有列表则
 * 原位替换（显式标记处「自动生成」语义，与静态渲染一致）。无文献配置时
 * 原样返回。
 */
export function injectReferencesHtml(html: string, keysInOrder: string[]): string {
  const entries = bibliography.all();
  if (entries.length === 0) return html;
  const refs = buildReferences(entries, keysInOrder, bibliography.getStyle());
  const listHtml =
    refs.length > 0
      ? `<ol class="md-references">${refs
          .map((r) => `<li>${escapeHtml(r.number !== null ? `[${r.number}] ${r.text}` : r.text)}</li>`)
          .join("")}</ol>`
      : `<p class="md-references-empty">（未解析到文献条目）</p>`;

  for (const m of html.matchAll(HEADING_RE)) {
    if (!isReferencesHeadingText(headingText(m[2]))) continue;
    const after = (m.index ?? 0) + m[0].length;
    // 跳过空白，若紧随的是列表则原位替换，否则直接插入。
    let i = after;
    while (i < html.length && /\s/.test(html[i])) i++;
    if (html.startsWith("<ul", i) || html.startsWith("<ol", i)) {
      const listEnd = findListEnd(html, i);
      if (listEnd > i) {
        return html.slice(0, i) + listHtml + html.slice(listEnd);
      }
    }
    return html.slice(0, after) + `\n${listHtml}\n` + html.slice(after);
  }
  return html;
}

/** 引用导出一步到位（doExport 调用）：chip 降级 + 文献表注入。 */
export function resolveCitationsForExport(html: string): string {
  const { html: resolved, keysInOrder } = resolveCitationsInHtml(html);
  if (bibliography.size() === 0) return resolved;
  return injectReferencesHtml(resolved, keysInOrder);
}

// assignCitationNumbers 由 formatInlineCitation 调用方共享；此处显式引用以
// 保持与静态渲染编号语义的可见关联（语义：文档序首现占号）。
void assignCitationNumbers;
