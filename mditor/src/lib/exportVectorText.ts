// RV 轮阶段一：矢量文本的纯逻辑面 —— CSS 颜色解析 + 逐文本结点的矢量化
// 判定。DOM 采集（exportPdfPipeline.collectTextFragments）与组装
//（exportPdfAssembly 的可见 drawText）共享这套判定，保证「位图里摘除的
// 文字」与「矢量补画的文字」严格同一批——错一批就是丢字或重影。
//
// 判定口径（阶段一）：只有「常规字重、非斜体、无文本装饰线、非等宽字体、
// 不透明颜色、不在块级降级域、不在 KaTeX 内」的文本走矢量；其余留在位图
// （Tr 3 影子层保选中/复制）。阶段四放开 bold/italic（合成字重/斜体）。

/** RGB（0-255）+ alpha（0-1）。 */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** computed color / background-color 字符串 → RGB。解析不了返回 null。 */
export function parseCssColor(s: string): RgbColor | null {
  const t = s.trim();
  let m = t.match(
    /^rgba?\(\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/i
  );
  if (m) {
    const num = (v: string): number => Math.max(0, Math.min(255, parseFloat(v)));
    let a = 1;
    if (m[4] != null) {
      a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      if (!Number.isFinite(a)) a = 1;
    }
    return { r: num(m[1]), g: num(m[2]), b: num(m[3]), a: Math.max(0, Math.min(1, a)) };
  }
  m = t.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    const hex = m[1];
    const pair = (i: number): number => parseInt(hex.slice(i, i + 2), 16);
    if (hex.length === 3 || hex.length === 4) {
      const s = (i: number): number => parseInt(hex[i] + hex[i], 16);
      return { r: s(0), g: s(1), b: s(2), a: hex.length === 4 ? s(3) / 255 : 1 };
    }
    if (hex.length === 6 || hex.length === 8) {
      return { r: pair(0), g: pair(2), b: pair(4), a: hex.length === 8 ? pair(6) / 255 : 1 };
    }
  }
  return null;
}

/** 矢量化跳过的原因（结题报告的降级占比口径）。 */
export type VectorSkipReason =
  | "raster-scope" // 块级降级域（公式块/图/代码块等所在顶层块）
  | "katex" // KaTeX 渲染域（含行内公式）
  | "bold" // 字重 ≥600：阶段四合成 bold 前留在位图
  | "italic" // 斜体：阶段四合成 oblique 前留在位图
  | "mono-font" // 等宽字体（行内代码）：字形不可复刻，留位图
  | "decorated" // 下划线/删除线等文本装饰：阶段二矢量画线前留位图
  | "alpha-color" // 半透明文字色：pdf-lib 无文字 alpha，混色近似留位图
  | "no-color"; // 颜色解析失败（保守留位图）

export interface VectorizeInput {
  inRasterScope: boolean;
  inKatex: boolean;
  fontWeight: number;
  fontStyle: string;
  textDecorationLine: string;
  fontFamily: string;
  color: RgbColor | null;
}

export interface VectorizeDecision {
  vector: boolean;
  reason: "ok" | VectorSkipReason;
}

/** 合成字重阈值：≥600 视为 bold（阶段四合成开启后仅作统计口径）。 */
export const BOLD_WEIGHT_MIN = 600;

/** 逐文本结点矢量化判定（纯函数）。 */
export function decideTextVectorization(x: VectorizeInput): VectorizeDecision {
  if (x.inRasterScope) return { vector: false, reason: "raster-scope" };
  if (x.inKatex) return { vector: false, reason: "katex" };
  if (x.fontWeight >= BOLD_WEIGHT_MIN) return { vector: false, reason: "bold" };
  if (x.fontStyle !== "normal") return { vector: false, reason: "italic" };
  if (/mono/i.test(x.fontFamily)) return { vector: false, reason: "mono-font" };
  if (x.textDecorationLine !== "none") return { vector: false, reason: "decorated" };
  if (!x.color) return { vector: false, reason: "no-color" };
  if (x.color.a < 0.9) return { vector: false, reason: "alpha-color" };
  return { vector: true, reason: "ok" };
}
