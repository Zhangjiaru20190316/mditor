// RVF 阶段 0 验收（F5 语法高亮）：fixture 双模式 PDF + HTML 导出落盘。
// 断言在 rvf-measure.py（代码区彩色像素 > 0，修复前双模式均为 0）。
// 前置：dev 实例带 CDP 9223（改码后必须重启进程——模块缓存不随 HMR 刷新）。
import { writeFileSync, mkdirSync, statSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT = join(ROOT, "perf", "results", "rvf-stage0");
const FIX = "C:/Users/hh/Documents/rv-fixtures/vector-export-demo.md";
const DUMP = "C:/Users/hh/Documents/rvf-dump";
mkdirSync(OUT, { recursive: true });
rmSync(DUMP, { recursive: true, force: true });
mkdirSync(DUMP, { recursive: true });

const target = await findPageTarget(9223, 120_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");
const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(FIX)})`);
if (!opened) throw new Error("open failed");
await sleep(4500);

const run = async (mode) => {
  const dir = `${DUMP}/${mode}`;
  mkdirSync(dir, { recursive: true });
  const pdf = `${DUMP}/rvf-${mode}.pdf`;
  const meta = await cdp.eval(
    `window.__exportDebug.exportPdfTo(${JSON.stringify(pdf)}, {
      mode: ${JSON.stringify(mode)},
      dumpPages: { indices: [0], dir: ${JSON.stringify(dir)}, name: "page" },
    })`,
    { awaitPromise: true, returnByValue: true }
  );
  return { mode, pdf, meta, bytes: statSync(pdf).size };
};
const runs = [await run("raster"), await run("vector")];

// HTML 出口（prepareExportHtml 含 F5 高亮；wrapHtml 注 EXPORT_HLJS_CSS）
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
writeFileSync(join(OUT, "rvf-export.html"), htmlOut);

for (const r of runs) {
  for (const f of readdirSync(`${DUMP}/${r.mode}`)) {
    copyFileSync(`${DUMP}/${r.mode}/${f}`, join(OUT, `${r.mode}-${f}`));
  }
  copyFileSync(r.pdf, join(OUT, `rvf-${r.mode}.pdf`));
}
rmSync(DUMP, { recursive: true, force: true });

// 内容侧断言：HTML 出口代码块必须带 hljs token span（修复前纯文本）
const hljsSpans = (htmlOut.match(/<span class="hljs-/g) ?? []).length;
const summary = {
  hljsSpans,
  runs: runs.map((r) => ({
    mode: r.mode,
    pages: r.meta?.meta?.pages,
    pdfBytes: r.bytes,
    vectorFallback: r.meta?.meta?.vectorFallback ?? null,
  })),
};
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 1));
if (hljsSpans === 0) {
  console.error("HTML 出口无 hljs token span（内容侧高亮未生效）");
  process.exit(1);
}
if (runs[0].meta?.meta?.pages !== runs[1].meta?.meta?.pages) {
  console.error(`页数不一致！raster=${runs[0].meta?.meta?.pages} vector=${runs[1].meta?.meta?.pages}`);
  process.exit(1);
}
cdp.close();
