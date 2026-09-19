// @vitest-environment jsdom
// S10 回归：导出兜底消毒——脚本/事件/危险协议向量被移除，编辑器合法结构
// （KaTeX span、批注 data-*、颜色 style、任务列表 input、正常链接/图片）保留。
import { describe, expect, it } from "vitest";
import { sanitizeExportHtml } from "./exportSanitize";

describe("sanitizeExportHtml（S10 导出兜底消毒）", () => {
  it("移除 <script> 元素（含内容）", () => {
    const out = sanitizeExportHtml(
      `<p>正文</p><script>alert(1)</script><p>尾</p>`
    );
    expect(out).not.toContain("script");
    expect(out).not.toContain("alert");
    expect(out).toContain("<p>正文</p>");
    expect(out).toContain("<p>尾</p>");
  });

  it("移除 iframe/object/embed/base/meta/link", () => {
    const out = sanitizeExportHtml(
      `<iframe src="https://x"></iframe><object data="o"></object>` +
        `<embed src="e"><base href="b"><meta http-equiv="refresh">` +
        `<link rel="stylesheet" href="l"><p>ok</p>`
    );
    for (const t of ["iframe", "object", "embed", "<base", "meta", "link"]) {
      expect(out.toLowerCase()).not.toContain(t);
    }
    expect(out).toContain("<p>ok</p>");
  });

  it("移除 on* 事件属性（任意元素）", () => {
    const out = sanitizeExportHtml(
      `<p onclick="steal()">hi</p><img src="a.png" onerror="x()" alt="a">`
    );
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onerror");
    expect(out).toContain("hi");
    expect(out).toContain('src="a.png"');
  });

  it("移除 javascript:/vbscript: 协议链接，保留 https 与锚点", () => {
    const out = sanitizeExportHtml(
      `<a href="javascript:alert(1)">bad</a>` +
        `<a href="vbscript:x">bad2</a>` +
        `<a href="https://example.com">good</a>` +
        `<a href="#section">anchor</a>`
    );
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("vbscript:");
    expect(out).toContain("https://example.com");
    expect(out).toContain("#section");
    expect(out).toContain(">bad<"); // 文本内容保留（只删属性）
  });

  it("保留编辑器合法结构：KaTeX 类名、批注 data-*、颜色 style、任务列表 input", () => {
    const legit =
      `<span class="katex-display"><span class="katex">E=mc²</span></span>` +
      `<span data-annotation-id="a1" data-type="code-anno">批注</span>` +
      `<span style="color: #e11d48">红字</span>` +
      `<input type="checkbox" checked disabled>` +
      `<img src="asset://local/pic.png" alt="本地图">`;
    expect(sanitizeExportHtml(legit)).toBe(legit);
  });

  it("幂等：消毒后的输出再消毒不变", () => {
    const dirty = `<p onclick="x()">a</p><script>y</script>`;
    const once = sanitizeExportHtml(dirty);
    expect(sanitizeExportHtml(once)).toBe(once);
  });

  it("干净输入返回原引用（零开销路径）", () => {
    const clean = "<p>纯文本</p>";
    expect(sanitizeExportHtml(clean)).toBe(clean);
  });
});
