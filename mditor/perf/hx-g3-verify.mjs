// HX Fix-Pδ 终验：生产路径全量导出 + 逐页页缘墨扫描 + 疑点条带图。
// 判定口径：页顶/页底 ≤2 设备像素（=1 CSS px @2x）内出现墨像素 → 疑切字；
// 正常 flush-start（内容自第 3+ 行起排）不误报。条带图与上轮同规格
// （70 CSS px 高 × 2 倍放大，2720×280），供视觉终裁同判据复核。
// 用法：node perf/hx-g3-verify.mjs <fixture.md> <outDirName>
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT = join(ROOT, "perf", "results", "ex-hx-repro");
mkdirSync(OUT, { recursive: true });

const doc = process.argv[2] ?? join(ROOT, "perf", "fixtures", "无穷级数_密度档压测副本.md");
const tag = process.argv[3] ?? "g3-fixpd";

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");

const VERIFY = `(async () => {
  const alsoStrip = ${JSON.stringify((process.env.ALSO_STRIP ?? "").split(",").filter(Boolean).map(Number))};
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
  const pipe = await import('/src/lib/exportPdfPipeline.ts?t=' + Date.now());
  const pages = [];
  const t0 = performance.now();
  const res = await pipe.runPdfPipeline(html, css, {
    paper: 'A4', marginMm: 15, rasterScale: 2,
    onProgress: (p) => { if (p.stage === 'raster' && p.done % 20 === 0) console.log('raster', p.done, '/', p.total); },
    onPagePng: (i, dataUrl) => { pages[i] = dataUrl; },
  });
  const rasterMs = performance.now() - t0;
  // ——逐页扫描——
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const STRIP_DEV = 140; // 70 CSS px @2x
  const flags = [];
  const strips = [];
  for (let i = 0; i < pages.length; i++) {
    const img = new Image();
    img.src = pages[i];
    await img.decode();
    const W = img.width, H = img.height;
    cv.width = W; cv.height = H;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, W, H).data;
    const bg = [data[0], data[1], data[2]];
    const rowInk = (y) => {
      let n = 0;
      const row = y * W * 4;
      for (let x = 0; x < W; x++) {
        const p = row + x * 4;
        const d = Math.abs(data[p] - bg[0]) + Math.abs(data[p + 1] - bg[1]) + Math.abs(data[p + 2] - bg[2]);
        if (d > 60) n++;
      }
      return n;
    };
    let firstInkRow = -1, lastInkRow = -1;
    for (let y = 0; y < H && firstInkRow < 0; y++) if (rowInk(y) > 2) firstInkRow = y;
    for (let y = H - 1; y >= 0 && lastInkRow < 0; y--) if (rowInk(y) > 2) lastInkRow = y;
    const topCut = firstInkRow >= 0 && firstInkRow <= 2;
    const bottomCut = lastInkRow >= 0 && lastInkRow >= H - 3;
    if (topCut || bottomCut || alsoStrip.includes(i)) {
      if (topCut || bottomCut) flags.push({ page: i, firstInkRow, lastInkRow, H });
      // 条带图：每个疑边各存一张（70 CSS px，2 倍放大，与上轮规格一致）；
      // alsoStrip 指定页两缘都存（前后对照用）。
      const edges = topCut || alsoStrip.includes(i)
        ? ["top", "bottom"]
        : bottomCut
          ? ["bottom"]
          : [];
      for (const edge of edges) {
        const sy = edge === 'top' ? 0 : H - STRIP_DEV;
        const sc = document.createElement('canvas');
        sc.width = W * 2; sc.height = STRIP_DEV * 2;
        const sctx = sc.getContext('2d');
        sctx.imageSmoothingEnabled = false;
        sctx.drawImage(cv, 0, sy, W, STRIP_DEV, 0, 0, W * 2, STRIP_DEV * 2);
        strips.push({ page: i, edge, dataUrl: sc.toDataURL('image/png') });
      }
    }
    pages[i] = null; // 即弃
  }
  return JSON.stringify({
    pages: res.meta.pages, rasterMs,
    paginate: res.meta.paginate, timings: res.meta.timings,
    flags, strips,
  });
})()`;

console.log("== open", doc);
const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(doc)})`);
if (!opened) throw new Error("open failed");
await sleep(9000);
console.log("== export + scan …");
const raw = await cdp.eval(VERIFY, { awaitPromise: true, returnByValue: true });
const r = JSON.parse(raw);
const dir = join(OUT, `density-${tag}`);
mkdirSync(dir, { recursive: true });
const stripFiles = [];
for (const s of r.strips) {
  const f = join(dir, `ex-${tag}-band-p${s.page}-${s.edge}.png`);
  writeFileSync(f, Buffer.from(s.dataUrl.split(",")[1], "base64"));
  stripFiles.push(f);
}
writeFileSync(join(dir, "edge-scan.json"), JSON.stringify({ pages: r.pages, flags: r.flags }, null, 1));
console.log(`pages=${r.pages} rasterMs=${Math.round(r.rasterMs)}`);
console.log(`paginate: ${JSON.stringify(r.paginate)}`);
console.log(`flags: ${JSON.stringify(r.flags)}`);
console.log(`strips: ${stripFiles.length} → ${dir}`);
cdp.close();
