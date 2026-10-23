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
  | "mono-font" // 等宽字体（行内代码）：字形不可复刻，留位图
  | "decorated" // 不可矢量画的文本装饰（overline 等罕见形态）
  | "alpha-color" // 半透明文字色：pdf-lib 无文字 alpha，混色近似留位图
  | "no-color" // 颜色解析失败（保守留位图）
  | "no-glyph"; // 内嵌字体缺字形（emoji/特殊符号）→ 残留补丁兜底

export interface VectorizeInput {
  inRasterScope: boolean;
  inKatex: boolean;
  fontWeight: number;
  fontStyle: string;
  textDecorationLine: string;
  fontFamily: string;
  color: RgbColor | null;
  /** 内嵌字体对文本全字符有字形（阶段四；false → 残留补丁兜底）。 */
  glyphsCovered?: boolean;
}

export interface VectorizeDecision {
  vector: boolean;
  reason: "ok" | VectorSkipReason;
  /** 合成加粗（阶段四：Tr 2 FillAndStroke + 细描边）。 */
  syntheticBold?: boolean;
  /** 合成斜体（阶段四：xSkew 剪切）。 */
  syntheticItalic?: boolean;
}

/** 合成字重阈值：≥600 视为 bold（合成加粗覆盖）。 */
export const BOLD_WEIGHT_MIN = 600;

/** 可矢量绘制的文本装饰线（underline/line-through；overline 等罕见形态
 *  保守留位图）。 */
const DRAWABLE_DECOR = /^(underline|line-through)( (underline|line-through))?$/;

/** 逐文本结点矢量化判定（纯函数）。 */
export function decideTextVectorization(x: VectorizeInput): VectorizeDecision {
  if (x.inRasterScope) return { vector: false, reason: "raster-scope" };
  if (x.inKatex) return { vector: false, reason: "katex" };
  if (/mono/i.test(x.fontFamily)) return { vector: false, reason: "mono-font" };
  if (x.textDecorationLine !== "none" && !DRAWABLE_DECOR.test(x.textDecorationLine.trim())) {
    return { vector: false, reason: "decorated" };
  }
  if (!x.color) return { vector: false, reason: "no-color" };
  if (x.color.a < 0.9) return { vector: false, reason: "alpha-color" };
  if (x.glyphsCovered === false) return { vector: false, reason: "no-glyph" };
  const syntheticBold = x.fontWeight >= BOLD_WEIGHT_MIN;
  const syntheticItalic = x.fontStyle !== "normal";
  return {
    vector: true,
    reason: "ok",
    ...(syntheticBold ? { syntheticBold: true } : {}),
    ...(syntheticItalic ? { syntheticItalic: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// RVF 阶段一：拉丁 run 真字体变体（Inter 四变体内嵌，合成粗/斜体退位为
// CJK 兜底）。编辑器 --font-prose: system-ui 在 Windows 下 Latin=Segoe UI、
// CJK=微软雅黑；矢量导出此前全画 NotoSansSC——拉丁字形显著偏细（F1）、无
// Bold/Italic 文件只能描边/剪切近似（F2/F3）。Latin 子 run 改画 Inter（UI
// 文本族，与 Segoe UI 观感/墨量最接近），CJK 子 run 维持 NotoSansSC；混合
// run 按 script 拆分（Latin 真粗 + CJK 合成粗并存）。缺字形沿用 no-glyph →
// 残留补丁兜底（绝不画 notdef）。
// ---------------------------------------------------------------------------

/** Inter 四变体（索引与字节表顺序一致）。 */
export const LATIN_FONT_VARIANTS = [
  "latin-regular",
  "latin-bold",
  "latin-italic",
  "latin-bolditalic",
] as const;
export type LatinFontVariant = (typeof LATIN_FONT_VARIANTS)[number];
/** CJK/其余文字（NotoSansSC；粗/斜仍走合成兜底）。 */
export const CJK_VARIANT = "cjk";
export type RunFontVariant = LatinFontVariant | typeof CJK_VARIANT;

/** Inter 确定覆盖的 Unicode 码段（保守取值——Segoe UI 主字体呈现的字符面；
 *  拉丁/希腊/西里尔/通用标点/货币/上下标；其余一律 CJK 域，缺字形由
 *  glyphChecker 兜底）。 */
const LATIN_CP_RANGES: Array<[number, number]> = [
  [0x0020, 0x024f], // 基本拉丁 + Latin-1 + Latin Extended-A/B
  [0x0250, 0x036f], // IPA + 组合变音符（拼音声调）
  [0x0370, 0x04ff], // 希腊 + 西里尔
  [0x1e00, 0x1eff], // Latin Extended Additional
  [0x2000, 0x206f], // General Punctuation（省略号/引号/破折号）
  [0x2070, 0x209f], // 上下标
  [0x20a0, 0x20bf], // 货币符号
  [0x2122, 0x2122], // ™
];

/** 字符是否属于拉丁域（Inter 承担；否则 CJK 域走 NotoSansSC）。纯函数。 */
export function isLatinScript(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  for (const [lo, hi] of LATIN_CP_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/** 字重/字型 → Inter 变体（就近映射：≥600 为粗，非 normal 为斜；与
 *  decideTextVectorization 的合成判定同阈值）。纯函数。 */
export function latinVariantFor(
  weight: number,
  fontStyle: string
): LatinFontVariant {
  const bold = weight >= BOLD_WEIGHT_MIN;
  const italic = fontStyle !== "normal";
  return bold
    ? italic
      ? "latin-bolditalic"
      : "latin-bold"
    : italic
      ? "latin-italic"
      : "latin-regular";
}

/** 文本 → 逐字符字体变体（与 Array.from(text) 等长；拉丁字符按字重/字型
 *  选 Inter 变体，其余 CJK）。字形覆盖（glyphChecker）不在此层——缺字形
 *  的字符由调用方落 CJK 域或整节点 no-glyph 兜底。纯函数。 */
export function runVariants(
  text: string,
  weight: number,
  fontStyle: string
): RunFontVariant[] {
  const latin = latinVariantFor(weight, fontStyle);
  return Array.from(text, (ch) => (isLatinScript(ch) ? latin : CJK_VARIANT));
}

/** 文本按 script 分段（连续同域字符合并；测试与统计口径）。纯函数。 */
export function splitRunByScript(
  text: string
): Array<{ latin: boolean; text: string }> {
  const out: Array<{ latin: boolean; text: string }> = [];
  for (const ch of Array.from(text)) {
    const latin = isLatinScript(ch);
    const last = out[out.length - 1];
    if (last && last.latin === latin) last.text += ch;
    else out.push({ latin, text: ch });
  }
  return out;
}
