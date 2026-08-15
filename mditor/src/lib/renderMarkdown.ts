// Render Markdown -> HTML string (GFM tables, math via KaTeX, code via
// highlight.js, raw HTML passthrough, sanitized). Replaces Vditor.preview for
// every "static" rendering surface: the AI message bodies, annotation popover/
// list previews, and source-mode HTML export.
//
// SECURITY: the output is written to innerHTML (MarkdownText) and AI replies /
// annotations are EXTERNAL content, so the pipeline sanitizes all raw HTML with
// rehype-sanitize — CSP is a second line of defense, not the only one. The
// schema extends the GitHub-style default with our own syntax extensions
// (<mark>, color spans) and keeps the math classes rehype-katex consumes.
// KaTeX / highlight.js output is generated AFTER the sanitize step, so their
// markup is never stripped.
//
// The unified pipeline is built once and reused; the remark/rehype/katex/
// highlight.js modules are all imported at the top of this module, which is in
// turn imported lazily by its callers (MarkdownText, AiPanel) — so none of this
// weight lands in the initial page bundle until a message/annotation/export is
// actually rendered. Parity targets Vditor.preview's old options: gfmAutoLink,
// footnotes, mark, math.inlineDigit, hljs.

import { unified } from "unified";
import type { Plugin } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { remarkMark } from "./remarkMark";

// Many LLMs emit LaTeX-style math delimiters \( ... \) (inline) and \[ ... \]
// (display) instead of the $ ... $ / $$ ... $$ that remark-math understands.
// remark-math only parses dollar delimiters, so the LaTeX form renders as
// literal text — the classic "AI formula doesn't render" symptom. Convert them
// to dollar delimiters BEFORE the pipeline runs. Fenced and inline code are
// skipped so samples that *demonstrate* LaTeX syntax stay literal.
//
// The same symptom hits AI annotations for a different reason: their content
// round-trips through Milkdown (setValue → getMarkdown), and Milkdown's `text`
// handler escapes every `$` to `\$` (remark-math lists `$` as unsafe in phrasing
// context). When that escaped text reaches us, remark-math sees `\$x^2\$` — a
// sequence of escaped dollars, not math delimiters — and renders it literally.
// We unescape `\$` → `$` here (code is still skipped) so the round-tripped
// annotation body is re-recognised as math. Plain-text `\$` (a literal dollar
// intended by the author) is rare in AI replies / annotations and should be
// wrapped in inline code if it must display verbatim.
function normalizeMathDelimiters(md: string): string {
  // One left-to-right pass: match fenced code, inline code, a math pair, or an
  // escaped dollar. Only the math pairs / escaped dollars are rewritten; code
  // is returned untouched. The body is trimmed so "$ x $" (a space right after
  // the opening $, which remark-math rejects) is never produced from something
  // like "\( x \)".
  return md.replace(
    /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\\\$/g,
    (match, blockBody: string | undefined, inlineBody: string | undefined) => {
      if (blockBody !== undefined) return `$$${blockBody.trim()}$$`;
      if (inlineBody !== undefined) return `$${inlineBody.trim()}$`;
      if (match === "\\$") return "$";
      return match; // fenced/inline code — keep as-is
    },
  );
}

// Sanitize schema: the GitHub-style defaultSchema already covers tables, task
// lists, code fences (incl. the `language-math math-inline/math-display` classes
// rehype-katex consumes) and safe img/a protocols. On top of that we allow:
//   * <mark> — ==highlight== syntax (remarkMark → remark-rehype handler above)
//   * className + style on span/mark/code — sv-mode color spans written as raw
//     `<span style="color:…">` keep rendering; KaTeX/highlight add their own
//     classes AFTER sanitize and are unaffected.
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark"],
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), "className", "style"],
    mark: [...(defaultSchema.attributes?.mark ?? []), "className", "style"],
  },
};

// Build the configured pipeline once; the variable's type is inferred from the
// builder so the per-plugin type narrowing (Root/Root/string) is preserved.
function makeProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm) // tables, strikethrough, task lists, autolinks
    .use(remarkMark as unknown as Plugin) // ==highlight== -> mdast `mark` (rendered as <mark> below)
    .use(remarkMath) // $...$ / $$...$$ -> mdast math nodes
    .use(remarkRehype, {
      allowDangerousHtml: true, // keep raw html nodes
      // Map the `mark` mdast node (produced by remarkMark) to a <mark> element
      // so highlights render in AI replies / annotation previews / exports.
      handlers: {
        mark: (state: unknown, node: { children?: unknown[] }) => ({
          type: "element",
          tagName: "mark",
          properties: {},
          children: (state as { all: (n: unknown) => unknown[] }).all(node),
        }),
      } as never,
    })
    .use(rehypeRaw) // turn raw html into real hast before transforms below
    .use(rehypeSanitize, sanitizeSchema) // strip scripts/event handlers/style vectors from raw html
    .use(rehypeKatex) // math -> katex html (needs katex.css + fonts at runtime)
    .use(rehypeHighlight, {
      detect: true, // highlight even without an explicit language class
      ignoreMissing: true, // unknown language -> leave untouched, don't throw
    })
    .use(lazyImagesPlugin) // defer off-screen image decode/load (T0)
    .use(rehypeStringify);
}

// Rehype plugin: stamp loading="lazy" decoding="async" on every <img> so long
// AI replies / annotation previews that contain many images don't all decode at
// once. Runs after rehype-raw so raw-HTML <img> are real hast elements too.
// Idempotent: only sets the property when absent (respects explicit values).
function lazyImagesPlugin() {
  return (tree: HastNode) => stampLazyImages(tree);
}

interface HastNode {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function stampLazyImages(node: HastNode | undefined): void {
  if (!node) return;
  if (node.type === "element" && node.tagName === "img") {
    const props = node.properties || (node.properties = {});
    if (!("loading" in props)) props.loading = "lazy";
    if (!("decoding" in props)) props.decoding = "async";
  }
  const kids = node?.children;
  if (kids) for (const c of kids) stampLazyImages(c);
}

let processor: ReturnType<typeof makeProcessor> | null = null;

function getProcessor(): ReturnType<typeof makeProcessor> {
  if (!processor) processor = makeProcessor();
  return processor;
}

// ---- render-result LRU cache (T1) ---------------------------------------
// Each finished assistant reply holds the SAME content once it stops streaming,
// yet MarkdownText re-runs the whole unified pipeline whenever its component
// re-mounts (switching the AI tab away and back, or a virtual list recycling the
// row). Caching content->html turns those remounts into a cheap innerHTML write.
// Insertion-ordered Map => oldest entry is the first key (LRU eviction).
const HTML_CACHE_MAX = 64;
/** 第二道上限（T6）：缓存总字节（条目的 md 键 + html 值长度之和，UTF-16 码元
 *  估算）。仅按条数（64）限流时，几十个大文档回复可常驻几十 MB —— 超过字节
 *  上限时从最旧逐条淘汰直到回到限内（单条超限的巨型内容会被立即自我淘汰，
 *  渲染结果仍正常返回，只是不入缓存）。导出供测试断言。 */
export const HTML_CACHE_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB
const htmlCache = new Map<string, string>();
let htmlCacheBytes = 0;
// 生产路径恒为 HTML_CACHE_MAX_BYTES；仅测试钩子可临时覆盖（见下方 test hooks）。
let htmlCacheByteCap = HTML_CACHE_MAX_BYTES;

function cacheGet(key: string): string | undefined {
  const v = htmlCache.get(key);
  if (v !== undefined) {
    // Bump to most-recently-used (re-insert at the tail). Byte total unchanged.
    htmlCache.delete(key);
    htmlCache.set(key, v);
  }
  return v;
}

function cacheSet(key: string, html: string): void {
  const prev = htmlCache.get(key);
  if (prev !== undefined) {
    htmlCacheBytes -= key.length + prev.length;
    htmlCache.delete(key);
  }
  htmlCache.set(key, html);
  htmlCacheBytes += key.length + html.length;
  // 超过条数或字节上限时，从最旧（Map 头部）逐条淘汰直到回到限内。
  while (htmlCache.size > HTML_CACHE_MAX || htmlCacheBytes > htmlCacheByteCap) {
    const oldest = htmlCache.keys().next().value;
    if (oldest === undefined) break;
    const v = htmlCache.get(oldest);
    htmlCache.delete(oldest);
    if (v !== undefined) htmlCacheBytes -= oldest.length + v.length;
  }
}

// ---- test hooks（T6）------------------------------------------------------
// 仅供 renderMarkdown.test.ts 验证字节淘汰逻辑；生产代码不得调用，默认上限
// 不受影响。两个钩子都会清空缓存，保证字节计数与条目一致。

/** 临时覆盖 LRU 字节上限并清空缓存；返回恢复默认（并再次清空）的函数。 */
export function __setHtmlCacheByteCapForTests(cap: number): () => void {
  htmlCacheByteCap = cap;
  htmlCache.clear();
  htmlCacheBytes = 0;
  return () => {
    htmlCacheByteCap = HTML_CACHE_MAX_BYTES;
    htmlCache.clear();
    htmlCacheBytes = 0;
  };
}

/** 读取缓存当前状态：条数、总字节（md+html 长度估算）、按插入序的键列表。 */
export function __getHtmlCacheStatsForTests(): {
  size: number;
  bytes: number;
  keys: string[];
} {
  return { size: htmlCache.size, bytes: htmlCacheBytes, keys: [...htmlCache.keys()] };
}

/** Render a markdown string to an HTML fragment (no <html>/<body> wrapper).
 *  Raw HTML in the input is sanitized (see sanitizeSchema) — the result is safe
 *  to write into innerHTML. Results are memoized in a small LRU so repeated
 *  renders of the same content (e.g. AI rows recycled by virtual scrolling)
 *  skip the unified pipeline. */
export async function renderMarkdown(md: string): Promise<string> {
  if (!md) return "";
  md = normalizeMathDelimiters(md);
  const cached = cacheGet(md);
  if (cached !== undefined) return cached;
  const file = await getProcessor().process(md);
  const html = String(file);
  cacheSet(md, html);
  return html;
}
