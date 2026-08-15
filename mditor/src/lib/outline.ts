// Build a document outline (heading tree) from markdown source.
//
// This source-parse path is the FALLBACK: it feeds the outline in sv mode
// (where the hidden ProseMirror doc is stale) and before the editor reports
// its first headings. Rich modes use buildOutlineFromHeadings with headings
// extracted from the live ProseMirror doc, whose ids come straight from
// Milkdown's attrs.id — the same id the DOM carries — so anchor jumps can't
// diverge from the rendered <hN id>.
//
// We parse ATX headings (`#`..`######`) and Setext headings (H1/H2 underlined
// with `===`/`---`). Code-fenced blocks are skipped so `#` inside code doesn't
// count. The generated ids mirror Milkdown's heading-id generator closely
// enough for React keys and display dedup; sv-mode jumps target source lines,
// not these ids.

import type { FlatHeading, OutlineNode } from "../types";

// `buildOutline` runs on every keystroke, so this cross-call slug memo grows for
// every distinct heading text seen across the whole session. Slug computation is
// cheap, so bound the map to keep long sessions from leaking memory unbounded.
const SLUG_CACHE_MAX = 2000;
/** When the cache reaches MAX, evict the oldest entries down to this size. */
const SLUG_CACHE_KEEP = 1500;
const slugCache = new Map<string, string>();

/** Evict the OLDEST entries instead of clearing the whole map: a full clear()
 *  on a huge document forces every heading's slug to be recomputed on each
 *  build, turning the memo into pure overhead. Map preserves insertion order,
 *  so the first keys are the oldest. Trade-off: an evicted entry is simply
 *  recomputed on next use — the cache is a pure memo (text → base slug), and
 *  the `-#N` collision counters live in the per-build `used` set in makeSlug,
 *  so eviction can never corrupt in-flight dedup. */
function evictOldestSlugs() {
  let drop = slugCache.size - SLUG_CACHE_KEEP;
  for (const key of slugCache.keys()) {
    if (drop <= 0) break;
    slugCache.delete(key);
    drop -= 1;
  }
}

/**
 * Base heading slug — MUST stay byte-identical to the headingIdGenerator we
 * install in the Milkdown editor (see hooks/useMilkdown.ts). Milkdown's
 * sync-heading-id plugin dedups collisions by appending `-#2`, `-#3`, … (note
 * the literal `#`), so makeSlug mirrors that exact scheme.
 *
 * Rule: lowercase, keep Unicode letters/numbers/spaces/hyphens, collapse runs
 * of whitespace into single hyphens, trim edge hyphens, empty → "heading".
 */
export function headingSlugBase(text: string): string {
  const cached = slugCache.get(text);
  if (cached != null) return cached;
  let s = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!s) s = "heading";
  // Bound the memo by evicting the oldest entries (see evictOldestSlugs) —
  // recomputation on a miss is cheap and correctness is unaffected either way.
  if (slugCache.size >= SLUG_CACHE_MAX) evictOldestSlugs();
  slugCache.set(text, s);
  return s;
}

/** Slugify a heading: base slug + Milkdown-style `-#N` dedup against `used`. */
function makeSlug(text: string, used: Set<string>): string {
  const base = headingSlugBase(text);
  let candidate = base;
  let i = 1;
  while (used.has(candidate)) {
    i += 1;
    candidate = `${base}-#${i}`;
  }
  used.add(candidate);
  return candidate;
}

export function buildOutline(markdown: string): OutlineNode[] {
  const builder = new TreeBuilder();
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let fenceMarker = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^(\s*)(```+|~~~+)/);
    if (fence) {
      const marker = fence[2].charAt(0);
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    // ATX: optional 1-3 spaces, 1-6 hashes, a space, then text.
    const atx = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (atx) {
      builder.push(atx[1].length, atx[2], makeSlug(atx[2], builder.used), i);
      continue;
    }
    // Setext: next line is === (H1) or --- (H2), and current line is non-blank text.
    if (i + 1 < lines.length) {
      const next = lines[i + 1];
      const setext = next.match(/^\s{0,3}(=+|-{2,})\s*$/);
      if (setext && line.trim().length > 0 && !/^\s{0,3}(-|\*|_)\1\1+/.test(line)) {
        const level = setext[1].charAt(0) === "=" ? 1 : 2;
        builder.push(level, line.trim(), makeSlug(line.trim(), builder.used), i);
        i += 1; // consume the underline
      }
    }
  }
  return builder.roots;
}

/**
 * Outline tree from headings extracted out of the live ProseMirror document
 * (see FlatHeading). `line` is unknown on this path — sv-mode jumps don't use
 * it, and rich-mode jumps go through the heading's DOM id.
 */
export function buildOutlineFromHeadings(flat: FlatHeading[]): OutlineNode[] {
  const builder = new TreeBuilder();
  for (const h of flat) builder.push(h.level, h.text, h.id);
  return builder.roots;
}

/** Shared nesting logic: attach each heading under the nearest shallower one. */
class TreeBuilder {
  readonly roots: OutlineNode[] = [];
  readonly used = new Set<string>();
  private readonly stack: OutlineNode[] = [];

  push(level: number, text: string, id: string, line?: number): void {
    const node: OutlineNode = { level, text, id, children: [] };
    if (line != null) node.line = line;
    // pop until stack top is strictly shallower
    while (this.stack.length && this.stack[this.stack.length - 1].level >= level) {
      this.stack.pop();
    }
    if (this.stack.length === 0) {
      this.roots.push(node);
    } else {
      this.stack[this.stack.length - 1].children.push(node);
    }
    this.stack.push(node);
  }
}
