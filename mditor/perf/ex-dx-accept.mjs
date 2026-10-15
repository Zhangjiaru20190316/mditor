// DX 阶段二活体验收（修复后）：语料档 × 完整 DOCX 转换链（真实预处理 +
// ensureBrowserNodeGlobals 垫片 + juice + htmlToDocx），产物 base64 回传
// Node 侧落盘（C:/Users/hh/Documents/ex-dx-accept-<n>.docx），供 zip 结构
// 验证与 Word/WPS 人工打开验收。
//
// 前置：tauri dev @9223 已起（HMR 已载入修复后的 exporter.ts）。
// 用法：node perf/ex-dx-accept.mjs
import { findPageTarget, Cdp } from "./cdp.mjs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const CORPUS = [
  ["min-global", "perf/fixtures/docx-repro/min-global.md"],
  ["min-dataurl", "perf/fixtures/docx-repro/min-dataurl.md"],
  ["demo", "docs/demo.md"],
  ["formula", "perf/fixtures/公式下标最小复现_基准副本.md"],
  ["multiimg", "perf/fixtures/多图导出压测副本.md"],
];

const DRIVER = `(async ({ corpus }) => {
  const R = [];
  const dbg = window.__exportDebug;
  if (!dbg) return { fatal: "__exportDebug 不在位" };
  for (const [name, rel] of corpus) {
    const mdPath = rel;
    try {
      const opened = await dbg.open(mdPath);
      await new Promise(r => setTimeout(r, 1200));
      const cur = (dbg.docPath() ?? "").replace(/\\\\/g, "/");
      if (!opened || !cur.endsWith(mdPath.replace(/\\\\/g, "/").split("/").pop()))
        throw new Error("文档未切换: " + cur);
      let html = dbg.getHTML();
      // App.tsx doExport 同款预处理（无弹窗区全量）
      const em = await import("/src/lib/exportMath.ts");
      if (dbg.isBigDoc()) { try { html = em.renderDegradedMath(html).html; } catch {} }
      const r0 = em.renderBlockMath(html);
      html = r0.html;
      if (r0.hasMath) html = await em.rasterizeFormulas(html, () => {});
      const wl = await import("/src/lib/wikiLinkExport.ts");
      try { html = wl.resolveWikiLinksInHtml(html, dbg.docPath()); } catch {}
      const ce = await import("/src/lib/citationExport.ts");
      try { html = ce.resolveCitationsForExport(html); } catch {}
      const fc = await import("/src/lib/flashcardExport.ts");
      try { html = fc.degradeFlashcardsInHtml(html); } catch {}
      const tc = await import("/src/lib/themeCss.ts");
      const css = tc.collectThemeCss();
      // exportDocx 中段（修复点）：消毒 → 内联 → 垫片 → juice → htmlToDocx
      const ex = await import("/src/lib/exporter.ts?t=" + Date.now());
      const sz = await import("/src/lib/exportSanitize.ts");
      let ih = sz.sanitizeExportHtml(html);
      try { const r = await ex.inlineExportImages(ih, dbg.docPath(), { remote: "fetch" }); ih = r.html; } catch {}
      ex.ensureBrowserNodeGlobals();
      const juice = (await import("/node_modules/.vite/deps/juice.js")).default;
      const inlined = juice.inlineContent(ih, css);
      const fn = (await import("/node_modules/.vite/deps/@turbodocx_html-to-docx.js")).default;
      const t0 = performance.now();
      const out = await fn(inlined, null, { table: { row: { cantSplit: true } }, footer: true, pageNumber: true });
      const ms = Math.round(performance.now() - t0);
      const bytes = out instanceof Uint8Array ? out : new Uint8Array(out);
      // base64 回传（CDP returnByValue 不搬二进制）
      let b64 = "";
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      R.push({ name, ok: true, ms, htmlKB: Math.round(inlined.length / 1024), docxKB: +(bytes.length / 1024).toFixed(1),
               media: new TextDecoder("latin1").decode(bytes).includes("word/media/"), b64 });
    } catch (e) {
      R.push({ name, ok: false, err: String(e?.name) + ": " + String(e?.message ?? e),
               stack0: (e?.stack ?? "").split("\\n").slice(1, 4).join(" | ") });
    }
  }
  return R;
})(${JSON.stringify({ corpus: CORPUS.map(([n, p]) => [n, resolve(root, p).replace(/\\/g, "/")]) })})`;

const t = await findPageTarget(9223);
const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
console.log("== DX 修复活体验收：语料 × 完整 DOCX 转换链 ==");
const r = await cdp.eval(DRIVER, { awaitPromise: true });
for (const item of r ?? []) {
  const { b64, ...meta } = item;
  console.log(JSON.stringify(meta));
  if (b64) {
    const out = `C:/Users/hh/Documents/ex-dx-accept-${item.name}.docx`;
    writeFileSync(out, Buffer.from(b64, "latin1"));
    console.log(`   -> ${out}`);
  }
}
cdp.close();
