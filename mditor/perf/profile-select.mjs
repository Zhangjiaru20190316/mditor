// 选择链路 CPU Profile（第二轮）：对 三击选段 / 点公式→点正文 / 拖选 三场景
// 分别录制 JS 采样剖面，按 self-time 聚合 Top 函数。
// 用法：node perf/profile-select.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findPageTarget, Cdp, mouse, sleep } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);

await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 500 });

function aggregate(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  let totalUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    if (!node) continue;
    const dt = profile.timeDeltas[i] ?? 0;
    totalUs += dt;
    const cf = node.callFrame;
    const key = `${cf.functionName || "(anon)"} @ ${(cf.url || "").split("/").slice(-2).join("/")}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + dt);
  }
  return { self, totalUs };
}

function report(name, { self, totalUs }) {
  console.log(`\n===== ${name}: sampled ${Math.round(totalUs / 1000)}ms =====`);
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22);
  for (const [k, us] of top) {
    const pct = ((us / totalUs) * 100).toFixed(1);
    if (Number(pct) < 0.5) break;
    console.log(String(Math.round(us / 1000)).padStart(6) + "ms " + pct.padStart(5) + "%  " + k);
  }
}

// 找目标段落/公式（与 select-bench 相同的定位逻辑）
const findP = `(() => {
  const pm = document.querySelector('.ProseMirror');
  const kids = [...pm.children];
  const k = kids.slice(300).find(el => el.tagName === 'P' && (el.textContent ?? '').trim().length >= 60);
  if (!k) return null;
  const host = document.querySelector('.mditor-editor-host');
  host.scrollTop = Math.max(0, k.offsetTop - 150);
  return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
    const rc = k.getBoundingClientRect();
    res({ x: Math.round(rc.x + Math.min(rc.width / 2, 200)), y: Math.round(rc.y + rc.height / 2),
          x1: Math.round(rc.x + rc.width * 0.25), x2: Math.round(rc.x + rc.width * 0.75) });
  })));
})()`;
const findFormula = `(() => {
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
    res({ fx: Math.round(rc.x + rc.width / 2), fy: Math.round(rc.y + rc.height / 2),
          px: Math.round(prc.x + Math.min(prc.width / 2, 200)), py: Math.round(prc.y + Math.min(prc.height, 80)) });
  })));
})()`;

const p = await cdp.eval(findP);
await sleep(1500);

// ---- 1. 三击选段 -------------------------------------------------------------
{
  await cdp.send("Profiler.start");
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 3 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 3 });
  await sleep(900);
  const { profile } = await cdp.send("Profiler.stop");
  report("triple-click", aggregate(profile));
  writeFileSync(join(here, "results", "profile-triple.cpuprofile"), JSON.stringify(profile));
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(400);
}

// ---- 2. 点公式 → 点正文 ------------------------------------------------------
{
  const f = await cdp.eval(findFormula);
  await sleep(1500);
  await cdp.send("Profiler.start");
  for (let i = 0; i < 3; i++) {
    await m.click(f.fx, f.fy); await sleep(400);
    await m.click(f.px, f.py); await sleep(400);
  }
  const { profile } = await cdp.send("Profiler.stop");
  report("click-formula ×3", aggregate(profile));
  writeFileSync(join(here, "results", "profile-formula.cpuprofile"), JSON.stringify(profile));
  await sleep(300);
}

// ---- 3. 拖选 -----------------------------------------------------------------
{
  const q = await cdp.eval(findP);
  await sleep(1200);
  await cdp.send("Profiler.start");
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: q.x1, y: q.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 10; i++) {
    const x = Math.round(q.x1 + ((q.x2 - q.x1) * i) / 10);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: q.y, button: "left", buttons: 1 });
    await sleep(40);
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: q.x2, y: q.y, button: "left", clickCount: 1 });
  await sleep(700);
  const { profile } = await cdp.send("Profiler.stop");
  report("drag-select", aggregate(profile));
  writeFileSync(join(here, "results", "profile-drag.cpuprofile"), JSON.stringify(profile));
}

cdp.close();
