// G2 聚焦基准：与 baseline.mjs typing 场景同口径（第 700 块点入 → 逐键 60ms
// 打 9 字 → 事件延迟 p95 + 长任务），供 A/B 代码版本交错对比。
// 用法：node perf/g2-typing.mjs <标签>   → perf/results/g2-<标签>.json
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findPageTarget, Cdp, mouse, sleep, typeText, LONGTASK_RECORDER } from "./cdp.mjs";

const label = process.argv[2] ?? "run";
const here = dirname(fileURLToPath(import.meta.url));

const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);
await cdp.send("Runtime.enable");
try {
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
} catch { /* 尽力 */ }
await cdp.send("Page.enable");
await cdp.send("Page.reload", { ignoreCache: true });
await sleep(2500);
for (let k = 0; k < 40; k++) {
  const ok = await cdp.eval(`document.querySelectorAll('.ft-row.ft-file').length >= 1`);
  if (ok) break;
  await sleep(500);
}
const r0 = await cdp.eval(`(() => {
  const rows = [...document.querySelectorAll('.ft-row.ft-file')];
  const hit = rows.find(row => (row.querySelector('.ft-name')?.textContent ?? '').includes('1MB'));
  if (!hit) return null;
  hit.scrollIntoView({block:'center'});
  const rc = hit.getBoundingClientRect();
  return {x: Math.round(rc.x+80), y: Math.round(rc.y+rc.height/2)};
})()`);
if (!r0) throw new Error("no row");
await m.click(r0.x, r0.y);
// 等稳定
let last = -1, stable = 0;
while (stable < 4) {
  await sleep(600);
  const b = await cdp.eval(`document.querySelector('.ProseMirror')?.children.length ?? 0`);
  if (b === last && b > 1000) stable++; else stable = 0;
  last = b;
}

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

await cdp.eval(EVENT_RECORDER);
await cdp.eval(LONGTASK_RECORDER);

// 打字场景（同 baseline.mjs 口径）
await cdp.eval(`(() => {
  const pm = document.querySelector('.ProseMirror');
  const host = document.querySelector('.mditor-editor-host');
  const k = pm.children[700];
  host.scrollTop = Math.max(0, k.offsetTop - 150);
  return true;
})()`);
await sleep(120);
const r = await cdp.eval(`(() => {
  const pm = document.querySelector('.ProseMirror');
  const k = pm.children[700];
  const rc = k.getBoundingClientRect();
  return { x: Math.round(rc.x + Math.min(rc.width / 2, 300)), y: Math.round(rc.y + Math.min(rc.height / 2, 120)), tag: k.tagName };
})()`);
await m.click(r.x, r.y);
await sleep(250);
await cdp.eval("window.__ltRecorder.start()");
await cdp.eval("window.__evRec.start()");
await typeText(cdp, "性能基准输入测试xyz", { delay: 60 });
await sleep(400);
const lts = ((await cdp.eval("window.__ltRecorder.stop()")) ?? { events: [] }).events ?? [];
const ev = await cdp.eval("window.__evRec.stop()");

// 撤销（防污染）
for (let i = 0; i < 12; i++) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90 });
  await sleep(100);
}

const out = { label, blocks: last, ev, longtasks: lts };
console.log(`g2-typing [${label}]: ev=${JSON.stringify(ev)} lt>50=${lts.filter(e => e.d > 50).length} ltMax=${lts.length ? Math.max(...lts.map(e => e.d)) : 0}`);
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", `g2-${label}.json`), JSON.stringify(out, null, 1));
cdp.close();
