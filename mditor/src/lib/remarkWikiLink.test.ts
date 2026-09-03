// 双链 remark 插件单测：native 解析 / 序列化回写 / 导出降级三面锚定。
// 哨兵计数锚定见 remarkPipeline.test.ts。

import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { remarkWikiLink, parseWikiLink } from "./remarkWikiLink";

interface N {
  type?: string;
  value?: string;
  url?: string;
  target?: string;
  label?: string;
  children?: N[];
  [k: string]: unknown;
}

function runNative(md: string): N {
  const proc = unified().use(remarkParse).use(remarkWikiLink as never);
  return proc.runSync(proc.parse(md)) as N;
}

function runExport(md: string, resolve: (t: string) => string | null): N {
  const proc = unified()
    .use(remarkParse)
    .use(remarkWikiLink as never, { exportMode: true, resolve });
  return proc.runSync(proc.parse(md)) as N;
}

function find(node: N, pred: (n: N) => boolean): N[] {
  const out: N[] = [];
  const walk = (n: N) => {
    if (pred(n)) out.push(n);
    (n.children ?? []).forEach(walk);
  };
  walk(node);
  return out;
}

describe("parseWikiLink（语法拆解）", () => {
  it("target|label / target / target#heading", () => {
    expect(parseWikiLink("目标")).toEqual({ target: "目标", label: "目标" });
    expect(parseWikiLink("目标|显示")).toEqual({ target: "目标", label: "显示" });
    // 子标题链接：target 取 # 前，label 保留完整原文（显示更完整）。
    expect(parseWikiLink("目标#章节")).toEqual({ target: "目标", label: "目标#章节" });
    expect(parseWikiLink(" 目标 | 显示 ")).toEqual({ target: "目标", label: "显示" });
    expect(parseWikiLink("")).toBeNull();
    expect(parseWikiLink("#only-anchor")).toBeNull();
  });
});

describe("native 模式（编辑器 + worker 管线）", () => {
  it("text 里的 [[…]] → wikiLink 节点（含 attrs 与 children）", () => {
    const tree = runNative("见 [[目标|显示]] 与 [[目标]]");
    const links = find(tree, (n) => n.type === "wikiLink");
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ target: "目标", label: "显示" });
    expect(links[1]).toMatchObject({ target: "目标", label: "目标" });
    // 前后文本保留。
    const texts = find(tree, (n) => n.type === "text").map((n) => n.value);
    expect(texts).toContain("见 ");
    expect(texts).toContain(" 与 ");
  });

  it("代码 span / 代码块里的 [[…]] 不解析", () => {
    const tree = runNative("`[[不解析]]`\n\n```\n[[也不解析]]\n```\n\n[[解析]]");
    const links = find(tree, (n) => n.type === "wikiLink");
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("解析");
  });

  it("嵌套 [[ 双链逐个匹配（同一行多个）", () => {
    const tree = runNative("[[a]] 和 [[b|B]] 和 [[c]]");
    const links = find(tree, (n) => n.type === "wikiLink");
    expect(links.map((l) => l.target)).toEqual(["a", "b", "c"]);
  });

  it("序列化回写保留 [[…]] 原文（本地闭环）", () => {
    const proc = unified()
      .use(remarkParse)
      .use(remarkWikiLink as never)
      .use(remarkStringify, { bullet: "-" });
    const out = String(proc.processSync("见 [[目标|显示]] 与 [[目标]]"));
    expect(out).toContain("[[目标|显示]]");
    expect(out).toContain("[[目标]]");
    expect(out).not.toContain("undefined");
  });

  it("标题行内的双链同样解析", () => {
    const tree = runNative("# 标题带 [[链接]]");
    expect(find(tree, (n) => n.type === "wikiLink")).toHaveLength(1);
  });
});

describe("export 模式（静态渲染 / 导出降级）", () => {
  it("resolver 命中 → 标准 link 节点（相对 href）", () => {
    const tree = runExport("见 [[目标|显示]]", () => "../notes/目标.md");
    const links = find(tree, (n) => n.type === "link");
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("../notes/目标.md");
    expect(links[0].children?.[0]?.value).toBe("显示");
    // 不残留 wikiLink 节点。
    expect(find(tree, (n) => n.type === "wikiLink")).toHaveLength(0);
  });

  it("未解析 → 样式化纯文本 span（html 节点，title 保留目标名）", () => {
    const tree = runExport("见 [[不存在]]", () => null);
    const html = find(tree, (n) => n.type === "html");
    expect(html).toHaveLength(1);
    expect(String(html[0].value)).toContain('class="wikilink-unresolved"');
    expect(String(html[0].value)).toContain("不存在");
    expect(String(html[0].value)).toContain("未链接的笔记");
    // 目标名中的 HTML 特殊字符转义。
    const tree2 = runExport("[[a<b&c>]]", () => null);
    const html2 = find(tree2, (n) => n.type === "html")[0];
    expect(String(html2.value)).toContain("a&lt;b&amp;c&gt;");
  });

  it("export 模式不注册序列化 handler（不污染 stringify）", () => {
    // export 管线只走 md→html；确认 toMarkdownExtensions 未挂（用例：串
    // 两个 processor 不串扰）。这里只验证 export 模式处理器可重复解析。
    const t1 = runExport("[[a]] [[b]]", () => "x");
    const t2 = runExport("[[c]]", () => null);
    expect(find(t1, (n) => n.type === "link")).toHaveLength(2);
    expect(find(t2, (n) => n.type === "link")).toHaveLength(0);
  });
});
