// Export the current document to HTML / PDF / PNG / DOCX.
//
// Single source of truth: the editor's rendered HTML (`getHTML()`). Every format
// starts from that HTML + the active theme CSS, so exports visually match the
// editor.
//
//   * HTML:  inline theme CSS into a standalone .html, write to disk. With
//            `inlineImages` the LOCAL images referenced by the doc are read
//            from disk and embedded as base64 data URLs → one portable file.
//   * PDF:   load the same HTML into a hidden iframe and call print(). The user
//            picks "Save as PDF" in the OS dialog. (True silent export isn't
//            exposed by Tauri/wry yet — wry#707. Windows-only path TODO P1.)
//   * PNG:   modern-screenshot of a rendered preview container; oversized
//            documents step the scale DOWN fractionally instead of refusing.
//   * DOCX:  @turbodocx/html-to-docx (real OOXML, client-side, no pandoc).
//            Local images are inlined as data URLs first — the browser build
//            has no sharp to fetch relative refs itself, so without inlining
//            images silently dropped (the V3.5 known issue).
//
// Images: for portability we don't base64-inline by default (keeps HTML small);
// the HTML path asks the user (V3.6), the DOCX path always inlines (lossless).

import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile, writeFile, readFile } from "@tauri-apps/plugin-fs";
// NOTE: modern-screenshot + juice + @turbodocx/html-to-docx are all imported
// lazily inside their respective export functions so the heavyweight "export"
// bundle only loads when the user actually exports. Importing them at the top
// would pull a 2 MB+ chunk into the initial page load.

const HTML_FILTER = [{ name: "HTML", extensions: ["html"] }];
const PDF_FILTER = [{ name: "PDF", extensions: ["pdf"] }];
const PNG_FILTER = [{ name: "Image", extensions: ["png"] }];
const DOCX_FILTER = [{ name: "Word", extensions: ["docx"] }];

/** 单张图片内联上限（过大直接保留引用，防止内存爆掉）。 */
const INLINE_IMG_MAX_BYTES = 10 * 1024 * 1024;
/** 内联总预算（超出后剩余图片保留原引用）。 */
const INLINE_IMG_TOTAL_BUDGET = 64 * 1024 * 1024;

const IMG_SRC_RE = /<img\b[^>]*\bsrc="([^"]*)"/gi;

/** 按扩展名猜测 data URL 的 MIME。 */
function mimeOf(src: string): string {
  const m = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(src);
  switch ((m?.[1] ?? "").toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

/**
 * 把 HTML 里引用的 LOCAL 图片（相对路径 / 绝对路径，非 http(s) / data:）
 * 读出来替换为 base64 data URL。`docPath` 用于解析相对引用。远程 URL 与
 * 读取失败/超限的图片保留原样。单次遍历 + 预算控制，失败静默降级。
 */
export async function inlineLocalImages(
  html: string,
  docPath?: string | null
): Promise<string> {
  if (!docPath) return html;
  const dir = docPath.replace(/[\\/][^\\/]+$/, "");
  const toAbs = (src: string) =>
    /^[a-zA-Z]:[\\/]/.test(src) ? src : `${dir}/${src}`.replace(/\\/g, "/");
  const jobs: Array<{ src: string; abs: string }> = [];
  IMG_SRC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMG_SRC_RE.exec(html))) {
    const src = m[1];
    if (!src || /^(https?:|data:|asset:|blob:)/i.test(src)) continue;
    jobs.push({ src, abs: toAbs(src) });
  }
  if (jobs.length === 0) return html;

  let used = 0;
  const cache = new Map<string, string>();
  for (const { src, abs } of jobs) {
    if (cache.has(abs)) continue;
    try {
      const bytes = await readFile(abs);
      if (bytes.byteLength > INLINE_IMG_MAX_BYTES) continue;
      if (used + bytes.byteLength > INLINE_IMG_TOTAL_BUDGET) continue;
      used += bytes.byteLength;
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      cache.set(abs, `data:${mimeOf(src)};base64,${btoa(bin)}`);
    } catch {
      /* 读取失败：保留原引用 */
    }
  }
  if (cache.size === 0) return html;
  return html.replace(IMG_SRC_RE, (whole, src: string) => {
    const data = cache.get(toAbs(src));
    return data ? whole.replace(`"${src}"`, `"${data}"`) : whole;
  });
}

export interface ExportContext {
  /** Rendered HTML of the document (from Vditor.getHTML()). */
  html: string;
  /** Theme CSS to apply (the active content theme). */
  css: string;
  /** Optional base path to resolve relative image refs for inlining. */
  docPath?: string | null;
}

/** Wrap rendered HTML + theme CSS into a standalone document string. */
function wrapHtml(html: string, css: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
${css}
/* export-friendly defaults */
body { max-width: 820px; margin: 40px auto; padding: 0 24px; }
mark { background: rgba(255, 213, 79, 0.55); color: inherit; border-radius: 2px; padding: 0.05em 0.12em; } /* ==高光== */
</style>
</head>
<body class="vditor-reset">
${html}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Export a standalone .html file. Returns the chosen path or null.
 *  V3.6: `options.inlineImages` 把本地图片内联为 base64（单文件分发）。 */
export async function exportHtml(
  ctx: ExportContext,
  suggestedName = "untitled.html",
  options: { inlineImages?: boolean } = {}
): Promise<string | null> {
  const path = await saveDialog({ defaultPath: suggestedName, filters: HTML_FILTER });
  if (!path) return null;
  const title = suggestedName.replace(/\.html?$/i, "");
  let html = ctx.html;
  if (options.inlineImages) {
    try {
      html = await inlineLocalImages(html, ctx.docPath);
    } catch {
      /* 内联失败退回原引用 —— 导出仍然完成 */
    }
  }
  const standalone = wrapHtml(html, ctx.css, title);
  await writeTextFile(path, standalone);
  return path;
}

/**
 * Export to PDF. Renders the HTML in a hidden iframe and triggers the OS print
 * dialog; the user selects "Save as PDF". Returns the path the user would save
 * to (informational only — the actual file is produced by the print dialog).
 */
export async function exportPdf(
  ctx: ExportContext,
  suggestedName = "untitled.pdf"
): Promise<string | null> {
  const path = await saveDialog({ defaultPath: suggestedName, filters: PDF_FILTER });
  if (!path) return null;
  const title = suggestedName.replace(/\.pdf$/i, "");
  await printHtml(wrapHtml(ctx.html, ctx.css, title));
  // Hint the user where they intended to save (the print dialog does the rest).
  return path;
}

/** Render `fullHtml` (a complete document) offscreen and call print(). */
function printHtml(fullHtml: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    // 幂等回收：移除 iframe 并清掉兜底定时器。连续导出 PDF 时若不即时回收，
    // 每个隐藏 iframe（含其完整 document 对象）会一直挂到 60s 兜底超时才释放，
    // 堆积成可观的内存占用。
    let settled = false;
    let settleTimer: number | undefined;
    let fallbackTimer: number | undefined;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer);
      iframe.remove();
    };
    iframe.onload = () => {
      try {
        const win = iframe.contentWindow;
        // give layout/fonts a tick to settle before invoking print. Track the
        // handle and re-check `settled` inside: if cleanup already ran (e.g.
        // doc.write fires onload twice, or onerror lands after onload), the
        // pending callback must not call print() on a removed iframe.
        settleTimer = window.setTimeout(() => {
          if (settled) return;
          win?.focus();
          // 打印对话框关闭后立即回收（afterprint 于打印/取消后触发），
          // 不再空等 60s；兜底定时器防范事件缺失的浏览器。
          win?.addEventListener("afterprint", cleanup, { once: true });
          win?.print();
          fallbackTimer = window.setTimeout(cleanup, 60_000);
          resolve();
        }, 400);
      } catch (e) {
        cleanup();
        reject(e);
      }
    };
    iframe.onerror = (e) => {
      cleanup();
      reject(e);
    };
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.open();
    doc.write(fullHtml);
    doc.close();
  });
}

/**
 * Export to PNG by snapshotting a rendered preview element.
 *
 * @param previewEl  a DOM node containing the rendered document
 * @param backgroundColor  page background (defaults to white)
 */
export async function exportPng(
  previewEl: HTMLElement,
  suggestedName = "untitled.png",
  backgroundColor = "#ffffff"
): Promise<string | null> {
  const path = await saveDialog({ defaultPath: suggestedName, filters: PNG_FILTER });
  if (!path) return null;
  // Make sure fonts are ready so CJK / mono render correctly.
  if (document.fonts?.ready) await document.fonts.ready;

  // Canvas budget gate: scale 2 quadruples the pixel count, and a tall document
  // at 2x easily exceeds what browsers allocate for a single canvas (opaque OOM
  // or a silently coerced/blank canvas). modern-screenshot multiplies the
  // width/height by `scale`, so the final canvas is (w*scale)×(h*scale) —
  // estimate it first and step the scale down before rendering.
  const MAX_CANVAS_SIDE = 16_384; // px per side, widely-safe upper bound
  const MAX_CANVAS_PIXELS = 120_000_000; // ~120 MP total-pixel budget
  const w = previewEl.scrollWidth;
  const h = previewEl.scrollHeight;
  if (w <= 0 || h <= 0) throw new Error("无法导出 PNG：文档内容为空。");
  const fits = (s: number) =>
    w * s <= MAX_CANVAS_SIDE &&
    h * s <= MAX_CANVAS_SIDE &&
    w * h * s * s <= MAX_CANVAS_PIXELS;
  let scale = 2;
  if (!fits(scale)) scale = 1; // too big at 2x — fall back to native resolution
  if (!fits(scale)) {
    // V3.6：原生分辨率仍超预算 → 逐步 fractional 降采样（0.01 步进，最低
    // 0.2），只有连 0.2 都放不下（单边超 16k）才拒绝。降采样导出优于直接
    // 报错——用户拿到的是缩小但完整的图。
    const byPixels = Math.sqrt(MAX_CANVAS_PIXELS / (w * h));
    const bySide = Math.min(MAX_CANVAS_SIDE / w, MAX_CANVAS_SIDE / h);
    scale = Math.floor(Math.min(1, byPixels, bySide) * 100) / 100;
    if (scale < 0.2 || !fits(scale)) {
      throw new Error(
        `文档过大，无法导出 PNG（约 ${w}×${h} px，超过 ${MAX_CANVAS_PIXELS / 1_000_000} MP 画布预算）。请拆分文档后再试。`
      );
    }
  }

  const { domToPng } = await import("modern-screenshot");
  const dataUrl = await domToPng(previewEl, {
    scale,
    backgroundColor,
    width: w,
    height: h,
  });
  const bytes = base64ToBytes(dataUrl);
  await writeFile(path, bytes);
  return path;
}

/**
 * Export to .docx (real OOXML).
 *
 * @turbodocx/html-to-docx signature:
 *   HTMLtoDOCX(htmlString, headerHTML?, documentOptions?, footerHTML?) ->
 *     Promise<ArrayBuffer | Blob | Buffer>
 *
 * NOTE: this lib has a Node heritage (Buffer/sharp under the hood). The browser
 * build degrades gracefully on images (no sharp) — text formatting still
 * exports. If the browser build throws at runtime, the P1 fix is to run the
 * conversion in a Tauri sidecar or a Node child process. TODO(P1).
 */
export async function exportDocx(
  ctx: ExportContext,
  suggestedName = "untitled.docx"
): Promise<string | null> {
  const path = await saveDialog({ defaultPath: suggestedName, filters: DOCX_FILTER });
  if (!path) return null;
  // V3.6：先把本地图片内联成 data URL —— 浏览器构建没有 sharp，相对引用的
  // 图片会被转换器直接丢弃（V3.5 已知问题）。失败退回原 HTML（行为同旧版）。
  let html = ctx.html;
  try {
    html = await inlineLocalImages(ctx.html, ctx.docPath);
  } catch {
    /* 内联失败按旧路径继续 */
  }
  // Inline CSS so heading/list styling survives the html->docx conversion.
  const juice = (await import("juice")).default;
  const inlined = juice.inlineContent(html, ctx.css);
  const htmlToDocx = (await import("@turbodocx/html-to-docx")).default;
  const documentOptions = {
    table: { row: { cantSplit: true } },
    footer: true,
    pageNumber: true,
  };
  const result = await htmlToDocx(inlined, null, documentOptions);
  const bytes = toArrayBuffer(result);
  await writeFile(path, new Uint8Array(bytes));
  return path;
}

/** Coerce the lib's union return type into an ArrayBuffer we can write. */
function toArrayBuffer(r: ArrayBuffer | Blob | Uint8Array): ArrayBuffer {
  if (r instanceof ArrayBuffer) return r;
  // Node Buffer is a Uint8Array subclass; handle that without referencing the
  // global `Buffer` (which doesn't exist in the webview type scope).
  if (r instanceof Uint8Array) {
    const ab = new ArrayBuffer(r.byteLength);
    new Uint8Array(ab).set(r);
    return ab;
  }
  // Blob — the browser build shouldn't return one, but guard anyway.
  throw new Error("html-to-docx returned a Blob; convert via arrayBuffer() first.");
}

function base64ToBytes(dataUrl: string): Uint8Array {
  const i = dataUrl.indexOf(",");
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
  return bytes;
}
