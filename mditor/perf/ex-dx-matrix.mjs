// DX 阶段一判别实验矩阵（观测，不修代码）：同一文档（demo.md 全语法语料）
// 的导出链路分段活体驱动——共享预处理段 / HTML 专属尾段 / PDF 自研管线 /
// DOCX 专属段（juice → htmlToDocx）。期望：共享段+HTML+PDF 全过，DOCX 段
// 抛 ReferenceError（复现 ≥2 次）。
//
// 前置：tauri dev @9223 已起。
// 用法：node perf/ex-dx-matrix.mjs [md 绝对路径，默认 docs/demo.md]
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = process.argv[2];
// 相对路径按仓库根（perf/ 的上级）解析，避免 perf/perf 双拼。
const mdPath = !arg
  ? resolve(here, "../docs/demo.md")
  : isAbsolute(arg)
    ? arg
    : resolve(here, "..", arg);
const OUT = JSON.stringify({
  mdPath,
  pdfOut: "C:/Users/hh/Documents/ex-dx-matrix.pdf",
});

const t = await findPageTarget(9223);
const cdp = await Cdp.connect(t.webSocketDebuggerUrl);

// ---- 页面侧矩阵驱动 --------------------------------------------------------
// 步骤命名与任务书 §2.A 链路一致；import 走 dev server（与生产同模块图）。
const DRIVER = `(async ({ mdPath, pdfOut }) => {
  const R = [];
  const step = async (name, fn) => {
    const t0 = performance.now();
    try { const v = await fn(); R.push({ step: name, ok: true, ms: Math.round(performance.now() - t0), info: v ?? "" }); }
    catch (e) { R.push({ step: name, ok: false, ms: Math.round(performance.now() - t0), err: String(e?.name) + ": " + String(e?.message ?? e), stack0: (e?.stack ?? "").split("\\n").slice(1, 4).join(" | ") }); }
  };
  const dbg = window.__exportDebug;
  if (!dbg) return { fatal: "window.__exportDebug 不在位" };

  const opened = await dbg.open(mdPath);
  await new Promise(r => setTimeout(r, 1500)); // 等编辑器装载稳定
  // open() 对不存在路径可能静默失败（编辑器保持旧文档）——校验切换结果。
  const cur = (dbg.docPath() ?? "").replace(/\\\\/g, "/");
  if (!opened || !cur.endsWith(mdPath.replace(/\\\\/g, "/").split("/").pop())) {
    return { fatal: "open 失败或文档未切换（opened=" + opened + ", docPath=" + cur + "）" };
  }

  let html = dbg.getHTML();
  if (!html) return { fatal: "getHTML() 为空" };
  const ctx0 = { html, css: "", docPath: dbg.docPath() };

  // ---- 共享预处理段（doExport :1787-1837，非弹窗区但判别矩阵需要覆盖）----
  let r2 = html;
  await step("S7 getHTML(模型序列化)", () => html.length + "B");
  const em = await import("/src/lib/exportMath.ts");
  await step("renderDegradedMath?跳过(isBigDoc=" + dbg.isBigDoc() + ")", () => "");
  await step("S7 renderBlockMath", async () => { const r = em.renderBlockMath(r2); r2 = r.html; return "hasMath=" + r.hasMath; });
  await step("S4 rasterizeFormulas(docx 前置)", async () => { r2 = await em.rasterizeFormulas(r2, () => {}); return r2.length + "B"; });
  const wl = await import("/src/lib/wikiLinkExport.ts");
  await step("resolveWikiLinksInHtml", () => { r2 = wl.resolveWikiLinksInHtml(r2, ctx0.docPath); return ""; });
  const ce = await import("/src/lib/citationExport.ts");
  await step("resolveCitationsForExport", () => { r2 = ce.resolveCitationsForExport(r2); return ""; });
  const fc = await import("/src/lib/flashcardExport.ts");
  await step("degradeFlashcardsInHtml", () => { r2 = fc.degradeFlashcardsInHtml(r2); return ""; });
  const tc = await import("/src/lib/themeCss.ts");
  let css = "";
  await step("S7 collectThemeCss", () => { css = tc.collectThemeCss(); return css.length + "B"; });

  // ---- 消毒 + 内联（DOCX 与 HTML/PDF 共享输入侧）----
  const ex = await import("/src/lib/exporter.ts");
  let shtml = r2;
  const sz = await import("/src/lib/exportSanitize.ts");
  await step("S6 sanitizeExportHtml(direct)", () => { shtml = sz.sanitizeExportHtml(r2); return shtml.length + "B"; });
  let ihtml = shtml, missing = [];
  await step("C2 inlineExportImages(remote:fetch)", async () => { const r = await ex.inlineExportImages(shtml, ctx0.docPath, { remote: "fetch" }); ihtml = r.html; missing = r.missing; return "missing=" + missing.length; });

  // ---- DOCX 专属段（弹窗候选区 :1844-1917 内部）----
  const ctx = { html: r2, css, docPath: ctx0.docPath };
  let inlined = "";
  await step("S2 juice.inlineContent", async () => { const juice = (await import("/node_modules/.vite/deps/juice.js")).default; inlined = juice.inlineContent(ihtml, css); return inlined.length + "B"; });
  let lib = null;
  await step("S1 htmlToDocx#1", async () => {
    lib = await import("/node_modules/.vite/deps/@turbodocx_html-to-docx.js");
    const fn = lib.default ?? lib;
    const r = await fn(inlined, null, { table: { row: { cantSplit: true } }, footer: true, pageNumber: true });
    return (r instanceof Uint8Array ? r : new Uint8Array(r)).length + "B";
  });
  await step("S1 htmlToDocx#2(复现第2次)", async () => {
    const fn = lib.default ?? lib;
    const r = await fn(inlined, null, { table: { row: { cantSplit: true } }, footer: true, pageNumber: true });
    return (r instanceof Uint8Array ? r : new Uint8Array(r)).length + "B";
  });

  // ---- HTML 专属尾段（exportHtml 内部除对话框/落盘）----
  await step("HTML wrapHtml+katex字体", async () => {
    let c2 = css;
    if (ihtml.includes("katex")) { try { c2 = await em.inlineKatexFonts(css); } catch {} }
    return ex.wrapHtml(ihtml, c2, "matrix", "light").length + "B";
  });

  // ---- PDF 自研管线（免对话框直写）----
  await step("PDF exportPdfTo(自研管线全量)", async () => {
    const r = await dbg.exportPdfTo(pdfOut, { textLayer: true });
    return JSON.stringify(r).slice(0, 160);
  });

  return { steps: R, htmlLen: html.length };
})(${OUT})`;

console.log(`== 判别实验矩阵：${mdPath} × {共享段, html, pdf, docx} ==`);
const r = await cdp.eval(DRIVER, { awaitPromise: true });
console.log(JSON.stringify(r, null, 2));
cdp.close();
