// 插桩：单个字形（orig gid 1）的 _usedSubrs 与 subsetSubrs used 集对照。
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const fontkit = require("@pdf-lib/fontkit");

const font = fontkit.create(fs.readFileSync("public/assets/fonts/NotoSansSC-Regular.otf"));

// 1) 独立解析 orig gid 1 的 path，看 _usedSubrs
const g1 = font.getGlyph(1);
console.log("glyph1 path commands:", g1.path.commands.length, "usedSubrs keys:", Object.keys(g1._usedSubrs || {}).length, Object.keys(g1._usedSubrs || {}).slice(0, 10));

// 2) subset 流程中同样的 glyph
const subset = font.createSubset();
subset.includeGlyph(g1);

const origSubsetSubrs = subset.subsetSubrs.bind(subset);
subset.subsetSubrs = function (subrs, used) {
  const usedKeys = Object.keys(used);
  console.log(
    `subsetSubrs: total=${subrs.length} used=${usedKeys.length} first=${usedKeys.slice(0, 10).join(",")}`,
  );
  const res = origSubsetSubrs(subrs, used);
  // 统计被 stub 的数量
  const stubs = res.filter((r) => r.length === 1 && r[0] === 11).length;
  console.log(`  -> kept ${res.length - stubs}, stubbed ${stubs}`);
  return res;
};

const parts = [];
await new Promise((res, rej) =>
  subset.encodeStream().on("data", (b) => parts.push(b)).on("end", res).on("error", rej),
);
fs.writeFileSync("perf/results/rvf-subset/single-subset.cff", Buffer.concat(parts.map((p) => Buffer.from(p))));
console.log("done");
