// HX 终验：+16 漂移的解剖——OL 盒整体移动 or LI 在 OL 内重排？含干净刀口基线。
// 用法：node perf/hx-drift-anatomy.mjs <fixture.md> <knifePageNosCsv>
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT = join(ROOT, "perf", "results", "ex-hx-repro");
mkdirSync(OUT, { recursive: true });

const doc = process.argv[2] ?? join(ROOT, "perf", "fixtures", "无穷级数_密度档压测副本.md");
const knifePages = (process.argv[3] ?? "72,75,76,73,80").split(",").map(Number);

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
  const win2 = h.iframe.contentWindow;
  try {
    const blocks = pipe.measureBlocks(h);
    const paginated = paginateBlocks(blocks, 1009);
    const content = h.content, doc = h.doc;
    const out = { probes: [] };
    for (const pn of ${JSON.stringify(knifePages)}) {
      const knifeY = paginated.pages[pn].top;
      // 测量态：刀口带内的 content 直接子元素（含盒/样式快照）
      const base0 = content.getBoundingClientRect();
      const rel = (el) => { const r = el.getBoundingClientRect(); return { top: +(r.top - base0.top).toFixed(2), bottom: +(r.bottom - base0.top).toFixed(2), h: +r.height.toFixed(2) }; };
      const snap = [];
      for (const el of content.children) {
        const r = rel(el);
        if (r.bottom > knifeY - 200 && r.top < knifeY + 200) {
          const cs = win2.getComputedStyle(el);
          snap.push({ el, tag: el.tagName, txt: (el.textContent || '').trim().slice(0, 14), m: r,
            mt: cs.marginTop, mb: cs.marginBottom, pt: cs.paddingTop, pb: cs.paddingBottom, pos: cs.position });
        }
      }
      // 刀口上下各取一个「带内 li/p」标记（跨刀口的流内元素）
      const marks = [];
      for (const el of content.querySelectorAll('li, p, h2, h3, table')) {
        if (el.closest('.katex-mathml')) continue;
        const r = el.getBoundingClientRect();
        const t = r.top - base0.top, b = r.bottom - base0.top;
        if (b > knifeY - 40 && t < knifeY + 40 && r.height > 0) marks.push({ el, tag: el.tagName, txt: (el.textContent || '').trim().slice(0, 14), mTop: +t.toFixed(2), mBottom: +b.toFixed(2) });
      }
      // 复刻 trim
      const parent = content.parentNode;
      const win = doc.createElement('div');
      win.style.cssText = 'overflow:hidden;position:relative;width:680px;';
      parent.insertBefore(win, content);
      win.appendChild(content);
      content.style.position = 'relative';
      const chunkTop = knifeY - 100, chunkBottom = knifeY + 100;
      win.style.height = (chunkBottom - chunkTop) + 'px';
      content.style.transform = 'translateY(' + (-chunkTop) + 'px)';
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
      void content.scrollHeight;
      await new Promise(res => setTimeout(res, 0));
      void content.scrollHeight;
      await new Promise(res => setTimeout(res, 0));
      const base1 = content.getBoundingClientRect();
      const relNow = (el) => { const r = el.getBoundingClientRect(); return { top: +(r.top - base1.top).toFixed(2), bottom: +(r.bottom - base1.top).toFixed(2), h: +r.height.toFixed(2) }; };
      const after = snap.map(s => ({ tag: s.tag, txt: s.txt, m0: s.m, m1: relNow(s.el),
        mt0: s.mt, mb0: s.mb, pt0: s.pt, pb0: s.pb,
        cs1: (() => { const c = win2.getComputedStyle(s.el); return { mt: c.marginTop, mb: c.marginBottom, pt: c.paddingTop, pb: c.paddingBottom }; })() }));
      const marksAfter = marks.map(m => { const r = relNow(m.el); return { tag: m.tag, txt: m.txt, mTop: m.mTop, mBottom: m.mBottom, rTop: r.top, rBottom: r.bottom, d: +(r.top - m.mTop).toFixed(2) }; });
      out.probes.push({ page: pn, knifeY: +knifeY.toFixed(2), kids: after, marks: marksAfter });
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
const outPath = join(OUT, `hx-drift-anatomy-${name}.json`);
writeFileSync(outPath, raw);
const r = JSON.parse(raw);
for (const p of r.probes) {
  console.log(`\n== page ${p.page} knifeY=${p.knifeY}`);
  for (const k of p.kids) console.log(` kid ${k.tag} "${k.txt}" box0=[${k.m0.top},${k.m0.bottom}]h${k.m0.h} box1=[${k.m1.top},${k.m1.bottom}]h${k.m1.h} css0(mt:${k.mt0} mb:${k.mb0} pt:${k.pt0} pb:${k.pb0}) css1(mt:${k.cs1.mt} mb:${k.cs1.mb} pt:${k.cs1.pt} pb:${k.cs1.pb})`);
  for (const m of p.marks) console.log(`  mark ${m.tag} "${m.txt}" [${m.mTop},${m.mBottom}] → [${m.rTop},${m.rBottom}] d=${m.d}`);
}
cdp.close();
