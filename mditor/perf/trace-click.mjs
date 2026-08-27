// 单次点击的 DevTools trace：解析 Layout / RecalculateStyle / Paint 事件的规模。
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findPageTarget, Cdp, mouse, sleep } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);

await cdp.send("Page.enable");
const events = [];
cdp.on("Tracing.dataCollected", (p) => events.push(...p.value));
const done = new Promise((res) => cdp.on("Tracing.tracingComplete", res));

// 静置
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
await sleep(3000);

await cdp.send("Tracing.start", {
  categories: "devtools.timeline,disabled-by-default-devtools.timeline,blink,user-visible",
  options: "sampling-frequency=10000",
});
await m.click(r.x, r.y);
await sleep(2000);
await cdp.send("Tracing.end");
await done;

// 聚合关心的类别
const byName = new Map();
for (const e of events) {
  if (!e.name || !e.dur) continue;
  const key = e.name;
  const cur = byName.get(key) ?? { count: 0, total: 0, max: 0, maxDetail: "" };
  cur.count++;
  cur.total += e.dur;
  if (e.dur > cur.max) {
    cur.max = e.dur;
    const args = e.args?.beginData ?? e.args?.endData ?? e.args?.data ?? {};
    cur.maxDetail = JSON.stringify(args).slice(0, 260);
  }
  byName.set(key, cur);
}
const top = [...byName.entries()].filter(([, v]) => v.total > 2000).sort((a, b) => b[1].total - a[1].total).slice(0, 14);
console.log("trace events:", events.length);
for (const [name, v] of top) {
  console.log(`${(v.total / 1000).toFixed(0)}ms ×${v.count}  ${name}  (max ${(v.max / 1000).toFixed(0)}ms)`);
  console.log("    ", v.maxDetail);
}
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", "trace-oneclick.json"), JSON.stringify(events));
cdp.close();
