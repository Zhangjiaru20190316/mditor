// C3 Δ1 定位：$\left[-\ln(1-x)\right](1+x+\cdots)$ 在减配档 .katex 清单消失
// 但 $ 计数未涨——观测「系数核对」段落在 管线各阶段 的 HTML 形态。
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
    btns.find(b => b.textContent.trim() === '帮助').click();
    await new Promise(r => setTimeout(r, 300));
    [...document.querySelectorAll('div,button,a')].find(e => e.textContent.trim() === '设置…' && e.offsetParent !== null).click();
    await new Promise(r => setTimeout(r, 500));
    [...document.querySelectorAll('.settings-nav-btn')][3].click();
    await new Promise(r => setTimeout(r, 300));
    const boxes = [...document.querySelectorAll('.settings-pane input[type=checkbox]')];
    const want = [${big ? "true" : "false"}, false];
    [boxes[0], boxes[1]].forEach((b, i) => { if (b.checked !== want[i]) b.click(); });
    await new Promise(r => setTimeout(r, 300));
    [...document.querySelectorAll('.modal button, [class*=modal] button')].find(b => b.textContent.trim() === '应用').click();
    await new Promise(r => setTimeout(r, 400));
    return 'ok';
  })()`, { awaitPromise: true, returnByValue: true });
}

console.log(await setPerfSwitches(true));
await sleep(4000);
const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(join(FIX, "无穷级数_密度档压测副本_减配触发.md"))})`, { awaitPromise: true, returnByValue: true });
if (!opened) throw new Error("open failed");
await sleep(5000);

const dump = await cdp.eval(`(async () => {
  const dbg = window.__exportDebug;
  const gate = dbg.isBigDoc();
  const raw = dbg.getHTML();
  const { renderDegradedMath, renderBlockMath } = await import('/src/lib/exportMath.ts');
  const afterDegraded = gate ? renderDegradedMath(raw).html : raw;
  const afterBlock = renderBlockMath(afterDegraded).html;

  const grab = (html, label) => {
    const i = html.indexOf('系数核对');
    return { label, found: i >= 0, excerpt: i >= 0 ? html.slice(Math.max(0, i - 120), i + 520) : null };
  };
  return {
    gate,
    raw: grab(raw, 'raw'),
    afterDegraded: grab(afterDegraded, 'afterDegraded'),
    afterBlock: grab(afterBlock, 'afterBlock'),
    dollars: { raw: (raw.match(/\\$/g) || []).length, afterDegraded: (afterDegraded.match(/\\$/g) || []).length, afterBlock: (afterBlock.match(/\\$/g) || []).length },
  };
})()`, { awaitPromise: true, returnByValue: true });

console.log(await setPerfSwitches(false)); // 还原默认
console.log(JSON.stringify(dump, null, 2));
writeFileSync(join(OUT, "ex-phase6-c3-delta1.json"), JSON.stringify(dump, null, 2));
console.log("saved → perf/results/ex-phase6-c3-delta1.json");
cdp.close();
