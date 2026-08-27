// spy 自检：安装后手动读一次各 API，确认拦截生效
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";
const t = await findPageTarget(9223);
const cdp = await Cdp.connect(t.webSocketDebuggerUrl);

const instrument = `(() => {
  window.__rectLog = [];
  const wrap = (obj, prop, tag) => {
    const d = Object.getOwnPropertyDescriptor(obj, prop);
    if (!d || !d.get) { window.__rectLog.push({ fn: 'NO-DESCRIPTOR ' + tag, el: '', stack: '' }); return; }
    window['__orig_' + tag] = d.get;
    Object.defineProperty(obj, prop, {
      configurable: true,
      get: function () {
        const v = window['__orig_' + tag].call(this);
        if (window.__rectLog) {
          const stack = (new Error().stack || '').split('\\n').slice(1, 4).map(s => s.trim().slice(0, 80)).join(' <- ');
          window.__rectLog.push({ fn: tag, el: String(this.className || this.tagName || '').slice(0, 40), stack });
        }
        return v;
      },
    });
  };
  wrap(Element.prototype, 'getBoundingClientRect', 'gBCR');
  wrap(Element.prototype, 'offsetWidth', 'offsetWidth');
  wrap(Range.prototype, 'getBoundingClientRect', 'rGBCR');
  return { gBCR: typeof window.__orig_gBCR, ow: typeof window.__orig_offsetWidth, rGBCR: typeof window.__orig_rGBCR };
})()`;
console.log(await cdp.eval(instrument));

await cdp.eval(`(() => {
  const pm = document.querySelector('.ProseMirror');
  pm.getBoundingClientRect();
  void pm.offsetWidth;
  const r = document.createRange();
  r.selectNodeContents(pm);
  r.getBoundingClientRect();
})()`);
await sleep(300);
console.log(await cdp.eval("window.__rectLog"));
cdp.close();
