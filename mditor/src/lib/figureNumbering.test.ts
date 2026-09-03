// 图表编号交叉引用测试（模块 3）：{#fig:id} / : caption {#tbl:id} / @fig:id
// 引用的解析、编号与静态渲染插件行为（caption 注入、code 免疫、未定义保留）。

import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { FigureNumbering, parseFigureAttr, parseTableCaption, resolveFigureRefs } from "./figureNumbering";
import { remarkFigureNumbering } from "./remarkFigureNumbering";

interface N {
  type?: string;
  value?: string;
  url?: string;
  alt?: string | null;
  children?: N[];
  [k: string]: unknown;
}

function run(md: string): N {
  // 与 renderMarkdown 静态管线同构（gfm 表格 + 本插件）。
  const proc = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFigureNumbering as never);
  return proc.runSync(proc.parse(md), md) as N;
}

function textOf(node: N): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

function all(node: N, pred: (n: N) => boolean, out: N[] = []): N[] {
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) all(c, pred, out);
  return out;
}

describe("parseFigureAttr / parseTableCaption（纯函数）", () => {
  it("{#fig:myid} / {#tbl:myid} 整段匹配", () => {
    expect(parseFigureAttr("{#fig:myid}")).toEqual({ kind: "fig", id: "myid" });
    expect(parseFigureAttr("  {#tbl:t1}  ")).toEqual({ kind: "tbl", id: "t1" });
    expect(parseFigureAttr("{#fig:}")).toBeNull();
    expect(parseFigureAttr("{fig:myid}")).toBeNull();
    expect(parseFigureAttr("前缀 {#fig:x}")).toBeNull();
  });

  it(": caption {#tbl:id} / 无 id 说明行", () => {
    expect(parseTableCaption(": 我的表格 {#tbl:t1}")).toEqual({
      caption: "我的表格",
      id: "t1",
    });
    expect(parseTableCaption(": 普通说明")).toEqual({ caption: "普通说明", id: null });
    expect(parseTableCaption("不是说明行")).toBeNull();
  });

  it("resolveFigureRefs：图/表 N 替换，未定义原样保留", () => {
    const figs = new Map([["a", 2]]);
    const tbls = new Map([["t", 1]]);
    expect(resolveFigureRefs("见 @fig:a 与 @tbl:t", figs, tbls)).toBe("见 图 2 与 表 1");
    expect(resolveFigureRefs("见 @fig:ghost", figs, tbls)).toBe("见 @fig:ghost");
  });

  it("FigureNumbering：首现占号、重复不重编、图表独立计数", () => {
    const n = new FigureNumbering();
    expect(n.assign("fig", "a")).toBe(1);
    expect(n.assign("tbl", "b")).toBe(1);
    expect(n.assign("fig", "a")).toBe(1);
    expect(n.assign("fig", "c")).toBe(2);
    expect(n.assign("tbl", "d")).toBe(2);
  });
});

describe("remarkFigureNumbering（静态渲染插件）", () => {
  it("图片 + 同段 {#fig:id} → caption 段「图 N：alt」，标记消失，@fig 引用解析", () => {
    const tree = run(
      "![实验结果](result.png){#fig:exp}\n\n如 @fig:exp 所示。\n"
    );
    const flat = textOf(tree);
    expect(flat).toContain("图 1：实验结果");
    expect(flat).not.toContain("{#fig:");
    expect(flat).toContain("如 图 1 所示");
    // 图片本体保留、alt 不动（alt 是 caption 源）。
    const img = all(tree, (n) => n.type === "image")[0];
    expect(img?.url).toBe("result.png");
  });

  it("图片段 + 下一段独立 {#fig:id} → 同样编号", () => {
    const tree = run("![标题](a.png)\n\n{#fig:x}\n");
    expect(textOf(tree)).toContain("图 1：标题");
  });

  it("表格相邻说明行 → 「表 N：caption」，正文 @tbl 引用解析", () => {
    const md = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n: 实验对比 {#tbl:cmp}\n\n见 @tbl:cmp。\n";
    const tree = run(md);
    const flat = textOf(tree);
    expect(flat).toContain("表 1：实验对比");
    expect(flat).toContain("见 表 1");
    expect(flat).not.toContain("{#tbl:");
  });

  it("表格前置说明行同样生效（前/后相邻均可）", () => {
    const md = ": 前置说明 {#tbl:pre}\n\n| a |\n| --- |\n| 1 |\n";
    const tree = run(md);
    expect(textOf(tree)).toContain("表 1：前置说明");
  });

  it("无 id 的普通说明行不动；未定义 @fig 引用保留原文", () => {
    const tree = run(": 普通说明\n\n| a |\n| --- |\n| 1 |\n\n见 @fig:ghost。\n");
    const flat = textOf(tree);
    expect(flat).toContain(": 普通说明");
    expect(flat).toContain("@fig:ghost");
  });

  it("多图多表按文档序编号", () => {
    const tree = run(
      "![一](a.png){#fig:a}\n\n![二](b.png){#fig:b}\n\n| x |\n| --- |\n| 1 |\n\n: 表一 {#tbl:t}\n\n![三](c.png){#fig:c}\n"
    );
    const flat = textOf(tree);
    expect(flat).toContain("图 1：一");
    expect(flat).toContain("图 2：二");
    expect(flat).toContain("表 1：表一");
    expect(flat).toContain("图 3：三");
  });

  it("code / inlineCode 内的 @fig: 保持字面", () => {
    const tree = run("示例 `@fig:x` 代码\n\n```\n@fig:x\n```\n");
    const code = all(tree, (n) => n.type === "code")[0];
    expect(code?.value).toBe("@fig:x");
    const inline = all(tree, (n) => n.type === "inlineCode")[0];
    expect(inline?.value).toBe("@fig:x");
  });

  it("无 alt 图片：仅「图 N」无标题", () => {
    const tree = run("![](a.png){#fig:noalt}\n");
    expect(textOf(tree)).toContain("图 1");
  });
});
