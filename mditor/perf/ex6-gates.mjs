// EX 阶段六门禁批：C3 三档公式完整性（默认/cv/减配）+ C2 多图 fixture +
// C1 产物断言。前置：dev 实例（9223）空闲（不要与密度档全量导出并发）。
// 用法：node perf/ex6-gates.mjs
// 产物：perf/results/ex-phase6-gates.json + ex-phase6-multiimg.pdf + 页位图。
import { writeFileSync, existsSync, statSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const FIX = "C:/Users/hh/Desktop/Tp/mditor/perf/fixtures";
const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT = join(ROOT, "perf", "results");
const DOC_DIR = "C:/Users/hh/Documents";

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");
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

const out = { startedAt: new Date().toISOString(), tiers: [], multiimg: null };

// ---- 设置驱动（与 ex1-repro 同路径）：读/写性能开关 ----
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

/** 档位断言：预处理后的 HTML $ 残留 + 工厂渲染 katex 节点数。 */
async function tierCheck(label, fixture) {
  const opened = await step(`open(${label})`, `window.__exportDebug.open(${JSON.stringify(join(FIX, fixture))})`, 30_000);
  if (!opened) throw new Error("open failed");
  await sleep(5000);
  const r = await step(`tier(${label})`, `(async () => {
    const dbg = window.__exportDebug;
    const gate = dbg.isBigDoc();
    const raw = dbg.getHTML();
    const { renderDegradedMath, renderBlockMath } = await import('/src/lib/exportMath.ts');
    // 镜像 doExport 预处理序
    let html = raw;
    if (gate) html = renderDegradedMath(html).html;
    html = renderBlockMath(html).html;
    const htmlDollars = (html.match(/\\$/g) || []).length;
    const css = await import('/src/lib/themeCss.ts').then(m => m.collectThemeCss());
    const fac = await import('/src/lib/exportRenderFactory.ts');
    const h = await fac.renderInFactory(html, { contentWidthPx: 680, css, maxImageHeightPx: 1009 });
    try {
      const factoryKatex = h.doc.querySelectorAll('.katex').length;
      const factoryDollars = (h.doc.querySelector('#mditor-export-content').textContent.match(/\\$/g) || []).length;
      return { gate, rawDollars: (raw.match(/\\$/g) || []).length, htmlDollars, factoryKatex, factoryDollars,
               blocks: h.content.children.length };
    } finally { h.destroy(); }
  })()`, 180_000);
  out.tiers.push({ label, fixture, ...r });
  console.log(JSON.stringify(r));
  return r;
}

// ---- C3：三档（先关干净 → 逐档开）----
console.log((await setPerfSwitches(false, false)));
await sleep(4000);
await tierCheck("default", "无穷级数_密度档压测副本.md");

console.log((await setPerfSwitches(false, true)));
await sleep(6000); // cv 档编辑器重建
await tierCheck("cv", "无穷级数_密度档压测副本.md");

console.log((await setPerfSwitches(true, false)));
await sleep(4000);
await tierCheck("degraded", "无穷级数_密度档压测副本_减配触发.md");

// 还原默认（全关）
console.log((await setPerfSwitches(false, false)));

// ---- C2：多图 fixture 全链路（PDF，含占位框视觉素材）----
await step("open-multiimg", `window.__exportDebug.open(${JSON.stringify(join(FIX, "多图导出压测副本.md"))})`, 30_000);
await sleep(5000);
const mm = await step("multiimg-pdf", `window.__exportDebug.exportPdfTo(${JSON.stringify(join(DOC_DIR, "ex6-multiimg.pdf"))}, {
  textLayer: true,
  dumpPages: { indices: [0], dir: ${JSON.stringify(DOC_DIR)}, name: "ex6-multiimg-page" },
})`, 300_000);
const mmFile = join(OUT, "ex-phase6-multiimg.pdf");
if (existsSync(join(DOC_DIR, "ex6-multiimg.pdf"))) {
  copyFileSync(join(DOC_DIR, "ex6-multiimg.pdf"), mmFile);
  if (existsSync(join(DOC_DIR, "ex6-multiimg-page-0.png"))) {
    copyFileSync(join(DOC_DIR, "ex6-multiimg-page-0.png"), join(OUT, "ex-phase6-multiimg-page0.png"));
  }
}
out.multiimg = mm;
console.log("multiimg:", JSON.stringify(mm).slice(0, 400));

writeFileSync(join(OUT, "ex-phase6-gates.json"), JSON.stringify(out, null, 2));
console.log("saved → perf/results/ex-phase6-gates.json");
