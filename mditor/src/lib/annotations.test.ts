// 批注锚点摘要测试（v3.9 批量化）：getAnchorSnippets 与单条版
// getAnchorSnippet 等价、缺失引用映射空串、代码块块锚点回退。

import { describe, expect, it } from "vitest";
import {
  buildDefinition,
  getAnchorSnippet,
  getAnchorSnippets,
  parseAnnotations,
} from "./annotations";

const doc = [
  "# 标题",
  "",
  "这是被批注的第一段文字[^anno-1]，后面还有内容。",
  "",
  "```ts",
  "const a = 1;",
  "const b = 2;",
  "```",
  "",
  "[^anno-2]",
  "",
  "另一段普通文字。",
  "",
  "[^anno-1]: 第一条批注内容",
  "[^anno-2]: 第二条批注内容",
].join("\n");

describe("getAnchorSnippets（批量）", () => {
  it("与单条 getAnchorSnippet 结果一致", () => {
    const ids = ["anno-1", "anno-2"];
    const batch = getAnchorSnippets(doc, ids);
    for (const id of ids) {
      expect(batch.get(id)).toBe(getAnchorSnippet(doc, id));
    }
  });
  it("行内引用取前置文字", () => {
    const batch = getAnchorSnippets(doc, ["anno-1"]);
    expect(batch.get("anno-1")).toContain("第一段文字");
  });
  it("块锚点（代码块下方的独占标记）回退到代码首行", () => {
    const batch = getAnchorSnippets(doc, ["anno-2"]);
    expect(batch.get("anno-2")).toContain("代码：");
    expect(batch.get("anno-2")).toContain("const a = 1;");
  });
  it("不存在的 id 映射为空串", () => {
    const batch = getAnchorSnippets(doc, ["anno-99"]);
    expect(batch.get("anno-99")).toBe("");
  });
  it("只请求的 id 进入结果", () => {
    const batch = getAnchorSnippets(doc, ["anno-1"]);
    expect(batch.has("anno-2")).toBe(false);
  });
  it("空文档 / 空 id 列表", () => {
    expect(getAnchorSnippets("", ["anno-1"]).get("anno-1")).toBe("");
    expect(getAnchorSnippets(doc, []).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// v3.9.2 回归：真实问题文档（Week8 教学 md）的 anno-11 定义体 —— 多行 bullet
// 正文 + `<!--md:line-->` 代码行元数据 + 前导空行的流式中间态。断言
// buildDefinition 的输出永远是「可独立解析成 footnote_definition」的形态，
// 杜绝定点替换每帧失败 → 整篇回退 → 代码块/徽章连根重建的闪烁循环。
// ---------------------------------------------------------------------------
describe("buildDefinition 真实文档回归（v3.9.2）", () => {
  const anno11Body = [
    "**DataLoader与Subset是联邦学习数据层核心，实现按客户端独立、高效的数据加载。**",
    "",
    "* **DataLoader功能**：将`Dataset`包装为可迭代的批次生成器。",
    "* **Subset作用**：通过索引列表从完整数据集创建子集视图，零拷贝。",
    "",
    "重点：确保`Subset`索引划分的准确性。",
  ].join("\n");
  const anno11Meta = {
    start: 18,
    end: 18,
    firstLine:
      "    return DataLoader(subset, batch_size=batch_size, shuffle=shuffle,",
  };

  it("多行 bullet 体：所有续行 4 空格缩进，令牌在首行尾，round-trip 无损", () => {
    const def = buildDefinition("anno-11", anno11Body, anno11Meta);
    const lines = def.split("\n");
    expect(lines[0]).toMatch(/^\[\^anno-11\]: \*\*DataLoader与Subset/);
    // 令牌在首行文字之后（前缀形态会被 Milkdown 解析器丢弃）
    expect(def.startsWith("[^anno-11]: <!--")).toBe(false);
    expect(lines[0]).toMatch(/<!--md:line 18-18 [A-Za-z0-9+/=]+-->$/);
    // 每条续行要么空白、要么 4 空格缩进
    for (const ln of lines.slice(1)) {
      expect(ln === "" || /^[ \t]{4}/.test(ln) || /^[ \t]*$/.test(ln)).toBe(true);
    }
    // parseAnnotations 能完整读回：内容与元数据 round-trip
    const parsed = parseAnnotations(def)[0];
    expect(parsed?.id).toBe("anno-11");
    expect(parsed?.codeLine?.start).toBe(18);
    expect(parsed?.codeLine?.end).toBe(18);
    expect(parsed?.codeLine?.firstLine).toBe(anno11Meta.firstLine);
    expect(parsed?.content).toContain("DataLoader与Subset");
    expect(parsed?.content).toContain("零拷贝");
    // round-trip 后再构造一次定义，正文可见内容不变（幂等）
    const again = buildDefinition("anno-11", parsed!.content, parsed!.codeLine ?? null);
    expect(again.startsWith("[^anno-11]: <!--")).toBe(false);
    expect(parseAnnotations(again)[0]?.content).toBe(parsed!.content);
  });

  it("前导空行的流式中间态：令牌挂第一条非空行尾，定义形态可解析", () => {
    // AI 流式回复以前导换行开头时曾经产出 `[^id]: <!--…-->` 前缀形态 →
    // 定义被解析丢弃 → 每帧整篇回退（徽章闪/无编号 + 代码块闪）。
    const def = buildDefinition("anno-11", "\n\n**DataLoader…**", anno11Meta);
    expect(def.startsWith("[^anno-11]: <!--")).toBe(false);
    const parsed = parseAnnotations(def)[0];
    expect(parsed?.id).toBe("anno-11");
    expect(parsed?.content).toBe("**DataLoader…**");
    expect(parsed?.codeLine?.start).toBe(18);
  });

  it("空体中间态：定义保持存在（无令牌），不再产出裸令牌定义", () => {
    const def = buildDefinition("anno-11", "", anno11Meta);
    expect(def).toBe("[^anno-11]: ");
    const parsed = parseAnnotations(def)[0];
    expect(parsed?.id).toBe("anno-11");
    expect(parsed?.content).toBe("");
  });
});
