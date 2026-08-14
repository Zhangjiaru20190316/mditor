// Build a document outline (heading tree) from markdown source.
//
// We parse ATX headings (`#`..`######`) and Setext headings (H1/H2 underlined
// with `===`/`---`). Code-fenced blocks are skipped so `#` inside code doesn't
// count. The generated ids mirror Milkdown's heading-id generator so anchor
// jumps (Outline → getElementById) line up with the editor's rendered <hN id>.

import type { OutlineNode } from "../types";

// `buildOutline` runs on every keystroke, so this cross-call slug memo grows for
// every distinct heading text seen across the whole session. Slug computation is
// cheap, so bound the map to keep long sessions from leaking memory unbounded.
const SLUG_CACHE_MAX = 2000;
const slugCache = new Map<string, string>();

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
  // Drop the whole memo once in a while; correctness is intact either way.
  if (slugCache.size >= SLUG_CACHE_MAX) slugCache.clear();
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
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  const used = new Set<string>();

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
      pushHeading(atx[1].length, atx[2], roots, stack, used);
      continue;
    }
    // Setext: next line is === (H1) or --- (H2), and current line is non-blank text.
    if (i + 1 < lines.length) {
      const next = lines[i + 1];
      const setext = next.match(/^\s{0,3}(=+|-{2,})\s*$/);
      if (setext && line.trim().length > 0 && !/^\s{0,3}(-|\*|_)\1\1+/.test(line)) {
        const level = setext[1].charAt(0) === "=" ? 1 : 2;
        pushHeading(level, line.trim(), roots, stack, used);
        i += 1; // consume the underline
      }
    }
  }
  return roots;
}

function pushHeading(
  level: number,
  text: string,
  roots: OutlineNode[],
  stack: OutlineNode[],
  used: Set<string>
) {
  const id = makeSlug(text, used);
  const node: OutlineNode = { level, text, id, children: [] };
  // pop until stack top is strictly shallower
  while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
  if (stack.length === 0) {
    roots.push(node);
  } else {
    stack[stack.length - 1].children.push(node);
  }
  stack.push(node);
}

/** Flatten a tree to a list for keyboard nav / counting. */
export function flattenOutline(nodes: OutlineNode[]): OutlineNode[] {
  const out: OutlineNode[] = [];
  const walk = (ns: OutlineNode[]) => {
    for (const n of ns) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
