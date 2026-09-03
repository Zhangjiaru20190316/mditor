// remarkCitation 插件测试（模块 3）：native 闭环（节点形态 / 序列化回写 /
// code 免疫）与 render 模式（编号格式化 / 未解析降级 / 参考文献表注入）。
// 文献数据经模块级 bibliography 单例的 loadText 灌入（node 环境无 Tauri fs）。

import { describe, expect, it, beforeEach } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { remarkCitation } from "./remarkCitation";
import { bibliography } from "./bibliography";

const BIB_TEXT = `
@article{smith2020,
  author = {Smith, John and Lee, Kate},
  title = {A Study of Things},
  journal = {Journal of Examples},
  year = {2020},
  volume = {12},
  pages = {45--67}
}
@book{knuth1984,
  author = {Knuth, Donald E.},
  title = {The TeXbook},
  publisher = {Addison-Wesley},
  year = {1984}
}
`;

interface N {
  type?: string;
  value?: string;
  children?: N[];
  raw?: string;
  keys?: string[];
  locator?: string;
  ordered?: boolean;
  [k: string]: unknown;
}

function runNative(md: string): N {
  const proc = unified().use(remarkParse).use(remarkCitation as never);
  return proc.runSync(proc.parse(md), md) as N;
}

function runRender(md: string): N {
  const proc = unified().use(remarkParse).use(remarkCitation as never, { mode: "render" });
  return proc.runSync(proc.parse(md), md) as N;
}

function find(node: N, pred: (n: N) => boolean): N | null {
  if (pred(node)) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}

function all(node: N, pred: (n: N) => boolean, out: N[] = []): N[] {
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) all(c, pred, out);
  return out;
}

function textOf(node: N): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

beforeEach(() => {
  // 每个用例从干净状态开始：未配置路径。
  void bibliography.setPath("");
});

describe("remarkCitation（native 模式：编辑器/worker 闭环）", () => {
  it("text → citation 节点（raw/keys/locator）", () => {
    const tree = runNative("见 [@smith2020] 与 [@knuth1984, p. 12]。");
    const cites = all(tree, (n) => n.type === "citation");
    expect(cites.length).toBe(2);
    expect(cites[0]).toMatchObject({ raw: "[@smith2020]", keys: ["smith2020"] });
    expect(cites[1]).toMatchObject({
      raw: "[@knuth1984, p. 12]",
      keys: ["knuth1984"],
      locator: "p. 12",
    });
  });

  it("序列化回写 raw 原文（remark-stringify 闭环）", () => {
    const proc = unified().use(remarkParse).use(remarkCitation as never).use(remarkStringify);
    const md = "引用 [@smith2020, p. 5] 结束";
    const out = proc.stringify(proc.runSync(proc.parse(md), md) as never);
    expect(out.trim()).toBe("引用 [@smith2020, p. 5] 结束");
  });

  it("code span / 代码块免疫", () => {
    const tree = runNative("示例 `[@smith2020]` 与\n\n```\n[@smith2020]\n```\n");
    expect(all(tree, (n) => n.type === "citation").length).toBe(0);
  });
});

describe("remarkCitation（render 模式：静态渲染/导出）", () => {
  it("未配置文献库：引用保留原文形态（可读降级），不注入文献表", () => {
    const tree = runRender("见 [@smith2020]。\n\n# References\n");
    expect(find(tree, (n) => n.type === "citation")).toBeNull();
    const flat = JSON.stringify(tree);
    expect(flat).toContain("[@smith2020]");
    // 无数据 → 不动参考文献标记区。
    expect(find(tree, (n) => n.type === "list")).toBeNull();
  });

  it("numeric：按出现序编号为纯文本 + References 标题下注入文献表", () => {
    bibliography.loadText("C:/fake/refs.bib", BIB_TEXT);
    bibliography.setStyle("numeric");
    const tree = runRender(
      "引用二 [@knuth1984] 与首引 [@smith2020]，再引 [@smith2020]。\n\n# References\n"
    );
    expect(find(tree, (n) => n.type === "citation")).toBeNull();
    const flat = textOf(tree);
    // 出现序：knuth1984=1，smith2020=2；再引沿用 2。
    expect(flat).toContain("[1]");
    expect(flat).toContain("[2]");
    const list = find(tree, (n) => n.type === "list");
    expect(list).not.toBeNull();
    const items = all(list!, (n) => n.type === "listItem");
    expect(items.length).toBe(2);
    expect(textOf(items[0])).toContain("[1] Knuth");
    expect(textOf(items[0])).toContain("The TeXbook");
    expect(textOf(items[1])).toContain("[2] Smith");
  });

  it("标记区下的旧占位内容被生成表替换（自动生成语义）", () => {
    bibliography.loadText("C:/fake/refs.bib", BIB_TEXT);
    bibliography.setStyle("numeric");
    const tree = runRender(
      "引 [@smith2020]。\n\n## 参考文献\n\n- 旧的占位内容\n- 另一条旧内容\n\n## 下一个标题\n\n正文。\n"
    );
    const list = find(tree, (n) => n.type === "list");
    expect(list).not.toBeNull();
    const items = all(list!, (n) => n.type === "listItem");
    expect(items.length).toBe(1); // 只有 smith2020
    expect(textOf(items[0])).not.toContain("旧的占位内容");
    // 后续标题与正文保留。
    const flat = textOf(tree);
    expect(flat).toContain("下一个标题");
    expect(flat).toContain("正文。");
  });

  it("author-year：作者-年份形态 + 字母序表", () => {
    bibliography.loadText("C:/fake/refs.bib", BIB_TEXT);
    bibliography.setStyle("author-year");
    const tree = runRender("引 [@smith2020] 与 [@knuth1984]。\n\n# References\n");
    const flat = textOf(tree);
    expect(flat).toContain("(Smith & Lee, 2020)");
    expect(flat).toContain("(Knuth, 1984)");
    const list = find(tree, (n) => n.type === "list");
    const items = all(list!, (n) => n.type === "listItem");
    expect(textOf(items[0])).toContain("Knuth");
    expect(textOf(items[1])).toContain("Smith");
  });

  it("未解析键降级为键名文本，且不进文献表", () => {
    bibliography.loadText("C:/fake/refs.bib", BIB_TEXT);
    bibliography.setStyle("numeric");
    const tree = runRender("引 [@smith2020] 与 [@ghost2099]。\n\n# References\n");
    const flat = textOf(tree);
    expect(flat).toContain("[1]");
    expect(flat).toContain("[ghost2099]");
    const list = find(tree, (n) => n.type === "list");
    const items = all(list!, (n) => n.type === "listItem");
    expect(items.length).toBe(1);
  });

  it("无 References 标记：只编号不注入", () => {
    bibliography.loadText("C:/fake/refs.bib", BIB_TEXT);
    const tree = runRender("引 [@smith2020]。");
    expect(find(tree, (n) => n.type === "list")).toBeNull();
    expect(textOf(tree)).toContain("[1]");
  });
});
