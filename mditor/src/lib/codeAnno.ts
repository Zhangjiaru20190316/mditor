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

import { noteScrollWrite } from "./scrollDebug";

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

/** Selector matching a rendered annotation marker badge (sup). Shared by the
 * popover, the stamp hook and the highlight restore below so the three can
 * never drift apart. */
export const ANNO_MARKER_SELECTOR =
  'sup[data-type="footnote_reference"][data-label^="anno-"]';

/** The code-line highlight currently "on loan" to the popover. ProseMirror
 *  re-renders a code block's node view on any transaction touching it, wiping
 *  the classes painted directly on .cm-line DOM — while the popover is open we
 *  remember the anchor and re-apply after such rebuilds (see
 *  restoreCodeLineHighlights, called from the stamp pass). */
let activeHighlight: {
  annoId: string;
  start: number;
  end: number;
  blockIndex?: number;
} | null = null;

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
const META_TOKEN_RE = /^<!--md:line (\d+)-(\d+) ([A-Za-z0-9+/=]+)-->$/;
const META_END_RE = /<!--md:line \d+-\d+ [A-Za-z0-9+/=]+-->$/;

/** Decode a full `<!--md:line …-->` token into CodeLineMeta (null on malformed). */
function decodeMetaToken(token: string): CodeLineMeta | null {
  const m = META_TOKEN_RE.exec(token);
  if (!m) return null;
  let firstLine = "";
  try {
    firstLine = b64ToUtf8(m[3]);
  } catch {
    /* bad base64 → empty fingerprint, anchor degrades to block-level */
  }
  return { start: parseInt(m[1], 10), end: parseInt(m[2], 10), firstLine };
}

/**
 * Split the metadata token off an annotation body. Returns the clean body plus
 * the decoded metadata, or null when the body carries none.
 *
 * Two token positions are recognised:
 *   * legacy: at the very start of the body (`<!--…-->内容`). Milkdown's
 *     markdown parser silently DROPS a footnote definition whose body begins
 *     with the raw-HTML token, orphaning the marker badge — new writes moved
 *     the token behind the first line's text (see withCodeLineMeta). Old
 *     documents on disk still carry the prefix form, so it stays readable.
 *   * current: at the end of the first body line (`内容 <!--…-->`).
 */
export function stripCodeLineMeta(content: string): { content: string; meta: CodeLineMeta | null } {
  const startM = META_RE.exec(content);
  if (startM) {
    const meta = decodeMetaToken(startM[0]);
    if (meta) return { content: content.slice(startM[0].length), meta };
    return { content, meta: null };
  }
  const nl = content.indexOf("\n");
  const firstLine = (nl < 0 ? content : content.slice(0, nl)).replace(/[ \t]+$/, "");
  const rest = nl < 0 ? "" : content.slice(nl);
  const endM = META_END_RE.exec(firstLine);
  if (endM) {
    const meta = decodeMetaToken(endM[0]);
    if (meta) return { content: firstLine.slice(0, endM.index).trimEnd() + rest, meta };
  }
  return { content, meta: null };
}

/** Replace (or attach) the metadata token on an annotation body, keeping the
 *  visible content intact. `meta: null` strips any existing token.
 *
 *  The token is written at the END of the first body line: a body that STARTS
 *  with the raw-HTML token gets its footnote definition silently dropped by
 *  Milkdown's parser on the next full-document round-trip (verified against the
 *  real crepe parser — `[^id]: <!--…-->内容` vanishes, `[^id]: 内容 <!--…-->`
 *  survives), which used to orphan every code-line annotation the moment it was
 *  created. 流式中间态的首行可能是空的（AI 回复以前导换行开头）——v3.9.2
 *  起这类体把 token 挂到第一条非空行尾，绝不回到前缀形态（该形态会触发
 *  「解析失败 → 整篇回退 → 定义被解析丢弃 → 再整篇回退」的每帧全文档
 *  重写循环，即「徽章闪/无编号 + 代码块闪」）。整条体全空时放弃 token
 *  （空定义保持存在，元数据由下一非空帧重新写回）。 */
export function withCodeLineMeta(content: string, meta: CodeLineMeta | null): string {
  const { content: clean } = stripCodeLineMeta(content);
  if (!meta) return clean;
  const token = encodeCodeLineMeta(meta);
  const nl = clean.indexOf("\n");
  const first = (nl < 0 ? clean : clean.slice(0, nl)).trimEnd();
  const rest = nl < 0 ? "" : clean.slice(nl);
  if (first) return `${first} ${token}${rest}`;
  const lines = clean.split("\n");
  const idx = lines.findIndex((l) => l.trim() !== "");
  if (idx < 0) return clean;
  lines[idx] = `${lines[idx].trimEnd()} ${token}`;
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Re-resolution against the current document                                  */
/* -------------------------------------------------------------------------- */

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/** 一行只有批注标记（可多个，sv 连续批注形态）——块锚定启发式里这类行
 *  是「透明」的：同一代码块的第二条及之后的批注，其标记行上方是别的
 *  标记行而不是 fence，不跳过就找不到代码块（v3.9.3 侧栏跳转错位根源
 *  之一）。 */
const MARKER_ONLY_LINE_RE = /^\s*(?:\[\^anno-\d+\]\s*)+$/;

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

/** Find the fenced code block whose CLOSE fence is the last fence/code line
 *  above `markerLine` (the line carrying the block-anchored marker). Blank
 *  lines and OTHER marker-only lines are skipped transparently — stacked
 *  markers (`[^anno-1]` line above `[^anno-2]` line above the fence) all
 *  anchor the same block. Returns null when no fence closes above it. */
function blockAbove(lines: string[], markerLine: number): CodeBlock | null {
  let i = markerLine - 1;
  while (
    i >= 0 &&
    (lines[i].trim() === "" || MARKER_ONLY_LINE_RE.test(lines[i]))
  )
    i--;
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
  /** 0-based index of the resolved block among ALL fenced code blocks in the
   *  document. The DOM side (highlightCodeLines) uses it to locate the SAME
   *  block when the block-above-marker heuristic doesn't apply (strategy 3
   *  re-targeted a block that moved elsewhere in the document). */
  blockIndex: number;
}

/** Index of `block` within `all` by startLine identity (blocks are disjoint
 *  so startLine is a unique key). */
function indexOfBlock(all: CodeBlock[], block: CodeBlock): number {
  return all.findIndex((b) => b.startLine === block.startLine);
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
  // Only block-anchored markers (nothing but other marker refs before this
  // one on its line) point at the code block above them; a prose-anchored
  // marker is not code-line based. sv-mode inserts stack multiple markers on
  // the line after the fence (`[^anno-3][^anno-1]`), so sibling refs are
  // tolerated — they still anchor the block above (same tolerance as
  // getAnchorSnippet in annotations.ts).
  if (
    beforeRef !== "" &&
    !/^\s*(?:\[\^anno-\d+\]\s*)+$/.test(beforeRef)
  ) {
    return null;
  }

  const want = meta.firstLine.trim();
  if (!want) return null;
  const count = Math.max(1, meta.end - meta.start + 1);
  const all = allCodeBlocks(lines);

  // 1+2) The block above the marker.
  const block = blockAbove(lines, markerLine);
  if (block) {
    const at = meta.start - 1;
    if (at >= 0 && at < block.lines.length && sameLine(block.lines[at], want)) {
      return {
        start: meta.start,
        end: meta.start + count - 1,
        blockStartLine: block.startLine,
        blockIndex: indexOfBlock(all, block),
      };
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
    if (best >= 0) {
      return {
        start: best + 1,
        end: best + count,
        blockStartLine: block.startLine,
        blockIndex: indexOfBlock(all, block),
      };
    }
  }

  // 3) The line moved to another block — pick the match closest to the marker.
  let bestBlock: CodeBlock | null = null;
  let bestLine = -1;
  let bestDist = Infinity;
  let bestBlockIdx = -1;
  for (let bi = 0; bi < all.length; bi++) {
    const b = all[bi];
    for (let k = 0; k < b.lines.length; k++) {
      if (!sameLine(b.lines[k], want)) continue;
      const dist = Math.abs(b.startLine + k - markerLine);
      if (dist < bestDist) {
        bestDist = dist;
        bestBlock = b;
        bestLine = k;
        bestBlockIdx = bi;
      }
    }
  }
  if (bestBlock && bestLine >= 0) {
    return {
      start: bestLine + 1,
      end: bestLine + count,
      blockStartLine: bestBlock.startLine,
      blockIndex: bestBlockIdx,
    };
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

/** A top-level paragraph holding nothing but annotation markers — transparent
 *  when walking up to a code block (stacked markers under the same block).
 *  Child-node-level verdict (mirrors useAnnotationMarkers.isMarkerOnlyParagraph):
 *  the badge <sup> CONTAINS the "anno-N" label text (hidden via font-size:0),
 *  so a textContent-empty check would never pass on real editor DOM. */
function isMarkerParagraph(el: Element | null): boolean {
  if (!el || el.tagName !== "P") return false;
  let hasMarker = false;
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (n.textContent?.trim() === "") continue;
      return false;
    }
    if (!(n instanceof Element)) return false;
    if (n.tagName === "BR") continue;
    if (n.tagName === "IMG" && n.classList.contains("ProseMirror-separator")) {
      continue;
    }
    if (n.matches(ANNO_MARKER_SELECTOR)) {
      hasMarker = true;
      continue;
    }
    return false;
  }
  return hasMarker;
}

function isCodeBlockEl(el: Element | null): boolean {
  if (!el) return false;
  return el.classList.contains("milkdown-code-block") || el.tagName === "PRE";
}

/**
 * The code block DOM element a marker badge anchors to (single resolver for
 * highlightCodeLines / restoreCodeLineHighlights / activeHighlightAnchor so
 * the three can never drift apart):
 *  * `blockIndex` given → the Nth top-level code block in the document (the
 *    DOM order of top-level blocks matches the source order, so this lands on
 *    the SAME block resolveCodeLines picked when strategy 3 re-targeted a
 *    block that moved elsewhere);
 *  * else walk up from the marker, skipping marker-only paragraphs, to the
 *    nearest code block. v3.9.3: the old blind `previousElementSibling` broke
 *    for the 2nd+ annotation on the same block (its previous sibling is
 *    ANOTHER marker paragraph, not the code block) — highlight, popover
 *    anchoring and sidebar jumps all silently fell back to the marker.
 */
function codeBlockForMarker(
  markerEl: HTMLElement,
  blockIndex?: number
): Element | null {
  const root = markerEl.closest(".ProseMirror");
  if (blockIndex != null && blockIndex >= 0 && root) {
    const blocks = Array.from(root.children).filter(isCodeBlockEl);
    if (blockIndex < blocks.length) return blocks[blockIndex];
    return null;
  }
  let cur: Element | null = topLevelBlock(markerEl);
  while (cur) {
    const prev: Element | null = cur.previousElementSibling;
    if (!prev) return null;
    if (isCodeBlockEl(prev)) return prev;
    if (isMarkerParagraph(prev)) {
      cur = prev;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Highlight lines [start..end] (1-based) of the code block the given marker
 * element is anchored after, and scroll the first highlighted line into view.
 * Returns the first highlighted line element (for popover positioning), or
 * null when the block can't be resolved (caller falls back to the marker).
 * `opts.scroll=false` skips the scrollIntoView (used by the restore path —
 * a rebuild mid-session must not yank the viewport, only repaint the lines).
 * `opts.blockIndex` (from resolveCodeLines) pins the target block when the
 * block-above-marker heuristic doesn't apply.
 */
export function highlightCodeLines(
  markerEl: HTMLElement,
  start: number,
  end: number,
  opts: { scroll?: boolean; blockIndex?: number } = {}
): HTMLElement | null {
  const doScroll = opts.scroll !== false;
  if (doScroll) noteScrollWrite("code-anno");
  try {
    const block = codeBlockForMarker(markerEl, opts.blockIndex);
    if (!block) return null;

    // CodeMirror-rendered block: one .cm-line child per source line.
    const cmLines = block.querySelectorAll<HTMLElement>(".cm-content > .cm-line");
    if (cmLines.length > 0) {
      const from = Math.max(1, start);
      const to = Math.min(cmLines.length, Math.max(from, end));
      let first: HTMLElement | null = null;
      for (let i = from; i <= to; i++) {
        const el = cmLines[i - 1];
        el.classList.add(CODE_LINE_HL_CLASS);
        if (!first) first = el;
      }
      if (doScroll) first?.scrollIntoView({ behavior: "auto", block: "center" });
      return first;
    }

    // Plain <pre><code> block (big-doc mode): highlight the whole block.
    if (block.tagName === "PRE") {
      block.classList.add(CODE_LINE_HL_CLASS);
      if (doScroll) block.scrollIntoView({ behavior: "auto", block: "center" });
      return block as HTMLElement;
    }
    return null;
  } catch {
    return null;
  }
}

/** Remember the highlight tied to the currently-open popover so it survives
 *  node-view re-renders (restoreCodeLineHighlights re-applies it). */
export function setActiveCodeHighlight(
  annoId: string,
  start: number,
  end: number,
  blockIndex?: number
): void {
  activeHighlight = { annoId, start, end, blockIndex };
}

/** Re-apply the active highlight if a re-render wiped it. Cheap no-op when no
 *  popover highlight is active or the classes are still in place. Called from
 *  the merged DOM-stamp pass (useAnnotationMarkers) after editor re-renders.
 *  「仍已涂色」只查 active marker 关联的代码块 —— 全文档任意残留高亮
 *  （上一次未清理/并发打开）会误判为已涂色，抑制真正需要的补画。 */
export function restoreCodeLineHighlights(): void {
  if (!activeHighlight) return;
  try {
    const marker = document.querySelector<HTMLElement>(
      `${ANNO_MARKER_SELECTOR}[data-label="${activeHighlight.annoId}"]`
    );
    if (!marker) return;
    const block = codeBlockForMarker(marker, activeHighlight.blockIndex);
    if (block?.querySelector(`.${CODE_LINE_HL_CLASS}`)) return; // still painted
    highlightCodeLines(marker, activeHighlight.start, activeHighlight.end, {
      scroll: false,
      blockIndex: activeHighlight.blockIndex,
    });
  } catch {
    /* teardown races — never throw */
  }
}

/** The popover's anchor element for `annoId`: the highlighted code line inside
 *  that annotation's OWN block, falling back to its marker badge. Scoped to the
 *  active annotation — the first `.anno-code-line-hl` anywhere in the document
 *  may belong to a different annotation (stale or concurrent) and would glue
 *  the card to the wrong block. */
export function activeHighlightAnchor(annoId: string): HTMLElement | null {
  try {
    const marker = document.querySelector<HTMLElement>(
      `${ANNO_MARKER_SELECTOR}[data-label="${annoId}"]`
    );
    if (!marker) return null;
    const block = codeBlockForMarker(marker);
    return (
      block?.querySelector<HTMLElement>(`.${CODE_LINE_HL_CLASS}`) ?? marker
    );
  } catch {
    return null;
  }
}

/** Remove every code-line highlight currently painted in the document and
 * forget the active-highlight anchor (closing the popover). */
export function clearCodeLineHighlights(): void {
  activeHighlight = null;
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
