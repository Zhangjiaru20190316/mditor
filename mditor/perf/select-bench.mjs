// 精简选择链路基准（第二轮专用）：reload → 打开文档 → 静置 → 只跑
// dragSelect / tripleClick / clickFormula 三个场景。单轮 ~2 分钟，供同窗口
// ABAB 交错对比（整机负载会漂移，跨时段单轮对比不可信——2026-08-27 教训）。
//
// 用法：node perf/select-bench.mjs <标签> [轮数=1]
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findPageTarget, Cdp, mouse, sleep, LONGTASK_RECORDER, FRAME_RECORDER } from "./cdp.mjs";

const label = process.argv[2] ?? "sel";
const rounds = Number(process.argv[3] ?? 1);
const here = dirname(fileURLToPath(import.meta.url));
const DOC_NAME = "一元微分学习题集";

const EVENT_RECORDER = `(() => {
  if (window.__evRec) return 'already';
  const buf = [];
  window.__evRec = {
    events: buf,
    start() { buf.length = 0; this.obs?.disconnect();
      this.obs = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) buf.push({ t: Math.round(e.startTime), d: Math.round(e.duration), type: e.name });
      });
      this.obs.observe({ type: 'event', durationThreshold: 16 }); },
    stop() { this.obs?.disconnect();
      const sorted = buf.slice().sort((a,b)=>a.d-b.d);
      const q = (p) => sorted.length ? sorted[Math.floor(sorted.length*p)].d : 0;
      return { n: buf.length, p50: q(0.5), p95: q(0.95), max: sorted.length ? sorted[sorted.length-1].d : 0, events: buf.slice(0, 20) }; },
  };
  return 'installed';
})()`;

const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);
await cdp.eval(LONGTASK_RECORDER);
await cdp.eval(EVENT_RECORDER);
const lt = { start: () => cdp.eval("window.__ltRecorder.start()"), stop: async () => (await cdp.eval("window.__ltRecorder.stop()")).events };
const ev = { start: () => cdp.eval("window.__evRec.start()"), stop: () => cdp.eval("window.__evRec.stop()") };

// ---- reload + 打开文档 + 静置 -------------------------------------------------
await cdp.eval("location.reload()");
await sleep(2500);
await cdp.eval(LONGTASK_RECORDER);
await cdp.eval(EVENT_RECORDER);
let tries = 0;
while (!(await cdp.eval(`!!document.querySelector('.ProseMirror')`))) {
  if (++tries > 40) throw new Error("reload 后编辑器未就绪");
  await sleep(500);
}
let row = null;
for (let i = 0; i < 30 && !row; i++) {
  row = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.ft-row.ft-file')];
    const hit = rows.find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes('${DOC_NAME}'));
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!row) await sleep(500);
}
await m.click(row.x, row.y);
let settle = 0, lastCount = -1, stable = 0;
while (settle < 40) {
  await sleep(250);
  const n = await cdp.eval(`document.querySelector('.ProseMirror')?.children.length ?? 0`);
  if (n > 100 && n === lastCount) { stable++; if (stable >= 3) break; } else stable = 0;
  lastCount = n; settle++;
}
await sleep(2500); // 打开后余波落定

const results = { label, ts: new Date().toISOString(), rounds: [] };

for (let round = 1; round <= rounds; round++) {
  const r = { round, dragSelect: null, tripleClick: null, clickFormula: null };

  // ---- 拖选 ------------------------------------------------------------------
  {
    const p = await cdp.eval(`(() => {
      const pm = document.querySelector('.ProseMirror');
      const host = document.querySelector('.mditor-editor-host');
      const kids = [...pm.children];
      const k = kids.slice(300).find(el => el.tagName === 'P' && (el.textContent ?? '').trim().length >= 60);
      if (!k) return null;
      host.scrollTop = Math.max(0, k.offsetTop - 150);
      return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
        const rc = k.getBoundingClientRect();
        res({ x1: Math.round(rc.x + rc.width * 0.25), x2: Math.round(rc.x + rc.width * 0.75), y: Math.round(rc.y + rc.height / 2) });
      })));
    })()`);
    await sleep(1200);
    await lt.start(); await ev.start();
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x1, y: p.y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 10; i++) {
      const x = Math.round(p.x1 + ((p.x2 - p.x1) * i) / 10);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: p.y, button: "left", buttons: 1 });
      await sleep(40);
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x2, y: p.y, button: "left", clickCount: 1 });
    await sleep(600);
    r.dragSelect = { longtasks: await lt.stop(), events: await ev.stop() };
    await sleep(300);
  }

  // ---- 三击选段 ----------------------------------------------------------------
  {
    const p = await cdp.eval(`(() => {
      const pm = document.querySelector('.ProseMirror');
      const kids = [...pm.children];
      const k = kids.slice(300).find(el => el.tagName === 'P' && (el.textContent ?? '').trim().length >= 60);
      if (!k) return null;
      const rc = k.getBoundingClientRect();
      return { x: Math.round(rc.x + Math.min(rc.width / 2, 200)), y: Math.round(rc.y + rc.height / 2) };
    })()`);
    await lt.start(); await ev.start();
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 3 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 3 });
    await sleep(800);
    r.tripleClick = { longtasks: await lt.stop(), events: await ev.stop() };
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(300);
  }

  // ---- 点公式 → 点正文 ---------------------------------------------------------
  {
    const p = await cdp.eval(`(() => {
      const pm = document.querySelector('.ProseMirror');
      const host = document.querySelector('.mditor-editor-host');
      const spans = [...pm.querySelectorAll('span[data-type="math_inline"]')];
      if (!spans.length) return null;
      const span = spans[Math.floor(spans.length / 2)];
      const par = span.closest('p');
      host.scrollTop = Math.max(0, span.offsetTop - 200);
      return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
        const rc = span.getBoundingClientRect();
        const prc = par.getBoundingClientRect();
        res({ fx: Math.round(rc.x + rc.width / 2), fy: Math.round(rc.y + rc.height / 2), px: Math.round(prc.x + Math.min(prc.width / 2, 200)), py: Math.round(prc.y + Math.min(prc.height, 80)) });
      })));
    })()`);
    await sleep(1500);
    if (!p) {
      // big 档关闭了 Latex 特性（无 math_inline DOM）——记录空结果而非崩溃。
      r.clickFormula = { skipped: "no math_inline (big mode disables Latex)", longtasks: [], events: { n: 0, p50: 0, p95: 0, max: 0 } };
      results.rounds.push(r);
      console.log(`round ${round}:`, "drag max=" + r.dragSelect.events.max, "triple max=" + r.tripleClick.events.max, "formula=skipped(big)");
      continue;
    }
    await lt.start(); await ev.start();
    for (let i = 0; i < 3; i++) {
      await m.click(p.fx, p.fy); await sleep(350);
      await m.click(p.px, p.py); await sleep(350);
    }
    r.clickFormula = { longtasks: await lt.stop(), events: await ev.stop() };
    await sleep(400);
  }

  results.rounds.push(r);
  console.log(`round ${round}:`,
    "drag max=" + r.dragSelect.events.max,
    "triple max=" + r.tripleClick.events.max,
    "formula max=" + r.clickFormula.events.max);
}

mkdirSync(join(here, "results"), { recursive: true });
const out = join(here, "results", `sel-${label}.json`);
const prev = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
const merged = prev && Array.isArray(prev.rounds) ? { ...results, rounds: [...prev.rounds, ...results.rounds] } : results;
writeFileSync(out, JSON.stringify(merged, null, 1), "utf8");
console.log("saved:", out, "(rounds total:", merged.rounds.length + ")");
cdp.close();
