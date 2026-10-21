// RV 轮阶段5回归：导出模式开关 + 矢量失败自动回退。
// 失败注入：onProgress 首次回调抛错（仅一次）→ 矢量路径失败 → 管线应自动
// 整体回退 raster 重跑（第二次起 onProgress 不再抛）→ 产物完整 +
// meta.vectorFallback 记录原因。对照组：正常 raster 导出。
import { writeFileSync, mkdirSync, statSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT = join(ROOT, "perf", "results", "rv-phase5");
const FIX = "C:/Users/hh/Documents/rv-fixtures/vector-export-demo.md";
mkdirSync(OUT, { recursive: true });

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");
const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(FIX)})`);
if (!opened) throw new Error("open failed");
await sleep(4500);

const pdfA = "C:/Users/hh/Documents/rv-p5-fallback.pdf";
const pdfB = "C:/Users/hh/Documents/rv-p5-raster.pdf";

// ---- 1. 失败注入：vector → 自动回退 raster ----
const metaFallback = await cdp.eval(`window.__exportDebug.exportPdfTo(${JSON.stringify(pdfA)}, {
  mode: "vector",
  onProgress: (() => { let n = 0; return () => { if (++n === 1) throw new Error("注入的矢量失败"); }; })(),
})`, { awaitPromise: true, returnByValue: true });
console.log("fallback meta:", JSON.stringify({
  pages: metaFallback?.meta?.pages,
  vectorMode: metaFallback?.meta?.vectorMode,
  vectorFallback: metaFallback?.meta?.vectorFallback,
}));

// ---- 2. 对照：正常 raster ----
const metaRaster = await cdp.eval(`window.__exportDebug.exportPdfTo(${JSON.stringify(pdfB)}, { mode: "raster" })`, { awaitPromise: true, returnByValue: true });

copyFileSync(pdfA, join(OUT, "rv-p5-fallback.pdf"));
copyFileSync(pdfB, join(OUT, "rv-p5-raster.pdf"));
const summary = {
  fallback: {
    pages: metaFallback?.meta?.pages,
    vectorMode: metaFallback?.meta?.vectorMode,
    vectorFallback: metaFallback?.meta?.vectorFallback ?? null,
    bytes: statSync(pdfA).size,
  },
  raster: { pages: metaRaster?.meta?.pages, bytes: statSync(pdfB).size },
};
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 1));
if (!summary.fallback.vectorFallback) {
  console.error("回退未触发（vectorFallback 为空）");
  process.exit(1);
}
if (summary.fallback.pages !== summary.raster.pages) {
  console.error(`回退产物页数不一致：${summary.fallback.pages} vs ${summary.raster.pages}`);
  process.exit(1);
}
cdp.close();
