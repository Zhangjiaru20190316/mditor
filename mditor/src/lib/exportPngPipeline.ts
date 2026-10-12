// PNG 导出管线（EX 轮阶段五，RC-6 修复）：离屏工厂渲染替代实时 DOM 截图。
//
// 旧路径 exportPng 截 previewEl() 实时 DOM——cv 档懒渲染占位（$ 源码文本）
// 与未加载 lazy 图直接入图（阶段一定罪：密度档 2,355 行内公式 984 个为
// 源码占位）。新路径与 PDF/HTML 同源：模型序列化 HTML → 共享预处理 →
// 工厂全量渲染（S10 消毒在工厂文档组装内）→ 分块光栅 → 纵向拼接单 PNG。
//
// 画布预算沿 exportPng 惯例（MAX 16384px 边 / 120MP）：2x 放不下步降 1x，
// 仍超则 fractional 降采样（0.01 步进、下限 0.2），连 0.2 都放不下才报错
// ——语义与旧路径一致（用户拿到的是缩小但完整的图）。

import { renderInFactory } from "./exportRenderFactory";

const MAX_CANVAS_SIDE = 16_384;
const MAX_CANVAS_PIXELS = 120_000_000;
/** PNG 内容宽（与 HTML 导出 wrapHtml 的 820px 版心同宽——视觉延续性）。 */
export const PNG_CONTENT_WIDTH_PX = 820;

export interface PngExportProgress {
  stage: "factory" | "raster" | "stitch";
  done: number;
  total: number;
}

export interface PngPipelineOptions {
  /** 光栅倍率（默认 2；超预算自动步降——与旧 exportPng 同语义）。 */
  scale?: number;
  /** 页面背景（主题底色；缺省白）。 */
  backgroundColor?: string;
  signal?: AbortSignal;
  onProgress?: (p: PngExportProgress) => void;
}

export interface PngPipelineResult {
  bytes: Uint8Array;
  meta: {
    widthPx: number;
    heightPx: number;
    scale: number;
    chunks: number;
    factoryIssues: number;
    timings: { factory: number; raster: number; stitch: number };
  };
}

export async function runPngPipeline(
  html: string,
  css: string,
  o: PngPipelineOptions = {}
): Promise<PngPipelineResult> {
  const t = { factory: 0, raster: 0, stitch: 0 };
  const scale0 = o.scale ?? 2;
  let t0 = performance.now();
  const handle = await renderInFactory(html, {
    // PNG 无页高概念：不设 maxImageHeightPx（长图语义）。
    contentWidthPx: PNG_CONTENT_WIDTH_PX,
    css,
    title: "png-export",
    signal: o.signal,
    onProgress: (p) =>
      p.stage === "images" &&
      o.onProgress?.({ stage: "factory", done: p.done, total: p.total }),
  });
  t.factory = performance.now() - t0;
  try {
    if (o.signal?.aborted) throw new DOMException("导出已取消", "AbortError");
    const doc = handle.doc;
    const content = handle.content;
    const w = PNG_CONTENT_WIDTH_PX;
    const h = Math.max(1, Math.ceil(content.scrollHeight));
    const bg =
      o.backgroundColor ||
      doc.defaultView?.getComputedStyle(doc.documentElement).backgroundColor ||
      "#ffffff";

    // 画布预算（沿旧 exportPng：2x → 1x → fractional ≥0.2）。
    const fits = (s: number): boolean =>
      w * s <= MAX_CANVAS_SIDE &&
      h * s <= MAX_CANVAS_SIDE &&
      w * h * s * s <= MAX_CANVAS_PIXELS;
    let scale = scale0;
    if (!fits(scale)) scale = 1;
    if (!fits(scale)) {
      const byPixels = Math.sqrt(MAX_CANVAS_PIXELS / (w * h));
      const bySide = Math.min(MAX_CANVAS_SIDE / w, MAX_CANVAS_SIDE / h);
      scale = Math.floor(Math.min(1, byPixels, bySide) * 100) / 100;
      if (scale < 0.2 || !fits(scale)) {
        throw new Error(
          `文档过大，无法导出 PNG（约 ${w}×${h} px，超过 ${MAX_CANVAS_PIXELS / 1_000_000} MP 画布预算）。请拆分文档后再试。`
        );
      }
    }

    // 裁剪窗口 + 分块光栅（与 PDF 管线同款技术，块高按预算）。
    const win = doc.createElement("div");
    win.style.cssText = `overflow:hidden;position:relative;width:${w}px;`;
    const parent = content.parentNode as Node;
    parent.insertBefore(win, content);
    win.appendChild(content);
    content.style.position = "relative";

    const outW = Math.round(w * scale);
    const outH = Math.round(h * scale);
    const chunkMaxH = Math.floor(
      Math.min(MAX_CANVAS_SIDE / scale, MAX_CANVAS_PIXELS / (w * scale * scale))
    );
    const chunks = Math.max(1, Math.ceil(h / chunkMaxH));

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建拼接画布（2D 上下文不可用）");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, outW, outH);

    const { domToPng } = await import("modern-screenshot");
    t0 = performance.now();
    for (let i = 0; i < chunks; i++) {
      if (o.signal?.aborted) throw new DOMException("导出已取消", "AbortError");
      const top = Math.min(i * chunkMaxH, Math.max(0, h - 1));
      const viewH = Math.min(chunkMaxH, h - top);
      win.style.height = `${viewH}px`;
      content.style.transform = `translateY(${-top}px)`;
      void content.scrollHeight; // 强制重排（不依赖 rAF，同 PDF 管线）
      await new Promise((res) => setTimeout(res, 0));
      const dataUrl = await domToPng(win, {
        width: w,
        height: viewH,
        scale,
        backgroundColor: bg,
      });
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      ctx.drawImage(img, 0, Math.round(top * scale));
      img.src = "";
      o.onProgress?.({ stage: "raster", done: i + 1, total: chunks });
    }
    t.raster = performance.now() - t0;

    t0 = performance.now();
    const bytes = dataUrlToBytes(canvas.toDataURL("image/png"));
    t.stitch = performance.now() - t0;
    return {
      bytes,
      meta: {
        widthPx: outW,
        heightPx: outH,
        scale,
        chunks,
        factoryIssues: handle.issues.length,
        timings: t,
      },
    };
  } finally {
    handle.destroy();
  }
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const i = dataUrl.indexOf(",");
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
  return bytes;
}
