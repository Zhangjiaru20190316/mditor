// tmp-r6 一次性：文件树渲染诊断——不入库
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { Cdp, sleep } from "../cdp.mjs";

const STORE = process.env.APPDATA + "/com.mditor.app.dev/mditor.json";
const raw = JSON.parse(readFileSync(STORE, "utf8"));
const holder = raw.settings ? raw : raw.value;
holder.settings.devMode = false; holder.settings.bigDocViewport = true; holder.settings.bigDocPerformance = false;
writeFileSync(STORE, JSON.stringify(raw, null, 2));
const child = spawn("cmd.exe", ["/c", "npx", "tauri", "dev", "--config", "src-tauri/tauri.dev.conf.json"], {
  cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1").slice(0, -1) && process.cwd(),
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9223" },
  stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
const t0 = Date.now(); let target = null;
while (Date.now() - t0 < 150000) {
  try { const r = await fetch("http://127.0.0.1:9223/json", { signal: AbortSignal.timeout(700) });
    const p = (await r.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (p) { target = p; break; } } catch { /* */ }
  await sleep(500);
}
if (!target) { console.log("CDP失败"); spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)]); process.exit(1); }
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
for (let i = 0; i < 30; i++) { if (await cdp.eval("!!document.querySelector('.ProseMirror')")) break; await sleep(500); }
await sleep(3000);
const st = await cdp.eval(`({ft: document.querySelectorAll('.ft-row').length,
  ftFile: document.querySelectorAll('.ft-row.ft-file').length,
  names: [...document.querySelectorAll('.ft-name')].slice(0,8).map(e=>e.textContent),
  anyFt: !!document.querySelector('[class*=ft-]'),
  pm: !!document.querySelector('.ProseMirror'),
  host: !!document.querySelector('.mditor-editor-host')})`);
console.log(JSON.stringify(st));
cdp.close();
spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
process.exit(0);
