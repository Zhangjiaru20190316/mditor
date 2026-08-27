// 打字延迟剖面：点入段落 → 静置 → start profiler → 逐字输入 12 个字符 → stop。
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findPageTarget, Cdp, mouse, sleep, typeText } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);

await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 500 });

const r = await cdp.eval(`(() => {
  const pm = document.querySelector('.ProseMirror');
  const host = document.querySelector('.mditor-editor-host');
  const k = pm.children[700];
  host.scrollTop = Math.max(0, k.offsetTop - 150);
  return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
    const rc = k.getBoundingClientRect();
    res({ x: Math.round(rc.x + Math.min(rc.width / 2, 300)), y: Math.round(rc.y + Math.min(rc.height / 2, 120)) });
  })));
})()`);
await m.click(r.x, r.y);
await sleep(2500);

await cdp.send("Profiler.start");
await typeText(cdp, "打字基准测试abc123", { delay: 90 });
await sleep(800);
const { profile } = await cdp.send("Profiler.stop");

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
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
console.log("sampled:", Math.round(total / 1000) + "ms");
for (const [k, us] of sorted.slice(0, 22)) {
  if (us < 5000) break;
  console.log(String(Math.round(us / 1000)).padStart(6) + "ms  " + k);
}
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", "profile-typing.cpuprofile"), JSON.stringify(profile));
cdp.close();
