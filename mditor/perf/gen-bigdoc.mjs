// 生成大文档压测副本：把 fixtures 里的习题集重复 N 份拼成 ~1MB 样本。
// 用途：≥1MB 档位的打开/交互/导出/搜索/保存基准（阶段 1 摸底）。
// 产物只进 perf/fixtures（dev 实例的预置工作区），不碰真实笔记。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "fixtures", "一元微分学习题集_CMC备战.md");
const out = join(here, "fixtures", "一元微分学习题集_1MB压测副本.md");

const base = readFileSync(src, "utf8");
const parts = [];
let n = 0;
while (parts.reduce((s, p) => s + p.length, 0) + base.length < 1.1 * 1024 * 1024) {
  n++;
  parts.push(`\n\n<!-- ===== 压测副本第 ${n} 段 ===== -->\n\n` + base);
}
const doc = parts.join("");
writeFileSync(out, doc, "utf8");
const lines = doc.split("\n").length;
console.log(`生成 ${out}`);
console.log(`段数=${n} 字符=${doc.length} 行数=${lines} 大小=${(Buffer.byteLength(doc, "utf8") / 1024).toFixed(0)}KB`);
