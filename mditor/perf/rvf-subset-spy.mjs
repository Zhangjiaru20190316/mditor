// 间谍：拦截 subsetFontdict 期间所有 fdForGlyph 调用，对比线性真值。
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const fontkit = require("@pdf-lib/fontkit");

const font = fontkit.create(fs.readFileSync("public/assets/fonts/NotoSansSC-Regular.otf"));
const codePoints = JSON.parse(fs.readFileSync("perf/results/rvf-subset/user-codepoints.json", "utf8"));
const subset = font.createSubset();
for (const cp of codePoints) subset.includeGlyph(font.glyphForCodePoint(cp));
const cff = subset.cff;

const ranges = cff.topDict.FDSelect.ranges;
function fdTrue(gid) {
  let fd = ranges[0].fd;
  for (const r of ranges) {
    if (gid >= r.first) fd = r.fd;
    else break;
  }
  return fd;
}

const origFn = cff.fdForGlyph.bind(cff);
let phase = "idle";
const calls = [];
cff.fdForGlyph = function (gid) {
  const r = origFn(gid);
  if (phase === "subset") calls.push([gid, r, fdTrue(gid)]);
  return r;
};

const origSubsetFontdict = subset.subsetFontdict.bind(subset);
subset.subsetFontdict = function (topDict) {
  phase = "subset";
  const out = origSubsetFontdict(topDict);
  phase = "idle";
  const bad = calls.filter(([, got, want]) => got !== want);
  console.log("fdForGlyph calls during subsetFontdict:", calls.length, "wrong:", bad.length);
  console.log("first wrong [gid, got, truth]:", bad.slice(0, 8));
  console.log("sample calls:", calls.slice(28, 40));
  return out;
};
await new Promise((res, rej) =>
  subset.encodeStream().on("data", () => {}).on("end", res).on("error", rej),
);
