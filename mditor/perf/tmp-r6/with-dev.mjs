// tmp-r6 一次性：挂载型 perf 脚本编排器——起 dev（自 spawn PID 树）→ 等就绪
// → 顺序执行传入的命令 → 杀树。用法：
//   node perf/tmp-r6/with-dev.mjs "node perf/open-1mb.mjs 3 r6final" ["cmd2" ...]
// 不入库。
import { spawn, spawnSync } from "node:child_process";
import { openSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { sleep } from "../cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..", "..");
const FORENSICS = resolve(MDITOR_DIR, "..", ".workflow", "task2-forensics");
mkdirSync(FORENSICS, { recursive: true });
const logFd = openSync(resolve(FORENSICS, "devlog-r6-withdev.txt"), "a");
const log = (m) => { try { writeSync(logFd, `[${new Date().toISOString()}] ${m}\n`); } catch { /* */ } console.log(m); };

async function portReady() {
  try {
    const r = await fetch("http://127.0.0.1:9223/json", { signal: AbortSignal.timeout(700) });
    const p = (await r.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    return !!p;
  } catch { return false; }
}

const child = spawn("cmd.exe", ["/c", "npx", "tauri", "dev", "--config", "src-tauri/tauri.dev.conf.json"], {
  cwd: MDITOR_DIR, env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9223" },
  stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
});
child.stderr?.on("data", (d) => { try { writeSync(logFd, d); } catch { /* */ } });
const kill = () => { try { if (child.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); } catch { /* */ } };
process.on("exit", kill);
process.on("SIGINT", () => { kill(); process.exit(130); });

const t0 = Date.now();
while (Date.now() - t0 < 180_000) {
  if (await portReady()) break;
  await sleep(1500);
}
if (!(await portReady())) { log("dev CDP 未就绪"); kill(); process.exit(2); }
log("dev 就绪，执行挂载命令");
await sleep(2000);

let code = 0;
for (const cmd of process.argv.slice(2)) {
  log(`> ${cmd}`);
  const st = spawnSync("bash", ["-c", cmd], { cwd: MDITOR_DIR, encoding: "buffer", windowsHide: true });
  const out = st.stdout?.toString("utf8") ?? "";
  const err = st.stderr?.toString("utf8") ?? "";
  if (out.trim()) console.log(out.trim().split("\n").slice(-8).join("\n"));
  if (err.trim()) console.error(err.trim().split("\n").slice(-4).join("\n"));
  log(`exit=${st.status}`);
  if (st.status !== 0) code = st.status ?? 1;
}
kill();
closeSync(logFd);
process.exit(code);
