// exp-demote.mjs —— R8 阶段四 exp4 可证伪实验：临时禁用 demote（DEMOTE_DELAY
// 改 1h）后跑 1MB 冷区慢滚双臂（up-slow / 深位 down-slow），验证冷区滚动掉帧
// 是否由 demote 回带重挂驱动。原型开关，不合入，跑完恢复（finally 保底）。
// 用法：node perf/tmp-r8/exp-demote.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..", "..");
const SRC = resolve(MDITOR_DIR, "src/lib/lazyInlineMath.ts");
const ORIG = readFileSync(SRC, "utf8");
const MARKER = "const DEMOTE_DELAY = 2500;";
const PATCHED = "const DEMOTE_DELAY = 3_600_000; // r8 tmp: disabled for falsification";
if (!ORIG.includes(MARKER)) { console.error("marker not found, abort"); process.exit(2); }
try {
  writeFileSync(SRC, ORIG.replace(MARKER, PATCHED), "utf8");
  console.log("[patched] DEMOTE_DELAY -> 1h");
  for (const extra of [
    ["--scenario", "up-slow", "--doc", "1MB压测", "--tag", "r8expND", "--phase", "4", "--run", "1", "--prewarm-wait"],
    ["--scenario", "down-slow", "--doc", "1MB压测", "--tag", "r8expND", "--phase", "4", "--run", "1", "--prewarm-wait", "--start-depth", "0.6"],
  ]) {
    const st = spawnSync("node", ["perf/tmp-r8/probe-jank.mjs", ...extra], { cwd: MDITOR_DIR, encoding: "utf8" });
    console.log((st.stdout || "") + (st.stderr || ""));
  }
} finally {
  writeFileSync(SRC, ORIG, "utf8");
  console.log("[restored] DEMOTE_DELAY = 2500");
}
