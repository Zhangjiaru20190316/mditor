// tmp-r6 一次性：生成 >8,192 唯一公式超限 fixture（M-a 钉死）——脚本不入库
// 规格：密度档副本（2,355 行内/唯一 1,642）× 4 段，段 n 的每个行内公式前缀
// 注入 `{n} `（KaTeX 分组前缀，合法且渲染成本≈不变），使段间源码互异 →
// 唯一行内公式 4×2,355 = 9,420 > 8,192（超 katexCache LRU 上限）。
// 体量 ~420KB / ~8,600 行（isBigDocCv 行数阈值 3,000 生效）。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "fixtures", "无穷级数_密度档压测副本.md");
const out = join(here, "..", "fixtures", "无穷级数_唯一公式超限副本.md");

const base = readFileSync(src, "utf8");
const parts = [];
for (let n = 1; n <= 4; n++) {
  let k = 0;
  // 段标题（区分段）+ 公式唯一化前缀：段号+段内序号双前缀（段内亦有重复式，
  // 单段号不足以全唯一）——KaTeX 分组前缀合法且渲染成本≈不变
  const seg = base.replace(/(?<!\\)\$([^\n$]+?)(?<!\\)\$/g, (_m, inner) => `$\{${n}}\{${++k}} ${inner}$`);
  parts.push(`\n\n<!-- ===== 唯一公式超限副本第 ${n} 段 ===== -->\n\n` + seg);
}
const doc = parts.join("");
writeFileSync(out, doc, "utf8");
const inlineAll = doc.match(/(?<!\\)\$[^\n$]+?(?<!\\)\$/g) || [];
console.log(
  `生成 ${out}\nchars=${doc.length} lines=${doc.split("\n").length} inline=${inlineAll.length} uniq=${new Set(inlineAll).size}`
);
