// 最小 PNG 分析器（HX 终验）：解码非交错 RGBA/RGB PNG → 行墨剖面 / 边缘游程。
// 仅用于 perf 取证，不进应用代码。用法：
//   node perf/hx-png-profile.mjs <png> [--bottom N] [--top N] [--full]
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not png");
  let pos = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      // data[10] compression, data[11] filter, data[12] interlace
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "PLTE") palette = data;
    else if (tYPEisTrns(type)) trns = data;
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (interlace) throw new Error("interlaced png unsupported");
  if (bitDepth !== 8) throw new Error("bitDepth " + bitDepth + " unsupported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error("colorType " + colorType + " unsupported");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(w * h * channels);
  const bpp = channels; // bytes per pixel for filter
  let prev = Buffer.alloc(stride);
  let src = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[src++];
    const row = raw.subarray(src, src + stride);
    src += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: throw new Error("filter " + filter);
      }
      cur[x] = v;
    }
    prev = cur;
  }
  // 统一转 RGBA Uint8 视图（调色板/灰度展开）
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * channels, q = i * 4;
    if (colorType === 6) { rgba[q] = out[o]; rgba[q+1] = out[o+1]; rgba[q+2] = out[o+2]; rgba[q+3] = out[o+3]; }
    else if (colorType === 2) { rgba[q] = out[o]; rgba[q+1] = out[o+1]; rgba[q+2] = out[o+2]; rgba[q+3] = 255; }
    else if (colorType === 4) { rgba[q] = rgba[q+1] = rgba[q+2] = out[o]; rgba[q+3] = out[o+1]; }
    else if (colorType === 0) { rgba[q] = rgba[q+1] = rgba[q+2] = out[o]; rgba[q+3] = 255; }
    else if (colorType === 3) {
      const pi = out[o] * 3;
      rgba[q] = palette[pi]; rgba[q+1] = palette[pi+1]; rgba[q+2] = palette[pi+2];
      rgba[q+3] = trns && out[o] < trns.length ? trns[out[o]] : 255;
    }
  }
  return { w, h, rgba };
}
function tYPEisTrns(t) { return t === "tRNS"; }

const file = process.argv[2];
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? +process.argv[i + 1] : d; };
const { w, h, rgba } = decodePng(readFileSync(file));
const bg = [rgba[0], rgba[1], rgba[2]]; // 页角背景（与审计同法）
const inkOf = (x, y) => {
  const q = (y * w + x) * 4;
  return Math.abs(rgba[q] - bg[0]) + Math.abs(rgba[q + 1] - bg[1]) + Math.abs(rgba[q + 2] - bg[2]);
};
const rows = [];
for (let y = 0; y < h; y++) {
  let ink = 0, runs = 0, inRun = false, minX = -1, maxX = -1, maxInk = 0;
  for (let x = 0; x < w; x++) {
    const v = inkOf(x, y);
    const on = v > 12; // 与既有 edge 扫描一致的浅墨阈
    if (on) {
      ink += v; if (v > maxInk) maxInk = v;
      if (!inRun) { runs++; inRun = true; }
      if (minX < 0) minX = x; maxX = x;
    } else inRun = false;
  }
  rows.push({ y, ink: Math.round(ink / w), runs, minX, maxX, maxInk });
}
const mode = process.argv.includes("--full") ? "full" : process.argv.includes("--bottom") ? "bottom" : "top";
const n = arg("--bottom", 0) || arg("--top", 40);
const from = mode === "full" ? 0 : mode === "bottom" ? h - n : 0;
const to = mode === "full" ? h : mode === "bottom" ? h : n;
console.log(`# ${file} ${w}x${h} bg=${bg.join(",")} mode=${mode} rows=[${from},${to})`);
let lastState = null, run0 = -1;
for (let y = from; y < to; y++) {
  const r = rows[y];
  const state = r.ink > 0 ? `ink=${r.ink} runs=${r.runs} x=[${r.minX},${r.maxX}] max=${r.maxInk}` : "clean";
  if (state === lastState) continue;
  if (lastState !== null) console.log(`  rows ${run0}-${y - 1}: ${lastState}`);
  lastState = state; run0 = y;
}
console.log(`  rows ${run0}-${to - 1}: ${lastState}`);
