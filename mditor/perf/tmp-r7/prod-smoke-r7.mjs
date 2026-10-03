// tmp-r7 一次性：打包版（release）冒烟——R6 断言（公式挂载/泵出口/CSP）+
// R7 新增停滚漂移断言（滚动停 6s 观察窗，rAF 哨兵采样位移 >4px 帧数=0、
// 无程序化 scrollTop 写入）。CDP 9224（避让惯例）。不入库。
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

// 打开密集档文档（prod store = 用户真实库）
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
let opened = false;
for (const t of ["题型方法决策树", "密度档压测", "无穷级数"]) {
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
  if (!opened && t === "题型方法决策树") await expandDir("02_习题集");
}
await sleep(6000);
const big = await cdp.eval(`!!document.querySelector('.mditor-editor-host')?.dataset.big`);
console.log(`打开文档: ${opened} big=${big}`);

// 滚动 12 步 + 静止 3s（R6 断言口径）
const cx = 640, cy = 400;
for (let i = 0; i < 12; i++) { await m.wheel(cx, cy, 0, 350); await sleep(180); }
await sleep(3000);

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

// —— R7 断言：再滚动 8 步（触发新 demote 潮到期窗口）→ 装 6s rAF 哨兵采样器 ——
for (let i = 0; i < 8; i++) { await m.wheel(cx, cy, 0, 350); await sleep(160); }
await sleep(420); // 静止门生效
const baseCounters = await cdp.eval(`window.__scrollDebug ? window.__scrollDebug.counters() : null`);
const startRes = await cdp.eval(`(() => {
  const host = document.querySelector('.mditor-editor-host');
  const pm = host && host.querySelector('.ProseMirror');
  if (!host || !pm) return 'no-host';
  const hr = host.getBoundingClientRect();
  const sents = [];
  const fr = [0.12, 0.5, 0.85];
  for (let i = 0; i < 3; i++) {
    const y = hr.top + hr.height * fr[i];
    for (const el of pm.children) { const r = el.getBoundingClientRect();
      if (r.height < 8) continue; if (r.top >= y - 4 && r.top <= y + hr.height * 0.3) { sents.push({ el }); break; } }
  }
  window.__r7smoke = { frames: 0, shifts: 0, stChanges: 0, done: false };
  const rec = window.__r7smoke;
  let prev = null;
  const tick = () => {
    const st = host.scrollTop;
    const row = { st, tops: sents.map((s) => s.el.isConnected ? s.el.getBoundingClientRect().top : null) };
    rec.frames++;
    if (prev) {
      if (Math.abs(row.st - prev.st) > 0.5) rec.stChanges++;
      for (let i = 0; i < row.tops.length; i++) {
        const a = prev.tops[i], b = row.tops[i];
        if (a != null && b != null && Math.abs(b - a) > 4) { rec.shifts++; break; }
      }
    }
    prev = row;
    if (rec.frames < 360) requestAnimationFrame(tick); else rec.done = true;
  };
  requestAnimationFrame(tick);
  return 'started:' + sents.length;
})()`);
console.log("采样器:", startRes);
await sleep(7000);
const drift = await cdp.eval(`window.__r7smoke ? JSON.parse(JSON.stringify(window.__r7smoke)) : null`);
const endCounters = await cdp.eval(`window.__scrollDebug ? window.__scrollDebug.counters() : null`);
let progWrites = 0;
if (baseCounters && endCounters) {
  for (const k of Object.keys(endCounters)) if (String(k).startsWith("write.") && (endCounters[k] ?? 0) !== (baseCounters[k] ?? 0)) progWrites += endCounters[k] - (baseCounters[k] ?? 0);
}
console.log("r7 断言:", JSON.stringify(drift), "progWrites:", progWrites);

try { const ss = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(MDITOR_DIR, "perf", "results", "r7-prod-smoke.png"), Buffer.from(ss.data, "base64")); } catch { /* */ }
cdp.close();
kill();
const ok = info.lazy > 0 && info.katex > 0 && info.vpUnready === 0 && info.pump >= 0
  && drift && drift.shifts === 0 && drift.stChanges === 0 && progWrites === 0;
console.log(ok ? "PASS" : "CHECK-FAIL");
process.exit(ok ? 0 : 1);
