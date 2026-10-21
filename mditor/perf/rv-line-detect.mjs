// RV 轮页图线检测（阶段0 表格边框的程序化验证）：ffmpeg 解码 PNG 为灰度
// raw → 行/列墨量剖面 → 检测长横线（表格边框/分隔线）与竖线（单元格内线）。
// 用法：node perf/rv-line-detect.mjs <page.png> [minRunRatio]
import { execFileSync } from "node:child_process";

const file = process.argv[2];
const ratio = Number(process.argv[3] ?? 0.4);
if (!file) {
  console.error("usage: node rv-line-detect.mjs <page.png> [minRunRatio]");
  process.exit(1);
}

// 读尺寸（PNG IHDR）
const fs = await import("node:fs");
const buf = fs.readFileSync(file);
const W = buf.readUInt32BE(16);
const H = buf.readUInt32BE(20);

// ffmpeg → gray rawvideo（页图 2x ≈ 3.5MB，maxBuffer 放大）
const raw = execFileSync("ffmpeg", [
  "-loglevel", "error", "-i", file,
  "-vf", "format=gray", "-f", "rawvideo", "-",
], { maxBuffer: 1 << 28 });

// 行剖面：每行与行中值的偏差像素数（抗主题底色）。灵敏度可调——claude 等
// 主题 --border 与纸底灰阶差仅 ~18，默认阈值须低于它。
const SENS = Number(process.env.RV_SENS ?? 8);
const rowProfile = new Int32Array(H);
for (let y = 0; y < H; y++) {
  const row = raw.subarray(y * W, y * W + W);
  const hist = new Map();
  for (const v of row) hist.set(v, (hist.get(v) ?? 0) + 1);
  let med = 0, best = 0;
  for (const [v, c] of hist) if (c > best) { best = c; med = v; }
  let ink = 0;
  for (const v of row) if (Math.abs(v - med) > SENS) ink++;
  rowProfile[y] = ink;
}

// 横线行：墨点 > ratio×W，聚组（相邻行合并成一条线）
const thresh = Math.floor(W * ratio);
const hLines = [];
let cur = -2;
for (let y = 0; y < H; y++) {
  if (rowProfile[y] > thresh) {
    if (y !== cur + 1 && !(hLines.length && y === cur)) hLines.push({ y0: y, y1: y });
    else hLines[hLines.length - 1].y1 = y;
    cur = y;
  }
}

// 竖线检测：在首末横线之间的 y 跨度内，列墨点 > 0.7×跨度
const vLines = [];
if (hLines.length >= 2) {
  const yTop = hLines[0].y1 + 2;
  const yBot = hLines[hLines.length - 1].y0 - 2;
  const span = yBot - yTop;
  if (span > 40) {
    for (let x = 0; x < W; x++) {
      let ink = 0;
      for (let y = yTop; y <= yBot; y++) if (raw[y * W + x] < 128) ink++;
      if (ink > span * 0.7) vLines.push(x);
    }
  }
}

console.log(JSON.stringify({
  file, W, H,
  hLineCount: hLines.length,
  hLines: hLines.map((l) => [l.y0, l.y1, rowProfile[l.y0]]),
  vLineCols: vLines.length ? [vLines[0], vLines[vLines.length - 1], `count=${vLines.length}`] : null,
}, null, 1));
