// 多格式笔记（MF 轮，阶段 1）：PDF / Word(.docx) 的扩展名与 TabItem 纯函数。
// 架构母版 = HN 轮（src/lib/htmlNote.ts + docs/html-note-spike-report.md）：
//   * 只读视图对象：dirty 恒 false、content 恒空，不进编辑器/useFile/docCache/
//     批注/双链/闪卡/RAG 全套（App 按 kind 分发到 PdfNoteView/DocxNoteView）；
//   * 与 HTML 笔记的渲染差异：PDF/Word 是受控解析（pdfjs / docx-preview），
//     不执行文档内脚本，不经 asset 协议 iframe；
//   * .doc（Word 97-2003 老格式）明确不支持——前端无成熟解析器，不进
//     扩展名集合（文件树不显示、对话框不可选），引导用户先转存 .docx。
// 副作用面（读字节 / 转 MD 落盘）只放本模块（M3 落地 convert*）；其余全部
// 纯函数可 vitest。

import { getAdapter } from "../platform";
import { basename, dirname, extname, join, toPosix } from "./path-shim";
import { conflictFreeName } from "./htmlNote";
import type { TabItem } from "../types";

/** PDF 笔记扩展名集合（与 htmlNote.HTML_EXTS 平行的单一来源）。 */
export const PDF_EXTS = new Set([".pdf"]);

/** Word 笔记扩展名集合——只含 .docx。.doc（97-2003 老格式）前端解析不可行，
 *  明确不支持：不进集合即不进文件树/对话框/同步白名单，UI 层面自然引导
 *  用户先在系统应用里转存 .docx。 */
export const DOCX_EXTS = new Set([".docx"]);

/** 多格式笔记扩展名并集（PDF ∪ Word）。 */
export const DOC_NOTE_EXTS: ReadonlySet<string> = new Set([
  ...PDF_EXTS,
  ...DOCX_EXTS,
]);

/** 文件名/路径是否为 PDF 笔记（大小写不敏感）。 */
export function isPdfNote(name: string): boolean {
  return PDF_EXTS.has(extname(name).toLowerCase());
}

/** 文件名/路径是否为 Word(.docx) 笔记（大小写不敏感）。 */
export function isDocxNote(name: string): boolean {
  return DOCX_EXTS.has(extname(name).toLowerCase());
}

/** 文件名/路径是否为多格式笔记（pdf 或 docx）。 */
export function isDocNote(name: string): boolean {
  return isPdfNote(name) || isDocxNote(name);
}

/** 拖拽/CLI 入口的路径判定（与 MD_EXT_RE 平行的正则形态）。不含 .doc。 */
export const DOC_NOTE_RE = /\.(pdf|docx)$/i;

/** pdf 标签判别（TabItem.kind）。 */
export function isPdfTab(tab: TabItem | null | undefined): boolean {
  return tab?.kind === "pdf";
}

/** docx 标签判别（TabItem.kind）。 */
export function isDocxTab(tab: TabItem | null | undefined): boolean {
  return tab?.kind === "docx";
}

/** 多格式标签判别（pdf 或 docx；只读视图对象）。 */
export function isDocTab(tab: TabItem | null | undefined): boolean {
  return isPdfTab(tab) || isDocxTab(tab);
}

/** 多格式标签的稳定 key：按扩展名取 "pdf-"/"docx-" 前缀 + 路径归一小写
 *  （Windows 大小写不敏感，对齐 htmlTabKey / tabPathKey）。前缀区分格式，
 *  同一路径的 tab key 与 html/md 标签永不碰撞。 */
export function docTabKey(path: string): string {
  const p = toPosix(path).toLowerCase();
  return isDocxNote(p) ? `docx-${p}` : `pdf-${p}`;
}

/** 由磁盘路径构造 pdf 标签（dirty 恒 false、content 恒空——只读视图对象）。 */
export function makePdfTab(path: string): TabItem {
  return {
    key: docTabKey(path),
    path,
    name: basename(path),
    dirty: false,
    content: "",
    kind: "pdf",
  };
}

/** 由磁盘路径构造 docx 标签（只读语义同 makePdfTab）。 */
export function makeDocxTab(path: string): TabItem {
  return {
    key: docTabKey(path),
    path,
    name: basename(path),
    dirty: false,
    content: "",
    kind: "docx",
  };
}

// ---- 字节缓存（视图首读 + 转 MD 复用共享）-----------------------------------

/** 模块级单条字节缓存：当前打开的 pdf/docx 原始字节（fs.readFile 二进制
 *  通道）。pdfjs 渲染与转 MD 管线共用同一份字节，避免大文件二次读取；
 *  路径切换/重载即失效。注意：消费方（pdfjs getDocument 会 transfer
 *  ArrayBuffer）必须传副本，缓存本体不可被 detach。 */
let docBytesCache: { path: string; bytes: Uint8Array } | null = null;

/** 读取多格式笔记字节（单条缓存）。force = 重载时绕过缓存并刷新条目。 */
export async function readDocNoteBytes(path: string, force = false): Promise<Uint8Array> {
  if (!force && docBytesCache?.path === path) return docBytesCache.bytes;
  const bytes = await getAdapter().fs.readFile(path);
  docBytesCache = { path, bytes };
  return bytes;
}

/** 使字节缓存失效（文件被删除/外部修改后重开前调用）。 */
export function invalidateDocNoteBytes(path: string): void {
  if (docBytesCache?.path === path) docBytesCache = null;
}

// ---- DE 轮 M3：微编辑行（命中层数据源，纯函数）--------------------------------

/** 微编辑行：piecesToLines 的可点击形态（用户空间几何 + 稳定行键）。 */
export interface PdfEditLine {
  page: number;
  key: string;
  text: string;
  x0: number;
  y: number;
  width: number;
  height: number;
}

/** 单页 pieces（可选带 rotated 标记——原 transform b/c 分量非零的旋转 run）
 *  → 可编辑行序列。旋转 run 被过滤：patch 模型只承载水平行（任务书 §4.2
 *  拒绝场景，静默跳过不崩溃）。空行剔除。 */
export function piecesToEditLines(
  page: number,
  pieces: Array<PdfTextPiece & { rotated?: boolean }>
): PdfEditLine[] {
  const lines = piecesToLines(
    pieces.filter((p) => !p.rotated && p.str.trim().length > 0)
  );
  return lines
    .filter((l) => l.text.length > 0)
    .map((l) => ({
      page,
      key: pdfLineKey(page, l.y, l.x0),
      text: l.text,
      x0: l.x0,
      y: l.y,
      width: l.width,
      height: l.height,
    }));
}

// ---- 转 Markdown：PDF 文本重建启发式（纯函数）--------------------------------

/** pdfjs TextItem 的结构子集（getTextContent 逐 piece 映射后的输入）。 */
export interface PdfTextPiece {
  str: string;
  /** 基点 x（transform[4]）。 */
  x: number;
  /** 基线 y（transform[5]，PDF 用户空间 y 向上）。 */
  y: number;
  width: number;
  /** 字号近似（piece 高度）——分行容差与行距聚类都按它缩放。 */
  height: number;
}

/** 行内两 piece 间距超过该值（pt）补一个空格（CJK 邻接不补）。 */
const PIECE_SPACE_GAP = 1.0;
/** 行距超过字号该倍数视为段落分隔。 */
const PARAGRAPH_GAP_RATIO = 1.9;

/** CJK/全角邻接判定（中日韩、CJK 标点、全角符号）。 */
function isCjkChar(ch: string | undefined): boolean {
  if (!ch) return false;
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0x3000 && c <= 0x303f) ||
    (c >= 0xff00 && c <= 0xffef)
  );
}

interface PdfLine {
  y: number;
  text: string;
  height: number;
  /** 行左缘 x（用户空间；DE 轮 M3 命中层/patch bbox 用）。 */
  x0: number;
  /** 行宽（用户空间；x1 = x0 + width）。 */
  width: number;
}

/** 单页 pieces → 行序列：按 y 降序（视觉自上而下）容差聚类，行内按 x 排序
 *  拼串（间距超阈值补空格）。 */
function piecesToLines(pieces: PdfTextPiece[]): PdfLine[] {
  const lines: PdfLine[] = [];
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);
  let cur: PdfTextPiece[] = [];
  let curY = Number.NaN;
  const flush = () => {
    if (cur.length === 0) return;
    cur.sort((a, b) => a.x - b.x);
    let text = "";
    let prevEnd = Number.NEGATIVE_INFINITY;
    for (const p of cur) {
      const s = p.str;
      if (!s) continue;
      if (
        text &&
        p.x - prevEnd > PIECE_SPACE_GAP &&
        !/\s$/.test(text) &&
        !/^\s/.test(s) &&
        !isCjkChar(text[text.length - 1]) &&
        !isCjkChar(s[0])
      ) {
        text += " ";
      }
      text += s;
      prevEnd = p.x + p.width;
    }
    const x0 = cur.reduce((m, p) => Math.min(m, p.x), Number.POSITIVE_INFINITY);
    const x1 = cur.reduce((m, p) => Math.max(m, p.x + p.width), Number.NEGATIVE_INFINITY);
    const h = cur.reduce((m, p) => Math.max(m, p.height), 0) || 10;
    lines.push({ y: curY, text: text.trim(), height: h, x0, width: Math.max(0, x1 - x0) });
    cur = [];
  };
  for (const p of sorted) {
    if (p.str.length === 0) continue;
    const tol = Math.max(1.0, p.height * 0.5);
    if (cur.length === 0 || Math.abs(p.y - curY) <= tol) {
      if (cur.length === 0) curY = p.y;
      cur.push(p);
    } else {
      flush();
      curY = p.y;
      cur.push(p);
    }
  }
  flush();
  return lines.filter((l) => l.text.length > 0);
}

/**
 * PDF 多页文本 → Markdown 纯文本（任务书 §4.6 启发式；DE 轮 M4 质量增强）：
 *   * 按 y 坐标分行（容差 = 字号一半），行内按 x 排序；
 *   * 行距聚类分段（行距 > 字号 × 1.9 或列表起头 → 新段落；段内软换行
 *     合并——CJK 邻接直连、西文补空格）；
 *   * M4 标题层级：字号相对页中位字号显著更大（>1.7×→#、>1.4×→##、
 *     >1.15×→###）且独立成行（前行距 > 1.2×中位、短文本、非列表）→ 映射
 *     ATX 标题；软换行的大字号行不误判（不独立）；
 *   * M4 列表语法：项目符号行 → `- `；数字/字母编号行 → `N. `（保留原
 *     编号），后续软换行并入列表项；
 *   * 页间 `---` 分隔。
 * 纯函数（pdfjs 不参与），vitest 可直接构造 pieces 验证。
 */

/** 列表起头判定与拆解：项目符号 / 数字 / 字母编号（短行才算，防正文误判）。 */
interface BulletMatch {
  marker: string;
  body: string;
}
function matchBulletish(text: string): BulletMatch | null {
  if (text.trim().length === 0 || text.trim().length >= 200) return null;
  let m = /^\s*([•·◦‣▪•-])\s*(.*)$/.exec(text);
  if (m && m[2].length > 0) return { marker: "- ", body: m[2].trim() };
  m = /^\s*(\d{1,3})\s*[.、)）]\s*(.*)$/.exec(text);
  if (m && m[2].length > 0) return { marker: `${m[1]}. `, body: m[2].trim() };
  m = /^\s*([a-zA-Z])\s*[.、)）]\s*(.*)$/.exec(text);
  if (m && m[2].length > 0) return { marker: `${m[1].toLowerCase()}. `, body: m[2].trim() };
  return null;
}

/** 标题层级（0 = 非标题）：字号显著大于页中位 + 短行 + 非列表。 */
function headingLevelOf(
  height: number,
  medianH: number,
  text: string,
  bullet: BulletMatch | null
): 0 | 1 | 2 | 3 {
  if (bullet || text.trim().length === 0 || text.trim().length > 80) return 0;
  if (height > medianH * 1.7) return 1;
  if (height > medianH * 1.4) return 2;
  if (height > medianH * 1.15) return 3;
  return 0;
}

export function rebuildPdfParagraphs(pages: PdfTextPiece[][]): string {
  const pageTexts: string[] = [];
  for (const pieces of pages) {
    const lines = piecesToLines(pieces);
    if (lines.length === 0) continue;
    const sortedH = lines.map((l) => l.height).sort((a, b) => a - b);
    const medianH = sortedH[Math.floor(sortedH.length / 2)] || 10;
    const paras: string[] = [];
    let cur = "";
    let prevY = Number.NaN;
    for (const line of lines) {
      const bullet = matchBulletish(line.text);
      const level = headingLevelOf(line.height, medianH, line.text, bullet);
      // 标题独立成行的佐证：页首行，或与前行距 > 1.2×中位（软换行的大字号
      // 行不满足——防正文大字误判）。
      const gapBefore = Number.isNaN(prevY) ? Number.POSITIVE_INFINITY : prevY - line.y;
      const standalone = gapBefore > medianH * 1.2;
      if (level > 0 && standalone) {
        if (cur !== "") paras.push(cur);
        paras.push(`${"#".repeat(level)} ${line.text.trim()}`);
        cur = "";
      } else if (bullet) {
        // 列表项独立起段（软换行的后续行并入本项）。
        if (cur !== "") paras.push(cur);
        cur = `${bullet.marker}${bullet.body}`;
      } else if (cur === "") {
        cur = line.text;
      } else {
        if (gapBefore > medianH * PARAGRAPH_GAP_RATIO) {
          paras.push(cur);
          cur = line.text;
        } else {
          const joiner =
            isCjkChar(cur[cur.length - 1]) || isCjkChar(line.text[0]) ? "" : " ";
          cur += joiner + line.text;
        }
      }
      prevY = line.y;
    }
    if (cur !== "") paras.push(cur);
    if (paras.length > 0) pageTexts.push(paras.join("\n\n"));
  }
  return pageTexts.join("\n\n---\n\n");
}

// ---- DE 轮：PDF 行级微编辑 patch 模型（纯数据；应用面见 docNoteSave.ts）--------

/** 一次行级替换补丁（任务书 §4.2）。所有坐标为 PDF 用户空间（y 向上，
 *  与 pdfjs textContent transform、pdf-lib drawText 同坐标系——阶段 0
 *  spike② 实测恒等映射，见 docs/doc-note-edit-spike-report.md）。 */
export interface PdfPatch {
  /** 1-based 页码。 */
  page: number;
  /** 行稳定键：`${page}@${Math.round(y)}@${Math.round(x0)}`（docTabKey 风格）。 */
  lineKey: string;
  origText: string;
  newText: string;
  /** 行 bbox（用户空间 [x0, yBottom, x1, yTop]——覆盖矩形用）。 */
  bbox: [number, number, number, number];
  /** 原行基线（drawText 原点）。 */
  baseline: { x: number; y: number };
  /** 原行有效字号（pt）。 */
  fontSize: number;
  /** 覆盖矩形底色（#rrggbb）。缺省纯白；非纯白背景在点击行进入编辑时从
   *  渲染 canvas 采样存入（spike② 定案）。 */
  coverColor?: string;
}

/** 由行聚类结果生成 patch 的稳定行键（page 1-based）。 */
export function pdfLineKey(page: number, y: number, x0: number): string {
  return `${page}@${Math.round(y)}@${Math.round(x0)}`;
}

// ---- 转 Markdown：data URL / 文件名（纯函数）---------------------------------


/** 拆 data: URL（mammoth 默认内联形态）→ mime + 字节。非 base64 形态返回
 *  null（调用方跳过落盘，保留原引用）。 */
export function splitDataUrl(url: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url);
  if (!m || !m[2]) return null;
  const bin = atob(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: m[1] || "application/octet-stream", bytes };
}

const DATA_URL_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/tiff": "tif",
  "image/x-emf": "emf",
  "image/x-wmf": "wmf",
};

/** data URL mime → 图片扩展名（未知一律 png——浏览器可显示优先）。 */
export function dataUrlImageExt(mime: string): string {
  return DATA_URL_EXT[mime.toLowerCase()] ?? "png";
}

// ---- 转 Markdown：管线（副作用面——读字节 / 落盘）------------------------------

/** 扫描版 PDF（无文本层）的显式中止错误——UI 提示走 OCR 建议，不产出空 MD。 */
export class PdfNoTextLayerError extends Error {
  constructor(message = "扫描版 PDF 无文本层") {
    super(message);
    this.name = "PdfNoTextLayerError";
  }
}

/** PDF → Markdown 文本：pdfjs 逐页 getTextContent（与视图共享字节缓存 +
 *  worker 单例），启发式段落重建（纯函数 rebuildPdfParagraphs）。 */
export async function convertPdfToMarkdownText(
  path: string
): Promise<{ text: string; pages: number }> {
  const bytes = await readDocNoteBytes(path);
  const { loadPdfjs } = await import("./pdfjsLazy");
  const pdfjs = await loadPdfjs();
  // v6：destroy() 在 loadingTask 上（proxy 无 destroy）——文档生命周期由任务收尾。
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  try {
    const pages: PdfTextPiece[][] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const items = tc.items as Array<{
        str?: string;
        transform?: number[];
        width?: number;
        height?: number;
      }>;
      pages.push(
        items
          .filter((it) => typeof it.str === "string" && Array.isArray(it.transform))
          .map((it) => ({
            str: it.str!,
            x: it.transform![4],
            y: it.transform![5],
            width: it.width ?? 0,
            height: it.height ?? 10,
          }))
      );
    }
    const text = rebuildPdfParagraphs(pages);
    if (text.replace(/\s/g, "").length < 8) throw new PdfNoTextLayerError();
    return { text, pages: doc.numPages };
  } finally {
    void task.destroy().catch(() => undefined);
  }
}

/** mammoth 懒加载单例（DocxNoteView 结构预览降级与转 MD 管线共用）。
 *  CJS 互op：default 形态与命名形态都收。 */
let mammothPromise: Promise<MammothLike> | null = null;

interface MammothLike {
  convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>;
}

export function loadMammoth(): Promise<MammothLike> {
  if (!mammothPromise) {
    mammothPromise = (async () => {
      const mod = await import("mammoth");
      const lib = (
        (mod as unknown as { default?: MammothLike }).default ?? mod
      ) as MammothLike;
      return lib;
    })();
    mammothPromise.catch(() => {
      mammothPromise = null;
    });
  }
  return mammothPromise;
}

/** docx → Markdown（含图片清单）：mammoth 语义 HTML（图片默认 data URL 内联）
 *  → 拆 data URL 为图片字节 + 相对 assets/ 引用 → turndown（复用
 *  htmlToMarkdown）。图片字节由调用方落盘（convertDocNoteToMd）。 */
export async function convertDocxToMarkdown(
  path: string
): Promise<{
  markdown: string;
  images: Array<{ name: string; bytes: Uint8Array }>;
  /** DE 轮 M4：表格含合并单元格（GFM 平铺降级——提示用，spike④ 清单）。 */
  flattenedSpans: boolean;
}> {
  const bytes = await readDocNoteBytes(path);
  const mammoth = await loadMammoth();
  // arrayBuffer 传副本——不暴露缓存本体给 mammoth 的 unzip 层。
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const res = await mammoth.convertToHtml({ arrayBuffer: ab });

  const doc = new DOMParser().parseFromString(res.value, "text/html");
  const stem = basename(path).slice(0, -extname(path).length) || "note";
  const images: Array<{ name: string; bytes: Uint8Array }> = [];
  doc.querySelectorAll('img[src^="data:"]').forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    const parsed = splitDataUrl(src);
    if (!parsed) return;
    const name = `${stem}-${String(images.length + 1).padStart(2, "0")}.${dataUrlImageExt(parsed.mime)}`;
    images.push({ name, bytes: parsed.bytes });
    img.setAttribute("src", `assets/${name}`);
  });
  const flattenedSpans = !!doc.querySelector("td[colspan],td[rowspan],th[colspan],th[rowspan]");
  const { convertHtmlToMarkdown } = await import("./htmlToMarkdown");
  const markdown = await convertHtmlToMarkdown(doc.body.innerHTML);
  return { markdown, images, flattenedSpans };
}

export interface DocConvertResult {
  /** 落盘后的 .md 绝对路径（源文件同目录，冲突经 conflictFreeName 改名）。 */
  mdPath: string;
  /** 结果提示（页数/图片数），调用方可直接展示。 */
  note: string;
}

// ---- DE 轮 M2：Word 原位编辑水合管线（spike④ 配方）----------------------------

/** mammoth HTML → 编辑面可承载 HTML 的预处理（纯函数，DOMParser 不执行脚本）。
 *  spike④-B 实测配方（docs/doc-note-edit-spike-report.md）——每次进入编辑面
 *  都要执行（含切回重水合，Crepe 自身序列化的表格也包 <p>）：
 *  ① 消毒闸门（S10 延伸：mammoth 产物进编辑面必过）；
 *  ② 单元格内 <p> 解包为 <span>（turndown-gfm 拒绝块级单元格→保留原始 HTML
 *     表→Crepe 丢弃，表格死亡链的断点）；
 *  ③ 各行截齐/补齐到最大列数 + 首行提升 <th>（GFM 管道表无 colspan/rowspan
 *     且要求首行表头——合并单元格降级为平铺，内容不丢）。
 *  返回 flattenedSpans = 输入含合并单元格（调用方据此提示降级）。 */
export function preprocessMammothHtmlForEdit(html: string): {
  html: string;
  flattenedSpans: boolean;
} {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll("script,style,noscript,template")
    .forEach((el) => el.remove());
  const flattenedSpans = !!doc.querySelector("td[colspan],td[rowspan],th[colspan],th[rowspan]");
  // span 属性先检测后剥离（GFM 管道表无合并语义，留着只会污染透传 HTML）。
  doc.querySelectorAll("td[colspan],td[rowspan],th[colspan],th[rowspan]").forEach((cell) => {
    cell.removeAttribute("colspan");
    cell.removeAttribute("rowspan");
  });
  doc.querySelectorAll("td p, th p").forEach((p) => {
    const span = p.ownerDocument.createElement("span");
    span.innerHTML = p.innerHTML;
    p.replaceWith(span);
  });
  doc.querySelectorAll("table").forEach((t) => {
    const rows = [...t.querySelectorAll("tr")];
    const maxCells = Math.max(0, ...rows.map((r) => r.querySelectorAll("td,th").length));
    rows.forEach((r, ri) => {
      const cells = [...r.querySelectorAll("td,th")];
      while (cells.length > maxCells) cells.pop()?.remove();
      while (r.querySelectorAll("td,th").length < maxCells) {
        r.appendChild(r.ownerDocument.createElement(ri === 0 ? "th" : "td"));
      }
      if (ri === 0) {
        r.querySelectorAll("td").forEach((td) => {
          const th = td.ownerDocument.createElement("th");
          th.innerHTML = td.innerHTML;
          td.replaceWith(th);
        });
      }
    });
  });
  return { html: doc.body.innerHTML, flattenedSpans };
}

export interface DocxForEditResult {
  /** 编辑面初始 markdown（Crepe defaultValue；经消毒 + 表格三步预处理）。 */
  markdown: string;
  /** mammoth 原始语义 HTML（图片 data URL 内联保持，全程不落盘）。 */
  html: string;
  /** 输入含合并单元格——编辑面将平铺（保存前提示文案用）。 */
  flattenedSpans: boolean;
}

/** docx → 编辑面初始 markdown（M2，任务书 §4.1）：mammoth 语义 HTML（图片
 *  data URL 内联）→ 消毒 + 表格预处理 → convertHtmlToMarkdown（turndown）。
 *  与 convertDocxToMarkdown 的差异：图片不拆 assets/（编辑期全程内联，
 *  保存链 prepareExportHtml/buildDocx 原生接受 data URL）。核心按字节入参
 *  （convertDocxBytesForEdit），路径封装只负责取字节。 */
export async function convertDocxBytesForEdit(bytes: Uint8Array): Promise<DocxForEditResult> {
  const mammoth = await loadMammoth();
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const res = await mammoth.convertToHtml({ arrayBuffer: ab });
  const { sanitizeExportHtml } = await import("./exportSanitize");
  const pre = preprocessMammothHtmlForEdit(sanitizeExportHtml(res.value));
  const { convertHtmlToMarkdown } = await import("./htmlToMarkdown");
  const markdown = await convertHtmlToMarkdown(pre.html);
  return { markdown, html: res.value, flattenedSpans: pre.flattenedSpans };
}

/** 路径封装：字节经 docNote 单条缓存（与视图/转 MD 共享）。 */
export async function convertDocxForEdit(path: string): Promise<DocxForEditResult> {
  return convertDocxBytesForEdit(await readDocNoteBytes(path));
}

/**
 * 一键「转为 Markdown 笔记」（任务书 §4.6）：
 *   * 目标 `.md` 放源文件同目录，命名 `原名.md`，冲突复用 HN 轮的
 *     conflictFreeName（绝不覆盖）；
 *   * docx 图片写入 `<md 同目录>/assets/`（对齐 imageManager 惯例），
 *     MD 内引用相对路径；
 *   * PDF 走文本层提取；扫描件抛 PdfNoTextLayerError（UI 提示 OCR 暂未
 *     支持），不产出空壳 MD。
 * 只读源文件——转换绝不修改/移动原 pdf/docx。
 */
export async function convertDocNoteToMd(path: string): Promise<DocConvertResult> {
  if (!isDocNote(path)) throw new Error(`not a doc note: ${path}`);
  const fs = getAdapter().fs;
  const dir = dirname(path);
  const taken = new Set(
    (await fs.readDir(dir).catch(() => [])).map((e) => e.name)
  );
  const stem = basename(path).slice(0, -extname(path).length) || "note";
  const mdName = conflictFreeName(`${stem}.md`, taken);
  const mdPath = join(dir, mdName);

  let content: string;
  let note: string;
  if (isPdfNote(path)) {
    const r = await convertPdfToMarkdownText(path);
    content = r.text;
    note = `已提取 ${r.pages} 页文本（排版/图片/公式丢失）`;
  } else {
    const r = await convertDocxToMarkdown(path);
    if (r.images.length > 0) {
      const assetsDir = join(dir, "assets");
      await fs.mkdir(assetsDir, { recursive: true });
      for (const im of r.images) {
        await fs.writeFile(join(assetsDir, im.name), im.bytes);
      }
    }
    content = r.markdown;
    note =
      (r.images.length > 0 ? `已转换（${r.images.length} 张图片落 assets/）` : "已转换") +
      (r.flattenedSpans ? "；表格含合并单元格，已按平铺表格转换" : "");
  }
  await fs.writeTextFile(mdPath, content);
  return { mdPath, note };
}
