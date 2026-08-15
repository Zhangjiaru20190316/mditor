import { describe, expect, it } from "vitest";
import {
  applyHunks,
  charDiffRange,
  diffText,
  splitLines,
  unwrapWholeFence,
} from "./diff";

const L = (...ls: string[]) => ls.join("\n");

describe("diffText", () => {
  it("returns no hunks for identical texts", () => {
    const t = L("# 标题", "", "正文段落。");
    expect(diffText(t, t)).toEqual([]);
  });

  it("ignores CRLF differences", () => {
    expect(diffText("a\r\nb\r\n", "a\nb\n")).toEqual([]);
  });

  it("detects a single changed line (typo fix)", () => {
    const orig = L("第一行", "第二行有个错别子", "第三行");
    const rev = L("第一行", "第二行有个错别字", "第三行");
    const hunks = diffText(orig, rev);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].origLines).toEqual(["第二行有个错别子"]);
    expect(hunks[0].newLines).toEqual(["第二行有个错别字"]);
    expect(hunks[0].origStart).toBe(1);
    expect(hunks[0].origEnd).toBe(2);
    expect(hunks[0].anchorLine).toBe("第二行有个错别子");
  });

  it("detects multiple separated hunks", () => {
    const orig = L("a", "b", "c", "d", "e");
    const rev = L("A", "b", "c", "D", "e");
    const hunks = diffText(orig, rev);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].origLines).toEqual(["a"]);
    expect(hunks[0].newLines).toEqual(["A"]);
    expect(hunks[1].origLines).toEqual(["d"]);
    expect(hunks[1].newLines).toEqual(["D"]);
  });

  it("handles a pure insertion", () => {
    const orig = L("a", "c");
    const rev = L("a", "b", "c");
    const hunks = diffText(orig, rev);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].origLines).toEqual([]);
    expect(hunks[0].newLines).toEqual(["b"]);
    expect(hunks[0].origStart).toBe(1);
    expect(hunks[0].origEnd).toBe(1);
  });

  it("handles a pure deletion", () => {
    const orig = L("a", "b", "c");
    const rev = L("a", "c");
    const hunks = diffText(orig, rev);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].origLines).toEqual(["b"]);
    expect(hunks[0].newLines).toEqual([]);
  });

  it("handles a replacement that changes line count", () => {
    const orig = L("one paragraph", "that gets split", "into more");
    const rev = L("one paragraph", "that gets", "split into", "more pieces", "tail");
    const hunks = diffText(orig, rev);
    expect(hunks.length).toBeGreaterThanOrEqual(1);
    // Whatever the hunk split, applying all must produce the revised text.
    expect(applyHunks(orig, hunks, hunks.map(() => true))).toBe(rev);
  });

  it("handles a completely rewritten text as one hunk", () => {
    const hunks = diffText("旧内容\n旧内容", "new stuff");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].origLines).toEqual(["旧内容", "旧内容"]);
    expect(hunks[0].newLines).toEqual(["new stuff"]);
  });

  it("falls back to a single coarse hunk beyond the DP cap", () => {
    const orig = Array.from({ length: 3000 }, (_, i) => `line-${i}`);
    const rev = Array.from({ length: 3000 }, (_, i) => `line-${i}-x`);
    const hunks = diffText(L(...orig), L(...rev));
    expect(hunks).toHaveLength(1);
    expect(applyHunks(L(...orig), hunks, [true])).toBe(L(...rev));
  });

  it("marks a moved-style change as hunks that apply cleanly", () => {
    const orig = L("# T", "", "- a", "- b", "- c", "", "尾段");
    const rev = L("# T", "", "- a（改）", "- b", "- c", "- 新增", "", "尾段（改）");
    const hunks = diffText(orig, rev);
    expect(hunks.length).toBeGreaterThanOrEqual(2);
    expect(applyHunks(orig, hunks, hunks.map(() => true))).toBe(rev);
  });
});

describe("applyHunks", () => {
  const orig = L("一", "二", "三", "四", "五");
  const rev = L("一", "二（改）", "三", "四（改）", "五");
  const hunks = diffText(orig, rev);

  it("accept-all reproduces the revised text", () => {
    expect(applyHunks(orig, hunks, [true, true])).toBe(rev);
  });

  it("reject-all keeps the original", () => {
    expect(applyHunks(orig, hunks, [false, false])).toBe(orig);
  });

  it("applies per-hunk decisions independently", () => {
    expect(applyHunks(orig, hunks, [true, false])).toBe(L("一", "二（改）", "三", "四", "五"));
    expect(applyHunks(orig, hunks, [false, true])).toBe(L("一", "二", "三", "四（改）", "五"));
  });

  it("round-trips insertions and deletions selectively", () => {
    const o = L("keep", "drop1", "drop2", "keep2");
    const r = L("keep", "inserted", "keep2");
    const hs = diffText(o, r);
    expect(applyHunks(o, hs, hs.map(() => true))).toBe(r);
    expect(applyHunks(o, hs, hs.map(() => false))).toBe(o);
  });
});

describe("charDiffRange", () => {
  it("finds the differing middle of two lines", () => {
    const { aRange, bRange } = charDiffRange("这是原来的句子", "这是修改后的句子");
    expect(aRange).not.toBeNull();
    expect(bRange).not.toBeNull();
    expect("这是原来的句子".slice(aRange![0], aRange![1])).toBe("原来");
    expect("这是修改后的句子".slice(bRange![0], bRange![1])).toBe("修改后");
  });

  it("returns nulls for equal strings", () => {
    expect(charDiffRange("same", "same")).toEqual({ aRange: null, bRange: null });
  });

  it("marks an entirely new string", () => {
    const { aRange, bRange } = charDiffRange("", "新增");
    expect(aRange).toBeNull();
    expect(bRange).toEqual([0, 2]);
  });
});

describe("unwrapWholeFence", () => {
  it("unwraps a whole-reply fence", () => {
    expect(unwrapWholeFence("```markdown\n# 标题\n正文\n```")).toBe("# 标题\n正文");
  });

  it("unwraps a tilde fence without info string", () => {
    expect(unwrapWholeFence("~~~\nabc\n~~~")).toBe("abc");
  });

  it("keeps text that merely contains a fence", () => {
    const t = L("前言", "", "```js", "code()", "```", "", "后记");
    expect(unwrapWholeFence(t)).toBe(t);
  });

  it("keeps unfenced text", () => {
    expect(unwrapWholeFence("普通回复")).toBe("普通回复");
  });
});

describe("splitLines", () => {
  it("splits on LF and CRLF", () => {
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
  });
  it("keeps a trailing empty line", () => {
    expect(splitLines("a\n")).toEqual(["a", ""]);
  });
});
