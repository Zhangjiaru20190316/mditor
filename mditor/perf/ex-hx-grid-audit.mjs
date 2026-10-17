// HX 轮 E-P1 定罪关键实验：三口径骑墨对比。
// 口径 1（分页器刀口）：pages[i].top —— 分页器认为的页界（变高链式）
// 口径 2（产物实际边界）：chunkTop + i*contentHeightPx —— 光栅器真实切片位（定高网格）
// 口径 3（文本层窗口）：pages[i].top（与口径 1 同源 → 与口径 2 脱节）
// 若口径 2 骑墨率高而口径 1 低 → 根因 = 分页器变高页 vs 光栅定高网格错位。
// 同时复算 chunk 网格（perChunk 与生产一致：min(bySide, byPixels, 4)）。
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const FIX = join(ROOT, "perf", "fixtures");
const OUT = join(ROOT, "perf", "results", "ex-hx-repro");
mkdirSync(OUT, { recursive: true });

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);

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
  const pipe = await import('/src/lib/exportPdfPipeline.ts?t=' + Date.now());
  const { paginateBlocks } = await import('/src/lib/exportPaginator.ts');
  const h = await fac.renderInFactory(html, { contentWidthPx: 680, css, maxImageHeightPx: 1009 });
  try {
    const base = h.content.getBoundingClientRect();
    const blocks = pipe.measureBlocks(h);
    const paginated = paginateBlocks(blocks, 1009);
    const ink = [];
    const walker = h.doc.createTreeWalker(h.content, NodeFilter.SHOW_TEXT);
    const range = h.doc.createRange();
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!(n.data || '').trim()) continue;
      const p = n.parentElement;
      if (!p || p.closest('.katex-mathml')) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects())
        if (r.width > 0 && r.height > 0) ink.push({ t: r.top - base.top, b: r.bottom - base.top, k: 'text', x: n.data.slice(0, 12) });
    }
    for (const el of h.content.querySelectorAll('svg, img, video')) {
      if (el.closest('.katex-mathml')) continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0) ink.push({ t: r.top - base.top, b: r.bottom - base.top, k: el.tagName, x: '' });
    }
    const straddleAt = (y) => ink.filter((r) => r.t < y - 0.5 && r.b > y + 0.5);
    // 生产 perChunk 复算（scale=2）
    const bySide = Math.floor(16384 / (1009 * 2));
    const byPixels = Math.floor(120000000 / (680 * 2 * 1009 * 2));
    const perChunk = Math.max(1, Math.min(bySide, byPixels, 4));
    // 口径 1：分页器刀口
    const pagKnives = paginated.pages.slice(1).map((p) => p.top);
    // 口径 2：产物网格边界（chunk 内定高，chunk 顶重置）
    const gridKnives = [];
    for (let s = 0; s < paginated.pages.length; s += perChunk) {
      for (let j = 1; s + j < paginated.pages.length && j < perChunk; j++) {
        gridKnives.push({ y: paginated.pages[s].top + j * 1009, page: s + j });
      }
      if (s + perChunk < paginated.pages.length) {
        gridKnives.push({ y: paginated.pages[s].top + perChunk * 1009, page: s + perChunk, chunkEdge: true });
      }
    }
    const pagS = pagKnives.map((y, i) => ({ knife: i + 1, y: +y.toFixed(1), n: straddleAt(y).length })).filter((o) => o.n > 0);
    const gridS = gridKnives.map((g) => ({ page: g.page, y: +g.y.toFixed(1), chunkEdge: !!g.chunkEdge, n: straddleAt(g.y).length,
      samples: straddleAt(g.y).slice(0, 3).map((r) => ({ k: r.k, x: r.x, above: +(g.y - r.t).toFixed(1), below: +(r.b - g.y).toFixed(1) })) })).filter((o) => o.n > 0);
    // 漂移剖面：每页 δ = pages[i].top − 网格位
    const drift = paginated.pages.map((p, i) => {
      const s = Math.floor(i / perChunk) * perChunk;
      return +(p.top - (paginated.pages[s].top + (i - s) * 1009)).toFixed(1);
    });
    return JSON.stringify({
      pages: paginated.pages.length, perChunk, stats: paginated.stats,
      pagKnifeStraddle: { knives: pagKnives.length, straddle: pagS.length },
      gridKnifeStraddle: { boundaries: gridKnives.length, straddle: gridS.length, samples: gridS.slice(0, 12) },
      driftProfile: { first10: drift.slice(0, 10), maxAbs: Math.max(...drift.map(Math.abs)), last: drift[drift.length - 1] },
    });
  } finally { h.destroy(); }
})()`;

const doc = process.argv[2] || join(FIX, "无穷级数_密度档压测副本.md");
console.log("== open", doc);
const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(doc)})`);
if (!opened) throw new Error("open failed");
await sleep(9000);
const raw = await cdp.eval(AUDIT, { awaitPromise: true, returnByValue: true });
const r = JSON.parse(raw);
r.doc = doc;
const name = doc.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
writeFileSync(join(OUT, `ex-hx-grid-audit-${name}.json`), JSON.stringify(r, null, 2));
console.log(JSON.stringify(r, null, 1));
cdp.close();
