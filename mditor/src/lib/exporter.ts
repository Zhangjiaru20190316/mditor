// Export the current document to HTML / PDF / PNG / DOCX.
//
// Single source of truth: Vditor's rendered HTML (`getHTML()`). Every format
// starts from that HTML + the active theme CSS, so exports visually match the
// editor.
//
//   * HTML:  inline theme CSS into a standalone .html, write to disk.
//   * PDF:   load the same HTML into a hidden iframe and call print(). The user
//            picks "Save as PDF" in the OS dialog. (True silent export isn't
//            exposed by Tauri/wry yet — wry#707. Windows-only path TODO P1.)
//   * PNG:   modern-screenshot of a rendered preview container.
//   * DOCX:  @turbodocx/html-to-docx (real OOXML, client-side, no pandoc).
//
// Images: for portability we don't base64-inline by default (keeps HTML small);
// a `inlineImages` option exists for the HTML path when you need a single
// self-contained file.

import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile, writeFile } from "@tauri-apps/plugin-fs";
// NOTE: modern-screenshot + juice + @turbodocx/html-to-docx are all imported
// lazily inside their respective export functions so the heavyweight "export"
// bundle only loads when the user actually exports. Importing them at the top
// would pull a 2 MB+ chunk into the initial page load.

const HTML_FILTER = [{ name: "HTML", extensions: ["html"] }];
const PDF_FILTER = [{ name: "PDF", extensions: ["pdf"] }];
const PNG_FILTER = [{ name: "Image", extensions: ["png"] }];
const DOCX_FILTER = [{ name: "Word", extensions: ["docx"] }];

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

/** Export a standalone .html file. Returns the chosen path or null. */
export async function exportHtml(
  ctx: ExportContext,
  suggestedName = "untitled.html"
): Promise<string | null> {
  const path = await saveDialog({ defaultPath: suggestedName, filters: HTML_FILTER });
  if (!path) return null;
  const title = suggestedName.replace(/\.html?$/i, "");
  const standalone = wrapHtml(ctx.html, ctx.css, title);
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
    throw new Error(
      `文档过大，无法导出 PNG（约 ${w}×${h} px，超过 ${MAX_CANVAS_PIXELS / 1_000_000} MP 画布预算）。请拆分文档后再试。`
    );
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
  // Inline CSS so heading/list styling survives the html->docx conversion.
  const juice = (await import("juice")).default;
  const inlined = juice.inlineContent(ctx.html, ctx.css);
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
