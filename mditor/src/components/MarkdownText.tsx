// Render a Markdown string into a host element as static HTML.
//
// Replaces Vditor.preview for every "static" rendering surface: AI assistant
// message bodies, the annotation popover body, and the annotation list preview.
// Uses the shared remark/rehype pipeline (lib/renderMarkdown) — GFM tables,
// footnotes, ==marks==, math (KaTeX), code (highlight.js) — matching the
// parity the main editor had.
//
// renderMarkdown (and its remark/rehype/katex/highlight.js deps) are imported
// lazily so none of this weight is in the initial bundle; it loads when a
// message/annotation is first rendered.
//
// v3.9 — no blank flash: rendering happens in a LAYOUT effect with a
// synchronous LRU probe first. A cache hit (virtualizer recycling a finished
// reply) paints the final HTML before the browser paints — the old useEffect
// path always committed an empty <div> first and filled it one frame later
// ("回答先空白一拍"). A miss writes a typography-matched plain-text
// placeholder synchronously (same font/line-height as the final render, see
// .md-rendering / .md-ph in global.css) and swaps in the real HTML when the
// async pipeline resolves — the streaming plain-text → rendered-markdown
// transition no longer jumps through an empty state.

import { memo, useLayoutEffect, useRef } from "react";
import { peekRenderedHtml, renderMarkdown } from "../lib/renderMarkdown";
import type { Theme } from "../types";

interface Props {
  content: string;
  theme: Theme;
  /** Extra className for the host element. */
  className?: string;
}

/** Escape text for safe embedding in the placeholder HTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build the stable placeholder shown while the async pipeline runs: plain
 * text in a <p> styled to match the final typography (no blank, no style
 * jump). Oversized inputs are capped — the placeholder only needs to reserve
 * roughly the right height, not mirror a 100KB reply. */
function placeholderHtml(content: string): string {
  const cap = 40_000;
  const text =
    content.length <= cap ? content : content.slice(0, cap) + "\n…（渲染中）";
  return `<p class="md-ph">${escapeHtml(text)}</p>`;
}

/** target=_blank / rel hardening for every link in the rendered output. */
function hardenLinks(el: HTMLElement): void {
  el.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });
}

export const MarkdownText = memo(function MarkdownText({
  content,
  theme,
  className,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    el.setAttribute(
      "data-md-theme",
      theme === "dark" || theme === "claude-dark" ? "dark" : "light"
    );
    if (!content) {
      el.classList.remove("is-rendering");
      el.innerHTML = "";
      return;
    }
    // 1) Synchronous cache hit → final HTML in this layout pass (zero flash).
    const cached = peekRenderedHtml(content);
    if (cached !== undefined) {
      el.classList.remove("is-rendering");
      el.innerHTML = cached;
      hardenLinks(el);
      return;
    }
    // 2) Cache miss → stable typography-matched placeholder NOW, real HTML
    // when the pipeline resolves.
    el.classList.add("is-rendering");
    el.innerHTML = placeholderHtml(content);
    void renderMarkdown(content)
      .then((html) => {
        if (cancelled) return;
        el.classList.remove("is-rendering");
        el.innerHTML = html;
        hardenLinks(el);
      })
      .catch(() => {
        // The pipeline should never throw (KaTeX/highlight swallow their own
        // errors), but malformed raw HTML via rehypeRaw still can. Fall back to
        // escaped plain text (textContent auto-escapes) instead of leaving the
        // message body blank.
        if (cancelled) return;
        el.classList.remove("is-rendering");
        el.textContent = content;
      });
    return () => {
      cancelled = true;
    };
  }, [content, theme]);

  return <div ref={ref} className={`md-rendered${className ? ` ${className}` : ""}`} />;
});
