// 探针 v7：dump direct 的 SVG XML + 两画布 PNG + 首墨行位置。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9229;
const URL = process.env.BENCH_URL ?? "http://127.0.0.1:1420/";
const OUT = ROOT + "/perf/results/mexport/isodump7";
fs.mkdirSync(OUT, { recursive: true });

const browser = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${ROOT}/perf/tmp/iso7-${Date.now()}`,
  "--no-first-run", "--hide-scrollbars", "--window-size=1400,2000", "about:blank",
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
  async evalBuf(expression) {
    // 大返回值走 IO.streamReadable 协议容易截断；这里直接分块 base64
    return this.eval(expression);
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
    const dCanvas = await rasterWindowDirect(win, directCss, W, span, 2, bgc);

    // 复刻 rasterWindowDirect 的 SVG 构造以取 XML（不内联 data 字体的头 4000 字符版本）
    const SVG_NS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", String(W)); svg.setAttribute("height", String(span));
    const styleEl = doc.createElement("style");
    styleEl.textContent = directCss.replace(/data:[^)"']{100,}/g, 'data:__STRIPPED__');
    svg.appendChild(styleEl);
    const fo = doc.createElementNS(SVG_NS, "foreignObject");
    fo.setAttribute("x","0"); fo.setAttribute("y","0");
    fo.setAttribute("width", String(W)); fo.setAttribute("height", String(span));
    const wrap = doc.createElement("div");
    wrap.setAttribute("class", "vditor-reset msvg-shim");
    wrap.setAttribute("style", win.style.cssText + ';background:#ffffff;');
    wrap.appendChild(win.cloneNode(true));
    fo.appendChild(wrap); svg.appendChild(fo);
    const xml = new XMLSerializer().serializeToString(svg);

    const firstInkRow = (canvas) => {
      const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.fillStyle = '#fff'; cx.fillRect(0,0,c.width,c.height); cx.drawImage(canvas, 0, 0);
      const d = cx.getImageData(0, 0, c.width, 64).data;
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < c.width; x++) {
          const p = (y * c.width + x) * 4;
          if (d[p] < 200 || d[p+1] < 200 || d[p+2] < 200) return y;
        }
      }
      return -1;
    };
    return {
      chunkTop, span,
      firstInkMs: firstInkRow(msCanvas), firstInkDirect: firstInkRow(dCanvas),
      pngMs: msCanvas.toDataURL('image/png').split(',', 2)[1],
      pngDirect: dCanvas.toDataURL('image/png').split(',', 2)[1],
      xmlHead: xml.slice(0, 120000),
    };
  } finally {
    handle.destroy();
  }
})()`);

fs.writeFileSync(OUT + "/ms-ref.png", Buffer.from(out.pngMs, "base64"));
fs.writeFileSync(OUT + "/direct.png", Buffer.from(out.pngDirect, "base64"));
fs.writeFileSync(OUT + "/direct.svg.xml", out.xmlHead);
console.log(JSON.stringify({ chunkTop: out.chunkTop, span: out.span, firstInkMs: out.firstInkMs, firstInkDirect: out.firstInkDirect, xmlLen: out.xmlHead.length }, null, 1));
await cdp.send("Browser.close").catch(() => {});
browser.kill();
