// @vitest-environment jsdom
// renderDegradedMath（EX 轮 Fix-D4）的行为锚点：减配档（大文档性能模式 +
// 超阈值）下 getHTML 输出的 `$`/`$$` 源码文本在导出前补渲染为 KaTeX——
// RC-5 定罪（ex-phase1-rc5：katex 231→0、$ 源码 3→4713）的修复面。
//
// 形态契约对齐（非减配档的真实序列化）：
//   行内 → <span data-type="math_inline" data-value="…"><span class="katex">…
//   块级 → <div class="md-math-block"><span class="katex">…（renderBlockMath 产物）
import { afterEach, describe, expect, it } from "vitest";
import { renderDegradedMath } from "./exportMath";
import { getMathRenderConfig, setMathRenderConfig } from "./mathConfig";

// 编号用例需要 autoNumber（mathNumbering：无 autoNumber 时 label 不进
// labelMap，\ref 不解析——与 renderBlockMath 同语义）。用后还原全局配置。
const savedConfig = getMathRenderConfig();
afterEach(() => setMathRenderConfig(savedConfig));

const p = (s: string) => `<p>${s}</p>`;

describe("renderDegradedMath 行内公式", () => {
  it("$x$ 文本 → math_inline span + katex 标记（data-value 保源码）", () => {
    const r = renderDegradedMath(p("设 $H_n$ 为调和级数"));
    expect(r.html).toContain('data-type="math_inline"');
    expect(r.html).toContain('data-value="H_n"');
    expect(r.html).toContain('class="katex"');
    expect(r.html).not.toContain("$H_n$");
    expect(r.renderedInline).toBe(1);
  });

  it("一段多个行内公式全部渲染", () => {
    const r = renderDegradedMath(p("$a+b$ 与 $c_d$ 与 $e^f$"));
    expect(r.renderedInline).toBe(3);
    expect((r.html.match(/math_inline/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(r.html).not.toMatch(/\$[^$<][^$]*\$/);
  });

  it("代码块/行内代码里的 $ 不渲染（合法字面）", () => {
    const html = p("价格 $5 与 $10") + "<pre><code>$x^2$ 代码里的公式</code></pre>" + p("行内 <code>$y$</code> 代码");
    const r = renderDegradedMath(html);
    expect(r.renderedInline).toBe(0);
    expect(r.html).toContain("$x^2$");
    expect(r.html).toContain("$y$");
    // 「$5 与 $10」两个裸 $ 无法成对（闭 $ 后是数字前有空格——按定界规则不匹配）
    expect(r.html).toContain("$5 与 $10");
  });

  it("转义 \\$ 不当定界符（与 markdown 源语义一致）", () => {
    const r = renderDegradedMath(p("花 \\$100 买 $x$ 本书"));
    expect(r.renderedInline).toBe(1);
    expect(r.html).toContain("\\$100");
  });

  it("开定界后空白 / 闭定界前空白不匹配（micromark-extension-math 单美元规则）", () => {
    const r = renderDegradedMath(p("$ x$ 与 $x $ 不算"));
    expect(r.renderedInline).toBe(0);
    expect(r.html).toContain("$ x$");
  });

  it("内容跨软换行的行内公式照常渲染（remark-math 允许段内换行；fixture 实证形态）", () => {
    const r = renderDegradedMath(p("部分和 $\\sum_{n=1}^{N}\na_n$ 发散"));
    expect(r.renderedInline).toBe(1);
    expect(r.html).toContain('class="katex"');
    expect(r.html).not.toContain("$\\sum");
  });

  it("跨行但闭定界前是空白 → 字面（guard trim 规则）", () => {
    const r = renderDegradedMath(p("$a\n $ 不算"));
    expect(r.renderedInline).toBe(0);
    expect(r.html).toContain("$a");
  });

  it("闭 $ 后紧跟数字 → 价格区间形态降级回字面（remarkMathGuard 同规）", () => {
    const r = renderDegradedMath(p("范围 $1-$10 之间"));
    expect(r.renderedInline).toBe(0);
    expect(r.html).toContain("$1-$10");
  });

  it("公式源码被 <em>/<strong> 撕碎（公式内 * 被 commonmark 吃成强调）→ 逻辑串拼平后照常渲染", () => {
    const html = p("合并通项为 $\\dfrac{1-\\mathbf{1}<em>{3\\mid n}}{n}$（$\\mathbf{1}</em>{3\\mid n}$ 发散");
    const r = renderDegradedMath(html);
    expect(r.renderedInline).toBe(2);
    expect((r.html.match(/data-type="math_inline"/g) ?? []).length).toBe(2);
    expect(r.html).toContain('class="katex"');
    expect(r.html).not.toContain("$\\dfrac");
  });

  it("公式不跨 code 屏障（code 两侧的 $ 不配对）", () => {
    const html = p("左 $a<code>x*y</code>b$ 右");
    const r = renderDegradedMath(html);
    expect(r.renderedInline).toBe(0);
    expect(r.html).toContain("<code>x*y</code>");
  });

  it("已渲染的 katex 子树不重复处理（幂等输入）", () => {
    const once = renderDegradedMath(p("设 $H_n$"));
    const twice = renderDegradedMath(once.html);
    expect(twice.renderedInline).toBe(0);
    expect((twice.html.match(/data-type="math_inline"/g) ?? []).length).toBe(1);
  });

  it("渲染失败（非法 latex）→ 红色 katex-error 展示源码（与编辑器同语义，不丢字）", () => {
    const r = renderDegradedMath(p("坏式 $\\frac{$"));
    expect(r.html).toContain("katex-error");
    expect(r.html).toContain("\\frac{"); // 源码在错误标记里可见
  });
});

describe("renderDegradedMath 块级公式（$$…$$）", () => {
  it("整段 $$ 公式 → 替换 <p> 为 div.md-math-block（renderBlockMath 同形）", () => {
    const r = renderDegradedMath(p("$$\\sum_{n=1}^{\\infty} \\frac{1}{n^2}$$"));
    expect(r.html).toContain('<div class="md-math-block">');
    expect(r.html).toContain('class="katex"');
    expect(r.html).not.toContain("<p>");
    expect(r.renderedBlock).toBe(1);
  });

  it("段落内嵌 $$ 片段 → 不破坏 <p> 结构（span 级 md-math-block 渲染）", () => {
    const r = renderDegradedMath(p("前置文字 $$x^2$$ 后置文字"));
    expect(r.html).toContain("<p>");
    expect(r.html).toContain('class="katex"');
    expect(r.html).toContain('class="md-math-block"'); // span 级包装
    expect(r.renderedBlock).toBe(1);
    // 不残留 $$ 定界
    expect(r.html).not.toContain("$$");
  });

  it("表格单元格内公式照常渲染", () => {
    const html = '<table><tbody><tr><td><p>求 $f^{(n)}(x_0)$</p></td></tr></tbody></table>';
    const r = renderDegradedMath(html);
    expect(r.renderedInline).toBe(1);
    expect(r.html).toContain('data-value="f^{(n)}(x_0)"');
  });

  it("\\label 自动编号与正文 \\ref 解析（与 renderBlockMath 同管线）", () => {
    setMathRenderConfig({ ...savedConfig, autoNumber: true });
    const html = p("见 \\ref{eq:a}") + p("$$x = y \\label{eq:a}$$");
    const r = renderDegradedMath(html);
    expect(r.html).not.toContain("\\ref{eq:a}");
    expect(r.html).toContain("见 1");
    expect(r.html).toContain("md-math-block");
  });
});

describe("renderDegradedMath 边界", () => {
  it("无 $ 文档原样返回（同一字符串引用）", () => {
    const html = p("普通文本");
    const r = renderDegradedMath(html);
    expect(r.html).toBe(html);
    expect(r.renderedInline + r.renderedBlock).toBe(0);
  });

  it("裸单 $ 不成对时不渲染不丢字", () => {
    const r = renderDegradedMath(p("单价 $ 5 美元"));
    expect(r.html).toContain("$ 5 美元");
  });
});
