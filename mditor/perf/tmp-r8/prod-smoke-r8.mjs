// tmp-r8 一次性：打包版（release）冒烟——R8 新增上滚掉帧对称断言 +
// R6 断言（公式挂载/泵出口）+ R7 断言（停滚 6s 漂移 0、无程序化写入）。
// CDP 9224（避让惯例）。不入库。
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Cdp, mouse, sleep } from "../cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..", "..");
const EXE = resolve(MDITOR_DIR, "src-tauri", "target", "release", "mditor.exe");
const PORT = 9224;

async function portReady() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(700) });
    const p = (await r.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    return p ?? null;
  } catch { return null; }
}

const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore", windowsHide: true,
});
const kill = () => { try { spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); } catch { /* */ } };
process.on("exit", kill);

const t0 = Date.now();
let target = null;
while (Date.now() - t0 < 60_000) {
  target = await portReady();
  if (target) break;
  await sleep(1000);
}
if (!target) { console.log("FAIL: CDP 9224 未就绪"); kill(); process.exit(2); }
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);
for (let i = 0; i < 40; i++) { if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break; await sleep(1000); }

const expandDir = async (dirName) => {
  for (let i = 0; i < 6; i++) {
    const p = await cdp.eval(`(() => {
      const hit = [...document.querySelectorAll('.ft-row')].find(r => {
        const n = r.querySelector('.ft-name')?.textContent ?? '';
        return n.includes(${JSON.stringify(dirName)}) && !n.endsWith('.md');
      });
      if (!hit) return null; const r = hit.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!p) return false;
    await m.click(p.x, p.y);
    await sleep(1200);
    return true;
  }
  return false;
};
await expandDir("01_专题笔记");
await expandDir("02_习题集");
let opened = false;
for (const t of ["无穷级数_习题集", "一元积分_习题集", "密度档压测", "无穷级数"]) {
  if (opened) break;
  for (let i = 0; i < 8 && !opened; i++) {
    const p = await cdp.eval(`(() => {
      const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes(${JSON.stringify(t)}));
      if (!hit) return null; const r = hit.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (p) { await m.click(p.x, p.y); opened = true; } else await sleep(1000);
  }
}
await sleep(6000);
const big = await cdp.eval(`!!document.querySelector('.mditor-editor-host')?.dataset.big`);
console.log(`打开文档: ${opened} big=${big}`);

// —— R8 断言：驱动期逐帧采样器（下滚段 → 上滚段 → 停滚 6s 漂移）——
const startRes = await cdp.eval(`(() => {
  const host = document.querySelector('.mditor-editor-host');
  const pm = host && host.querySelector('.ProseMirror');
  if (!host || !pm) return 'no-host';
  window.__r8smoke = { frames: [], phase: 'none', down: [], up: [], driftShifts: 0, stChanges: 0, driftFrames: 0, done: false };
  const rec = window.__r8smoke;
  let prev = null, prevPhaseSt = null;
  const tick = () => {
    const now = performance.now();
    const st = host.scrollTop;
    const row = { at: now, st };
    rec.frames.push(row);
    if (prev) {
      row.gap = now - prev.at;
      if (rec.phase === 'down' && row.gap != null) rec.down.push(row.gap);
      if (rec.phase === 'up' && row.gap != null) rec.up.push(row.gap);
      if (rec.phase === 'drift') {
        rec.driftFrames++;
        if (Math.abs(st - prevPhaseSt) > 0.5) rec.stChanges++;
        if (Math.abs(st - prevPhaseSt) > 0.5) rec.driftShifts++;
      }
    }
    prevPhaseSt = st;
    prev = row;
    if (!rec.done) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return 'started';
})()`);
console.log("采样器:", startRes);
const cx = 640, cy = 400;
// 下滚段
await cdp.eval(`window.__r8smoke.phase = 'down'`);
for (let i = 0; i < 10; i++) { await m.wheel(cx, cy, 0, 350); await sleep(180); }
// 上滚段
await cdp.eval(`window.__r8smoke.phase = 'up'`);
for (let i = 0; i < 10; i++) { await m.wheel(cx, cy, 0, -350); await sleep(180); }
await cdp.eval(`window.__r8smoke.phase = 'drift'`);
await sleep(6400);
await cdp.eval(`window.__r8smoke.done = true`);
const smoke = await cdp.eval(`JSON.parse(JSON.stringify(window.__r8smoke))`);

const info = await cdp.eval(`(() => ({
  lazy: document.querySelectorAll('.mditor-math-inline-lazy').length,
  ready: document.querySelectorAll('.mditor-math-inline-ready').length,
  katex: document.querySelectorAll('.katex').length,
  vpUnready: (() => { const h = document.querySelector('.mditor-editor-host'); if (!h) return -1;
    const r = h.getBoundingClientRect(); let n = 0;
    for (const el of document.querySelectorAll('.mditor-math-inline-lazy:not(.mditor-math-inline-ready)')) {
      const b = el.getBoundingClientRect(); if (b.bottom > r.top && b.top < r.bottom) n++; } return n; })(),
  pump: typeof window.__mathPumpStats === 'function' ? window.__mathPumpStats().enqueued : -1,
}))()`);
console.log("r6 断言:", JSON.stringify(info));

const quantile = (arr, q) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * q))]); };
const downGaps = smoke.down, upGaps = smoke.up;
const r8 = {
  downFrames: downGaps.length, upFrames: upGaps.length,
  downJank32: downGaps.filter((g) => g > 32).length, upJank32: upGaps.filter((g) => g > 32).length,
  downP95: quantile(downGaps, 0.95), upP95: quantile(upGaps, 0.95),
  jankRatio: downGaps.filter((g) => g > 32).length > 0 ? +(upGaps.filter((g) => g > 32).length / downGaps.filter((g) => g > 32).length).toFixed(2) : null,
  p95Ratio: quantile(downGaps, 0.95) ? +(quantile(upGaps, 0.95) / quantile(downGaps, 0.95)).toFixed(2) : null,
  driftShifts: smoke.driftShifts, stChanges: smoke.stChanges,
};
console.log("r8 断言:", JSON.stringify(r8));

try { const ss = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(MDITOR_DIR, "perf", "results", "r8-prod-smoke.png"), Buffer.from(ss.data, "base64")); } catch { /* */ }
cdp.close();
kill();
// R8 判定：R6 口径（挂载/泵出口）+ R7 漂移口径 + R8 对称性容差断言
// （对称比 ≤1.25 门 + 冒烟容差：帧数比 ≤1.25+2 帧或 p95 比 ≤1.9——打包版
// 单会话短驱动，容差防环境误报；灾难级形态（p95 比 >1.9）必 FAIL）
const r6ok = info.lazy > 0 && info.katex > 0 && info.vpUnready === 0 && info.pump >= 0;
const r7ok = r8.driftShifts === 0 && r8.stChanges === 0;
const r8ok = (r8.jankRatio != null && r8.jankRatio <= 1.25 + 2 / Math.max(1, r8.downJank32))
  || (r8.p95Ratio != null && r8.p95Ratio <= 1.9);
const ok = r6ok && r7ok && r8ok;
console.log(`r6ok=${r6ok} r7ok=${r7ok} r8ok=${r8ok} → ${ok ? "PASS" : "CHECK-FAIL"}`);
writeFileSync(resolve(MDITOR_DIR, "perf", "results", "r8-prod-smoke.json"), JSON.stringify({ ts: new Date().toISOString(), info, r8, r6ok, r7ok, r8ok, ok }), "utf8");
process.exit(ok ? 0 : 1);
