// DE 轮 M3：PDF 微编辑 patch 纯函数面（选字族/收缩/覆盖几何/upsert/revert）。
// 独立成模块的原因：PdfNoteView 静态引用这些纯函数，而 applyPdfPatches
// （pdf-lib/fontkit 副作用面）必须保持懒加载——铁律「首屏 bundle 增量 0」
// （阶段 0 报告 + 任务书 §八）。本模块零三方依赖，可全量 vitest。

import type { PdfPatch } from "./docNote";

// ---- 纯函数 -------------------------------------------------------------------

/** 选字族：文本含 CJK/全角（含 CJK 标点）任一字符 → Noto 主字族；纯拉丁/
 *  ASCII → Inter（Medium）。单 patch 单字族（混排走 Noto——其拉丁形可用）。 */
export function chooseFontKind(text: string): "cjk" | "latin" {
  for (const ch of Array.from(text)) {
    const c = ch.codePointAt(0) ?? 0;
    if (
      (c >= 0x2e80 && c <= 0x9fff) ||
      (c >= 0x3000 && c <= 0x303f) ||
      (c >= 0xff00 && c <= 0xffef) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0xf900 && c <= 0xfaff)
    ) {
      return "cjk";
    }
  }
  return "latin";
}

/** 宽度测量函数形态（pdf-lib PDFFont.widthOfTextAtSize 注入，纯函数可测）。 */
export type WidthFn = (text: string, size: number) => number;

/** 字号收缩（spike③ 一发公式）：w(size) 随 size 线性 → size* = size₀·W/w₀
 *  精确成立。低于下限（0.55·size₀）返回 ok=false（patch 拒绝列报）。 */
export function fitFontSize(
  widthOf: WidthFn,
  text: string,
  size: number,
  availWidth: number
): { size: number; ok: boolean } {
  const w0 = widthOf(text, size);
  if (w0 <= availWidth || w0 <= 0) return { size, ok: true };
  const shrunk = (size * availWidth) / w0;
  const MIN_RATIO = 0.55;
  if (shrunk < size * MIN_RATIO) return { size: shrunk, ok: false };
  return { size: shrunk, ok: true };
}

/** patch 覆盖矩形几何（用户空间；spike② 实测 Noto 度量：desc 0.30 + asc
 *  1.12，左右各 1pt 冗余）。bbox 输入为行 bbox（不含 pad）。 */
export function coverRectOf(patch: PdfPatch): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const [x0, yBottom, x1, yTop] = patch.bbox;
  const size = patch.fontSize || 10;
  return {
    x: x0 - 1,
    y: yBottom - 0.06 * size,
    width: x1 - x0 + 2,
    height: yTop - yBottom + 0.12 * size,
  };
}

/** 由编辑行构造 patch（bbox = 基线上下带内边距；coverColor 可选采样色）。 */
export function patchFromLine(
  line: { page: number; key: string; text: string; x0: number; y: number; width: number; height: number },
  newText: string,
  coverColor?: string
): PdfPatch {
  return {
    page: line.page,
    lineKey: line.key,
    origText: line.text,
    newText,
    bbox: [line.x0, line.y - 0.3 * line.height, line.x0 + line.width, line.y + 1.12 * line.height],
    baseline: { x: line.x0, y: line.y },
    fontSize: line.height,
    ...(coverColor ? { coverColor } : {}),
  };
}

/** upsert：同 lineKey 覆盖（行内二次编辑更新 newText）；newText 与原文相同
 *  则移除该 patch（编辑回原值 = 撤销语义）。 */
export function upsertPatch(patches: PdfPatch[], next: PdfPatch): PdfPatch[] {
  const rest = patches.filter((p) => p.lineKey !== next.lineKey);
  if (next.newText === next.origText) return rest;
  return [...rest, next];
}

/** 撤销指定行 patch。 */
export function revertPatch(patches: PdfPatch[], lineKey: string): PdfPatch[] {
  return patches.filter((p) => p.lineKey !== lineKey);
}

/** #rrggbb → pdf-lib rgb（非法输入回退纯白）。 */
export function hexToRgbTuple(hex: string | undefined): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
