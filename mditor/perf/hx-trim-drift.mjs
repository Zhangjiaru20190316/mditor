// HX 终验决定性实验：测量布局 vs 光栅（trim）布局的局部漂移。
// 复刻 rasterizeAndAssemble 的 win+translateY+ChunkTrim 流程（同款收帧），
// 在裁剪态下重测关键元素的 top，与测量态对比。
// 用法：node perf/hx-trim-drift.mjs <fixture.md> <knifePageNosCsv>
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT = join(ROOT, "perf", "results", "ex-hx-repro");
mkdirSync(OUT, { recursive: true });

const doc = process.argv[2] ?? join(ROOT, "perf", "fixtures", "无穷级数_密度档压测副本.md");
const knifePages = (process.argv[3] ?? "72,75,76").split(",").map(Number);

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");

const PROBE = `(async () => {
  const dbg = window.__exportDebug;
  let html = dbg.getHTML();
  if (dbg.isBigDoc()) { try { html = (await import('/src/lib/exportMath.ts')).renderDegradedMath(html).html; } catch {} }
  html = (await import('/src/lib/exportMath.ts')).renderBlockMath(html).html;
  try { html = (await import('/src/lib/wikiLinkExport.ts')).resolveWikiLinksInHtml(html, dbg.docPath()); } catch {}
  try { html = (await import('/src/lib/citationExport.ts')).resolveCitationsForHtml(html); } catch {}
  try { html = (await import('/src/lib/flashcardExport.ts')).degradeFlashcardsInHtml(html); } catch {}
  const { sanitizeExportHtml } = await import('/src/lib/exportSanitize.ts');
  html = sanitizeExportHtml(html);
  const css = await import('/src/lib/themeCss.ts').then(m => m.collectThemeCss());
  const fac = await import('/src/lib/exportRenderFactory.ts');
  const pipe = await import('/src/lib/exportPdfPipeline.ts?t=' + Date.now());
  const { paginateBlocks } = await import('/src/lib/exportPaginator.ts');
  const h = await fac.renderInFactory(html, { contentWidthPx: 680, css, maxImageHeightPx: 1009 });
  try {
    const blocks = pipe.measureBlocks(h);
    const paginated = paginateBlocks(blocks, 1009);
    const content = h.content, doc = h.doc;
    const cs0 = h.iframe.contentWindow.getComputedStyle(content);
    const contentGeom = { paddingTop: cs0.paddingTop, borderTop: cs0.borderTopWidth, marginTop: cs0.marginTop, position: cs0.position };
    const out = { contentGeom, probes: [] };
    for (const pn of ${JSON.stringify(knifePages)}) {
      const knifeY = paginated.pages[pn].top;
      // 带内标记元素（测量态）：刀口 ±30 内的所有直接子元素与其孙级 LI/P 顶
      const base0 = content.getBoundingClientRect();
      const mark = [];
      for (const el of content.querySelectorAll('li, p, h1, h2, h3, h4, table, pre, blockquote, hr, img, .katex-display')) {
        if (el.closest('.katex-mathml')) continue;
        const r = el.getBoundingClientRect();
        const t = r.top - base0.top, b = r.bottom - base0.top;
        if (b > knifeY - 30 && t < knifeY + 30 && r.height > 0) {
          mark.push({ el, tag: el.tagName, txt: (el.textContent || '').trim().slice(0, 16), mTop: +t.toFixed(2) });
        }
      }
      // 复刻 raster：win + translateY + ChunkTrim（直接 import 生产实现不可行——
      // ChunkTrim 未导出，按源码同款复刻）
      const parent = content.parentNode;
      const win = doc.createElement('div');
      win.style.cssText = 'overflow:hidden;position:relative;width:680px;';
      parent.insertBefore(win, content);
      win.appendChild(content);
      content.style.position = 'relative';
      const chunkTop = knifeY - 100, chunkBottom = knifeY + 100;
      win.style.height = (chunkBottom - chunkTop) + 'px';
      content.style.transform = 'translateY(' + (-chunkTop) + 'px)';
      // ChunkTrim 同款
      const kids = Array.from(content.children);
      const tops = kids.map(k => { const r = k.getBoundingClientRect(); const b = content.getBoundingClientRect(); return r.top - b.top; });
      const savedCss = kids.map(k => k.style.cssText);
      const staging = doc.createDocumentFragment();
      const n = kids.length;
      for (let i = 0; i < n; i++) {
        const top = tops[i];
        const bottom = i + 1 < n ? tops[i + 1] : top + kids[i].getBoundingClientRect().height;
        if (!(top < chunkBottom - 1 && bottom > chunkTop + 1)) { staging.appendChild(kids[i]); continue; }
        const k = kids[i];
        k.style.position = 'absolute';
        k.style.top = top + 'px';
        k.style.left = '0'; k.style.right = '0'; k.style.margin = '0'; k.style.bottom = 'auto';
      }
      // 收帧（同款：双 setTimeout + 强制布局读）
      void content.scrollHeight;
      await new Promise(res => setTimeout(res, 0));
      void content.scrollHeight;
      await new Promise(res => setTimeout(res, 0));
      // 裁剪态重测：transform 对 base 与元素同乘，相消
      const base1 = content.getBoundingClientRect();
      const drift = mark.map(m => {
        const r = m.el.getBoundingClientRect();
        return { tag: m.tag, txt: m.txt, mTop: m.mTop, rTop: +(r.top - base1.top).toFixed(2), d: +((r.top - base1.top) - m.mTop).toFixed(2) };
      });
      out.probes.push({ page: pn, knifeY: +knifeY.toFixed(2), drift });
      // 还原
      for (let i = 0; i < n; i++) { content.appendChild(kids[i]); kids[i].style.cssText = savedCss[i]; }
      try { parent.insertBefore(content, win); win.remove(); } catch {}
      content.style.position = '';
      content.style.transform = '';
      void content.scrollHeight;
      await new Promise(res => setTimeout(res, 0));
    }
    return JSON.stringify(out);
  } finally { h.destroy(); }
})()`;

console.log("== open", doc);
const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(doc)})`);
if (!opened) throw new Error("open failed");
await sleep(9000);
const raw = await cdp.eval(PROBE, { awaitPromise: true, returnByValue: true });
const name = doc.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
const outPath = join(OUT, `hx-trim-drift-${name}.json`);
writeFileSync(outPath, raw);
console.log("→", outPath);
for (const p of JSON.parse(raw).probes) {
  console.log(`page ${p.page} knifeY=${p.knifeY}`);
  for (const d of p.drift) console.log(`  ${d.tag} "${d.txt}" measured=${d.mTop} trimmed=${d.rTop} drift=${d.d}`);
}
cdp.close();
