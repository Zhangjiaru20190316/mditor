// DX 阶段一探察（观测，不修代码）：Node 直驱 @turbodocx/html-to-docx 的
// browser 构建（webview 实际加载的那份），与 Node 构建对照，绘差异图谱。
//
// ⚠️ 解读纪律：Node 环境缺 FileReader 等 DOM API。browser 构建若在此抛
// ReferenceError，仅证明其依赖 DOM API，【不等于】webview 会抛错——webview
// 里有这些 API。webview 真值由 CDP 活体采集（ex-dx-repro-*.mjs）。
//
// 用法：node perf/ex-dx-probe-node.mjs
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const browserBuild = pathToFileURL(
  resolve("node_modules/@turbodocx/html-to-docx/dist/html-to-docx.browser.esm.js")
).href;

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const CASES = {
  "纯文本": `<html><body><p>前</p><p>hello 中文</p><p>后</p></body></html>`,
  "dataURL图": `<html><body><p>前</p><p><img src="${TINY_PNG}" width="320" height="240" /></p><p>后</p></body></html>`,
};

const opts = { table: { row: { cantSplit: true } }, footer: true, pageNumber: true };

async function run(label, modFactory) {
  const mod = await modFactory();
  const fn = mod.default ?? mod;
  for (const [name, html] of Object.entries(CASES)) {
    const t0 = Date.now();
    try {
      const r = await fn(html, null, opts);
      const bytes = r instanceof Uint8Array ? r : new Uint8Array(r);
      const raw = new TextDecoder("latin1").decode(bytes);
      console.log(
        `[${label}] ${name}: OK ${bytes.length}B media=${raw.includes("word/media/")} (${Date.now() - t0}ms)`
      );
    } catch (e) {
      console.log(`[${label}] ${name}: THROW (${Date.now() - t0}ms)`);
      console.log("  ", String(e));
      console.log("   stack:", (e?.stack ?? "").split("\n").slice(0, 6).join("\n    "));
    }
  }
}

console.log("== Node 构建（node 条件，vitest 实际覆盖）==");
await run("node-build", () => import("@turbodocx/html-to-docx"));

console.log("\n== browser 构建（browser 条件，webview 实际加载）==");
await run("browser-build", () => import(browserBuild));
