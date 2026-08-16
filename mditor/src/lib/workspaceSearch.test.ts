import { describe, expect, it } from "vitest";
import { collectHits, matchLine } from "./workspaceSearch";

describe("matchLine", () => {
  it("finds case-insensitively by default", () => {
    expect(matchLine("Hello World", "world", false)).toBe(6);
    expect(matchLine("Hello World", "world", true)).toBe(-1);
    expect(matchLine("Hello World", "World", true)).toBe(6);
  });

  it("handles CJK needles", () => {
    expect(matchLine("标题：会议纪要", "会议", true)).toBe(3);
  });

  it("empty needle never matches", () => {
    expect(matchLine("abc", "", false)).toBe(-1);
  });
});

describe("collectHits", () => {
  const doc = "# 标题\n\n正文包含 needle 一处\nanother NEEDLE here\n最后一行";

  it("collects per-line hits with 0-based line numbers", () => {
    const hits = collectHits(doc, "needle", false, 50);
    expect(hits).toHaveLength(2);
    expect(hits[0].line).toBe(2);
    expect(hits[1].line).toBe(3);
    expect(hits[1].text).toContain("NEEDLE");
  });

  it("respects case sensitivity", () => {
    expect(collectHits(doc, "needle", true, 50)).toHaveLength(1);
  });

  it("caps hits at maxHits", () => {
    const hits = collectHits("a\na\na\na", "a", false, 2);
    expect(hits).toHaveLength(2);
  });

  it("clips long lines around the match", () => {
    const long = "x".repeat(300) + "needle" + "y".repeat(300);
    const hits = collectHits(long, "needle", false, 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].text.length).toBeLessThanOrEqual(161);
    expect(hits[0].text).toContain("needle");
  });
});
