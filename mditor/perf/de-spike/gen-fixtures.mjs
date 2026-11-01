// DE 轮阶段 0 spike 夹具生成（Node ≥22，零新依赖——pdf-lib/pdfjs/fontkit 均项目内）。
//
// 产出 perf/de-spike/fixtures/：
//   foreign-edge.pdf   外部生成器产物（Chromium print-to-PDF：文本+链接注释）
//   lib-form.pdf       pdf-lib 产物（CJK 文本 + AcroForm 文本域/复选框 + Link/Text 注释）
//   big-50mb.pdf       ~50MB 大文件（3 页 × 噪声 PNG 内嵌——随机数据不可压缩）
//   rotate-crop.pdf    坐标映射专用（页1 常规 / 页2 /Rotate 90 / 页3 CropBox 偏移）
//
// 用法：node perf/de-spike/gen-fixtures.mjs
import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import fontkitMod from "@pdf-lib/fontkit";
import { PDFName, PDFString } from "pdf-lib";
const fontkit = fontkitMod.default ?? fontkitMod;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = path.join(ROOT, "perf", "de-spike", "fixtures");
const FONTS = path.join(ROOT, "public", "assets", "fonts");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
mkdirSync(DIR, { recursive: true });

// ---- 噪声 PNG（随机 RGB → deflate 不掉体积，撑大文件用）----------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function makeNoisePng(w, h, seed = 42) {
  // xorshift32 —— 确定性伪随机（可复现夹具）
  let s = seed || 1;
  const rand = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0; // filter none
    for (let x = 0; x < w * 3; x += 3) {
      raw[off + 1 + x] = rand() & 0xff;
      raw[off + 2 + x] = rand() & 0xff;
      raw[off + 3 + x] = rand() & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- 夹具 ①：外部生成器（Chromium print-to-PDF）-------------------------------

const htmlPath = path.join(DIR, "src.html");
writeFileSync(
  htmlPath,
  `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body{font-family:"Microsoft YaHei",sans-serif;margin:24px;line-height:1.6}
  h1{font-size:22px}h2{font-size:17px}table{border-collapse:collapse}td{border:1px solid #999;padding:4px 10px}
  </style></head><body>
  <h1>外部生成器夹具 Foreign Producer Fixture</h1>
  <h2>1. 中文段落</h2>
  <p>这是用于 pdf-lib 载入→保存保真测试的中文段落。行级微编辑要求未编辑内容原样保留，
  因此首先必须确认 pdf-lib 的重写不会破坏 Chromium 生成的文本层、字体子集与链接注释。</p>
  <h2>2. Link annotation</h2>
  <p><a href="https://example.com/de-spike">an external hyperlink that Chromium emits as /Link annot</a></p>
  <h2>3. 表格</h2>
  <table><tr><td>甲</td><td>乙</td><td>丙</td></tr><tr><td>11</td><td>22</td><td>33</td></tr></table>
  </body></html>`
);
execFileSync(
  EDGE,
  [
    "--headless=new", "--disable-gpu", "--no-first-run",
    "--no-pdf-header-footer",
    `--print-to-pdf=${path.join(DIR, "foreign-edge.pdf")}`,
    `file:///${htmlPath.replace(/\\/g, "/")}`,
  ],
  { stdio: "ignore" }
);

// ---- 夹具 ②：pdf-lib 产物（AcroForm + Link/Text 注释 + CJK）-------------------

async function buildLibForm() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle("lib-form 夹具");
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const noto = await doc.embedFont(readFileSync(path.join(FONTS, "NotoSansSC-Regular.otf")), { subset: false });

  // 页 1：标题 + CJK 段落（供 spike②③ 坐标/重绘定位复用）
  const p1 = doc.addPage([595.28, 841.89]);
  p1.drawText("Spike Fixture / 第一页标题", { x: 72, y: 760, size: 20, font: noto, color: rgb(0.1, 0.1, 0.1) });
  p1.drawText("这是第一段中文正文，行级微编辑将替换本行的内容。", { x: 72, y: 720, size: 14, font: noto });
  p1.drawText("Mixed 中英混排 line with punctuation，标点与空格。", { x: 72, y: 690, size: 14, font: noto });
  p1.drawText("第二段：未被编辑的内容必须在保存后逐字节保留。", { x: 72, y: 660, size: 14, font: noto });

  // 页 2：AcroForm（文本域 + 复选框）
  const p2 = doc.addPage([595.28, 841.89]);
  p2.drawText("AcroForm Page", { x: 72, y: 760, size: 18, font: helv });
  const form = doc.getForm();
  const tf = form.createTextField("spike.text1");
  tf.setText("prefilled");
  tf.addToPage(p2, { x: 72, y: 700, width: 220, height: 24 });
  const cb = form.createCheckBox("spike.check1");
  cb.addToPage(p2, { x: 72, y: 650, width: 18, height: 18 });

  // Link + Text（便笺）注释 —— 低层 API（pdf-lib 无高层链接封装）
  const ctx = doc.context;
  const linkAnnot = ctx.obj({
    Type: "Annot", Subtype: "Link",
    Rect: [72, 600, 300, 620],
    Border: [0, 0, 1],
    C: [0, 0, 1],
    A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.com/lib-form") },
  });
  const noteAnnot = ctx.obj({
    Type: "Annot", Subtype: "Text",
    Rect: [320, 600, 336, 616],
    Contents: PDFString.of("便笺注释内容"),
    T: PDFString.of("Spike Author"),
  });
  p2.node.set(PDFName.of("Annots"), ctx.obj([ctx.register(linkAnnot), ctx.register(noteAnnot)]));

  // 页 3：CJK 密集页（spike③ 重绘密度）
  const p3 = doc.addPage([595.28, 841.89]);
  for (let i = 0; i < 12; i++) {
    p3.drawText(`第三页中文行 ${i + 1}：微编辑覆盖矩形与重绘文本的质量验证。`, {
      x: 72, y: 780 - i * 28, size: 12, font: noto,
    });
  }
  // 大纲（书签）
  p1.drawText("", { x: 0, y: 0, size: 1, font: helv }); // noop 占位
  const out = await doc.save({ useObjectStreams: false });
  writeFileSync(path.join(DIR, "lib-form.pdf"), out);

  // 大纲需要低层写 outline —— 简化：跳过（保真检查用页文本/注释/表单已足够覆盖面）
}

// ---- 夹具 ③：~50MB 大文件 ------------------------------------------------------

async function buildBig() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const noto = await doc.embedFont(readFileSync(path.join(FONTS, "NotoSansSC-Regular.otf")), { subset: false });
  for (let i = 0; i < 3; i++) {
    const png = makeNoisePng(3000, 1800, 1000 + i);
    const img = await doc.embedPng(png);
    const page = doc.addPage([595.28, 841.89]);
    page.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
    page.drawText(`大文件页 ${i + 1}`, { x: 24, y: 800, size: 16, font: noto });
  }
  const out = await doc.save({ useObjectStreams: false });
  writeFileSync(path.join(DIR, "big-50mb.pdf"), out);
  return out.length;
}

// ---- 夹具 ④：rotate/crop（spike② 专用）----------------------------------------

async function buildRotateCrop() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const noto = await doc.embedFont(readFileSync(path.join(FONTS, "NotoSansSC-Regular.otf")), { subset: false });

  const p1 = doc.addPage([595.28, 841.89]); // 常规页
  p1.drawText("PAGE1 常规页：目标替换行 TARGET-LINE-P1", { x: 72, y: 720, size: 14, font: noto });

  const p2 = doc.addPage([595.28, 841.89]); // /Rotate 90
  p2.setRotation(degrees(90));
  p2.drawText("PAGE2 旋转页：目标替换行 TARGET-LINE-P2", { x: 72, y: 720, size: 14, font: noto });

  const p3 = doc.addPage([595.28, 841.89]); // CropBox 偏移
  p3.setCropBox(40, 60, 595.28 - 40, 841.89 - 60);
  p3.drawText("PAGE3 裁剪页：目标替换行 TARGET-LINE-P3", { x: 72, y: 720, size: 14, font: noto });

  const out = await doc.save({ useObjectStreams: false });
  writeFileSync(path.join(DIR, "rotate-crop.pdf"), out);
}

await buildLibForm();
const bigBytes = await buildBig();
await buildRotateCrop();
const sizes = {};
for (const f of ["foreign-edge.pdf", "lib-form.pdf", "big-50mb.pdf", "rotate-crop.pdf"]) {
  sizes[f] = (readFileSync(path.join(DIR, f)).length / 1024 / 1024).toFixed(2) + " MB";
}
console.log(JSON.stringify({ dir: DIR, sizes, bigBytes }, null, 2));
