// DE 轮 M3：文字 PDF 行级微编辑的 patch 应用（任务书 §4.2）。
//
// 铁律（阶段 0 spike 报告 docs/doc-note-edit-spike-report.md 的实测结论）：
//   * 坐标：pdfjs textContent transform 与 pdf-lib drawText/drawRectangle 同
//     为用户空间（y 向上）恒等映射——零换算；
//   * 覆盖矩形：y0 = f − 0.30·size、高 1.42·size、左右各 +1pt（视觉验收
//     零残留）；底色默认纯白，patch.coverColor 携带编辑时采样色；
//   * 宽度：pdf-lib widthOfTextAtSize 与 pdfjs 回读零误差；收缩一发公式
//     size* = size₀·W/w₀（线性精确），下限 0.55·size₀，仍超则拒绝列报；
//   * 字形（🔴 进程安全红线）：subset:true 下缺字形在 fontkit 流回调里抛
//     异步 RangeError，try/catch 兜不住、直接杀死 WebView 进程——任何文本
//     drawText 前必须逐码点 hasGlyphForCodePoint 检查，未覆盖的 patch 拒绝；
//   * 加密：load 直接抛错（禁用 ignoreEncryption——会产出损坏文件）；
//   * /Rotate≠0 的页整页拒绝（预览照常）；幂等：每次保存从原始字节重放。
//
// 纯函数（选字族/收缩/upsert/revert/覆盖几何）可全量 vitest；applyPdfPatches
// 副作用面（pdf-lib）在 vitest node 环境直测（库本身同构）。

import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import * as fontkitNs from "@pdf-lib/fontkit";
import type { PdfPatch } from "./docNote";

// CJS 互op（对齐 exportPdfPipeline.ts 的 default/命名双收形态）。
const fontkit = (fontkitNs as unknown as { default?: typeof fontkitNs }).default ?? fontkitNs;

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

// ---- 应用（副作用面：pdf-lib）--------------------------------------------------

export interface PdfPatchReject {
  lineKey: string;
  page: number;
  reason: string;
}

export interface ApplyPdfPatchesResult {
  bytes: Uint8Array;
  applied: number;
  rejected: PdfPatchReject[];
}

export interface ApplyPdfPatchesFonts {
  /** CJK 主字族（NotoSansSC；缺失则全部 patch 拒绝——绝不 notdef）。 */
  cjk: Uint8Array;
  /** Inter 拉丁变体（可选：缺位时拉丁 patch 也走 CJK 字族）。 */
  latin?: Uint8Array | null;
}

/** 从原始字节重放全部 patch（幂等：调用方保证传入原始字节，不基于已 patch
 *  产物叠加）。拒绝场景逐条列报（rejected），不中断其余 patch。 */
export async function applyPdfPatches(
  bytes: Uint8Array,
  patches: PdfPatch[],
  fonts: ApplyPdfPatchesFonts
): Promise<ApplyPdfPatchesResult> {
  const rejected: PdfPatchReject[] = [];
  if (patches.length === 0) {
    return { bytes, applied: 0, rejected };
  }
  // 加密 PDF 在此抛错（默认不 ignoreEncryption——铁律 4）。
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const noto = await doc.embedFont(fonts.cjk, { subset: true });
  const inter = fonts.latin ? await doc.embedFont(fonts.latin, { subset: true }) : null;

  // 字形守护（红线）：fontkit 直读全量字体 + 码点级缓存——未检查文本绝不
  // 进 drawText（缺字形 = fontkit 流回调异步崩溃，进程级事故）。
  const gc = fontkit.create(fonts.cjk);
  const gi = fonts.latin ? fontkit.create(fonts.latin) : null;
  const cache = new Map<string, boolean>();
  const covered = (text: string, kind: "cjk" | "latin"): boolean => {
    for (const ch of Array.from(text)) {
      const cp = ch.codePointAt(0)!;
      const ck = `${kind}:${cp}`;
      let ok = cache.get(ck);
      if (ok === undefined) {
        ok = kind === "latin" && gi ? gi.hasGlyphForCodePoint(cp) : gc.hasGlyphForCodePoint(cp);
        cache.set(ck, ok);
      }
      if (!ok) return false;
    }
    return true;
  };

  const pickFont = (kind: "cjk" | "latin"): PDFFont =>
    kind === "latin" && inter ? inter : noto;

  for (const patch of patches) {
    const page = doc.getPage(patch.page - 1);
    // /Rotate≠0 整页拒绝（任务书：旋转页编辑拒绝，预览照常）。
    if (((page.getRotation().angle % 360) + 360) % 360 !== 0) {
      rejected.push({ lineKey: patch.lineKey, page: patch.page, reason: "该页为旋转页，不支持编辑" });
      continue;
    }
    const kind = chooseFontKind(patch.newText);
    if (!covered(patch.newText, kind)) {
      rejected.push({ lineKey: patch.lineKey, page: patch.page, reason: "新文本包含字库未覆盖的字符（如 emoji/特殊符号）" });
      continue;
    }
    const font = pickFont(kind);
    const availW = patch.bbox[2] - patch.bbox[0] + 2;
    const fit = fitFontSize((t, s) => font.widthOfTextAtSize(t, s), patch.newText, patch.fontSize || 10, availW);
    if (!fit.ok) {
      rejected.push({ lineKey: patch.lineKey, page: patch.page, reason: "新文本过长：字号收缩超下限仍超行宽" });
      continue;
    }
    const [r, g, b] = hexToRgbTuple(patch.coverColor);
    const cr = coverRectOf(patch);
    page.drawRectangle({ ...cr, color: rgb(r, g, b) });
    page.drawText(patch.newText, {
      x: patch.baseline.x,
      y: patch.baseline.y,
      size: fit.size,
      font,
      color: rgb(0, 0, 0),
    });
  }

  if (rejected.length === patches.length) {
    // 全拒：不产出「名义保存、实际零改动」的假成功——抛错交由调用方列报。
    throw new Error(`全部 ${rejected.length} 条补丁被拒绝：${rejected[0].reason}`);
  }
  const out = await doc.save({ useObjectStreams: true });
  return { bytes: out, applied: patches.length - rejected.length, rejected };
}
