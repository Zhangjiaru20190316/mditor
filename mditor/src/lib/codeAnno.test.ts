import { describe, expect, it } from "vitest";
import {
  encodeCodeLineMeta,
  resolveCodeLines,
  stripCodeLineMeta,
  withCodeLineMeta,
  type CodeLineMeta,
} from "./codeAnno";
import {
  appendAnnotationDefinition,
  findAnnotationRefLine,
  parseAnnotations,
  updateAnnotationInMd,
} from "./annotations";

const meta: CodeLineMeta = { start: 2, end: 3, firstLine: "  return x + 1" };

const doc = [
  "# 标题",
  "",
  "```python",
  "def f(x):",
  "    return x + 1",
  "    # note",
  "```",
  "",
  "[^anno-1]",
  "",
  "[^anno-1]: 批注内容",
].join("\n");

function docWithMeta(md: string): string {
  return updateAnnotationInMd(md, "anno-1", "批注内容");
}

describe("code-line metadata codec", () => {
  it("round-trips through the HTML comment token", () => {
    const token = encodeCodeLineMeta(meta);
    expect(token).toMatch(/^<!--md:line 2-3 [A-Za-z0-9+/=]+-->$/);
    const { meta: back } = stripCodeLineMeta(`${token}正文`);
    expect(back).toEqual(meta);
  });

  it("stripCodeLineMeta decodes and cleans the body", () => {
    const { content, meta: m } = stripCodeLineMeta(
      `${encodeCodeLineMeta(meta)}批注正文`
    );
    expect(content).toBe("批注正文");
    expect(m).not.toBeNull();
    expect(m!.start).toBe(2);
    expect(m!.end).toBe(3);
    expect(m!.firstLine).toBe("  return x + 1");
  });

  it("passes through bodies without metadata", () => {
    expect(stripCodeLineMeta("普通批注")).toEqual({ content: "普通批注", meta: null });
  });

  it("withCodeLineMeta attaches / replaces / strips", () => {
    expect(withCodeLineMeta("正文", meta)).toBe(`${encodeCodeLineMeta(meta)}正文`);
    expect(withCodeLineMeta(`${encodeCodeLineMeta(meta)}旧`, { start: 1, end: 1, firstLine: "n" })).toBe(
      `${encodeCodeLineMeta({ start: 1, end: 1, firstLine: "n" })}旧`
    );
    expect(withCodeLineMeta(`${encodeCodeLineMeta(meta)}旧`, null)).toBe("旧");
  });

  it("survives non-ASCII first lines", () => {
    const m: CodeLineMeta = { start: 4, end: 4, firstLine: "// 注释：中文ⓒ" };
    const { meta: back } = stripCodeLineMeta(`${encodeCodeLineMeta(m)}x`);
    expect(back?.firstLine).toBe("// 注释：中文ⓒ");
  });
});

describe("findAnnotationRefLine", () => {
  it("returns the 0-based line of the inline reference, not the definition", () => {
    const md = ["# 标题", "", "正文[^anno-1]继续", "", "[^anno-1]: 内容"].join("\n");
    expect(findAnnotationRefLine(md, "anno-1")).toBe(2);
  });

  it("finds a block-anchored marker on its own line", () => {
    // doc's `[^anno-1]` sits alone on line 8 (0-based).
    expect(findAnnotationRefLine(doc, "anno-1")).toBe(8);
  });

  it("picks the FIRST reference when the marker appears twice inline", () => {
    const md = ["a[^anno-1]", "", "b[^anno-1]", "", "[^anno-1]: x"].join("\n");
    expect(findAnnotationRefLine(md, "anno-1")).toBe(0);
  });

  it("returns null when only the definition exists", () => {
    expect(findAnnotationRefLine("[^anno-1]: 只有定义", "anno-1")).toBeNull();
  });

  it("handles CRLF line endings", () => {
    const md = "para\r\n\r\nref[^anno-2] here\r\n\r\n[^anno-2]: x";
    expect(findAnnotationRefLine(md, "anno-2")).toBe(2);
  });

  it("ignores look-alike refs inside fenced code blocks", () => {
    // A document ABOUT footnotes: the `[^anno-1]` inside the fence is code,
    // never a rendered marker — the jump must target the real prose ref.
    const md = [
      "# 笔记",
      "",
      "```md",
      "示例[^anno-1]",
      "```",
      "",
      "真正的引用[^anno-1]",
      "",
      "[^anno-1]: x",
    ].join("\n");
    expect(findAnnotationRefLine(md, "anno-1")).toBe(6);
  });

  it("ignores refs written inside another annotation's definition body", () => {
    // 批注内容里引用另一条批注：定义块内（含缩进续行）的 `[^anno-1]`
    // 不是 inline marker。
    const md = [
      "被批注[^anno-2]",
      "",
      "[^anno-2]: 见 [^anno-1]",
      "    继续批注正文，也提到 [^anno-1]",
      "",
      "目标[^anno-1]",
      "",
      "[^anno-1]: y",
    ].join("\n");
    expect(findAnnotationRefLine(md, "anno-1")).toBe(5);
  });
});

describe("resolveCodeLines", () => {
  it("resolves the exact lines when the code is unchanged", () => {
    const md = docWithMeta(doc);
    expect(resolveCodeLines(md, "anno-1", meta)).toEqual({
      start: 2,
      end: 3,
      blockStartLine: 3,
    });
  });

  it("follows the content when lines were inserted above inside the block", () => {
    const edited = docWithMeta(
      doc.replace("def f(x):", "import os\ndef f(x):")
    );
    // "  return x + 1" moved from line 2 to line 3 within the block.
    expect(resolveCodeLines(edited, "anno-1", meta)).toEqual({
      start: 3,
      end: 4,
      blockStartLine: 3,
    });
  });

  it("keeps pointing at the content when the line moved further", () => {
    const edited = docWithMeta(
      doc.replace("```python", "```python\n# a\n# b\n# c")
    );
    expect(resolveCodeLines(edited, "anno-1", meta)).toEqual({
      start: 5,
      end: 6,
      blockStartLine: 3,
    });
  });

  it("falls back to another block containing the line", () => {
    const moved = docWithMeta(
      [
        "# 标题",
        "",
        "```python",
        "def f(x):",
        "    return x + 1",
        "```",
        "",
        "```js",
        "let a = 1;",
        "```",
        "",
        "[^anno-1]",
        "",
        "[^anno-1]: 批注",
      ].join("\n")
    );
    // The match lives in the python block (content lines 3-4, 0-based).
    expect(resolveCodeLines(moved, "anno-1", meta)).toEqual({
      start: 2,
      end: 3,
      blockStartLine: 3,
    });
  });

  it("returns null when the anchored line disappeared", () => {
    const gone = docWithMeta(doc.replace("    return x + 1", "    return x + 2"));
    expect(resolveCodeLines(gone, "anno-1", meta)).toBeNull();
  });

  it("returns null for prose-anchored (inline) markers", () => {
    const inline = [
      "被批注的文字[^anno-1]",
      "",
      "[^anno-1]: 批注",
    ].join("\n");
    expect(resolveCodeLines(inline, "anno-1", meta)).toBeNull();
  });

  it("returns null when the marker is missing", () => {
    expect(resolveCodeLines("no markers here", "anno-1", meta)).toBeNull();
  });
});

describe("annotations integration", () => {
  it("sv jump math: blockStartLine + start - 1 lands on the annotated source line", () => {
    // The sv-mode annotation jump combines the block's absolute first content
    // line with the 1-based in-block range to compute an absolute 0-based
    // line. doc's anchored line "    return x + 1" is line 4 (0-based).
    // (docWithMeta drops the meta token when the source definition lacks one,
    // so embed it explicitly for the parseAnnotations round-trip.)
    const md = doc.replace(
      "[^anno-1]: 批注内容",
      `[^anno-1]: ${encodeCodeLineMeta(meta)}批注内容`
    );
    const anno = parseAnnotations(md).find((a) => a.id === "anno-1");
    expect(anno?.codeLine).not.toBeNull();
    const r = resolveCodeLines(md, "anno-1", anno!.codeLine!);
    expect(r).not.toBeNull();
    expect(md.split(/\r?\n/)[r!.blockStartLine + r!.start - 1]).toBe(
      "    return x + 1"
    );
  });

  it("parseAnnotations exposes codeLine and hides the token from content", () => {
    const md = appendAnnotationDefinition(
      "正文\n\n[^anno-1]",
      "anno-1",
      "这条批注指向代码行",
      meta
    );
    const annos = parseAnnotations(md);
    expect(annos).toHaveLength(1);
    expect(annos[0].content).toBe("这条批注指向代码行");
    expect(annos[0].codeLine?.start).toBe(2);
    expect(annos[0].codeLine?.end).toBe(3);
    expect(annos[0].codeLine?.firstLine).toBe("  return x + 1");
  });

  it("updateAnnotationInMd preserves the metadata across edits", () => {
    const md = appendAnnotationDefinition("正文\n\n[^anno-1]", "anno-1", "旧内容", meta);
    const next = updateAnnotationInMd(md, "anno-1", "新内容\n第二行");
    expect(next).not.toContain("旧内容");
    expect(next).toContain(encodeCodeLineMeta(meta));
    const annos = parseAnnotations(next);
    expect(annos[0].content).toBe("新内容\n第二行");
    expect(annos[0].codeLine?.start).toBe(2);
  });

  it("multi-line definitions keep metadata only at the head", () => {
    const md = appendAnnotationDefinition("x\n\n[^anno-2]", "anno-2", "a\nb\nc", meta);
    const annos = parseAnnotations(md);
    expect(annos[0].content).toBe("a\nb\nc");
    expect(annos[0].codeLine).not.toBeNull();
  });
});
