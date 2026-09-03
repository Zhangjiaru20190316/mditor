// 引用 HTML 导出后处理测试（模块 3）：chip → 编号纯文本、文献表注入/替换、
// 未配置文献库的可读降级——与静态渲染（remarkCitation render 模式）共用
// lib/citation 纯函数，锚定「三处一致」。

import { describe, expect, it, beforeEach } from "vitest";
import { bibliography } from "./bibliography";
import { injectReferencesHtml, resolveCitationsForExport, resolveCitationsInHtml } from "./citationExport";

const BIB_TEXT = `
@article{smith2020,
  author = {Smith, John and Lee, Kate},
  title = {A Study of Things},
  journal = {Journal of Examples},
  year = {2020}
}
@book{knuth1984,
  author = {Knuth, Donald E.},
  title = {The TeXbook},
  publisher = {Addison-Wesley},
  year = {1984}
}
`;

function chip(keys: string[], locator = ""): string {
  return `<span class="citation" data-citation="${keys.join(";")}"${
    locator ? ` data-locator="${locator}"` : ""
  }>(chip)</span>`;
}

beforeEach(() => {
  void bibliography.setPath("");
});

describe("resolveCitationsInHtml", () => {
  it("未配置文献库：chip → 原文形态 [@key]（可读降级）", () => {
    const { html, keysInOrder } = resolveCitationsInHtml(
      `<p>见 ${chip(["smith2020"], "p. 5")}。</p>`
    );
    expect(html).toContain("[@smith2020, p. 5]");
    expect(keysInOrder).toEqual(["smith2020"]);
  });

  it("numeric：文档序编号 + 转义", () => {
    bibliography.loadText("C:/fake.bib", BIB_TEXT);
    bibliography.setStyle("numeric");
    const { html } = resolveCitationsInHtml(
      `<p>首 ${chip(["knuth1984"])}，再 ${chip(["smith2020", "knuth1984"])}。</p>`
    );
    expect(html).toContain("[1]");
    expect(html).toContain("[2, 1]");
    expect(html).not.toContain("data-citation");
  });

  it("author-year 形态 + 未解析键保留键名", () => {
    bibliography.loadText("C:/fake.bib", BIB_TEXT);
    bibliography.setStyle("author-year");
    const { html } = resolveCitationsInHtml(
      `<p>${chip(["smith2020"])} 与 ${chip(["ghost"])}</p>`
    );
    expect(html).toContain("(Smith &amp; Lee, 2020)");
    expect(html).toContain("(ghost)");
  });

  it("无 chip 时原样返回（零开销路径）", () => {
    const src = "<p>普通文本 & 符号</p>";
    expect(resolveCitationsInHtml(src).html).toBe(src);
  });
});

describe("injectReferencesHtml", () => {
  it("References 标题后注入 <ol>（numeric 含编号前缀）", () => {
    bibliography.loadText("C:/fake.bib", BIB_TEXT);
    bibliography.setStyle("numeric");
    const html = injectReferencesHtml(
      `<h1>正文标题</h1><p>文</p><h2>References</h2><p>尾</p>`,
      ["smith2020", "knuth1984"]
    );
    expect(html).toContain('<ol class="md-references">');
    expect(html).toContain("[1] Smith");
    expect(html).toContain("[2] Knuth");
    // 注入点在标题之后、原文其余内容保留。
    expect(html.indexOf("<h2>References</h2>")).toBeLessThan(html.indexOf("<ol"));
    expect(html).toContain("<p>尾</p>");
  });

  it("标题后已有列表 → 原位替换（含嵌套列表）", () => {
    bibliography.loadText("C:/fake.bib", BIB_TEXT);
    const html = injectReferencesHtml(
      `<h1>参考文献</h1><ul><li>旧<ul><li>嵌套</li></ul></li><li>旧2</li></ul><p>后文</p>`,
      ["knuth1984"]
    );
    expect(html).not.toContain("旧2");
    expect(html).toContain("Knuth");
    expect(html).toContain("<p>后文</p>");
  });

  it("中文标题「参考文献」与无标记文档", () => {
    bibliography.loadText("C:/fake.bib", BIB_TEXT);
    expect(injectReferencesHtml(`<h1>参考文献</h1>`, ["knuth1984"])).toContain("<ol");
    const noMarker = `<p>无标记</p>`;
    expect(injectReferencesHtml(noMarker, ["knuth1984"])).toBe(noMarker);
  });

  it("未配置文献库：原样返回", () => {
    expect(injectReferencesHtml(`<h1>References</h1>`, ["x"])).toBe(
      `<h1>References</h1>`
    );
  });
});

describe("resolveCitationsForExport（一步到位）", () => {
  it("chip 降级 + 文献表注入组合", () => {
    bibliography.loadText("C:/fake.bib", BIB_TEXT);
    bibliography.setStyle("numeric");
    const html = resolveCitationsForExport(
      `<p>见 ${chip(["smith2020"])}。</p><h1>References</h1>`
    );
    expect(html).toContain("[1]");
    expect(html).toContain('<ol class="md-references">');
    expect(html).not.toContain("data-citation");
  });
});
