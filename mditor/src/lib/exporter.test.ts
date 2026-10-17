// wrapHtml 导出文档外壳快照锚定。背景：主题变量全部挂在 [data-theme=...]
// 下，导出文档一旦不带该属性，所有主题都退化到 :root 浅色兜底；打印默认丢
// 背景色，暗色主题更是白纸白字。这两条修复用测试锁死，防止回归。

import { describe, expect, it } from "vitest";
import { wrapHtml } from "./exporter";

const CSS = '[data-theme="dark"] { --bg: #1e1e1e; --fg: #e5e7eb; }';

describe("wrapHtml 导出文档外壳", () => {
  it("html 标签回写 data-theme（主题变量在导出产物中生效的前提）", () => {
    const doc = wrapHtml("<p>hi</p>", CSS, "t", "dark");
    expect(doc).toContain('<html lang="zh-CN" data-theme="dark">');
  });

  it("导出默认样式携带整页主题背景（根元素背景传播到打印画布）", () => {
    const doc = wrapHtml("<p>hi</p>", CSS, "t", "dark");
    expect(doc).toContain("html { background: var(--bg); }");
  });

  it("@media print 强制 print-color-adjust: exact（暗色主题防白纸白字）", () => {
    const doc = wrapHtml("<p>hi</p>", CSS, "t", "light");
    expect(doc).toContain("print-color-adjust: exact");
    expect(doc).toContain("-webkit-print-color-adjust: exact");
  });

  it("mark 高亮跟随主题变量并保留浅色回退", () => {
    const doc = wrapHtml("<p>hi</p>", CSS, "t", "sepia");
    expect(doc).toContain("var(--mark-bg, rgba(255, 213, 79, 0.55))");
  });

  it("title 经 HTML 转义注入（<script> 不逃逸）", () => {
    const doc = wrapHtml("<p>hi</p>", CSS, "<script>alert(1)</script>", "light");
    expect(doc).toContain("<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>");
  });

  it("正文挂 vditor-reset 类、原样嵌入 body", () => {
    const doc = wrapHtml('<p class="x">正文</p>', CSS, "t", "claude");
    expect(doc).toContain('<body class="vditor-reset">');
    expect(doc).toContain('<p class="x">正文</p>');
  });

  // HX E-H1 回归锚定：应用外壳规则随整包收集进入导出文件——body 的
  // overflow:hidden 传播到视口，独立 HTML 打开后滚动锁死（只能看到第一屏）。
  // 修复：导出 defaults 在收集 CSS 之后声明 html/body 的 height/overflow
  // 覆盖（同特异度层叠后者胜），恢复普通流式网页语义。
  it("导出外壳覆盖整包收集的应用外壳规则（html/body height 与 overflow）", () => {
    const shellCss = [
      "html, body, #root { height: 100%; margin: 0; padding: 0; }",
      "body { font-family: var(--font-prose); overflow: hidden; }",
    ].join("\n");
    const doc = wrapHtml("<p>hi</p>", shellCss, "t", "light");
    const override = "html, body { height: auto; overflow: visible; }";
    expect(doc).toContain(override);
    // 层叠位次：覆盖必须出现在收集 CSS 之后（同特异度后者胜）
    expect(doc.indexOf(override)).toBeGreaterThan(doc.indexOf("overflow: hidden"));
  });
});
