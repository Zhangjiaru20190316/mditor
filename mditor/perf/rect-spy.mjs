// 抓现行：2.5s 窗口内谁在读 getBoundingClientRect / getClientRects（元素+调用栈Top）
import { findPageTarget, Cdp, mouse, sleep } from "./cdp.mjs";

const t = await findPageTarget(9223);
const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
const m = mouse(cdp);

const instrument = `(() => {
  window.__rectLog = [];
  window.__origGBCR = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    const r = window.__origGBCR.call(this);
    if (window.__rectLog) {
      const stack = (new Error().stack || '').split('\\n').slice(1, 5).map(s => s.trim().slice(0, 90)).join(' <- ');
      window.__rectLog.push({ fn: 'gBCR', el: String(this.className || this.tagName || '').slice(0, 40), stack });
    }
    return r;
  };
  window.__origGCRS = Range.prototype.getClientRects;
  Range.prototype.getClientRects = function () {
    const r = window.__origGCRS.call(this);
    if (window.__rectLog) {
      const stack = (new Error().stack || '').split('\\n').slice(1, 5).map(s => s.trim().slice(0, 90)).join(' <- ');
      window.__rectLog.push({ fn: 'gCRS', el: 'Range', stack });
    }
    return r;
  };
  return 'instrumented';
})()`;

await cdp.eval(instrument);

const r = await cdp.eval(`(() => {
  const pm = document.querySelector('.ProseMirror');
  const host = document.querySelector('.mditor-editor-host');
  const k = pm.children[900];
  host.scrollTop = Math.max(0, k.offsetTop - 150);
  return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
    const rc = k.getBoundingClientRect();
    res({ x: Math.round(rc.x + Math.min(rc.width / 2, 300)), y: Math.round(rc.y + Math.min(rc.height / 2, 120)) });
  })));
})()`);
console.log("clicking at", r);
await m.click(r.x, r.y);
await sleep(2500);

const log = await cdp.eval("window.__rectLog");
const agg = new Map();
for (const e of log ?? []) {
  const top = (e.stack || "").split(" <- ").slice(0, 3).join(" <- ");
  const key = `${e.fn} ${e.el} :: ${top}`;
  agg.set(key, (agg.get(key) ?? 0) + 1);
}
console.log("total rect reads in 2.5s:", (log ?? []).length);
for (const [k, n] of [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  console.log(String(n).padStart(5), k);
}
// 还原原型，避免影响后续测量
await cdp.eval(`(() => {
  if (window.__origGBCR) Element.prototype.getBoundingClientRect = window.__origGBCR;
  if (window.__origGCRS) Range.prototype.getClientRects = window.__origGCRS;
  return 'restored';
})()`);
cdp.close();
