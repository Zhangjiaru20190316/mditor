// 门禁补跑：①按真实用户路径授权 fixtures 目录（工作区根递归授权，S1 语义）
// ②多图 fixture 重出 PDF + 首页位图 + missing 明细（此前 read-error 是作用域
// 环境问题，非分类逻辑）③C3 减配档 −1 katex 定位（默认 vs 减配公式清单 diff）。
// 产物：ex-phase6-gates.json 增补 multiimgDetail/c3diff 字段。
import { writeFileSync, existsSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const FIX = "C:/Users/hh/Desktop/Tp/mditor/perf/fixtures";
const OUT = "C:/Users/hh/Desktop/Tp/mditor/perf/results";
const DOC_DIR = "C:/Users/hh/Documents";

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
await cdp.send("Page.enable").catch(() => {});
await cdp.send("Page.bringToFront").catch(() => {});

const step = async (label, expr, cap = 120_000) => {
  const t0 = Date.now();
  const r = await Promise.race([
    cdp.eval(expr, { awaitPromise: true, returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${cap}ms`)), cap)),
  ]);
  console.log(`[${label}] ${Date.now() - t0}ms`);
  return r;
};

// ---- ①授权 fixtures 目录（工作区根语义）----
console.log(await step("grant", `(async () => {
  const { getAdapter } = await import('/src/platform/index.ts');
  await getAdapter().app.grantFsScope([${JSON.stringify(FIX)}], true);
  const b = await getAdapter().fs.readFile(${JSON.stringify(FIX + "/assets/normal-red.png")});
  return 'granted, probe read bytes=' + b.length;
})()`));

// ---- ②多图重出（missing 明细 + 占位框分类）----
await step("open-multiimg", `window.__exportDebug.open(${JSON.stringify(join(FIX, "多图导出压测副本.md"))})`, 30_000);
await sleep(5000);
const mm = await step("multiimg-pdf", `window.__exportDebug.exportPdfTo(${JSON.stringify(join(DOC_DIR, "ex6-multiimg.pdf"))}, {
  textLayer: true,
  dumpPages: { indices: [0, 2], dir: ${JSON.stringify(DOC_DIR)}, name: "ex6-multiimg-page" },
})`, 300_000);
console.log("multiimg:", JSON.stringify(mm).slice(0, 500));

// missing 明细（与 exportPdfTo 同序的共享管线直调）
const detail = await step("missing-detail", `(async () => {
  const dbg = window.__exportDebug;
  const { sanitizeExportHtml } = await import('/src/lib/exportSanitize.ts');
  const { inlineExportImages } = await import('/src/lib/exporter.ts');
  const html = sanitizeExportHtml(dbg.getHTML());
  const r = await inlineExportImages(html, dbg.docPath(), { remote: 'fetch' });
  return r.missing.map(m => ({ src: (m.src || '').slice(0, 70), status: m.status, bytes: m.bytes ?? null, detail: (m.detail || '').slice(0, 80) }));
})()`, 60_000);
console.log("missing:", JSON.stringify(detail));

if (existsSync(join(DOC_DIR, "ex6-multiimg.pdf"))) {
  copyFileSync(join(DOC_DIR, "ex6-multiimg.pdf"), join(OUT, "ex-phase6-multiimg.pdf"));
  for (const i of [0, 2]) {
    const src = join(DOC_DIR, `ex6-multiimg-page-${i}.png`);
    if (existsSync(src)) copyFileSync(src, join(OUT, `ex-phase6-multiimg-page${i}.png`));
  }
}

// ---- ③C3 −1 katex 定位：默认 vs 减配的公式文本清单 diff ----
async function setPerfSwitches(big, viewport) {
  return cdp.eval(`(async () => {
    const btns = [...document.querySelectorAll('nav.mb button, nav.mb [role=button]')];
    const help = btns.find(b => b.textContent.trim() === '帮助');
    if (!help) return 'no-help';
    help.click();
    await new Promise(r => setTimeout(r, 300));
    const item = [...document.querySelectorAll('div,button,a')].find(e => e.textContent.trim() === '设置…' && e.offsetParent !== null);
    if (!item) return 'no-settings';
    item.click();
    await new Promise(r => setTimeout(r, 500));
    const navs = [...document.querySelectorAll('.settings-nav-btn')];
    if (!navs[3]) return 'no-nav-3';
    navs[3].click();
    await new Promise(r => setTimeout(r, 300));
    const boxes = [...document.querySelectorAll('.settings-pane input[type=checkbox]')];
    if (boxes.length < 2) return 'no-boxes';
    const want = [${big ? "true" : "false"}, ${viewport ? "true" : "false"}];
    [boxes[0], boxes[1]].forEach((b, i) => { if (b.checked !== want[i]) b.click(); });
    await new Promise(r => setTimeout(r, 300));
    const apply = [...document.querySelectorAll('.modal button, [class*=modal] button')].find(b => b.textContent.trim() === '应用');
    if (!apply) return 'no-apply';
    apply.click();
    await new Promise(r => setTimeout(r, 400));
    return 'ok:' + boxes[0].checked + ',' + boxes[1].checked;
  })()`, { awaitPromise: true, returnByValue: true });
}

async function katexInventory(fixture) {
  const opened = await step(`open(${fixture})`, `window.__exportDebug.open(${JSON.stringify(join(FIX, fixture))})`, 30_000);
  if (!opened) throw new Error("open failed");
  await sleep(5000);
  return step(`inv(${fixture})`, `(async () => {
    const dbg = window.__exportDebug;
    const gate = dbg.isBigDoc();
    let html = dbg.getHTML();
    const { renderDegradedMath, renderBlockMath } = await import('/src/lib/exportMath.ts');
    if (gate) html = renderDegradedMath(html).html;
    html = renderBlockMath(html).html;
    const css = await import('/src/lib/themeCss.ts').then(m => m.collectThemeCss());
    const fac = await import('/src/lib/exportRenderFactory.ts');
    const h = await fac.renderInFactory(html, { contentWidthPx: 680, css, maxImageHeightPx: 1009 });
    try {
      const list = [...h.doc.querySelectorAll('.katex')].map(k => (k.textContent || '').replace(/\\s+/g, ''));
      return { gate, count: list.length, list };
    } finally { h.destroy(); }
  })()`, 180_000);
}

console.log(await setPerfSwitches(false, false));
await sleep(4000);
const def = await katexInventory("无穷级数_密度档压测副本.md");
console.log("default katex:", def.count);

console.log(await setPerfSwitches(true, false));
await sleep(4000);
const deg = await katexInventory("无穷级数_密度档压测副本_减配触发.md");
console.log("degraded katex:", deg.count);

console.log(await setPerfSwitches(false, false)); // 还原默认

// 清单 diff：找出默认有、减配没有（或合并）的公式
const defSet = new Map();
for (const s of def.list) defSet.set(s, (defSet.get(s) ?? 0) + 1);
const degSet = new Map();
for (const s of deg.list) degSet.set(s, (degSet.get(s) ?? 0) + 1);
const onlyDefault = [];
for (const [s, n] of defSet) {
  const m = degSet.get(s) ?? 0;
  if (m < n) onlyDefault.push({ text: s.slice(0, 80), defCount: n, degCount: m });
}
const onlyDegraded = [];
for (const [s, n] of degSet) {
  const m = defSet.get(s) ?? 0;
  if (m < n) onlyDegraded.push({ text: s.slice(0, 80), degCount: n, defCount: m });
}
console.log("onlyDefault:", JSON.stringify(onlyDefault.slice(0, 5)));
console.log("onlyDegraded:", JSON.stringify(onlyDegraded.slice(0, 5)));

// ---- 落盘：合并进 gates JSON ----
const gatesPath = join(OUT, "ex-phase6-gates.json");
const gates = JSON.parse(readFileSync(gatesPath, "utf8"));
gates.multiimgDetail = { meta: mm.meta, missingCount: mm.missingCount, missing: detail };
gates.c3diff = { defaultCount: def.count, degradedCount: deg.count, onlyDefault, onlyDegraded };
gates.fixtureScopeGranted = true;
writeFileSync(gatesPath, JSON.stringify(gates, null, 2));
console.log("saved → perf/results/ex-phase6-gates.json");
