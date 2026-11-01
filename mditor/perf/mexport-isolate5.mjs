// 探针 v5：定位 direct vs ms 的差异性质——
//  A) directCss 的 @font-face 是否内联成 data: URL（字体修复是否生效）
//  B) 两画布逐行墨量互相关 → 垂直位移量化（px）
//  C) 若无整体位移，给最差公式找它真实的墨位置（±500px 搜索）
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9229;
const URL = process.env.BENCH_URL ?? "http://127.0.0.1:1420/";

const browser = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${ROOT}/perf/tmp/iso5-${Date.now()}`,
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
    const t0 = performance.now();
    const directCss = await buildDirectRasterCss(doc, doc.baseURI);
    const cssMs = Math.round(performance.now() - t0);
    // A) 字体内联验证
    const ffAll = directCss.match(/@font-face\\s*\\{[^}]*\\}/g) ?? [];
    const ffData = ffAll.filter((r) => r.includes('data:font') || r.includes('data:application'));
    const bgc = doc.defaultView.getComputedStyle(doc.documentElement).backgroundColor || '#ffffff';

    const win = doc.createElement('div');
    win.style.cssText = 'overflow:hidden;position:relative;width:' + W + 'px;';
    const parent = content.parentNode;
    parent.insertBefore(win, content);
    win.appendChild(content);
    content.style.position = 'relative';
    const fullSpan = content.scrollHeight;

    const base = content.getBoundingClientRect();
    const formulas = [];
    for (const el of content.querySelectorAll('.katex')) {
      if (el.parentElement && el.parentElement.closest('.katex')) continue;
      const r = el.getBoundingClientRect();
      formulas.push({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
    }

    const span = 1043 * 2;
    const chunkTop = Math.max(0, fullSpan - span - 200);
    win.style.height = span + 'px';
    content.style.transform = 'translateY(' + (-chunkTop) + 'px)';
    await new Promise(r => setTimeout(r, 80));

    const msCanvas = await ms.domToCanvas(await ms.createContext(win, { width: W, height: span, scale: 2, backgroundColor: bgc, autoDestruct: false }));
    const dCanvas = await rasterWindowDirect(win, directCss, W, span, 2, bgc);

    // B) 行墨量互相关（scale=2，搜索 ±600 设备像素 = ±300 CSS px）
    const rowInk = (canvas) => {
      const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
      cx.drawImage(canvas, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      const rows = new Float64Array(c.height);
      for (let y = 0; y < c.height; y++) {
        let s = 0; const off = y * c.width * 4;
        for (let x = 0; x < c.width; x++) {
          const p = off + x * 4;
          if (d[p] < 200 || d[p+1] < 200 || d[p+2] < 200) s++;
        }
        rows[y] = s;
      }
      return rows;
    };
    const A = rowInk(msCanvas), B = rowInk(dCanvas);
    let bestShift = 0, bestScore = -1;
    for (let sh = -600; sh <= 600; sh += 2) {
      let dot = 0, na = 0, nb = 0;
      for (let y = 0; y < A.length; y++) {
        const y2 = y + sh;
        if (y2 < 0 || y2 >= B.length) continue;
        dot += A[y] * B[y2]; na += A[y] * A[y]; nb += B[y2] * B[y2];
      }
      const score = dot / Math.sqrt(na * nb + 1e-9);
      if (score > bestScore) { bestScore = score; bestShift = sh; }
    }

    // C) 最差公式位移定位：isolate3 已知 y≈19500 附近 r=0——在 direct 里
    //    ±500px 垂直搜索它的墨块
    const f0 = formulas.filter(f => f.y >= chunkTop && f.y + f.h <= chunkTop + span)
      .sort((a, b) => b.w * b.h - a.w * a.h)[Math.floor(0)]; // 取最大的一个公式
    const locate = (canvas, f) => {
      const sx = Math.max(0, Math.round(f.x * 2)), sw = Math.min(Math.round(f.w * 2), canvas.width - sx);
      const sy0 = Math.round((f.y - chunkTop) * 2), sh0 = Math.round(f.h * 2);
      let best = { dy: 0, ink: -1 };
      for (let dy = -1000; dy <= 1000; dy += 4) {
        const sy = sy0 + dy;
        if (sy < 0 || sy + sh0 > canvas.height) continue;
        const c = document.createElement('canvas'); c.width = sw; c.height = sh0;
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, sw, sh0);
        cx.drawImage(canvas, sx, sy, sw, sh0, 0, 0, sw, sh0);
        const d = cx.getImageData(0, 0, sw, sh0).data;
        let ink = 0;
        for (let p = 0; p < d.length; p += 4) if (d[p] < 200 || d[p+1] < 200 || d[p+2] < 200) ink++;
        if (ink > best.ink) best = { dy, ink };
      }
      return { dyCss: Math.round(best.dy / 2), ink: best.ink };
    };
    const locMs = locate(msCanvas, f0), locD = locate(dCanvas, f0);

    return {
      cssMs, fontFaces: ffAll.length, fontFacesDataUri: ffData.length,
      chunkTop: Math.round(chunkTop),
      rowCorrShiftPx: Math.round(bestShift / 2), rowCorrScore: Math.round(bestScore * 1000) / 1000,
      biggestFormula: { y: Math.round(f0.y), w: Math.round(f0.w), h: Math.round(f0.h) },
      locateMs: locMs, locateDirect: locD,
    };
  } finally {
    handle.destroy();
  }
})()`);

console.log(JSON.stringify(out, null, 1));
await cdp.send("Browser.close").catch(() => {});
browser.kill();
