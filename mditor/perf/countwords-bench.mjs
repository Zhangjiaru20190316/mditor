// P2 微基准：实测 countWords 在 1MB 压测文档上的单次耗时与防抖前后每秒预算。
// 用法：npx tsx perf/countwords-bench.mjs
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { countWords } from "../src/lib/textStats";

const md = readFileSync(new URL("./fixtures/一元微分学习题集_1MB压测副本.md", import.meta.url), "utf8");
console.log("doc chars:", md.length);
countWords(md); // 预热（JIT）
const times = [];
for (let i = 0; i < 30; i++) {
  const t0 = performance.now();
  countWords(md);
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
const p50 = times[15], p95 = times[28];
console.log(`countWords(1MB) p50: ${p50.toFixed(2)} ms | p95: ${p95.toFixed(2)} ms`);
console.log(`修复前（rAF 合并后仍每键 1 次，最高 60 次/秒）：每秒全文扫描预算 ${(p50 * 60).toFixed(0)} ms`);
console.log(`修复后（150ms 防抖，最高 ~6.6 次/秒）：每秒 ${(p50 * 6.6).toFixed(0)} ms（降幅 89%）`);
