// Annotation helpers — parse / build / edit footnote-style annotations.
//
// Annotations are persisted as plain Markdown footnotes whose id carries an
// `anno-` prefix, so they survive Vditor's wysiwyg→markdown round-trip
// (VditorDOM2Md strips custom HTML, but footnotes are native markdown). The
// prefix lets us tell annotations apart from ordinary footnotes the user may
// also have in the same document.
//
// On disk a document with one annotation looks like:
//
//   这是被批注的文字[^anno-1]，继续正文。
//
//   [^anno-1]: 这是批注的具体内容，可由 AI 生成或手写。
//
// Vditor renders `[^anno-1]` as a small superscript (the visible marker). The
// definition block is hidden in the editor (see annotation.css + the
// `data-anno` tagging in useAnnotationMarkers) and shown in a popover on click.

import { stripCodeLineMeta, withCodeLineMeta, type CodeLineMeta } from "./codeAnno";

/** A single annotation parsed from a markdown document. */
export interface Annotation {
  /** Marker id without the `[^...]` brackets, e.g. `anno-1`. */
  id: string;
  /** Numeric suffix, e.g. `1` for `anno-1`. */
  marker: number;
  /** Body text of the annotation (trimmed, may span multiple lines). */
  content: string;
  /** Code line-level anchor, when the annotation targets lines inside a code
   *  block (see lib/codeAnno.ts). Null for ordinary prose annotations. */
  codeLine?: CodeLineMeta | null;
}

/** Prefix that distinguishes annotations from ordinary footnotes. */
export const ANNO_PREFIX = "anno-";

/** `[^anno-7]` reference token, inserted inline next to the annotated text. */
export function refToken(id: string): string {
  return `[^${id}]`;
}

/** Build the footnote definition block `[^anno-7]: text` (continuation lines
 *  are indented so Lute keeps them inside the same definition). When the
 *  annotation is code-line anchored, a `<!--md:line …-->` metadata token is
 *  prepended (see lib/codeAnno.ts). */
export function buildDefinition(id: string, content: string, codeLine?: CodeLineMeta | null): string {
  const indented = withCodeLineMeta(content, codeLine ?? null).replace(/\r?\n/g, "\n    ");
  return `[^${id}]: ${indented}`;
}

/** Regex for a single annotation definition line: `[^anno-N]: ...`. */
const ANNO_DEF_RE = /^\[\^anno-(\d+)\]:[ \t]*(.*)$/;

/**
 * Parse every `[^anno-N]: ...` definition out of a markdown document.
 * Multi-line definitions (continuation lines indented with whitespace) are
 * joined. If the same id is defined more than once the first wins, mirroring
 * how Lute resolves duplicate footnote ids.
 */
export function parseAnnotations(md: string): Annotation[] {
  if (!md) return [];
  const lines = md.split(/\r?\n/);
  const byId = new Map<string, Annotation>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ANNO_DEF_RE);
    if (!m) continue;
    const marker = parseInt(m[1], 10);
    const id = `${ANNO_PREFIX}${marker}`;
    if (byId.has(id)) continue; // first definition wins
    const bodyLines = [m[2]];
    let j = i + 1;
    while (j < lines.length && isContinuationLine(lines[j])) {
      bodyLines.push(lines[j].replace(/^[ \t]+/, ""));
      j++;
    }
    const { content, meta } = stripCodeLineMeta(bodyLines.join("\n").trim());
    byId.set(id, { id, marker, content, codeLine: meta });
  }
  return Array.from(byId.values()).sort((a, b) => a.marker - b.marker);
}

/** Return the next free annotation number (max existing + 1, or 1 if none). */
export function nextAnnotationId(md: string): number {
  const annos = parseAnnotations(md);
  if (annos.length === 0) return 1;
  return annos.reduce((mx, a) => (a.marker > mx ? a.marker : mx), 0) + 1;
}

/**
 * Return a short snippet of the text an annotation's marker is attached to.
 *
 * The marker `[^id]` is inserted inline right after the annotated prose, so we
 * locate the first inline reference (NOT the `[^id]:` definition — excluded by
 * the negative lookahead) and take the text immediately before it. Other
 * footnote refs and a couple of inline Markdown markers are stripped so the
 * result reads cleanly as a list header ("批注挂在哪段文字上"). Returns "" if
 * the marker isn't found inline (e.g. only the definition exists).
 */
export function getAnchorSnippet(md: string, id: string, maxBefore = 40): string {
  const refRe = new RegExp(`\\[\\^${escapeRegExp(id)}\\](?!:)`, "g");
  const m = refRe.exec(md);
  if (!m) return "";
  const idx = m.index;
  // A marker that sits alone on its line (no prose before it on that line)
  // anchors a block — typically a code / math block, whose annotation marker is
  // dropped on its own line right after the block. Surface that block's first
  // content line so the sidebar shows what the annotation is attached to,
  // instead of falling through to the prose tail (which would either yield ""
  // or strip the code's backticks into a confusing snippet).
  const lineStart = md.lastIndexOf("\n", idx - 1) + 1;
  const beforeOnLine = md
    .slice(lineStart, idx)
    .replace(/\[\^[^\]]*\]/g, "")
    .trim();
  if (beforeOnLine === "") {
    const block = blockAnchorSnippet(md, idx, maxBefore);
    if (block) return block;
  }
  const start = Math.max(0, idx - maxBefore);
  let snippet = md.slice(start, idx);
  snippet = snippet
    .replace(/\[\^[^\]]*\]/g, "") // other inline footnote refs
    .replace(/\*\*|__/g, "") // bold markers
    .replace(/[`]/g, "") // inline code markers
    .replace(/\s+/g, " ")
    .trim();
  if (!snippet) return "";
  return (start > 0 ? "…" : "") + snippet;
}

/**
 * 0-based source line of the first INLINE `[^id]` reference. Null when the
 * marker isn't referenced inline. sv-mode annotation jumps use this to scroll
 * the source editor to the marker.
 *
 * Line-scanned rather than a raw regex-over-the-whole-document so it can't be
 * fooled by look-alike tokens the renderer never treats as markers:
 *   * `[^id]` inside a fenced code block (documents ABOUT footnotes);
 *   * `[^id]` inside an annotation definition body (批注内容里引用另一条批注)
 *     — the `[^…]:` line and its continuation lines are skipped.
 */
export function findAnnotationRefLine(md: string, id: string): number | null {
  if (!md) return null;
  const lines = md.split(/\r?\n/);
  const refRe = new RegExp(`\\[\\^${escapeRegExp(id)}\\](?!:)`);
  let inFence = false;
  let fenceMarker = "";
  let inDef = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Fences: same 0-3 space tolerance as buildOutline; marker char must match.
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1].charAt(0);
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    // Annotation definition blocks own their whole body — a ref written there
    // is prose about the annotation, not the inline marker.
    if (ANNO_DEF_RE.test(line)) {
      inDef = true;
      continue;
    }
    if (inDef) {
      if (isContinuationLine(line)) continue;
      inDef = false; // flush prose line ends the body — test it below
    }
    if (refRe.test(line)) return i;
  }
  return null;
}

/** Snippet for a block-anchored annotation marker — one whose marker sits on
 *  its own line directly after a fenced code block or a display-math block.
 *  Returns the block's first non-empty content line prefixed 代码：/公式：
 *  (capped to `max` chars), or "" when no recognised block sits above the
 *  marker. */
function blockAnchorSnippet(md: string, markerIdx: number, max: number): string {
  const lines = md.split(/\r?\n/);
  const markerLine = md.slice(0, markerIdx).split(/\r?\n/).length - 1;
  // First non-blank line above the marker line.
  let i = markerLine - 1;
  while (i >= 0 && lines[i].trim() === "") i--;
  if (i < 0) return "";
  const line = lines[i];
  // Fenced code block close (``` or ~~~): walk up to its opening fence and
  // take the first content line between them.
  const fenceM = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
  if (fenceM) {
    const ch = fenceM[1][0]; // "`" or "~" — neither is a regex metacharacter
    const openRe = new RegExp("^\\s{0,3}" + ch + "{3,}");
    let j = i - 1;
    while (j >= 0 && !openRe.test(lines[j])) j--;
    for (let k = j + 1; k < i; k++) {
      const t = lines[k].trim();
      if (t) return cap(`代码：${t}`, max);
    }
    return "代码块";
  }
  // Display-math block close ($$): walk up to its opening $$.
  if (/^\s{0,3}\$\$\s*$/.test(line)) {
    let j = i - 1;
    while (j >= 0 && !/^\s{0,3}\$\$/.test(lines[j])) j--;
    for (let k = j + 1; k < i; k++) {
      const t = lines[k].trim();
      if (t) return cap(`公式：${t}`, max);
    }
    return "公式";
  }
  return "";
}

/** Cap a snippet to `max` chars, appending an ellipsis when truncated. */
function cap(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/** Append a new annotation definition to the document, returning the new text.
 *  The definition is added at the end (footnote definitions may live anywhere
 *  in the document; Lute gathers them on render). */
export function appendAnnotationDefinition(
  md: string,
  id: string,
  content: string,
  codeLine?: CodeLineMeta | null
): string {
  const def = buildDefinition(id, content, codeLine);
  const trimmed = md.replace(/\s+$/, "");
  if (trimmed === "") return def;
  return trimmed + "\n\n" + def;
}

/** Escape a literal string for safe embedding inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if `line` belongs to the body of a footnote definition (i.e. is a
 * continuation of the `[^id]: ...` line above it).
 *
 * Lute's VditorDOM2Md serialisation fills every blank line inside / between
 * footnote definitions with 4 spaces (not a real blank line) and normalises
 * continuation indentation to 7 spaces. So the rules are:
 *   * blank / whitespace-only line  → continuation (preserves paragraph breaks
 *                                     inside the body; trimmed at the edges)
 *   * next `[^...]:` definition      → NOT a continuation (ends this body)
 *   * any other non-blank line       → continuation iff it's indented; a
 *                                     flush line is正文/prose and ends the body
 *
 * Without the blank-line allowance, any annotation whose body spans multiple
 * paragraphs would be truncated at the first blank line.
 */
function isContinuationLine(line: string): boolean {
  if (/^[ \t]*$/.test(line)) return true; // blank or whitespace-only
  if (/^\[\^[^\]]+\]:/.test(line)) return false; // next footnote definition
  return /^[ \t]/.test(line); // indented → continuation; flush → end
}

/**
 * Remove an annotation entirely: deletes its definition block (the `[^id]:`
 * line plus any indented continuation lines) and strips every inline
 * `[^id]` reference. Returns the new markdown.
 */
export function removeAnnotationFromMd(md: string, id: string): string {
  const defRe = new RegExp(`^\\[\\^${escapeRegExp(id)}\\]:`);
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (defRe.test(lines[i])) {
      // Skip the definition line and all of its continuation lines (including
      // the whitespace-only blank lines Lute sprinkles between paragraphs /
      // definitions — see isContinuationLine).
      i++;
      while (i < lines.length && isContinuationLine(lines[i])) i++;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  // Strip every inline reference [^id] (there may be several). A line that
  // contained ONLY the reference (a block-anchored marker paragraph, e.g. the
  // `[^anno-N]` dropped on its own line under a code block) would otherwise
  // become a stray blank line — drop it so deleting such an annotation leaves no
  // residue. Intentional blank paragraph separators (which hold no ref) are
  // preserved, so normal spacing between paragraphs is unaffected.
  const refTokenStr = `[^${id}]`;
  const refRe = new RegExp(`\\[\\^${escapeRegExp(id)}\\]`, "g");
  const cleaned: string[] = [];
  for (const ln of out) {
    if (ln.indexOf(refTokenStr) < 0) {
      cleaned.push(ln);
      continue;
    }
    const stripped = ln.replace(refRe, "");
    if (stripped.trim() === "") continue; // marker-only line → drop the paragraph
    cleaned.push(stripped);
  }
  return cleaned.join("\n");
}

/**
 * Replace the body of an existing annotation definition, preserving its id,
 * position AND any code-line metadata token (see lib/codeAnno.ts) so editing
 * an annotation doesn't demote a code-line anchor back to block level.
 * Continuation lines of the old definition are dropped and the new content's
 * newlines are re-indented to stay inside the definition.
 */
export function updateAnnotationInMd(
  md: string,
  id: string,
  newContent: string
): string {
  const defRe = new RegExp(`^(\\[\\^${escapeRegExp(id)}\\]:)[ \\t]*(.*)$`);
  const defLine = md.split(/\r?\n/).find((ln) => defRe.test(ln)) ?? "";
  const defMatch = defLine.match(defRe);
  // The metadata token lives at the head of the old body (def line).
  const oldMeta = defMatch ? stripCodeLineMeta(defMatch[2]).meta : null;
  const indented = withCodeLineMeta(newContent, oldMeta).replace(/\r?\n/g, "\n    ");
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  let replaced = false;
  while (i < lines.length) {
    const m = lines[i].match(defRe);
    if (m && !replaced) {
      out.push(`${m[1]} ${indented}`);
      i++;
      // Drop all old continuation lines (incl. whitespace-only blanks).
      while (i < lines.length && isContinuationLine(lines[i])) i++;
      replaced = true;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
}
