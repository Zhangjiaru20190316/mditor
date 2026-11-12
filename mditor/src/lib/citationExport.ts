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

/**
 * 在 References/参考文献 标题下注入自动生成的文献表。替换范围与静态渲染
 * （remarkCitation.injectReferences）对齐：标题 → 下一同级/更高级标题之间
 * 的旧内容（含手写占位列表/段落）整体由生成表替换——此前只替换紧邻列表，
 * 「生成表 + 手写内容」会在导出产物里重复并列（MC 轮 P2）。无文献配置时
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
    const depth = Number(m[1]);
    // 下一同级/更高级标题（静态渲染同语义）：span 终点。
    let end = html.length;
    for (const h of html.matchAll(HEADING_RE)) {
      const hi = h.index ?? 0;
      if (hi >= after && Number(h[1]) <= depth) {
        end = hi;
        break;
      }
    }
    return html.slice(0, after) + `\n${listHtml}\n` + html.slice(end);
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
