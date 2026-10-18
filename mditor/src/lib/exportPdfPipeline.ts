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
/** JPEG 档内存护栏：解码位图累计超过该值 → 页图转 JPEG（0.92）。
 *  pdf-lib 的 embedPng 解码 RGBA 且驻留到 save；87 页 × 2x ≈ 1GB 实测
 *  撞墙（EX-P）。阈值取 ~256MB——小文档保持无损 PNG。 */
const JPEG_GUARD_BYTES = 256 * 1024 * 1024;
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
  /** 调试：指定页码（0 基）在入册时回调页 PNG dataURL（C1 视觉抽检用）。 */
  onPagePng?: (index: number, dataUrl: string) => void;
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
      onPagePng: o.onPagePng,
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
/** 墨迹护量上限（CSS px，HX P-γ 补全）：字形墨迹可越出文本 rect 盒——
 *  KaTeX 大操作符降部（∑）实测越盒 ~0.5px、行内极限栈（∫n+1∞ 的 vlist
 *  零高盒）越盒 ~3.5px，刀口贴行盒底会剃进笔画（页尾全浓墨平切像）。
 *  行盒底按「相邻行间隙半宽」自适应外扩（≤本值）：split 刀口随之落到
 *  越盒墨迹之下；块末行的外扩由块间距（≥margin）吸收。表格行不外扩
 *  （边框线本就贴行界，外扩反而切边框）。 */
const INK_GUARD_MAX_PX = 4;

/** 行盒底自适应护量：每行底部外扩 min(上限, 与下一行间隙的一半 − ε)，
 *  保证相邻行护量不交叠（刀口仍落在本行墨迹与下行墨迹之间）。 */
function guardLineUnits(units: SplitLine[]): SplitLine[] {
  return units.map((u, i) => {
    const bottom = u.top + u.height;
    const nextTop = i + 1 < units.length ? units[i + 1].top : Infinity;
    const gap = nextTop - bottom;
    const pad =
      i + 1 < units.length
        ? Math.min(INK_GUARD_MAX_PX, Math.max(gap / 2 - 0.25, 0))
        : INK_GUARD_MAX_PX;
    return { top: u.top, height: u.height + pad };
  });
}

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
  if (kids.length === 0) return [];

  // Pass 1：逐 kid 测 border 顶 + 断页单元（行盒/行，rel 到 border 顶——
  // 首单元可为负：KaTeX vlist 零高盒的墨迹绘制在布局盒之外，HX P-γ）。
  interface KidMeasure {
    borderTop: number;
    borderHeight: number;
    keepTogether?: boolean;
    keepWithNext?: boolean;
    rows?: SplitLine[];
    lines?: SplitLine[];
    orphanControl?: boolean;
    /** 首单元绝对顶（content 坐标；无单元 = border 顶）。 */
    inkTop: number;
    /** 末单元绝对底与 border 底的较大者（content 坐标）。 */
    coverBottom: number;
  }
  const unitTop = (u?: SplitLine): number | undefined =>
    u ? u.top : undefined;
  const unitBottom = (u?: SplitLine): number | undefined =>
    u ? u.top + u.height : undefined;
  const measured: KidMeasure[] = kids.map((kid) => {
    const el = kid as HTMLElement;
    const rect = el.getBoundingClientRect();
    const top = rect.top - base.top;
    const tag = el.tagName;
    let m: KidMeasure = {
      borderTop: top,
      borderHeight: rect.height,
      inkTop: top,
      coverBottom: top + rect.height,
    };
    if (KEEP_TAGS.has(tag)) {
      m.keepTogether = true;
    } else if (HEADING_TAGS.has(tag)) {
      m.keepTogether = true;
      m.keepWithNext = true;
    } else if (tag === "TABLE") {
      m.rows = tableRows(el, top, base.top);
    } else {
      m.lines = guardLineUnits(lineBoxes(doc, el, top, base.top));
      m.orphanControl = true;
    }
    const units = m.rows ?? m.lines;
    if (units && units.length > 0) {
      const first = unitTop(units[0]) as number;
      const last = unitBottom(units[units.length - 1]) as number;
      // 墨迹顶：行盒首顶可为负（vlist 上伸越盒）；表格行首顶 ≥0。
      m.inkTop = Math.min(top, top + first);
      m.coverBottom = Math.max(top + rect.height, top + last);
    }
    return m;
  });

  // Pass 2：墨迹感知 rebase——块基准顶取「墨迹顶」（首块不取负：content
  // 原点以上的溢出不在任何页窗内，从测量面裁掉），高度链铺满到下一块墨迹
  // 顶，且任何块的覆盖底不小于自身墨迹底（块间刀口构造性落进无墨间隙/
  // 块间隙）。
  const blocks: MeasuredBlock[] = [];
  let acc = 0;
  for (let i = 0; i < measured.length; i++) {
    const m = measured[i];
    const coverTop = i === 0 ? Math.max(0, m.inkTop) : m.inkTop;
    const top = Math.max(acc, coverTop);
    // 单元换算：rel(border) → rel(新基)＝borderTop − top（墨迹顶高于
    // border 顶时为正，把上溢部分拉回 0 基）。
    const shift = m.borderTop - top;
    const nextCoverTop = measured[i + 1]?.inkTop;
    // 末块兜底到内容末底（scrollHeight 含溢出绘制）。
    const lastEnd = Math.max(
      content.scrollHeight,
      measured[measured.length - 1].coverBottom
    );
    const height =
      i + 1 < measured.length
        ? Math.max(Math.max(nextCoverTop, m.coverBottom) - top, 0)
        : Math.max(lastEnd - top, 0);
    const rebase = (units?: SplitLine[]): SplitLine[] | undefined =>
      units?.map((u) => ({ top: u.top + shift, height: u.height }));
    blocks.push({
      blockId: blocks.length,
      height,
      ...(m.keepTogether ? { keepTogether: true } : {}),
      ...(m.keepWithNext ? { keepWithNext: true } : {}),
      ...(m.rows ? { rows: rebase(m.rows) } : {}),
      ...(m.lines ? { lines: rebase(m.lines) } : {}),
      ...(m.orphanControl ? { orphanControl: true } : {}),
    });
    acc = top + height;
  }
  return blocks;
}

/** 表格行盒（相对块顶）。baseTop＝content 容器视口顶（HX P-α：Range/
 *  getBoundingClientRect 均为视口坐标，须先换算回 content 相对坐标）。 */
function tableRows(
  table: HTMLElement,
  blockTop: number,
  baseTop: number
): SplitLine[] {
  const rows: SplitLine[] = [];
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    const r = tr.getBoundingClientRect();
    if (r.height <= 0) continue;
    rows.push({ top: r.top - baseTop - blockTop, height: r.height });
  }
  if (rows.length > 0) return rows;
  const whole = table.getBoundingClientRect();
  return [{ top: whole.top - baseTop - blockTop, height: whole.height }];
}

/**
 * 块内行盒（相对块顶）：Range 全量取文本片矩形 → 垂直区间合并（同线不同
 * 高度的上下标/行内公式并成一行，防止刀口落进视觉行内部）。baseTop＝
 * content 容器视口顶：HX P-α——getClientRects 是视口坐标而 blockTop 是
 * content 相对坐标，content 视口原点≠0（首块塌陷 margin 等）时混用会使
 * 全部行盒整体偏移，刀口切进视觉行内部。
 */
function lineBoxes(
  doc: Document,
  el: HTMLElement,
  blockTop: number,
  baseTop: number
): SplitLine[] {
  const rects = textRectsOf(doc, el);
  if (rects.length === 0) {
    const r = el.getBoundingClientRect();
    return r.height > 0 ? [{ top: r.top - baseTop - blockTop, height: r.height }] : [];
  }
  rects.sort((a, b) => a.top - b.top);
  const merged: SplitLine[] = [];
  let cur = { top: rects[0].top, bottom: rects[0].bottom };
  for (let i = 1; i < rects.length; i++) {
    const r = rects[i];
    if (r.top <= cur.bottom + 1) {
      cur.bottom = Math.max(cur.bottom, r.bottom);
    } else {
      merged.push({ top: cur.top - baseTop - blockTop, height: cur.bottom - cur.top });
      cur = { top: r.top, bottom: r.bottom };
    }
  }
  merged.push({ top: cur.top - baseTop - blockTop, height: cur.bottom - cur.top });
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
//
// 序列化裁剪（EX 阶段六，密度档 87 页实测冻死归因）：domToPng 对窗口子树
// 全量克隆——87 页文档每块克隆 ~80 万节点，6 块后 renderer 内存压力累积冻
// 死（进度事件定位：6×87s 后第 7 块 console/eval 双静默）。裁剪法：每块把
// 窗口外的顶层块暂存到 DocumentFragment，窗口内块改绝对定位（top = 原始
// content 坐标，margin 归零并入 top——绝对定位不参与相邻 margin 合并，坐
// 标精确），出图后按原序全量还原。克隆成本从 O(全文档)×块数 降为
// O(块内)×块数，块间垃圾即弃。
// ---------------------------------------------------------------------------

/** 页切片源 y（设备 px，纯函数）：页真实窗口顶相对 chunk 顶。HX P-β——
 *  分页器产出变高页（endPage bottom=末段底，页顶链式推进），chunk 内按
 *  i×contentHeightPx 定高网格切片会使提前收尾页之后的所有页累计漂移
 *  （密度档实测最大 211px），产物页界落在任意墨迹上。切片位必须跟随
 *  pages[i].top；文本层（fragmentsToPageRuns）本就按页顶开窗，此后三路
 *  坐标系对齐。 */
export function pageSliceSourceY(
  pageTop: number,
  chunkTop: number,
  scale: number
): number {
  return Math.round((pageTop - chunkTop) * scale);
}

/** 页切片计划（设备 px，纯函数）：每页源竖片 [sy, sy+sh) 按变高页拼接——
 *  sh = 页内容高（非末页 = 下页 top − 本页 top；末页 = bottom − top）。
 *  若每页取满 contentHeightPx（窗口 [top, top+H)），变高页窗口互相重叠：
 *  重叠区内容跨页重复、页底缘切在下页开头内容上（HX P-β 补全：拼接语义
 *  零缝隙零重叠，短页尾部由页画布背景填充）。满页时与定高网格一致。 */
export function pageSlicePlan(
  chunk: PageWindow[],
  chunkTop: number,
  scale: number
): Array<{ sy: number; sh: number }> {
  const edge = (y: number): number => Math.round((y - chunkTop) * scale);
  return chunk.map((p, i) => {
    const sy = edge(p.top);
    const end = i + 1 < chunk.length ? edge(chunk[i + 1].top) : edge(p.bottom);
    return { sy, sh: Math.max(end - sy, 0) };
  });
}

/** 窗口相交判定（纯函数）：块区间 [top, bottom) 与窗口 [wTop, wBottom)
 *  有重叠则保留（骑线块必须保留——分页刀口可能落在块内部）。 */
export function blockIntersectsWindow(
  top: number,
  bottom: number,
  wTop: number,
  wBottom: number,
  eps = 1
): boolean {
  return top < wBottom - eps && bottom > wTop + eps;
}

/** 块的「首个流内块级后代」锚点（HX P-δ）：沿首个非 inline、非浮动、
 *  非 absolute 的子元素下钻（塌缩链只经这条路径穿透块顶）。锚点的位移
 *  ＝该块内容的整体位移，供 trim 后实测回拨。无合格子级时回落到自身。 */
function anchorOf(el: HTMLElement, win: Window): HTMLElement {
  let e = el;
  for (let depth = 0; depth < 32; depth++) {
    let next: HTMLElement | null = null;
    for (const c of Array.from(e.children)) {
      const cs = win.getComputedStyle(c);
      if (cs.position !== "static" || cs.float !== "none" || cs.display.startsWith("inline")) {
        continue;
      }
      next = c as HTMLElement;
      break;
    }
    if (!next) return e;
    e = next;
  }
  return e;
}

interface RasterizeArgs {
  contentWidthPx: number;
  contentHeightPx: number;
  scale: number;
  fragments: TextFragment[];
  assembler: Awaited<ReturnType<typeof createPdfAssembler>>;
  signal?: AbortSignal;
  onProgress: (done: number, total: number, note?: string) => void;
  onPagePng?: (index: number, dataUrl: string) => void;
}

/** 分块序列化裁剪句柄：抓取 content 顶层子元素的原位坐标，按块暂存/还原。 */
class ChunkTrim {
  private kids: HTMLElement[] = [];
  private tops: number[] = [];
  private savedCss: string[] = [];
  private staging: DocumentFragment;
  private detached = false;
  /** 每 kid 的「首个流内块级后代」锚点原位 top（HX P-δ）。 */
  private anchorTops: number[] = [];

  constructor(
    private content: HTMLElement
  ) {
    this.staging = content.ownerDocument!.createDocumentFragment();
    // 快照必须在任何裁剪前完成：rect 相对 content 盒（与分页/文本素材同坐
    // 标系）。此后仅由裁剪自身改结构，坐标不再依赖回流。
    const base = content.getBoundingClientRect();
    const win = content.ownerDocument!.defaultView!;
    this.kids = Array.from(content.children) as HTMLElement[];
    this.tops = this.kids.map((k) => k.getBoundingClientRect().top - base.top);
    this.savedCss = this.kids.map((k) => k.style.cssText);
    this.anchorTops = this.kids.map((k, i) => {
      const t = anchorOf(k, win).getBoundingClientRect().top - base.top;
      return Number.isFinite(t) ? t : this.tops[i];
    });
  }

  get kidTops(): number[] {
    return this.tops;
  }

  /** 应用到窗口 [wTop, wBottom)：窗口外块暂存，窗口内块绝对定位到原坐标。 */
  apply(wTop: number, wBottom: number): void {
    const n = this.kids.length;
    const inWindow: number[] = [];
    for (let i = 0; i < n; i++) {
      const top = this.tops[i];
      // 区间语义与 measureBlocks 一致：高度覆盖到下一块顶。
      const bottom = i + 1 < n ? this.tops[i + 1] : top + this.kids[i].getBoundingClientRect().height;
      if (!blockIntersectsWindow(top, bottom, wTop, wBottom)) {
        this.staging.appendChild(this.kids[i]);
        continue;
      }
      inWindow.push(i);
      const k = this.kids[i];
      // 绝对定位：top 为 margin 盒顶——margin 归零并入 top，border 盒精确
      // 落在原坐标（rect 即 border 盒）。left/right:0 钉住流宽度。
      k.style.position = "absolute";
      k.style.top = `${top}px`;
      k.style.left = "0";
      k.style.right = "0";
      k.style.margin = "0";
      k.style.bottom = "auto";
    }
    this.detached = true;
    // HX P-δ：绝对定位盒的 margin 不与子级塌缩——原本「塌缩穿透到盒外」
    // 的首行链 margin（列表/引用常见 16px）会在盒内重新生效，把该块全部
    // 内容推低同样距离（密度档实测 +16px，页窗刀口按测量布局落位 → 切字）。
    // 按锚点实测回拨：内容几何还原为测量面（有涂装盒自带 padding 分隔塌缩
    // 不会漂移，回拨量自然为 0）。
    void this.content.scrollHeight;
    const base = this.content.getBoundingClientRect();
    const win = this.content.ownerDocument!.defaultView!;
    const adjust: Array<{ k: HTMLElement; top: number }> = [];
    for (const i of inWindow) {
      const k = this.kids[i];
      const anchorNow = anchorOf(k, win).getBoundingClientRect().top - base.top;
      const delta = anchorNow - this.anchorTops[i];
      if (Math.abs(delta) > 0.5) adjust.push({ k, top: this.tops[i] - delta });
    }
    for (const a of adjust) a.k.style.top = `${a.top}px`;
  }

  /** 按原序全量还原（appendChild 移动既有节点，无克隆；还原后一次回流）。 */
  restore(): void {
    if (!this.detached) return;
    for (let i = 0; i < this.kids.length; i++) {
      this.content.appendChild(this.kids[i]);
      this.kids[i].style.cssText = this.savedCss[i];
    }
    this.detached = false;
  }
}

async function rasterizeAndAssemble(
  handle: RenderFactoryHandle,
  pages: PageWindow[],
  a: RasterizeArgs
): Promise<void> {
  const doc = handle.doc;
  const content = handle.content;
  const runsPerPage = fragmentsToPageRuns(a.fragments, pages, a.contentHeightPx);
  // 内存护栏：整本解码位图预算超限 → JPEG 档（视觉质量权衡记录于结题
  // 报告 Q3；未拍板清单含「阈值与质量参数」）。
  const pagePx = a.contentWidthPx * a.scale * a.contentHeightPx * a.scale;
  const useJpeg = pages.length * pagePx * 4 > JPEG_GUARD_BYTES;

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

  const trim = new ChunkTrim(content);
  try {
    for (let start = 0; start < pages.length; start += perChunk) {
      if (a.signal?.aborted) throw new DOMException("导出已取消", "AbortError");
      const chunk = pages.slice(start, start + perChunk);
      const chunkTop = chunk[0].top;
      const chunkBottom = chunk[chunk.length - 1].top + a.contentHeightPx;
      // chunk 窗口高 = 实际跨度（变高页下小于 contentHeight×页数——网格
      // 高度只会在尾部多出空白画布，无内容意义）。
      const chunkSpan = chunkBottom - chunkTop;
      win.style.height = `${chunkSpan}px`;
      content.style.transform = `translateY(${-chunkTop}px)`;
      trim.apply(chunkTop, chunkBottom);
      // 平移后布局收帧：不依赖 rAF（后台/被遮挡窗口的 rAF 会被暂停，
      // 挂死导出——见 exportRenderFactory 同款注释）——强制同步布局读 +
      // 双定时器翻两轮事件循环。
      void content.scrollHeight;
      await new Promise((res) => setTimeout(res, 0));
      void content.scrollHeight;
      await new Promise((res) => setTimeout(res, 0));
      const dataUrl = await domToPng(win, {
        width: a.contentWidthPx,
        height: chunkSpan,
        scale: a.scale,
        backgroundColor: bg,
      });
      trim.restore();
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const plan = pageSlicePlan(chunk, chunkTop, a.scale);
      for (let i = 0; i < chunk.length; i++) {
        const pageIndex = start + i;
        pageCtx.fillRect(0, 0, pw, ph);
        pageCtx.drawImage(
          img,
          0,
          plan[i].sy,
          img.width,
          plan[i].sh,
          0,
          0,
          pw,
          plan[i].sh
        );
        const pageDataUrl = pageCanvas.toDataURL(
          useJpeg ? "image/jpeg" : "image/png",
          0.92
        );
        a.onPagePng?.(pageIndex, pageDataUrl);
        const bytes = dataUrlToBytes(pageDataUrl);
        await a.assembler.addPage(
          { bytes, mime: useJpeg ? "image/jpeg" : "image/png" },
          runsPerPage[pageIndex]
        );
        a.onProgress(pageIndex + 1, pages.length);
      }
      // 即弃：分块位图与解码图随下一轮 GC；显式断引用帮助引擎回收。
      img.src = "";
    }
  } finally {
    trim.restore();
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

// ---------------------------------------------------------------------------
// 调试 A/B（EX 阶段六，裁剪语义决定性判定）：同一工厂内把同一批页光栅化三
// 遍——trim1（现行为：ChunkTrim 裁剪）→ stream（修复前行为：窗口 +
// translateY 不裁剪，含全量克隆成本）→ trim2（trim 对照二跑，夹住 stream
// 检出 renderer 状态污染）。行墨量剖面互相关定位移滞后与残差，块顶对原位
// 基准（measureBlocks/文本层同坐标系）取差。仅 perf 驱动（__exportDebug.
// rasterAb），不进默认导出路径；结论落 docs/export-overhaul-report.md §4。
// ---------------------------------------------------------------------------

export interface RasterAbOptions {
  paper?: PdfPaperId;
  marginMm?: number;
  rasterScale?: number;
  /** 参与对比的连续页数（从第 0 页起）。默认 3。 */
  pageCount?: number;
  /** 行剖面互相关搜索的最大滞后（CSS px 双侧；设备像素 = ×scale）。默认 24。 */
  maxLagPx?: number;
  /** 各变体页位图回调（perf 落盘人工比对；同一变体内按页序调用）。 */
  onPng?: (variant: "trim1" | "stream" | "trim2", index: number, dataUrl: string) => void;
  /** 阶段遥测（factory/measure/{variant}:start|done；挂点定位用）。 */
  onStage?: (stage: string, ms?: number) => void;
}

export interface RasterAbRectDiff {
  /** 首块顶差（margin 逃逸类偏移直接可见）。 */
  first: number;
  maxAbs: number;
  meanAbs: number;
  /** 参与统计的块数（窗口内且已连接）。 */
  count: number;
}

export interface RasterAbPage {
  page: number;
  ink: { trim1: number; stream: number; trim2: number };
  /** 行剖面最优滞后（CSS px；正 = 后者内容更靠下）。 */
  lagPx: { streamVsTrim1: number; trim1VsTrim2: number };
  /** 最优滞后处 Pearson r（1 = 剖面全等；残差视角 = 1−r）。 */
  corr: { streamVsTrim1: number; trim1VsTrim2: number };
}

export interface RasterAbResult {
  pages: number;
  scale: number;
  contentWidthPx: number;
  contentHeightPx: number;
  /** 变体布局对原位基准的块顶差（px）。 */
  rectDiff: { stream: RasterAbRectDiff; trim: RasterAbRectDiff };
  perPage: RasterAbPage[];
  timings: Record<string, number>;
}

/**
 * 行剖面互相关（纯函数）：在 ±maxLag 整数滞后内找 Pearson r 最优处。
 * 约定：b[y+lag] ≈ a[y]，lag > 0 = b 内容比 a 靠下 lag px。
 */
export function pearsonBestLag(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  maxLag: number
): { lag: number; r: number } {
  const n = Math.min(a.length, b.length);
  let best = { lag: 0, r: -2 };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const y0 = Math.max(0, -lag);
    const y1 = Math.min(n, n - lag);
    const m = y1 - y0;
    if (m < 8) continue; // 重叠过短：相关无意义
    let sa = 0;
    let sb = 0;
    for (let y = y0; y < y1; y++) {
      sa += a[y];
      sb += b[y + lag];
    }
    const ma = sa / m;
    const mb = sb / m;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let y = y0; y < y1; y++) {
      const va = a[y] - ma;
      const vb = b[y + lag] - mb;
      num += va * vb;
      da += va * va;
      db += vb * vb;
    }
    const den = Math.sqrt(da * db);
    if (den <= 0) continue;
    const r = num / den;
    if (r > best.r) best = { lag, r };
  }
  return best.r === -2 ? { lag: 0, r: 0 } : best;
}

interface RasterAbVariantOutput {
  pngs: string[];
  profiles: Float64Array[];
  inks: number[];
  rectDiff: RasterAbRectDiff;
}

export async function runPdfRasterAb(
  html: string,
  css: string,
  o: RasterAbOptions = {}
): Promise<RasterAbResult> {
  const paper = PDF_PAPERS[o.paper ?? "A4"];
  const marginPt = mmToPt(o.marginMm ?? 15);
  const scale = o.rasterScale ?? 2;
  const contentWidthPx = Math.round((paper.widthPt - 2 * marginPt) / PT_PER_PX);
  const contentHeightPx = Math.round((paper.heightPt - 2 * marginPt) / PT_PER_PX);
  const t: Record<string, number> = { factory: 0, measure: 0, trim1: 0, stream: 0, trim2: 0 };
  let t0 = performance.now();
  const handle = await renderInFactory(html, {
    contentWidthPx,
    css,
    maxImageHeightPx: contentHeightPx,
  });
  t.factory = performance.now() - t0;
  o.onStage?.("factory", t.factory);
  try {
    t0 = performance.now();
    const blocks = measureBlocks(handle);
    const paginated = paginateBlocks(blocks, contentHeightPx);
    t.measure = performance.now() - t0;
    o.onStage?.("measure", t.measure);
    const pageCount = Math.min(Math.max(o.pageCount ?? 3, 1), paginated.pages.length);
    const pages = paginated.pages.slice(0, pageCount);

    // 原位基准：与 measureBlocks/collectTextFragments 同坐标系（content 盒）。
    const content = handle.content;
    const doc = handle.doc;
    const base0 = content.getBoundingClientRect();
    const kids = Array.from(content.children) as HTMLElement[];
    const origTops = kids.map((k) => k.getBoundingClientRect().top - base0.top);

    const { domToPng } = await import("modern-screenshot");
    const bg =
      doc.defaultView?.getComputedStyle(doc.documentElement).backgroundColor || "#ffffff";
    const chunkTop = pages[0].top;
    const chunkBottom = pages[pages.length - 1].top + contentHeightPx;
    const W = Math.round(contentWidthPx * scale);
    const H = Math.round(contentHeightPx * scale);

    // 单变体：win 组装（与 rasterizeAndAssemble 同序）→ 可选裁剪 → 收帧 →
    // 矩形采样 → 出图 → 逐页剖面 → 还原。裁剪变体的 ChunkTrim 构造时机与
    // 生产一致（content 移入 win 之后）。
    const runVariant = async (
      label: "trim1" | "stream" | "trim2",
      useTrim: boolean
    ): Promise<RasterAbVariantOutput> => {
      o.onStage?.(`${label}:start`);
      const parent = content.parentNode as Node;
      const next = content.nextSibling;
      const win = doc.createElement("div");
      win.style.cssText = `overflow:hidden;position:relative;width:${contentWidthPx}px;`;
      parent.insertBefore(win, content);
      win.appendChild(content);
      content.style.position = "relative";
      win.style.height = `${contentHeightPx * pages.length}px`;
      content.style.transform = `translateY(${-chunkTop}px)`;
      const trim = useTrim ? new ChunkTrim(content) : null;
      try {
        trim?.apply(chunkTop, chunkBottom);
        // 收帧：与生产同款（双 setTimeout + 强制布局读，不依赖 rAF）。
        void content.scrollHeight;
        await new Promise((res) => setTimeout(res, 0));
        void content.scrollHeight;
        await new Promise((res) => setTimeout(res, 0));
        // 矩形采样（相对 content 盒；translateY 对基差相消）。裁剪变体中
        // 被暂存的窗口外块不连接，跳过。
        const base = content.getBoundingClientRect();
        const diffs: number[] = [];
        let first = 0;
        for (let i = 0; i < kids.length; i++) {
          const el = kids[i];
          if (!el.isConnected) continue;
          const top = el.getBoundingClientRect().top - base.top;
          const d = top - origTops[i];
          if (i === 0) first = d;
          if (!blockIntersectsWindow(origTops[i], origTops[i] + 1e-6, chunkTop, chunkBottom))
            continue;
          diffs.push(d);
        }
        const rectDiff: RasterAbRectDiff = {
          first,
          maxAbs: diffs.length ? Math.max(...diffs.map(Math.abs)) : 0,
          meanAbs: diffs.length
            ? diffs.reduce((s, d) => s + Math.abs(d), 0) / diffs.length
            : 0,
          count: diffs.length,
        };
        const dataUrl = await domToPng(win, {
          width: contentWidthPx,
          height: contentHeightPx * pages.length,
          scale,
          backgroundColor: bg,
        });
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const pageCanvas = doc.createElement("canvas");
        pageCanvas.width = W;
        pageCanvas.height = H;
        const ctx = pageCanvas.getContext("2d");
        if (!ctx) throw new Error("无法创建页画布（2D 上下文不可用）");
        const pngs: string[] = [];
        const profiles: Float64Array[] = [];
        const inks: number[] = [];
        for (let i = 0; i < pages.length; i++) {
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, W, H);
          ctx.drawImage(img, 0, i * H, W, H, 0, 0, W, H);
          const data = ctx.getImageData(0, 0, W, H).data;
          // 行墨量：对页角背景色的逐通道偏差（任意主题底色通用）。
          const bgR = data[0];
          const bgG = data[1];
          const bgB = data[2];
          const profile = new Float64Array(H);
          for (let y = 0; y < H; y++) {
            let ink = 0;
            const row = y * W * 4;
            for (let x = 0; x < W; x++) {
              const p = row + x * 4;
              ink +=
                Math.abs(data[p] - bgR) + Math.abs(data[p + 1] - bgG) + Math.abs(data[p + 2] - bgB);
            }
            profile[y] = ink / W;
          }
          profiles.push(profile);
          inks.push(profile.reduce((s, v) => s + v, 0) / H);
          if (o.onPng) {
            const png = pageCanvas.toDataURL("image/png");
            pngs.push(png);
            o.onPng(label, i, png);
          }
        }
        img.src = "";
        return { pngs, profiles, inks, rectDiff };
      } finally {
        trim?.restore();
        // 归位到原插槽 + 清内联样式：下一变体从原位布局开始。
        try {
          parent.insertBefore(content, next);
          win.remove();
        } catch {
          /* 已随 iframe 销毁 */
        }
        content.style.position = "";
        content.style.transform = "";
      }
    };

    t0 = performance.now();
    const trim1 = await runVariant("trim1", true);
    t.trim1 = performance.now() - t0;
    o.onStage?.("trim1:done", t.trim1);
    t0 = performance.now();
    const stream = await runVariant("stream", false);
    t.stream = performance.now() - t0;
    o.onStage?.("stream:done", t.stream);
    t0 = performance.now();
    const trim2 = await runVariant("trim2", true);
    t.trim2 = performance.now() - t0;
    o.onStage?.("trim2:done", t.trim2);

    const maxLag = Math.round((o.maxLagPx ?? 24) * scale);
    const perPage: RasterAbPage[] = pages.map((_, i) => {
      const sT = pearsonBestLag(stream.profiles[i], trim1.profiles[i], maxLag);
      const tT = pearsonBestLag(trim1.profiles[i], trim2.profiles[i], maxLag);
      return {
        page: i,
        ink: { trim1: trim1.inks[i], stream: stream.inks[i], trim2: trim2.inks[i] },
        lagPx: {
          streamVsTrim1: sT.lag / scale,
          trim1VsTrim2: tT.lag / scale,
        },
        corr: { streamVsTrim1: sT.r, trim1VsTrim2: tT.r },
      };
    });
    return {
      pages: pageCount,
      scale,
      contentWidthPx,
      contentHeightPx,
      rectDiff: { stream: stream.rectDiff, trim: trim1.rectDiff },
      perPage,
      timings: t,
    };
  } finally {
    handle.destroy();
  }
}
