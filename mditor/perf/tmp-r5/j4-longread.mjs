// j4-longread.mjs —— 挂靠运行中实例的 J4 长会话滚读采样（一次性）
import { findPageTarget, Cdp, mouse, sleep } from "../cdp.mjs";
import { writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RESULTS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "results");

const target = await findPageTarget(9223, 15000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);
const cx = 640, cy = 400;
const row = { ts: new Date().toISOString(), scenario: "longread-attach", windows: [], f1: null, counters: null };

// 开密度档文档
for (let i = 0; i < 40; i++) {
  const p = await cdp.eval(`(() => {
    const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes('无穷级数_密度档'));
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    if (r.width === 0) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (p) { await m.click(p.x, p.y); break; }
  await sleep(500);
}
await sleep(8000);
console.log("doc opened, big=", await cdp.eval(`!!document.querySelector('.mditor-editor-host')?.dataset.big`));

const t0 = Date.now();
let dir = 1;
while (Date.now() - t0 < 180_000) {
  await m.wheel(cx, cy, 0, dir * 300);
  await sleep(400);
  const top = await cdp.eval(`Math.round(document.querySelector('.mditor-editor-host')?.scrollTop ?? -1)`);
  if (top > 60000) dir = -1; else if (top < 300) dir = 1;
  // 每 30s 记一个窗口帧统计（__scrollDebug frameStats 窗口字段 + 清窗）
  if ((Date.now() - t0) % 30000 < 500) {
    const fs = await cdp.eval(`(() => {
      const s = window.__scrollDebug;
      if (!s) return null;
      const f = s.frameStats();
      const c = s.counters();
      return { windowWorstGapMs: f.windowWorstGapMs, windowJank: f.jankFrames, ghost: c['session.ghost'] ?? 0 };
    })()`);
    if (fs) row.windows.push({ atSec: Math.round((Date.now() - t0) / 1000), ...fs });
    await cdp.eval(`window.__scrollDebug && window.__scrollDebug.clear()`);
  }
}
const final = await cdp.eval(`(() => {
  const host = document.querySelector('.mditor-editor-host');
  const vh = host ? host.clientHeight : 0;
  let unready = 0;
  if (host) for (const el of document.querySelectorAll('.mditor-math-inline-lazy:not(.mditor-math-inline-ready)')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > 0 && r.top < vh) unready++;
  }
  return { unready, katexErr: document.querySelectorAll('.katex-error').length };
})()`);
row.f1 = final;
row.counters = await cdp.eval(`window.__scrollDebug ? window.__scrollDebug.counters() : null`);
writeFileSync(join(RESULTS, "r5-j4-longread.json"), JSON.stringify(row));
console.log("J4 windows:", JSON.stringify(row.windows));
console.log("final:", JSON.stringify(final));
cdp.close();
