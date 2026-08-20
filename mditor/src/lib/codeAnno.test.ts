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
  buildDefinition,
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

  it("withCodeLineMeta attaches at the END of the first line (Milkdown-safe)", () => {
    // 前缀形态（`<!--…-->正文`）的定义会被 Milkdown 解析器整个丢弃（孤儿徽章），
    // 令牌必须写在首行文字之后。
    expect(withCodeLineMeta("正文", meta)).toBe(`正文 ${encodeCodeLineMeta(meta)}`);
    expect(withCodeLineMeta("第一行\n第二行", meta)).toBe(
      `第一行 ${encodeCodeLineMeta(meta)}\n第二行`
    );
  });

  it("withCodeLineMeta never emits the parser-dropping forms for blank-leading bodies (v3.9.2)", () => {
    // 流式中间态可能以前导空行开头：令牌挂到第一条非空行尾，绝不回到
    // 前缀形态（该形态的定义被 Milkdown 解析丢弃 → 整篇回退 → 定义消失
    // → 再回退，即每帧全文档重写的「徽章闪/无编号 + 代码块闪」循环）。
    expect(withCodeLineMeta("\n\n正文", meta)).toBe(
      `\n\n正文 ${encodeCodeLineMeta(meta)}`
    );
    expect(withCodeLineMeta(" \n  \n正文\n次行", meta)).toBe(
      ` \n  \n正文 ${encodeCodeLineMeta(meta)}\n次行`
    );
    // 整条体全空：宁可丢令牌（下一非空帧补写），也不产出会被解析丢弃的
    // 裸令牌定义。
    expect(withCodeLineMeta("", meta)).toBe("");
    expect(withCodeLineMeta(" \n \n", meta)).toBe(" \n \n");
    // 定义级输出（buildDefinition 视角）：任何续行要么空白要么 ≥4 空格缩进，
    // 且 `[^id]: ` 后的第一个字符绝不能是 `<!--`。
    for (const body of ["\n\n正文", "", " \n正文\n"]) {
      const def = buildDefinition("anno-9", body, meta);
      expect(def.startsWith("[^anno-9]: <!--")).toBe(false);
      for (const ln of def.split("\n").slice(1)) {
        expect(ln === "" || /^[ \t]{4}/.test(ln) || /^[ \t]*$/.test(ln)).toBe(true);
      }
    }
  });

  it("withCodeLineMeta replaces legacy prefix tokens and strips", () => {
    const n: CodeLineMeta = { start: 1, end: 1, firstLine: "n" };
    expect(withCodeLineMeta(`${encodeCodeLineMeta(meta)}旧`, n)).toBe(
      `旧 ${encodeCodeLineMeta(n)}`
    );
    expect(withCodeLineMeta(`旧 ${encodeCodeLineMeta(meta)}`, n)).toBe(
      `旧 ${encodeCodeLineMeta(n)}`
    );
    expect(withCodeLineMeta(`正文 ${encodeCodeLineMeta(meta)}`, null)).toBe("正文");
    expect(withCodeLineMeta(`${encodeCodeLineMeta(meta)}旧`, null)).toBe("旧");
  });

  it("stripCodeLineMeta reads both token positions", () => {
    const { content, meta: m1 } = stripCodeLineMeta(
      `批注正文 ${encodeCodeLineMeta(meta)}`
    );
    expect(content).toBe("批注正文");
    expect(m1).toEqual(meta);
    const legacy = stripCodeLineMeta(`${encodeCodeLineMeta(meta)}批注正文`);
    expect(legacy.content).toBe("批注正文");
    expect(legacy.meta).toEqual(meta);
    const multi = stripCodeLineMeta(`首行 ${encodeCodeLineMeta(meta)}\n次行`);
    expect(multi.content).toBe("首行\n次行");
    expect(multi.meta).toEqual(meta);
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
      blockIndex: 0,
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
      blockIndex: 0,
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
      blockIndex: 0,
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
      blockIndex: 0,
    });
  });

  it("resolves through stacked marker-only lines (2nd annotation on the same block, v3.9.3)", () => {
    // 同一代码块的第二条批注：其标记行上方是第一条批注的标记行而不是
    // fence。v3.9.2 及之前 blockAbove 在标记行就放弃（返回 null），只有
    // 策略 3 全文兜底；策略 1/2 从未生效——多标记堆叠文档的高亮/跳转
    // 由此长期错位。标记行现在对块锚定「透明」。
    const stackedParas = docWithMeta(
      [
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
        "[^anno-2]",
        "",
        "[^anno-1]: 批注一",
        "[^anno-2]: 批注二",
      ].join("\n")
    );
    // anno-2 的标记行上方是 anno-1 的标记行——必须穿透找到 python 块。
    expect(
      resolveCodeLines(stackedParas, "anno-2", {
        start: 2,
        end: 3,
        firstLine: "  return x + 1",
      })
    ).toEqual({
      start: 2,
      end: 3,
      blockStartLine: 3,
      blockIndex: 0,
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

  it("tolerates sibling markers stacked on the same line (sv inserts)", () => {
    // sv 模式在同一代码块上加第二条批注会把标记挤到同一行：
    //   [^anno-2][^anno-1]   或   [^anno-3] [^anno-1]
    // 两条都必须仍按“块级锚定”解析到上方代码块。
    const stacked = [
      "# 标题",
      "",
      "```python",
      "def f(x):",
      "    return x + 1",
      "    # note",
      "```",
      "",
      "[^anno-2][^anno-1]",
      "",
      "[^anno-1]: 批注一",
      "[^anno-2]: 批注二",
    ].join("\n");
    const r1 = resolveCodeLines(stacked, "anno-1", meta);
    expect(r1).not.toBeNull();
    expect(r1!.start).toBe(2);
    const spaced = stacked.replace("[^anno-2][^anno-1]", "[^anno-3] [^anno-1]");
    expect(resolveCodeLines(spaced, "anno-1", meta)).not.toBeNull();
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
