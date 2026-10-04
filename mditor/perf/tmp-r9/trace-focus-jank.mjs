// trace-focus-jank.mjs —— R9 阶段二：CDP Tracing 定位 focus 掉帧帧的渲染管线环节
//（一次性，不入库）。focus/normal 各滚一段慢滚，抓 devtools.timeline trace，
// 对比每帧 Layout/Paint/Composite/ParseHTML 时长分布。
// 用法：node perf/tmp-r9/trace-focus-jank.mjs [--doc 题型方法] [--depth 0.6] [--tag r9p2t]
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
const args = { doc: "题型方法", depth: 0.6, tag: "r9p2t" };
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--doc") args.doc = process.argv[++i];
  else if (process.argv[i] === "--depth") args.depth = Number(process.argv[++i]);
  else if (process.argv[i] === "--tag") args.tag = process.argv[++i];
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
if (!target) { console.log("FAIL: CDP 未就绪"); kill(); process.exit(2); }
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);
for (let i = 0; i < 40; i++) { if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break; await sleep(1000); }
await sleep(2000);
// 开文档（el.click 直接触发，沿承 prod-focus-jank run5 验证过的路径）
for (const d of ["01_专题笔记"]) {
  await cdp.eval(`(() => { const hit = [...document.querySelectorAll('.ft-row.ft-dir')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes(${JSON.stringify(d)})); if (hit) hit.click(); return !!hit; })()`);
  await sleep(1500);
}
let opened = false;
for (let i = 0; i < 12 && !opened; i++) {
  opened = await cdp.eval(`(() => { const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes(${JSON.stringify(args.doc)})); if (!hit) return false; hit.click(); return true; })()`);
  if (!opened) await sleep(800);
}
if (!opened) { console.log("FAIL: 文档未开"); kill(); process.exit(2); }
console.log("文档已开");
await sleep(8000);
await cdp.eval(`(() => { const sd = window.__scrollDebug; if (!sd) return false; const es = typeof sd.events === 'function' ? sd.events() : sd.events; return (es ?? []).some(e => e.kind === 'prewarm.done'); })()`);
console.log("预热态确认");

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

// trace 收集器
async function traceSegment(mode, startTop) {
  const events = [];
  const collect = (params) => { for (const e of params.value) events.push(e); };
  cdp.on("Tracing.dataCollected", collect);
  await cdp.send("Tracing.start", { transferMode: "ReportEvents", categories: "devtools.timeline", options: "sampling-frequency=10000" });
  await fast(startTop - (await cdp.eval(READ_GEO)).top);
  await sleep(1500);
  // 慢滚 5000px
  const n = Math.ceil(5000 / 220);
  for (let i = 0; i < n; i++) await wheel(220, 450);
  await sleep(1000);
  await cdp.send("Tracing.end");
  await sleep(2500);
  cdp.handlers.get("Tracing.dataCollected")?.splice(0);
  return events;
}

// normal 臂先滚（预热已完成的区间 0.55 深度）
const out = { ts: new Date().toISOString(), tag: args.tag, ok: false };
for (const mode of ["normal", "focus", "normal2"]) {
  const want = mode !== "normal";
  const g = await setMode(want);
  if (!g) { console.log(`FAIL: 切换 ${mode}`); break; }
  await sleep(2000);
  const geo = await cdp.eval(READ_GEO);
  const base = Math.round((geo.h - geo.vh) * args.depth) + (mode === "normal" ? 0 : mode === "focus" ? 10000 : 20000);
  console.log(`${mode}: vh=${geo.vh} pw=${geo.pw} 起点=${base}`);
  const evs = await traceSegment(mode, base);
  const summary = { mode, vh: geo.vh, pw: geo.pw, events: evs.length };
  // 每类事件时长合计与 >8ms 明细
  const byName = {};
  for (const e of evs) {
    if (e.ph !== "X") continue;
    const dur = e.dur ?? 0;
    if (!byName[e.name]) byName[e.name] = { count: 0, totalMs: 0, maxMs: 0 };
    byName[e.name].count++;
    byName[e.name].totalMs += dur / 1000;
    byName[e.name].maxMs = Math.max(byName[e.name].maxMs, dur / 1000);
  }
  const top = Object.entries(byName).sort((a, b) => b[1].totalMs - a[1].totalMs).slice(0, 14)
    .map(([n, v]) => `${n}: ${v.count}x ${v.totalMs.toFixed(0)}ms max${v.maxMs.toFixed(1)}`);
  console.log(top.join("\n"));
  summary.byName = byName;
  out[mode] = summary;
  writeFileSync(join(RESULTS_DIR, `r9-phase2-trace-${mode}-${args.tag}.json`), JSON.stringify({ ...out[mode], raw: evs.length < 60000 ? evs : evs.filter(e => e.ph === "X") }));
  await setMode(false);
  await sleep(1000);
}
out.ok = true;
writeFileSync(join(RESULTS_DIR, `r9-phase2-trace-summary-${args.tag}.json`), JSON.stringify(out));
console.log("done");
kill();
process.exit(0);
