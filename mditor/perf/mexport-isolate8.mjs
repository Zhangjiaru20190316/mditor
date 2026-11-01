// 探针 v8：三方对比——工厂 iframe 屏上截图（真值）vs ms vs direct。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9229;
const URL = process.env.BENCH_URL ?? "http://127.0.0.1:1420/";
const OUT = ROOT + "/perf/results/mexport/isodump8";
fs.mkdirSync(OUT, { recursive: true });

const browser = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${ROOT}/perf/tmp/iso8-${Date.now()}`,
  "--no-first-run", "--hide-scrollbars", "--window-size=1400,2200", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let version = null;
for (let i = 0; i < 60; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
  catch { await sleep(500); }
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id != null) {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      }
    });
    this.ready = new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  }
  static async connect(url) { const c = new Cdp(new WebSocket(url)); await c.ready; return c; }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }
}

const bcdp = await Cdp.connect(version.webSocketDebuggerUrl);
const { targetId } = await bcdp.send("Target.createTarget", { url: "about:blank" });
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const cdp = await Cdp.connect(list.find((t) => t.id === targetId).webSocketDebuggerUrl);
await cdp.send("Page.enable");
await cdp.send("Page.navigate", { url: URL });
await sleep(2500);

const out = await cdp.eval(`(async () => {
  await import('/src/dev/exportBench.ts?t=${Date.now()}');
  const B0 = window.__mexport;
  const { renderBlockMath } = await import('/src/lib/exportMath.ts');
  const { renderInFactory } = await import('/src/lib/exportRenderFactory.ts');
  const ms = await import('/node_modules/modern-screenshot/dist/index.mjs');
  const { buildDirectRasterCss, rasterWindowDirect } = await import('/src/lib/exportPdfPipeline.ts');

  const fixture = B0.buildFixture({ blocks: 320 });
  const html = renderBlockMath(fixture.html).html;
  const css = B0.katexCssForFactory();
  const W = 753;
  const handle = await renderInFactory(html, { contentWidthPx: W, css });
  try {
    const doc = handle.doc;
    const content = handle.content;
    const directCss = await buildDirectRasterCss(doc, doc.baseURI);
    const bgc = doc.defaultView.getComputedStyle(doc.documentElement).backgroundColor || '#ffffff';

    const win = doc.createElement('div');
    win.style.cssText = 'overflow:hidden;position:relative;width:' + W + 'px;';
    const parent = content.parentNode;
    parent.insertBefore(win, content);
    win.appendChild(content);
    content.style.position = 'relative';
    const fullSpan = content.scrollHeight;

    const span = 1043 * 2;
    const chunkTop = Math.max(0, fullSpan - span - 200);
    win.style.height = span + 'px';
    content.style.transform = 'translateY(' + (-chunkTop) + 'px)';
    await new Promise(r => setTimeout(r, 80));

    const msCanvas = await ms.domToCanvas(await ms.createContext(win, { width: W, height: span, scale: 2, backgroundColor: bgc, autoDestruct: false }));
    // 管线同款配置的 ms（includeStyleProperties 白名单 + features）
    const MSP = (await import('/src/lib/exportPdfPipeline.ts')).MS_STYLE_PROPS;
    const msPipeCtx = await ms.createContext(win, {
      width: W, height: span, scale: 2, backgroundColor: bgc, autoDestruct: false,
      includeStyleProperties: MSP,
      features: { copyScrollbar: false, removeAbnormalAttributes: false, restoreScrollPosition: false },
    });
    const msPipeCanvas = await ms.domToCanvas(msPipeCtx);
    const dCanvas = await rasterWindowDirect(win, directCss, W, span, 2, bgc);

    // 工厂真值：把 iframe 挪到屏上，页面截图 clip
    handle.iframe.style.cssText = 'position:fixed;left:0;top:0;border:0;pointer-events:none;' +
      'width:' + W + 'px;height:' + span + 'px;background:#fff;z-index:2147483647;';
    await new Promise(r => setTimeout(r, 150));
    window.__iso8 = { pngMs: msCanvas.toDataURL('image/png').split(',', 2)[1],
                      pngMsPipe: msPipeCanvas.toDataURL('image/png').split(',', 2)[1],
                      pngDirect: dCanvas.toDataURL('image/png').split(',', 2)[1] };
    return { chunkTop, span };
  } catch (e) {
    return { error: String(e) };
  }
})()`);

if (out.error) { console.error(out.error); process.exit(1); }
// 工厂截图（clip 在视口 0,0 起）
const shot = await cdp.send("Page.captureScreenshot", {
  format: "png",
  clip: { x: 0, y: 0, width: 753, height: 2086, scale: 2 },
  captureBeyondViewport: true,
});
fs.writeFileSync(OUT + "/factory-viewport.png", Buffer.from(shot.data, "base64"));
const pngs = await cdp.eval("window.__iso8");
fs.writeFileSync(OUT + "/ms-ref.png", Buffer.from(pngs.pngMs, "base64"));
fs.writeFileSync(OUT + "/ms-pipe.png", Buffer.from(pngs.pngMsPipe, "base64"));
fs.writeFileSync(OUT + "/direct.png", Buffer.from(pngs.pngDirect, "base64"));
console.log(JSON.stringify(out, null, 1));
await cdp.send("Browser.close").catch(() => {});
browser.kill();
