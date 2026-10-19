// HX 终验深挖：三处切字残端的几何归属。对指定刀口输出——
//   1) 页窗口与首末段（blockId/clipTop/clipBottom 绝对坐标）
//   2) 段所在块的单元数据（lines/rows，含护量后的 bottom）
//   3) 刀口 ±40px 带内【全部元素 rect】（不只 text/svg——找 CSS 绘制墨迹）
//   4) 带内文本 rect（含零高 rect，计数并标注）
// 用法：node perf/hx-knife-forensics.mjs <fixture.md> <knifePageNosCsv>
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT = join(ROOT, "perf", "results", "ex-hx-repro");
mkdirSync(OUT, { recursive: true });

const doc = process.argv[2] ?? join(ROOT, "perf", "fixtures", "无穷级数_密度档压测副本.md");
const knifePages = (process.argv[3] ?? "72,75,76").split(",").map(Number); // 刀口页号=窗口顶所在页（0 基）

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");

const FORENSICS = `(async () => {
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
  const h = await fac.renderInFactory(html, { contentWidthPx: 680, css, maxImageHeightPx: 1009 });
  try {
    const blocks = pipe.measureBlocks(h);
    const paginated = (await import('/src/lib/exportPaginator.ts')).paginateBlocks(blocks, 1009);
    const base = h.content.getBoundingClientRect();
    const rel = (r) => ({ top: r.top - base.top, bottom: r.bottom - base.top, left: r.left - base.left, right: r.right - base.left });
    const out = { knifePages: ${JSON.stringify(knifePages)}, reports: [] };
    for (const pn of ${JSON.stringify(knifePages)}) {
      const page = paginated.pages[pn];
      const prev = paginated.pages[pn - 1];
      const y = page.top;
      const band = 40;
      // ——段与单元——
      const segs = page.segments.map(s => {
        const b = blocks[s.blockId];
        let topAbs = null;
        let acc = 0;
        for (const bb of blocks) { if (bb.blockId === s.blockId) { topAbs = acc; break; } acc += bb.height; }
        const units = b.rows ?? b.lines;
        const unitDump = units ? units.map((u, i) => ({ i, top: +u.top.toFixed(1), bottom: +(u.top + u.height).toFixed(1), absTop: +(topAbs + u.top).toFixed(1), absBottom: +(topAbs + u.top + u.height).toFixed(1) })) : null;
        return {
          blockId: s.blockId, clipTop: s.clipTop, clipBottom: s.clipBottom,
          absTop: +topAbs.toFixed(1), height: +b.height.toFixed(1),
          keepTogether: !!b.keepTogether, isRows: !!b.rows, unitCount: units ? units.length : 0,
          unitsAroundKnife: unitDump ? unitDump.filter(u => u.absBottom > y - 60 && u.absTop < y + 60) : null,
        };
      });
      const prevSegs = prev ? prev.segments.map(s => ({ blockId: s.blockId, clipBottom: s.clipBottom })) : null;
      // ——带内全部元素 rect（含装饰性/伪元素载体）——
      const els = [];
      const all = h.content.querySelectorAll('*');
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.height <= 0 && r.width <= 0) continue;
        const t = r.top - base.top, bm = r.bottom - base.top;
        if (bm < y - band || t > y + band) continue;
        const cs = h.iframe.contentWindow.getComputedStyle(el);
        const painted = !!(cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.backgroundImage !== 'none' ||
          ['solid','double','dotted','dashed'].includes(cs.borderTopStyle) && parseFloat(cs.borderTopWidth) > 0 ||
          ['solid','double','dotted','dashed'].includes(cs.borderBottomStyle) && parseFloat(cs.borderBottomWidth) > 0 ||
          cs.boxShadow !== 'none');
        els.push({
          tag: el.tagName, cls: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').toString().slice(0, 60),
          top: +t.toFixed(1), bottom: +bm.toFixed(1), left: +(r.left - base.left).toFixed(1), height: +r.height.toFixed(1),
          painted, pos: cs.position, txt: (el.textContent || '').trim().slice(0, 24),
          straddle: t < y - 0.5 && bm > y + 0.5,
          above: +(bm - y).toFixed(1) < 0 ? null : +(y - t).toFixed(1), below: +(bm - y).toFixed(1),
        });
      }
      // ——带内文本 rect（含零高）——
      const texts = [];
      let zeroH = 0;
      const walker = h.doc.createTreeWalker(h.content, NodeFilter.SHOW_TEXT);
      const range = h.doc.createRange();
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (!(n.data || '').trim()) continue;
        const p = n.parentElement;
        if (!p || p.closest('.katex-mathml')) continue;
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          if (r.width <= 0) continue;
          const t = r.top - base.top, bm = r.bottom - base.top;
          if (r.height === 0) zeroH++;
          if (bm < y - band || t > y + band) continue;
          texts.push({ top: +t.toFixed(1), bottom: +bm.toFixed(1), left: +(r.left - base.left).toFixed(1), h: +r.height.toFixed(1), t: n.data.slice(0, 16), straddle: t < y - 0.5 && bm > y + 0.5 });
        }
      }
      out.reports.push({
        page: pn, knifeY: +y.toFixed(2), pageTop: +page.top.toFixed(1), pageBottom: +page.bottom.toFixed(1),
        prevBottom: prev ? +prev.bottom.toFixed(1) : null, prevSegs,
        firstSegs: segs.slice(0, 3),
        elsNearKnife: els.filter(e => e.bottom > y - 12 && e.top < y + 12),
        elsAll: els.length, zeroHeightRects: zeroH,
        textsNearKnife: texts.filter(t2 => t2.bottom > y - 12 && t2.top < y + 12),
      });
    }
    out.stats = paginated.stats;
    out.blockCount = blocks.length;
    return JSON.stringify(out);
  } finally { h.destroy(); }
})()`;

console.log("== open", doc);
const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(doc)})`);
if (!opened) throw new Error("open failed");
await sleep(9000);
const t0 = Date.now();
const raw = await cdp.eval(FORENSICS, { awaitPromise: true, returnByValue: true });
const name = doc.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
const outPath = join(OUT, `hx-knife-forensics-${name}.json`);
writeFileSync(outPath, raw);
console.log(`(${Date.now() - t0}ms) → ${outPath}`);
cdp.close();
