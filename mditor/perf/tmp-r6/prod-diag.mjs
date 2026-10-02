// tmp-r6 一次性：打包版应用状态诊断——不入库
import { spawn, spawnSync } from "node:child_process";
import { Cdp, sleep } from "../cdp.mjs";
const child = spawn(process.env.USERPROFILE + "/Desktop/Tp/mditor/src-tauri/target/release/mditor.exe", [],
  { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9224" }, stdio: "ignore", windowsHide: true });
const kill = () => { try { spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); } catch {} };
process.on("exit", kill);
let target = null; const t0 = Date.now();
while (Date.now() - t0 < 45000) {
  try { const r = await fetch("http://127.0.0.1:9224/json", { signal: AbortSignal.timeout(700) });
    const p = (await r.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (p) { target = p; break; } } catch {}
  await sleep(1000);
}
if (!target) { console.log("CDP 未就绪"); kill(); process.exit(2); }
await sleep(6000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const st = await cdp.eval(`({
  pm: !!document.querySelector('.ProseMirror'),
  host: !!document.querySelector('.mditor-editor-host'),
  big: document.querySelector('.mditor-editor-host')?.dataset?.big ?? null,
  tabs: [...document.querySelectorAll('.tabbar-tab')].map(t => (t.textContent||'').trim().slice(0,30)),
  ftRows: document.querySelectorAll('.ft-row').length,
  ftVisible: [...document.querySelectorAll('.ft-row')].filter(r => r.getBoundingClientRect().width > 0).length,
  ftFiles: [...document.querySelectorAll('.ft-name')].slice(0,10).map(e => (e.textContent||'').slice(0,24)),
  sidebarCls: (document.querySelector('[class*=sidebar], [class*=Sidebar]')?.className || '').slice(0,60),
  activeDocChars: document.querySelector('.ProseMirror')?.textContent?.length ?? 0,
})`);
console.log(JSON.stringify(st, null, 1));
cdp.close(); kill();
process.exit(0);
