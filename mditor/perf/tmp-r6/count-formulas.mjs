// tmp-r6 一次性：fixture 公式画像（总数/唯一数）——不入库
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "fixtures");
for (const f of [
  "无穷级数_密度档压测副本.md",
  "解题技巧_密度档切换副本.md",
  "一元微分学习题集_1MB压测副本.md",
]) {
  const s = readFileSync(join(dir, f), "utf8");
  const inlineAll = s.match(/(?<!\\)\$[^\n$]+?(?<!\\)\$/g) || [];
  const uniq = new Set(inlineAll);
  const blocks = (s.match(/\$\$[\s\S]*?\$\$/g) || []).length;
  console.log(
    f,
    "chars=" + s.length,
    "inline=" + inlineAll.length,
    "uniqInline=" + uniq.size,
    "block=" + blocks
  );
}
