// HX H2 修复门矩阵：明暗主题 × 有无公式 × 图片内联/引用——导出后浏览器
// 实测「可滚动到文档末尾」+ 主题保真（背景/文字色与主题一致）。
// 主题切换走与 useSettings 同款机制（懒 import 主题 css + data-theme attr）。
// 产物：perf/results/ex-hx-repro/ex-hx-h2-matrix.json
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT = join(ROOT, "perf", "results", "ex-hx-repro");
const DOC_DIR = "C:/Users/hh/Documents";

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);

// 主题切换（与 useSettings.ts:39-41,210 同款）
const setTheme = (theme) => cdp.eval(`(async () => {
  const t = ${JSON.stringify(theme)};
  if (t !== 'light') await import('/src/styles/themes/' + t + '.css');
  else await import('/src/styles/themes/light.css');
  document.documentElement.setAttribute('data-theme', t);
  return document.documentElement.getAttribute('data-theme');
})()`);

// 导出链（与 ex-hx-html-repro 同源，inlineImages 可选）
const EXPORT = (doc, inline) => `(async () => {
  const dbg = window.__exportDebug;
  const opened = await dbg.open(${JSON.stringify(doc)});
  if (!opened) return JSON.stringify({ error: 'open failed' });
  await new Promise(r => setTimeout(r, 4500));
  const raw = dbg.getHTML();
  let html = raw;
  if (dbg.isBigDoc()) { try { html = (await import('/src/lib/exportMath.ts')).renderDegradedMath(html).html; } catch {} }
  html = (await import('/src/lib/exportMath.ts')).renderBlockMath(html).html;
  try { html = (await import('/src/lib/wikiLinkExport.ts')).resolveWikiLinksInHtml(html, dbg.docPath()); } catch {}
  try { html = (await import('/src/lib/citationExport.ts')).resolveCitationsForExport(html); } catch {}
  try { html = (await import('/src/lib/flashcardExport.ts')).degradeFlashcardsInHtml(html); } catch {}
  const { sanitizeExportHtml } = await import('/src/lib/exportSanitize.ts');
  const { wrapHtml } = await import('/src/lib/exporter.ts?t=' + Date.now());
  const { collectThemeCss } = await import('/src/lib/themeCss.ts');
  let sanitized = sanitizeExportHtml(html);
  let missing = [];
  if (${inline ? "true" : "false"}) {
    try {
      const { inlineExportImages } = await import('/src/lib/exporterImages.ts');
      const r = await inlineExportImages(sanitized, dbg.docPath(), { remote: 'fetch' });
      sanitized = r.html; missing = r.missing;
    } catch (e) { missing = [{ error: String(e) }]; }
  }
  let css = collectThemeCss();
  if (sanitized.includes('katex')) {
    try { css = await (await import('/src/lib/exportMath.ts')).inlineKatexFonts(css); } catch {}
  }
  const theme = document.documentElement.getAttribute('data-theme') ?? 'light';
  return JSON.stringify({ standalone: wrapHtml(sanitized, css, 'm', theme), hasKatex: sanitized.includes('katex'), missingCount: missing.length });
})()`;

const combos = [
  { id: "light+公式+引用", theme: "light", doc: join(ROOT, "docs", "demo.md"), inline: false },
  { id: "dark+公式+引用", theme: "dark", doc: join(ROOT, "docs", "demo.md"), inline: false },
  { id: "dark+公式+内联", theme: "dark", doc: join(ROOT, "docs", "demo.md"), inline: true },
  { id: "dark+无公式", theme: "dark", doc: join(ROOT, "perf", "fixtures", "hx-repro", "plain-long.md"), inline: false },
  { id: "light+无公式", theme: "light", doc: join(ROOT, "perf", "fixtures", "hx-repro", "plain-long.md"), inline: false },
];

const results = [];
for (const c of combos) {
  console.log("==", c.id);
  await setTheme(c.theme);
  await sleep(800);
  const raw = await cdp.eval(EXPORT(c.doc, c.inline), { awaitPromise: true, returnByValue: true });
  const r = JSON.parse(raw);
  if (r.error) { results.push({ id: c.id, error: r.error }); continue; }
  const file = join(DOC_DIR, `hx-matrix-${c.id.replace(/[+]/g, "_")}.html`);
  const { writeFileSync: wf } = await import("node:fs");
  wf(file, r.standalone, "utf8");
  results.push({ id: c.id, file, bytes: Buffer.byteLength(r.standalone), hasKatex: r.hasKatex, missingCount: r.missingCount, theme: c.theme });
  console.log("  written", file, r.hasKatex ? "(katex)" : "", r.missingCount ? `missing:${r.missingCount}` : "");
}
writeFileSync(join(OUT, "ex-hx-h2-matrix-pending.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 1));
cdp.close();
