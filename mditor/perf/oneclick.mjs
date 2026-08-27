// 单次点击的微剖面：滚到目标块 → 等 3s 静止 → start profiler → 单击 → stop。
// 排除滚动本身的干扰，只看「点击事务」的构成。
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

// 静置：滚到块 900，等 3 秒让一切余波（预热/盖章/观察器）平息
const r = await cdp.eval(`(() => {
  const pm = document.querySelector('.ProseMirror');
  const host = document.querySelector('.mditor-editor-host');
  const k = pm.children[900];
  host.scrollTop = Math.max(0, k.offsetTop - 150);
  return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
    const rc = k.getBoundingClientRect();
    res({ x: Math.round(rc.x + Math.min(rc.width / 2, 300)), y: Math.round(rc.y + Math.min(rc.height / 2, 120)) });
  })));
})()`);
console.log("settling 3s at", r);
await sleep(3000);

await cdp.send("Profiler.start");
const t0 = Date.now();
await m.click(r.x, r.y);
await sleep(1800);
const { profile } = await cdp.send("Profiler.stop");
console.log("click wall time:", Date.now() - t0 - 1800 + "ms(profiler span incl)");

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
  agg.set(cf.functionName || "(anon)", (agg.get(cf.functionName || "(anon)") ?? 0) + us);
}
const sorted = [...agg.entries()].sort((a, b) => b[1] - a[1]);
const total = [...agg.values()].reduce((a, b) => a + b, 0);
console.log("sampled:", Math.round(total / 1000) + "ms");
for (const [k, us] of sorted.slice(0, 16)) {
  console.log(String(Math.round(us / 1000)).padStart(6) + "ms  " + k);
}
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", "profile-oneclick.cpuprofile"), JSON.stringify(profile));
cdp.close();
