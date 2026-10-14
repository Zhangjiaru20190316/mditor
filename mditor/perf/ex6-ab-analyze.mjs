// A/B 位图深分析：对已落盘的 ex6-ab-{variant}-page{i}.png 做
// ①首/末墨行（全局偏移）②分窗最优滞后（窗 240 设备px/步 120/±80px）——
// 区分全局平移（各窗 lag 一致）vs 累积行高差（lag 随 y 增长）vs reflow
// （各窗 lag 混乱/ corr 低）③列墨量剖面相关（横向是否一致）。
// trim1 vs trim2 为对照（应全 0/1）。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp } from "./cdp.mjs";

const OUT = "C:/Users/hh/Desktop/Tp/mditor/perf/results";
const DOC_DIR = "C:/Users/hh/Documents";

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
await cdp.send("Page.enable").catch(() => {});
await cdp.send("Page.bringToFront").catch(() => {});

const r = await cdp.eval(`(async () => {
  const { getAdapter } = await import('/src/platform/index.ts');
  const adapter = await getAdapter();
  await adapter.app.grantFsScope([${JSON.stringify(DOC_DIR)}, ${JSON.stringify(OUT)}], true);

  const readDataUrl = async (p) => {
    const b = await adapter.fs.readFile(p);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < b.length; i += CH)
      bin += String.fromCharCode.apply(null, b.subarray(i, i + CH));
    return 'data:image/png;base64,' + btoa(bin);
  };
  const load = async (p) => {
    const img = new Image();
    img.src = await readDataUrl(p);
    await img.decode();
    return img;
  };
  const profile = (img) => {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const bgR = d[0], bgG = d[1], bgB = d[2];
    const rows = new Float64Array(c.height);
    const cols = new Float64Array(c.width);
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const p = (y * c.width + x) * 4;
        const v = Math.abs(d[p] - bgR) + Math.abs(d[p + 1] - bgG) + Math.abs(d[p + 2] - bgB);
        rows[y] += v; cols[x] += v;
      }
    }
    return { rows, cols, w: c.width, h: c.height };
  };
  const pearson = (a, b, y0, y1, lag) => {
    const s0 = Math.max(0, y0 - Math.max(0, lag)); // a 段
    // 直接以重叠段计算
    let sa = 0, sb = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      const yb = y + lag;
      if (yb < 0 || yb >= b.length) continue;
      sa += a[y]; sb += b[yb]; n++;
    }
    if (n < 32) return null;
    const ma = sa / n, mb = sb / n;
    let num = 0, da = 0, db = 0;
    for (let y = y0; y < y1; y++) {
      const yb = y + lag;
      if (yb < 0 || yb >= b.length) continue;
      const va = a[y] - ma, vb = b[yb] - mb;
      num += va * vb; da += va * va; db += vb * vb;
    }
    const den = Math.sqrt(da * db);
    return den > 0 ? num / den : null;
  };
  const bestLag = (a, b, y0, y1, maxLag) => {
    let best = { lag: 0, r: -2 };
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      const r = pearson(a, b, y0, y1, lag);
      if (r != null && r > best.r) best = { lag, r };
    }
    return best.r === -2 ? { lag: 0, r: 0 } : best;
  };
  const inkBounds = (rows) => {
    const max = Math.max(...rows);
    const th = max * 0.02;
    let first = -1, last = -1;
    for (let y = 0; y < rows.length; y++) {
      if (rows[y] > th) { if (first < 0) first = y; last = y; }
    }
    return { first, last };
  };
  const colCorr = (ca, cb) => {
    // 横向剖面零位移相关（reflow 会连横向墨量分布一起变）
    let ma = 0, mb = 0;
    for (let i = 0; i < ca.length; i++) { ma += ca[i]; mb += cb[i]; }
    ma /= ca.length; mb /= cb.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < ca.length; i++) {
      const va = ca[i] - ma, vb = cb[i] - mb;
      num += va * vb; da += va * va; db += vb * vb;
    }
    return num / Math.sqrt(da * db);
  };

  const results = [];
  for (let page = 0; page < 3; page++) {
    for (const [name, va, vb] of [
      ["stream-vs-trim1", "stream", "trim1"],
      ["trim1-vs-trim2", "trim1", "trim2"],
    ]) {
      const A = await load(${JSON.stringify(DOC_DIR)} + '/ex6-ab-' + va + '-page' + page + '.png');
      const B = await load(${JSON.stringify(DOC_DIR)} + '/ex6-ab-' + vb + '-page' + page + '.png');
      const pa = profile(A), pb = profile(B);
      const ba = inkBounds(pa.rows), bb = inkBounds(pb.rows);
      const windows = [];
      const WIN = 240, STEP = 120;
      for (let y0 = 80; y0 + WIN < pa.h - 80; y0 += STEP) {
        const r = bestLag(pa.rows, pb.rows, y0, y0 + WIN, 80);
        if (r.r > 0) windows.push({ y: y0, ...r });
      }
      results.push({
        page, pair: name,
        inkFirst: { a: ba.first, b: bb.first }, inkLast: { a: ba.last, b: bb.last },
        colCorr: colCorr(pa.cols, pb.cols),
        windows,
        nWinHighCorr: windows.filter(w => w.r > 0.9).length,
      });
    }
  }
  return results;
})()`, { awaitPromise: true, returnByValue: true });

console.log(JSON.stringify(r, null, 1));
writeFileSync(join(OUT, "ex-phase6-raster-ab-windows.json"), JSON.stringify(r, null, 2));
console.log("saved → perf/results/ex-phase6-raster-ab-windows.json");
cdp.close();
