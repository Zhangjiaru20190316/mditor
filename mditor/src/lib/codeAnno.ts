// Code line-level annotation anchoring (代码行级批注).
//
// When an annotation is anchored on a selection INSIDE a fenced code block,
// the marker paragraph still sits after the block (code_block can't hold an
// inline footnote_reference), but the annotation additionally records WHICH
// lines it points at:
//
//   1. at capture time the editor derives {start, end, firstLine} — the
//      1-based line range within the block plus the text of the first
//      anchored line;
//   2. that metadata is persisted INSIDE the footnote definition as a leading
//      HTML comment:  [^anno-3]: <!--md:line 2-3 dGVtcA==-->批注内容
//      parseAnnotations strips it before display, updateAnnotationInMd
//      preserves it across body edits, and a round-trip that drops the
//      comment merely degrades the annotation back to block-level;
//   3. on open, `resolveCodeLines` re-locates the lines in the CURRENT
//      document — matching the stored first-line text at (or nearest to) the
//      recorded position first, so edits above the block shift the anchor
//      correctly and edits INSIDE the block follow the content, not the line
//      numbers;
//   4. `highlightCodeLines` paints the resolved lines inside the rendered
//      block (CodeMirror `.cm-line` elements; whole-`<pre>` fallback) and
//      returns the first highlighted line so the popover can sit beside it.

/** Persisted line anchor of a code annotation. */
export interface CodeLineMeta {
  /** 1-based first anchored line within the code block. */
  start: number;
  /** 1-based last anchored line (inclusive). */
  end: number;
  /** Original text of the first anchored line — the content fingerprint the
   *  anchor follows when the code is edited. */
  firstLine: string;
}

/** Class applied to highlighted CodeMirror lines / plain <pre> blocks. */
export const CODE_LINE_HL_CLASS = "anno-code-line-hl";

/* -------------------------------------------------------------------------- */
/* Metadata encode / decode                                                    */
/* -------------------------------------------------------------------------- */

/** UTF-8 → base64 without the deprecated `unescape` (HTML comments cannot
 *  contain `--`, and base64 never does). */
function utf8ToB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToUtf8(s: string): string {
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Cap the stored first-line fingerprint — it exists to re-find the line, not
 *  to mirror the whole code block. */
const MAX_FIRST_LINE = 200;

/** Render the `<!--md:line …-->` metadata token (no trailing space). */
export function encodeCodeLineMeta(meta: CodeLineMeta): string {
  const fingerprint = meta.firstLine.slice(0, MAX_FIRST_LINE);
  return `<!--md:line ${meta.start}-${meta.end} ${utf8ToB64(fingerprint)}-->`;
}

const META_RE = /^<!--md:line (\d+)-(\d+) ([A-Za-z0-9+/=]+)-->/;

/** Split a leading metadata token off an annotation body. Returns the clean
 *  body plus the decoded metadata, or null when the body carries none. */
export function stripCodeLineMeta(content: string): { content: string; meta: CodeLineMeta | null } {
  const m = META_RE.exec(content);
  if (!m) return { content, meta: null };
  let firstLine: string;
  try {
    firstLine = b64ToUtf8(m[3]);
  } catch {
    firstLine = "";
  }
  return {
    content: content.slice(m[0].length),
    meta: { start: parseInt(m[1], 10), end: parseInt(m[2], 10), firstLine },
  };
}

/** Replace (or attach) the metadata token on an annotation body, keeping the
 *  visible content intact. `meta: null` strips any existing token. */
export function withCodeLineMeta(content: string, meta: CodeLineMeta | null): string {
  const { content: clean } = stripCodeLineMeta(content);
  return meta ? `${encodeCodeLineMeta(meta)}${clean}` : clean;
}

/* -------------------------------------------------------------------------- */
/* Re-resolution against the current document                                  */
/* -------------------------------------------------------------------------- */

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/** Colapsed-whitespace comparison — code indentation changes shouldn't break
 *  the anchor. */
function sameLine(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

interface CodeBlock {
  /** Content lines between the fences. */
  lines: string[];
  /** Index (into the document's line array) of the first content line. */
  startLine: number;
}

/** Find the fenced code block whose CLOSE fence is the last non-blank line
 *  above `markerLine` (the line carrying the block-anchored marker). Returns
 *  null when no fence closes above it. */
function blockAbove(lines: string[], markerLine: number): CodeBlock | null {
  let i = markerLine - 1;
  while (i >= 0 && lines[i].trim() === "") i--;
  if (i < 0) return null;
  const closeM = FENCE_RE.exec(lines[i]);
  if (!closeM) return null;
  const ch = closeM[1][0];
  const openRe = new RegExp("^\\s{0,3}" + ch + "{3,}");
  let j = i - 1;
  while (j >= 0 && !openRe.test(lines[j])) j--;
  if (j < 0) return null;
  return { lines: lines.slice(j + 1, i), startLine: j + 1 };
}

/** All fenced code blocks in the document (for the block-moved fallback). */
function allCodeBlocks(lines: string[]): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const openM = FENCE_RE.exec(lines[i]);
    if (!openM) {
      i++;
      continue;
    }
    const ch = openM[1][0];
    const closeRe = new RegExp("^\\s{0,3}" + ch + "{3,}");
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j])) j++;
    if (j >= lines.length) break; // unclosed fence — stop scanning
    blocks.push({ lines: lines.slice(i + 1, j), startLine: i + 1 });
    i = j + 1;
  }
  return blocks;
}

export interface ResolvedCodeLines {
  /** 1-based line range INSIDE the code block. */
  start: number;
  end: number;
  /** 0-based line index (into the document's line array) of the block's first
   *  content line — sv-mode jumps combine it with start/end to compute the
   *  absolute source line of the annotated code. */
  blockStartLine: number;
}

/**
 * Re-locate a code annotation's line range in the CURRENT markdown.
 *
 * Strategy (most-to-least trusted):
 *   1. the block directly above the marker, with the stored first line still
 *      at its recorded position → exact;
 *   2. the same block, first line moved → follow the content (nearest
 *      occurrence to the recorded line);
 *   3. another block in the document containing the first line → the block
 *      moved (nearest to the marker wins);
 *   4. give up (null) → the caller falls back to block-level anchoring.
 */
export function resolveCodeLines(
  md: string,
  annoId: string,
  meta: CodeLineMeta
): ResolvedCodeLines | null {
  if (!md) return null;
  const lines = md.split(/\r?\n/);
  // Locate the marker's INLINE reference (not the definition).
  const refRe = new RegExp(`\\[\\^${escapeRe(annoId)}\\](?!:)`, "g");
  const ref = refRe.exec(md);
  if (!ref) return null;
  const markerLine = md.slice(0, ref.index).split(/\r?\n/).length - 1;
  const lineStart = md.lastIndexOf("\n", ref.index - 1) + 1;
  const beforeRef = md.slice(lineStart, ref.index).trim();
  // Only block-anchored markers (nothing before the ref on its line) point at
  // the code block above them; a prose-anchored marker is not code-line based.
  if (beforeRef !== "") return null;

  const want = meta.firstLine.trim();
  if (!want) return null;
  const count = Math.max(1, meta.end - meta.start + 1);

  // 1+2) The block above the marker.
  const block = blockAbove(lines, markerLine);
  if (block) {
    const at = meta.start - 1;
    if (at >= 0 && at < block.lines.length && sameLine(block.lines[at], want)) {
      return { start: meta.start, end: meta.start + count - 1, blockStartLine: block.startLine };
    }
    // Follow the content: nearest occurrence to the recorded line.
    let best = -1;
    let bestDist = Infinity;
    for (let k = 0; k < block.lines.length; k++) {
      if (!sameLine(block.lines[k], want)) continue;
      const dist = Math.abs(k - at);
      if (dist < bestDist) {
        bestDist = dist;
        best = k;
      }
    }
    if (best >= 0) return { start: best + 1, end: best + count, blockStartLine: block.startLine };
  }

  // 3) The line moved to another block — pick the match closest to the marker.
  let bestBlock: CodeBlock | null = null;
  let bestLine = -1;
  let bestDist = Infinity;
  for (const b of allCodeBlocks(lines)) {
    for (let k = 0; k < b.lines.length; k++) {
      if (!sameLine(b.lines[k], want)) continue;
      const dist = Math.abs(b.startLine + k - markerLine);
      if (dist < bestDist) {
        bestDist = dist;
        bestBlock = b;
        bestLine = k;
      }
    }
  }
  if (bestBlock && bestLine >= 0) {
    return { start: bestLine + 1, end: bestLine + count, blockStartLine: bestBlock.startLine };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* DOM highlighting                                                            */
/* -------------------------------------------------------------------------- */

/** Walk up from an element inside the ProseMirror content to its top-level
 *  block (direct child of .ProseMirror). */
function topLevelBlock(el: Element): Element | null {
  let cur: Element | null = el;
  while (cur?.parentElement) {
    if (cur.parentElement.classList.contains("ProseMirror")) return cur;
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Highlight lines [start..end] (1-based) of the code block the given marker
 * element is anchored after, and scroll the first highlighted line into view.
 * Returns the first highlighted line element (for popover positioning), or
 * null when the block can't be resolved (caller falls back to the marker).
 */
export function highlightCodeLines(
  markerEl: HTMLElement,
  start: number,
  end: number
): HTMLElement | null {
  try {
    const top = topLevelBlock(markerEl);
    if (!top) return null;
    const prev = top.previousElementSibling;
    if (!prev) return null;

    // CodeMirror-rendered block: one .cm-line child per source line.
    const cmLines = prev.querySelectorAll<HTMLElement>(".cm-content > .cm-line");
    if (cmLines.length > 0) {
      const from = Math.max(1, start);
      const to = Math.min(cmLines.length, Math.max(from, end));
      let first: HTMLElement | null = null;
      for (let i = from; i <= to; i++) {
        const el = cmLines[i - 1];
        el.classList.add(CODE_LINE_HL_CLASS);
        if (!first) first = el;
      }
      first?.scrollIntoView({ behavior: "auto", block: "center" });
      return first;
    }

    // Plain <pre><code> block (big-doc mode): highlight the whole block.
    if (prev.tagName === "PRE") {
      prev.classList.add(CODE_LINE_HL_CLASS);
      prev.scrollIntoView({ behavior: "auto", block: "center" });
      return prev as HTMLElement;
    }
    return null;
  } catch {
    return null;
  }
}

/** Remove every code-line highlight currently painted in the document. */
export function clearCodeLineHighlights(): void {
  try {
    document
      .querySelectorAll<HTMLElement>(`.${CODE_LINE_HL_CLASS}`)
      .forEach((el) => el.classList.remove(CODE_LINE_HL_CLASS));
  } catch {
    /* teardown races — never throw */
  }
}

/** Escape a literal string for safe embedding inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
