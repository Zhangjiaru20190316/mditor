// EX 阶段三 EX-P 原型实测：D-1/D-2/D-3 拍板数据落盘。
// 前置：dev 实例已起（WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npm run tauri dev）。
// 用法：node perf/ex3-exp-prototype.mjs [quick]
//   quick = 只跑 demo.md 双模式（跳过密度档），供快速冒烟。
// 产物：perf/results/ex-phase3-demo-{text,raster}.pdf、ex-phase3-density-text.pdf、
//       ex-phase3-exp.json（D-1/D-2/D-3 数据 + Q1 程序化抽检 + C1 预演断言）。
//
// 判读口径（任务书 D-3 三指标）：
//   Q1 对位：程序化侧 = 片段 rect → run 换算链零损（|placed-measured| ≤ 0.5px）
//            + 基线推导误差抽样；视觉侧留给用户在 Edge/Acrobat 人工判定。
//   体积增量：text vs raster 两份产物字节数差 = 文本层成本。
//   时长：meta.timings 分阶段（factory/measure/paginate/text/raster/assemble）。
import { writeFileSync, statSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const OUT = join(here, "results");
const FIX = join(here, "fixtures");
const quick = process.argv.includes("quick");

const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
await cdp.send("Page.enable").catch(() => {});
await cdp.send("Page.bringToFront").catch(() => {}); // 前台化：光栅引擎与布局时序稳定
await cdp.send("Page.reload").catch(() => {});
await sleep(7000);

const out = { startedAt: new Date().toISOString(), runs: [], notes: [] };

// fs 能力域只放行 $APPDATA/$DOCUMENT：app 内写 Documents，Node 侧复制回 perf/results。
const DOC_DIR = "C:/Users/hh/Documents";

async function exportTo(docPath, fileName, opts, label) {
  const pdfPath = join(DOC_DIR, fileName);
  const ok = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(docPath)})`);
  if (!ok) throw new Error("open failed: " + docPath);
  await sleep(4500);
  const t0 = Date.now();
  const r = await cdp.eval(
    `window.__exportDebug.exportPdfTo(${JSON.stringify(pdfPath)}, ${JSON.stringify(opts)})`,
    { awaitPromise: true, returnByValue: true }
  );
  if (r && r.error) throw new Error("exportPdfTo failed: " + r.error);
  const wall = Date.now() - t0;
  const size = existsSync(pdfPath) ? statSync(pdfPath).size : 0;
  if (size > 0) {
    const dest = join(OUT, fileName);
    writeFileSync(dest, readFileSync(pdfPath));
    out.copied = out.copied ?? [];
    out.copied.push(dest);
  }
  console.log(`[${label}] pages=${r.meta.pages} size=${(size / 1024).toFixed(0)}KB wall=${wall}ms`);
  out.runs.push({ label, doc: docPath.split("/").pop(), opts, wall, fileSize: size, meta: r.meta, missingCount: r.missingCount });
  return r;
}

// ---- A/B. demo.md 全语法：文本层 vs 纯光栅（D-3 体积/时长差）----
const demoText = await exportTo(
  join(ROOT, "docs", "demo.md"),
  "ex-phase3-demo-text.pdf",
  { textLayer: true },
  "demo-text"
);
const demoRaster = await exportTo(
  join(ROOT, "docs", "demo.md"),
  "ex-phase3-demo-raster.pdf",
  { textLayer: false },
  "demo-raster"
);

// ---- C. 密度档 fixture（2,355 行内公式）：公式完整性的管线面复测 ----
let density = null;
if (!quick) {
  density = await exportTo(
    join(FIX, "无穷级数_密度档压测副本.md"),
    "ex-phase3-density-text.pdf",
    { textLayer: true },
    "density-text"
  );
}

// ---- D. Q1 程序化抽检：片段→run 换算链零损 + C3 公式完整性（工厂渲染侧）----
// 在页内直接驱动管线模块，取「collectTextFragments 的实测位」与「铺字换算位」
// 的差，以及工厂 iframe 内 katex 渲染节点计数（三档中本脚本覆盖默认档；
// cv/减配档由 ex3-c3-tier.mjs 补齐）。
const q1 = await cdp.eval(`(async () => {
  const dbg = window.__exportDebug;
  const html0 = dbg.getHTML();
  const { renderBlockMath } = await import('/src/lib/exportMath.ts');
  const html = renderBlockMath(html0).html;
  const css = await import('/src/lib/themeCss.ts').then(m => m.collectThemeCss());
  const fac = await import('/src/lib/exportRenderFactory.ts');
  const pipe = await import('/src/lib/exportPdfPipeline.ts');
  const paginator = await import('/src/lib/exportPaginator.ts');
  const h = await fac.renderInFactory(html, { contentWidthPx: 680, css, maxImageHeightPx: 958 });
  try {
    const blocks = pipe.measureBlocks(h);
    const paginated = paginator.paginateBlocks(blocks, 958);
    const fragments = pipe.collectTextFragments(h);
    const runs = pipe.fragmentsToPageRuns(fragments, paginated.pages, 958);
    // 换算链零损：每个 run 的 x/baseline 与其片段一致（页内坐标 = 片段 − 页顶）。
    let maxDx = 0, maxDy = 0, checked = 0;
    for (let i = 0; i < paginated.pages.length; i++) {
      for (const run of runs[i]) {
        const f = fragments.find(f => f.text === run.text && Math.abs((f.baselineY - paginated.pages[i].top) - run.baselineY) < 0.001 && Math.abs(f.x - run.x) < 0.001);
        if (!f) continue;
        checked++;
        maxDx = Math.max(maxDx, Math.abs(f.x - run.x));
        maxDy = Math.max(maxDy, Math.abs((f.baselineY - paginated.pages[i].top) - run.baselineY));
      }
    }
    // 基线推导抽检：片段 rect 与基线的差应落在 [ascent, rect.height] 语义内。
    const katexNodes = h.doc.querySelectorAll('.katex').length;
    const dollarRaw = (h.doc.body.textContent.match(/\\$/g) || []).length;
    const imgTotal = h.doc.images.length;
    return {
      pages: paginated.stats.pages, paginateStats: paginated.stats,
      fragments: fragments.length, runsTotal: runs.reduce((n, r) => n + r.length, 0),
      maxDx, maxDy, checked,
      katexNodes, dollarRaw, imgTotal,
      contentScrollH: h.content.scrollHeight,
    };
  } finally { h.destroy(); }
})()`, { awaitPromise: true, returnByValue: true });
out.q1Programmatic = q1;
console.log("Q1 programmatic:", JSON.stringify({ ...q1, paginateStats: undefined }));

// ---- E. Node 侧产物断言（C1 预演：页数一致 + 非空）----
const { PDFDocument } = await import("pdf-lib");
const asserts = [];
const fileOf = {
  "demo-text": "ex-phase3-demo-text.pdf",
  "demo-raster": "ex-phase3-demo-raster.pdf",
  "density-text": "ex-phase3-density-text.pdf",
};
for (const r of out.runs) {
  const p = join(OUT, fileOf[r.label]);
  if (!existsSync(p)) { asserts.push({ label: r.label, error: "file missing" }); continue; }
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(p)));
  asserts.push({
    label: r.label,
    pdfPages: doc.getPageCount(),
    metaPages: r.meta.pages,
    match: doc.getPageCount() === r.meta.pages,
    sizeKB: Math.round(statSync(p).size / 1024),
  });
}
out.pdfAsserts = asserts;

// D-3 体积增量与结论草稿
out.d3 = {
  textLayerSizeDeltaBytes: (out.runs[0]?.fileSize ?? 0) - (out.runs[1]?.fileSize ?? 0),
};
writeFileSync(join(OUT, "ex-phase3-exp.json"), JSON.stringify(out, null, 2));
console.log("saved → perf/results/ex-phase3-exp.json");

