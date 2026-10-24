// 全量插桩：对比内存 FDSelect.fds 期望 vs 输出文件实际解析值。
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const fontkit = require("@pdf-lib/fontkit");

const font = fontkit.create(fs.readFileSync("public/assets/fonts/NotoSansSC-Regular.otf"));
const codePoints = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const outPath = process.argv[3];

const subset = font.createSubset();
for (const cp of codePoints) subset.includeGlyph(font.glyphForCodePoint(cp));

const cff = subset.cff;
let expected = null;
const origSubsetFontdict = subset.subsetFontdict.bind(subset);
subset.subsetFontdict = function (topDict) {
  origSubsetFontdict(topDict);
  expected = {
    fds: [...topDict.FDSelect.fds],
    fdCount: topDict.FDArray.length,
    fdStdhw: topDict.FDArray.map((fd) => fd.Private?.StdHW),
  };
};

const parts = [];
await new Promise((res, rej) =>
  subset.encodeStream().on("data", (b) => parts.push(b)).on("end", res).on("error", rej),
);
fs.writeFileSync(outPath, Buffer.concat(parts.map((p) => Buffer.from(p))));
fs.writeFileSync(outPath + ".expected.json", JSON.stringify(expected));
console.log("encoded", outPath, "glyphs", subset.glyphs.length);
console.log("expected fdCount:", expected.fdCount, "StdHW:", expected.fdStdhw);
console.log("expected fds[:20]:", expected.fds.slice(0, 20));
