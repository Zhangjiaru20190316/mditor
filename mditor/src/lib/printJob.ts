// 应用内打印（PI2，重构自 PR 轮 printNote.ts）：一个入口覆盖四种标签
// （md/html/pdf/docx），全程应用内完成——自研打印对话框（PrintDialog.tsx）
// + 自研 PDF 管线排版（buildPdf）+ Rust GDI 直打（src-tauri/src/printing.rs）。
//
// 五条铁律（printIronRule.test.ts / printJob.test.ts 锚定）：
//  1. 全仓零 webview 打印调用：不调用 webview 的 print（wry#707 + RC-4 的
//     历史根因，见 docs/export-overhaul-report.md）；打印执行经自研 GDI
//     引擎，不再生成「交系统浏览器自动弹打印框」的 HTML——PR 轮的
//     PRINT_AUTO_SCRIPT / wrapPrintHtml / injectPrintAssets 全部退役。
//  2. 临时文件不污染用户可见目录：只写 appDataDir()/print/（job-*/ 逐页
//     PNG，打印结束即删）；绝不写文档目录/工作区——SYNCABLE_EXTS
//     （lib/sync/ignore.ts）会把工作区打印副本当笔记同步，这是红线。
//     启动时 best-effort 清理 48h 前旧件（含遗留 job 目录）。
//  3. 原件神圣：打印链只读。md 走 App 侧 buildExportContext（与导出同序）、
//     html 走 readTextFile、pdf 走 readDocNoteBytes 副本（缓存本体不可被
//     detach）、docx 走 mammoth + arrayBuffer slice 副本纪律。
//  4. 打印执行完全应用内：不经系统浏览器/PDF 阅读器/print verb/文件关联；
//     打印机交互只有 list_printers / print_png_job / print_job_cancel 三
//     自定义命令（GDI 直打，位图 300 DPI 文字质量与矢量无肉眼差异）。
//  5. 失败显式：渲染/写盘/打印机错误原样抛错（调用方 toast，不静默吞掉）；
//     远程图抓取失败沿用导出链显式列报（formatMissingImages）。

import { getAdapter } from "../platform";
import type { TabItem } from "../types";
import { joinAbs } from "./path-shim";
import { cleanLocalRef, normalizeLocalPath } from "./imageManager";
import { sniffImageMime } from "./imageSniff";
import { collectThemeCss } from "./themeCss";
import { readDocNoteBytes, loadMammoth } from "./docNote";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  buildPdf,
  bytesToDataUrl,
  type ExportContext,
  type ExportImageReportItem,
} from "./exporter";
import type {
  PdfExportProgress,
  PdfPaperId,
  PdfPipelineOptions,
} from "./exportPdfPipeline";

// ---- 值域（单一事实源，对话框与测试都取自此）------------------------------------

/** 标签 kind（TabItem.kind 缺省 = md，对齐 noteKind 惯例）。 */
export type PrintKind = NonNullable<TabItem["kind"]>;

export const PRINT_ORIENTATIONS = ["portrait", "landscape"] as const;
export type PrintOrientation = (typeof PRINT_ORIENTATIONS)[number];

/** 打印质量档（渲染 DPI；Rust 侧 StretchDIBits 再缩放到打印机实际 DPI）。 */
export const PRINT_DPI_CHOICES = [
  { id: "standard", dpi: 150, label: "标准（150 DPI）" },
  { id: "high", dpi: 300, label: "高（300 DPI）" },
] as const;
export type PrintDpiId = (typeof PRINT_DPI_CHOICES)[number]["id"];

export function printDpiOf(id: PrintDpiId): number {
  return PRINT_DPI_CHOICES.find((c) => c.id === id)?.dpi ?? 300;
}

/**
 * 页面范围解析（纯函数）：「1-3,5」→ [1,2,3,5]。
 * 容忍中文逗号/分号/空白分隔与 – ~ 连字符；去重升序；越界/格式错 → ok:false
 * 带中文原因（对话框直接展示）。空输入 = 未填写（ok:false，调用方「全部」
 * 是独立选项）。
 */
export type PageRangeResult =
  | { ok: true; pages: number[] }
  | { ok: false; error: string };

export function parsePageRange(input: string, total: number): PageRangeResult {
  const s = input.trim();
  if (!s) return { ok: false, error: "未输入页码" };
  if (total <= 0) return { ok: false, error: "文档没有可打印页" };
  const parts = s.split(/[,，;；\s]+/).filter(Boolean);
  const set = new Set<number>();
  for (const part of parts) {
    const m = /^(\d+)(?:\s*[-–~]\s*(\d+))?$/.exec(part);
    if (!m) return { ok: false, error: `无法识别的页码：「${part}」` };
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a) return { ok: false, error: `页码范围无效：「${part}」` };
    if (b > total) return { ok: false, error: `页码超出范围（共 ${total} 页）：「${part}」` };
    for (let i = a; i <= b; i++) set.add(i);
  }
  return { ok: true, pages: [...set].sort((x, y) => x - y) };
}

// ---- 临时目录生命周期（铁律 2）---------------------------------------------------

/** 打印临时目录名（appDataDir() 下）。 */
export const PRINT_DIR = "print";
/** 旧打印件保留时长（启动清理阈值）。 */
export const PRINT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** 文档基名 → 临时文件名安全段（Windows 非法字符清洗 + 尾部点/空格剥除，
 *  对齐导出 suggestedName 惯例；空串兜底 "note"）。控制字符经码点过滤清除
 *  （no-control-regex 规约：控制字符范围不进正则字面量）。 */
export function sanitizePrintStem(name: string): string {
  const noCtrl = [...name]
    .filter((ch) => (ch.codePointAt(0) ?? 0) >= 0x20)
    .join("");
  const s = noCtrl
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[.\s]+$/, "")
    .trim()
    .slice(0, 60);
  return s || "note";
}

/** yyyyMMdd-HHmmss 时间戳段。 */
export function printTimestamp(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 打印作业子目录名：`job-<清洗基名>-<时间戳>`。 */
export function jobDirName(stem: string, d: Date = new Date()): string {
  return `job-${sanitizePrintStem(stem)}-${printTimestamp(d)}`;
}

/** 打印临时目录（首用 mkdir 递归建；$APPDATA scope 内全合法）。 */
export async function ensurePrintDir(): Promise<string> {
  const dir = joinAbs(await getAdapter().app.appDataDir(), PRINT_DIR);
  await getAdapter().fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 打印作业目录（print/ 下以 job- 为前缀；页 PNG 落此处，作业结束整目录删除）。 */
export async function ensureJobDir(stem: string): Promise<string> {
  const dir = joinAbs(await ensurePrintDir(), jobDirName(stem));
  await getAdapter().fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 启动清理（App 一次性 useEffect 调用）：best-effort 删除 48h 前的打印
 * 临时件（含 PR 轮遗留 .html/.pdf 与本轮以 job- 为前缀的作业目录）。
 * 目录不存在/读取失败仅 console.warn（不阻断启动，不重试）。
 */
export async function cleanupOldPrintFiles(
  opts: { now?: number; maxAgeMs?: number } = {}
): Promise<void> {
  try {
    const adapter = getAdapter();
    const dir = joinAbs(await adapter.app.appDataDir(), PRINT_DIR);
    const entries = await adapter.fs.readDir(dir);
    const now = opts.now ?? Date.now();
    const maxAge = opts.maxAgeMs ?? PRINT_MAX_AGE_MS;
    for (const e of entries) {
      try {
        const p = joinAbs(dir, e.name);
        const st = await adapter.fs.stat(p);
        const t = st.mtime?.getTime() ?? 0;
        if (t > 0 && now - t > maxAge) {
          await adapter.fs.remove(p, { recursive: true });
        }
      } catch {
        /* 单项失败不阻断其余清理 */
      }
    }
  } catch (e) {
    console.warn("[mditor] 打印临时件清理跳过（目录不存在或读取失败）：", e);
  }
}

// ---- html 内容源（应用内重排版：提取正文+样式，交 PDF 管线）----------------------

const HTML_ENTITY_RE = /&(amp|lt|gt|quot|#39);/g;
/** 不参与本地路径解析的引用形态（远程/内联/应用内协议；file:// 由
 *  cleanLocalRef 剥前缀后按本地路径处理）。 */
const SKIP_URL_RE = /^(data:|asset:|blob:|https?:)/i;
const BODY_RE = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i;
const STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
const LINK_RE = /<link\b[^>]*>/gi;
const ATTR_RE = (name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

function decodeEntities(s: string): string {
  return s.replace(
    HTML_ENTITY_RE,
    (_, e: string) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e] as string
  );
}

/** link 标签 → 属性值（无该属性/无引号形态均兜底为 null）。 */
function attrOfTag(tag: string, name: string): string | null {
  const m = ATTR_RE(name).exec(tag);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? "");
}

/** css url() 本地资源内联上限（字节）：超限保留原引用并计入 failed。 */
const CSS_ASSET_MAX_BYTES = 8 * 1024 * 1024;

/** 扩展名 → MIME（魔数嗅探不出时的兜底：url() 还可能是字体/svg）。 */
const EXT_MIME: Record<string, string> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  svg: "image/svg+xml",
};

function extMimeOf(absPath: string): string | null {
  const ext = absPath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? null;
}

export interface InlineCssResult {
  css: string;
  /** 读取失败/超限未内联的本地 url() 数（保真度边界列报）。 */
  failed: number;
}

/**
 * css 文本内本地 url()（背景图/字体）→ base64 data: 内联（纯函数面直测，
 * fs 经 platform adapter 注入现实实现）。此前生成的 file:/// URL 在离屏
 * 工厂 iframe 会被 CSP（img-src/font-src 无 file:）静默拦截——本地背景图
 * 全体丢失；改为 fs 读取 + data: 内联后与 <img> 的 inlineExportImages 同
 * 语义（自包含、不受 CSP/asset scope 限制）。远程/data: 引用原样保留；
 * 读取失败或超限保留原引用并计数（铁律 5）。cssPath 为该 css 文件自身
 * 路径（相对 url() 按其目录解析）。
 */
export async function inlineCssUrls(
  css: string,
  cssPath: string | null | undefined
): Promise<InlineCssResult> {
  if (!cssPath) return { css, failed: 0 };
  const dir = cssPath.replace(/[\\/][^\\/]+$/, "");
  const fs = getAdapter().fs;
  const cache = new Map<string, string | null>(); // 原始引用 → data: | null（失败）
  let failed = 0;
  const parts: string[] = [];
  let last = 0;
  // 每次调用建局部正则（导出链 exportPdfPipeline 同款 matchAll 快照语义）：
  // 共享 g 正则 + 循环内 await 会互踩 lastIndex——当前调用序列虽串行，这是
  // 给未来并发调用者埋的雷。
  const urlRe = new RegExp(CSS_URL_RE.source, "gi");
  for (let m = urlRe.exec(css); m; m = urlRe.exec(css)) {
    parts.push(css.slice(last, m.index));
    last = m.index + m[0].length;
    const whole = m[0];
    const raw = m[2];
    if (SKIP_URL_RE.test(raw.trim())) {
      parts.push(whole);
      continue;
    }
    let dataUrl = cache.get(raw);
    if (dataUrl === undefined) {
      const abs = localHrefToAbs(raw, dir);
      dataUrl = null;
      if (abs) {
        try {
          const bytes = await fs.readFile(abs);
          if (bytes.byteLength <= CSS_ASSET_MAX_BYTES) {
            const mime =
              sniffImageMime(bytes) ?? extMimeOf(abs) ?? "application/octet-stream";
            dataUrl = bytesToDataUrl(bytes, mime);
          }
        } catch {
          /* 读取失败：保留原引用（failed 计数） */
        }
      }
      cache.set(raw, dataUrl);
    }
    if (dataUrl) parts.push(`url("${dataUrl}")`);
    else {
      failed++;
      parts.push(whole);
    }
  }
  parts.push(css.slice(last));
  return { css: parts.join(""), failed };
}

/** html 文档 → 打印部件（纯函数，vitest 直测）。
 *  残缺文档（无 <body>）全文当正文，不报错。 */
export interface HtmlPrintParts {
  /** body 内文，<style> 已剥除（样式统一走 css 通道，防重复）。 */
  bodyHtml: string;
  /** 全文档内联 <style> 内容（含 head 与 body 内的）。 */
  inlineCss: string;
  /** 本地 <link rel=stylesheet> 的 href（相对/绝对路径，待逐个读取）。 */
  localCssHrefs: string[];
  /** 远程样式表数（http(s) 跳过——应用内打印的保真度边界，列报用）。 */
  remoteStyles: number;
}

export function extractHtmlPrintParts(fullHtml: string): HtmlPrintParts {
  const bodyMatch = BODY_RE.exec(fullHtml);
  const bodyInner = bodyMatch ? bodyMatch[1] : fullHtml;
  const styles: string[] = [];
  let m: RegExpExecArray | null;
  STYLE_RE.lastIndex = 0;
  while ((m = STYLE_RE.exec(fullHtml))) styles.push(m[1]);
  const bodyHtml = bodyInner.replace(STYLE_RE, "");
  const localCssHrefs: string[] = [];
  let remoteStyles = 0;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(fullHtml))) {
    const rel = (attrOfTag(m[0], "rel") ?? "").toLowerCase();
    if (!rel.includes("stylesheet")) continue;
    const href = attrOfTag(m[0], "href");
    if (!href) continue;
    if (/^(data:|https?:)/i.test(href)) {
      remoteStyles++;
      continue;
    }
    localCssHrefs.push(href);
  }
  return { bodyHtml, inlineCss: styles.join("\n"), localCssHrefs, remoteStyles };
}

/** href → 本地绝对路径（供 fs 读取；非本地形态返回 null）。 */
export function localHrefToAbs(href: string, dir: string): string | null {
  const src = decodeEntities(href.trim());
  if (!src || SKIP_URL_RE.test(src)) return null;
  const cleaned = cleanLocalRef(src);
  if (!cleaned) return null;
  const isAbs = /^([A-Za-z]:[\\/]|[\\/])/.test(cleaned);
  return isAbs ? normalizeLocalPath(cleaned) : normalizeLocalPath(`${dir}/${cleaned}`);
}

export interface HtmlPrintContext extends ExportContext {
  /** 远程样式表跳过数（保真度边界提示用）。 */
  skippedRemoteStyles: number;
  /** CSS 本地资源（背景图/字体）读取失败/超限未内联数（列报用）。 */
  skippedCssAssets: number;
}

/**
 * html 笔记 → 打印用 ExportContext：提取 body + 收集样式（内联 style + 本地
 * link css 读取；url() 本地资源 fs 读取后 data: 内联），交 PDF 管线按
 * mditor 版心重排。保真度边界：远程样式表跳过、页面宽度驱动的布局会重排
 * （PI2 决策：统一应用内打印，不再借道系统浏览器）。图片（含相对引用）由
 * prepareExportHtml 的 inlineExportImages 按 docPath 解析内联——与 md 同
 * 语义；CSS url() 由 inlineCssUrls 内联（与 <img> 通道对齐，data: 自包含）。
 */
export async function buildHtmlPrintContext(path: string): Promise<HtmlPrintContext> {
  const fs = getAdapter().fs;
  const full = await fs.readTextFile(path);
  const parts = extractHtmlPrintParts(full);
  const docDir = path.replace(/[\\/][^\\/]+$/, "");
  const cssParts: string[] = [];
  let skippedCssAssets = 0;
  if (parts.inlineCss) {
    const r = await inlineCssUrls(parts.inlineCss, path);
    cssParts.push(r.css);
    skippedCssAssets += r.failed;
  }
  for (const href of parts.localCssHrefs) {
    const abs = localHrefToAbs(href, docDir);
    if (!abs) continue;
    try {
      // css 内相对 url() 按 css 文件自身目录解析（严格于按文档目录）。
      const text = await fs.readTextFile(abs);
      const r = await inlineCssUrls(text, abs);
      cssParts.push(r.css);
      skippedCssAssets += r.failed;
    } catch {
      /* 单个样式文件读取失败：跳过（残缺样式优于中断打印） */
    }
  }
  return {
    html: parts.bodyHtml,
    css: cssParts.join("\n"),
    docPath: path,
    skippedRemoteStyles: parts.remoteStyles,
    skippedCssAssets,
  };
}

// ---- docx / pdf 内容源（铁律 3：只读 + 副本纪律）--------------------------------

/**
 * docx → 打印用 ExportContext：mammoth 语义 HTML（图片 data URL 内联，与
 * DE 轮编辑面同形态）+ 主题 CSS（版式按 mditor 样式，非 Word 原版式——保真
 * 边界与 DE 轮编辑态一致，原版式引导用户在 Word 中打印原文件）。
 */
export async function buildDocxPrintContext(path: string): Promise<ExportContext> {
  const bytes = await readDocNoteBytes(path);
  const mammoth = await loadMammoth();
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const res = await mammoth.convertToHtml({ arrayBuffer: ab });
  return { html: res.value, css: collectThemeCss(), docPath: path };
}

/** pdf 原文件直打源：readDocNoteBytes 的**副本**（缓存本体不可被 detach；
 *  消费方 pdfjs getDocument 还会再 transfer，各自持有独立副本）。 */
export async function readPdfPrintBytes(path: string): Promise<Uint8Array> {
  const bytes = await readDocNoteBytes(path);
  return bytes.slice();
}

// ---- 打印 PDF 构建（排版 = 自研管线；pdf kind 原文件即成品）----------------------

export type PrintSource =
  | { kind: "md" | "docx" | "html"; ctx: ExportContext }
  | { kind: "pdf"; bytes: Uint8Array };

export interface BuildPrintPdfOptions {
  paper: PdfPaperId;
  orientation: PrintOrientation;
  marginMm: number;
  rasterScale?: number;
  mode?: PdfPipelineOptions["mode"];
  title?: string;
  signal?: AbortSignal;
  onProgress?: (p: PdfExportProgress) => void;
}

export interface PrintPdfArtifact {
  bytes: Uint8Array;
  /** 未内联进产物的图片（C2 列报源，对话框复用 formatMissingImages）。 */
  missing: ExportImageReportItem[];
  meta?: Record<string, unknown>;
}

/** 打印排版（单一入口）：md/docx/html 走 buildPdf（与「导出 PDF」同一管线，
 *  增量仅 orientation）；pdf 原样返回（零转码零损耗）。 */
export async function buildPrintPdfBytes(
  source: PrintSource,
  o: BuildPrintPdfOptions
): Promise<PrintPdfArtifact> {
  if (source.kind === "pdf") return { bytes: source.bytes, missing: [] };
  const r = await buildPdf(source.ctx, {
    paper: o.paper,
    orientation: o.orientation,
    marginMm: o.marginMm,
    rasterScale: o.rasterScale,
    mode: o.mode,
    signal: o.signal,
    onProgress: o.onProgress,
    title: o.title,
  });
  return {
    bytes: r.bytes,
    missing: r.missing,
    meta: r.meta as unknown as Record<string, unknown>,
  };
}

// ---- 打印机交互与作业执行（Rust printing.rs 三命令的 TS 面）----------------------

export interface PrinterInfoDto {
  name: string;
  isDefault: boolean;
}

/** Rust 作业事件（printing.rs PrintJobEvent 的 camelCase 序列化形态）。 */
export interface PrintJobEventDto {
  job: string;
  kind: "started" | "page" | "done" | "failed" | "cancelled";
  page: number;
  total: number;
  message: string;
}

export const PRINT_JOB_EVENT = "print-job-progress";

/** 枚举本机打印机（本地 + 网络连接，默认打印机带标记）。 */
export async function listPrinters(): Promise<PrinterInfoDto[]> {
  return getAdapter().app.invoke<PrinterInfoDto[]>("list_printers");
}

/** 请求取消作业（页边界生效；已出页不撤回）。 */
export async function cancelPrintJob(jobId: string): Promise<void> {
  await getAdapter().app.invoke<boolean>("print_job_cancel", { jobId });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("打印已取消", "AbortError");
}

/** 取消转发后终态事件的等待上限（毫秒）：网络打印机离线时 GDI 调用可长
 *  时间阻塞、终态事件迟迟不来（或事件层丢失），无兜底则前端永卡 printing
 *  且「取消打印」看似无效。超限按已取消收场（旗标已置，Rust 侧页边界真正
 *  停止）。非取消路径不设超时——慢打印机的正常作业不能被误判。 */
const CANCEL_SETTLE_TIMEOUT_MS = 15_000;

/**
 * 单页 → PNG（pdf.js 按 dpi 光栅化；调用方逐页调用、逐页落盘，内存峰值 =
 * 单页位图——超大文档 795 页档位依然可控，对齐管线分块治理思路）。
 * canvas 用毕即清零释放。
 */
export async function renderPageToPng(
  doc: PDFDocumentProxy,
  pageNum: number,
  dpi: number
): Promise<Uint8Array> {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    canvas.width = 0;
    canvas.height = 0;
    throw new Error(`打印页 ${pageNum} 无法创建画布`);
  }
  try {
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, "image/png")
    );
    if (!blob) throw new Error(`打印页 ${pageNum} PNG 编码失败`);
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    canvas.width = 0; // 释放位图（下一页/失败路径都不驻留）
    canvas.height = 0;
  }
}

export interface RunPrintJobOptions {
  jobId: string;
  /** 预览共用同一 pdfjs 文档实例（所见即所打）。 */
  doc: PDFDocumentProxy;
  /** 1-based 页号（已应用页面范围）。 */
  pages: number[];
  printer: string;
  copies: number;
  dpi: number;
  /** 纸张 id（md/docx/html 排版纸）；null = 不设置（pdf 原文件直打按页 fit）。 */
  paper: string | null;
  /** 作业目录基名（文档名；内部过 sanitizePrintStem）。 */
  stem: string;
  signal?: AbortSignal;
  /** 光栅化+落盘进度（done/total 只计渲染阶段）。 */
  onRenderProgress?: (done: number, total: number) => void;
  /** Rust 侧打印进度（GDI 逐页；全局序含份数展开）。 */
  onPrintEvent?: (page: number, total: number) => void;
}

export interface PrintJobOutcome {
  outcome: "done" | "cancelled";
  total: number;
}

/**
 * 执行打印作业（编排单一事实源）：job 目录逐页渲染 PNG → invoke Rust GDI
 * 直打 → 等待终态事件（先注册监听再启动，零竞态）→ 无论成败删除 job 目录
 * （铁律 2）。取消语义：渲染阶段直接中止；打印阶段转发 cancel 命令，等待
 * cancelled 事件收场（页边界生效）。
 *
 * 取舍说明：当前编排是「全部页渲染落盘后才启动打印」——磁盘峰值 = N 页
 * PNG（300 DPI A4 约 1–5MB/页）、首张出纸延后整个渲染时长。换来的是作业
 * 原子性（Rust 侧逐页读文件，中途零依赖前端）与内存峰值恒为单页位图。
 * 若未来要做「渲染 k 页即启动」的流水线（或按 16–32 页分批多作业），改
 * 这里与 printing.rs 的页清单接口即可，铁律 2 的目录生命周期不变。
 */
export async function runPrintJob(o: RunPrintJobOptions): Promise<PrintJobOutcome> {
  const adapter = getAdapter();
  // 目录名以 jobId 打头（print-<ms>-<seq> 全局唯一）：jobId 在 sanitize 的
  // 60 字符截断后必然存活——多窗口同一秒对同名文档开打不再共用目录（页
  // PNG 互相覆盖 + 先结束方整目录删除把对方的页抽走）。
  const dir = await ensureJobDir(`${o.jobId}-${o.stem}`);
  const files: string[] = [];
  try {
    let rendered = 0;
    for (const p of o.pages) {
      throwIfAborted(o.signal);
      const png = await renderPageToPng(o.doc, p, o.dpi);
      const f = joinAbs(dir, `page-${String(p).padStart(3, "0")}.png`);
      await adapter.fs.writeFile(f, png);
      files.push(f);
      o.onRenderProgress?.(++rendered, o.pages.length);
    }
    throwIfAborted(o.signal);
    if (files.length === 0) throw new Error("打印作业没有页面");

    // 先注册事件监听再启动作业（否则快速作业的终态事件可能在注册前发出）。
    let resolveDone: (r: PrintJobOutcome) => void = () => undefined;
    let rejectDone: (e: unknown) => void = () => undefined;
    const settled = new Promise<PrintJobOutcome>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });
    const onAbort = (): void => {
      void cancelPrintJob(o.jobId);
    };
    const unlisten = await adapter.app.listen<PrintJobEventDto>(
      PRINT_JOB_EVENT,
      (ev) => {
        const e = ev.payload;
        if (!e || e.job !== o.jobId) return;
        if (e.kind === "page") o.onPrintEvent?.(e.page, e.total);
        else if (e.kind === "done") resolveDone({ outcome: "done", total: e.total });
        else if (e.kind === "cancelled") resolveDone({ outcome: "cancelled", total: e.total });
        else if (e.kind === "failed") rejectDone(new Error(e.message || "打印失败"));
      }
    );
    try {
      o.signal?.addEventListener("abort", onAbort, { once: true });
      await adapter.app.invoke("print_png_job", {
        jobId: o.jobId,
        printer: o.printer,
        copies: o.copies,
        paper: o.paper ?? null,
        pages: files,
      });
      // invoke 窗口期取消竞态：取消若在 Rust 侧注册旗标前到达会落空（作业
      // 照跑并最终误报 done）——invoke 返回后 signal 已中止则补发一次取消
      // 再等终态（cancelled 事件），由其收场。
      if (o.signal?.aborted) await cancelPrintJob(o.jobId).catch(() => undefined);
      // 取消路径设超时兜底（见 CANCEL_SETTLE_TIMEOUT_MS 注）；已显式取消的
      // 作业即使终态事件先到 done 也不报成功（用户刚按下取消却弹「已发送
      // 到打印队列」是反向反馈）。
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const out = o.signal?.aborted
          ? await Promise.race([
              settled,
              new Promise<PrintJobOutcome>((res) => {
                settleTimer = setTimeout(
                  () => res({ outcome: "cancelled", total: 0 }),
                  CANCEL_SETTLE_TIMEOUT_MS
                );
              }),
            ])
          : await settled;
        if (o.signal?.aborted && out.outcome === "done") {
          return { outcome: "cancelled", total: out.total };
        }
        return out;
      } finally {
        if (settleTimer !== undefined) clearTimeout(settleTimer);
      }
    } finally {
      o.signal?.removeEventListener("abort", onAbort);
      unlisten();
    }
  } finally {
    await adapter.fs.remove(dir, { recursive: true }).catch(() => undefined);
  }
}
