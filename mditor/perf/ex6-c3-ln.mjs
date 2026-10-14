// C3 定向精查：源中唯一的 $\left[-\ln(1-x)\right](1+x+\cdots)$ 在默认档
// .katex 清单中出现、减配档缺失（Δ1）。取两侧所有含 ln(1 的公式全量文本
// 对照，判定是「公式丢失」还是「注记文本变化后与它文撞名」。
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const FIX = "C:/Users/hh/Desktop/Tp/mditor/perf/fixtures";
const OUT = "C:/Users/hh/Desktop/Tp/mditor/perf/results";

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
await cdp.send("Page.enable").catch(() => {});
await cdp.send("Page.bringToFront").catch(() => {});

async function setPerfSwitches(big) {
  return cdp.eval(`(async () => {
    const btns = [...document.querySelectorAll('nav.mb button, nav.mb [role=button]')];
    const help = btns.find(b => b.textContent.trim() === '帮助');
    help.click();
    await new Promise(r => setTimeout(r, 300));
    const item = [...document.querySelectorAll('div,button,a')].find(e => e.textContent.trim() === '设置…' && e.offsetParent !== null);
    item.click();
    await new Promise(r => setTimeout(r, 500));
    const navs = [...document.querySelectorAll('.settings-nav-btn')];
    navs[3].click();
    await new Promise(r => setTimeout(r, 300));
    const boxes = [...document.querySelectorAll('.settings-pane input[type=checkbox]')];
    const want = [${big ? "true" : "false"}, false];
    [boxes[0], boxes[1]].forEach((b, i) => { if (b.checked !== want[i]) b.click(); });
    await new Promise(r => setTimeout(r, 300));
    const apply = [...document.querySelectorAll('.modal button, [class*=modal] button')].find(b => b.textContent.trim() === '应用');
    apply.click();
    await new Promise(r => setTimeout(r, 400));
    return 'ok';
  })()`, { awaitPromise: true, returnByValue: true });
}

async function lnFormulas(fixture) {
  const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(join(FIX, fixture))})`, { awaitPromise: true, returnByValue: true });
  if (!opened) throw new Error("open failed");
  await sleep(5000);
  return cdp.eval(`(async () => {
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
      const all = [...h.doc.querySelectorAll('.katex')].map(k => (k.textContent || '').replace(/\\s+/g, ''));
      const ln = all.filter(t => t.includes('ln(1') || t.includes('ln⁡(1'));
      return { gate, total: all.length, lnCount: ln.length, ln };
    } finally { h.destroy(); }
  })()`, { awaitPromise: true, returnByValue: true });
}

console.log(await setPerfSwitches(false));
await sleep(4000);
const def = await lnFormulas("无穷级数_密度档压测副本.md");
console.log("default total:", def.total, "ln(1 formulas:", def.lnCount);

console.log(await setPerfSwitches(true));
await sleep(4000);
const deg = await lnFormulas("无穷级数_密度档压测副本_减配触发.md");
console.log("degraded total:", deg.total, "ln(1 formulas:", deg.lnCount);

console.log(await setPerfSwitches(false)); // 还原
await sleep(1500);

console.log("\n--- default ln(1) 公式 ---");
def.ln.forEach((t, i) => console.log(`D${i}:`, JSON.stringify(t.slice(0, 110))));
console.log("\n--- degraded ln(1) 公式 ---");
deg.ln.forEach((t, i) => console.log(`G${i}:`, JSON.stringify(t.slice(0, 110))));

writeFileSync(join(OUT, "ex-phase6-c3-ln.json"), JSON.stringify({ def, deg }, null, 2));
console.log("\nsaved → perf/results/ex-phase6-c3-ln.json");
cdp.close();
