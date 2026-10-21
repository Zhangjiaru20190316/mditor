// R1 回归锚定：导出文档（body.vditor-reset + 裸 table）必须自带表格边框
// 规则——HTML 导出（wrapHtml）与 PDF/PNG 工厂（buildFactoryDocumentHtml）
// 两个出口同源注入，缺一即回到「导出表格一条线都没有」的定罪形态
// （perf/results/ex-hx-repro/demo-export.html）。

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EXPORT_PROSE_CSS, EXPORT_TABLE_CSS } from "./exportProseCss";
import { wrapHtml } from "./exporter";
import { buildFactoryDocumentHtml } from "./exportRenderFactory";

describe("EXPORT_TABLE_CSS 内容（编辑器 global.css 同款语义）", () => {
  it("表级外框 + 单元格右/下内线 + 末列/末行清线 + separate 折叠", () => {
    expect(EXPORT_TABLE_CSS).toContain(".vditor-reset table");
    expect(EXPORT_TABLE_CSS).toContain("border-collapse: separate");
    expect(EXPORT_TABLE_CSS).toContain("border-spacing: 0");
    expect(EXPORT_TABLE_CSS).toContain("1px solid var(--border");
    expect(EXPORT_TABLE_CSS).toContain("border-radius");
    // 单元格只画右/下内线
    expect(EXPORT_TABLE_CSS).toMatch(/\.vditor-reset th,\s*\.vditor-reset td/);
    expect(EXPORT_TABLE_CSS).toContain("border-right: 1px solid");
    expect(EXPORT_TABLE_CSS).toContain("border-bottom: 1px solid");
    // 末列清右线、末行清下线（避免与外框叠加）
    expect(EXPORT_TABLE_CSS).toMatch(/th:last-child[\s\S]*border-right: none/);
    expect(EXPORT_TABLE_CSS).toMatch(/tr:last-child th[\s\S]*border-bottom: none/);
  });

  it("边框色带变量缺位兜底（极简自定义 CSS 场景仍有边框）", () => {
    expect(EXPORT_TABLE_CSS).toContain("var(--border, #e5e7eb)");
  });
});

describe("两个导出出口同源注入（R1：HTML 与 PDF 工厂一次修复）", () => {
  it("wrapHtml（HTML 导出）的 style 内含表格边框规则，且在主题 CSS 之后", () => {
    const doc = wrapHtml("<table><tr><td>x</td></tr></table>", "/* theme */", "t", "light");
    const style = doc.slice(doc.indexOf("<style>"), doc.indexOf("</style>"));
    expect(style).toContain(".vditor-reset table");
    expect(style.indexOf("/* theme */")).toBeLessThan(style.indexOf(".vditor-reset table"));
  });

  it("buildFactoryDocumentHtml（PDF/PNG 工厂）同样携带表格边框规则", () => {
    const doc = buildFactoryDocumentHtml("<p>x</p>", {
      contentWidthPx: 680,
      css: "/* theme */",
    });
    expect(doc).toContain(".vditor-reset table");
    expect(doc).toContain("border-collapse: separate");
  });

  it("EXPORT_PROSE_CSS 汇总包含表格段（后续扩展的单一挂点）", () => {
    expect(EXPORT_PROSE_CSS).toContain(EXPORT_TABLE_CSS);
  });
});
