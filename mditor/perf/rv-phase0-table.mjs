// RV 轮阶段0回归（R1 表格边框）：三面验收——
//   1) 工厂计算样式：vditor-reset 下的 table/th/td border-width ≥1px（CSS 命中）；
//   2) PDF 导出：页位图（onPagePng 落盘）目检表格边框 + 基线记录（页数/体积）；
//   3) HTML 导出：wrapHtml 产物落盘，浏览器直开检查（R1 验收第 6 条）。
// 驱动真实 dev 实例（WebView2 9223 调试口），fixture = docs/vector-export-demo.md。
import { writeFileSync, mkdirSync, statSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT = join(ROOT, "perf", "results", "rv-phase0");
const PDF_PATH = "C:/Users/hh/Documents/rv-phase0-table.pdf";
// Tauri fs scope 只放行用户目录——页图先落 Documents 再拷回工程（.catch 静默
// 吞错，直接写工程目录会无声失败）。
const DUMP_DIR = "C:/Users/hh/Documents/rv-dump-p0";
mkdirSync(OUT, { recursive: true });
rmSync(DUMP_DIR, { recursive: true, force: true });

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");

// ---- 1. 打开回归 fixture ----
const DOC = join(ROOT, "docs", "vector-export-demo.md");
const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(DOC)})`);
if (!opened) throw new Error("open failed");
await sleep(5000);

// ---- 2. 工厂计算样式断言（R1 命中面）----
const styles = await cdp.eval(`(async () => {
  const dbg = window.__exportDebug;
  const html = dbg.getHTML();
  const css = await import('/src/lib/themeCss.ts').then(m => m.collectThemeCss());
  const fac = await import('/src/lib/exportRenderFactory.ts');
  const h = await fac.renderInFactory(html, { contentWidthPx: 680, css, maxImageHeightPx: 1009 });
  try {
    const win = h.iframe.contentWindow;
    const table = h.content.querySelector('table');
    if (!table) return { error: 'no table in factory' };
    const td = table.querySelector('td');
    const th = table.querySelector('th');
    const cs = (el) => {
      const s = win.getComputedStyle(el);
      return { borderTopWidth: s.borderTopWidth, borderRightWidth: s.borderRightWidth,
        borderBottomWidth: s.borderBottomWidth, borderLeftWidth: s.borderLeftWidth,
        borderTopColor: s.borderTopColor, collapse: win.getComputedStyle(table).borderCollapse,
        display: s.display };
    };
    return { table: cs(table), th: th ? cs(th) : null, td: td ? cs(td) : null,
      rows: table.querySelectorAll('tr').length };
  } finally { h.destroy(); }
})()`, { awaitPromise: true, returnByValue: true });
console.log("factory table styles:", JSON.stringify(styles));
writeFileSync(join(OUT, "factory-styles.json"), JSON.stringify(styles, null, 2));

// ---- 3. PDF 导出（页图 + 基线 meta）----
mkdirSync(DUMP_DIR, { recursive: true }); // 先建目录（writeFile 不建父目录）
const meta = await cdp.eval(`window.__exportDebug.exportPdfTo(${JSON.stringify(PDF_PATH)}, {
  dumpPages: { indices: [0, 1, 2, 3, 4, 5], dir: ${JSON.stringify(DUMP_DIR)}, name: "rv-p0-page" },
})`, { awaitPromise: true, returnByValue: true });
console.log("exportPdfTo meta:", JSON.stringify(meta).slice(0, 400));
for (const f of (await import("node:fs")).readdirSync(DUMP_DIR)) {
  if (f.startsWith("rv-p0-page")) copyFileSync(join(DUMP_DIR, f), join(OUT, f));
}
rmSync(DUMP_DIR, { recursive: true, force: true });

// ---- 4. HTML 导出产物（浏览器直开检查 R1）----
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
writeFileSync(join(OUT, "rv-phase0-export.html"), htmlOut);
console.log("html bytes:", htmlOut.length);

// ---- 5. 基线记录（后续阶段页数一致性对照）----
const bytes = statSync(PDF_PATH).size;
const baseline = {
  when: new Date().toISOString(),
  pdf: PDF_PATH,
  pdfBytes: bytes,
  pages: meta?.meta?.pages,
  paginate: meta?.meta?.paginate,
  textFragments: meta?.meta?.textFragments,
  factoryTableStyles: styles,
};
writeFileSync(join(OUT, "baseline.json"), JSON.stringify(baseline, null, 2));
console.log("baseline:", JSON.stringify({ pdfBytes: bytes, pages: meta?.meta?.pages }));
cdp.close();
