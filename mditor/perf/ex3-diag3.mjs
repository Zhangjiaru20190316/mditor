// 密度档 fixture 分阶段诊断：定位 2355 公式文档的挂点/慢点。
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";
import { join } from "node:path";

const FIX = "C:/Users/hh/Desktop/Tp/mditor/perf/fixtures";
const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");
await cdp.send("Page.enable").catch(() => {});
await cdp.send("Page.bringToFront").catch(() => {});

const step = async (label, expr, cap = 120_000) => {
  const t0 = Date.now();
  try {
    const r = await Promise.race([
      cdp.eval(expr, { awaitPromise: true, returnByValue: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${cap}ms`)), cap)),
    ]);
    console.log(`[${label}] ${Date.now() - t0}ms`, JSON.stringify(r).slice(0, 500));
    return r;
  } catch (e) {
    console.log(`[${label}] FAIL ${Date.now() - t0}ms:`, String(e).slice(0, 300));
    process.exitCode = 1;
    return null;
  }
};

await step("open", `window.__exportDebug.open(${JSON.stringify(join(FIX, "无穷级数_密度档压测副本.md"))})`, 30_000);
await sleep(5000);

await step("getHTML-size", `window.__exportDebug.getHTML().length`);

await step("preprocess+measure", `(async () => {
  const html0 = window.__exportDebug.getHTML();
  const { renderBlockMath } = await import('/src/lib/exportMath.ts');
  const t0 = performance.now();
  const html = renderBlockMath(html0).html;
  const css = await import('/src/lib/themeCss.ts').then(m => m.collectThemeCss());
  const fac = await import('/src/lib/exportRenderFactory.ts');
  const pipe = await import('/src/lib/exportPdfPipeline.ts');
  const paginator = await import('/src/lib/exportPaginator.ts');
  const tFac = performance.now();
  const h = await fac.renderInFactory(html, { contentWidthPx: 680, css, maxImageHeightPx: 1009 });
  const tMea = performance.now();
  const blocks = pipe.measureBlocks(h);
  const tPag = performance.now();
  const p = paginator.paginateBlocks(blocks, 1009);
  const tTxt = performance.now();
  const frags = pipe.collectTextFragments(h);
  const ms = {
    blockMath: Math.round(tFac - t0), factory: Math.round(tMea - tFac),
    measure: Math.round(tPag - tMea), paginate: Math.round(tTxt - tPag),
    textFrag: Math.round(performance.now() - tTxt),
  };
  const out = { ms, htmlKB: Math.round(html.length / 1024), blocks: blocks.length,
    pages: p.stats.pages, paginateStats: p.stats, fragments: frags.length,
    scrollH: h.content.scrollHeight, katex: h.doc.querySelectorAll('.katex').length };
  h.destroy();
  return out;
})()`, 180_000);

// 单块光栅（一块 4 页）计时
await step("one-chunk-raster", `(async () => {
  const html0 = window.__exportDebug.getHTML();
  const { renderBlockMath } = await import('/src/lib/exportMath.ts');
  const html = renderBlockMath(html0).html;
  const css = await import('/src/lib/themeCss.ts').then(m => m.collectThemeCss());
  const fac = await import('/src/lib/exportRenderFactory.ts');
  const h = await fac.renderInFactory(html, { contentWidthPx: 680, css, maxImageHeightPx: 1009 });
  try {
    const { domToPng } = await import('modern-screenshot');
    const doc = h.doc, content = h.content;
    const win = doc.createElement('div');
    win.style.cssText = 'overflow:hidden;position:relative;width:680px;height:4036px';
    const parent = content.parentNode;
    parent.insertBefore(win, content);
    win.appendChild(content);
    content.style.position = 'relative';
    content.style.transform = 'translateY(0px)';
    void content.scrollHeight;
    const t0 = performance.now();
    const dataUrl = await domToPng(win, { width: 680, height: 4036, scale: 2, backgroundColor: '#ffffff' });
    return { rasterMs: Math.round(performance.now() - t0), pngKB: Math.round(dataUrl.length / 1024) };
  } finally { h.destroy(); }
})()`, 300_000);
console.log("DONE");
