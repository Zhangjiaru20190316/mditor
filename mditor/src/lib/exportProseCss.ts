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

/** 导出散文补丁整体（现阶段仅表格；后续矢量装饰的 DOM 侧着色如有需要也挂这里）。 */
export const EXPORT_PROSE_CSS = EXPORT_TABLE_CSS;
