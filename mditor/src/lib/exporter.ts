// Export the current document to HTML / PDF / PNG / DOCX.
//
// Single source of truth: the editor's rendered HTML (`getHTML()`). Every format
// starts from that HTML + the active theme CSS, so exports visually match the
// editor.
//
//   * HTML:  inline theme CSS into a standalone .html, write to disk. With
//            `inlineImages` the LOCAL images referenced by the doc are read
//            from disk and embedded as base64 data URLs → one portable file.
//   * PDF:   自研管线（EX 轮）：离屏工厂渲染 → 分页 → 分块光栅 → pdf-lib
//            组装（位图 + 隐形文本层）。全链路应用内完成，无 OS 打印对话
//            框（wry#707 的静默导出限制由此绕开，不再借道系统打印）。
//   * PNG:   modern-screenshot of a rendered preview container; oversized
//            documents step the scale DOWN fractionally instead of refusing.
//   * DOCX:  @turbodocx/html-to-docx (real OOXML, client-side, no pandoc).
//            Local images are inlined as data URLs first — the browser build
//            has no sharp to fetch relative refs itself, so without inlining
//            images silently dropped (the V3.5 known issue).
//
// Images: for portability we don't base64-inline by default (keeps HTML small);
// the HTML path asks the user (V3.6), the DOCX path always inlines (lossless).

import { getAdapter } from "../platform";
import { sniffImageMime } from "./imageSniff";
import { cleanLocalRef, normalizeLocalPath } from "./imageManager";
import { sanitizeExportHtml } from "./exportSanitize";
import { EXPORT_PROSE_CSS } from "./exportProseCss";
// type-only：编译期擦除，不把 pdf/png 管线块拉进首屏（依赖纪律见下）。
import type { PdfPipelineOptions } from "./exportPdfPipeline";
import type { PngPipelineOptions } from "./exportPngPipeline";
// NOTE: modern-screenshot + juice + @turbodocx/html-to-docx are all imported
// lazily inside their respective export functions so the heavyweight "export"
// bundle only loads when the user actually exports. Importing them at the top
// would pull a 2 MB+ chunk into the initial page load.

const HTML_FILTER = [{ name: "HTML", extensions: ["html"] }];
const PDF_FILTER = [{ name: "PDF", extensions: ["pdf"] }];
const PNG_FILTER = [{ name: "Image", extensions: ["png"] }];
const DOCX_FILTER = [{ name: "Word", extensions: ["docx"] }];
const TEX_FILTER = [{ name: "LaTeX", extensions: ["tex"] }];

/** 单张图片内联上限（过大直接保留引用，防止内存爆掉）。 */
export const INLINE_IMG_MAX_BYTES = 10 * 1024 * 1024;
/** 内联总预算（超出后剩余图片保留原引用）。 */
const INLINE_IMG_TOTAL_BUDGET = 64 * 1024 * 1024;
/** 远程图单张抓取的 JS 侧等待上限（Rust 侧另有 30s 硬上限；超时即放弃并
 *  入显式清单——替代旧打印路径「5s 盲等后照打不误」的静默行为）。 */
const REMOTE_IMG_TIMEOUT_MS = 15_000;
/** 远程图并发抓取数（带宽友好；本地图读盘仍串行）。 */
const REMOTE_IMG_CONCURRENCY = 3;

const IMG_SRC_RE = /<img\b[^>]*\bsrc="([^"]*)"/gi;

/**
 * 单图在导出内联中的结局（C2 显式报告的分类面）。除 inlined /
 * remote-skip（HTML「保留引用」模式的文档化语义）外，一切未进产物的
 * 图片都会出现在 ImageInlineResult.missing 里，由导出 UI 列报——
 * 「静默裂图」是 E-1 的直接根源（阶段一定罪 ex-phase1-e1e2）。
 */
export type ExportImageStatus =
  | "inlined" // 读取成功且预算内，已换装 data URL（本地或远程）
  | "oversize" // 超单图上限 INLINE_IMG_MAX_BYTES
  | "sniff-fail" // 魔数嗅探失败（未知/转换器死循环格式）
  | "budget" // 内联总预算耗尽
  | "read-error" // 读盘失败 / 相对引用无 docPath 可解析
  | "remote-error" // 远程抓取失败（网络/HTTP 错）
  | "remote-timeout" // 远程抓取超时（REMOTE_IMG_TIMEOUT_MS）
  | "remote-skip"; // 策略性不抓（HTML 保留引用模式，文档化语义非缺陷）

export interface ExportImageReportItem {
  src: string;
  status: ExportImageStatus;
  /** 已知字节数（inlined/oversize/budget）。 */
  bytes?: number;
  /** 失败原因摘要（read-error/remote-*）。 */
  detail?: string;
}

export interface ImageInlineResult {
  html: string;
  /** 文档内每张参与内联决策的图片的结局（data:/asset:/blob: 不参与）。 */
  report: ExportImageReportItem[];
  /** 未进产物的图片（一切非 inlined 且非 remote-skip）——UI 列报源。 */
  missing: ExportImageReportItem[];
}

/** 字节 → base64 data URL（分块，避开 apply 栈溢出）。 */
function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

export interface InlineExportImagesOptions {
  /** 远程 http(s) 图策略：fetch = 抓取内联（PDF/DOCX/HTML 内联模式）；
   *  skip = 保留引用（HTML「保留引用」模式默认，remote-skip 不列报）。 */
  remote?: "fetch" | "skip";
  /** 远程单图等待上限（默认 REMOTE_IMG_TIMEOUT_MS）。 */
  remoteTimeoutMs?: number;
}

/**
 * 导出图片内联的全量决策面（EX 轮 Fix-C2）：把 HTML 里参与内联的图片逐张
 * 读取/抓取、按魔数与预算门换装 data URL，并对每张给出显式结局。
 *
 * - 本地图（相对/绝对路径）：与旧 inlineLocalImages 逐字节同语义（含
 *   v4.10.1 的引用清洗/归一化与 v4.6.2 魔数门），只是不再静默。
 * - 远程图（D-5）：remote:"fetch" 时经平台 fetchImage（Tauri=应用自身
 *   Rust http，带 SSRF 防线与 20MB 硬顶；鸿蒙同语义桥接）抓取，并发
 *   REMOTE_IMG_CONCURRENCY，单图 JS 侧超时 remoteTimeoutMs；失败/超时
 *   入显式清单，绝不静默。
 * - data:/asset:/blob: 引用不参与（asset: 在应用内可加载，历史语义）。
 */
export async function inlineExportImages(
  html: string,
  docPath: string | null | undefined,
  opts: InlineExportImagesOptions = {}
): Promise<ImageInlineResult> {
  const remoteMode = opts.remote ?? "skip";
  const dir = docPath ? docPath.replace(/[\\/][^\\/]+$/, "") : null;
  // v4.10.1：与编辑器 resolveImgSrc 同一份解析语义——HTML 属性先做实体解码，
  // 再清洗引用（file:// / ?# / percent 编码）、归一化 `.`/`..` 段。此前导出端
  // 裸拼接，Typora 风格的 `assets/my%20pic.png`、`./assets/../x.png`、POSIX
  // 绝对路径 `/…`（会被误拼到盘符后面）在导出产物里全部 404。
  const toAbs = (raw: string) => {
    const src = raw.replace(
      /&(amp|lt|gt|quot|#39);/g,
      (_, e: string) =>
        ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e] as string
    );
    const cleaned = cleanLocalRef(src);
    return /^([A-Za-z]:[\\/]|[\\/])/.test(cleaned)
      ? normalizeLocalPath(cleaned)
      : normalizeLocalPath(`${dir}/${cleaned}`);
  };
  const keyOf = (src: string): string | null => {
    if (/^https?:/i.test(src)) return src;
    return dir ? toAbs(src) : null;
  };

  // 第一遍：按文档顺序收集唯一引用，分本地/远程作业（remote-skip 与
  // 无 docPath 相对引用没有作业，直接定性）。
  const localJobs = new Map<string, string>(); // abs → 首个 src（作业去重）
  const remoteJobs = new Map<string, string>(); // url → 首个 src
  const orderedSrcs: string[] = [];
  const seenSrc = new Set<string>();
  IMG_SRC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMG_SRC_RE.exec(html))) {
    const src = m[1];
    if (!src || seenSrc.has(src)) continue;
    seenSrc.add(src);
    orderedSrcs.push(src);
    if (/^data:|^asset:|^blob:/i.test(src)) continue; // 不参与内联决策
    if (/^https?:/i.test(src)) {
      if (remoteMode === "fetch") remoteJobs.set(src, src);
      continue; // skip 模式的结局在报告遍历里补
    }
    if (!dir) continue; // 无 docPath 的结局在报告遍历里补
    const abs = toAbs(src);
    if (!localJobs.has(abs)) localJobs.set(abs, src);
  }

  let used = 0;
  const cache = new Map<string, { dataUrl: string; bytes: number }>();
  const failures = new Map<string, Omit<ExportImageReportItem, "src">>();
  const classifyBytes = (key: string, bytes: Uint8Array): void => {
    if (bytes.byteLength > INLINE_IMG_MAX_BYTES) {
      failures.set(key, { status: "oversize", bytes: bytes.byteLength });
      return;
    }
    // 魔数门（v4.6.2）：未知格式不内联——html-to-docx 的 image-size 对
    // ICNS/JXL/HEIF 有解析死循环（详见 lib/imageSniff.ts），且 octet-stream
    // 内联本就渲染不出。嗅探出的真实 MIME 优先于扩展名猜测。
    const sniffed = sniffImageMime(bytes);
    if (!sniffed) {
      failures.set(key, { status: "sniff-fail", bytes: bytes.byteLength });
      return;
    }
    if (used + bytes.byteLength > INLINE_IMG_TOTAL_BUDGET) {
      failures.set(key, { status: "budget", bytes: bytes.byteLength });
      return;
    }
    used += bytes.byteLength;
    cache.set(key, { dataUrl: bytesToDataUrl(bytes, sniffed), bytes: bytes.byteLength });
  };

  // 本地读盘：串行（IPC 便宜，串行最省内存峰值）。
  for (const abs of localJobs.keys()) {
    try {
      const bytes = await getAdapter().fs.readFile(abs);
      classifyBytes(abs, bytes);
    } catch (e) {
      failures.set(abs, { status: "read-error", detail: String(e).slice(0, 120) });
    }
  }

  // 远程抓取：小并发池 + 单图超时（挂起的 IPC 无法取消，只停止等待）。
  if (remoteJobs.size > 0) {
    const timeout = opts.remoteTimeoutMs ?? REMOTE_IMG_TIMEOUT_MS;
    const urls = [...remoteJobs.keys()];
    let idx = 0;
    const worker = async () => {
      while (idx < urls.length) {
        const url = urls[idx++];
        try {
          const bytes = await Promise.race([
            getAdapter().app.fetchImage(url),
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error("timeout")), timeout)
            ),
          ]);
          classifyBytes(url, bytes);
        } catch (e) {
          const msg = String(e);
          failures.set(url, {
            status: msg.includes("timeout") ? "remote-timeout" : "remote-error",
            detail: msg.slice(0, 120),
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(REMOTE_IMG_CONCURRENCY, urls.length) }, worker)
    );
  }

  // 第二遍：按文档顺序产出报告 + 换装。
  const report: ExportImageReportItem[] = [];
  for (const src of orderedSrcs) {
    if (/^data:|^asset:|^blob:/i.test(src)) continue;
    if (/^https?:/i.test(src)) {
      if (remoteMode !== "fetch") {
        report.push({ src, status: "remote-skip" });
        continue;
      }
    }
    const key = keyOf(src);
    if (key === null) {
      // 相对引用但文档未保存：无从解析，必裂图——显式列报而非静默。
      report.push({ src, status: "read-error", detail: "文档未保存，相对路径无法解析" });
      continue;
    }
    const hit = cache.get(key);
    if (hit) report.push({ src, status: "inlined", bytes: hit.bytes });
    else {
      const fail = failures.get(key);
      report.push(fail ? { src, ...fail } : { src, status: "read-error", detail: "未知失败" });
    }
  }

  const replaced =
    cache.size === 0
      ? html
      : html.replace(IMG_SRC_RE, (whole, src: string) => {
          const key = keyOf(src);
          const hit = key ? cache.get(key) : undefined;
          return hit ? whole.replace(`"${src}"`, `"${hit.dataUrl}"`) : whole;
        });
  return { html: replaced, report, missing: missingOf(report) };
}

function missingOf(report: ExportImageReportItem[]): ExportImageReportItem[] {
  return report.filter((r) => r.status !== "inlined" && r.status !== "remote-skip");
}

/**
 * C2 产物内显式占位（EX 轮）：内联失败/超预算/远程失败的 <img> 换成可见的
 * 「图片未包含」占位框——静默裂图（broken icon/空白）不允许；原因取自
 * 内联报告分类。仅用于工厂渲染路径（PDF/PNG）；HTML「保留引用」模式语义
 * 不变（引用是文档化行为）。
 */
export function markMissingImages(
  html: string,
  missing: ExportImageReportItem[]
): string {
  if (missing.length === 0) return html;
  let out = html;
  for (const m of missing) {
    const esc = m.src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`<img\\b[^>]*\\bsrc="${esc}"[^>]*>`, "gi");
    const label = `${shortSrc(m.src)}——${STATUS_LABEL[m.status]}${m.detail ? `：${m.detail}` : ""}`;
    out = out.replace(
      re,
      `<span style="display:block;border:1.5px dashed currentColor;border-radius:6px;padding:18px 14px;margin:8px 0;opacity:.75;text-align:center;font-size:.9em">🖼 图片未包含（${label}）</span>`
    );
  }
  return out;
}

/** C2 列报文案：状态 → 用户可读原因（顺序即展示顺序）。 */
const STATUS_LABEL: Record<ExportImageStatus, string> = {
  inlined: "已内联",
  oversize: "超过 10MB 单图上限",
  "sniff-fail": "格式无法识别",
  budget: "超出内联总预算",
  "read-error": "读取失败",
  "remote-error": "下载失败",
  "remote-timeout": "下载超时（15 秒）",
  "remote-skip": "按设置保留引用",
};

/** 未内联图片清单 → 用户可读多行文案（UI 列报用，最多列 8 项）。 */
export function formatMissingImages(missing: ExportImageReportItem[]): string {
  if (missing.length === 0) return "";
  const lines = missing
    .slice(0, 8)
    .map((m) => `· ${shortSrc(m.src)} —— ${STATUS_LABEL[m.status]}${m.detail ? `：${m.detail}` : ""}`);
  const more = missing.length - Math.min(missing.length, 8);
  return [`以下 ${missing.length} 张图片未包含在导出产物中：`, ...lines, ...(more > 0 ? [`……等共 ${missing.length} 项`] : [])].join("\n");
}

function shortSrc(src: string): string {
  return src.length > 72 ? src.slice(0, 69) + "…" : src;
}

/**
 * 把 HTML 里引用的 LOCAL 图片（相对路径 / 绝对路径，非 http(s) / data:）
 * 读出来替换为 base64 data URL。`docPath` 用于解析相对引用。远程 URL 与
 * 读取失败/超限的图片保留原样。单次遍历 + 预算控制，失败静默降级。
 *
 * @deprecated 兼容包装（EX 轮 Fix-C2 起被 inlineExportImages 取代）——
 * 保留给未迁移调用方与回归测试；新代码一律用带显式报告的版本。
 */
export async function inlineLocalImages(
  html: string,
  docPath?: string | null
): Promise<string> {
  const r = await inlineExportImages(html, docPath, { remote: "skip" });
  return r.html;
}

export interface ExportContext {
  /** Rendered HTML of the document (from Vditor.getHTML()). */
  html: string;
  /** Theme CSS to apply (the active content theme). */
  css: string;
  /** Optional base path to resolve relative image refs for inlining. */
  docPath?: string | null;
}

/** 导出结果（EX 轮 Fix-C2）：落盘路径 + 未进产物的图片清单（C2 列报源）。 */
export interface ExportOutcome {
  /** 用户选择的保存路径（取消 = null）。 */
  path: string | null;
  /** 未内联进产物的图片（空 = 图片全部就位或文档无图）。 */
  missing: ExportImageReportItem[];
}

/** Active theme id（与 collectThemeCss 同源：<html data-theme>）。 */
function currentTheme(): string {
  return document.documentElement.getAttribute("data-theme") ?? "light";
}

/** Wrap rendered HTML + theme CSS into a standalone document string. */
export function wrapHtml(
  html: string,
  css: string,
  title: string,
  theme: string
): string {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
${css}
${EXPORT_PROSE_CSS}
/* export-friendly defaults. 主题变量全部挂在 [data-theme=...] 下，html 不带
   该属性时 var(--bg)/var(--fg) 全部退化到 :root 浅色兜底——任何主题导出都
   变成默认浅色。此处必须回写 data-theme。 */
html { background: var(--bg); } /* 根元素背景传播到画布：打印时整页带主题底色 */
/* HX E-H1：整包收集的应用外壳规则（html/body height:100% + body
   overflow:hidden——无边框窗口语义）会随主题 CSS 进导出文件；body 的
   overflow 传播到视口，浏览器打开后滚动锁死。导出文档是普通流式网页，
   在收集 CSS 之后声明（同特异度层叠后者胜）恢复自然文档语义。 */
html, body { height: auto; overflow: visible; }
body { max-width: 820px; margin: 40px auto; padding: 0 24px; }
mark { background: var(--mark-bg, rgba(255, 213, 79, 0.55)); color: inherit; border-radius: 2px; padding: 0.05em 0.12em; } /* ==高光== */
/* 打印默认丢弃背景色：暗色主题下浅色文字 + 白纸 = 白纸白字。强制按屏幕
   色输出（PDF 走「另存为 PDF」，Chromium/WebView2 遵循 print-color-adjust）。 */
@media print {
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
}
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
 *  V3.6: `options.inlineImages` 把本地图片内联为 base64（单文件分发）。
 *  EX Fix-C2：内联模式下远程图一并抓取，未内联项显式列报。 */
export async function exportHtml(
  ctx: ExportContext,
  suggestedName = "untitled.html",
  options: { inlineImages?: boolean } = {}
): Promise<ExportOutcome> {
  const path = await getAdapter().dialog.pickSaveFile(suggestedName, HTML_FILTER);
  if (!path) return { path: null, missing: [] };
  const title = suggestedName.replace(/\.html?$/i, "");
  // S10：落盘前兜底消毒（raw-HTML 直通漏出时导出文件不再是保护空窗）。
  let html = sanitizeExportHtml(ctx.html);
  let missing: ExportImageReportItem[] = [];
  if (options.inlineImages) {
    // 内联模式：本地 + 远程全抓（单文件分发语义），失败项列报。
    const r = await inlineExportImages(html, ctx.docPath, { remote: "fetch" });
    html = r.html;
    missing = r.missing;
  }
  // v4.6：文档含公式时把 KaTeX woff2 字体内嵌为 base64——导出文件在磁盘上
  // 打开后，CSS 里的字体相对/绝对路径都会失效，公式会退化到回退字体。PDF
  // 走应用内 iframe（字体按应用源解析）无需此步。
  let css = ctx.css;
  if (html.includes("katex")) {
    try {
      const { inlineKatexFonts } = await import("./exportMath");
      css = await inlineKatexFonts(css);
    } catch {
      /* 字体读取失败：保留引用（公式退化到回退字体，导出仍完成） */
    }
  }
  const standalone = wrapHtml(html, css, title, currentTheme());
  await getAdapter().fs.writeTextFile(path, standalone);
  return { path, missing };
}

/**
 * 共享预处理（S10 消毒 + 图片内联强化 + C2 未内联显式占位）：buildPdf 与
 * 调试 A/B（__exportDebug.rasterAb）同源入口，保证 perf 对照与生产路径的
 * 工厂输入逐字节一致。
 */
export async function prepareExportHtml(
  ctx: ExportContext
): Promise<{ html: string; missing: ExportImageReportItem[] }> {
  let html = sanitizeExportHtml(ctx.html);
  let missing: ExportImageReportItem[] = [];
  try {
    const r = await inlineExportImages(html, ctx.docPath, { remote: "fetch" });
    html = r.html;
    missing = r.missing;
  } catch {
    /* 内联整体失败保留原引用（missing 为空——无法判定时不算列报项） */
  }
  return { html: markMissingImages(html, missing), missing };
}

/**
 * 自研 PDF 管线编排（EX 轮）：共享预处理（S10 消毒 + 图片内联强化）→
 * 离屏工厂 → 分页 → 分块光栅 → pdf-lib 组装。返回字节与 meta（不落盘——
 * 落盘由调用方 pickSaveFile 后进行；perf 驱动口经 __exportDebug.exportPdfTo
 * 直写指定路径）。EX-P 原型期 textLayer 开关透传；字体缺位自动纯光栅。
 */
export async function buildPdf(
  ctx: ExportContext,
  o: PdfPipelineOptions = {}
): Promise<{ bytes: Uint8Array; meta: Record<string, unknown>; missing: ExportImageReportItem[] }> {
  const { html, missing } = await prepareExportHtml(ctx);
  const { runPdfPipeline } = await import("./exportPdfPipeline");
  const result = await runPdfPipeline(html, ctx.css, o);
  return {
    bytes: result.bytes,
    meta: result.meta as unknown as Record<string, unknown>,
    missing,
  };
}

/**
 * Export to PDF（EX 轮全量落地：自研管线，printHtml/win.print 退役）。
 * pickSaveFile 先行（唯一系统交互）→ buildPdf（消毒/内联/工厂/分页/光栅/
 * 组装，进度回调 + 可取消）→ 落盘。未内联图片经 ExportOutcome.missing 由
 * 调用方列报（C2）；取消（AbortError）向上抛出。
 */
export async function exportPdf(
  ctx: ExportContext,
  suggestedName = "untitled.pdf",
  o: PdfPipelineOptions = {}
): Promise<ExportOutcome> {
  const path = await getAdapter().dialog.pickSaveFile(suggestedName, PDF_FILTER);
  if (!path) return { path: null, missing: [] };
  const r = await buildPdf(ctx, o);
  await getAdapter().fs.writeFile(path, r.bytes);
  return { path, missing: r.missing };
}

/**
 * PNG 自研管线编排（EX 轮阶段五，RC-6 修复）：共享预处理（S10 消毒 +
 * 图片内联强化）→ 离屏工厂 → 分块光栅 → 纵向拼接。返回字节与 meta。
 */
export async function buildPng(
  ctx: ExportContext,
  o: PngPipelineOptions = {}
): Promise<{
  bytes: Uint8Array;
  meta: Record<string, unknown>;
  missing: ExportImageReportItem[];
}> {
  let html = sanitizeExportHtml(ctx.html);
  let missing: ExportImageReportItem[] = [];
  try {
    const r = await inlineExportImages(html, ctx.docPath, { remote: "fetch" });
    html = r.html;
    missing = r.missing;
  } catch {
    /* 内联整体失败保留原引用 */
  }
  // C2：未内联项显式占位（静默裂图禁止）。
  html = markMissingImages(html, missing);
  const { runPngPipeline } = await import("./exportPngPipeline");
  const result = await runPngPipeline(html, ctx.css, o);
  return {
    bytes: result.bytes,
    meta: result.meta as unknown as Record<string, unknown>,
    missing,
  };
}

/**
 * Export to PNG（EX 轮阶段五：离屏工厂路径——懒渲染占位/未加载图不再
 * 入图；不再依赖预览模式）。
 */
export async function exportPngFromDocument(
  ctx: ExportContext,
  suggestedName = "untitled.png",
  backgroundColor?: string,
  o: PngPipelineOptions = {}
): Promise<ExportOutcome> {
  const path = await getAdapter().dialog.pickSaveFile(suggestedName, PNG_FILTER);
  if (!path) return { path: null, missing: [] };
  const r = await buildPng(ctx, { ...o, backgroundColor });
  await getAdapter().fs.writeFile(path, r.bytes);
  return { path, missing: r.missing };
}

/**
 * Export to PNG by snapshotting a rendered preview element.
 *
 * @param previewEl  a DOM node containing the rendered document
 * @param backgroundColor  page background (defaults to white)
 * @deprecated EX 轮阶段五起被 exportPngFromDocument（离屏工厂路径）取代
 *   ——实时 DOM 截图继承懒渲染状态（RC-6）。保留供回归对照，新代码勿用。
 */
export async function exportPng(
  previewEl: HTMLElement,
  suggestedName = "untitled.png",
  backgroundColor = "#ffffff"
): Promise<string | null> {
  const path = await getAdapter().dialog.pickSaveFile(suggestedName, PNG_FILTER);
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
  await getAdapter().fs.writeFile(path, bytes);
  return path;
}

/**
 * Export to .docx (real OOXML).
 *
 * @turbodocx/html-to-docx signature:
 *   HTMLtoDOCX(htmlString, headerHTML?, documentOptions?, footerHTML?) ->
 *     Promise<ArrayBuffer | Blob | Buffer>
 *
 * DX 修复（2026-10-15）：该库的 browser 构建（exports.browser 条件，webview
 * 实际加载）裸引用 Node 全局 `Buffer`/`global`（1.22.0～1.23.1 上游未修，
 * 库内部打包了完整 buffer 实现却没挂到全局），WebView2 里任何文档都抛
 * ReferenceError——含图档崩在 yM 图片解码（Buffer），纯文本档崩在尾段产物
 * 转换（global）。定罪证据：perf/results/ex-dx-phase1-conviction.md。
 * 输入侧规避：加载库前补最小垫片（ensureBrowserNodeGlobals，仅补缺不覆
 * 盖、幂等、零新依赖）——sidecar/Node 子进程预案（TODO P1）不需要。
 */
/** 垫片 Buffer 的外部面（库与 node 侧依赖的实测调用形态，见定罪报告）。 */
interface ShimBufferCtor {
  new (size: number): Uint8Array;
  from(input: string | Uint8Array | ArrayLike<number>, encoding?: string): Uint8Array;
  isBuffer(x: unknown): boolean;
  byteLength(s: string, encoding?: string): number;
  alloc(size: number, fill?: number): Uint8Array;
  concat(list: Uint8Array[]): Uint8Array;
}

/** Uint8Array 子类（产物可进 zip 流，toArrayBuffer 的 instanceof 检查天然
 * 通过）。from 以 Buffer 语义（str + encoding）遮蔽 Uint8Array.from 的 mapfn
 * 重载——静态签名天然冲突，故 class 内叫 make、挂载时换名（调用形态由
 * exporterDocxBrowserBuild.test.ts 钉住）。 */
const MiniBufferClass = class extends Uint8Array {
  static make(
    input: string | Uint8Array | ArrayLike<number>,
    encoding?: string
  ): Uint8Array {
    if (typeof input === "string") {
      const bytes =
        (encoding ?? "utf-8").toLowerCase() === "base64"
          ? base64ToBytes(input)
          : new TextEncoder().encode(input);
      const out = new MiniBufferClass(bytes.length);
      out.set(bytes);
      return out;
    }
    const out = new MiniBufferClass(input.length);
    out.set(input);
    return out;
  }

  static isBuffer(x: unknown): boolean {
    return x instanceof MiniBufferClass;
  }

  // 静态工具面：库本体不直接用，但 node 侧依赖（如 undici fetch 实现）会
  // 裸调 Buffer.byteLength 等——补齐核心三件，避免垫片环境下的旁路崩溃。
  static byteLength(s: string, encoding?: string): number {
    return MiniBufferClass.make(s, encoding).length;
  }

  static alloc(size: number, fill: number = 0): Uint8Array {
    const b = new MiniBufferClass(size);
    b.fill(fill);
    return b;
  }

  static concat(list: Uint8Array[]): Uint8Array {
    const total = list.reduce((n, x) => n + x.length, 0);
    const out = new MiniBufferClass(total);
    let o = 0;
    for (const x of list) {
      out.set(x, o);
      o += x.length;
    }
    return out;
  }
};

const MiniBuffer: ShimBufferCtor = Object.assign(MiniBufferClass, {
  from: MiniBufferClass.make,
});

/** webview 下补 global 别名与 Buffer 垫片（见 exportDocx 头注）。 */
export function ensureBrowserNodeGlobals(): void {
  const g = globalThis as { global?: unknown; Buffer?: unknown };
  if (g.global === undefined) g.global = globalThis;
  if (g.Buffer === undefined) g.Buffer = MiniBuffer;
}

export async function exportDocx(
  ctx: ExportContext,
  suggestedName = "untitled.docx"
): Promise<ExportOutcome> {
  const path = await getAdapter().dialog.pickSaveFile(suggestedName, DOCX_FILTER);
  if (!path) return { path: null, missing: [] };
  // V3.6：先把本地图片内联成 data URL —— 浏览器构建没有 sharp，相对引用的
  // 图片会被转换器直接丢弃（V3.5 已知问题）。EX Fix-C2：远程图一并抓取，
  // 失败项显式列报（转换器静默丢图的输入侧防线）。
  // S10：进转换器前兜底消毒。
  let html = sanitizeExportHtml(ctx.html);
  let missing: ExportImageReportItem[] = [];
  try {
    const r = await inlineExportImages(html, ctx.docPath, { remote: "fetch" });
    html = r.html;
    missing = r.missing;
  } catch {
    /* 内联失败按旧路径继续 */
  }
  // Inline CSS so heading/list styling survives the html->docx conversion.
  const juice = (await import("juice")).default;
  const inlined = juice.inlineContent(html, ctx.css);
  // DX：browser 构建裸引用 Buffer/global——必须在首次 import 前注入垫片
  //（库顶层与图片解码路径都会读这两个全局，见 exportDocx 头注）。
  ensureBrowserNodeGlobals();
  const htmlToDocx = (await import("@turbodocx/html-to-docx")).default;
  const documentOptions = {
    table: { row: { cantSplit: true } },
    footer: true,
    pageNumber: true,
  };
  const result = await htmlToDocx(inlined, null, documentOptions);
  const bytes = toArrayBuffer(result);
  await getAdapter().fs.writeFile(path, new Uint8Array(bytes));
  return { path, missing };
}

/**
 * Export to .tex（模块 3，纯前端 md→tex，铁律 2：不调 pandoc）。
 *
 * 输入是 Markdown 源码（非编辑器 HTML）——公式源天然平移、[@key] → \cite、
 * 图表编号交给 LaTeX 计数器（\caption/\label/\ref）、References 标题处生成
 * thebibliography。产物面向 XeLaTeX + ctexart（含中文），见
 * lib/exportLatex.ts 头注。返回导出路径或 null（用户取消）。
 */
export async function exportLatexFile(
  markdown: string,
  suggestedName = "untitled.tex",
  docTitle?: string
): Promise<string | null> {
  const path = await getAdapter().dialog.pickSaveFile(suggestedName, TEX_FILTER);
  if (!path) return null;
  const { markdownToLatex } = await import("./exportLatex");
  const { tex, warnings } = markdownToLatex(markdown, docTitle);
  if (warnings.length > 0) console.warn("[mditor] LaTeX 导出告警：", warnings.join("；"));
  await getAdapter().fs.writeTextFile(path, tex);
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
