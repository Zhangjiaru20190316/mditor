// 逐字形跟踪 subsetFontdict 的 fd 推导 vs fdForGlyph 真值。
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const fontkit = require("@pdf-lib/fontkit");

const font = fontkit.create(fs.readFileSync("public/assets/fonts/NotoSansSC-Regular.otf"));
const codePoints = JSON.parse(fs.readFileSync("perf/results/rvf-subset/user-codepoints.json", "utf8"));
const subset = font.createSubset();
for (const cp of codePoints) subset.includeGlyph(font.glyphForCodePoint(cp));
const cff = subset.cff;

const origSubsetFontdict = subset.subsetFontdict.bind(subset);
subset.subsetFontdict = function (topDict) {
  // 在原实现跑之前，独立记录每个 glyph 的 fdForGlyph
  const truth = [...subset.glyphs].map((g) => cff.fdForGlyph(g));
  const orig = origSubsetFontdict(topDict);
  const got = [...topDict.FDSelect.fds];
  // 还原 first-seen 顺序的期望映射
  const seen = new Map();
  const expected = [];
  for (const fd of truth) {
    if (!seen.has(fd)) seen.set(fd, seen.size);
    expected.push(seen.get(fd));
  }
  const mism = [];
  for (let i = 0; i < got.length; i++) {
    if (got[i] !== expected[i]) mism.push([i, got[i], expected[i], [...subset.glyphs][i]]);
  }
  console.log("glyph count:", truth.length, "fd mismatches:", mism.length);
  console.log("first mismatches [idx, got, expected, origGid]:", mism.slice(0, 8));
  console.log("truth fds of first 40 glyphs:", truth.slice(0, 40).join(","));
  console.log("got fds of first 40 glyphs:  ", got.slice(0, 40).join(","));
  return orig;
};
await new Promise((res, rej) =>
  subset.encodeStream().on("data", () => {}).on("end", res).on("error", rej),
);
