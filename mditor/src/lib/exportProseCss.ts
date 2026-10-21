// 导出文档散文样式补丁（RV 轮 R1）：编辑器内容样式全部带 .mditor-milkdown
// .ProseMirror 作用域前缀（global.css 表格段），导出文档（body.vditor-reset +
// 裸 <table>）无一命中——HTML/PDF 导出的表格一条边框线都不画（已用产物
// perf/results/ex-hx-repro/demo-export.html 复现定罪）。
//
// 修复口径：按编辑器同款表现（global.css「表格整体圆角」段）写一段挂
// .vditor-reset 作用域的导出专用规则，HTML 导出（exporter.wrapHtml）与
// PDF/PNG 工厂（exportRenderFactory.buildFactoryDocumentHtml）同源注入——
// 一次修复两个出口，PNG 管线共用工厂自然受益。色值走主题 --border 变量
// （collectThemeCss 已把主题变量定义带进导出文档），变量缺位时退回浅色
// 基值（与 light.css 同值），保证极简自定义 CSS 场景仍有边框。

/** 表格边框规则（编辑器 global.css 同款语义，作用域换导出文档的 .vditor-reset）。 */
export const EXPORT_TABLE_CSS = `/* mditor-export-prose：R1 导出表格边框（编辑器同款：separate 折叠语义 +
   表级外框圆角裁切，单元格只画右/下内线，末列/末行清线避免与外框叠加）。 */
.vditor-reset table {
  border-collapse: separate;
  border-spacing: 0;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: var(--radius-m, 8px);
  overflow: clip;
}
.vditor-reset th,
.vditor-reset td {
  border-right: 1px solid var(--border, #e5e7eb);
  border-bottom: 1px solid var(--border, #e5e7eb);
  padding: 6px 10px;
}
.vditor-reset th:last-child,
.vditor-reset td:last-child {
  border-right: none;
}
.vditor-reset tr:last-child th,
.vditor-reset tr:last-child td {
  border-bottom: none;
}
`;

/** 引用块/mark/代码块/间距规则（编辑器 global.css 同款语义；R1 同族的
 *  作用域错配缺口——.ProseMirror 前缀规则在导出文档全部落空，引用竖条/
 *  高光底色/代码底色与段落间距一并丢失）。 */
export const EXPORT_BLOCK_CSS = `/* mditor-export-prose：R1 同族补齐——引用块/高光/代码块/间距。 */
.vditor-reset p,
.vditor-reset li,
.vditor-reset blockquote {
  margin: 0 0 var(--para-spacing, 16px);
}
.vditor-reset h1,
.vditor-reset h2,
.vditor-reset h3,
.vditor-reset h4 {
  margin: 1.4em 0 0.5em;
}
.vditor-reset blockquote {
  border-left: 4px solid var(--accent, #4f46e5);
  background: var(--accent-soft, #eef2ff);
  border-radius: 0 var(--radius-m, 8px) var(--radius-m, 8px) 0;
  padding: 6px 14px;
  color: var(--fg, inherit);
}
.vditor-reset mark {
  background: var(--mark-bg, rgba(255, 213, 79, 0.55));
  color: inherit;
  border-radius: 2px;
  padding: 0.05em 0.12em;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
.vditor-reset code,
.vditor-reset pre {
  font-family: var(--font-mono, ui-monospace, "Cascadia Mono", Consolas, monospace);
}
.vditor-reset pre {
  background: var(--code-bg, #dde1e8);
  border: 1px solid var(--code-border, #c4c9d4);
  border-radius: var(--radius-l, 10px);
  padding: 12px 14px;
  overflow: auto;
}
.vditor-reset :not(pre) > code {
  background: var(--code-bg, #dde1e8);
  border: 1px solid var(--code-border, #c4c9d4);
  border-radius: var(--radius-s, 6px);
  padding: 0.1em 0.35em;
  font-size: 0.9em;
}
`;

/** 导出散文补丁整体（表格边框 + 引用/高光/代码/间距；HTML 导出与
 *  PDF/PNG 工厂同源注入）。 */
export const EXPORT_PROSE_CSS = EXPORT_TABLE_CSS + EXPORT_BLOCK_CSS;
