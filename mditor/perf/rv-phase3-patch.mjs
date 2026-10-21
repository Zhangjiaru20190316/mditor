// RV 轮阶段3回归：局部补丁 + 原生图片 + 满铺位图退位。
// fixture 迁到 $DOCUMENT（dev 实例 fs scope 只放行用户目录——工程路径图片
// 内联必失败成占位框），图片改 assets/ 相对引用。
// 三面验收：
//   1) meta：patchPlan（块/行内/残留补丁数、原生图数）+ 页数一致性 + 体积；
//   2) PDF 结构：pymupdf 侧（Node 跑完后另验）——满铺大图消失（只剩小图
//      XObject）、矢量文本/装饰仍在；
//   3) 文本抽取与重复检查。
import { writeFileSync, mkdirSync, statSync, copyFileSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT = join(ROOT, "perf", "results", "rv-phase3");
const FIX = "C:/Users/hh/Documents/rv-fixtures";
const DUMP = "C:/Users/hh/Documents/rv-dump-p3";
mkdirSync(OUT, { recursive: true });
rmSync(FIX, { recursive: true, force: true });
rmSync(DUMP, { recursive: true, force: true });
mkdirSync(join(FIX, "assets"), { recursive: true });
mkdirSync(DUMP, { recursive: true });

// ---- 1. fixture 就位（图片可内联形态）----
const md = readFileSync(join(ROOT, "docs", "vector-export-demo.md"), "utf8")
  .replace("../perf/fixtures/assets/normal-red.png", "assets/normal-red.png");
writeFileSync(join(FIX, "vector-export-demo.md"), md);
copyFileSync(join(ROOT, "perf", "fixtures", "assets", "normal-red.png"), join(FIX, "assets", "normal-red.png"));
copyFileSync(join(ROOT, "docs", "assets", "mditor-promo.svg"), join(FIX, "assets", "mditor-promo.svg"));

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");
const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(join(FIX, "vector-export-demo.md"))})`);
if (!opened) throw new Error("open failed");
await sleep(4500);

const run = async (mode) => {
  const dir = `${DUMP}/${mode}`;
  mkdirSync(dir, { recursive: true });
  const pdf = `${DUMP}/rv-p3-${mode}.pdf`;
  const meta = await cdp.eval(
    `window.__exportDebug.exportPdfTo(${JSON.stringify(pdf)}, {
      mode: ${JSON.stringify(mode)},
      dumpPages: { indices: [0, 1, 2, 3], dir: ${JSON.stringify(dir)}, name: "page" },
    })`,
    { awaitPromise: true, returnByValue: true }
  );
  return { mode, pdf, meta, bytes: statSync(pdf).size };
};

const runs = [await run("raster"), await run("vector")];
for (const r of runs) {
  for (const f of readdirSync(`${DUMP}/${r.mode}`)) {
    copyFileSync(`${DUMP}/${r.mode}/${f}`, join(OUT, `${r.mode}-${f}`));
  }
  copyFileSync(r.pdf, join(OUT, `rv-p3-${r.mode}.pdf`));
}
rmSync(DUMP, { recursive: true, force: true });

const summary = runs.map((r) => ({
  mode: r.mode,
  pages: r.meta?.meta?.pages,
  pdfBytes: r.bytes,
  textPlan: r.textPlan ?? r.meta?.meta?.textPlan,
  patchPlan: r.meta?.meta?.patchPlan,
  visibleGlyphs: r.meta?.meta?.assemble?.visibleGlyphsPlaced,
  vectorFallback: r.meta?.meta?.vectorFallback ?? null,
}));
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 1));
if (summary[0].pages !== summary[1].pages) {
  console.error(`页数不一致：raster=${summary[0].pages} vector=${summary[1].pages}`);
  process.exit(1);
}
cdp.close();
