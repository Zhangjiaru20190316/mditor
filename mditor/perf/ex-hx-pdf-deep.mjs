// HX 轮 E-P1 深挖：骑墨刀的块归属 + lineBoxes 实况 vs 墨迹实况。
// 对每个骑墨刀：定位骑墨文本所属顶层块（tag/序号）、该块 lines/rows 数据、
// 刀前后最近行盒边界、骑墨 rect 与行盒的差值 —— 区分 S-P1（行盒数据缺墨）
// 与 S-P2（分页器弃用行盒数据的路径）。
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT = join(ROOT, "perf", "results", "ex-hx-repro");
mkdirSync(OUT, { recursive: true });
const DOC_DIR = "C:/Users/hh/Documents";
const DOC = join(ROOT, "docs", "demo.md");

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");

// ---- 1. demo.md 真实管线导出（免对话框直驱）+ 全页位图 ----
const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(DOC)})`);
if (!opened) throw new Error("open failed");
await sleep(6000);
const meta = await cdp.eval(`window.__exportDebug.exportPdfTo(${JSON.stringify(join(DOC_DIR, "hx-demo.pdf"))}, {
  dumpPages: { indices: [0, 1], dir: ${JSON.stringify(OUT)}, name: "ex-hx-demo-page" },
})`, { awaitPromise: true, returnByValue: true });
console.log("exportPdfTo meta:", JSON.stringify(meta).slice(0, 500));
for (const f of ["hx-demo.pdf"]) {
  if (existsSync(join(DOC_DIR, f))) copyFileSync(join(DOC_DIR, f), join(OUT, f));
}

// ---- 2. 深挖骑墨刀（demo.md）----
const deep = await cdp.eval(`(async () => {
  const dbg = window.__exportDebug;
  let html = dbg.getHTML();
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
  const h = await fac.renderInFactory(html, { contentWidthPx: 680, css, maxImageHeightPx: 1009 });
  try {
    const base = h.content.getBoundingClientRect();
    const kids = Array.from(h.content.children);
    // 顶层块实测面（与 measureBlocks 同法）
    const tops = kids.map((k) => k.getBoundingClientRect().top - base.top);
    const blocks = pipe.measureBlocks(h);
    const paginated = paginateBlocks(blocks, 1009);
    const knives = paginated.pages.slice(1).map((p) => p.top);
    // 墨迹（原始 text rects + svg/img）
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
        if (r.width > 0 && r.height > 0) {
          const bi = kids.findIndex((k) => k.contains(p) || k === p);
          ink.push({ top: r.top - base.top, bottom: r.bottom - base.top, kind: 'text', text: n.data.slice(0, 16), blockIdx: bi, blockTag: bi >= 0 ? kids[bi].tagName : null });
        }
      }
    }
    for (const el of h.content.querySelectorAll('svg, img, video')) {
      if (el.closest('.katex-mathml')) continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0) {
        const bi = kids.findIndex((k) => k.contains(el));
        ink.push({ top: r.top - base.top, bottom: r.bottom - base.top, kind: el.tagName, text: '', blockIdx: bi, blockTag: bi >= 0 ? kids[bi].tagName : null });
      }
    }
    const out = [];
    for (let i = 0; i < knives.length; i++) {
      const y = knives[i];
      const s = ink.filter((r) => r.top < y - 0.5 && r.bottom > y + 0.5);
      if (!s.length) continue;
      // 本刀相关块（骑墨块 + 刀上方/下方最近的块）
      const blockIdxs = [...new Set(s.map((x) => x.blockIdx))];
      const blockInfo = blockIdxs.map((bi) => {
        const k = kids[bi];
        const b = blocks.find((x) => x.blockId === bi) || blocks[bi];
        return {
          idx: bi, tag: k.tagName, cls: (k.getAttribute('class') || '').slice(0, 40),
          top: +tops[bi].toFixed(1), height: +blocks[bi].height.toFixed(1),
          hasLines: !!blocks[bi].lines, hasRows: !!blocks[bi].rows,
          lines: (blocks[bi].lines || blocks[bi].rows || []).map((l) => [Math.round(l.top), Math.round(l.top + l.height)]).slice(-6),
          lineCount: (blocks[bi].lines || blocks[bi].rows || []).length,
          textHead: (k.textContent || '').slice(0, 24),
        };
      });
      out.push({ knifeIndex: i + 1, y: +y.toFixed(1), straddle: s.slice(0, 5).map((x) => ({ kind: x.kind, t: x.text, above: +(y - x.top).toFixed(1), below: +(x.bottom - y).toFixed(1), blockIdx: x.blockIdx, blockTag: x.blockTag })), blockInfo });
    }
    // 分页窗口里本刀的 segments（分页器视角）
    return JSON.stringify({ knives: out, pages: paginated.pages.length,
      page2Segments: paginated.pages[1].segments.map((sg) => ({ blockId: sg.blockId, clipTop: +sg.clipTop.toFixed(1), clipBottom: +sg.clipBottom.toFixed(1) })) });
  } finally { h.destroy(); }
})()`, { awaitPromise: true, returnByValue: true });

writeFileSync(join(OUT, "ex-hx-pdf-deep-demo.json"), deep);
console.log(JSON.parse(deep).knives.map((k) => JSON.stringify(k, null, 1)).join("\n"));
console.log("page2Segments:", JSON.parse(deep).page2Segments);
cdp.close();
