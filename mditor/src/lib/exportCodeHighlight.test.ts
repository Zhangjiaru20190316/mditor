// F5 回归锚定：导出三出口的代码块必须带静态语法高亮 token。定罪形态 =
// editor.getHTML() 序列化输出 <pre data-language="ts"><code>纯文本</code></pre>
// （编辑器内 CodeMirror 动态高亮不进序列化）——CSS 色板再全也无元素可命中，
// 导出 HTML/PDF/PNG 的代码块全部单色（perf/results/rv-final/cmp-render/ 实测
// 代码区 0 彩色像素）。

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  applyStaticCodeHighlight,
  decodeHtmlEntities,
  detectCodeLanguage,
  highlightCodeBlocks,
  type HljsLike,
} from "./exportCodeHighlight";
import { EXPORT_HLJS_CSS, EXPORT_PROSE_CSS } from "./exportProseCss";

/** 可控 stub：记录调用、按表返回高亮 HTML。 */
function stubHljs(langs: string[], out = '<span class="hljs-keyword">k</span>'): HljsLike & {
  calls: Array<{ code: string; language: string }>;
} {
  const calls: Array<{ code: string; language: string }> = [];
  return {
    calls,
    getLanguage: (name) => langs.includes(name),
    highlight: (code, opts) => {
      calls.push({ code, language: opts.language });
      return { value: out };
    },
  };
}

describe("decodeHtmlEntities（导出 code 文本 → highlight.js 入参）", () => {
  it("命名实体与数字实体全量解码，&amp; 最后拆保证两层转义不被拆穿", () => {
    expect(decodeHtmlEntities("&lt;a&gt;")).toBe("<a>");
    expect(decodeHtmlEntities("&quot;x&quot;")).toBe('"x"');
    expect(decodeHtmlEntities("a &amp;lt; b")).toBe("a &lt; b");
    expect(decodeHtmlEntities("&#40;&#41;")).toBe("()");
    expect(decodeHtmlEntities("&#x41;")).toBe("A");
    expect(decodeHtmlEntities("&#x110000;")).toBe("\uFFFD"); // 越界码点兜底
  });
  it("无实体原样返回（快路径）", () => {
    expect(decodeHtmlEntities("const x = 1;")).toBe("const x = 1;");
  });
});

describe("detectCodeLanguage", () => {
  it("pre 的 data-language 优先，code 的 language-x class 兜底", () => {
    expect(detectCodeLanguage(' data-language="ts"', "")).toBe("ts");
    expect(detectCodeLanguage("", ' class="hljs language-python"')).toBe("python");
    expect(detectCodeLanguage(' data-language=""', ' class="language-c++"')).toBe("c++");
  });
  it("两处都缺失/空白 → null", () => {
    expect(detectCodeLanguage("", "")).toBeNull();
    expect(detectCodeLanguage(' data-language="  "', "")).toBeNull();
  });
});

describe("highlightCodeBlocks（纯字符串变换）", () => {
  const TS_BLOCK = '<pre data-language="ts"><code>const x: number = 1 &lt;&amp; 2;</code></pre>';

  it("有语言且支持 → code 换装 hljs span，入参是解码后的纯文本", () => {
    const hljs = stubHljs(["ts"]);
    const out = highlightCodeBlocks(TS_BLOCK, hljs);
    expect(hljs.calls).toEqual([{ code: "const x: number = 1 <& 2;", language: "ts" }]);
    expect(out).toBe(
      '<pre data-language="ts"><code class="hljs language-ts">' +
        '<span class="hljs-keyword">k</span></code></pre>'
    );
    expect(out).not.toContain("&lt;&amp;");
  });

  it("code 已带 hljs 类 → 幂等跳过（静态管线产物/重复调用）", () => {
    const hljs = stubHljs(["ts"]);
    const already =
      '<pre><code class="hljs language-ts"><span class="hljs-keyword">k</span></code></pre>';
    expect(highlightCodeBlocks(already, hljs)).toBe(already);
    expect(hljs.calls).toHaveLength(0);
  });

  it("无语言 / 语言不支持 → 原样（编辑器无语言也无高亮，观感对齐）", () => {
    const hljs = stubHljs([]);
    const noLang = "<pre><code>plain text</code></pre>";
    expect(highlightCodeBlocks(noLang, hljs)).toBe(noLang);
    expect(highlightCodeBlocks(TS_BLOCK, hljs)).toBe(TS_BLOCK);
    expect(hljs.calls).toHaveLength(0);
  });

  it("code 含子元素（raw HTML 直通）→ 不动", () => {
    const hljs = stubHljs(["ts"]);
    const nested = '<pre data-language="ts"><code>x<span class="x">y</span></code></pre>';
    expect(highlightCodeBlocks(nested, hljs)).toBe(nested);
  });

  it("highlighter 抛错 → 该块降级原样，其余块不受影响", () => {
    const bad: HljsLike = {
      getLanguage: () => true,
      highlight: () => {
        throw new Error("illegal");
      },
    };
    const py = '<pre data-language="python"><code>pass</code></pre>';
    const out = highlightCodeBlocks(`${TS_BLOCK}${py}`, bad);
    expect(out).toBe(`${TS_BLOCK}${py}`);
  });

  it("文档无 pre → 原样返回（快路径）", () => {
    expect(highlightCodeBlocks("<p>hello</p>", stubHljs(["ts"]))).toBe("<p>hello</p>");
  });
});

describe("applyStaticCodeHighlight（真 highlight.js common 集）", () => {
  it("ts 代码块产出 hljs-keyword token span（导出链冒烟）", async () => {
    const html =
      '<pre data-language="ts"><code>// note\nexport function f(n: number) {\n  return n &lt;= 1 ? n : f(n - 1);\n}\n</code></pre>';
    const out = await applyStaticCodeHighlight(html);
    expect(out).toContain('class="hljs language-ts"');
    expect(out).toContain("hljs-keyword");
    expect(out).toContain("hljs-comment");
    // 实体保持转义（产物是 HTML）
    expect(out).toContain("&lt;=");
  });

  it("不支持的语言（mermaid 等）→ 原样", async () => {
    const html = '<pre data-language="mermaid"><code>graph TD;</code></pre>';
    expect(await applyStaticCodeHighlight(html)).toBe(html);
  });
});

describe("EXPORT_HLJS_CSS（色板与编辑器静态渲染同源）", () => {
  it("token 分组类名与 global.css 静态渲染段一致，色值带浅色兜底", () => {
    for (const sel of [
      ".vditor-reset .hljs-keyword",
      ".vditor-reset .hljs-string",
      ".vditor-reset .hljs-number",
      ".vditor-reset .hljs-comment",
      ".vditor-reset .hljs-title.function_",
      ".vditor-reset .hljs-built_in",
      ".vditor-reset .hljs-attribute",
      ".vditor-reset .hljs-tag",
    ]) {
      expect(EXPORT_HLJS_CSS).toContain(sel);
    }
    expect(EXPORT_HLJS_CSS).toContain("var(--tok-keyword, #0000ff)");
    expect(EXPORT_HLJS_CSS).toContain("var(--tok-base, #1f2328)");
  });

  it("汇入 EXPORT_PROSE_CSS（三出口同源注入的单一挂点）", () => {
    expect(EXPORT_PROSE_CSS).toContain(EXPORT_HLJS_CSS);
  });
});
