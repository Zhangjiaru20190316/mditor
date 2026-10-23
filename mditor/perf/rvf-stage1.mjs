// RVF 阶段 1 验收（Inter 真变体）：fixture 双模式导出 + 断言汇总。
// 度量断言在 rvf-measure.py（2 Tr 仅剩 CJK 兜底 / 墨量比 / 抽取一致性）。
// 前置：改码后必须重启 dev 进程（动态 import 模块缓存不随 HMR 刷新）。
import { writeFileSync, mkdirSync, statSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT = join(ROOT, "perf", "results", "rvf-stage1");
const FIX = "C:/Users/hh/Documents/rv-fixtures/vector-export-demo.md";
mkdirSync(OUT, { recursive: true });

const target = await findPageTarget(9223, 120_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");
const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(FIX)})`);
if (!opened) throw new Error("open failed");
await sleep(4500);

const run = async (mode) => {
  const pdf = `${DUMP}/${mode}.pdf`;
  const meta = await cdp.eval(
    `window.__exportDebug.exportPdfTo(${JSON.stringify(pdf.replace(/\\\\/g, "/"))}, {
      mode: ${JSON.stringify(mode)},
    })`,
    { awaitPromise: true, returnByValue: true }
  );
  if (meta?.error || !meta?.meta) {
    console.error("exportPdfTo failed:", JSON.stringify(meta).slice(0, 400));
    process.exit(1);
  }
  return { mode, pdf, meta };
};
const DUMP = "C:/Users/hh/Documents/rvf-dump1";
rmSync(DUMP, { recursive: true, force: true });
mkdirSync(DUMP, { recursive: true });
const runs = [await run("raster"), await run("vector")];
for (const r of runs) {
  copyFileSync(`${DUMP}/${r.mode}.pdf`, r.pdf);
}
const [ras, vec] = runs;

const summary = {
  runs: runs.map((r) => ({
    mode: r.mode,
    pages: r.meta?.meta?.pages,
    pdfBytes: statSync(r.pdf).size,
    vectorFallback: r.meta?.meta?.vectorFallback ?? null,
    textPlan: r.meta?.meta?.textPlan,
    assemble: r.meta?.meta?.assemble && {
      fontEmbedded: r.meta.meta.assemble.fontEmbedded,
      latinFontsEmbedded: r.meta.meta.assemble.latinFontsEmbedded,
      visibleGlyphs: r.meta.meta.assemble.visibleGlyphsPlaced,
      textOps: r.meta.meta.assemble.textOpsPlaced,
    },
    timings: r.meta?.meta?.timings,
  })),
};
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 1));

if (summary.runs[0].pages !== summary.runs[1].pages) {
  console.error(`页数不一致！raster=${summary.runs[0].pages} vector=${summary.runs[1].pages}`);
  process.exit(1);
}
if (summary.runs[1].vectorFallback) {
  console.error(`矢量回退意外触发：${summary.runs[1].vectorFallback}`);
  process.exit(1);
}
const growth = (statSync(vec.pdf).size - 449926) / 449926;
console.log(`矢量版体积较阶段0基线(449926B)增幅：${(growth * 100).toFixed(1)}%`);
if (growth > 0.2) {
  console.error("体积增幅超 20% 红线");
  process.exit(1);
}
cdp.close();
