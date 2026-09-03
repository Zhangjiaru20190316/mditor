// remarkFlash 插件测试（模块 4）：native 闭环（容器组装 / 序列化回写 /
// 未闭合宽容）与 render 模式（blockquote 降级）。

import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { remarkFlash } from "./remarkFlash";

interface N {
  type?: string;
  value?: string;
  children?: N[];
  [k: string]: unknown;
}

function runNative(md: string): N {
  const proc = unified().use(remarkParse).use(remarkFlash as never);
  return proc.runSync(proc.parse(md), md) as N;
}

function runRender(md: string): N {
  const proc = unified().use(remarkParse).use(remarkFlash as never, { mode: "render" });
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

describe("remarkFlash（native 模式：编辑器/worker 闭环）", () => {
  it(":::flash 块 → flashcard 节点（children 保留原始块）", () => {
    const tree = runNative(":::flash\n问题？\n---\n答案。\n:::\n");
    const card = find(tree, (n) => n.type === "flashcard");
    expect(card).not.toBeNull();
    const kinds = (card?.children ?? []).map((c) => c.type);
    expect(kinds).toContain("paragraph");
    expect(kinds).toContain("thematicBreak");
    expect(kinds.length).toBe(3);
  });

  it("嵌套容器（引用/列表）里的 :::flash 同样组装", () => {
    const tree = runNative("> 引用开头\n>\n> :::flash\n> Q\n> ---\n> A\n> :::\n");
    expect(find(tree, (n) => n.type === "flashcard")).not.toBeNull();
  });

  it("序列化回写 :::flash 原文（remark-stringify 闭环）", () => {
    const proc = unified().use(remarkParse).use(remarkFlash as never).use(remarkStringify);
    const md = ":::flash\n问题？\n\n---\n\n答案。\n:::\n";
    const out = proc.stringify(proc.runSync(proc.parse(md), md) as never);
    expect(out).toContain(":::flash");
    expect(out).toContain(":::");
    expect(out).toContain("问题？");
    expect(out).toContain("答案。");
  });

  it("未闭合容器保持原样（宽容：不开卡不吞正文）", () => {
    const tree = runNative(":::flash\n问题？\n（没有闭合）\n");
    expect(find(tree, (n) => n.type === "flashcard")).toBeNull();
    const flat = JSON.stringify(tree);
    expect(flat).toContain("问题？");
    expect(flat).toContain("没有闭合");
  });

  it("代码围栏内的 :::flash 字面保留", () => {
    const tree = runNative("```\n:::flash\nQ\n:::\n```\n");
    expect(find(tree, (n) => n.type === "flashcard")).toBeNull();
    expect(find(tree, (n) => n.type === "code")?.value).toContain(":::flash");
  });
});

describe("remarkFlash（render 模式：静态渲染/导出降级）", () => {
  it("flashcard → blockquote（铁律 6：普通引用块）", () => {
    const tree = runRender(":::flash\n问题？\n\n---\n\n答案。\n:::\n");
    expect(find(tree, (n) => n.type === "flashcard")).toBeNull();
    const quote = find(tree, (n) => n.type === "blockquote");
    expect(quote).not.toBeNull();
    const kinds = (quote?.children ?? []).map((c) => c.type);
    expect(kinds).toContain("paragraph");
    expect(kinds).toContain("thematicBreak");
  });
});
