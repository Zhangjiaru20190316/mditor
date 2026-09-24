// G2 口径差异归因（tmp）：复刻 baseline.mjs 的 open→clicks→select→dragSelect
// →tripleClick→clickFormula 前置场景，再跑同口径 typing 场景。对照 g2-typing.mjs
// （新鲜打开即打字）可分离「前置交互状态」带来的每键增量。
// 用法：node perf/tmp-g2-ctx-typing.mjs <标签> [--profile]
//   --profile  打字段挂 CDP Profiler（500µs 采样）并落 .cpuprofile + self-time 聚合
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findPageTarget, Cdp, mouse, typeText, sleep, LONGTASK_RECORDER } from "./cdp.mjs";

const label = process.argv[2] ?? "ctx";
const doProfile = process.argv.includes("--profile");
const here = dirname(fileURLToPath(import.meta.url));
const DOC_NAME = process.env.MDITOR_DOC ?? "一元微分学习题集_1MB压测副本";

const scrollBlockIntoView = (idx) => `(() => {
  const pm = document.querySelector('.ProseMirror');
  const host = document.querySelector('.mditor-editor-host');
  if (!pm || !host) return null;
  const kids = pm.children;
  if (!kids.length) return null;
  const k = kids[Math.min(${idx}, kids.length - 1)];
  host.scrollTop = Math.max(0, k.offsetTop - 150);
  return true;
})()`;
const blockRect = (idx) => `(() => {
  const pm = document.querySelector('.ProseMirror');
  if (!pm) return null;
  const kids = pm.children;
  const k = kids[Math.min(${idx}, kids.length - 1)];
  const r = k.getBoundingClientRect();
  return { x: Math.round(r.x + Math.min(r.width / 2, 300)), y: Math.round(r.y + Math.min(r.height / 2, 120)), tag: k.tagName };
})()`;
const docReady = `(() => {
  const pm = document.querySelector('.ProseMirror');
  return pm ? pm.children.length : 0;
})()`;
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
      return { n: buf.length, p50: q(0.5), p95: q(0.95), max: sorted.length ? sorted[sorted.length-1].d : 0 }; },
  };
  return 'installed';
})()`;

const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);
if (doProfile) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
}
const lt = { start: () => cdp.eval("window.__ltRecorder.start()"), stop: async () => (await cdp.eval("window.__ltRecorder.stop()")).events ?? [] };

// ---- 场景 1：open（与 baseline.mjs 逐步一致）--------------------------------
await cdp.eval("location.reload()");
await sleep(2500);
await cdp.eval(LONGTASK_RECORDER);
await cdp.eval(EVENT_RECORDER);
let bootTries = 0;
while (!(await cdp.eval(`!!document.querySelector('.ProseMirror')`))) {
  if (++bootTries > 40) throw new Error("reload 后编辑器未就绪");
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
if (!row) throw new Error("文件树里找不到目标文档");
await m.click(row.x, row.y);
let settle = 0, lastCount = -1, stable = 0;
while (settle < 40) {
  await sleep(250);
  const n = await cdp.eval(docReady);
  if (n > 100 && n === lastCount) { stable++; if (stable >= 3) break; } else stable = 0;
  lastCount = n; settle++;
}
await sleep(1500);
console.log("open settled, blocks:", lastCount);

// ---- 场景 2：clicks（10 次跨区点击）------------------------------------------
for (let i = 60; i < 60 + 10; i++) {
  await cdp.eval(scrollBlockIntoView(i * 37));
  await sleep(90);
  const r = await cdp.eval(blockRect(i * 37));
  if (r) await m.click(r.x, r.y);
  await sleep(220);
}
console.log("clicks done");

// ---- 场景 3：双击选词 ---------------------------------------------------------
{
  const r = await cdp.eval(`(() => {
    const pm = document.querySelector('.ProseMirror');
    const host = document.querySelector('.mditor-editor-host');
    const kids = [...pm.children];
    const k = kids.slice(500).find(el => el.tagName === 'P' && (el.textContent ?? '').trim().length >= 30);
    if (!k) return null;
    host.scrollTop = Math.max(0, k.offsetTop - 150);
    return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
      const rc = k.getBoundingClientRect();
      res({ x: Math.round(rc.x + Math.min(rc.width / 2, 200)), y: Math.round(rc.y + Math.min(rc.height / 2, 100)) });
    })));
  })()`);
  await m.click(r.x, r.y); await sleep(60);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 2 });
  await sleep(80);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 2 });
  await sleep(350);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}
console.log("select done");

// ---- 场景 3b：dragSelect ------------------------------------------------------
{
  const r = await cdp.eval(`(() => {
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
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x1, y: r.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 10; i++) {
    const x = Math.round(r.x1 + ((r.x2 - r.x1) * i) / 10);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: r.y, button: "left", buttons: 1 });
    await sleep(40);
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x2, y: r.y, button: "left", clickCount: 1 });
  await sleep(600);
  await sleep(300);
}
console.log("dragSelect done");

// ---- 场景 3c：tripleClick -----------------------------------------------------
{
  const r = await cdp.eval(`(() => {
    const pm = document.querySelector('.ProseMirror');
    const kids = [...pm.children];
    const k = kids.slice(300).find(el => el.tagName === 'P' && (el.textContent ?? '').trim().length >= 60);
    if (!k) return null;
    const rc = k.getBoundingClientRect();
    return { x: Math.round(rc.x + Math.min(rc.width / 2, 200)), y: Math.round(rc.y + rc.height / 2) };
  })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 3 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 3 });
  await sleep(800);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(300);
}
console.log("tripleClick done");

// ---- 场景 3d：clickFormula ----------------------------------------------------
{
  const r = await cdp.eval(`(() => {
    const pm = document.querySelector('.ProseMirror');
    const host = document.querySelector('.mditor-editor-host');
    const spans = [...pm.querySelectorAll('span[data-type="math_inline"]')];
    if (!spans.length) return null;
    const span = spans[Math.floor(spans.length / 2)];
    const p = span.closest('p');
    host.scrollTop = Math.max(0, span.offsetTop - 200);
    return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
      const rc = span.getBoundingClientRect();
      const prc = p.getBoundingClientRect();
      res({ fx: Math.round(rc.x + rc.width / 2), fy: Math.round(rc.y + rc.height / 2), px: Math.round(prc.x + Math.min(prc.width / 2, 200)), py: Math.round(prc.y + Math.min(prc.height, 80)) });
    })));
  })()`);
  await sleep(1500);
  for (let i = 0; i < 3; i++) {
    await m.click(r.fx, r.fy); await sleep(350);
    await m.click(r.px, r.py); await sleep(350);
  }
  await sleep(400);
}
console.log("clickFormula done");

// ---- 场景 4：typing（同 baseline.mjs 口径，可选 profiler）---------------------
await cdp.eval(scrollBlockIntoView(700));
await sleep(120);
const r = await cdp.eval(blockRect(700));
await m.click(r.x, r.y);
await sleep(250);
await lt.start();
await cdp.eval("window.__evRec.start()");
if (doProfile) await cdp.send("Profiler.start");
await typeText(cdp, "性能基准输入测试xyz", { delay: 60 });
await sleep(400);
if (doProfile) var { profile } = await cdp.send("Profiler.stop");
const longtasks = await lt.stop();
const ev = await cdp.eval("window.__evRec.stop()");

// 撤销恢复（防污染）
for (let i = 0; i < 12; i++) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90 });
  await sleep(100);
}

const out = { label, ts: new Date().toISOString(), profiled: doProfile, blocks: lastCount, typingEvents: ev, typingLongtasks: longtasks.filter((e) => e.d > 50) };
console.log(`ctx-typing [${label}]: ev=${JSON.stringify(ev)} lt>50=${out.typingLongtasks.length} ltMax=${out.typingLongtasks.length ? Math.max(...out.typingLongtasks.map((e) => e.d)) : 0}`);

mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", `tmp-ctx-typing-${label}.json`), JSON.stringify(out, null, 1));

if (doProfile && profile) {
  writeFileSync(join(here, "results", `profile-typing-ctx-${label}.cpuprofile`), JSON.stringify(profile));
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }
  const agg = new Map();
  for (const [id, us] of self) {
    const cf = byId.get(id)?.callFrame;
    if (!cf) continue;
    const key = `${cf.functionName || "(anon)"} @ ${(cf.url || "").split("/").slice(-1)[0]}:${cf.lineNumber + 1}`;
    agg.set(key, (agg.get(key) ?? 0) + us);
  }
  const sorted = [...agg.entries()].sort((a, b) => b[1] - a[1]);
  const total = [...agg.values()].reduce((a, b) => a + b, 0);
  console.log("sampled:", Math.round(total / 1000) + "ms", "top self-time:");
  for (const [k, us] of sorted.slice(0, 25)) console.log(" ", (us / 1000).toFixed(1).padStart(8), "ms ", k);
}
cdp.close();
