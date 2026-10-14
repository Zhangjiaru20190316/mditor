// 密度档全量导出 v5（仪表化重试）：v3/v4 两次 renderer 冻死，冻点未定位。
// 本版双通道观测——页内 onProgress → console.log（Runtime.consoleAPICalled
// 事件流，eval 被饿死时仍能到达）+ Node 侧 eval 轮询（8s 竞速判 BLOCKED）。
// 进度逐行落盘（stdout 块缓冲丢日志教训，见 memory/2026-10-12）。
// 用法：node perf/ex3-density5.mjs [rasterScale=2] [capMinutes=45]
// 产物：ex-phase3-density-run.json + ex-phase3-density-text.pdf + 页位图。
// 退出码：0=完成；1=导出报错；2=页状态丢失；3=判定冻死；4=超时未完成。
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";
import { join } from "node:path";
import {
  existsSync, statSync, writeFileSync, readFileSync, copyFileSync, appendFileSync, renameSync,
} from "node:fs";

const FIX = "C:/Users/hh/Desktop/Tp/mditor/perf/fixtures";
const OUT = "C:/Users/hh/Desktop/Tp/mditor/perf/results";
const DOC_DIR = "C:/Users/hh/Documents";
const DOC = join(DOC_DIR, "ex3-density-text.pdf");
const PROG = join(OUT, "ex3-density5-progress.logl");

const SCALE = Number(process.argv[2] ?? 2);
const CAP_MIN = Number(process.argv[3] ?? 45);
const DUMP = [0, 43, 86]; // C1 首/中/末页位图抽检

writeFileSync(PROG, "");
const log = (s) => appendFileSync(PROG, `${new Date().toISOString()} ${s}\n`);

const target = await findPageTarget(9223, 15_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
await cdp.send("Page.enable").catch(() => {});
await cdp.send("Page.bringToFront").catch(() => {});
await cdp.send("Runtime.enable").catch(() => {});
let lastConsoleAt = Date.now();
cdp.on("Runtime.consoleAPICalled", (p) => {
  const txt = (p.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
  if (txt.includes("[ex3]")) { lastConsoleAt = Date.now(); log(`console ${txt.slice(0, 220)}`); }
});
cdp.on("Runtime.exceptionThrown", (p) => {
  const d = p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "";
  log(`EXC ${String(d).slice(0, 300)}`);
});
log(`connected scale=${SCALE} cap=${CAP_MIN}min`);

const opened = await cdp.eval(
  `window.__exportDebug.open(${JSON.stringify(join(FIX, "无穷级数_密度档压测副本.md"))})`
);
log(`open: ${opened}`);
if (!opened) { console.error("open failed"); process.exit(2); }
await sleep(5000);

// 页内后台启动：进度写 __ex3Run.progress + console 双通道。
await cdp.eval(`(async () => {
  const dbg = window.__exportDebug;
  window.__ex3Run = { done: false, error: null, meta: null, progress: [] };
  try {
    const t0 = performance.now();
    const r = await dbg.exportPdfTo(${JSON.stringify(DOC)}, {
      textLayer: true,
      rasterScale: ${SCALE},
      dumpPages: { indices: ${JSON.stringify(DUMP)}, dir: ${JSON.stringify(DOC_DIR)}, name: "ex3-density-page" },
      onProgress: (p) => {
        const line = { t: Math.round(performance.now() - t0), stage: p.stage, done: p.done, total: p.total };
        window.__ex3Run.progress.push(line);
        if (window.__ex3Run.progress.length > 600) window.__ex3Run.progress.shift();
        console.log('[ex3] ' + JSON.stringify(line));
      },
    });
    window.__ex3Run.meta = r.meta ?? r;
    window.__ex3Run.missingCount = r.missingCount;
  } catch (e) { window.__ex3Run.error = String(e); }
  window.__ex3Run.done = true;
  console.log('[ex3] DONE err=' + String(window.__ex3Run.error));
})()`, { awaitPromise: false });
log("launched, polling…");

const t0 = Date.now();
let blockedStreak = 0;
let verdict = "timeout";
while (Date.now() - t0 < CAP_MIN * 60_000) {
  await sleep(20_000);
  const sec = Math.round((Date.now() - t0) / 1000);
  let st;
  try {
    st = await Promise.race([
      cdp.eval(
        `(() => { const r = window.__ex3Run; return r ? { done: r.done, err: r.error, last: r.progress[r.progress.length - 1] ?? null } : 'gone'; })()`,
        { awaitPromise: false }
      ),
      new Promise((res) => setTimeout(() => res("BLOCKED"), 8_000)),
    ]);
  } catch { st = "EVAL-ERR"; }
  log(`poll ${sec}s ${JSON.stringify(st)} consoleIdle=${Math.round((Date.now() - lastConsoleAt) / 1000)}s`);
  if (st === "gone") { verdict = "gone"; break; }
  if (st === "BLOCKED" || st === "EVAL-ERR") {
    blockedStreak++;
    // eval 饿死 + console 5 分钟无事件 = 冻死实锤（慢则 console 会持续到达）。
    if (blockedStreak >= 3 && Date.now() - lastConsoleAt > 300_000) { verdict = "frozen"; break; }
    continue;
  }
  blockedStreak = 0;
  if (st && typeof st === "object" && st.done) { verdict = st.err ? "error" : "done"; break; }
}

log(`verdict: ${verdict}`);
const run = verdict === "done" || verdict === "error"
  ? await cdp.eval(`window.__ex3Run`, { awaitPromise: false }).catch(() => null)
  : null;
log(`meta: ${JSON.stringify(run?.meta)?.slice(0, 1800)}`);

if (verdict === "done" && existsSync(DOC)) {
  log(`PDF bytes: ${statSync(DOC).size}`);
  copyFileSync(DOC, join(OUT, "ex-phase3-density-text.pdf"));
  for (const i of DUMP) {
    const src = join(DOC_DIR, `ex3-density-page-${i}.png`);
    if (!existsSync(src)) continue;
    // useJpeg 档位图实为 JPEG 字节（dump 口扩展名固定 .png）——按魔数归位。
    const magic = readFileSync(src).subarray(0, 2).toString("latin1");
    const ext = magic === "\u00ff\u00d8" ? "jpg" : "png";
    copyFileSync(src, join(OUT, `ex-phase3-density-page${i}.${ext}`));
  }
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(join(OUT, "ex-phase3-density-text.pdf"))));
  log(`pdf-lib pageCount: ${doc.getPageCount()} | meta.pages: ${run?.meta?.pages} | MATCH: ${doc.getPageCount() === run?.meta?.pages}`);
  writeFileSync(join(OUT, "ex-phase3-density-run.json"), JSON.stringify({
    scale: SCALE, wallSec: Math.round((Date.now() - t0) / 1000),
    meta: run?.meta, progress: run?.progress,
  }, null, 2));
  log("saved → perf/results/ex-phase3-density-run.json");
  console.log("DENSITY DONE", JSON.stringify(run?.meta?.timings));
  process.exit(0);
}
if (verdict === "error") { console.error("EXPORT ERROR:", run?.error); process.exit(1); }
if (verdict === "frozen") {
  console.error("FROZEN — last progress:", JSON.stringify(run ?? "eval-unreachable"));
  process.exit(3);
}
console.error(`verdict=${verdict}`);
process.exit(verdict === "gone" ? 2 : 4);
