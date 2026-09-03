// 导出链路的双链降级（铁律 5）：编辑器 getHTML() 里的双链是
// `<a class="wikilink" data-wikilink="target">label</a>`（无 href——编辑器内
// 点击由 PM 插件处理）。导出产物离开本工具必须可读：
//   * 索引能解析目标 → 补标准相对链接 href（相对导出文档所在目录）；
//   * 未解析 → 降级为纯文本 + 样式提示 span（title 保留原目标名）。
//
// 纯字符串后处理（DOM 无关），供 exporter 三条路径（HTML/PDF/DOCX）共用。

import { vaultIndex } from "./vaultIndex";
import { toPosix } from "./path-shim";

const WIKILINK_TAG_RE = /<a class="wikilink" data-wikilink="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 相对路径（target 绝对路径 → 相对 base 目录；同盘符简化，跨盘符回退绝对）。 */
export function relativeTo(target: string, base: string): string {
  const t = toPosix(target);
  const b = toPosix(base);
  const tParts = t.split("/");
  const bParts = b.split("/");
  let i = 0;
  while (i < tParts.length && i < bParts.length && tParts[i].toLowerCase() === bParts[i].toLowerCase()) {
    i++;
  }
  if (i === 0) return t; // 无公共前缀（跨盘符等）——绝对路径也可用
  const ups = bParts.length - i;
  const rel = [...Array(ups).fill(".."), ...tParts.slice(i)].join("/");
  return rel || ".";
}

/**
 * 把导出 HTML 里的 wikilink 标记降级为标准链接 / 样式化纯文本。
 * `docPath` 为导出文档的磁盘路径（解析相对引用的基准）；无索引命中时软降级。
 */
export function resolveWikiLinksInHtml(html: string, docPath?: string | null): string {
  if (!html.includes("wikilink")) return html;
  const dir = docPath ? docPath.replace(/[\\/][^\\/]+$/, "") : "";
  return html.replace(WIKILINK_TAG_RE, (_whole, rawTarget: string, label: string) => {
    const target = rawTarget
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"');
    const hits = vaultIndex.resolveWikiTarget(target);
    if (hits.length > 0 && dir) {
      const href = relativeTo(hits[0].path, dir);
      return `<a class="wikilink" href="${escapeHtml(href)}"${hits.length > 1 ? ` title="重名目标，已链接：${escapeHtml(hits[0].path)}"` : ""}>${label}</a>`;
    }
    // 未解析（或无基准目录）：纯文本 + 样式提示。
    return `<span class="wikilink-unresolved" title="未链接的笔记：${escapeHtml(target)}">${label}</span>`;
  });
}
