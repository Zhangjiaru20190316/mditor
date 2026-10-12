// EX 阶段三分阶段诊断：逐段跑管线，定位挂点。
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";
import { dirname as pdirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = pdirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

const target = await findPageTarget(9223, 10_000);
console.log("target:", target?.url?.slice(0, 60));
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");
await cdp.send("Page.enable").catch(() => {});
await cdp.send("Page.bringToFront").catch(() => {});
await cdp.send("Page.reload").catch(() => {});
await sleep(7000);

const step = async (label, expr) => {
  const t0 = Date.now();
  try {
    const r = await Promise.race([
      cdp.eval(expr, { awaitPromise: true, returnByValue: true }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("STEP TIMEOUT 60s")), 60_000)
      ),
    ]);
    console.log(`[${label}] ${Date.now() - t0}ms`, JSON.stringify(r).slice(0, 300));
    return r;
  } catch (e) {
    console.log(`[${label}] FAIL ${Date.now() - t0}ms:`, String(e).slice(0, 200));
    process.exit(1);
  }
};

await step("open", `window.__exportDebug.open(${JSON.stringify(join(ROOT, "docs", "demo.md"))})`);
await sleep(3000);

// 阶段 0：getHTML 体量
await step("getHTML", `window.__exportDebug.getHTML().length`);

// 阶段 1：工厂渲染（进度回调计数 + 完成信号）
const fac = await step("factory", `(async () => {
  const dbg = window.__exportDebug;
  const html = dbg.getHTML();
  const { renderBlockMath } = await import('/src/lib/exportMath.ts');
  const h2 = renderBlockMath(html).html;
  const css = await import('/src/lib/themeCss.ts').then(m => m.collectThemeCss());
  const fac = await import('/src/lib/exportRenderFactory.ts');
  const stages = [];
  const t0 = performance.now();
  const h = await fac.renderInFactory(h2, {
    contentWidthPx: 680, css, maxImageHeightPx: 958,
    onProgress: (p) => { stages.push(p.stage + ':' + p.done + '/' + p.total); },
  });
  try {
    return {
      ms: Math.round(performance.now() - t0),
      stages: stages.slice(-4),
      imgs: h.doc.images.length, kids: h.content.children.length,
      scrollH: h.content.scrollHeight, issues: h.issues.length,
      katex: h.doc.querySelectorAll('.katex').length,
    };
  } finally { h.destroy(); }
})()`);

// 阶段 2：完整 buildPdf（小文档应秒级——若挂，看它挂在哪）
await step("buildPdf-smoke", `(async () => {
  const dbg = window.__exportDebug;
  const html = dbg.getHTML();
  const { renderBlockMath } = await import('/src/lib/exportMath.ts');
  const h2 = renderBlockMath(html).html;
  const css = await import('/src/lib/themeCss.ts').then(m => m.collectThemeCss());
  const { runPdfPipeline } = await import('/src/lib/exportPdfPipeline.ts');
  const t0 = performance.now();
  const logs = [];
  const r = await runPdfPipeline(h2, css, {
    textLayer: true, title: 'smoke',
    onProgress: (p) => { const s = p.stage + ' ' + p.done + '/' + p.total; if (logs[logs.length-1] !== s) logs.push(s); },
  });
  return {
    ms: Math.round(performance.now() - t0),
    lastLogs: logs.slice(-8),
    bytesKB: Math.round(r.bytes.length / 1024),
    meta: { pages: r.meta.pages, timings: r.meta.timings, assemble: { pages: r.meta.assemble.pages, fontEmbedded: r.meta.assemble.fontEmbedded, textOps: r.meta.assemble.textOpsPlaced } },
  };
})()`);
console.log("ALL STEPS DONE");
