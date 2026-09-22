// renderMarkdown 净化管线的行为验证 —— 该管线的输出会直接写入 innerHTML
// （MarkdownText：AI 回复与批注预览），这里锁定「危险内容被剥离、自有语法
// 扩展被保留」两类关键行为，防止 sanitize schema 后续被无意收紧/放宽。
// 另含渲染结果 LRU 缓存字节上限（T6）的行为验证。
import { describe, expect, it } from "vitest";
import {
  HTML_CACHE_MAX_BYTES,
  __getHtmlCacheStatsForTests,
  __setHtmlCacheByteCapForTests,
  renderMarkdown,
} from "./renderMarkdown";
import {
  DEFAULT_MATH_CONFIG,
  setMathRenderConfig,
} from "./mathConfig";

describe("renderMarkdown sanitize", () => {
  it("strips <script> blocks", async () => {
    const html = await renderMarkdown('hi <script>alert(1)</script> there');
    expect(html).not.toContain("<script");
    expect(html).toContain("hi");
  });

  it("strips event-handler attributes from raw html", async () => {
    const html = await renderMarkdown('<img src="https://x/a.png" onerror="alert(1)">');
    expect(html).not.toContain("onerror");
    // src 本身（安全协议）保留
    expect(html).toContain("https://x/a.png");
  });

  it("strips javascript: link protocols", async () => {
    const html = await renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("keeps ==highlight== as <mark>", async () => {
    const html = await renderMarkdown("a ==b== c");
    expect(html).toContain("<mark>");
  });

  it("keeps inline color spans (sv-mode syntax)", async () => {
    const html = await renderMarkdown('<span style="color:red">t</span>');
    expect(html).toContain("color:red");
  });

  it("prunes non-color declarations from inline styles (v3.9.1)", async () => {
    // rehype-sanitize 放行的 style 属性不做值级过滤；管线在 sanitize 之后
    // 把 span/mark 的内联 style 裁剪为仅 color / background-color。
    const html = await renderMarkdown(
      '<span style="color:red;position:fixed;inset:0">t</span>'
    );
    expect(html).toContain("color:red");
    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("inset");
    // mark 上的危险声明同样被裁剪，安全声明保留。
    const html2 = await renderMarkdown(
      '<mark style="background-color:yellow;transform:translate(0)">t</mark>'
    );
    expect(html2).toContain("background-color:yellow");
    expect(html2).not.toContain("transform");
  });

  it("keeps math classes for KaTeX", async () => {
    const html = await renderMarkdown("$x^2$");
    expect(html).toContain("katex");
  });

  it("still renders GFM tables", async () => {
    const html = await renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<table");
  });
});

describe("renderMarkdown math（v4.6）", () => {
  // 每个用例改配置后恢复默认（renderMarkdown 的 processor/LRU 缓存键含配
  // 置签名，恢复默认即回到主配置的键空间，用例间不串扰）。
  function withMathConfig(patch: Partial<typeof DEFAULT_MATH_CONFIG>, fn: () => Promise<void>) {
    return (async () => {
      setMathRenderConfig({ ...DEFAULT_MATH_CONFIG, ...patch });
      try {
        await fn();
      } finally {
        setMathRenderConfig(DEFAULT_MATH_CONFIG);
      }
    })();
  }

  it("LaTeX 风格定界符 \\( ... \\) 归一化后渲染（AI 回复经典症状）", async () => {
    const html = await renderMarkdown("公式 \\(x^2\\) 完成");
    expect(html).toContain("katex");
  });

  it("```math 围栏 → 展示公式（GitHub 风格）", async () => {
    const html = await renderMarkdown("```math\nE=mc^2\n```");
    expect(html).toContain("katex");
  });

  it("```latex 围栏保持代码块（代码示例语义）", async () => {
    const html = await renderMarkdown("```latex\n\\frac{a}{b}\n```");
    expect(html).toContain("<code");
    expect(html).not.toContain("katex");
  });

  it("\\label 剥除（KaTeX 不认），\\eqref 默认保持字面（autoNumber 关）", async () => {
    const html = await renderMarkdown(
      "$$\nE=mc^2 \\label{eq:e}\n$$\n\n见 \\eqref{eq:e}。"
    );
    expect(html).toContain("katex");
    expect(html).not.toContain("label");
    expect(html).toContain("\\eqref{eq:e}");
  });

  it("autoNumber：注入编号 + \\eqref 解析为 (n)", async () => {
    await withMathConfig({ autoNumber: true }, async () => {
      const html = await renderMarkdown(
        "$$\na=b \\label{eq:a}\n$$\n\n$$\nc=d \\notag\n$$\n\n见 \\eqref{eq:a}。"
      );
      // v4.17.1 katex overrides 归一为 0.18.4 后：编号元素类名前缀化为
      // "katex-tag"（0.16 时代的裸 "tag" 不再出现），且 rehype-katex 与直接
      // 调 katex.renderToString 输出一致（单实例，差异注释不再成立）；
      // MathML 里同步有 (1)。
      expect(html).toContain('class="katex-tag"');
      expect(html).toContain("<mtext>(1)</mtext>");
      expect(html).toContain("见 (1)。");
    });
  });

  it("自定义宏生效（mathMacros → rehype-katex macros）", async () => {
    await withMathConfig(
      { macros: { "\\RR": "\\mathbb{R}" } },
      async () => {
        const html = await renderMarkdown("$\\RR$");
        // KaTeX 用 KaTeX_AMS 字体渲染 mathbb（不输出 Unicode ℝ），锚定
        // mathbb 类名 + MathML mathvariant。
        expect(html).toContain("mathbb");
        expect(html).toContain("double-struck");
      }
    );
  });
});

describe("renderMarkdown LRU byte cap", () => {
  it("defaults to an 8 MiB byte cap alongside the 64-entry count cap", () => {
    // 导出的生产默认值：8 MiB（条数上限 64 之外的第二道限制）。
    expect(HTML_CACHE_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it("evicts oldest entries until the byte total is back under the cap", async () => {
    // 每条 ≈ 830 字节（md ~404 + html ~420），两条 ~1660 < 2000，三条 ~2490
    // 超限 → 插入第三条后最旧的 a 被淘汰，总量回到 ~1660。
    const big = (tag: string) => `# ${tag}\n\n${"word ".repeat(80)}`;
    const mdA = big("a");
    const mdB = big("b");
    const mdC = big("c");
    const restore = __setHtmlCacheByteCapForTests(2000);
    try {
      await renderMarkdown(mdA);
      await renderMarkdown(mdB);
      await renderMarkdown(mdC);
      const stats = __getHtmlCacheStatsForTests();
      // v4.6：缓存键 = 配置签名 + \u0000 + 归一化 md（同一份内容在不同
      // 数学配置下不吃旧渲染），断言用后缀匹配。
      expect(stats.bytes).toBeLessThanOrEqual(2000);
      expect(stats.keys.some((k) => k.endsWith(mdA))).toBe(false); // 最旧者被逐条淘汰
      expect(stats.keys.some((k) => k.endsWith(mdB))).toBe(true);
      expect(stats.keys.some((k) => k.endsWith(mdC))).toBe(true); // 最新者保留
      // 淘汰只影响缓存，不影响渲染正确性：同内容再渲染结果不变。
      expect(await renderMarkdown(mdA)).toContain("word");
    } finally {
      restore();
    }
  });

  it("self-evicts a single entry that alone exceeds the cap (render result unaffected)", async () => {
    const restore = __setHtmlCacheByteCapForTests(100);
    try {
      const md = `big\n\n${"x".repeat(400)}`; // md+html 远超 100
      const html = await renderMarkdown(md);
      expect(html).toContain("big"); // 结果正常返回
      const stats = __getHtmlCacheStatsForTests();
      expect(stats.size).toBe(0); // 只是不入缓存
      expect(stats.bytes).toBe(0);
    } finally {
      restore();
    }
  });
});
