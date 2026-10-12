// 密度档全量导出 + 进度轮询：拿 raster 分块真实耗时（Q3/T1 数据）。
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";
import { join } from "node:path";
import { existsSync, statSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";

const FIX = "C:/Users/hh/Desktop/Tp/mditor/perf/fixtures";
const OUT = "C:/Users/hh/Desktop/Tp/mditor/perf/results";
const DOC = "C:/Users/hh/Documents/ex3-density-text.pdf";

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log(new Date().toISOString(), "connected");
await cdp.send("Page.enable").catch(() => {});
await cdp.send("Page.bringToFront").catch(() => {});

const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(join(FIX, "无穷级数_密度档压测副本.md"))})`);
console.log("open:", opened);
await sleep(5000);

// 页内后台启动（进度写 window.__ex3Run），Node 侧轮询。
await cdp.eval(`(async () => {
  const dbg = window.__exportDebug;
  const logs = [];
  window.__ex3Run = { logs, done: false, error: null, meta: null };
  try {
    const r = await dbg.exportPdfTo(${JSON.stringify(DOC)}, { textLayer: true });
    window.__ex3Run.meta = r.meta;
    window.__ex3Run.missingCount = r.missingCount;
  } catch (e) { window.__ex3Run.error = String(e); }
  window.__ex3Run.done = true;
})()`, { awaitPromise: false });
console.log("launched, polling…");

const t0 = Date.now();
let last = "";
while (Date.now() - t0 < 20 * 60_000) {
  await sleep(15_000);
  const st = await cdp.eval(`(() => { const r = window.__ex3Run; return r ? { done: r.done, error: r.error, pages: r.meta?.pages, raster: r.meta?.timings?.raster } : null; })()`, { awaitPromise: false });
  const line = JSON.stringify(st);
  if (line !== last) { console.log(`${Math.round((Date.now() - t0) / 1000)}s`, line.slice(0, 200)); last = line; }
  if (!st) break;
  if (st.done) {
    if (st.error) { console.log("EXPORT ERROR:", st.error.slice(0, 400)); process.exit(1); }
    break;
  }
}
const run = await cdp.eval(`window.__ex3Run`, { awaitPromise: false });
console.log("meta:", JSON.stringify(run?.meta).slice(0, 1500));
if (existsSync(DOC)) {
  console.log("PDF bytes:", statSync(DOC).size);
  copyFileSync(DOC, join(OUT, "ex-phase3-density-text.pdf"));
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(join(OUT, "ex-phase3-density-text.pdf"))));
  console.log("pdf-lib pageCount:", doc.getPageCount(), "meta pages:", run?.meta?.pages,
    "MATCH:", doc.getPageCount() === run?.meta?.pages);
}
writeFileSync(join(OUT, "ex-phase3-density-run.json"), JSON.stringify({ wallSec: Math.round((Date.now() - t0) / 1000), meta: run?.meta }, null, 2));
console.log("saved → perf/results/ex-phase3-density-run.json");
