// RV 轮最终回归（验收第 4.6 条）：fixture 双模式导出 + HTML 导出 + 页图
// 落盘 + 结构断言汇总。产物全部留存 perf/results/rv-final/ 供人工终检。
import { writeFileSync, mkdirSync, statSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT = join(ROOT, "perf", "results", "rv-final");
const FIX = "C:/Users/hh/Documents/rv-fixtures/vector-export-demo.md";
const DUMP = "C:/Users/hh/Documents/rv-dump-final";
mkdirSync(OUT, { recursive: true });
rmSync(DUMP, { recursive: true, force: true });
mkdirSync(DUMP, { recursive: true });

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");
const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(FIX)})`);
if (!opened) throw new Error("open failed");
await sleep(4500);

const run = async (mode) => {
  const dir = `${DUMP}/${mode}`;
  mkdirSync(dir, { recursive: true });
  const pdf = `${DUMP}/rv-final-${mode}.pdf`;
  const meta = await cdp.eval(
    `window.__exportDebug.exportPdfTo(${JSON.stringify(pdf)}, {
      mode: ${JSON.stringify(mode)},
      dumpPages: { indices: [0, 1, 2, 3, 4, 5], dir: ${JSON.stringify(dir)}, name: "page" },
    })`,
    { awaitPromise: true, returnByValue: true }
  );
  return { mode, pdf, meta, bytes: statSync(pdf).size };
};
const runs = [await run("raster"), await run("vector")];

// HTML 导出（wrapHtml 现行版——表格边框 + 引用/高光/代码块补齐）
const htmlOut = await cdp.eval(`(async () => {
  const dbg = window.__exportDebug;
  const { prepareExportHtml, wrapHtml } = await import('/src/lib/exporter.ts');
  const css = await import('/src/lib/themeCss.ts').then(m => m.collectThemeCss());
  let html = dbg.getHTML();
  html = (await import('/src/lib/exportMath.ts')).renderBlockMath(html).html;
  try { html = (await import('/src/lib/wikiLinkExport.ts')).resolveWikiLinksInHtml(html, dbg.docPath()); } catch {}
  try { html = (await import('/src/lib/citationExport.ts')).resolveCitationsForExport(html); } catch {}
  try { html = (await import('/src/lib/flashcardExport.ts')).degradeFlashcardsInHtml(html); } catch {}
  const prep = await prepareExportHtml({ html, css, docPath: dbg.docPath() });
  return wrapHtml(prep.html, css, 'vector-export-demo', document.documentElement.getAttribute('data-theme') || 'light');
})()`, { awaitPromise: true, returnByValue: true });
writeFileSync(join(OUT, "rv-final-export.html"), htmlOut);

for (const r of runs) {
  for (const f of readdirSync(`${DUMP}/${r.mode}`)) {
    copyFileSync(`${DUMP}/${r.mode}/${f}`, join(OUT, `${r.mode}-${f}`));
  }
  copyFileSync(r.pdf, join(OUT, `rv-final-${r.mode}.pdf`));
}
rmSync(DUMP, { recursive: true, force: true });

const summary = runs.map((r) => ({
  mode: r.mode,
  pages: r.meta?.meta?.pages,
  pdfBytes: r.bytes,
  textPlan: r.meta?.meta?.textPlan,
  patchPlan: r.meta?.meta?.patchPlan,
  assemble: r.meta?.meta?.assemble && {
    visibleGlyphs: r.meta.meta.assemble.visibleGlyphsPlaced,
    fontEmbedded: r.meta.meta.assemble.fontEmbedded,
  },
  timings: r.meta?.meta?.timings,
  paginate: r.meta?.meta?.paginate,
  vectorFallback: r.meta?.meta?.vectorFallback ?? null,
}));
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary.map(s => ({ mode: s.mode, pages: s.pages, bytes: s.pdfBytes, vectorChars: s.textPlan?.vectorChars, patches: s.patchPlan })), null, 1));
if (summary[0].pages !== summary[1].pages) {
  console.error(`页数不一致！raster=${summary[0].pages} vector=${summary[1].pages}`);
  process.exit(1);
}
if (summary[1].vectorFallback) {
  console.error(`矢量回退意外触发：${summary[1].vectorFallback}`);
  process.exit(1);
}
console.log("HTML bytes:", htmlOut.length);
cdp.close();
