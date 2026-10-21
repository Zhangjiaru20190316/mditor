// RV 轮阶段1回归：矢量文本主路径。同一 fixture 双模式导出对照——
//   1) 页数一致性（分页器未动 → 两模式页数必须相同）；
//   2) textPlan 覆盖统计（vectorChars/shadowChars/reasons 直读 meta）；
//   3) 位图层摘除验证（vector 模式页图墨量显著低于 raster 模式——纯文本
//      区域不再有位图墨迹，且不为零：bold/公式/代码/表格线仍在）；
//   4) 产物 PDF 结构验证（python/pymupdf 侧另跑：0 Tr 可见算子 + 文本可抽取）。
import { writeFileSync, mkdirSync, statSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT = join(ROOT, "perf", "results", "rv-phase1");
const DOC = join(ROOT, "docs", "vector-export-demo.md");
const DUMP = "C:/Users/hh/Documents/rv-dump-p1";
mkdirSync(OUT, { recursive: true });
rmSync(DUMP, { recursive: true, force: true });
mkdirSync(DUMP, { recursive: true });

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");
const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(DOC)})`);
if (!opened) throw new Error("open failed");
await sleep(4500);

const run = async (mode) => {
  const dir = `${DUMP}/${mode}`;
  mkdirSync(dir, { recursive: true });
  const pdf = `${DUMP}/rv-p1-${mode}.pdf`;
  const meta = await cdp.eval(
    `window.__exportDebug.exportPdfTo(${JSON.stringify(pdf)}, {
      mode: ${JSON.stringify(mode)},
      dumpPages: { indices: [0, 1, 2, 3], dir: ${JSON.stringify(dir)}, name: "page" },
    })`,
    { awaitPromise: true, returnByValue: true }
  );
  return { mode, pdf, meta, bytes: statSync(pdf).size };
};

const runs = [];
runs.push(await run("raster"));
runs.push(await run("vector"));

// 页图拷回工程目录
for (const r of runs) {
  for (const f of readdirSync(`${DUMP}/${r.mode}`)) {
    copyFileSync(`${DUMP}/${r.mode}/${f}`, join(OUT, `${r.mode}-${f}`));
  }
  copyFileSync(r.pdf, join(OUT, `rv-p1-${r.mode}.pdf`));
}
rmSync(DUMP, { recursive: true, force: true });

const summary = runs.map((r) => ({
  mode: r.mode,
  pages: r.meta?.meta?.pages,
  vectorMode: r.meta?.meta?.vectorMode,
  pdfBytes: r.bytes,
  textPlan: r.meta?.meta?.textPlan,
  assemble: {
    visibleRuns: r.meta?.meta?.assemble?.visibleRunsPlaced,
    visibleGlyphs: r.meta?.meta?.assemble?.visibleGlyphsPlaced,
    textRuns: r.meta?.meta?.assemble?.textRunsPlaced,
  },
  paginate: r.meta?.meta?.paginate,
  vectorFallback: r.meta?.meta?.vectorFallback ?? null,
}));
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 1));

// 页数一致性硬门
if (summary[0].pages !== summary[1].pages) {
  console.error(`页数不一致：raster=${summary[0].pages} vector=${summary[1].pages}`);
  process.exit(1);
}
cdp.close();
