// Annotation anchor search.
//
// An annotation marker must land right after the text the user had selected
// when the annotation (or the AI question it answers) was created. Two text
// forms are involved and they are NOT byte-identical:
//
//   * the anchor text comes from `window.getSelection().toString()` — the DOM
//     joins paragraphs with "\n\n", renders footnote badges as pseudo-element
//     content (invisible to the selection string) and line breaks as "\n";
//   * the document side is ProseMirror, where `textBetween(from, to, "\n")`
//     joins blocks with a single "\n" and a text node never contains newlines.
//
// The old resolver compared both forms with a plain `===` after trim and, once
// that failed, looked for the anchor inside ONE text node at a time — so every
// cross-paragraph / cross-mark selection fell through and its marker ended up
// appended to the document tail, and repeated wording anchored at the earliest
// (wrong) occurrence.
//
// Both sides are therefore compared and searched in a whitespace-collapsed
// form, and the whole document is flattened into that form together with a
// character→PM-position map, so a match anywhere (across paragraphs, across
// inline-mark boundaries, across hard breaks) maps back to the exact
// ProseMirror insertion position. A captured range (possibly stale after
// edits) doubles as a disambiguation hint: when the wording occurs several
// times, the occurrence closest to where the selection used to be wins.

import type { Node as PMNode } from "@milkdown/prose/model";

/** Collapse every whitespace run (spaces, newlines, tabs) to a single space
 *  and trim the ends — the common form for both range validation and text
 *  search, so DOM-selection quirks and ProseMirror block separators compare
 *  equal. */
export function normalizeAnchorText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** End index (just after the last char) of the `needle` occurrence closest to
 *  `hint` — first occurrence when hint < 0, -1 when the needle never occurs.
 *  Plain-string twin of findAnchorPos for the source-view (textarea) mode. */
export function nearestOccurrenceEnd(haystack: string, needle: string, hint = -1): number {
  if (!needle) return -1;
  let best = -1;
  let bestDist = Infinity;
  let idx = haystack.indexOf(needle);
  while (idx >= 0) {
    const end = idx + needle.length;
    if (hint < 0) return end;
    const dist = Math.abs(idx - hint);
    if (dist < bestDist) {
      bestDist = dist;
      best = end;
    }
    idx = haystack.indexOf(needle, idx + 1);
  }
  return best;
}

/** ProseMirror position just after the last character of the anchor text's
 *  occurrence closest to `hintFrom` (-1 → first occurrence; still -1 when the
 *  anchor can't be matched anywhere).
 *
 *  The document is flattened by walking its text nodes and emitting each
 *  character in normalized form while recording its PM position; block
 *  boundaries and hard_breaks emit a single separator space (they are
 *  whitespace runs in the DOM selection string), while other inline atoms
 *  (footnote_reference, images) contribute nothing — exactly like the empty
 *  pseudo-element badges the DOM selection string sees. */
export function findAnchorPos(doc: PMNode, anchorText: string, hintFrom = -1): number {
  const needle = normalizeAnchorText(anchorText);
  if (!needle) return -1;
  const chars: string[] = [];
  const pmAt: number[] = [];
  // Suppresses leading separators and collapses whitespace runs to one space.
  let lastWasSpace = true;
  const emit = (ch: string, pm: number) => {
    if (ch === " ") {
      if (lastWasSpace) return;
      lastWasSpace = true;
    } else {
      lastWasSpace = false;
    }
    chars.push(ch);
    pmAt.push(pm);
  };
  doc.descendants((n, p) => {
    if (n.isText && n.text) {
      for (let i = 0; i < n.text.length; i++) {
        const ch = n.text[i];
        emit(/\s/.test(ch) ? " " : ch, p + i);
      }
    } else if (n.isBlock || n.type.name === "hard_break") {
      emit(" ", p);
    }
    return true;
  });
  const text = chars.join("");
  let best = -1;
  let bestDist = Infinity;
  let idx = text.indexOf(needle);
  while (idx >= 0) {
    // Needle is non-empty and trimmed, so pmAt[idx] / pmAt[end-1] always hit
    // real characters — insertion goes right after the last matched one,
    // inside its textblock (never past the block's closing boundary).
    const end = idx + needle.length;
    const pos = pmAt[end - 1] + 1;
    if (hintFrom < 0) return pos;
    const dist = Math.abs(pmAt[idx] - hintFrom);
    if (dist < bestDist) {
      bestDist = dist;
      best = pos;
    }
    idx = text.indexOf(needle, idx + 1);
  }
  return best;
}
