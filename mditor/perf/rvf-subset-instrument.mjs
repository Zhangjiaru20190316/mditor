// 插桩版：CFFSubset.encode 前后对照，定位 FD 映射错位发生在内存还是写入。
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const fontkit = require("@pdf-lib/fontkit");

const font = fontkit.create(fs.readFileSync("public/assets/fonts/NotoSansSC-Regular.otf"));

// 取 的原始 gid
const quGlyph = font.glyphForCodePoint(0x53d6); // 取
console.log("取 original glyph id:", quGlyph.id);
// 用 cff 内部 API 验证 fdForGlyph

const subset = font.createSubset();
const cff = subset.cff;
console.log("font keys:", Object.keys(font).slice(0, 20));
subset.includeGlyph(quGlyph);
// 也加一个已验证渲染正常的字（立 U+7ACB）与题目中其他字
for (const cp of [0x8303, 0x6587, 0x7acb, 0x4f1a, 0x8003]) {
  subset.includeGlyph(font.glyphForCodePoint(cp));
}

// 在 encode 前 hook subsetFontdict：打印内存中的 FDArray 顺序与每个 glyph 的 fd
const origSubsetFontdict = subset.subsetFontdict.bind(subset);
subset.subsetFontdict = function (topDict) {
  console.log("--- in-memory before subsetFontdict ---");
  console.log("glyphs (original gids, insertion order):", [...subset.glyphs]);
  for (const gid of subset.glyphs) {
    console.log(`gid ${gid}: fdForGlyph ->`, cff.fdForGlyph(gid));
  }
  origSubsetFontdict(topDict);
  console.log("--- after subsetFontdict (in-memory topDict) ---");
  topDict.FDArray.forEach((fd, i) => {
    console.log(
      `subset FD${i}: StdHW=${fd.Private?.StdHW} subrsCount=${
        fd.Private?.Subrs?.length ?? "?"
      }`,
    );
  });
  console.log("FDSelect.fds:", topDict.FDSelect.fds);
};
await new Promise((res, rej) =>
  subset.encodeStream().on("data", () => {}).on("end", res).on("error", rej),
);
console.log("done");
