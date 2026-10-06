// diag-open.mjs —— R9 devgates 排障：手动起 dev，检查应用状态 + 开档点击方式对比
// 全 eval 带 8s 超时 + 逐行落盘 perf/tmp-r9/diag-open.log（防 CDP 死链黑盒）
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { Cdp, mouse, sleep } from "../cdp.mjs";
import { resolve } from "node:path";

const MDITOR_DIR = resolve(import.meta.dirname, "..", "..");
const PORT = 9223;
const LOGF = resolve(import.meta.dirname, "diag-open.log");
writeFileSync(LOGF, "");
const log = (s) => { appendFileSync(LOGF, s + "\n"); console.log(s); };
const wt = (p, ms = 8000) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

spawnSync("taskkill", ["/F", "/T", "/IM", "mditor.exe"], { stdio: "ignore" });
await sleep(2000);

const child = spawn("cmd.exe", ["/c", "npx", "tauri", "dev", "--config", "src-tauri/tauri.dev.conf.json"], {
  cwd: MDITOR_DIR,
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", "ignore", "ignore"], windowsHide: true,
});
log(`dev pid ${child.pid}`);

let target = null;
const t0 = Date.now();
while (Date.now() - t0 < 120_000) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(700) });
    const page = (await res.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page) { target = page; break; }
  } catch { /* */ }
  await sleep(1000);
}
if (!target) { log("CDP 未就绪"); spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); process.exit(1); }
log(`CDP 就绪 ${Math.round((Date.now() - t0) / 1000)}s`);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);

let pmOk = false;
for (let i = 0; i < 30; i++) { if (await wt(cdp.eval(`!!document.querySelector('.ProseMirror')`), 5000)) { pmOk = true; break; } log(`prewait ${i}...`); await sleep(1000); }
log(`ProseMirror: ${pmOk}`);
await sleep(3000);

const state = await wt(cdp.eval(`(() => {
  const rows = [...document.querySelectorAll('.ft-row')];
  const vis = rows.filter(r => r.getBoundingClientRect().width > 0);
  return {
    readyState: document.readyState,
    switching: !!document.querySelector('.is-switching'),
    ftRows: rows.length, ftVisible: vis.length,
    pmChildren: document.querySelector('.ProseMirror') ? document.querySelector('.ProseMirror').children.length : null,
    activeRow: (document.querySelector('.ft-row.ft-file.ft-active') || {}).textContent || null,
    dpr: window.devicePixelRatio, iw: innerWidth, ih: innerHeight, title: document.title,
  };
})()`), 10000);
log("STATE: " + JSON.stringify(state));

const row = await wt(cdp.eval(`(() => {
  const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent || '').includes('1MB压测'));
  if (!hit) return null;
  const r = hit.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`), 8000);
log("1MB row: " + JSON.stringify(row));
if (row) {
  await m.click(row.x, row.y);
  await sleep(4000);
  log("坐标点击后: " + JSON.stringify(await wt(cdp.eval(`(() => ({
    active: (document.querySelector('.ft-row.ft-file.ft-active') || {}).textContent || null,
    pmChildren: document.querySelector('.ProseMirror') ? document.querySelector('.ProseMirror').children.length : null }))()`), 8000)));
  log("el.click: " + await wt(cdp.eval(`(() => {
    const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent || '').includes('1MB压测'));
    if (!hit) return 'no-row';
    hit.click(); return 'clicked'; })()`), 8000));
  await sleep(6000);
  log("el.click 后: " + JSON.stringify(await wt(cdp.eval(`(() => ({
    active: (document.querySelector('.ft-row.ft-file.ft-active') || {}).textContent || null,
    pmChildren: document.querySelector('.ProseMirror') ? document.querySelector('.ProseMirror').children.length : null,
    switching: !!document.querySelector('.is-switching') }))()`), 8000)));
  for (let k = 0; k < 6; k++) {
    await sleep(5000);
    log(`+${(k + 1) * 5}s: ` + JSON.stringify(await wt(cdp.eval(`(() => ({
      active: (document.querySelector('.ft-row.ft-file.ft-active') || {}).textContent || null,
      pmChildren: document.querySelector('.ProseMirror') ? document.querySelector('.ProseMirror').children.length : null,
      big: !!document.querySelector('.mditor-editor-host[data-big]') }))()`), 8000)));
  }
}
try { cdp.close(); } catch { /* */ }
spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
log("done");
process.exit(0);
