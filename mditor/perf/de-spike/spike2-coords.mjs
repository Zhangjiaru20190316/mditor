// DE 轮阶段 0 spike ②③：pdfjs→pdf-lib 坐标映射 + CJK 重绘质量（Node）。
import { spawnSync } from "node:child_process";
//
// spike②（坐标映射）：
//   * 页1 常规页：pdfjs textItem.transform[4/5] 基线 → pdf-lib drawText 原点，
//     bbox（transform+width/height）→ drawRectangle 覆盖矩形；
//   * 页2 /Rotate 90 / 页3 CropBox 偏移：同法实测映射是否仍成立；
//   * 数值验证：补丁后用 pdfjs 重新提取，新文本 item 的 transform 与原行
//     基线逐分量对比（ε=0.05pt）。
// spike③（CJK 重绘）：
//   * NotoSansSC subset:true 嵌入 + drawText：纯中文/中英混排/全角标点；
//   * 宽度精度：pdf-lib widthOfTextAtSize vs pdfjs 回读 item.width（同一嵌入
//     字体两套测量引擎的偏差）；
//   * 字号收缩：w(s) 随 size 线性 → 一发公式 size* = size0·W/w0 的实测验证；
//   * 缺字形：emoji 经 fontkit hasGlyphForCodePoint 拒绝；强行 drawText 的
//     行为记录。
// 结果打印 JSON 摘要（报告人工整理）。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, rgb, degrees } from "pdf-lib";
import fontkitMod from "@pdf-lib/fontkit";
const fontkit = fontkitMod.default ?? fontkitMod;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIX = path.join(ROOT, "perf", "de-spike", "fixtures");
const OUT = path.join(ROOT, "perf", "de-spike", "out");
mkdirSync(OUT, { recursive: true });
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const NOTO = readFileSync(path.join(ROOT, "public", "assets", "fonts", "NotoSansSC-Regular.otf"));
const INTER = readFileSync(path.join(ROOT, "public", "assets", "fonts", "Inter-Medium.ttf"));

async function textItems(pdfPath) {
  const data = new Uint8Array(readFileSync(pdfPath));
  const task = pdfjs.getDocument({ data, isEvalSupported: false });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({
      view: vp.viewBox, // [x0,y0,x1,y1]
      rotate: vp.rotation,
      items: tc.items.map((it) => ({
        str: it.str,
        tx: it.transform,
        w: it.width,
        h: it.height,
      })),
    });
  }
  await task.destroy();
  return pages;
}

// ---- spike ②：三页各打一个补丁 --------------------------------------------------

const src = readFileSync(path.join(FIX, "rotate-crop.pdf"));
const origPages = await textItems(path.join(FIX, "rotate-crop.pdf"));
const coordResults = [];

const doc = await PDFDocument.load(new Uint8Array(src), { updateMetadata: false });
doc.registerFontkit(fontkit);
const noto = await doc.embedFont(NOTO, { subset: true });

const NEW_TEXT = "已替换 REPLACED";
for (let pi = 0; pi < 3; pi++) {
  const line = origPages[pi].items.find((it) => it.str.includes("TARGET-LINE"));
  if (!line) { coordResults.push({ page: pi + 1, error: "target line not found" }); continue; }
  const [a, b, c, d, e, f] = line.tx;
  const page = doc.getPage(pi);
  const size = Math.round(Math.hypot(b, d) * 1000) / 1000 || d; // 有效字号（含旋转分量）
  // 覆盖矩形：pdfjs item 以基线原点 + width/height（用户空间，y 向上）描述。
  // 近似 bbox：x∈[e, e+w]，y∈[f - 0.26·size, f + 0.98·size]（Noto 度量 ascent≈1.08/descent≈0.29 实测后微调）。
  const padX = 1, desc = 0.30 * size, asc = 1.12 * size;
  page.drawRectangle({
    x: e - padX, y: f - desc, width: line.w + padX * 2, height: desc + asc,
    color: rgb(1, 1, 1),
  });
  const shrinkTo = line.w; // ① 先按原字号画（映射验证）——宽度验证在 spike③
  page.drawText(NEW_TEXT, { x: e, y: f, size, font: noto, color: rgb(0.05, 0.05, 0.6) });
  coordResults.push({
    page: pi + 1,
    origLine: { str: line.str, e: Math.round(e * 100) / 100, f: Math.round(f * 100) / 100, size, w: Math.round(line.w * 100) / 100, h: Math.round(line.h * 100) / 100, a: Math.round(a * 1000) / 1000, b: Math.round(b * 1000) / 1000, d: Math.round(d * 1000) / 1000 },
    viewBox: origPages[pi].view,
    rotation: origPages[pi].rotate,
    drawnAt: { x: e, y: f, size },
    shrinkTo,
  });
}
writeFileSync(path.join(OUT, "spike2-patched.pdf"), await doc.save({ useObjectStreams: false }));

// 补丁后回读：新文本 item 的基线位置 vs 原行基线
const patchedPages = await textItems(path.join(OUT, "spike2-patched.pdf"));
for (const r of coordResults) {
  if (r.error) continue;
  const p = patchedPages[r.page - 1];
  const nt = p.items.find((it) => it.str === NEW_TEXT);
  const firstPiece = p.items.find((it) => it.str.startsWith("已替换"));
  const item = nt ?? firstPiece;
  r.verify = item
    ? {
        found: true,
        exactItem: !!nt,
        e: Math.round(item.tx[4] * 100) / 100,
        f: Math.round(item.tx[5] * 100) / 100,
        dx: Math.round((item.tx[4] - r.drawnAt.x) * 1000) / 1000,
        dy: Math.round((item.tx[5] - r.drawnAt.y) * 1000) / 1000,
        w: Math.round(item.w * 100) / 100,
      }
    : { found: false };
}

// ---- spike ③：CJK 宽度/收缩/缺字形 ---------------------------------------------

const doc3 = await PDFDocument.create();
doc3.registerFontkit(fontkit);
const noto3 = await doc3.embedFont(NOTO, { subset: true });
const inter = await doc3.embedFont(INTER, { subset: true });
const page = doc3.addPage([595.28, 841.89]);

const samples = [
  "纯中文样本：行级微编辑重绘质量验证。",
  "Mixed 中英混排 with Inter/Noto both, 含 half-width!",
  "全角标点：，。：；！？（）【】《》——……",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
];
const cjkResults = [];
let y = 780;
for (const s of samples) {
  const w14 = noto3.widthOfTextAtSize(s, 14);
  page.drawText(s, { x: 60, y, size: 14, font: noto3, color: rgb(0, 0, 0) });
  const w14Inter = inter.widthOfTextAtSize(s, 14);
  cjkResults.push({ sample: s.slice(0, 18) + "…", w14_noto: Math.round(w14 * 1000) / 1000, w14_inter: Math.round(w14Inter * 1000) / 1000 });
  y -= 24;
}
// Inter 拉丁 run 实测
const latinOnly = "Latin run in Inter Medium 14pt";
page.drawText(latinOnly, { x: 60, y, size: 14, font: inter, color: rgb(0.1, 0.1, 0.5) });
cjkResults.push({ sample: latinOnly, w14_inter: Math.round(inter.widthOfTextAtSize(latinOnly, 14) * 1000) / 1000 });

// 字号收缩线性验证：目标宽 200
const LONG = "这是一行非常长的中文替换文本，用于验证字号自适应收缩公式是否精确成立。";
const w0 = noto3.widthOfTextAtSize(LONG, 14);
const sizeStar = (14 * 200) / w0;
const wStar = noto3.widthOfTextAtSize(LONG, sizeStar);
page.drawText(LONG, { x: 60, y: y - 24, size: sizeStar, font: noto3, color: rgb(0.4, 0, 0) });
page.drawRectangle({ x: 60, y: y - 24 - 6, width: 200, height: 4, color: rgb(1, 0, 0) }); // 200pt 标尺
const shrink = { w0: Math.round(w0 * 1000) / 1000, sizeStar: Math.round(sizeStar * 1000) / 1000, wStar: Math.round(wStar * 1000) / 1000, errPt: Math.round((wStar - 200) * 1000) / 1000 };

// 缺字形：emoji —— 子进程隔离（实测：subset:true 下缺字形的 CFFSubset 崩溃
// 发生在 fontkit 流回调里，try/catch 兜不住，会杀死宿主进程）。
const g = fontkit.create(NOTO);
const emojiCp = 0x1f600;
const hasEmoji = g.hasGlyphForCodepoint ? null : g.hasGlyphForCodePoint(emojiCp);
const CHILD = `
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import fontkitMod from "@pdf-lib/fontkit";
const fontkit = fontkitMod.default ?? fontkitMod;
const NOTO = readFileSync(${JSON.stringify(path.join(ROOT, "public/assets/fonts/NotoSansSC-Regular.otf"))});
const d2 = await PDFDocument.create();
d2.registerFontkit(fontkit);
const f2 = await d2.embedFont(NOTO, { subset: true });
d2.addPage([200, 100]).drawText("\\u{1F600}", { x: 10, y: 50, size: 14, font: f2 });
await d2.save();
console.log("saved-ok");
`;
writeFileSync(path.join(OUT, "_emoji-child.mjs"), CHILD);
const childR = spawnSync(process.execPath, [path.join(OUT, "_emoji-child.mjs")], { encoding: "utf8", cwd: ROOT });
const emojiDrawError = childR.status === 0 ? null : `child exit ${childR.status}: ${(childR.stderr || "").split("\n").filter((l) => l.includes("Error") || l.includes("error"))[0] ?? childR.stderr?.slice(0, 160)}`;
writeFileSync(path.join(OUT, "spike3-cjk.pdf"), await doc3.save({ useObjectStreams: false }));

// spike③ 回读宽度对比（pdfjs 同字体测量）
const cjkPages = await textItems(path.join(OUT, "spike3-cjk.pdf"));
const widthCheck = [];
for (let i = 0; i < cjkResults.length; i++) {
  const line = cjkPages[0].items.find((it) => it.w > 10 && it.str.length > 3 && Math.abs(it.tx[5] - (780 - i * 24)) < 1.5);
  if (line) widthCheck.push({ i, pdfjsW: Math.round(line.w * 1000) / 1000, libW: cjkResults[i].w14_noto ?? cjkResults[i].w14_inter, errPt: Math.round((line.w - (cjkResults[i].w14_noto ?? cjkResults[i].w14_inter)) * 1000) / 1000 });
}

console.log(JSON.stringify({ spike2_coords: coordResults, spike3_cjk: cjkResults, spike3_widthCheck: widthCheck, spike3_shrink: shrink, spike3_missingGlyph: { hasEmoji, emojiDrawError } }, null, 2));
