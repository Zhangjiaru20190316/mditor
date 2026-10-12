// PDF 自研管线（EX 轮阶段三原型 / 阶段四全量落地）：离屏工厂 → 块测量 →
// 分页器 → 分块光栅 → pdf-lib 组装（位图 + 可选隐形文本层）。
//
// 全链路应用内完成（用户铁律）：无 OS 打印对话框、无 window.print；唯一
// 系统交互是调用方的 pickSaveFile。进度事件贯穿各阶段、AbortSignal 可取
// 消、工厂 iframe/画布/中间位图随分块即弃（T2：峰值受画布预算约束）。
//
// 依赖纪律：modern-screenshot（既有）/ pdf-lib / fontkit 全部函数内懒加载。
// 字体（文本层）：应用源 public/assets/fonts/NotoSansSC-Regular.otf（OFL，
// 允许子集内嵌再分发；见同目录 OFL.txt）。取不到 → 纯光栅降级（info 如实
// 报告 fontEmbedded=false），不为文本层牺牲完整性主门。

import {
  renderInFactory,
  type RenderFactoryHandle,
} from "./exportRenderFactory";
import {
  paginateBlocks,
  type MeasuredBlock,
  type PageWindow,
  type SplitLine,
} from "./exportPaginator";
import {
  createPdfAssembler,
  PT_PER_PX,
  type PdfAssembleInfo,
  type PdfTextRun,
} from "./exportPdfAssembly";

export const PDF_PAPERS = {
  A4: { widthPt: 595.28, heightPt: 841.89, label: "A4（210×297mm）" },
  Letter: { widthPt: 612, heightPt: 792, label: "Letter（216×279mm）" },
  A3: { widthPt: 841.89, heightPt: 1190.55, label: "A3（297×420mm）" },
} as const;
export type PdfPaperId = keyof typeof PDF_PAPERS;

export const PDF_MARGIN_CHOICES = [10, 15, 20, 25] as const; // mm
export const PDF_SCALE_CHOICES = [1, 1.5, 2] as const; // 96/144/192 dpi 等效

/** 单画布预算（沿 exportPng 惯例：T2 画布治理）。 */
const MAX_CANVAS_SIDE = 16_384;
const MAX_CANVAS_PIXELS = 120_000_000;
/** 每分块最多页数（foreignObject 序列化是全文档级成本，块太大内存尖峰）。 */
const MAX_PAGES_PER_CHUNK = 4;
/** 文本层字体（应用源；OFL 授权见 public/assets/fonts/OFL.txt）。 */
const CJK_FONT_URL =
  (import.meta.env.BASE_URL ?? "/") + "assets/fonts/NotoSansSC-Regular.otf";

export interface PdfExportProgress {
  stage: "factory" | "measure" | "paginate" | "text" | "raster" | "assemble";
  done: number;
  total: number;
  note?: string;
}

export interface PdfPipelineOptions {
  paper?: PdfPaperId;
  /** 四边统一边距（mm）。 */
  marginMm?: number;
  /** 光栅倍率（1/1.5/2 = 96/144/192dpi 等效）。 */
  rasterScale?: number;
  /** 隐形文本层开关（EX-P 拍板前原型位；false = 纯光栅）。 */
  textLayer?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: PdfExportProgress) => void;
  title?: string;
}

export interface PdfPipelineResult {
  bytes: Uint8Array;
  meta: {
    pages: number;
    paper: PdfPaperId;
    contentWidthPx: number;
    contentHeightPx: number;
    rasterScale: number;
    paginate: ReturnType<typeof paginateBlocks>["stats"];
    assemble: PdfAssembleInfo;
    textFragments: number;
    timings: Record<string, number>;
  };
}

/** mm → pt。 */
export const mmToPt = (mm: number): number => (mm * 72) / 25.4;

export async function runPdfPipeline(
  html: string,
  css: string,
  o: PdfPipelineOptions = {}
): Promise<PdfPipelineResult> {
  const t = { factory: 0, measure: 0, paginate: 0, text: 0, raster: 0, assemble: 0 };
  const paper = PDF_PAPERS[o.paper ?? "A4"];
  const marginPt = mmToPt(o.marginMm ?? 15);
  const scale = o.rasterScale ?? 2;
  const contentWidthPt = paper.widthPt - 2 * marginPt;
  const contentHeightPt = paper.heightPt - 2 * marginPt;
  const contentWidthPx = Math.round(contentWidthPt / PT_PER_PX);
  const contentHeightPx = Math.round(contentHeightPt / PT_PER_PX);
  const signal = o.signal;
  const checkAbort = (): void => {
    if (signal?.aborted) throw new DOMException("导出已取消", "AbortError");
  };
  const progress = (p: PdfExportProgress): void => o.onProgress?.(p);

  // ---- 1. 离屏工厂渲染（S10 消毒在工厂文档组装内）----
  let t0 = performance.now();
  const handle = await renderInFactory(html, {
    contentWidthPx,
    css,
    title: o.title,
    maxImageHeightPx: contentHeightPx,
    signal,
    onProgress: (p) =>
      progress({
        stage: "factory",
        done: p.done,
        total: p.total,
        note: p.stage,
      }),
  });
  t.factory = performance.now() - t0;
  try {
    checkAbort();

    // ---- 2. 块测量 ----
    t0 = performance.now();
    const blocks = measureBlocks(handle);
    t.measure = performance.now() - t0;
    progress({ stage: "measure", done: blocks.length, total: blocks.length });

    // ---- 3. 分页 ----
    t0 = performance.now();
    const paginated = paginateBlocks(blocks, contentHeightPx);
    t.paginate = performance.now() - t0;
    progress({
      stage: "paginate",
      done: paginated.stats.pages,
      total: paginated.stats.pages,
    });
    checkAbort();

    // ---- 4. 文本层素材（可选；一次全量收集，页窗口二分归属）----
    t0 = performance.now();
    const fragments = o.textLayer === false ? [] : collectTextFragments(handle);
    t.text = performance.now() - t0;
    progress({ stage: "text", done: fragments.length, total: fragments.length });

    // ---- 5. 字体（懒加载；失败 = 纯光栅）----
    let fontBytes: Uint8Array | null = null;
    if (o.textLayer !== false && fragments.length > 0) {
      fontBytes = await loadFontBytes();
    }

    // ---- 6. 组装器 ----
    const assembler = await createPdfAssembler({
      pageWidthPt: paper.widthPt,
      pageHeightPt: paper.heightPt,
      marginPt: { top: marginPt, right: marginPt, bottom: marginPt, left: marginPt },
      contentWidthPx,
      contentHeightPx,
      fontBytes,
      title: o.title,
    });

    // ---- 7. 分块光栅 + 逐页入册 ----
    t0 = performance.now();
    await rasterizeAndAssemble(handle, paginated.pages, {
      contentWidthPx,
      contentHeightPx,
      scale,
      fragments,
      assembler,
      signal,
      onProgress: (done, total, note) =>
        progress({ stage: "raster", done, total, note }),
    });
    t.raster = performance.now() - t0;

    // ---- 8. 落册 ----
    const bytes = await assembler.save();
    t.assemble = performance.now() - t0 - t.raster;
    return {
      bytes,
      meta: {
        pages: paginated.stats.pages,
        paper: o.paper ?? "A4",
        contentWidthPx,
        contentHeightPx,
        rasterScale: scale,
        paginate: paginated.stats,
        assemble: assembler.info(),
        textFragments: fragments.length,
        timings: t,
      },
    };
  } finally {
    handle.destroy();
  }
}

// ---------------------------------------------------------------------------
// 块测量：工厂 content 的子元素 → MeasuredBlock（契约：height 覆盖到下一
// 块顶）。列表展开到 li（长列表可断）；表格给行盒；段落/代码/引用给行盒。
// ---------------------------------------------------------------------------

const KEEP_TAGS = new Set(["IMG", "HR", "FIGURE", "VIDEO", "SVG", "IFRAME"]);
const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

export function measureBlocks(handle: RenderFactoryHandle): MeasuredBlock[] {
  const content = handle.content;
  const doc = handle.doc;
  const base = content.getBoundingClientRect();
  const kids: Element[] = [];
  for (const node of Array.from(content.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (el.tagName === "UL" || el.tagName === "OL") {
        for (const li of Array.from(el.children)) kids.push(li);
        // 列表自身与 li 之间的空隙（无 li 的空列表/列表边距）：并入前块高度
        // 由「下一块顶 − 本块顶」语义自然覆盖（li 顶即列表顶）。
      } else {
        kids.push(el);
      }
    } else if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim()) {
      // 裸文本（罕见）：包一个 span 使其可测量（不改内容）。
      const span = doc.createElement("span");
      span.textContent = node.textContent;
      content.replaceChild(span, node);
      kids.push(span);
    }
  }
  const blocks: MeasuredBlock[] = [];
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i] as HTMLElement;
    const rect = el.getBoundingClientRect();
    const top = rect.top - base.top;
    const nextTop =
      i + 1 < kids.length
        ? (kids[i + 1] as HTMLElement).getBoundingClientRect().top - base.top
        : content.scrollHeight;
    const height = Math.max(nextTop - top, rect.height, 0);
    const tag = el.tagName;
    const blockId = blocks.length;
    if (KEEP_TAGS.has(tag)) {
      blocks.push({ blockId, height, keepTogether: true });
    } else if (HEADING_TAGS.has(tag)) {
      blocks.push({ blockId, height, keepTogether: true, keepWithNext: true });
    } else if (tag === "TABLE") {
      blocks.push({ blockId, height, rows: tableRows(el, top) });
    } else {
      blocks.push({ blockId, height, lines: lineBoxes(doc, el, top), orphanControl: true });
    }
  }
  return blocks;
}

/** 表格行盒（相对块顶）。 */
function tableRows(table: HTMLElement, blockTop: number): SplitLine[] {
  const rows: SplitLine[] = [];
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    const r = tr.getBoundingClientRect();
    if (r.height <= 0) continue;
    rows.push({ top: r.top - blockTop, height: r.height });
  }
  return rows.length > 0 ? rows : [{ top: 0, height: table.getBoundingClientRect().height }];
}

/**
 * 块内行盒（相对块顶）：Range 全量取文本片矩形 → 垂直区间合并（同线不同
 * 高度的上下标/行内公式并成一行，防止刀口落进视觉行内部）。
 */
function lineBoxes(doc: Document, el: HTMLElement, blockTop: number): SplitLine[] {
  const rects = textRectsOf(doc, el);
  if (rects.length === 0) {
    const r = el.getBoundingClientRect();
    return r.height > 0 ? [{ top: r.top - blockTop, height: r.height }] : [];
  }
  rects.sort((a, b) => a.top - b.top);
  const merged: SplitLine[] = [];
  let cur = { top: rects[0].top, bottom: rects[0].bottom };
  for (let i = 1; i < rects.length; i++) {
    const r = rects[i];
    if (r.top <= cur.bottom + 1) {
      cur.bottom = Math.max(cur.bottom, r.bottom);
    } else {
      merged.push({ top: cur.top - blockTop, height: cur.bottom - cur.top });
      cur = { top: r.top, bottom: r.bottom };
    }
  }
  merged.push({ top: cur.top - blockTop, height: cur.bottom - cur.top });
  return merged;
}

/** 块子树内可见文本的矩形（content 视口坐标）。跳过 KaTeX 的隐藏 MathML。 */
function textRectsOf(doc: Document, el: HTMLElement): DOMRect[] {
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  const out: DOMRect[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!(node.data ?? "").trim()) continue;
    const p = node.parentElement;
    if (!p || p.closest(".katex-mathml")) continue;
    range.selectNodeContents(node);
    for (const r of Array.from(range.getClientRects())) {
      if (r.width > 0 && r.height > 0) out.push(r);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 文本层素材：全量收集文本片段（content 坐标 + 字体/字号 + 逐字符实测
// advance），页窗口过滤后映射为 PdfTextRun。advance 用工厂 iframe 的 canvas
// measureText（与布局同引擎同字体→位置按构造一致），(font,char) 级缓存。
// ---------------------------------------------------------------------------

interface TextFragment {
  text: string;
  /** content 坐标（相对 content 盒左上）。 */
  x: number;
  top: number;
  height: number;
  size: number;
  /** 基线（content 坐标，向下正）。 */
  baselineY: number;
  advances: number[];
}

interface FontMetrics {
  ascent: number;
  descent: number;
}

export function collectTextFragments(handle: RenderFactoryHandle): TextFragment[] {
  const content = handle.content;
  const doc = handle.doc;
  const win = handle.iframe.contentWindow;
  if (!win) return [];
  const base = content.getBoundingClientRect();
  const canvas = doc.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  const fontMetrics = new Map<string, FontMetrics>();
  const advanceCache = new Map<string, number>();
  const styleCache = new Map<HTMLElement, { font: string; size: number }>();
  const fragments: TextFragment[] = [];
  const walker = doc.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const data = node.data ?? "";
    if (!data.trim()) continue;
    const p = node.parentElement;
    if (!p || p.closest(".katex-mathml")) continue;
    let style = styleCache.get(p);
    if (!style) {
      const cs = win.getComputedStyle(p);
      style = { font: cs.font, size: parseFloat(cs.fontSize) || 16 };
      styleCache.set(p, style);
    }
    if (!Number.isFinite(style.size) || style.size <= 0) continue;
    ctx.font = style.font;
    let fm = fontMetrics.get(style.font);
    if (!fm) {
      const m = ctx.measureText("中Mgq");
      const ascent = Number.isFinite(m.fontBoundingBoxAscent)
        ? m.fontBoundingBoxAscent
        : style.size * 0.88;
      const descent = Number.isFinite(m.fontBoundingBoxDescent)
        ? m.fontBoundingBoxDescent
        : style.size * 0.12;
      fm = { ascent, descent };
      fontMetrics.set(style.font, fm);
    }
    // 逐字符 advance（(font,char) 缓存——CJK 重复率高）。
    const chars = Array.from(data);
    const advances = chars.map((ch) => {
      const key = style.font + "\u0000" + ch;
      let w = advanceCache.get(key);
      if (w === undefined) {
        w = ctx.measureText(ch).width;
        advanceCache.set(key, w);
      }
      return w;
    });
    range.selectNodeContents(node);
    for (const r of Array.from(range.getClientRects())) {
      if (r.width <= 0 || r.height <= 0) continue;
      fragments.push({
        text: data,
        x: r.left - base.left,
        top: r.top - base.top,
        height: r.height,
        size: style.size,
        baselineY:
          r.top - base.top + (r.height - (fm.ascent + fm.descent)) / 2 + fm.ascent,
        advances,
      });
    }
  }
  return fragments;
}

/** 页窗口 → 文本 run（片段与窗口相交即入；整行原子，归属重叠最多的一页）。 */
export function fragmentsToPageRuns(
  fragments: TextFragment[],
  pages: PageWindow[],
  contentHeightPx: number
): PdfTextRun[][] {
  const perPage: PdfTextRun[][] = pages.map(() => []);
  for (const f of fragments) {
    const fBottom = f.top + f.height;
    // 页窗口连续（下页 top = 上页 bottom），二分定位起始页。
    let lo = 0;
    let hi = pages.length - 1;
    let start = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pages[mid].top <= f.top + 1e-6) {
        start = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    for (let i = Math.max(start, 0); i < pages.length; i++) {
      const wTop = pages[i].top;
      const wBottom = wTop + contentHeightPx;
      if (wTop >= fBottom - 1e-6) break;
      const overlap = Math.min(fBottom, wBottom) - Math.max(f.top, wTop);
      if (overlap > 0) {
        // 重叠最多的一页认领（正常分页下片段独占一页，此处防边界浮点）。
        let best = i;
        if (i + 1 < pages.length) {
          const nb = pages[i + 1].top + contentHeightPx;
          const nOverlap = Math.min(fBottom, nb) - Math.max(f.top, pages[i + 1].top);
          if (nOverlap > overlap) best = i + 1;
        }
        perPage[best].push({
          text: f.text,
          x: f.x,
          baselineY: f.baselineY - pages[best].top,
          size: f.size,
          advances: f.advances,
        });
        break;
      }
    }
  }
  return perPage;
}

// ---------------------------------------------------------------------------
// 分块光栅：裁剪窗口（overflow:hidden + translateY 平移内容）+ modern-
// screenshot 按 chunk 出图 → 父窗口 canvas 裁成页 PNG → 入册即弃。
// ---------------------------------------------------------------------------

interface RasterizeArgs {
  contentWidthPx: number;
  contentHeightPx: number;
  scale: number;
  fragments: TextFragment[];
  assembler: Awaited<ReturnType<typeof createPdfAssembler>>;
  signal?: AbortSignal;
  onProgress: (done: number, total: number, note?: string) => void;
}

async function rasterizeAndAssemble(
  handle: RenderFactoryHandle,
  pages: PageWindow[],
  a: RasterizeArgs
): Promise<void> {
  const doc = handle.doc;
  const content = handle.content;
  const runsPerPage = fragmentsToPageRuns(a.fragments, pages, a.contentHeightPx);

  // 裁剪窗口就位（把 content 挪进窗口容器；同文档内移动，样式不丢）。
  const win = doc.createElement("div");
  win.style.cssText = `overflow:hidden;position:relative;width:${a.contentWidthPx}px;`;
  const bg = doc.defaultView
    ?.getComputedStyle(doc.documentElement)
    .backgroundColor || "#ffffff";
  const parent = content.parentNode as Node;
  parent.insertBefore(win, content);
  win.appendChild(content);
  content.style.position = "relative";

  const { domToPng } = await import("modern-screenshot");
  const bySide = Math.floor(MAX_CANVAS_SIDE / (a.contentHeightPx * a.scale));
  const byPixels = Math.floor(
    MAX_CANVAS_PIXELS /
      (a.contentWidthPx * a.scale * a.contentHeightPx * a.scale)
  );
  const perChunk = Math.max(1, Math.min(bySide, byPixels, MAX_PAGES_PER_CHUNK));

  const pageCanvas = document.createElement("canvas");
  pageCanvas.width = Math.round(a.contentWidthPx * a.scale);
  pageCanvas.height = Math.round(a.contentHeightPx * a.scale);
  const pageCtx = pageCanvas.getContext("2d");
  if (!pageCtx) throw new Error("无法创建页画布（2D 上下文不可用）");
  pageCtx.fillStyle = bg;
  const pw = pageCanvas.width;
  const ph = pageCanvas.height;

  try {
    for (let start = 0; start < pages.length; start += perChunk) {
      if (a.signal?.aborted) throw new DOMException("导出已取消", "AbortError");
      const chunk = pages.slice(start, start + perChunk);
      const chunkTop = chunk[0].top;
      win.style.height = `${a.contentHeightPx * chunk.length}px`;
      content.style.transform = `translateY(${-chunkTop}px)`;
      // 平移后布局收帧再截图。
      await new Promise<void>((res) =>
        requestAnimationFrame(() => requestAnimationFrame(() => res()))
      );
      const dataUrl = await domToPng(win, {
        width: a.contentWidthPx,
        height: a.contentHeightPx * chunk.length,
        scale: a.scale,
        backgroundColor: bg,
      });
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      for (let i = 0; i < chunk.length; i++) {
        const pageIndex = start + i;
        pageCtx.fillRect(0, 0, pw, ph);
        pageCtx.drawImage(
          img,
          0,
          Math.round(i * a.contentHeightPx * a.scale),
          img.width,
          Math.round(a.contentHeightPx * a.scale),
          0,
          0,
          pw,
          ph
        );
        const png = dataUrlToBytes(pageCanvas.toDataURL("image/png"));
        await a.assembler.addPage(png, runsPerPage[pageIndex]);
        a.onProgress(pageIndex + 1, pages.length);
      }
      // 即弃：分块位图与解码图随下一轮 GC；显式断引用帮助引擎回收。
      img.src = "";
    }
  } finally {
    // 工厂回收前把 content 归位（destroy 只移除 iframe，无副作用亦可）。
    try {
      parent.insertBefore(content, win);
      win.remove();
    } catch {
      /* 已随 iframe 销毁 */
    }
  }
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const i = dataUrl.indexOf(",");
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
  return bytes;
}

let fontBytesCache: Uint8Array | null | undefined;

/** 文本层字体（应用源 fetch，会话内缓存；失败 → null → 纯光栅）。 */
export async function loadFontBytes(url: string = CJK_FONT_URL): Promise<Uint8Array | null> {
  if (fontBytesCache !== undefined) return fontBytesCache;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fontBytesCache = new Uint8Array(await r.arrayBuffer());
  } catch {
    fontBytesCache = null; // 字体缺位：纯光栅降级（EX-P 允许，完整性不受损）
  }
  return fontBytesCache;
}
