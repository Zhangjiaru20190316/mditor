// exp-demdete.mjs —— R7 阶段四 D-e 可证伪实验：临时禁用 demote（DEMOTE_DELAY
// 改 1h）后跑 down-slow 场景，验证漂移是否归零。原型开关，不合入，跑完恢复。
// 用法：node perf/tmp-r7/exp-demdete.mjs   （内部：patch → probe → restore）
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..", "..");
const SRC = resolve(MDITOR_DIR, "src/lib/lazyInlineMath.ts");
const ORIG = readFileSync(SRC, "utf8");
const MARKER = "const DEMOTE_DELAY = 2500;";
const PATCHED = "const DEMOTE_DELAY = 3_600_000; // r7 tmp: disabled for falsification";
if (!ORIG.includes(MARKER)) { console.error("marker not found, abort"); process.exit(2); }
try {
  writeFileSync(SRC, ORIG.replace(MARKER, PATCHED), "utf8");
  console.log("[patched] DEMOTE_DELAY -> 1h");
  const st = spawnSync("node", ["perf/tmp-r7/probe-drift.mjs", "--scenario", "down-slow",
    "--doc", "无穷级数_密度档", "--tag", "r7p2d", "--run", "1"], { cwd: MDITOR_DIR, encoding: "utf8" });
  console.log((st.stdout || "") + (st.stderr || ""));
} finally {
  writeFileSync(SRC, ORIG, "utf8");
  console.log("[restored] DEMOTE_DELAY = 2500");
}
