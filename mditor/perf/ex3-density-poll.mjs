// 密度档导出完成等待器（无时限轮询 __ex3Run.done）。
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";
import { statSync, existsSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "C:/Users/hh/Desktop/Tp/mditor/perf/results";
const DOC = "C:/Users/hh/Documents/ex3-density-text.pdf";

const target = await findPageTarget(9223, 8000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log(new Date().toISOString(), "poller connected");
const t0 = Date.now();
while (Date.now() - t0 < 60 * 60_000) {
  await sleep(20_000);
  let st = null;
  try {
    st = await Promise.race([
      cdp.eval(`(() => { const r = window.__ex3Run; return r ? { done: r.done, err: r.error?.slice(0,200) } : 'gone'; })()`, { awaitPromise: false }),
      new Promise((res) => setTimeout(() => res('blocked'), 10_000)),
    ]);
  } catch { st = 'eval-error'; }
  console.log(`${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(st));
  if (st && typeof st === 'object' && st.done) {
    if (st.err) { console.log('EXPORT ERROR:', st.err); process.exit(1); }
    break;
  }
  if (st === 'gone') { console.log('page reloaded? run state gone'); process.exit(2); }
}
const run = await cdp.eval(`window.__ex3Run?.meta ?? null`, { awaitPromise: false });
console.log("meta:", JSON.stringify(run)?.slice(0, 2000));
if (existsSync(DOC)) {
  console.log("PDF bytes:", statSync(DOC).size);
  copyFileSync(DOC, join(OUT, "ex-phase3-density-text.pdf"));
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(join(OUT, "ex-phase3-density-text.pdf"))));
  console.log("pdf-lib pageCount:", doc.getPageCount(), "| meta.pages:", run?.pages,
    "| MATCH:", doc.getPageCount() === run?.pages);
  writeFileSync(join(OUT, "ex-phase3-density-run.json"),
    JSON.stringify({ wallSec: Math.round((Date.now() - t0) / 1000) + 1200, meta: run }, null, 2));
  console.log("saved → perf/results/ex-phase3-density-run.json");
}
