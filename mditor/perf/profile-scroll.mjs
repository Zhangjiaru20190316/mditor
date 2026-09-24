// G6 on 臂归因（tmp）：打开 1MB（cv 档）→ 稳定 → Profiler → 10s 连续滚轮
// → 停止 → self-time 聚合。A/B 两臂（f4ef4f0 vs main）同脚本对比。
// 用法：node perf/tmp-profile-scroll.mjs <标签>
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findPageTarget, Cdp, mouse, sleep, LONGTASK_RECORDER } from "./cdp.mjs";

const label = process.argv[2] ?? "scr";
const here = dirname(fileURLToPath(import.meta.url));
const DOC_NAME = "一元微分学习题集_1MB压测副本";

const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Page.reload", { ignoreCache: true });
await sleep(2500);
await cdp.eval(LONGTASK_RECORDER);
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
if (!row) throw new Error("文件树找不到目标文档");
await m.click(row.x, row.y);
let settle = 0, lastCount = -1, stable = 0;
while (settle < 40) {
  await sleep(250);
  const n = await cdp.eval(`document.querySelector('.ProseMirror')?.children.length ?? 0`);
  if (n > 100 && n === lastCount) { stable++; if (stable >= 3) break; } else stable = 0;
  lastCount = n; settle++;
}
await sleep(2500); // 打开余波（与 select-bench/scroll-abab 的静置对齐）
console.log("blocks:", lastCount);

await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
await cdp.eval("window.__ltRecorder.start()");
await cdp.send("Profiler.start");
const cx = 640, cy = 400;
const t0 = Date.now();
for (let i = 0; i < 100; i++) {
  await m.wheel(cx, cy, 0, 400);
  await sleep(100);
}
const scrollS = (Date.now() - t0) / 1000;
const { profile } = await cdp.send("Profiler.stop");
const lts = ((await cdp.eval("window.__ltRecorder.stop()")) ?? { events: [] }).events ?? [];

// self-time 聚合
const agg = new Map();
if (profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  for (let i = 0; i < profile.samples.length; i++) {
    const cf = byId.get(profile.samples[i])?.callFrame;
    if (!cf) continue;
    const key = `${cf.functionName || "(anon)"} @ ${(cf.url || "").split("/").slice(-1)[0]}:${cf.lineNumber + 1}`;
    agg.set(key, (agg.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }
}
const sorted = [...agg.entries()].sort((a, b) => b[1] - a[1]);
const total = [...agg.values()].reduce((a, b) => a + b, 0);
console.log(`scroll ${scrollS}s sampled=${Math.round(total / 1000)}ms lt(n/tot/max)=${lts.length}/${lts.reduce((s, e) => s + e.d, 0)}/${lts.length ? Math.max(...lts.map((e) => e.d)) : 0}`);
for (const [k, us] of sorted.slice(0, 25)) console.log(" ", (us / 1000).toFixed(1).padStart(8), "ms ", k);
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", `tmp-profile-scroll-${label}.cpuprofile`), JSON.stringify(profile));
cdp.close();
