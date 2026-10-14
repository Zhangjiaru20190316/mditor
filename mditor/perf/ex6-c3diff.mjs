// C3 精查：默认 vs 减配的 KaTeX 清单全量文本对比（gates2 落盘截断 80 字符
// 导致配对失败）。产出：①规范化配对结果 ②减配侧「合并节点」检测（文本 =
// 两个默认公式拼接）③计数差 Δ 的定位。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const FIX = "C:/Users/hh/Desktop/Tp/mditor/perf/fixtures";
const OUT = "C:/Users/hh/Desktop/Tp/mditor/perf/results";

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
await cdp.send("Page.enable").catch(() => {});
await cdp.send("Page.bringToFront").catch(() => {});

const step = async (label, expr, cap = 180_000) => {
  const t0 = Date.now();
  const r = await Promise.race([
    cdp.eval(expr, { awaitPromise: true, returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${cap}ms`)), cap)),
  ]);
  console.log(`[${label}] ${Date.now() - t0}ms`);
  return r;
};

async function setPerfSwitches(big) {
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
    const want = [${big ? "true" : "false"}, false];
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
    const dollars = (html.match(/\\$/g) || []).length;
    const css = await import('/src/lib/themeCss.ts').then(m => m.collectThemeCss());
    const fac = await import('/src/lib/exportRenderFactory.ts');
    const h = await fac.renderInFactory(html, { contentWidthPx: 680, css, maxImageHeightPx: 1009 });
    try {
      // 全量文本 + 相邻公式是否被同一容器承载（合并检测）
      const list = [...h.doc.querySelectorAll('.katex')].map(k => ({
        text: (k.textContent || '').replace(/\\s+/g, ''),
        parent: (k.parentElement?.tagName || '') + '#' + ([...k.parentElement?.children || []].filter(c => c.classList.contains('katex')).length),
      }));
      return { gate, dollars, count: list.length, list };
    } finally { h.destroy(); }
  })()`, 180_000);
}

console.log(await setPerfSwitches(false));
await sleep(4000);
const def = await katexInventory("无穷级数_密度档压测副本.md");
console.log("default:", def.count, "dollars:", def.dollars);

console.log(await setPerfSwitches(true));
await sleep(4000);
const deg = await katexInventory("无穷级数_密度档压测副本_减配触发.md");
console.log("degraded:", deg.count, "dollars:", deg.dollars);

console.log(await setPerfSwitches(false)); // 还原默认
await sleep(2000);

// ---- 分析：规范化配对 + 合并检测 ----
const norm = (s) => s.replace(/[\\,\s]/g, "");
const defTexts = def.list.map(e => e.text);
const degTexts = deg.list.map(e => e.text);
const defBag = new Map();
for (const t of defTexts) defBag.set(t, (defBag.get(t) ?? 0) + 1);
const degBag = new Map();
for (const t of degTexts) degBag.set(t, (degBag.get(t) ?? 0) + 1);

// ①精确配对
const exactDefault = [], exactDegraded = [];
for (const [t, n] of defBag) { const m = degBag.get(t) ?? 0; if (m < n) exactDefault.push({ text: t, def: n, deg: m }); }
for (const [t, n] of degBag) { const m = defBag.get(t) ?? 0; if (m < n) exactDegraded.push({ text: t, deg: n, def: m }); }
console.log("精确配对后 default 富余条目:", exactDefault.length, "degraded 富余条目:", exactDegraded.length);

// ②规范化（\,、空白）配对
const nDef = new Map();
for (const [t, n] of defBag) { const k = norm(t); nDef.set(k, (nDef.get(k) ?? 0) + n); }
const nDeg = new Map();
for (const [t, n] of degBag) { const k = norm(t); nDeg.set(k, (nDeg.get(k) ?? 0) + n); }
let normUnpairedDef = [];
for (const [k, n] of nDef) { const m = nDeg.get(k) ?? 0; if (m < n) normUnpairedDef.push({ k: k.slice(0, 100), def: n, deg: m }); }
let normUnpairedDeg = [];
for (const [k, n] of nDeg) { const m = nDef.get(k) ?? 0; if (m < n) normUnpairedDeg.push({ k: k.slice(0, 100), deg: n, def: m }); }
console.log("规范化配对后仍未配对: default", normUnpairedDef.length, "| degraded", normUnpairedDeg.length);
normUnpairedDef.slice(0, 5).forEach(u => console.log("  DEF_ONLY:", JSON.stringify(u.k)));
normUnpairedDeg.slice(0, 5).forEach(u => console.log("  DEG_ONLY:", JSON.stringify(u.k)));

// ③合并检测：degraded 文本 ≈ 两个 default 文本拼接
const merges = [];
if (normUnpairedDef.length >= 2) {
  const degKeys = new Set(normUnpairedDeg.map(u => u.k));
  for (let i = 0; i < normUnpairedDef.length; i++) {
    for (let j = 0; j < normUnpairedDef.length; j++) {
      if (i === j) continue;
      const cat = normUnpairedDef[i].k + normUnpairedDef[j].k;
      if (degKeys.has(cat)) merges.push({ a: i, b: j, cat: cat.slice(0, 80) });
    }
  }
}
console.log("合并候选（deg = def[i]+def[j]）:", merges.length, merges.slice(0, 3));

// ④容器父子计数（同容器多公式 = 编辑器相邻渲染特征）
const multiKatexParents = deg.list.filter(e => parseInt(e.parent.split('#')[1] || '0') > 1).length;
console.log("degraded 同容器多公式容器数:", multiKatexParents);

writeFileSync(join(OUT, "ex-phase6-c3diff-full.json"), JSON.stringify({
  def: { count: def.count, dollars: def.dollars },
  deg: { count: deg.count, dollars: deg.dollars },
  exactDefault: exactDefault.length, exactDegraded: exactDegraded.length,
  normUnpairedDef, normUnpairedDeg, merges, multiKatexParents,
}, null, 2));
console.log("saved → perf/results/ex-phase6-c3diff-full.json");
cdp.close();
