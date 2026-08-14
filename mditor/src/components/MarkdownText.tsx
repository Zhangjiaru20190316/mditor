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

import { memo, useEffect, useRef } from "react";
import { renderMarkdown } from "../lib/renderMarkdown";
import type { Theme } from "../types";

interface Props {
  content: string;
  theme: Theme;
  /** Extra className for the host element. */
  className?: string;
}

export const MarkdownText = memo(function MarkdownText({
  content,
  theme,
  className,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    if (!content) {
      el.innerHTML = "";
      return;
    }
    el.setAttribute("data-md-theme", theme === "dark" || theme === "claude-dark" ? "dark" : "light");
    void renderMarkdown(content)
      .then((html) => {
        if (cancelled) return;
        el.innerHTML = html;
        // open <a> externally via the OS browser
        el.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
          a.target = "_blank";
          a.rel = "noopener noreferrer";
        });
      })
      .catch(() => {
        // The pipeline should never throw (KaTeX/highlight swallow their own
        // errors), but malformed raw HTML via rehypeRaw still can. Fall back to
        // escaped plain text (textContent auto-escapes) instead of leaving the
        // message body blank.
        if (cancelled) return;
        el.textContent = content;
      });
    return () => {
      cancelled = true;
    };
  }, [content, theme]);

  return <div ref={ref} className={`md-rendered${className ? ` ${className}` : ""}`} />;
});
