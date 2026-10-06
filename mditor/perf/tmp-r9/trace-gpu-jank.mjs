// trace-gpu-jank.mjs —— R9 阶段二：GPU/光栅级 trace（gpu + 深度 timeline
// categories），抓 focus 掉帧 gap 期间的光栅/合成任务（一次性，不入库）。
// 用法：node perf/tmp-r9/trace-gpu-jank.mjs [--depth 0.55] [--tag r9p2t2]
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { Cdp, mouse, sleep } from "../cdp.mjs";

const PORT = 9224;
const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..", "..");
const RESULTS_DIR = join(MDITOR_DIR, "perf", "results");
const EXE = resolve(process.env.LOCALAPPDATA ?? "", "Mditor", "mditor.exe");
const a = { doc: "题型方法", depth: 0.55, tag: "r9p2t2", mode: "focus" };
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--depth") a.depth = Number(process.argv[++i]);
  else if (process.argv[i] === "--tag") a.tag = process.argv[++i];
  else if (process.argv[i] === "--mode") a.mode = process.argv[++i];
}
mkdirSync(RESULTS_DIR, { recursive: true });

const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore", windowsHide: true,
});
const kill = () => { try { spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); } catch { /* */ } };
process.on("exit", kill);
let target = null;
const t0 = Date.now();
while (Date.now() - t0 < 60_000) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(700) });
    target = (await res.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (target) break;
  } catch { /* */ }
  await sleep(1000);
}
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);
for (let i = 0; i < 40; i++) { if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break; await sleep(1000); }
await sleep(2000);
await cdp.eval(`(() => { const hit = [...document.querySelectorAll('.ft-row.ft-dir')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes("01_专题笔记")); if (hit) hit.click(); })()`);
await sleep(1500);
for (let i = 0; i < 12; i++) {
  const ok = await cdp.eval(`(() => { const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes(${JSON.stringify(a.doc)})); if (!hit) return false; hit.click(); return true; })()`);
  if (ok) break;
  await sleep(800);
}
console.log("文档已开");
await sleep(8000);

const READ_GEO = `(() => { const h = document.querySelector('.mditor-editor-host'); const pm = document.querySelector('.mditor-editor-host .ProseMirror'); return h ? { top: Math.round(h.scrollTop), h: Math.round(h.scrollHeight), vh: h.clientHeight, pw: pm ? Math.round(pm.clientWidth) : null, isFocus: document.querySelector('.app').classList.contains('is-focus') } : null; })()`;
const setMode = async (wantFocus) => {
  let geo = await cdp.eval(READ_GEO);
  if (geo.isFocus === wantFocus) return geo;
  if (wantFocus) {
    const p = await cdp.eval(`(() => { const b = document.querySelector('button.sb-icon-btn[title="焦点模式"]'); if (!b) return null; const r = b.getBoundingClientRect(); if (r.width === 0) return null; return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (p) await m.click(p.x, p.y);
  } else {
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }
  for (let i = 0; i < 30; i++) { await sleep(100); geo = await cdp.eval(READ_GEO); if (geo.isFocus === wantFocus) return geo; }
  return null;
};
const wheel = async (dy, pause) => { await m.wheel(640, 400, 0, dy); await sleep(pause); };
const fast = async (px) => { const n = Math.ceil(Math.abs(px) / 1200); for (let i = 0; i < n; i++) await wheel(Math.sign(px) * 1200, 90); };

const g0 = await setMode(a.mode === "focus");
if (!g0) { console.log("FAIL mode"); kill(); process.exit(2); }
await sleep(2000);
const geo = await cdp.eval(READ_GEO);
const base = Math.round((geo.h - geo.vh) * a.depth);
console.log(`${a.mode}: vh=${geo.vh} pw=${geo.pw} 起点=${base}`);
await fast(base - geo.top);
await sleep(1500);

const events = [];
cdp.on("Tracing.dataCollected", (p) => { for (const e of p.value) events.push(e); });
await cdp.send("Tracing.start", { transferMode: "ReportEvents",
  categories: "devtools.timeline,gpu,disabled-by-default-devtools.timeline.sequence" });
const n = Math.ceil(5000 / 220);
for (let i = 0; i < n; i++) await wheel(220, 450);
await sleep(1000);
await cdp.send("Tracing.end");
await sleep(4000);

// 分析：Presentation gap >32ms 时刻附近的光栅/GPU 任务
const pres = events.filter(e => e.name === "AnimationFrame::Presentation" && e.ph === "n").map(e => e.ts).sort((x, y) => x - y);
const gaps32 = [];
for (let i = 1; i < pres.length; i++) if ((pres[i] - pres[i-1]) / 1000 > 32) gaps32.push([pres[i-1], pres[i]]);
console.log(`presentations=${pres.length} gaps>32ms=${gaps32.length}`);
// GPU/raster 事件聚合（按名）
const gpuBy = {};
for (const e of events) {
  if (e.ph !== "X" || !/raster|Raster|GPU|gpu|Tile|Image|Decode|Acquire|Present|Swap/i.test(e.name)) continue;
  if (!gpuBy[e.name]) gpuBy[e.name] = { count: 0, totalMs: 0, maxMs: 0 };
  gpuBy[e.name].count++;
  gpuBy[e.name].totalMs += (e.dur ?? 0) / 1000;
  gpuBy[e.name].maxMs = Math.max(gpuBy[e.name].maxMs, (e.dur ?? 0) / 1000);
}
Object.entries(gpuBy).sort((x, y) => y[1].totalMs - x[1].totalMs).slice(0, 16)
  .forEach(([nm, v]) => console.log(`${nm}: ${v.count}x ${v.totalMs.toFixed(0)}ms max=${v.maxMs.toFixed(1)}`));
// 掉帧 gap 内的最大单事件（全线程）
const xe = events.filter(e => e.ph === "X").sort((x, y) => x.ts - y.ts);
for (const [t0w, t1w] of gaps32.slice(0, 12)) {
  const inGap = xe.filter(e => e.ts + (e.dur ?? 0) > t0w && e.ts < t1w && (e.dur ?? 0) > 1500)
    .sort((x, y) => (y.dur ?? 0) - (x.dur ?? 0)).slice(0, 4)
    .map(e => `${e.name.slice(0, 28)}/${((e.dur ?? 0) / 1000).toFixed(1)}ms`);
  console.log(`gap ${((t1w - t0w) / 1000).toFixed(0)}ms: ${inGap.join(" | ") || "(无>1.5ms)"}`);
}
writeFileSync(join(RESULTS_DIR, `r9-phase2-trace-gpu-${a.mode}-${a.tag}.json`),
  JSON.stringify({ mode: a.mode, vh: geo.vh, pw: geo.pw, summary: gpuBy, gaps32Count: gaps32.length, raw: events.filter(e => e.ph === "X") }));
console.log("done");
kill();
process.exit(0);
