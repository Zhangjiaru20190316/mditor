// 导出链路代码块静态语法高亮（F5 速赢修复）：编辑器内高亮由 CodeMirror
// 动态渲染（tok-* 类），getHTML() 序列化输出只有纯文本 <pre data-language>
// ——导出 HTML/PDF/PNG 三出口的代码块全部单色。CSS 侧色板（global.css 的
// 裸 .hljs-* 规则随 collectThemeCss 进导出文档）从未被命中过：产物里没有
// token span。本模块在导出预处理阶段补静态高亮（rehype-highlight 同款
// highlight.js common 语言集——AI 面板/注解预览与导出的 token 分类同源，
// 色板共用 --tok-* 变量，编辑器/静态渲染/导出三者观感一致）。
//
// 纯函数面（decode/highlightCodeBlocks）可注入 highlighter 单测；
// applyStaticCodeHighlight 动态加载 highlight.js（导出时才进内存，懒加载
// 红线），任何失败降级为原样返回——高亮是增强，不阻断导出。

/** 最小 highlighter 面（highlight.js/lib/common 的结构子集；测试注入 stub）。 */
export interface HljsLike {
  getLanguage(name: string): unknown;
  highlight(
    code: string,
    opts: { language: string; ignoreIllegals: boolean }
  ): { value: string };
}

/** HTML 实体解码（导出序列化器输出的 code 文本 → highlight.js 纯文本入参）。
 *  命名实体（XML 五件套）+ 十进制/十六进制数字实体；解码顺序保证 &amp;lt;
 *  两层转义不被拆穿。无实体时返回原串。 */
export function decodeHtmlEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|nbsp);/g, (m) => (m === "&apos;" ? "'" : "\u00a0"))
    .replace(/&amp;/g, "&");
}

function safeFromCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "\uFFFD";
  }
}

const PRE_CODE_RE = /<pre\b([^>]*)>\s*<code\b([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/g;

/** 从 pre/code 属性串提取高亮语言（pre 的 data-language 优先，静态管线产物
 *  的 code class language-x 兜底）。空/缺失返回 null。 */
export function detectCodeLanguage(preAttrs: string, codeAttrs: string): string | null {
  const m1 = preAttrs.match(/data-language=["']([^"']*)["']/i);
  if (m1 && m1[1].trim()) return m1[1].trim();
  const m2 = codeAttrs.match(/language-([\w#+.-]+)/i);
  return m2 ? m2[1] : null;
}

/**
 * 纯字符串变换：给无 token 的 <pre><code> 块补静态高亮 span。
 * 跳过（原样保留）：code 已带 hljs 类（幂等）、无语言/语言不支持（编辑器
 * 无语言时也无高亮，观感对齐）、code 含子元素（raw HTML 直通块不动）。
 * highlighter 由调用方注入（applyStaticCodeHighlight 用 highlight.js common）。
 */
export function highlightCodeBlocks(html: string, hljs: HljsLike): string {
  if (!html.includes("<pre")) return html;
  return html.replace(PRE_CODE_RE, (whole, preAttrs: string, codeAttrs: string, body: string) => {
    if (/\bclass=["'][^"']*\bhljs/i.test(codeAttrs)) return whole; // 已高亮
    if (/<[a-zA-Z!/]/.test(body)) return whole; // 含子元素：非纯文本 code
    const lang = detectCodeLanguage(preAttrs, codeAttrs);
    if (!lang || !hljs.getLanguage(lang)) return whole;
    const code = decodeHtmlEntities(body);
    try {
      const { value } = hljs.highlight(code, { language: lang, ignoreIllegals: true });
      if (!value) return whole;
      // hljs.value 是转义后的 HTML 片段；code 挂 hljs + language 类（色板/
      // 底色规则命中，与 rehype-highlight 输出结构一致）。pre 属性原样保留。
      return `<pre${preAttrs}><code class="hljs language-${lang}">${value}</code></pre>`;
    } catch {
      return whole; // 个别语言对非法语法抛错：该块降级纯文本
    }
  });
}

/**
 * 导出预处理入口：动态加载 highlight.js（common 集，与 rehype-highlight
 * 默认语言面一致）并补高亮。加载/高亮任何失败 → 原样返回（增强不阻断）。
 */
export async function applyStaticCodeHighlight(html: string): Promise<string> {
  try {
    const mod = (await import("highlight.js/lib/common")) as {
      default: HljsLike;
    };
    const hljs = mod.default ?? (mod as unknown as HljsLike);
    return highlightCodeBlocks(html, hljs);
  } catch {
    return html;
  }
}
