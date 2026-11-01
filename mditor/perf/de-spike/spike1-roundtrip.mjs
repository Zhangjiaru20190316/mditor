// DE 轮阶段 0 spike ①：pdf-lib load→save 保真实测（Node）。
//
// 对每个夹具：load（不 updateMetadata、不 ignoreEncryption）→ save
// （useObjectStreams 两档）→ 与原件做结构对比：
//   * 文本层：pdfjs legacy 逐页 getTextContent —— str 拼接串 + 逐 item
//     transform/width/height（ε=0.01）全等判定；
//   * 注释：page.getAnnotations —— 数量/Subtype/URI/Contents 对比；
//   * 表单：pdf-lib getForm().getFields() —— 名称/类型/值对比；
//   * 体积/耗时/RSS 增量；大文件另测 load+save 峰值内存。
// 结果写 perf/de-spike/results/spike1.json 并打印摘要。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIX = path.join(ROOT, "perf", "de-spike", "fixtures");
const OUT = path.join(ROOT, "perf", "de-spike", "out");
mkdirSync(OUT, { recursive: true });

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

async function extract(pdfPath) {
  const data = new Uint8Array(readFileSync(pdfPath));
  const task = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const items = tc.items.map((it) => ({
      str: it.str,
      transform: it.transform.map((n) => Math.round(n * 100) / 100),
      width: Math.round((it.width ?? 0) * 100) / 100,
      height: Math.round((it.height ?? 0) * 100) / 100,
    }));
    const annots = (await page.getAnnotations({ intent: "display" })).map((a) => ({
      subtype: a.subtype,
      url: a.url ?? a.unsafeUrl ?? null,
      contents: a.contents ?? null,
      rect: a.rect?.map((n) => Math.round(n * 100) / 100) ?? null,
    }));
    pages.push({ items, annots });
  }
  const meta = { title: (await doc.getMetadata()).info?.Title ?? null };
  await task.destroy();
  return { pages, meta };
}

function diffExtract(a, b) {
  if (a.pages.length !== b.pages.length) return `pageCount ${a.pages.length}→${b.pages.length}`;
  for (let p = 0; p < a.pages.length; p++) {
    const pa = a.pages[p];
    const pb = b.pages[p];
    if (pa.items.length !== pb.items.length)
      return `p${p + 1} textItems ${pa.items.length}→${pb.items.length}`;
    for (let i = 0; i < pa.items.length; i++) {
      const ia = pa.items[i];
      const ib = pb.items[i];
      if (ia.str !== ib.str) return `p${p + 1} item${i} str "${ia.str}"→"${ib.str}"`;
      for (let t = 0; t < 6; t++) {
        if (Math.abs(ia.transform[t] - ib.transform[t]) > 0.01)
          return `p${p + 1} item${i} transform[${t}] ${ia.transform[t]}→${ib.transform[t]}`;
      }
      if (Math.abs(ia.width - ib.width) > 0.01 || Math.abs(ia.height - ib.height) > 0.01)
        return `p${p + 1} item${i} wh ${ia.width}x${ia.height}→${ib.width}x${ib.height}`;
    }
    const ka = JSON.stringify(pa.annots);
    const kb = JSON.stringify(pb.annots);
    if (ka !== kb) return `p${p + 1} annots ${ka}→${kb}`;
  }
  return null; // 无差异
}

async function formSnapshot(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = doc.tryGet ? null : null;
  try {
    const f = doc.getForm();
    return f.getFields().map((fd) => {
      const name = fd.getName();
      const ctor = fd.constructor.name;
      let value = null;
      try {
        if (ctor === "PDFTextField") value = fd.getText();
        else if (ctor === "PDFCheckBox") value = fd.isChecked();
      } catch { /* 无 appearance 不阻断 */ }
      return { name, ctor, value };
    });
  } catch {
    return []; // 无 AcroForm
  }
}

const FIXTURES = ["foreign-edge.pdf", "lib-form.pdf", "big-50mb.pdf", "rotate-crop.pdf"];
const results = [];

for (const name of FIXTURES) {
  const bytes = readFileSync(path.join(FIX, name));
  const entry = { name, origBytes: bytes.length };
  const orig = await extract(path.join(FIX, name));
  entry.origTextItems = orig.pages.reduce((n, p) => n + p.items.length, 0);
  entry.origAnnots = orig.pages.reduce((n, p) => n + p.annots.length, 0);

  for (const useObjectStreams of [true, false]) {
    const tag = useObjectStreams ? "os-true" : "os-false";
    const t0 = performance.now();
    const rss0 = process.memoryUsage().rss;
    let doc;
    try {
      doc = await PDFDocument.load(new Uint8Array(bytes), { updateMetadata: false });
    } catch (e) {
      entry[tag] = { loadError: String(e) };
      continue;
    }
    const tLoad = performance.now();
    const saved = await doc.save({ useObjectStreams });
    const tSave = performance.now();
    const rss1 = process.memoryUsage().rss;
    const outPath = path.join(OUT, name.replace(".pdf", `-rt-${tag}.pdf`));
    writeFileSync(outPath, saved);
    const rt = await extract(outPath);
    const diff = diffExtract(orig, rt);
    entry[tag] = {
      bytes: saved.length,
      loadMs: Math.round(tLoad - t0),
      saveMs: Math.round(tSave - tLoad),
      rssDeltaMB: Math.round((rss1 - rss0) / 1048576),
      textAnnotsPreserved: diff === null,
      diff: diff ?? "IDENTICAL",
    };
  }

  // 表单对比（lib-form 专用）
  if (name === "lib-form.pdf") {
    const osFalse = readFileSync(path.join(OUT, "lib-form-rt-os-false.pdf"));
    const a = await formSnapshot(new Uint8Array(bytes));
    const b = await formSnapshot(new Uint8Array(osFalse));
    entry.formFields = { orig: a, roundtrip: b, preserved: JSON.stringify(a) === JSON.stringify(b) };
  }
  results.push(entry);
  console.log(JSON.stringify(entry, null, 2));
}

const resDir = path.join(ROOT, "perf", "de-spike", "results");
mkdirSync(resDir, { recursive: true });
writeFileSync(path.join(resDir, "spike1.json"), JSON.stringify(results, null, 2));
console.log("\n==== spike1 summary ====");
for (const r of results) {
  console.log(
    r.name.padEnd(20),
    "osT:", r["os-true"]?.textAnnotsPreserved ? "OK" : "DIFF",
    "osF:", r["os-false"]?.textAnnotsPreserved ? "OK" : "DIFF",
    "| size", r.origBytes, "→", r["os-true"]?.bytes, "/", r["os-false"]?.bytes,
    "| load/save", r["os-true"]?.loadMs + "/" + r["os-true"]?.saveMs, "ms",
    "| form", r.formFields ? (r.formFields.preserved ? "OK" : "DIFF") : "-"
  );
  if (r["os-true"]?.diff && r["os-true"].diff !== "IDENTICAL") console.log("   os-true diff:", r["os-true"].diff);
  if (r["os-false"]?.diff && r["os-false"].diff !== "IDENTICAL") console.log("   os-false diff:", r["os-false"].diff);
}
