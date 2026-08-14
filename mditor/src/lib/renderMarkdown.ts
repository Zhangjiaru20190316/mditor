// Render Markdown -> HTML string (GFM tables, math via KaTeX, code via
// highlight.js, raw HTML passthrough). Replaces Vditor.preview for every
// "static" rendering surface: the AI message bodies, annotation popover/list
// previews, and source-mode HTML export.
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
import rehypeStringify from "rehype-stringify";
import { remarkMark } from "./remarkMark";

// Many LLMs emit LaTeX-style math delimiters \( ... \) (inline) and \[ ... \]
// (display) instead of the $ ... $ / $$ ... $$ that remark-math understands.
// remark-math only parses dollar delimiters, so the LaTeX form renders as
// literal text — the classic "AI formula doesn't render" symptom. Convert them
// to dollar delimiters BEFORE the pipeline runs. Fenced and inline code are
// skipped so samples that *demonstrate* LaTeX syntax stay literal.
function normalizeMathDelimiters(md: string): string {
  // One left-to-right pass: match fenced code, inline code, or a math pair.
  // Only the math pairs are rewritten; code is returned untouched. The body is
  // trimmed so "$ x $" (a space right after the opening $, which remark-math
  // rejects) is never produced from something like "\( x \)".
  return md.replace(
    /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g,
    (match, blockBody: string | undefined, inlineBody: string | undefined) => {
      if (blockBody !== undefined) return `$$${blockBody.trim()}$$`;
      if (inlineBody !== undefined) return `$${inlineBody.trim()}$`;
      return match; // fenced/inline code — keep as-is
    },
  );
}

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
const htmlCache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const v = htmlCache.get(key);
  if (v !== undefined) {
    // Bump to most-recently-used (re-insert at the tail).
    htmlCache.delete(key);
    htmlCache.set(key, v);
  }
  return v;
}

function cacheSet(key: string, html: string): void {
  if (htmlCache.has(key)) htmlCache.delete(key);
  htmlCache.set(key, html);
  while (htmlCache.size > HTML_CACHE_MAX) {
    const oldest = htmlCache.keys().next().value;
    if (oldest === undefined) break;
    htmlCache.delete(oldest);
  }
}

/** Render a markdown string to an HTML fragment (no <html>/<body> wrapper).
 *  Results are memoized in a small LRU so repeated renders of the same content
 *  (e.g. AI rows recycled by virtual scrolling) skip the unified pipeline. */
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

/** Drop the render cache (used when memory-guard rebuilds the editor, so stale
 *  renders never outlive a recovery). Public for the guard; cheap to call. */
export function invalidateRenderCache(): void {
  htmlCache.clear();
}
