// anchorSearch.ts 的定位行为验证。ProseMirror 编号规则：块节点占
// size = 2 + 文本长度，段内首个字符位于 段起点+1，"最后一个字符之后"
// 的插入位 = 最后字符位置 + 1（仍在块内，绝不会越过块闭合边界）。
// 每个用例的期望值都按此手算并注明推导，便于失败时对照排查。
import { describe, expect, it } from "vitest";
import { Schema, Node as PMNode } from "@milkdown/prose/model";
import { normalizeAnchorText, nearestOccurrenceEnd, findAnchorPos } from "./anchorSearch";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block", toDOM: () => ["p", 0] },
    text: { group: "inline" },
    hard_break: { inline: true, group: "inline", selectable: false, atom: true, toDOM: () => ["br"] },
  },
  marks: { bold: { toDOM: () => ["strong", 0] } },
});

const t = (text: string) => ({ type: "text", text });
const bold = (text: string) => ({ type: "text", marks: [{ type: "bold" }], text });
const br = () => ({ type: "hard_break" });
const para = (...inlines: unknown[]) => ({ type: "paragraph", content: inlines });
const docOf = (...blocks: unknown[]) => PMNode.fromJSON(schema, { type: "doc", content: blocks });

describe("normalizeAnchorText", () => {
  it("collapses whitespace runs and trims ends", () => {
    expect(normalizeAnchorText("a\n\nb  c\t d ")).toBe("a b c d");
    expect(normalizeAnchorText("   ")).toBe("");
  });
});

describe("nearestOccurrenceEnd", () => {
  it("returns the first occurrence end without a hint", () => {
    // "abc" at 0/4/8 → ends 3/7/11；无 hint 取第一处。
    expect(nearestOccurrenceEnd("abc abc abc", "abc")).toBe(3);
  });

  it("returns the occurrence closest to the hint", () => {
    expect(nearestOccurrenceEnd("abc abc abc", "abc", 5)).toBe(7);
    expect(nearestOccurrenceEnd("abc abc abc", "abc", 9)).toBe(11);
  });

  it("returns -1 when absent or the needle is empty", () => {
    expect(nearestOccurrenceEnd("abc", "xyz")).toBe(-1);
    expect(nearestOccurrenceEnd("abc", "")).toBe(-1);
  });
});

describe("findAnchorPos", () => {
  it("anchors after the match inside a single paragraph", () => {
    // 段 0..13，文本 1..11（"Hello world" 11 字符）→ 末字符 'd' 在 11 → 插入位 12。
    const doc = docOf(para(t("Hello world")));
    expect(findAnchorPos(doc, "Hello world")).toBe(12);
    // 选区串的空白差异（多空格/首尾空白）不影响结果。
    expect(findAnchorPos(doc, "  Hello   world ")).toBe(12);
  });

  it("matches across paragraphs (DOM selection uses \\n\\n separators)", () => {
    // 段1 0..12（文本 1..10），段2 12..25（文本 13..23）→ 末字符在 23 → 插入位 24。
    const doc = docOf(para(t("first para")), para(t("second para")));
    expect(findAnchorPos(doc, "first para\n\nsecond para")).toBe(24);
    // 只锚选区后半段（落在第二段内）同样可命中。
    expect(findAnchorPos(doc, "second para")).toBe(24);
  });

  it("matches across inline-mark boundaries (adjacent text nodes)", () => {
    // 文本 "foo " 在 1..4，加粗 "bar" 在 5..7 → 拼接为 "foo bar"，末字符 'r' 在 7 → 8。
    const doc = docOf(para(t("foo "), bold("bar")));
    expect(findAnchorPos(doc, "foo bar")).toBe(8);
  });

  it("matches across hard_breaks (DOM renders <br> as \\n)", () => {
    // "foo" 1..3，hard_break 在 4，"bar" 5..7 → 拼接 "foo bar"（换行归一为空格）→ 8。
    const doc = docOf(para(t("foo"), br(), t("bar")));
    expect(findAnchorPos(doc, "foo\nbar")).toBe(8);
  });

  it("disambiguates repeated wording via the hint (stale range)", () => {
    // 段1 0..12（文本 1..10），段2 12..20（文本 13..18），段3 20..32（文本 21..30）。
    // "same words" 两处：段1 末字符在 10 → 11；段3 末字符在 30 → 31。
    const doc = docOf(para(t("same words")), para(t("middle")), para(t("same words")));
    expect(findAnchorPos(doc, "same words")).toBe(11); // 无 hint：保持首次出现
    expect(findAnchorPos(doc, "same words", 25)).toBe(31); // 靠近段3
    expect(findAnchorPos(doc, "same words", 5)).toBe(11); // 靠近段1
  });

  it("returns -1 when the anchor cannot be matched", () => {
    const doc = docOf(para(t("Hello world")));
    expect(findAnchorPos(doc, "absent text")).toBe(-1);
    expect(findAnchorPos(doc, "")).toBe(-1);
    expect(findAnchorPos(doc, "   ")).toBe(-1);
  });
});
