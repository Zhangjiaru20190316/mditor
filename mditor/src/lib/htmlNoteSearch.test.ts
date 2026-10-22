// HN 轮阶段 2 单测：HTML 笔记搜索抽取（DOMParser）+ 命中收集 + 磁盘搜索；
// 以及 htmlToMarkdown 转换。DOMParser 需要 jsdom 环境。

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({
  detectRuntime: () => "tauri",
  getAdapter: () => ({ runtime: "tauri", fs: mockFs, capabilities: { htmlNoteView: true } }),
}));

import {
  collectHtmlHits,
  extractHtmlNoteIndex,
  searchHtmlNotes,
} from "./htmlNoteSearch";
import { convertHtmlToMarkdown } from "./htmlToMarkdown";

let mockFs: {
  readDir: (d: string) => Promise<Array<{ name: string; isDirectory: boolean }>>;
  readTextFile: (p: string) => Promise<string>;
};

const treeOf = (files: Record<string, string>) => ({
  readDir: async (d: string) =>
    Object.keys(files)
      .filter((p) => p.startsWith(d + "/") && !p.slice(d.length + 1).includes("/"))
      .map((p) => ({ name: p.slice(d.length + 1), isDirectory: false })),
  readTextFile: async (p: string) => {
    if (!(p in files)) throw new Error("ENOENT " + p);
    return files[p];
  },
});

describe("extractHtmlNoteIndex（DOMParser 抽取）", () => {
  it("title 回退 <title> → 首个 h1；大纲按文档序；文本压缩空白", () => {
    const r = extractHtmlNoteIndex(
      `<html><head><title>页面标题</title><style>.x{color:red}</style></head>
       <body><h1>一级</h1><p>段落  文本</p><script>alert(1)</script><h2>二级</h2></body></html>`
    );
    expect(r.title).toBe("页面标题");
    expect(r.outline).toEqual([
      { level: 1, text: "一级" },
      { level: 2, text: "二级" },
    ]);
    expect(r.text).toContain("段落 文本");
    expect(r.text).not.toContain("alert");
    expect(r.text).not.toContain("color:red");
  });

  it("无 title 无 h1 → title null", () => {
    expect(extractHtmlNoteIndex("<p>只有正文</p>").title).toBeNull();
  });
});

describe("collectHtmlHits", () => {
  const text = "第一段讲算法。第二段讲算法复杂度。第三段无关。";
  it("大小写不敏感默认；多命中全收集；摘录锚定命中处", () => {
    const hits = collectHtmlHits(text, "算法", false, 10);
    expect(hits.length).toBe(2);
    expect(hits[0].text.startsWith("算法")).toBe(true); // 摘录从命中处起
  });
  it("maxHits 截断", () => {
    expect(collectHtmlHits(text, "段", false, 2).length).toBe(2);
  });
  it("大小写敏感", () => {
    expect(collectHtmlHits("Abc abc", "abc", true).length).toBe(1);
  });
});

describe("searchHtmlNotes（mock fs）", () => {
  it("命中 html 文件、跳过超长文件", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    mockFs = treeOf({
      "V/a.html": "<h1>速查</h1><p>线性代数笔记</p>",
      "V/b.htm": "<p>没有关键词</p>",
      "V/c.html": big,
    });
    const r = await searchHtmlNotes(["V"], "线性代数", {});
    expect(r.files.length).toBe(1);
    expect(r.files[0].name).toBe("a.html");
    expect(r.files[0].hits[0].text).toContain("线性代数");
    expect(r.truncated).toBe(true); // 超长跳过置位
    expect(r.scanned).toBe(3);
  });
});

describe("convertHtmlToMarkdown（turndown + GFM）", () => {
  it("标题/强调/链接/表格；script/style 剥除", async () => {
    const md = await convertHtmlToMarkdown(
      `<html><body>
        <h1>标题一</h1>
        <p><strong>加粗</strong> 与 <a href="https://example.com">链接</a></p>
        <script>evil()</script>
        <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
      </body></html>`
    );
    expect(md).toContain("# 标题一");
    expect(md).toContain("**加粗**");
    expect(md).toContain("[链接](https://example.com)");
    expect(md).toContain("| A | B |");
    expect(md).not.toContain("evil");
  });

  it("空表（无单元格）不崩溃（gfm 已知缺陷的预处理）", async () => {
    const md = await convertHtmlToMarkdown(
      `<body><p>正文</p><table id="checks"><tbody></tbody></table></body>`
    );
    expect(md).toContain("正文");
  });

  it("官方测试页可完整转换（回归钉）", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync("public/html-note-demo/index.html", "utf8");
    const md = await convertHtmlToMarkdown(html);
    expect(md).toContain("Mditor HTML 笔记官方测试页");
  });
});
