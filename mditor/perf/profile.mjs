// 单场景 CPU Profile：对一次交互（click / open）录制 JS 采样剖面，
// 按 self-time 聚合出 Top 函数。用法：
//   node perf/profile.mjs click        → 点一个段落后采样
//   node perf/profile.mjs open         → reload + 文件树打开文档全程
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findPageTarget, Cdp, mouse, sleep, LONGTASK_RECORDER } from "./cdp.mjs";

const scenario = process.argv[2] ?? "click";
// MDITOR_DOC：目标文档名（文件树行包含匹配，与 baseline.mjs 同款）。
const DOC_NAME = process.env.MDITOR_DOC ?? "一元微分";
// SETTLE_MS：open 场景点击后等内容稳定的时长（1MB 档默认加长到 40s）。
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 6000);
const here = dirname(fileURLToPath(import.meta.url));
const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);
await cdp.eval(LONGTASK_RECORDER);

await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 1000 }); // 1ms 采样

const blockRect = (idx) => `(() => {
  const pm = document.querySelector('.ProseMirror');
  if (!pm) return null;
  const host = document.querySelector('.mditor-editor-host');
  const k = pm.children[Math.min(${idx}, pm.children.length - 1)];
  host.scrollTop = Math.max(0, k.offsetTop - 150);
  return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
    const r = k.getBoundingClientRect();
    res({ x: Math.round(r.x + Math.min(r.width / 2, 300)), y: Math.round(r.y + Math.min(r.height / 2, 120)) });
  })));
})()`;

await cdp.send("Profiler.start");

let label = scenario;
if (scenario === "click") {
  for (const idx of [1300, 2600, 3900]) {
    const r = await cdp.eval(blockRect(idx));
    if (r) { await m.click(r.x, r.y); await sleep(1500); }
  }
  label = "click×3";
} else if (scenario === "open") {
  await cdp.eval("location.reload()");
  await sleep(3000);
  for (let i = 0; i < 30; i++) {
    const row = await cdp.eval(`(() => {
      const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes('${DOC_NAME}'));
      if (!hit) return null;
      const r = hit.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (row) { await m.click(row.x, row.y); break; }
    await sleep(500);
  }
  await sleep(SETTLE_MS);
  label = "open-full";
}

const { profile } = await cdp.send("Profiler.stop");
console.log("samples:", profile.samples.length, "nodes:", profile.nodes.length);

// self-time 聚合
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map(); // key → us
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
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
console.log("total sampled:", Math.round(totalUs / 1000) + "ms");
for (const [k, us] of top) {
  const pct = ((us / totalUs) * 100).toFixed(1);
  if (Number(pct) < 0.4) break;
  console.log(String(Math.round(us / 1000)).padStart(6) + "ms " + pct.padStart(5) + "%  " + k);
}
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", `profile-${scenario}.cpuprofile`), JSON.stringify(profile));
console.log("profile saved: perf/results/profile-" + scenario + ".cpuprofile");
cdp.close();
