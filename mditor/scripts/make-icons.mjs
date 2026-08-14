// Generates the app icons for Tauri without any npm dependency.
// Produces:
//   src-tauri/icons/32x32.png
//   src-tauri/icons/128x128.png
//   src-tauri/icons/128x128@2x.png   (256x256)
//   src-tauri/icons/icon.png         (512x512)
//   src-tauri/icons/icon.ico         (multi-size ICO)
//   src-tauri/icons/icon.icns        (left as the PNG placeholder; real .icns
//                                     needs macOS tooling — Tauri tolerates a
//                                     missing .icns on non-mac builds)
//
// Design: an indigo→violet diagonal-gradient rounded square with a soft top
// gloss, a gentle bottom shade, and a refined anti-aliased white "M" glyph.
// Rendered at 4× resolution and box-filtered down for smooth, premium edges
// — still zero npm dependencies.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, "..", "src-tauri", "icons");
mkdirSync(iconsDir, { recursive: true });

// --- minimal PNG encoder (RGBA) -------------------------------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // add filter byte (0) per scanline
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- color helpers --------------------------------------------------------
function hexToRgb(h) {
  h = h.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}
const lerp = (a, b, t) => a + (b - a) * t;
const lerpRgb = (c1, c2, t) => [
  lerp(c1[0], c2[0], t),
  lerp(c1[1], c2[1], t),
  lerp(c1[2], c2[2], t),
];
const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// --- draw the icon --------------------------------------------------------
// Design: an indigo→violet diagonal-gradient rounded square with a soft top
// gloss, a gentle bottom shade, and a refined anti-aliased white "M" glyph.
// Quality comes from 4× supersampling: render at 4× then box-filter down,
// which yields smooth corners and glyph edges with zero npm dependencies.
const SS = 4; // supersample factor

const BG_TOP = hexToRgb("#4f46e5"); // indigo-600
const BG_BOT = hexToRgb("#7c3aed"); // violet-600
const FG = [255, 255, 255];

// Build a boolean coverage mask for the "M" glyph at hi-res (ss×ss).
function buildGlyph(ss) {
  const g = new Uint8Array(ss * ss);
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= ss || y >= ss) return;
    g[y * ss + x] = 1;
  };
  const margin = ss * 0.235; // distance from each side to the outer vertical edge
  const left = margin; // left vertical, left edge
  const right = ss - margin; // right vertical, right edge
  const top = ss * 0.27;
  const bot = ss * 0.73;
  const sw = ss * 0.082; // stroke width
  const mid = ss / 2;
  const notchY = ss * 0.52; // where the inner V meets (slightly below center)
  const Ti = Math.round(top);
  const Bi = Math.round(bot);
  const swi = Math.round(sw);
  const NYi = Math.round(notchY);
  // two vertical strokes
  for (let y = Ti; y <= Bi; y++) {
    for (let w = 0; w < swi; w++) {
      set(Math.round(left) + w, y);
      set(Math.round(right) - swi + w, y);
    }
  }
  // inner V: diagonals from the top of each vertical down to the center,
  // drawn with a consistent (roughly perpendicular) stroke width
  const cL0 = left + sw / 2; // center of the left vertical
  const cR0 = right - sw / 2; // center of the right vertical
  const steps = NYi - Ti;
  for (let s = 0; s <= steps; s++) {
    const t = steps > 0 ? s / steps : 0;
    const cL = lerp(cL0, mid, t);
    const cR = lerp(cR0, mid, t);
    for (let w = 0; w < swi; w++) {
      const off = w - (swi - 1) / 2;
      set(Math.round(cL + off), Ti + s);
      set(Math.round(cR + off), Ti + s);
    }
  }
  return g;
}

// Render the full icon at hi-res (ss×ss) RGBA, with gradient, gloss, shade
// and the glyph already composited. Pixels outside the rounded square are
// left transparent.
function drawHi(ss) {
  const buf = Buffer.alloc(ss * ss * 4);
  const radius = ss * 0.205;
  const glyph = buildGlyph(ss);
  const insideRect = (x, y) => {
    const cx = Math.min(x, ss - 1 - x);
    const cy = Math.min(y, ss - 1 - y);
    if (cx >= radius || cy >= radius) return true;
    const dx = radius - cx;
    const dy = radius - cy;
    return dx * dx + dy * dy <= radius * radius;
  };
  for (let y = 0; y < ss; y++) {
    for (let x = 0; x < ss; x++) {
      const i = (y * ss + x) * 4;
      if (!insideRect(x, y)) {
        buf[i + 3] = 0; // transparent outside the rounded square
        continue;
      }
      const u = x / (ss - 1);
      const v = y / (ss - 1);
      // diagonal linear gradient (top-left → bottom-right)
      let col = lerpRgb(BG_TOP, BG_BOT, (u + v) / 2);
      // soft top gloss — suggests light from above
      if (v < 0.45) {
        const gl = Math.pow(1 - v / 0.45, 1.7) * 0.24;
        col = [
          col[0] + (255 - col[0]) * gl,
          col[1] + (255 - col[1]) * gl,
          col[2] + (255 - col[2]) * gl,
        ];
      }
      // gentle bottom shade for depth
      if (v > 0.72) {
        const sh = ((v - 0.72) / 0.28) * 0.16;
        col = [col[0] * (1 - sh), col[1] * (1 - sh), col[2] * (1 - sh)];
      }
      // thin lit rim along the top inner edge
      if (y < ss * 0.012) {
        const rim = 0.22;
        col = [
          col[0] + (255 - col[0]) * rim,
          col[1] + (255 - col[1]) * rim,
          col[2] + (255 - col[2]) * rim,
        ];
      }
      // refined white "M" glyph on top
      if (glyph[y * ss + x]) col = FG.slice();
      buf[i] = clampByte(col[0]);
      buf[i + 1] = clampByte(col[1]);
      buf[i + 2] = clampByte(col[2]);
      buf[i + 3] = 255;
    }
  }
  return buf;
}

// Box-filter downsample from ss×ss (hi-res) to size×size (final, anti-aliased).
function downsample(hi, ss, size) {
  const out = Buffer.alloc(size * size * 4);
  const n = SS * SS;
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const sx = ox * SS + dx;
          const sy = oy * SS + dy;
          const i = (sy * ss + sx) * 4;
          r += hi[i];
          g += hi[i + 1];
          b += hi[i + 2];
          a += hi[i + 3];
        }
      }
      const oi = (oy * size + ox) * 4;
      out[oi] = Math.round(r / n);
      out[oi + 1] = Math.round(g / n);
      out[oi + 2] = Math.round(b / n);
      out[oi + 3] = Math.round(a / n);
    }
  }
  return out;
}

function draw(size) {
  const ss = size * SS;
  return downsample(drawHi(ss), ss, size);
}

function writePng(name, size) {
  const png = encodePng(size, size, draw(size));
  writeFileSync(join(iconsDir, name), png);
  console.log(`[icons] wrote ${name} (${size}x${size})`);
}

// PNGs
writePng("32x32.png", 32);
writePng("128x128.png", 128);
writePng("128x128@2x.png", 256);
writePng("icon.png", 512);

// --- ICO (multi-size) -----------------------------------------------------
// ICONDIR + ICONDIRENTRY[] + image data (each a PNG for >255 colors).
function buildIco(sizes) {
  const entries = sizes.map((s) => ({ s, png: encodePng(s, s, draw(s)) }));
  const headerSize = 6 + entries.length * 16;
  let offset = headerSize;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type = icon
  dir.writeUInt16LE(entries.length, 4);
  const entryBufs = entries.map((e, i) => {
    const b = Buffer.alloc(16);
    b[0] = e.s >= 256 ? 0 : e.s; // width
    b[1] = e.s >= 256 ? 0 : e.s; // height
    b[2] = 0; // colors
    b[3] = 0; // reserved
    b.writeUInt16LE(1, 4); // planes
    b.writeUInt16LE(32, 6); // bpp
    b.writeUInt32LE(e.png.length, 8);
    b.writeUInt32LE(offset, 12);
    offset += e.png.length;
    return b;
  });
  return Buffer.concat([dir, ...entryBufs, ...entries.map((e) => e.png)]);
}
writeFileSync(join(iconsDir, "icon.ico"), buildIco([16, 32, 48, 64, 128, 256]));
console.log("[icons] wrote icon.ico");

// .icns is only required for macOS builds; skip if we're not on macOS and the
// tool is missing. We drop a PNG named icon.icns as a no-op placeholder so the
// bundle config doesn't 404 on Windows/Linux builds — Tauri ignores it there.
if (!existsSync(join(iconsDir, "icon.icns"))) {
  // macOS builds need a real .icns; warn loudly.
  console.warn(
    "[icons] NOTE: icon.icns not generated. Generate one with " +
      "`iconutil -c icns` on macOS (or `npx @tauri-apps/cli icon`) before building a .dmg."
  );
}

console.log("[icons] done.");
