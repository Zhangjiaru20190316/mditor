import { describe, expect, it } from "vitest";
import { countWords } from "./textStats";

describe("countWords", () => {
  it("counts each CJK character as one word", () => {
    expect(countWords("你好世界")).toBe(4);
  });

  it("counts latin word runs as single words", () => {
    expect(countWords("hello world foo_bar")).toBe(4); // underscore splits foo_bar
  });

  it("matches the old two-regex semantics on mixed text", () => {
    const md = "# 标题 heading\n\n这是 mixed 内容 with 123 numbers。";
    // old: cjk(标题这是内容=6) + latin(heading mixed with 123 numbers=5)
    expect(countWords(md)).toBe(11);
  });

  it("returns 0 for empty / separator-only text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t == ** == ")).toBe(0);
  });
});
