// Word counting for the status bar. CJK-aware, matching how editors like
// Typora count: each Han/kana/hangul character is one word; each contiguous
// run of latin letters/digits is one word. Implemented as a single
// zero-allocation pass — the previous two-regex version allocated a match
// array plus a full replaced copy of the document on every recompute.

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
    (cp >= 0xac00 && cp <= 0xd7af) // Hangul Syllables
  );
}

function isLatin(cp: number): boolean {
  return (
    (cp >= 0x41 && cp <= 0x5a) || // A-Z
    (cp >= 0x61 && cp <= 0x7a) || // a-z
    (cp >= 0x30 && cp <= 0x39) // 0-9
  );
}

/** Count CJK characters + latin word runs in `md`. */
export function countWords(md: string): number {
  let words = 0;
  let inLatin = false;
  for (let i = 0; i < md.length; i++) {
    const cp = md.charCodeAt(i);
    if (isCjk(cp)) {
      words++;
      inLatin = false;
    } else if (isLatin(cp)) {
      if (!inLatin) words++;
      inLatin = true;
    } else {
      inLatin = false;
    }
  }
  return words;
}
