// Line-level diff between an original text and an AI-revised text, used by the
// AI panel's 改动预览 (review-before-apply) flow.
//
// The algorithm is a classic LCS over LINES:
//   1. normalise line endings and trim the common prefix / suffix lines so the
//      O(n·m) DP only ever runs on the changed interior (a rewrite of a long
//      note usually differs in a handful of places);
//   2. LCS table on the interior lines (capped — beyond the cap the whole
//      interior becomes one hunk, which is still correct, just coarser);
//   3. walk the table emitting delete/insert runs, each run becoming one hunk
//      showing 原内容 → 新内容.
//
// Hunks are non-overlapping and sorted by document order, which is what makes
// `applyHunks` a simple splice walk.

/** One reviewable change: original lines [origStart, origEnd) replaced by
 *  `newLines` (either side may be empty for pure insert / delete). */
export interface DiffHunk {
  /** 0-based line index into the ORIGINAL text's line array. */
  origStart: number;
  /** Exclusive end of the original range. */
  origEnd: number;
  /** Original lines (empty for a pure insertion). */
  origLines: string[];
  /** Replacement lines (empty for a pure deletion). */
  newLines: string[];
  /** The first non-empty original line — used as the jump-back anchor when the
   *  user clicks a hunk to view it in context. Empty for pure insertions. */
  anchorLine: string;
}

/** DP cell budget for the LCS table. Beyond this the interior collapses into a
 *  single hunk (correct, coarse). 4M cells ≈ 16MB Int32Array. */
const MAX_DP_CELLS = 4_000_000;

export function splitLines(s: string): string[] {
  return s.replace(/\r\n?/g, "\n").split("\n");
}

/** A delete/insert run emitted by the LCS walk, in document order. `sa`/`sb`
 *  are the run's START indices into midA/midB — the equal lines consumed
 *  between runs are NOT part of any run, so without absolute starts the
 *  original line indices would drift past them. */
interface Run {
  sa: number;
  del: number;
  sb: number;
  ins: number;
}

function lcsRuns(midA: string[], midB: string[]): Run[] {
  const n = midA.length;
  const m = midB.length;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) {
    // One side empty: everything the other side has is a single run.
    return [{ sa: 0, del: n, sb: 0, ins: m }];
  }
  if (n * m > MAX_DP_CELLS) return [{ sa: 0, del: n, sb: 0, ins: m }];

  // LCS lengths table, 1-based padding row/col of zeros around the content.
  const w = m + 1;
  const lcs = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        midA[i] === midB[j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }

  const runs: Run[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      i++;
      j++;
      continue;
    }
    const si = i;
    const sj = j;
    while (i < n && j < m && midA[i] !== midB[j]) {
      // Follow the LCS-optimal direction: consuming midA[i] is a deletion,
      // consuming midB[j] an insertion.
      if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) i++;
      else j++;
    }
    if (i >= n || j >= m) {
      // One side ran out inside the run — the remainder of BOTH sides belongs
      // to this run (leftover deletions + insertions at the tail).
      i = n;
      j = m;
    }
    runs.push({ sa: si, del: i - si, sb: sj, ins: j - sj });
  }
  if (i < n || j < m) runs.push({ sa: i, del: n - i, sb: j, ins: m - j });
  return runs;
}

/**
 * Diff two texts by lines. Returns the change hunks in document order; an
 * empty array means the texts are identical (after line-ending normalisation).
 */
export function diffText(original: string, revised: string): DiffHunk[] {
  const a = splitLines(original);
  const b = splitLines(revised);

  // Trim the common prefix / suffix — the DP only sees the changed interior,
  // and leading/trailing equal lines can never appear inside a hunk.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);

  const runs = lcsRuns(midA, midB);
  const hunks: DiffHunk[] = [];
  for (const run of runs) {
    if (run.del === 0 && run.ins === 0) continue;
    const origLines = midA.slice(run.sa, run.sa + run.del);
    const newLines = midB.slice(run.sb, run.sb + run.ins);
    hunks.push({
      origStart: pre + run.sa,
      origEnd: pre + run.sa + run.del,
      origLines,
      newLines,
      anchorLine: origLines.find((l) => l.trim() !== "") ?? "",
    });
  }
  return hunks;
}

/**
 * Apply the accepted hunks to `original`, returning the merged text. Rejected
 * hunks leave their original lines untouched. Hunks must come from a single
 * `diffText` call over the same `original` (non-overlapping, sorted).
 */
export function applyHunks(original: string, hunks: DiffHunk[], accept: boolean[]): string {
  const lines = splitLines(original);
  // Splice from the back so earlier indices stay valid.
  for (let k = hunks.length - 1; k >= 0; k--) {
    if (!accept[k]) continue;
    const h = hunks[k];
    lines.splice(h.origStart, h.origEnd - h.origStart, ...h.newLines);
  }
  return lines.join("\n");
}

/**
 * Char ranges to emphasise inside a changed line pair, for the 原文 → 新文
 * inline display. Returns the index range that differs (the middle between the
 * common prefix and suffix). Cheap prefix/suffix trimming — plenty for typo
 * level edits and stable for CJK text where "words" don't exist.
 */
export function charDiffRange(
  a: string,
  b: string
): { aRange: [number, number] | null; bRange: [number, number] | null } {
  let p = 0;
  const minLen = Math.min(a.length, b.length);
  while (p < minLen && a[p] === b[p]) p++;
  let s = 0;
  while (s < minLen - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const aEnd = a.length - s;
  const bEnd = b.length - s;
  return {
    aRange: p < aEnd ? [p, aEnd] : null,
    bRange: p < bEnd ? [p, bEnd] : null,
  };
}

/**
 * Strip a single whole-text code fence some models wrap their rewrite in
 * (```markdown\n…\n```). Only unwraps when the fence spans the ENTIRE reply;
 * legitimate fenced content inside the reply is untouched.
 */
export function unwrapWholeFence(s: string): string {
  const t = s.replace(/\r\n?/g, "\n").trim();
  const m = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1$/.exec(t);
  return m ? m[2] : t;
}
