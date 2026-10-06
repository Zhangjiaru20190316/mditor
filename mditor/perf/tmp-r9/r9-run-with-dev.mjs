// r9-run-with-dev.mjs —— 起 dev 实例(9223) → 跑挂靠型基准脚本(open-1mb/g2-typing) → 树杀清理
// 用法：node perf/tmp-r9/r9-run-with-dev.mjs <命令...>
//   例：node perf/tmp-r9/r9-run-with-dev.mjs node perf/open-1mb.mjs 3 r9r1
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MDITOR_DIR = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const PORT = 9223;
const cmd = process.argv.slice(2);
if (!cmd.length) { console.error("no command"); process.exit(2); }

const killTree = () => { try { if (child?.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); } catch { /* */ } };

// 预杀残留 debug 实例（single-instance 转发会让新 dev 秒退、CDP 连错对象）
spawnSync("taskkill", ["/F", "/T", "/IM", "mditor.exe"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2000));

// 显式钉 store 的 bigDocViewport（R9 教训：挂靠型脚本的 R1/R2 口径依赖
// ambient store 状态，批间被其它脚本改动即混杂；MDITOR_SET_BIGDOC=on|off）
if (process.env.MDITOR_SET_BIGDOC) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const storePath = process.env.APPDATA + "\\com.mditor.app.dev\\mditor.json";
  const holder = JSON.parse(readFileSync(storePath, "utf8"));
  holder.settings.bigDocViewport = process.env.MDITOR_SET_BIGDOC === "on";
  writeFileSync(storePath, JSON.stringify(holder, null, 2), "utf8");
  console.log(`store 钉: bigDocViewport=${holder.settings.bigDocViewport}`);
}

let child = spawn("cmd.exe", ["/c", "npx", "tauri", "dev", "--config", "src-tauri/tauri.dev.conf.json"], {
  cwd: MDITOR_DIR,
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", "ignore", "ignore"], windowsHide: true,
});
console.log(`dev pid=${child.pid}，等 CDP ${PORT}...`);
process.on("exit", killTree);

let ok = false;
const t0 = Date.now();
while (Date.now() - t0 < 120_000) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(700) });
    const page = (await res.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page) { ok = true; break; }
  } catch { /* */ }
  await new Promise((r) => setTimeout(r, 1000));
}
if (!ok) { console.error("CDP 未就绪"); killTree(); process.exit(2); }
await new Promise((r) => setTimeout(r, 6000));

console.log(`dev 就绪，执行: ${cmd.join(" ")}`);
const inner = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", env: process.env, cwd: process.cwd() });
console.log(`内层退出码: ${inner.status}`);
killTree();
await new Promise((r) => setTimeout(r, 3000));
spawnSync("taskkill", ["/F", "/T", "/IM", "mditor.exe"], { stdio: "ignore" }); // debug 实例兜底
process.exit(inner.status ?? 1);
