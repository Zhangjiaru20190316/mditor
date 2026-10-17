// HX 轮 E-P1 定罪（症状：PDF 分页边界一行字被横切——上半截留本页、下半截落下页）。
// 方法：刀口 vs 墨迹审计——在真实工厂里跑 measureBlocks+paginateBlocks（生产同源），
// 但审计基准独立于 lineBoxes：直接取原始 text rect（Range.getClientRects）+ svg/img
// 矩形，逐刀检查是否有墨迹严格骑刀（top < y−ε 且 bottom > y+ε）。
//   - 有骑墨 → 家族甲（测量/分页段：行盒数据未覆盖墨迹，S-P1/S-P2/S-P5）
//   - 无骑墨但视觉切字 → 家族乙（光栅/裁切段，S-P3/S-P4）
// 产物：perf/results/ex-hx-repro/ex-hx-pdf-audit-{doc}.json
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const FIX = join(ROOT, "perf", "fixtures");
const OUT = join(ROOT, "perf", "results", "ex-hx-repro");
mkdirSync(OUT, { recursive: true });

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");

const AUDIT = `(async () => {
  const dbg = window.__exportDebug;
  let html = dbg.getHTML();
  if (dbg.isBigDoc()) { try { html = (await import('/src/lib/exportMath.ts')).renderDegradedMath(html).html; } catch {} }
  html = (await import('/src/lib/exportMath.ts')).renderBlockMath(html).html;
  try { html = (await import('/src/lib/wikiLinkExport.ts')).resolveWikiLinksInHtml(html, dbg.docPath()); } catch {}
  try { html = (await import('/src/lib/citationExport.ts')).resolveCitationsForExport(html); } catch {}
  try { html = (await import('/src/lib/flashcardExport.ts')).degradeFlashcardsInHtml(html); } catch {}
  const { sanitizeExportHtml } = await import('/src/lib/exportSanitize.ts');
  html = sanitizeExportHtml(html);
  const css = await import('/src/lib/themeCss.ts').then(m => m.collectThemeCss());
  const fac = await import('/src/lib/exportRenderFactory.ts');
  const pipe = await import('/src/lib/exportPdfPipeline.ts');
  const { paginateBlocks } = await import('/src/lib/exportPaginator.ts');
  // A4 + 15mm（生产默认）：版心 680×1009 CSS px（与 ex6 同口径）
  const h = await fac.renderInFactory(html, { contentWidthPx: 680, css, maxImageHeightPx: 1009 });
  try {
    const blocks = pipe.measureBlocks(h);
    const paginated = paginateBlocks(blocks, 1009);
    // ——墨迹审计（独立基准：原始 text rects + svg/img rects，不经 lineBoxes 合并）——
    const base = h.content.getBoundingClientRect();
    const ink = [];
    const walker = h.doc.createTreeWalker(h.content, NodeFilter.SHOW_TEXT);
    const range = h.doc.createRange();
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!(n.data || '').trim()) continue;
      const p = n.parentElement;
      if (!p || p.closest('.katex-mathml')) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width > 0 && r.height > 0)
          ink.push({ top: r.top - base.top, bottom: r.bottom - base.top, kind: 'text', text: n.data.slice(0, 16) });
      }
    }
    for (const el of h.content.querySelectorAll('svg, img, video')) {
      if (el.closest('.katex-mathml')) continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0)
        ink.push({ top: r.top - base.top, bottom: r.bottom - base.top, kind: el.tagName, text: (el.getAttribute('alt') || el.getAttribute('class') || '').slice(0, 24) });
    }
    const knives = paginated.pages.slice(1).map((p) => p.top);
    const straddles = [];
    for (let i = 0; i < knives.length; i++) {
      const y = knives[i];
      const s = ink.filter((r) => r.top < y - 0.5 && r.bottom > y + 0.5);
      if (s.length) straddles.push({
        knifeIndex: i + 1, y: +y.toFixed(1), count: s.length,
        kinds: [...new Set(s.map((x) => x.kind))],
        maxDepth: +Math.max(...s.map((x) => Math.min(y - x.top, x.bottom - y))).toFixed(1),
        samples: s.slice(0, 4).map((x) => ({ kind: x.kind, t: x.text, above: +(y - x.top).toFixed(1), below: +(x.bottom - y).toFixed(1) })),
      });
    }
    return JSON.stringify({
      pages: paginated.pages.length, stats: paginated.stats,
      inkCount: ink.length, knifeCount: knives.length,
      straddleKnifeCount: straddles.length, straddles: straddles.slice(0, 40),
    });
  } finally { h.destroy(); }
})()`;

const docs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [join(FIX, "无穷级数_密度档压测副本.md"), join(ROOT, "docs", "demo.md")];

for (const doc of docs) {
  console.log("== open", doc);
  const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(doc)})`);
  if (!opened) throw new Error("open failed: " + doc);
  await sleep(9000);
  const t0 = Date.now();
  const raw = await cdp.eval(AUDIT, { awaitPromise: true, returnByValue: true });
  const r = JSON.parse(raw);
  r.doc = doc;
  r.tookMs = Date.now() - t0;
  const name = doc.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
  const outPath = join(OUT, `ex-hx-pdf-audit-${name}.json`);
  writeFileSync(outPath, JSON.stringify(r, null, 2));
  console.log(`pages=${r.pages} knives=${r.knifeCount} straddle=${r.straddleKnifeCount} (${r.tookMs}ms) → ${outPath}`);
  if (r.straddleKnifeCount) {
    for (const s of r.straddles.slice(0, 10)) console.log("  knife@" + s.y, JSON.stringify(s.samples));
  }
  console.log("  stats:", JSON.stringify(r.stats));
}
cdp.close();
