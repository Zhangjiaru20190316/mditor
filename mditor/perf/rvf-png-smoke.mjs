// RVF 验收补项：PNG 出口冒烟（工厂共用代码回归——高亮/字体/装饰同源）。
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";
const target = await findPageTarget(9223, 30_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const FIX = "C:/Users/hh/Documents/rv-fixtures/vector-export-demo.md";
const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(FIX)})`);
if (!opened) throw new Error("open failed");
await sleep(4000);
const r = await cdp.eval(`(async () => {
  const dbg = window.__exportDebug;
  const { buildPng } = await import('/src/lib/exporter.ts');
  const css = await import('/src/lib/themeCss.ts').then(m => m.collectThemeCss());
  let html = dbg.getHTML();
  html = (await import('/src/lib/exportMath.ts')).renderBlockMath(html).html;
  const out = await buildPng({ html, css, docPath: dbg.docPath() }, {});
  const b64 = btoa(String.fromCharCode(...out.bytes.subarray(0, 200)));
  return { meta: { bytes: out.bytes.length, missing: out.missing.length, head: b64.slice(0, 40) } };
})()`, { awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(r));
if (!r?.meta?.bytes || !r.meta.head.startsWith("iVBOR")) {
  console.error("PNG 冒烟失败");
  process.exit(1);
}
console.log("PNG pipeline OK:", (r.meta.bytes / 1024).toFixed(0) + "KB");
cdp.close();
