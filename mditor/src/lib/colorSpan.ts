// Shared atoms for the inline `<span style="color:…">` convention that stores
// text color in Markdown (Typora-style). Two independent consumers must agree
// on what a color declaration is — the remark round-trip (remarkTextColor.ts)
// and the source-mode textarea helpers (useMilkdown.ts) — so the regexes and
// readers live here instead of being re-derived per consumer (the duplicates
// had already started to drift apart).

/** Matches a `color:` declaration inside an inline style string. */
export const STYLE_COLOR_RE = /(?:^|;)\s*color\s*:\s*([^;]+)/i;

/** Matches a `color:` declaration for in-place rewrite (no anchors, so it can
 *  replace the declaration wherever it sits in the style string). */
export const COLOR_DECL_RE = /color\s*:\s*[^;]+/i;

/** Extracts a `style="…"` / `style='…'` value from a tag attribute string. */
export const STYLE_ATTR_RE = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/** Read the `color:` value from an inline style string, or null. */
export function colorFromStyle(style: string): string | null {
  const m = STYLE_COLOR_RE.exec(style);
  return m ? m[1].trim() : null;
}
