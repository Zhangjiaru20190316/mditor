// 抓现行（第二轮）：三击选段窗口内谁在读 getBoundingClientRect / getClientRects /
// offsetWidth（元素+调用栈Top）。用法：node perf/rect-spy2.mjs
import { findPageTarget, Cdp, mouse, sleep } from "./cdp.mjs";

const t = await findPageTarget(9223);
const cdp = await Cdp.connect(target_ws(t));
function target_ws(t) { return t.webSocketDebuggerUrl; }
const m = mouse(cdp);

const instrument = `(() => {
  window.__rectLog = [];
  const log = (tag, self) => {
    if (!window.__rectLog) return;
    const stack = (new Error().stack || '').split('\\n').slice(1, 5).map(s => s.trim().slice(0, 90)).join(' <- ');
    window.__rectLog.push({ fn: tag, el: String(self && (self.className || self.tagName) || '').slice(0, 40), stack });
  };
  const wrapMethod = (obj, prop, tag) => {
    const orig = obj[prop];
    if (typeof orig !== 'function') return;
    window['__orig_' + tag] = orig;
    obj[prop] = function () {
      const v = orig.apply(this, arguments);
      log(tag, this);
      return v;
    };
  };
  const wrapGetter = (obj, prop, tag) => {
    const d = Object.getOwnPropertyDescriptor(obj, prop);
    if (!d || !d.get) return;
    window['__orig_' + tag] = d.get;
    Object.defineProperty(obj, prop, {
      configurable: true,
      get: function () {
        const v = window['__orig_' + tag].call(this);
        log(tag, this);
        return v;
      },
    });
  };
  wrapMethod(Element.prototype, 'getBoundingClientRect', 'gBCR');
  wrapMethod(Range.prototype, 'getBoundingClientRect', 'rGBCR');
  wrapMethod(Range.prototype, 'getClientRects', 'gCRS');
  wrapGetter(HTMLElement.prototype, 'offsetWidth', 'offsetWidth');
  return 'instrumented';
})()`;

await cdp.eval(instrument);

const p = await cdp.eval(`(() => {
  const pm = document.querySelector('.ProseMirror');
  const host = document.querySelector('.mditor-editor-host');
  const kids = [...pm.children];
  const k = kids.slice(300).find(el => el.tagName === 'P' && (el.textContent ?? '').trim().length >= 60);
  if (!k) return null;
  host.scrollTop = Math.max(0, k.offsetTop - 150);
  return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
    const rc = k.getBoundingClientRect();
    res({ x: Math.round(rc.x + Math.min(rc.width / 2, 200)), y: Math.round(rc.y + rc.height / 2) });
  })));
})()`);
console.log("triple-clicking at", p);
await sleep(1200);
await cdp.eval("window.__rectLog = []");
await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 3 });
await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 3 });
await sleep(1200);

const selState = await cdp.eval(`(() => { const s = getSelection(); return { collapsed: s.isCollapsed, len: s.toString().length }; })()`);
console.log("selection after triple-click:", JSON.stringify(selState));

const log = await cdp.eval("window.__rectLog");
const agg = new Map();
for (const e of log ?? []) {
  const top = (e.stack || "").split(" <- ").slice(0, 3).join(" <- ");
  const key = `${e.fn} ${e.el} :: ${top}`;
  agg.set(key, (agg.get(key) ?? 0) + 1);
}
console.log("total rect-ish reads:", (log ?? []).length);
for (const [k, n] of [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16)) {
  console.log(String(n).padStart(5), k);
}
await cdp.eval(`(() => {
  if (window.__orig_gBCR) Element.prototype.getBoundingClientRect = window.__orig_gBCR;
  if (window.__orig_rGBCR) Range.prototype.getBoundingClientRect = window.__orig_rGBCR;
  if (window.__orig_gCRS) Range.prototype.getClientRects = window.__orig_gCRS;
  if (window.__orig_offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: window.__orig_offsetWidth });
  return 'restored';
})()`);
cdp.close();
