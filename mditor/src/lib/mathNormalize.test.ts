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
});
