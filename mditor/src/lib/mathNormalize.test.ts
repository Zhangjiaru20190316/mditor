// normalizeMathDelimiters（v4.6）的行为锚点：LaTeX 风格定界符归一化、代码
// 区段跳过、\$ 还原开关、幂等性。静态管线（renderMarkdown）与编辑器整篇
// 载入（useMilkdown.loadMarkdownFull）共用这一函数，行为漂移会同时影响两条
// 路径，必须在这里先红。
import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters } from "./mathNormalize";

describe("normalizeMathDelimiters", () => {
  it("\\( ... \\) → $...$（内容 trim，避免产生 $ x $）", () => {
    expect(normalizeMathDelimiters("a \\( x^2 \\) b")).toBe("a $x^2$ b");
  });

  it("\\[ ... \\] → $$...$$", () => {
    expect(normalizeMathDelimiters("前\\[E=mc^2\\]后")).toBe("前$$E=mc^2$$后");
  });

  it("围栏代码与行内代码里的 LaTeX 定界符保持字面", () => {
    const md = "```\n\\(x\\) 代码块\n```\n\n行内 `\\(y\\)` 样例";
    expect(normalizeMathDelimiters(md)).toBe(md);
  });

  it("unescapeDollar=false（编辑器载入路径）：\\$ 保持字面", () => {
    expect(normalizeMathDelimiters("价格 \\$5 与 \\$10")).toBe(
      "价格 \\$5 与 \\$10"
    );
  });

  it("unescapeDollar=true（静态渲染路径）：\\$ → $（批注往返转义还原）", () => {
    expect(
      normalizeMathDelimiters("\\$x^2\\$", { unescapeDollar: true })
    ).toBe("$x^2$");
  });

  it("纯美元定界符文档不被改写（探测集只含 LaTeX 风格定界符）", () => {
    expect(normalizeMathDelimiters("$x^2$ 和 $$E=mc^2$$")).toBe(
      "$x^2$ 和 $$E=mc^2$$"
    );
  });

  it("幂等：已归一化文本再跑一遍结果不变", () => {
    const once = normalizeMathDelimiters("a \\( x \\) b \\[ y \\] c");
    expect(normalizeMathDelimiters(once)).toBe(once);
  });

  // ---- v4.10.1 误伤防护（转义字符与 LaTeX 定界符同形）--------------------

  it("防护 1：`a\\[1\\]` 转义方括号（\\[ 前紧邻字母数字）保持字面", () => {
    expect(normalizeMathDelimiters("数组 a\\[1\\] 与 S\\[0\\]")).toBe(
      "数组 a\\[1\\] 与 S\\[0\\]"
    );
  });

  it("防护 1 边界：`\\[` 前是空白/行首/标点仍视为公式", () => {
    // 行首
    expect(normalizeMathDelimiters("\\[E=mc^2\\]")).toBe("$$E=mc^2$$");
    // 空格后
    expect(normalizeMathDelimiters("值 \\[E=mc^2\\]")).toBe("值 $$E=mc^2$$");
    // CJK 后（中文里直接写公式定界符的常见形态）
    expect(normalizeMathDelimiters("前\\[E=mc^2\\]后")).toBe("前$$E=mc^2$$后");
  });

  it("防护 2：`\\[文字\\]\\(链接\\)` 整对转义链接语法保持字面", () => {
    const md = "\\[文字\\]\\(https://example.com\\)";
    expect(normalizeMathDelimiters(md)).toBe(md);
  });

  it("防护 3：`[文字]\\(链接\\)` 未转义方括号变体保持字面", () => {
    const md = "[文字]\\(https://example.com\\)";
    expect(normalizeMathDelimiters(md)).toBe(md);
  });

  it("防护不误伤真公式：`\\(x^2\\)` 前是字母数字仍归一化（括号形态无歧义）", () => {
    expect(normalizeMathDelimiters("a \\(x^2\\) b")).toBe("a $x^2$ b");
  });
});
