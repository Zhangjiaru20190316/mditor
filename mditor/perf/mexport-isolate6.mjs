// 探针 v6：逐公式 x 带内行墨互相关 → direct 相对 ms 的每公式真实垂直偏移
// dy 序列（+ = direct 更靠下）。看 dy 随 y 的形态：线性累积 vs 跳变。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9229;
const URL = process.env.BENCH_URL ?? "http://127.0.0.1:1420/";

const browser = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${ROOT}/perf/tmp/iso6-${Date.now()}`,
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
    const directCss = await buildDirectRasterCss(doc, doc.baseURI);
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

    // 窗口覆盖文档中段偏后（跨过交接发现的 ~30px 跳变区）
    const span = 1043 * 3;
    const chunkTop = Math.max(0, fullSpan - span - 200);
    win.style.height = span + 'px';
    content.style.transform = 'translateY(' + (-chunkTop) + 'px)';
    await new Promise(r => setTimeout(r, 80));

    const msCanvas = await ms.domToCanvas(await ms.createContext(win, { width: W, height: span, scale: 2, backgroundColor: bgc, autoDestruct: false }));
    const dCanvas = await rasterWindowDirect(win, directCss, W, span, 2, bgc);

    // 每公式 x 带行墨 → 互相关求 dy（scale=2，±300 CSS px）
    const bandRows = (canvas, f) => {
      const sx = Math.max(0, Math.round(f.x * 2)), sw = Math.min(Math.round(f.w * 2), canvas.width - sx);
      const c = document.createElement('canvas'); c.width = sw; c.height = canvas.height;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, sw, c.height);
      cx.drawImage(canvas, sx, 0, sw, c.height, 0, 0, sw, c.height);
      const d = cx.getImageData(0, 0, sw, c.height).data;
      const rows = new Float64Array(c.height);
      for (let y = 0; y < c.height; y++) {
        let s = 0; const off = y * sw * 4;
        for (let x = 0; x < sw; x++) {
          const p = off + x * 4;
          if (d[p] < 200 || d[p+1] < 200 || d[p+2] < 200) s++;
        }
        rows[y] = s;
      }
      return rows;
    };
    const bestDy = (rowsA, rowsB) => {
      let best = { dy: null, score: -1 };
      for (let dy = -600; dy <= 600; dy += 2) {
        let dot = 0, na = 0, nb = 0;
        for (let y = 0; y < rowsA.length; y++) {
          const y2 = y + dy;
          if (y2 < 0 || y2 >= rowsB.length) continue;
          dot += rowsA[y] * rowsB[y2]; na += rowsA[y] * rowsA[y]; nb += rowsB[y2] * rowsB[y2];
        }
        const s = dot / Math.sqrt(na * nb + 1e-9);
        if (s > best.score) best = { dy, score: s };
      }
      return best;
    };
    const per = [];
    for (const f of formulas) {
      if (f.y < chunkTop - 150 || f.y + f.h > chunkTop + span - 150) continue;
      const A = bandRows(msCanvas, f), B = bandRows(dCanvas, f);
      // 每画布自相关零位移参考（同一画布 vs 自己平移 0 → 1.0）先验证带内墨足够
      const mA = A.reduce((s, v) => s + v, 0), mB = B.reduce((s, v) => s + v, 0);
      if (mA < 400 || mB < 400) { per.push({ y: Math.round(f.y), skip: true, mA, mB }); continue; }
      const b = bestDy(A, B);
      per.push({ y: Math.round(f.y), dy: Math.round(b.dy / 2), score: Math.round(b.score * 100) / 100, mA, mB });
    }
    per.sort((a, b2) => a.y - b2.y);
    return { chunkTop: Math.round(chunkTop), span, n: per.length, per: per.filter(p => !p.skip), skipped: per.filter(p => p.skip).length };
  } finally {
    handle.destroy();
  }
})()`);

console.log(JSON.stringify(out, null, 1));
await cdp.send("Browser.close").catch(() => {});
browser.kill();
