// RVF 追加轮：fontkit CFF 子集最小复现。
// 用法: node perf/rvf-subset-repro.mjs <out-prefix>
// 产出: <out-prefix>-subset.cff（裸 CFF）+ 摘要 JSON 打印。
// fontTools 侧校验用 perf/rvf-subset-verify.py。
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
// 用 UMD 入口（CJS）以保证与浏览器打包同一份补丁逻辑可对照；
// es 版与 umd 版补丁同步维护。
const fontkit = require("@pdf-lib/fontkit");

const fontPath = "public/assets/fonts/NotoSansSC-Regular.otf";
const outPrefix = process.argv[2] || "perf/results/rvf-subset/repro";
fs.mkdirSync("perf/results/rvf-subset", { recursive: true });

const buf = fs.readFileSync(fontPath);
const font = fontkit.create(buf);

// 字符集来源：--cp <json>（用户 PDF 实际码点，插入序）或默认样本
let codePoints;
if (process.argv[3] === "--cp" && process.argv[4]) {
  codePoints = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
} else {
  const sample = "范文与逐句精讲立场不会取代教师备考语料会人工智能";
  codePoints = [...sample].map((c) => c.codePointAt(0));
}

const subset = font.createSubset();
for (const cp of codePoints) {
  const glyph = font.glyphForCodePoint(cp);
  subset.includeGlyph(glyph);
}
const parts = [];
await new Promise((resolve, reject) => {
  subset
    .encodeStream()
    .on("data", (b) => parts.push(b))
    .on("end", resolve)
    .on("error", reject);
});
const encoded = Buffer.concat(parts.map((p) => Buffer.from(p)));
fs.writeFileSync(`${outPrefix}-subset.cff`, encoded);
fs.writeFileSync(
  `${outPrefix}-glyphs.json`,
  JSON.stringify([...subset.glyphs]),
);
console.log(
  JSON.stringify(
    {
      sample: process.argv[4] || "inline-sample",
      codepointCount: codePoints.length,
      glyphCount: subset.glyphs.length,
      encodedBytes: encoded.length,
      out: `${outPrefix}-subset.cff`,
    },
    null,
    2,
  ),
);
