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
import { chooseFontKind, coverRectOf, fitFontSize, hexToRgbTuple } from "./docNotePdfPatch";

// CJS 互op（对齐 exportPdfPipeline.ts 的 default/命名双收形态）。
const fontkit = (fontkitNs as unknown as { default?: typeof fontkitNs }).default ?? fontkitNs;

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
