// exportMath.renderBlockMath（v4.6）的行为锚点：编辑器导出 HTML 里的块级
// 公式 <pre data-language="LaTeX"> 再渲染为 KaTeX、\label 剥除、自动编号与
// \ref 解析、代码区段跳过。纯字符串实现，node 环境直跑（katex 渲染不依赖
// DOM）。rasterizeFormulas / inlineKatexFonts 依赖 DOM/fetch，由人工导出验
// 证覆盖，不在单测范围。
import { afterEach, describe, expect, it } from "vitest";
import { renderBlockMath } from "./exportMath";
import {
  DEFAULT_MATH_CONFIG,
  setMathRenderConfig,
  type MathRenderConfig,
} from "./mathConfig";

let prevConfig: MathRenderConfig = DEFAULT_MATH_CONFIG;

function withConfig(cfg: Partial<MathRenderConfig>, fn: () => void): void {
  prevConfig = { ...DEFAULT_MATH_CONFIG };
  setMathRenderConfig({ ...prevConfig, ...cfg });
  try {
    fn();
  } finally {
    setMathRenderConfig(prevConfig);
  }
}

afterEach(() => {
  setMathRenderConfig(DEFAULT_MATH_CONFIG);
});

describe("renderBlockMath", () => {
  it("块级公式 <pre> → KaTeX HTML，原始源码标记消失", () => {
    const html = '<p>前文</p><pre data-language="LaTeX"><code>E=mc^2</code></pre><p>后文</p>';
    const r = renderBlockMath(html);
    expect(r.hasMath).toBe(true);
    expect(r.html).toContain("md-math-block");
    expect(r.html).toContain("katex");
    expect(r.html).not.toContain("data-language");
    expect(r.html).toContain("前文");
  });

  it("lang 大小写不敏感（用户手写 ```latex 围栏的序列化形态）", () => {
    const r = renderBlockMath('<pre data-language="latex"><code>a=b</code></pre>');
    expect(r.html).toContain("katex");
  });

  it("其他语言的代码块原样保留", () => {
    const html = '<pre data-language="js"><code>const x = 1;</code></pre>';
    const r = renderBlockMath(html);
    expect(r.html).toBe(html);
    expect(r.hasMath).toBe(false);
  });

  it("无公式文档原样返回", () => {
    const html = "<p>plain</p>";
    expect(renderBlockMath(html)).toEqual({ html, hasMath: false });
  });

  it("\\label 被剥除（KaTeX 不认，留着报红）", () => {
    const r = renderBlockMath(
      '<pre data-language="LaTeX"><code>E=mc^2 \\label{eq:e}</code></pre>'
    );
    expect(r.html).toContain("katex");
    expect(r.html).not.toContain("label");
  });

  it("autoNumber：自动编号注入 + 正文 \\eqref 解析", () => {
    withConfig({ autoNumber: true }, () => {
      const r = renderBlockMath(
        '<p>见 \\eqref{eq:e}。</p><pre data-language="LaTeX"><code>E=mc^2 \\label{eq:e}</code></pre>'
      );
      expect(r.html).toContain("katex-tag");
      expect(r.html).toContain("见 (1)。");
    });
  });

  it("\\ref 解析跳过代码区段（演示样例保持字面）", () => {
    withConfig({ autoNumber: true }, () => {
      const r = renderBlockMath(
        '<pre data-language="LaTeX"><code>a=b \\label{eq:a}</code></pre>' +
          "<p>公式 \\ref{eq:a}；样例 <code>\\ref{eq:a}</code> 不动。</p>"
      );
      expect(r.html).toContain("公式 1；");
      expect(r.html).toContain("<code>\\ref{eq:a}</code>");
    });
  });

  it("HTML 实体解码后再渲染（ProseMirror 文本序列化为 &amp;lt; 形态）", () => {
    // latex 源码 "a < b" 被 PM 序列化为 "a &lt; b"；解码后交给 KaTeX。
    const r = renderBlockMath(
      '<pre data-language="LaTeX"><code>a &lt; b</code></pre>'
    );
    expect(r.html).toContain("katex");
    // 解码只做一次：源码里的字面 "&amp;"（作者想显示 & 符号）不会被二次
    // 展开成裸 & 再破坏 latex 解析。
    const r2 = renderBlockMath(
      '<pre data-language="LaTeX"><code>a &amp;amp; b</code></pre>'
    );
    expect(r2.html).toContain("katex");
  });
});
