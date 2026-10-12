// 钩子路径诊断：__exportDebug.exportPdfTo 逐段。
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");
await cdp.send("Page.enable").catch(() => {});
await cdp.send("Page.bringToFront").catch(() => {});

const step = async (label, expr, cap = 90_000) => {
  const t0 = Date.now();
  try {
    const r = await Promise.race([
      cdp.eval(expr, { awaitPromise: true, returnByValue: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${cap}ms`)), cap)),
    ]);
    console.log(`[${label}] ${Date.now() - t0}ms`, JSON.stringify(r).slice(0, 400));
    return r;
  } catch (e) {
    console.log(`[${label}] FAIL ${Date.now() - t0}ms:`, String(e).slice(0, 300));
    process.exitCode = 1;
  }
};

await step("open", `window.__exportDebug.open(${JSON.stringify(join("C:/Users/hh/Desktop/Tp/mditor", "docs", "demo.md"))})`);
await sleep(2500);

// 内联段单独测（exportPdfTo 的第一段差异点）
await step("inline", `(async () => {
  const html = window.__exportDebug.getHTML();
  const { inlineExportImages } = await import('/src/lib/exporter.ts');
  const t0 = performance.now();
  const r = await inlineExportImages(html, window.__exportDebug.docPath(), { remote: 'fetch' });
  return { ms: Math.round(performance.now() - t0), missing: r.missing.map(m => m.src.slice(0, 40)), inlined: r.report.filter(x => x.status === 'inlined').length };
})()`);

// 完整钩子
const r = await step("exportPdfTo", `window.__exportDebug.exportPdfTo("C:/Users/hh/Documents/ex3-hook-test.pdf", { textLayer: true })`, 120_000);
if (r && !r.error) {
  console.log("file exists:", existsSync("C:/Users/hh/Documents/ex3-hook-test.pdf"),
    existsSync("C:/Users/hh/Documents/ex3-hook-test.pdf") ? statSync("C:/Users/hh/Documents/ex3-hook-test.pdf").size : 0);
}
