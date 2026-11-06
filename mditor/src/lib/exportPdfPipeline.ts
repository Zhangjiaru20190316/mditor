// PDF 自研管线（EX 轮阶段三原型 / 阶段四全量落地）：离屏工厂 → 块测量 →
// 分页器 → 分块光栅 → pdf-lib 组装（位图 + 可选隐形文本层）。
//
// 全链路应用内完成（用户铁律）：无 OS 打印对话框、不调用 webview 的
// print；唯一系统交互是调用方的 pickSaveFile。进度事件贯穿各阶段、
// AbortSignal 可取消、工厂 iframe/画布/中间位图随分块即弃（T2：峰值受
// 画布预算约束）。铁律锚点（PI2 加强版）：全仓零 print 调用字面量——
// webview 打印已于 EX 轮整体退役且 PI2 应用内打印不复活它，见
// printIronRule.test.ts。
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
  type LatinFontBytes,
  type PdfAssembleInfo,
  type PdfTextRun,
} from "./exportPdfAssembly";
import {
  CJK_VARIANT,
  decideTextVectorization,
  isLatinScript,
  parseCssColor,
  runVariants,
  type RunFontVariant,
} from "./exportVectorText";
import { decorationsToPageDecos, type PageDeco } from "./exportVectorDecor";
import {
  mergeRectsVertically,
  patchWindowSeg,
  patchesToPagePlacements,
  type PatchSource,
} from "./exportVectorPatch";

// 纸张/边距值域单一事实源已抽至零依赖模块（store.ts 首屏路径共用）；此处
// re-export 维持既有导入方（PrintDialog/exporter 等）不动。
export { PDF_PAPERS, PDF_MARGIN_CHOICES, PDF_PAPER_IDS } from "./pdfPaperValues";
export type { PdfPaperId } from "./pdfPaperValues";

import { PDF_PAPERS, type PdfPaperId } from "./pdfPaperValues";

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
/** Inter 拉丁变体（RVF 阶段一；OFL 见 public/assets/fonts/INTER-OFL.txt）。
 *  正文档取 Medium 而非 Regular：Inter Regular 为高分辨率屏设计，12pt 下
 *  stem/em=0.088（实测渲染墨量仅 NotoSansSC 拉丁的 43%）——比被替换的
 *  Noto 更细，F1 不收敛反恶化；Medium（stem/em=0.107，墨量 ≈Noto×1.38）
 *  才对齐编辑器 Segoe UI 的低 DPI 屏显墨量。Bold 档同族 Bold（≈Noto 干宽）。 */
const LATIN_FONT_URLS = {
  regular: (import.meta.env.BASE_URL ?? "/") + "assets/fonts/Inter-Medium.ttf",
  bold: (import.meta.env.BASE_URL ?? "/") + "assets/fonts/Inter-Bold.ttf",
  italic: (import.meta.env.BASE_URL ?? "/") + "assets/fonts/Inter-MediumItalic.ttf",
  boldItalic:
    (import.meta.env.BASE_URL ?? "/") + "assets/fonts/Inter-BoldItalic.ttf",
} as const;

export interface PdfExportProgress {
  stage: "factory" | "measure" | "paginate" | "text" | "raster" | "assemble";
  done: number;
  total: number;
  note?: string;
}

export interface PdfPipelineOptions {
  paper?: PdfPaperId;
  /** 页面方向（PI2 打印对话框）：landscape = 宽高交换（版心随之变宽变矮）。
   *  缺省 portrait——导出路径不传该参数，行为与既往逐字节一致。 */
  orientation?: "portrait" | "landscape";
  /** 四边统一边距（mm）。 */
  marginMm?: number;
  /** 光栅倍率（1/1.5/2 = 96/144/192dpi 等效）。 */
  rasterScale?: number;
  /** 隐形文本层开关（EX-P 拍板前原型位；false = 纯光栅）。 */
  textLayer?: boolean;
  /** 导出模式（RV 轮）：vector = 文字矢量绘制（默认）；raster = 旧满铺
   *  位图 + Tr 3 影子层。矢量路径任何阶段失败自动整体回退 raster。 */
  mode?: "vector" | "raster";
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
    /** 本次是否横向（PI2；portrait 缺省时也回填，便于消费方直读）。 */
    orientation: "portrait" | "landscape";
    contentWidthPx: number;
    contentHeightPx: number;
    rasterScale: number;
    paginate: ReturnType<typeof paginateBlocks>["stats"];
    assemble: PdfAssembleInfo;
    textFragments: number;
    /** 矢量化覆盖统计（RV 轮：结题报告的降级占比口径）。 */
    textPlan?: TextPlanStats;
    /** 局部补丁统计（RV 阶三：块/行内/残留补丁数 + 原生图片数）。 */
    patchPlan?: {
      blockPatches: number;
      inlinePatches: number;
      residualPatches: number;
      nativeImages: number;
    };
    /** 本次导出是否真正走了矢量文本路径（字体缺位/回退时为 false）。 */
    vectorMode?: boolean;
    /** 矢量路径失败 → raster 重跑的原因（成功时缺省）。 */
    vectorFallback?: string;
    timings: Record<string, number>;
  };
}

/** mm → pt。 */
export const mmToPt = (mm: number): number => (mm * 72) / 25.4;

/**
 * 管线入口（RV 轮起带模式分发）：vector（默认）= 文本矢量绘制 + 位图只承载
 * 装饰/降级域；raster = 旧满铺位图 + Tr 3 影子层。矢量路径任何阶段失败
 * （AbortError 除外）自动整体回退 raster 重跑——绝不丢导出，回退原因入 meta。
 */
/** modern-screenshot 样式内联白名单（EX 优化轮 #4）：默认逐元素 diff 全量
 * ~350 个计算样式属性（每属性一次 getPropertyValue + Map 写 + 多数一次
 * clone 上的 setProperty），公式密集文档里克隆阶段 90% 耗时来自这里。工厂
 * 文档的视觉面完全由受控 CSS（主题 + EXPORT_PROSE_CSS + KaTeX）决定， paint/layout
 * 相关属性收口到本清单即保持渲染等价（页面 PNG 哈希回归验证）。 */
export const MS_STYLE_PROPS: string[] = [
  // 排版
  "font", "font-family", "font-size", "font-style", "font-variant", "font-weight",
  "font-feature-settings", "font-kerning", "font-stretch", "font-synthesis",
  "letter-spacing", "word-spacing", "line-height", "line-break", "text-align",
  "text-align-last", "text-indent", "text-justify", "text-overflow",
  "text-rendering", "text-shadow", "text-transform", "text-decoration-line",
  "text-decoration-style", "text-decoration-color", "text-decoration-thickness",
  "text-underline-offset", "text-underline-position", "white-space", "word-break",
  "overflow-wrap", "word-wrap", "vertical-align", "color", "tab-size", "hyphens",
  "direction", "unicode-bidi", "writing-mode", "orphans", "widows",
  "-webkit-text-fill-color", "-webkit-text-stroke-color", "-webkit-text-stroke-width",
  "-webkit-font-smoothing", "-webkit-rtl-ordering",
  // 盒模型 / 定位
  "display", "position", "top", "right", "bottom", "left", "width", "height",
  "min-width", "min-height", "max-width", "max-height", "margin-top",
  "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right",
  "padding-bottom", "padding-left", "box-sizing", "aspect-ratio", "float",
  "clear", "z-index", "isolation", "overflow", "overflow-x", "overflow-y",
  "visibility", "opacity", "transform", "transform-origin", "transform-box",
  "translate", "rotate", "scale", "clip", "clip-path", "contain",
  "content-visibility", "inset-block-start", "inset-inline-start",
  // 弹性 / 网格
  "flex", "flex-basis", "flex-direction", "flex-flow", "flex-grow", "flex-shrink",
  "flex-wrap", "gap", "row-gap", "column-gap", "order", "align-content",
  "align-items", "align-self", "justify-content", "justify-items",
  "justify-self", "place-content", "place-items", "place-self", "grid",
  "grid-area", "grid-auto-columns", "grid-auto-flow", "grid-auto-rows",
  "grid-column", "grid-row", "grid-template", "grid-template-areas",
  "grid-template-columns", "grid-template-rows",
  // 边框 / 背景 / 阴影（含 -x/-y 长名）
  "border", "border-width", "border-style", "border-color", "border-top",
  "border-right", "border-bottom", "border-left", "border-top-width",
  "border-top-style", "border-top-color", "border-right-width",
  "border-right-style", "border-right-color", "border-bottom-width",
  "border-bottom-style", "border-bottom-color", "border-left-width",
  "border-left-style", "border-left-color", "border-image", "border-radius",
  "border-top-left-radius", "border-top-right-radius",
  "border-bottom-right-radius", "border-bottom-left-radius",
  "background", "background-color", "background-image", "background-position",
  "background-position-x", "background-position-y", "background-size",
  "background-repeat", "background-origin", "background-clip",
  "background-attachment", "background-blend-mode", "box-shadow", "outline",
  "outline-width", "outline-style", "outline-color", "outline-offset",
  // 表格 / 列表 / 嵌入
  "border-collapse", "border-spacing", "table-layout", "empty-cells",
  "caption-side", "list-style", "list-style-type", "list-style-position",
  "list-style-image", "object-fit", "object-position", "image-rendering",
  "mix-blend-mode", "filter", "backdrop-filter", "will-change",
  "columns", "column-count", "column-width", "column-rule",
  "-webkit-line-clamp", "-webkit-box-orient", "-webkit-box-align",
  "-webkit-box-direction", "-webkit-box-pack",
];

// ---------------------------------------------------------------------------
// 直连 foreignObject 光栅（EX 优化轮 #8）：
//
// modern-screenshot 的 domToCanvas 对窗口子树做「逐元素 getComputedStyle diff
// + 内联到克隆」——公式密集文档每 chunk 数千元素，克隆阶段独占 serialize
// 耗时的大头（探针实测 5.1s/chunk）。工厂文档是受控环境：全部样式来自注入
// 的 <style>（主题 CSS + EXPORT_PROSE_CSS + 工厂版式 CSS），没有任何外部
// 样式表。因此把同一份样式表文本内嵌进 SVG，让 SVG 引擎自己解析选择器，
// DOM 用原生 cloneNode(true)（零样式计算）+ XMLSerializer 产出合法 XML。
// 字体 URL → data URL（SVG-as-image 拦截外链资源；会话级缓存）。
//
// 仅 vector 模式启用：该模式位图只承载补丁（公式/代码块），原生图已被
// visibility:hidden（外链 img 在 SVG-image 中被拦截也无视觉影响）；raster
// 模式整页入图、可能含未内联的外链图片，继续走 domToCanvas（它会抓取并
// 内联图片资源）。任何异常逐 chunk 回退 domToCanvas，绝不丢导出。
// ---------------------------------------------------------------------------

const FONT_DATA_URL_CACHE = new Map<string, string>();
const FONT_DATA_URL_CACHE_CAP = 64;

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** 样式表里的字体 URL 全部内嵌为 data URL（SVG-as-image 无外链权限）。 */
async function inlineCssFontUrls(css: string, baseUri: string): Promise<string> {
  const jobs: Array<Promise<void>> = [];
  const resolved = new Map<string, string>();
  let failed = 0;
  CSS_URL_RE.lastIndex = 0;
  for (const m of css.matchAll(CSS_URL_RE)) {
    const u = m[2];
    if (u.startsWith("data:") || resolved.has(u)) continue;
    // 只内联 woff2（EX 复审 P1）：@font-face 的 src 声明 woff2/woff/ttf 多候
    // 选时浏览器只取首个支持的候选（Chromium 恒 woff2），全量内联 = SVG 载荷
    // ~3 倍白背（ttf 单文件远大于 woff2）。其余候选留在原样，不会被用到；
    // 与 exportMath.ts inlineKatexFonts 同一既定模式。代价：仅发布 ttf/woff
    // 的字体面不内联（SVG 内退回系统字体）——KaTeX 与主题字体均 woff2 首发。
    if (!/\.woff2([?#]|$)/i.test(u)) continue;
    resolved.set(u, m[0]); // 先占位：失败时保留原 url()
    jobs.push(
      (async () => {
        if (FONT_DATA_URL_CACHE.has(u)) {
          resolved.set(u, `url("${FONT_DATA_URL_CACHE.get(u)}")`);
          return;
        }
        try {
          const abs = new URL(u, baseUri);
          const res = await fetch(abs.href);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const dataUrl = await blobToDataUrl(await res.blob());
          if (FONT_DATA_URL_CACHE.size >= FONT_DATA_URL_CACHE_CAP) {
            const first = FONT_DATA_URL_CACHE.keys().next().value;
            if (first !== undefined) FONT_DATA_URL_CACHE.delete(first);
          }
          FONT_DATA_URL_CACHE.set(u, dataUrl);
          resolved.set(u, `url("${dataUrl}")`);
        } catch {
          /* 失败向上聚合（见下）：工厂里该面已 loaded（渲染正常），SVG 内却
           * 会被外链拦截退系统字体——保留 url() 的「同语义」并不成立。 */
          failed++;
        }
      })()
    );
  }
  if (jobs.length === 0) return css;
  await Promise.all(jobs);
  // 任一保留面内联失败 → 抛出让调用方整程回退 domToCanvas（EX 复审 P2-3：
  // 静默降级 = 直连路径字形退化且 directOk 仍真，宁走慢路不走错路）。
  if (failed > 0) throw new Error(`direct 字体内联失败 ${failed} 处`);
  // 替换回调直接用捕获组（正则组 2 = 裸 URL）——不要从 whole 反解：URL 里
  // 允许的字符（如 path 段）会连 url( 前缀一起被捕进反解组，键永远对不上，
  // 内联静默失效（EX #8 复盘：fontFaces 20 / dataUri 0 的根因）。
  return css.replace(CSS_URL_RE, (whole, _q, u: string) => {
    const r = resolved.get(u);
    return r && r !== whole ? r : whole;
  });
}

/** 工厂文档样式表文本（style 元素全文）。选择器改写：SVG 上下文没有
 *  html/body 元素——body/html 规则（.vditor-reset 基础字号、版心宽度、
 *  主题背景/颜色）改写到包装类 .msvg-shim 上，由包装 div 携带（class=
 *  "vditor-reset msvg-shim"），继承链与工厂逐位对齐。只改选择器位置的
 *  token（前邻 ^/空白/{/},/>，后邻空白+选择器字符（含 * 与函数形 ( ）），
 *  属性值/URL 不受影响。字符集为防御性全集：当前 app CSS 无这些形态。 */
const HTML_BODY_SELECTOR_RE = /(^|[\s,{}>])(?:html|body)\b(?=\s*[ ,>+~.[:#{(*])/gm;
const MSVG_SHIM_CLASS = "msvg-shim";

/** 优化轮 #12：@font-face 按实际使用裁剪。KaTeX 声明 ~20 个字体面，典型
 *  文档只用其中一部分；每个 @font-face 的 base64 内联是直连 SVG 载荷主体，
 *  每 chunk 的 SVG 解码都重复解析全部字体。浏览器按需加载字体面——工厂
 *  文档 fonts.ready 后，status=loaded 的面 = 全文档用到的面的并集（超集
 *  覆盖任意 chunk 子窗口）。匹配按 family+weight+style 三元组；解析不出
 *  或匹配不到的规则一律保留（宁多勿缺，缺面 = 字体回退 = 像素变化）。 */
function pruneUnusedFontFaces(css: string, factoryDoc: Document): string {
  const normW = (w: string): string =>
    w === "bold" ? "700" : w === "normal" || w === "" ? "400" : w;
  const loaded = new Set<string>();
  try {
    factoryDoc.fonts?.forEach?.((f) => {
      if (f.status === "loaded") {
        loaded.add(
          `${f.family.replace(/^["']|["']$/g, "")}|${normW(String(f.weight))}|${f.style}`
        );
      }
    });
  } catch {
    return css; // 字体集不可枚举（旧引擎）：全量保留
  }
  if (loaded.size === 0) return css;
  let pruned = 0;
  const kept = css.replace(/@font-face\s*\{[^}]*\}/g, (rule) => {
    const fam = rule.match(/font-family:\s*([^;}]+)/i)?.[1]?.trim();
    if (!fam) return rule;
    const weight = normW(rule.match(/font-weight:\s*([^;}]*)/i)?.[1]?.trim() ?? "");
    const style = rule.match(/font-style:\s*([^;}]*)/i)?.[1]?.trim() || "normal";
    if (loaded.has(`${fam.replace(/^["']|["']$/g, "")}|${weight}|${style}`)) return rule;
    pruned++;
    return "";
  });
  return pruned > 0 ? kept : css;
}

export async function buildDirectRasterCss(
  factoryDoc: Document,
  baseUri: string
): Promise<string> {
  let css = "";
  for (const s of Array.from(factoryDoc.querySelectorAll("style"))) {
    css += s.textContent + "\n";
  }
  css = css.replace(HTML_BODY_SELECTOR_RE, `$1.${MSVG_SHIM_CLASS}`);
  css = pruneUnusedFontFaces(css, factoryDoc);
  return inlineCssFontUrls(css, baseUri);
}

// 优化轮 #10：cssInline（含 ~1MB 内联字体 base64）跨 chunk 恒定。若每 chunk
// 都把它塞进 <style> 再整段 encodeURIComponent，编码成本随 chunk 数线性放大。
// 改为：style 里放短标记，序列化后把标记（encodeURIComponent 后形态不变）拼接
// 成一次性编码并按 cssInline 字符串记忆的整段。标记含随机后缀防撞文档内容。
let DIRECT_CSS_ENC_CACHE: { css: string; encoded: string } | null = null;
const DIRECT_CSS_MARK = `__mditor_direct_css_${Math.random().toString(36).slice(2)}__`;

/** 直连光栅一个 chunk 窗口 → 画布（异常向上抛，调用方回退 domToCanvas；
 *  perf 探针亦直接调用）。 */
export async function rasterWindowDirect(
  win: HTMLElement,
  cssInline: string,
  widthCss: number,
  heightCss: number,
  scale: number,
  bg: string
): Promise<HTMLCanvasElement> {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const doc = win.ownerDocument!;
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(widthCss));
  svg.setAttribute("height", String(heightCss));
  const styleEl = doc.createElement("style");
  styleEl.textContent = DIRECT_CSS_MARK;
  svg.appendChild(styleEl);
  const fo = doc.createElementNS(SVG_NS, "foreignObject");
  fo.setAttribute("x", "0");
  fo.setAttribute("y", "0");
  fo.setAttribute("width", String(widthCss));
  fo.setAttribute("height", String(heightCss));
  const theme = doc.documentElement.getAttribute("data-theme") ?? "light";
  // 背景解析为不透明色：工厂 html 背景可为透明（var(--bg) 缺位）——透明
  // fillRect 是空操作，会把整页留成 alpha-0 黑底（flattened 视角全黑）。
  const bgParsed = parseCssColor(bg);
  const opaqueBg =
    bgParsed && bgParsed.a >= 1
      ? bg
      : (() => {
          const c = parseCssColor(
            doc.defaultView?.getComputedStyle(doc.body).backgroundColor || "#ffffff"
          );
          return c && c.a >= 1
            ? `rgb(${c.r},${c.g},${c.b})`
            : "#ffffff";
        })();
  const wrap = doc.createElement("div");
  wrap.setAttribute("data-theme", theme);
  wrap.setAttribute("class", `vditor-reset ${MSVG_SHIM_CLASS}`);
  // win 的窗口语义（overflow:hidden + 尺寸）以行内样式原样携带。
  wrap.setAttribute("style", `${win.style.cssText};background:${opaqueBg};`);
  wrap.appendChild(win.cloneNode(true));
  fo.appendChild(wrap);
  svg.appendChild(fo);
  const xml = new XMLSerializer().serializeToString(svg);
  // data URL 而非 blob URL（EX #10 复盘）：blob: SVG 经 <img> 绘入画布会
  // 污染画布（toDataURL 全程 SecurityError，实测 i11），data: 则按同源
  // 干净资源处理。encodeURIComponent 是必要成本——但样式表部分只付一次。
  if (!DIRECT_CSS_ENC_CACHE || DIRECT_CSS_ENC_CACHE.css !== cssInline) {
    // XML 文本转义后编码：拼接路径绕过了 XMLSerializer 的文本转义，CSS 里的
    // `&`（嵌套选择器）/`]]>` 会拼出非法 XML → 解码失败静默回退 ms 路径。
    // 转义后经 XML 解析还原为原字符，与整段序列化语义等价。
    DIRECT_CSS_ENC_CACHE = {
      css: cssInline,
      encoded: encodeURIComponent(
        cssInline.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      ),
    };
  }
  // 序列化产物里 style 节点形如 <style xmlns="…xhtml">__mditor_direct_css…</style>
  // （HTML 命名空间元素被 XMLSerializer 补 xmlns）。标记匹配在 raw XML 上做
  // （标记为 XML 文本安全字符集），命中则头/尾分别编码、中间拼缓存好的整段
  // CSS 编码——大字符串只编码一次。未命中（序列化形态变化）回退全量编码。
  const markMatch = xml.match(new RegExp(`<style[^>]*>${DIRECT_CSS_MARK}</style>`));
  let xmlEnc: string;
  if (markMatch?.index !== undefined) {
    const head = xml.slice(0, markMatch.index + markMatch[0].indexOf(`>${DIRECT_CSS_MARK}`) + 1);
    const tail = xml.slice(markMatch.index + markMatch[0].length - "</style>".length);
    xmlEnc = `${encodeURIComponent(head)}${DIRECT_CSS_ENC_CACHE.encoded}${encodeURIComponent(tail)}`;
  } else {
    styleEl.textContent = cssInline;
    xmlEnc = encodeURIComponent(new XMLSerializer().serializeToString(svg));
  }
  const dataUrl = `data:image/svg+xml;charset=utf-8,${xmlEnc}`;
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(widthCss * scale));
  canvas.height = Math.max(1, Math.round(heightCss * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("直连光栅：画布 2D 上下文不可用");
  ctx.fillStyle = opaqueBg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function runPdfPipeline(
  html: string,
  css: string,
  o: PdfPipelineOptions = {}
): Promise<PdfPipelineResult> {
  if (o.mode === "raster") {
    return runPdfPipelineOnce(html, css, o, false);
  }
  try {
    return await runPdfPipelineOnce(html, css, o, true);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    // 矢量失败兜底：完整重跑 raster（工厂/测量/分页全部重来——矢量路径可能
    // 已在 DOM 上做过透明化摘除，工厂必须重建）。
    const r = await runPdfPipelineOnce(html, css, o, false);
    return {
      ...r,
      meta: {
        ...r.meta,
        vectorFallback: String(e).slice(0, 200),
      },
    };
  }
}

async function runPdfPipelineOnce(
  html: string,
  css: string,
  o: PdfPipelineOptions,
  vector: boolean
): Promise<PdfPipelineResult> {
  const t: Record<string, number> = { factory: 0, measure: 0, paginate: 0, text: 0, raster: 0, assemble: 0 };
  const paper = PDF_PAPERS[o.paper ?? "A4"];
  // PI2 横向：页面与版心宽高交换（分页/工厂版心/组装器尺寸全部由此派生）。
  const orientation: "portrait" | "landscape" =
    o.orientation === "landscape" ? "landscape" : "portrait";
  const pageWidthPt = orientation === "landscape" ? paper.heightPt : paper.widthPt;
  const pageHeightPt = orientation === "landscape" ? paper.widthPt : paper.heightPt;
  const marginPt = mmToPt(o.marginMm ?? 15);
  const scale = o.rasterScale ?? 2;
  const contentWidthPt = pageWidthPt - 2 * marginPt;
  const contentHeightPt = pageHeightPt - 2 * marginPt;
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

    // ---- 4. 字体（懒加载；矢量模式下字体缺位 = 退化纯光栅，不做摘除）----
    let fontBytes: Uint8Array | null = null;
    const wantText = o.textLayer !== false;
    if (wantText) fontBytes = await loadFontBytes();
    const vectorActive = vector && wantText && !!fontBytes;
    // Inter 变体（缺位 = 拉丁 run 退主字体合成，CJK 主路径不受影响）。
    // raster 模式同样加载：影子层拉丁用 Inter 画（与 vector 可见层字形
    // bbox 一致，双模式抽取分词才一致）。
    const latinFontBytes = wantText ? await loadLatinFontBytes() : null;

    // ---- 5. 文本素材 + 补丁计划 + 块装饰（一次全量收集；textLayer=false 跳过）----
    t0 = performance.now();
    const subText: Record<string, number> = {};
    let ts0 = performance.now();
    const emptyHiding: DecorationHiding = { borderEls: [], quoteEls: [], bgEls: [], decorEls: [], imgEls: [] };
    const patchPlan = vectorActive ? collectPatchPlan(handle) : null;
    subText.patchPlan = performance.now() - ts0;
    // 字形覆盖检测（阶段四）：fontkit 直读全量字体，(codePoint) 级缓存。
    // 缺字形（emoji/特殊符号）→ 判定 no-glyph → 残留补丁兜底，绝不画 notdef。
    // RVF 阶段一双字体：拉丁域字符查 Inter（Regular 代表四变体覆盖面），
    // Inter 缺字形再查 Noto（拉丁回 CJK 域画 Noto 拉丁形）；两族皆缺才
    // 节点级 no-glyph。
    let glyphChecker: ((text: string) => boolean) | undefined;
    let latinGlyphCovered: ((cp: number) => boolean) | undefined;
    if (vectorActive && fontBytes) {
      try {
        const fontkitMod = (await import("@pdf-lib/fontkit")) as unknown as {
          default?: unknown;
        };
        const fontkit = (fontkitMod.default ?? fontkitMod) as {
          create: (b: Uint8Array) => {
            hasGlyphForCodePoint: (cp: number) => boolean;
          };
        };
        const gf = fontkit.create(fontBytes);
        const interGf =
          latinFontBytes?.regular ? fontkit.create(latinFontBytes.regular) : null;
        // 两族覆盖各自独立缓存（查询语义不同：拉丁覆盖只认 Inter；节点级
        // 判定认 Inter 或 Noto 任一——共享缓存会互相污染）。
        const coveredAny = new Map<number, boolean>();
        const coveredLatin = new Map<number, boolean>();
        const coveredIn = (
          f: { hasGlyphForCodePoint: (cp: number) => boolean } | null,
          cp: number
        ): boolean => !!f && !!f.hasGlyphForCodePoint(cp);
        latinGlyphCovered = interGf
          ? (cp: number): boolean => {
              let ok = coveredLatin.get(cp);
              if (ok === undefined) {
                ok = cp < 0x80 || coveredIn(interGf, cp);
                coveredLatin.set(cp, ok);
              }
              return ok;
            }
          : undefined;
        glyphChecker = (text: string): boolean => {
          for (const ch of Array.from(text)) {
            const cp = ch.codePointAt(0)!;
            let ok = coveredAny.get(cp);
            if (ok === undefined) {
              if (cp < 0x80) ok = true; // ASCII 直放
              else if (isLatinScript(ch) && interGf)
                ok = coveredIn(interGf, cp) || coveredIn(gf, cp);
              else ok = coveredIn(gf, cp);
              coveredAny.set(cp, ok);
            }
            if (!ok) return false;
          }
          return true;
        };
      } catch {
        glyphChecker = undefined; // 检测不可用：保守跳过检测
      }
    }
    ts0 = performance.now();
    const material = wantText
      ? collectTextMaterial(handle, {
          vector: vectorActive,
          patchPlan: patchPlan ?? undefined,
          glyphChecker,
          latinGlyphCovered,
        })
      : {
          fragments: [] as TextFragment[],
          vectorNodes: [] as Text[],
          hiding: emptyHiding,
          residualPatches: [] as PatchSource[],
          stats: {
            totalChars: 0, vectorChars: 0, shadowChars: 0, syntheticBoldChars: 0, syntheticItalicChars: 0, latinTrueVariantChars: 0, reasons: {} as Record<string, number>,
          },
        };
    subText.material = performance.now() - ts0;
    const fragments = material.fragments;
    ts0 = performance.now();
    const blockDecor = vectorActive ? collectBlockDecorations(handle) : null;
    subText.blockDecor = performance.now() - ts0;
    // 满铺位图退位（RV 阶三）：页底色改矢量矩形（内容盒同尺寸）。
    const patchSources: PatchSource[] = patchPlan
      ? [
          ...patchPlan.blockPatches,
          ...patchPlan.inlinePatches,
          ...material.residualPatches,
        ]
      : [];
    if (blockDecor) {
      blockDecor.rects.unshift({
        x: 0,
        y: 0,
        w: contentWidthPx,
        h: contentHeightPx,
        color: blockDecor.pageBg,
      });
    }
    t.text = performance.now() - t0;
    progress({ stage: "text", done: fragments.length, total: fragments.length });

    // ---- 6. 组装器 ----
    const assembler = await createPdfAssembler({
      pageWidthPt,
      pageHeightPt,
      marginPt: { top: marginPt, right: marginPt, bottom: marginPt, left: marginPt },
      contentWidthPx,
      contentHeightPx,
      fontBytes,
      latinFontBytes,
      title: o.title,
      vectorText: vectorActive,
    });

    // ---- 7. 分块光栅 + 逐页入册 ----
    t0 = performance.now();
    const subRaster: Record<string, number> = {};
    await rasterizeAndAssemble(handle, paginated.pages, {
      contentWidthPx,
      contentHeightPx,
      scale,
      fragments,
      vectorNodes: vectorActive ? material.vectorNodes : [],
      hiding: vectorActive
        ? [
            material.hiding,
            ...(blockDecor ? [blockDecor.hiding] : []),
            ...(patchPlan
              ? [{ ...emptyHiding, imgEls: patchPlan.imgEls } as DecorationHiding]
              : []),
          ]
        : [],
      blockDecor,
      patchSources: vectorActive ? patchSources : [],
      nativeImages: patchPlan?.nativeImages ?? [],
      vectorActive,
      assembler,
      signal,
      sub: subRaster,
      onProgress: (done, total, note) =>
        progress({ stage: "raster", done, total, note }),
      onPagePng: o.onPagePng,
    });
    t.raster = performance.now() - t0;

    // ---- 8. 落册 ----
    const bytes = await assembler.save();
    t.assemble = performance.now() - t0 - t.raster;
    for (const [k, v] of Object.entries(subText)) t[`text.${k}`] = v;
    for (const [k, v] of Object.entries(subRaster)) t[`raster.${k}`] = v;
    Object.assign(t, handle.timings ?? {});
    return {
      bytes,
      meta: {
        pages: paginated.stats.pages,
        paper: o.paper ?? "A4",
        orientation,
        contentWidthPx,
        contentHeightPx,
        rasterScale: scale,
        paginate: paginated.stats,
        assemble: assembler.info(),
        textFragments: fragments.length,
        textPlan: material.stats,
        patchPlan: patchPlan
          ? {
              blockPatches: patchPlan.stats.blockPatches,
              inlinePatches: patchPlan.stats.inlinePatches,
              residualPatches: material.residualPatches.length,
              nativeImages: patchPlan.stats.nativeImages,
            }
          : undefined,
        vectorMode: vectorActive,
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
    const m: KidMeasure = {
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
// 文本素材：全量收集文本片段（content 坐标 + 字体/字号/颜色 + 逐字符实测
// advance），页窗口过滤后映射为 PdfTextRun。advance 用工厂 iframe 的 canvas
// measureText（与布局同引擎同字体→位置按构造一致），(font,char) 级缓存。
//
// RV 轮矢量扩展（阶段一）：逐文本结点过 decideTextVectorization 判定——
// vector 片段记录颜色由组装器可见绘制，并在光栅前把该文本结点包进
// color:transparent 的 span（位图摘除，布局零扰动）；shadow 片段留位图视觉
// + Tr 3 影子层。块级降级域（公式/图/代码块所在顶层块）整体 shadow。
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
  /** 矢量绘制色（vector=true 时必有）。 */
  color?: { r: number; g: number; b: number };
  /** true = 矢量可见绘制；false/缺省 = 位图承载视觉 + Tr 3 影子（旧形态）。 */
  vector?: boolean;
  skipReason?: string;
  /** 合成加粗（阶段四：Tr 2 FillAndStroke + 细描边）。RVF 阶段一起仅对
   *  CJK 段生效。 */
  syntheticBold?: boolean;
  /** 合成斜体（阶段四：xSkew 剪切）。RVF 阶段一起仅对 CJK 段生效。 */
  syntheticItalic?: boolean;
  /** 逐字符字体变体（与 Array.from(text) 等长；vector 片段携带）。 */
  variants?: RunFontVariant[];
  /** 有效文本装饰线（最近带线祖先——传播语义近似；shadow 片段也记录：
   *  位图统一摘线后由矢量补画，加粗链接的线不丢）。 */
  decor?: { kinds: Array<"underline" | "line-through">; color: { r: number; g: number; b: number } };
  /** inline 背景提供者（mark 高亮等；混合粗体片段的底也不丢——rect 几何即片段盒）。 */
  bg?: { color: { r: number; g: number; b: number } };
}

export interface TextPlanStats {
  totalChars: number;
  vectorChars: number;
  shadowChars: number;
  /** 合成加粗/斜体字符数（阶段四覆盖口径；RVF 阶段一起为 CJK 域字符数）。 */
  syntheticBoldChars: number;
  syntheticItalicChars: number;
  /** 走 Inter 真变体的拉丁字符数（RVF 阶段一报告口径）。 */
  latinTrueVariantChars: number;
  reasons: Record<string, number>;
}

export interface TextMaterial {
  fragments: TextFragment[];
  /** 矢量文本结点（光栅前包 span 摘除位图墨迹用）。 */
  vectorNodes: Text[];
  /** 装饰遮蔽面（光栅期间对位图隐藏、由矢量补画的元素清单）。 */
  hiding: DecorationHiding;
  /** 残留影子文本的补丁源（非矢量化文字的行盒并集；满铺位图退位后由
   *  局部补丁承载其墨迹——粗体/斜体阶段四放开前的主要成分）。 */
  residualPatches: PatchSource[];
  stats: TextPlanStats;
}

/** 装饰遮蔽面：各元素要隐藏的视觉通道（还原用 cssText 快照）。 */
export interface DecorationHiding {
  /** 边框 → transparent（table/th/td/hr）。 */
  borderEls: HTMLElement[];
  /** 引用块：左竖条 + 底色。 */
  quoteEls: HTMLElement[];
  /** inline 背景（mark 高亮等，至少含一个矢量片段才隐藏）。 */
  bgEls: HTMLElement[];
  /** 装饰线（下划线/删除线绘制宿主）→ text-decoration-color transparent。 */
  decorEls: HTMLElement[];
  /** 原生嵌入图片 → visibility:hidden（保留布局，摘除位图墨迹）。 */
  imgEls: HTMLElement[];
}

interface FontMetrics {
  ascent: number;
  descent: number;
}

/** 块级降级域选择器（RV 阶三起不含 img——可原生嵌入的图不再拖垮整块，
 *  也不含 .katex——公式走行内补丁，不再把整个段落拖进位图）。 */
const RASTER_SCOPE_SELECTOR =
  "pre, svg, video, iframe, canvas, object, embed";

/** 原生嵌入判定：data URL 的 PNG/JPEG 才能走 embedPng/embedJpg。 */
function nativeEmbeddableSrc(src: string | null): "image/png" | "image/jpeg" | null {
  if (!src) return null;
  const m = src.match(/^data:(image\/(?:png|jpe?g));base64,/i);
  if (!m) return null;
  return /png/i.test(m[1]) ? "image/png" : "image/jpeg";
}

/** 原生嵌入图片描述（content 坐标）。 */
export interface NativeImageDesc {
  id: string;
  src: string;
  mime: "image/png" | "image/jpeg";
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 补丁计划（RV 阶段三）：块级/行内补丁源 + 原生图片 + 降级域集合。 */
export interface PatchPlan {
  /** 块级降级域（content 直接子元素；其内文本全部 shadow，整块补丁）。 */
  rasterBlocks: Set<Element>;
  /** 全部补丁元素（块级子元素 + 行内 .katex/.katex-display/svg）。 */
  patchEls: Set<Element>;
  blockPatches: PatchSource[];
  inlinePatches: PatchSource[];
  nativeImages: NativeImageDesc[];
  /** 原生嵌入图元素（光栅期间 visibility:hidden）。 */
  imgEls: HTMLElement[];
  stats: { blockPatches: number; inlinePatches: number; nativeImages: number };
}

/** 补丁计划采集（纯 DOM 读，无副作用）。图片分类：顶层 image-block（分页
 *  keepTogether，永不跨页）且 png/jpeg data URL → 原生嵌入；其余（行内嵌
 *  入/不可嵌入格式）→ 所在块整块补丁承载。 */
export function collectPatchPlan(handle: RenderFactoryHandle): PatchPlan {
  const content = handle.content;
  const base = content.getBoundingClientRect();
  const rasterBlocks = new Set<Element>();
  const patchEls = new Set<Element>();
  const blockPatches: PatchSource[] = [];
  const inlinePatches: PatchSource[] = [];
  const nativeImages: NativeImageDesc[] = [];
  const imgEls: HTMLElement[] = [];
  for (const kid of Array.from(content.children)) {
    const el = kid as HTMLElement;
    const rect = el.getBoundingClientRect();
    const imgs = Array.from(el.querySelectorAll?.("img") ?? []) as HTMLElement[];
    // 顶层独立图（image-block）：无其他内容、可原生嵌入 → 原生。
    const standalone =
      el.tagName === "IMG" &&
      Array.from(el.childNodes).every(
        (n) => n.nodeType !== Node.TEXT_NODE || !(n.textContent ?? "").trim()
      );
    if (standalone) {
      const src = el.getAttribute("src");
      const mime = nativeEmbeddableSrc(src);
      if (mime) {
        if (rect.width > 0 && rect.height > 0) {
          nativeImages.push({
            id: src!.slice(0, 96) + rect.width + "x" + rect.height,
            src: src!,
            mime,
            x: rect.left - base.left,
            y: rect.top - base.top,
            w: rect.width,
            h: rect.height,
          });
          imgEls.push(el);
        }
        continue;
      }
      // 不可嵌入（gif/webp/引用失败占位前的原始形态）→ 整块补丁。
      rasterBlocks.add(el);
      patchEls.add(el);
      blockPatches.push({
        x: rect.left - base.left,
        y: rect.top - base.top,
        w: rect.width,
        h: rect.height,
      });
      continue;
    }
    const inScope =
      el.matches?.(RASTER_SCOPE_SELECTOR) ||
      !!el.querySelector?.(RASTER_SCOPE_SELECTOR) ||
      // 任何嵌套图（行内/段落内）都走位图（跨页裁切由补丁窗口完成）
      imgs.length > 0;
    if (inScope) {
      rasterBlocks.add(el);
      patchEls.add(el);
      blockPatches.push({
        x: rect.left - base.left,
        y: rect.top - base.top,
        w: rect.width,
        h: rect.height,
      });
    }
  }
  // 行内补丁：.katex（非 display 内部）、.katex-display、独立 svg——不在
  // 任何块补丁内（祖先也不在，防嵌套双画）。
  const inPatchTree = (el: Element): boolean => {
    let e: Element | null = el;
    while (e && e !== content) {
      if (patchEls.has(e)) return true;
      e = e.parentElement;
    }
    return false;
  };
  for (const node of Array.from(
    content.querySelectorAll(".katex, .katex-display, svg")
  )) {
    const el = node as HTMLElement;
    if (inPatchTree(el)) continue;
    // .katex 在 .katex-display 内 → 由 display 补丁覆盖；svg 在 katex 内同理。
    if (
      (el.classList.contains("katex") && el.closest(".katex-display")) ||
      (el.tagName === "SVG" && el.closest(".katex"))
    ) {
      continue;
    }
    patchEls.add(el);
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      inlinePatches.push({
        x: r.left - base.left,
        y: r.top - base.top,
        w: r.width,
        h: r.height,
      });
    }
  }
  return {
    rasterBlocks,
    patchEls,
    blockPatches,
    inlinePatches,
    nativeImages,
    imgEls,
    stats: {
      blockPatches: blockPatches.length,
      inlinePatches: inlinePatches.length,
      nativeImages: nativeImages.length,
    },
  };
}

/**
 * 全量文本素材 + 矢量化判定（vector=false 时退化为旧采集：全部 shadow、
 * 不采集额外样式——与 EX 轮行为逐字节等价）。patchPlan 给出降级域与补丁
 * 元素（RV 阶三）；残留影子文本（不在任何补丁内）就地聚成 residual 补丁。
 */
export function collectTextMaterial(
  handle: RenderFactoryHandle,
  o: {
    vector: boolean;
    patchPlan?: PatchPlan;
    glyphChecker?: (text: string) => boolean;
    /** Inter 变体对码点的覆盖（RVF 阶段一；缺省 = 拉丁字符仍标变体，
     *  组装器无 Inter 字体时退主字体，安全）。 */
    latinGlyphCovered?: (cp: number) => boolean;
  }
): TextMaterial {
  const content = handle.content;
  const doc = handle.doc;
  const win = handle.iframe.contentWindow;
  const stats: TextPlanStats = { totalChars: 0, vectorChars: 0, shadowChars: 0, syntheticBoldChars: 0, syntheticItalicChars: 0, latinTrueVariantChars: 0, reasons: {} };
  const bump = (reason: string, chars: number): void => {
    stats.reasons[reason] = (stats.reasons[reason] ?? 0) + chars;
  };
  const noHiding: DecorationHiding = { borderEls: [], quoteEls: [], bgEls: [], decorEls: [], imgEls: [] };
  if (!win) return { fragments: [], vectorNodes: [], hiding: noHiding, residualPatches: [], stats };
  const base = content.getBoundingClientRect();
  const canvas = doc.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return { fragments: [], vectorNodes: [], hiding: noHiding, residualPatches: [], stats };
  const fontMetrics = new Map<string, FontMetrics>();
  const advanceCache = new Map<string, number>();
  interface StyleInfo {
    font: string;
    size: number;
    weight: number;
    style: string;
    decoration: string;
    family: string;
    colorStr: string;
  }
  const styleCache = new Map<HTMLElement, StyleInfo>();
  // 块级降级域：content 直接子元素级判定一次。
  const fragments: TextFragment[] = [];
  const vectorNodes: Text[] = [];
  const hiding: DecorationHiding = { borderEls: [], quoteEls: [], bgEls: [], decorEls: [], imgEls: [] };
  const residualByExtent = new Map<Element | null, PatchSource[]>();
  // 降级域（阶段三：块级集合来自补丁计划；无计划时回退旧选择器语义）。
  const rasterBlocks = o.patchPlan?.rasterBlocks;
  const patchEls = o.patchPlan?.patchEls;
  const inRasterScopeOf = (el: Element): boolean => {
    if (rasterBlocks) {
      let e: Element | null = el;
      while (e && e.parentElement && e.parentElement !== content) e = e.parentElement;
      return e ? rasterBlocks.has(e) : false;
    }
    let e: Element | null = el;
    while (e && e.parentElement && e.parentElement !== content) e = e.parentElement;
    return e ? e.matches?.(RASTER_SCOPE_SELECTOR) || !!e.querySelector?.(RASTER_SCOPE_SELECTOR) : false;
  };
  const inPatchTree = (el: Element): boolean => {
    if (!patchEls) return false;
    let e: Element | null = el;
    while (e && e !== content) {
      if (patchEls.has(e)) return true;
      e = e.parentElement;
    }
    return false;
  };
  // 有效装饰线：最近带线祖先（含 parent；传播语义近似——GFM 的 a/del/u 命中）。
  // 返回宿主元素（线的绘制者——遮蔽与取色都指向它）。
  const decorLineCache = new Map<HTMLElement, string>();
  const decorHostCache = new Map<HTMLElement, HTMLElement | null>();
  const decorHostOf = (el: HTMLElement): HTMLElement | null => {
    let v = decorHostCache.get(el);
    if (v === undefined) {
      v = null;
      let e: HTMLElement | null = el;
      while (e && e !== content) {
        const d = decorLineCache.get(e) ?? win.getComputedStyle(e).textDecorationLine;
        decorLineCache.set(e, d);
        if (d && d !== "none") {
          v = e;
          break;
        }
        e = e.parentElement;
      }
      decorHostCache.set(el, v);
    }
    return v;
  };
  const decorLineOfHost = (host: HTMLElement | null): string =>
    host ? decorLineCache.get(host) ?? "none" : "none";
  // 装饰线颜色：宿主的 text-decoration-color（currentcolor → 宿主 color）。
  const decorColorCache = new Map<HTMLElement, { r: number; g: number; b: number } | null>();
  const decorColorOf = (el: HTMLElement) => {
    let c = decorColorCache.get(el);
    if (c === undefined) {
      const cs = win.getComputedStyle(el);
      const dc = parseCssColor(cs.textDecorationColor);
      c = dc && dc.a >= 0.9 ? { r: dc.r, g: dc.g, b: dc.b } : pickColor(cs.color) ?? null;
      decorColorCache.set(el, c);
    }
    return c;
  };
  // inline 背景提供者（mark 等；块级底色走块装饰通道，只认 inline）。
  const bgProviderCache = new Map<HTMLElement, HTMLElement | null>();
  const bgProviderOf = (el: HTMLElement): HTMLElement | null => {
    let v = bgProviderCache.get(el);
    if (v === undefined) {
      v = null;
      let e: HTMLElement | null = el;
      while (e && e !== content) {
        const cs = win.getComputedStyle(e);
        if (!cs.display.startsWith("inline")) break; // 块级到此为止
        const c = parseCssColor(cs.backgroundColor);
        if (c && c.a > 0.01) {
          v = e;
          break;
        }
        e = e.parentElement;
      }
      bgProviderCache.set(el, v);
    }
    return v;
  };
  // 页面底色（半透明背景的预混合基准：工厂 html 背景）。
  const pageBg = (() => {
    const c = parseCssColor(
      win.getComputedStyle(doc.documentElement).backgroundColor || "#ffffff"
    );
    return c ?? { r: 255, g: 255, b: 255, a: 1 };
  })();
  const blendOver = (fg: { r: number; g: number; b: number; a: number }) => ({
    r: Math.round(fg.r * fg.a + pageBg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + pageBg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + pageBg.b * (1 - fg.a)),
  });
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
      const weightStr = cs.fontWeight;
      const weight =
        weightStr === "bold" ? 700 : weightStr === "normal" ? 400 : parseFloat(weightStr) || 400;
      style = {
        font: cs.font,
        size: parseFloat(cs.fontSize) || 16,
        weight: Number.isFinite(weight) ? weight : 400,
        style: cs.fontStyle,
        decoration: cs.textDecorationLine,
        family: cs.fontFamily,
        colorStr: cs.color,
      };
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
    // 矢量化判定（纯逻辑见 exportVectorText.ts——采集与组装共享同一批）。
    // 装饰线按「最近带线祖先」取有效值（传播语义），可画的线不阻断矢量。
    const charCount = Array.from(data).length;
    const decorHost = o.vector ? decorHostOf(p) : null;
    const effectiveDecor = decorLineOfHost(decorHost);
    let vector = false;
    let skipReason = "";
    let syntheticBold = false;
    let syntheticItalic = false;
    if (o.vector) {
      const d = decideTextVectorization({
        inRasterScope: inRasterScopeOf(p),
        inKatex: !!p.closest(".katex"),
        fontWeight: style.weight,
        fontStyle: style.style,
        textDecorationLine: effectiveDecor,
        fontFamily: style.family,
        color: parseCssColor(style.colorStr),
        glyphsCovered: o.glyphChecker ? o.glyphChecker(data) : undefined,
      });
      vector = d.vector;
      skipReason = d.reason;
      syntheticBold = !!d.syntheticBold;
      syntheticItalic = !!d.syntheticItalic;
      if (vector && syntheticBold) stats.syntheticBoldChars += charCount;
      if (vector && syntheticItalic) stats.syntheticItalicChars += charCount;
    }
    // 装饰线信息（vector 与 shadow 片段都记：位图统一摘线、矢量统一补线）。
    let fragDecor: TextFragment["decor"] | undefined;
    if (
      decorHost &&
      /^(underline|line-through)( (underline|line-through))?$/.test(effectiveDecor.trim())
    ) {
      const color = decorColorOf(decorHost);
      if (color) {
        const kinds = effectiveDecor.trim().split(/\s+/) as Array<"underline" | "line-through">;
        fragDecor = { kinds, color };
        if (!hiding.decorEls.includes(decorHost)) hiding.decorEls.push(decorHost);
      }
    }
    // inline 背景提供者（vector 片段触发隐藏；shadow 片段的行也补 rect——
    // 混合粗体的高亮行不丢底）。
    let bgProvider: HTMLElement | null = null;
    let fragBg: TextFragment["bg"] | undefined;
    if (o.vector && !p.closest(".katex")) {
      bgProvider = bgProviderOf(p);
      if (bgProvider) {
        const c = parseCssColor(win.getComputedStyle(bgProvider).backgroundColor);
        if (c) {
          fragBg = { color: c.a >= 1 ? { r: c.r, g: c.g, b: c.b } : blendOver(c) };
          if (vector && !hiding.bgEls.includes(bgProvider)) hiding.bgEls.push(bgProvider);
        }
      }
    }
    stats.totalChars += charCount;
    if (vector) {
      stats.vectorChars += charCount;
      vectorNodes.push(node);
    } else {
      stats.shadowChars += charCount;
      if (skipReason) bump(skipReason, charCount);
    }
    // 逐字符字体变体（RVF 阶段一）：拉丁域字符按字重/字型标 Inter 变体
    //（Inter 缺字形回 CJK 域——节点级判定已保证至少一族覆盖）；其余 CJK。
    // vector 与 shadow 片段都携带：影子层拉丁也用 Inter（Tr 3 隐形），让
    // 两模式的字形 bbox 宽度一致——否则抽取器按 Noto/Inter 字形宽度推断
    // 空格，双模式分词不一致（逐字锚定也救不了，实测 21+ 处差异）。
    const chars = Array.from(data);
    const nodeVariants: RunFontVariant[] = runVariants(
      data,
      style.weight,
      style.style
    ).map((v, idx) => {
      if (v === CJK_VARIANT) return v;
      const cp = chars[idx].codePointAt(0) ?? 0;
      return !o.latinGlyphCovered || o.latinGlyphCovered(cp) ? v : CJK_VARIANT;
    });
    if (vector) {
      stats.latinTrueVariantChars += nodeVariants.filter((v) => v !== CJK_VARIANT).length;
    }
    /** 字符区间 [i, j) + 行几何 → 片段（文本/advances 同步切片）。 */
    const pushFragment = (
      i: number,
      j: number,
      r: { left: number; top: number; bottom: number }
    ): void => {
      if (j <= i) return;
      const top = r.top - base.top;
      const height = r.bottom - r.top;
      fragments.push({
        text: chars.slice(i, j).join(""),
        x: r.left - base.left,
        top,
        height,
        size: style.size,
        baselineY: top + (height - (fm.ascent + fm.descent)) / 2 + fm.ascent,
        advances: advances.slice(i, j),
        ...(vector ? { color: pickColor(style.colorStr) } : {}),
        vector,
        skipReason,
        ...(syntheticBold ? { syntheticBold: true } : {}),
        ...(syntheticItalic ? { syntheticItalic: true } : {}),
        ...(nodeVariants ? { variants: nodeVariants.slice(i, j) } : {}),
        ...(fragDecor ? { decor: fragDecor } : {}),
        ...(fragBg ? { bg: fragBg } : {}),
      });
      // 残留影子文本 → 补丁源（不在任何补丁元素内的部分；按 extent 元素
      // 分组取并集——行内代码 chip 的底/边框随 extent 全覆盖）。
      if (o.vector && !vector && !inPatchTree(p)) {
        const key = bgProvider ?? null;
        const rect: PatchSource = {
          x: r.left - base.left,
          y: top,
          w: advances.slice(i, j).reduce((s, v) => s + v, 0),
          h: height,
        };
        const list = residualByExtent.get(key);
        if (list) list.push(rect);
        else residualByExtent.set(key, [rect]);
      }
    };
    // 逐字符 advance（(font,char) 缓存——CJK 重复率高）。
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
    const nodeRects = Array.from(range.getClientRects()).filter(
      (r) => r.width > 0 && r.height > 0
    );
    if (nodeRects.length <= 1) {
      // 单行：整文一个片段（快路径）。
      const r = nodeRects[0];
      if (r) pushFragment(0, chars.length, r);
      continue;
    }
    // 多行（RV 定罪修复：按行重复铺设整文——隐形层时代即存在的重复缺陷，
    // 矢量可见化后必须消除）：逐 code point 取 rect，按垂直重叠分行出段，
    // 每段只画本行字符。Range 偏移按 UTF-16 code unit 计。
    interface CharBox {
      top: number;
      bottom: number;
      left: number;
    }
    const boxes: CharBox[] = [];
    {
      let cu = 0;
      for (const ch of chars) {
        range.setStart(node, cu);
        range.setEnd(node, cu + ch.length);
        const b = range.getBoundingClientRect();
        boxes.push({ top: b.top, bottom: b.bottom, left: b.left });
        cu += ch.length;
      }
    }
    let segTop = boxes[0].top;
    let segBottom = boxes[0].bottom;
    let segLeft = boxes[0].left;
    let segStart = 0;
    const closeSegment = (end: number): void => {
      if (end <= segStart) return;
      pushFragment(segStart, end, {
        left: segLeft,
        top: segTop,
        bottom: segBottom,
      });
    };
    for (let i = 1; i <= boxes.length; i++) {
      const b = boxes[i];
      // 与 lineBoxes 同判：顶落在当前行带底 +1 内 → 同行（吸收上下标微差）。
      if (i < boxes.length && b.top <= segBottom + 1) {
        segBottom = Math.max(segBottom, b.bottom);
      } else {
        closeSegment(i);
        if (i < boxes.length) {
          segTop = b.top;
          segBottom = b.bottom;
          segLeft = b.left;
          segStart = i;
        }
      }
    }
    continue;
  }
  // 残留补丁：同 extent 元素（行内代码 chip 等）的矩形与其元素盒一起纵向
  // 邻近合并（gap ≤ 6px 并入，避免补丁缝露底；chip 的底/边框全覆盖）。
  const residualPatches: PatchSource[] = [];
  for (const [el, rects] of residualByExtent) {
    const all = [...rects];
    if (el) {
      const er = el.getBoundingClientRect();
      all.push({ x: er.left - base.left, y: er.top - base.top, w: er.width, h: er.height });
    }
    residualPatches.push(...mergeRectsVertically(all, 6));
  }
  return { fragments, vectorNodes, hiding, residualPatches, stats };
}

/** 文本颜色（rgb → {r,g,b}；解析失败给黑色兜底——判定已保证 vector 必有色）。 */
function pickColor(cssColor: string): { r: number; g: number; b: number } | undefined {
  const c = parseCssColor(cssColor);
  return c ? { r: c.r, g: c.g, b: c.b } : undefined;
}

/** 兼容包装：仅取片段（旧调用方/测试）。 */
export function collectTextFragments(handle: RenderFactoryHandle): TextFragment[] {
  return collectTextMaterial(handle, { vector: false }).fragments;
}

/**
 * 位图文字摘除（RV 阶段一核心机制）：把矢量文本结点逐个包进
 * `<span style="color:transparent">`——只隐藏字形墨迹，不影响布局（颜色
 * 不参与排版→页数/坐标零扰动）、不误伤列表标记（::marker 继承的是原父级
 * 颜色）、不误伤 currentColor 边框与装饰线（它们由各自宿主元素绘制）。
 * 返回还原函数（幂等安全：工厂已销毁时静默）。
 */
export function applyTextTransparency(doc: Document, nodes: Text[]): () => void {
  const wraps: Array<{ span: HTMLElement; node: Text }> = [];
  for (const node of nodes) {
    const parent = node.parentNode;
    if (!parent) continue;
    const span = doc.createElement("span");
    span.setAttribute("style", "color:transparent");
    parent.insertBefore(span, node);
    span.appendChild(node);
    wraps.push({ span, node });
  }
  return () => {
    for (const { span, node } of wraps) {
      try {
        if (span.parentNode) {
          span.parentNode.insertBefore(node, span);
          span.remove();
        }
      } catch {
        /* 已随工厂销毁 */
      }
    }
  };
}

/**
 * 块级装饰采集（RV 阶段二）：表格边框全量线段（外框 + 单元格内线）、引用
 * 块底色/左竖条、hr 分割线 → content 坐标装饰面 + 断口补线输入 + 遮蔽清单。
 * 位置来自工厂 DOM 实测 rect，颜色/宽度来自 computed style。
 */
export interface BlockDecorationMaterial {
  rects: import("./exportVectorDecor").DecoRect[];
  lines: import("./exportVectorDecor").DecoLine[];
  tables: import("./exportVectorDecor").TableSpan[];
  hiding: DecorationHiding;
  /** 页面底色（满铺位图退位后的矢量底矩形色）。 */
  pageBg: { r: number; g: number; b: number };
}

/** 装饰线宽下限（CSS px）：≈0.5pt@k0.75。发丝线（dpr 1.75 下 1px border
 *  被 Chromium snap 成 0.5714px）矢量换算后 0.43pt 偏淡（F4）。 */
const DECOR_MIN_PX = 0.67;

export function collectBlockDecorations(
  handle: RenderFactoryHandle
): BlockDecorationMaterial {
  const content = handle.content;
  const doc = handle.doc;
  const win = handle.iframe.contentWindow;
  const rects: BlockDecorationMaterial["rects"] = [];
  const lines: BlockDecorationMaterial["lines"] = [];
  const tables: BlockDecorationMaterial["tables"] = [];
  const hiding: DecorationHiding = { borderEls: [], quoteEls: [], bgEls: [], decorEls: [], imgEls: [] };
  if (!win) return { rects, lines, tables, hiding, pageBg: { r: 255, g: 255, b: 255 } };
  const base = content.getBoundingClientRect();
  const pageBgC = parseCssColor(
    win.getComputedStyle(doc.documentElement).backgroundColor || "#ffffff"
  );
  const pageBg = pageBgC ?? { r: 255, g: 255, b: 255, a: 1 };
  const blendOver = (fg: { r: number; g: number; b: number; a: number }) => ({
    r: Math.round(fg.r * fg.a + pageBg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + pageBg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + pageBg.b * (1 - fg.a)),
  });
  const hline = (y: number, x1: number, x2: number, w: number, c: { r: number; g: number; b: number }) =>
    lines.push({ x1, y1: y, x2, y2: y, width: w, color: c });
  const vline = (x: number, y1: number, y2: number, w: number, c: { r: number; g: number; b: number }) =>
    lines.push({ x1: x, y1, x2: x, y2, width: w, color: c });

  for (const table of Array.from(content.querySelectorAll("table"))) {
    const el = table as HTMLElement;
    const tcs = win.getComputedStyle(el);
    const tColor = parseCssColor(tcs.borderTopColor);
    const tWidth = Math.max(parseFloat(tcs.borderTopWidth) || 1, DECOR_MIN_PX);
    const tr = el.getBoundingClientRect();
    const L = tr.left - base.left;
    const R = tr.right - base.left;
    const T = tr.top - base.top;
    const B = tr.bottom - base.top;
    const color = tColor ?? { r: 200, g: 200, b: 200 };
    hline(T, L, R, tWidth, color);
    hline(B, L, R, tWidth, color);
    vline(L, T, B, tWidth, color);
    vline(R, T, B, tWidth, color);
    tables.push({ x1: L, x2: R, top: T, bottom: B, borderWidth: tWidth, color });
    hiding.borderEls.push(el);
    const rows = Array.from(el.querySelectorAll("tr"));
    rows.forEach((row, ri) => {
      const cells = Array.from(row.children);
      cells.forEach((cellNode, ci) => {
        const cell = cellNode as HTMLElement;
        const ccs = win.getComputedStyle(cell);
        const cColor = parseCssColor(ccs.borderBottomColor) ?? color;
        const cWidth = Math.max(parseFloat(ccs.borderBottomWidth) || tWidth, DECOR_MIN_PX);
        const cr = cell.getBoundingClientRect();
        hiding.borderEls.push(cell);
        if (ci < cells.length - 1) {
          vline(cr.right - base.left, cr.top - base.top, cr.bottom - base.top, cWidth, cColor);
        }
        if (ri < rows.length - 1) {
          hline(cr.bottom - base.top, cr.left - base.left, cr.right - base.left, cWidth, cColor);
        }
      });
    });
  }

  for (const q of Array.from(content.querySelectorAll("blockquote"))) {
    const el = q as HTMLElement;
    const cs = win.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const x = r.left - base.left;
    const y = r.top - base.top;
    const bg = parseCssColor(cs.backgroundColor);
    if (bg && bg.a > 0.01) {
      rects.push({
        x,
        y,
        w: r.width,
        h: r.height,
        color: bg.a >= 1 ? { r: bg.r, g: bg.g, b: bg.b } : blendOver(bg),
      });
    }
    const barColor = parseCssColor(cs.borderLeftColor);
    const barW = parseFloat(cs.borderLeftWidth) || 0;
    if (barColor && barW > 0) {
      rects.push({ x, y, w: barW, h: r.height, color: { r: barColor.r, g: barColor.g, b: barColor.b } });
    }
    hiding.quoteEls.push(el);
  }

  for (const hr of Array.from(content.querySelectorAll("hr"))) {
    const el = hr as HTMLElement;
    const cs = win.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const c = parseCssColor(cs.borderTopColor) ?? parseCssColor(cs.color);
    const w = Math.max(parseFloat(cs.borderTopWidth) || 1, DECOR_MIN_PX);
    if (c) {
      hline(r.top - base.top + w / 2, r.left - base.left, r.right - base.left, w, { r: c.r, g: c.g, b: c.b });
    }
    hiding.borderEls.push(el);
  }

  return { rects, lines, tables, hiding, pageBg: { r: pageBg.r, g: pageBg.g, b: pageBg.b } };
}

/**
 * 装饰遮蔽（RV 阶段二）：光栅期间把「将由矢量补画」的装饰通道对位图隐藏
 * ——表格/单元格/hr 边框色、引用块底色+左竖条、inline 背景（mark）、装饰
 * 线颜色。cssText 快照还原（含异常/取消路径）。与文字摘除同一 finally 链。
 */
export function applyDecorationTransparency(
  hiding: DecorationHiding,
  more: DecorationHiding[] = []
): () => void {
  const all: DecorationHiding = { borderEls: [], quoteEls: [], bgEls: [], decorEls: [], imgEls: [] };
  for (const h of [hiding, ...more]) {
    all.borderEls.push(...h.borderEls);
    all.quoteEls.push(...h.quoteEls);
    all.bgEls.push(...h.bgEls);
    all.decorEls.push(...h.decorEls);
    all.imgEls.push(...h.imgEls);
  }
  const saved: Array<[HTMLElement, string]> = [];
  const push = (el: HTMLElement): void => {
    saved.push([el, el.style.cssText]);
  };
  for (const el of all.borderEls) {
    push(el);
    el.style.borderColor = "transparent";
  }
  for (const el of all.quoteEls) {
    push(el);
    el.style.borderLeftColor = "transparent";
    el.style.backgroundColor = "transparent";
  }
  for (const el of all.bgEls) {
    push(el);
    el.style.backgroundColor = "transparent";
  }
  for (const el of all.decorEls) {
    push(el);
    el.style.textDecorationColor = "transparent";
  }
  for (const el of all.imgEls) {
    push(el);
    el.style.visibility = "hidden"; // 保留布局（原生嵌入按 rect 放置）
  }
  return () => {
    for (const [el, css] of saved) {
      try {
        el.style.cssText = css;
      } catch {
        /* 已随工厂销毁 */
      }
    }
  };
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
          top: f.top,
          height: f.height,
          baselineY: f.baselineY - pages[best].top,
          size: f.size,
          advances: f.advances,
          ...(f.vector ? { color: f.color ?? { r: 0, g: 0, b: 0 } } : {}),
          shadow: f.vector !== true,
          ...(f.syntheticBold ? { syntheticBold: true } : {}),
          ...(f.syntheticItalic ? { syntheticItalic: true } : {}),
          ...(f.variants ? { variants: f.variants } : {}),
          ...(f.decor ? { decor: f.decor } : {}),
          ...(f.bg ? { bg: f.bg } : {}),
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
  /** 矢量文本结点：光栅前包 span 摘除位图墨迹（空 = 旧满铺行为）。 */
  vectorNodes: Text[];
  /** 装饰遮蔽面（文本侧 + 块级；矢量补画通道对位图隐藏）。 */
  hiding: DecorationHiding[];
  /** 块装饰（矢量 rect/line + 表格断口补线输入；null = 关闭）。 */
  blockDecor: BlockDecorationMaterial | null;
  /** 局部补丁源（块/行内/残留；vector 模式下满铺位图退位）。 */
  patchSources: PatchSource[];
  /** 原生嵌入图片（png/jpeg data URL；位图墨迹摘除）。 */
  nativeImages: NativeImageDesc[];
  /** 矢量模式（false = 旧满铺位图路径，逐字节等价）。 */
  vectorActive: boolean;
  assembler: Awaited<ReturnType<typeof createPdfAssembler>>;
  signal?: AbortSignal;
  sub?: Record<string, number>;
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
  const decosPerPage = a.blockDecor
    ? decorationsToPageDecos(a.blockDecor, pages)
    : (pages.map(() => null) as Array<PageDeco | null>);
  // 补丁的逐页放置（纯几何；vector 模式核心输出）。原生图片不跨页（顶层
  // keepTogether），按包含窗口整图入页。
  const patchPlacements = a.vectorActive
    ? patchesToPagePlacements(a.patchSources, pages)
    : null;
  const nativePerPage: Array<Array<NativeImageDesc & { pageY: number }>> =
    pages.map(() => []);
  if (a.vectorActive) {
    for (const n of a.nativeImages) {
      for (let i = 0; i < pages.length; i++) {
        const seg = patchWindowSeg(n.y, n.h, pages[i].top, pages[i].bottom);
        if (!seg) continue;
        nativePerPage[i].push({ ...n, pageY: seg[0] - pages[i].top });
      }
    }
  }
  // 内存护栏：整本解码位图预算超限 → JPEG 档（仅满铺路径；补丁路径页图
  // 是小裁片，不受此约束）。
  const pagePx = a.contentWidthPx * a.scale * a.contentHeightPx * a.scale;
  const useJpeg = !a.vectorActive && pages.length * pagePx * 4 > JPEG_GUARD_BYTES;

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

  const { createContext, destroyContext, domToCanvas } = await import(
    "modern-screenshot"
  );
  // 上下文跨 chunk 复用（EX 优化轮 #3）：字体 dataURL 的 requests 缓存、
  // defaultComputedStyles 缓存与 waitUntilLoad 都只做一次——每 chunk 重建
  // context 时 KaTeX 的 ~20 个 woff2 会被重复 fetch+base64。
  const msContext = await createContext(win, {
    width: a.contentWidthPx,
    height: a.contentHeightPx,
    scale: a.scale,
    backgroundColor: bg,
    autoDestruct: false,
    includeStyleProperties: MS_STYLE_PROPS,
    features: {
      copyScrollbar: false, // 工厂窗口 overflow:hidden，无滚动条面
      removeAbnormalAttributes: false, // 编辑器产物属性均规范，免逐元素扫描
      restoreScrollPosition: false,
    },
    debug: (window as unknown as { __msDebug?: boolean }).__msDebug === true,
  });
  const bySide = Math.floor(MAX_CANVAS_SIDE / (a.contentHeightPx * a.scale));
  const byPixels = Math.floor(
    MAX_CANVAS_PIXELS /
      (a.contentWidthPx * a.scale * a.contentHeightPx * a.scale)
  );
  // SVG-as-image 的光栅面（宽或高）超过 ~8192 设备像素时 foreignObject 内容
  // 出现渐进丢失（实测 8344px 高的 chunk 底部公式整行缺墨、右侧截断——
  // 像素级对比定罪）。直连路径按设备高收口 chunk 页数；回退路径不受影响
  // 但统一采用（多余 chunk 的固定开销很小）。
  const byRasterSurface = Math.max(
    1,
    Math.floor(8000 / (a.contentHeightPx * a.scale))
  );
  const perChunk = Math.max(
    1,
    Math.min(bySide, byPixels, MAX_PAGES_PER_CHUNK, byRasterSurface)
  );

  const pageCanvas = document.createElement("canvas");
  pageCanvas.width = Math.round(a.contentWidthPx * a.scale);
  pageCanvas.height = Math.round(a.contentHeightPx * a.scale);
  const pageCtx = pageCanvas.getContext("2d");
  if (!pageCtx) throw new Error("无法创建页画布（2D 上下文不可用）");
  pageCtx.fillStyle = bg;
  const pw = pageCanvas.width;
  const ph = pageCanvas.height;
  // 补丁裁片画布（按需建；每片独立尺寸）。EX 优化轮 #5：裁片改每片独立
  // 画布 + toBlob 异步编码（浏览器编码线程池并行），替代共享画布上的同步
  // toDataURL（主线程逐片 PNG 编码曾是 crop 阶段全部成本）。
  interface PatchCrop {
    canvas: HTMLCanvasElement;
    x: number;
    y: number;
    w: number;
    h: number;
  }
  const patchCanvasPool: HTMLCanvasElement[] = [];
  const takePatchCanvas = (): HTMLCanvasElement => {
    const c = patchCanvasPool.pop() ?? document.createElement("canvas");
    const ctx = c.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, c.width, c.height);
    return c;
  };
  /** chunk 位图内裁片（同步绘制，编码延后并行）。 */
  const cropPatch = (
    img: HTMLImageElement | HTMLCanvasElement,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    out: PatchCrop
  ): boolean => {
    const cx = Math.max(0, Math.round(sx));
    const cy = Math.max(0, Math.round(sy));
    const cw = Math.max(1, Math.min(Math.round(sw), img.width - cx));
    const ch = Math.max(1, Math.min(Math.round(sh), img.height - cy));
    if (cw <= 0 || ch <= 0 || cx >= img.width || cy >= img.height) return false;
    out.canvas = takePatchCanvas();
    out.canvas.width = cw;
    out.canvas.height = ch;
    const ctx = out.canvas.getContext("2d");
    if (!ctx) return false;
    // 源/目标同为 scale 后设备像素、尺寸差 <1px：关闭平滑免双线性重采样
    // （软件渲染下逐片重采样曾是 crop 阶段主成本），整数对齐即像素精确。
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
    return true;
  };
  /** 一页的裁片批量编码（并行 toBlob → bytes）。 */
  // 编码失败计数器（复用 timings 子表的计数字段惯例，值恒为小整数）。
  const count = (k: string): void => {
    if (a.sub) a.sub[k] = (a.sub[k] ?? 0) + 1;
  };
  const encodePatches = async (
    crops: Array<{ crop: PatchCrop; x: number; y: number; w: number; h: number }>
  ): Promise<Array<{ bytes: Uint8Array; mime: "image/png" } & PatchSource>> => {
    if (crops.length === 0) return [];
    const out: Array<{ bytes: Uint8Array; mime: "image/png" } & PatchSource> = [];
    await Promise.all(
      crops.map(
        (c, i) =>
          new Promise<void>((resolve) => {
            c.crop.canvas.toBlob((blob) => {
              if (blob) {
                // catch 兜底（EX 复审 P2-2）：arrayBuffer 理论拒绝时若不落
                // resolve，外层 Promise.all 永不 settle → 页循环 await 挂死
                // 且不可取消。补丁缺失好过导出卡死；失败计数入 sub 供诊断。
                blob
                  .arrayBuffer()
                  .then((ab) => {
                    out[i] = {
                      bytes: new Uint8Array(ab),
                      mime: "image/png",
                      x: c.x,
                      y: c.y,
                      w: c.w,
                      h: c.h,
                    };
                    resolve();
                  })
                  .catch(() => {
                    count("crop.arrayBufferFail");
                    resolve();
                  });
              } else {
                count("crop.blobNull");
                resolve();
              }
            }, "image/png");
          })
      )
    );
    for (const c of crops) {
      c.crop.canvas.width = 0;
      c.crop.canvas.height = 0;
      patchCanvasPool.push(c.crop.canvas);
    }
    return out.filter(Boolean);
  };

  const trim = new ChunkTrim(content);
  // 直连光栅样式（vector 模式；构建失败 → 全程 domToCanvas）。perf 开关：
  // window.__noDirectRaster = true 强制回退路径（A/B 对比用）。
  let directCss: string | null = null;
  if (
    a.vectorActive &&
    !(window as unknown as { __noDirectRaster?: boolean }).__noDirectRaster
  ) {
    try {
      directCss = await buildDirectRasterCss(doc, doc.baseURI);
    } catch {
      directCss = null;
    }
  }
  let directOk = directCss !== null;
  // 矢量文本摘除 + 装饰遮蔽：整段光栅期间统一生效（颜色/边框色不参与布局，
  // 块测量/文本素材均在此之前完成——坐标面不受影响）。还原在 finally。
  const undoTransparency =
    a.vectorNodes.length > 0 ? applyTextTransparency(doc, a.vectorNodes) : null;
  const undoDecor =
    a.hiding.length > 0 ? applyDecorationTransparency(a.hiding[0], a.hiding.slice(1)) : null;
  try {
    const sub = a.sub ?? {};
    const bump = (k: string, ms: number): void => {
      sub[k] = (sub[k] ?? 0) + ms;
    };
    // EX 优化轮 #11 复盘：曾尝试跨 chunk 预启动（下一 chunk 的 trim/光栅与本
    // chunk 编码装册重叠），实测更慢（i15：serialize 2.0→7.1s、encodeWait
    // 6.9→8.1s）——SVG 解码与 toBlob 编码抢同一线程池，encodeWait 是编码器
    // 吞吐瓶颈而非主线程空闲，预启动只制造竞争。保留串行结构。
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
      let ts0 = performance.now();
      trim.apply(chunkTop, chunkBottom);
      bump("trim", performance.now() - ts0);
      // 平移后布局收帧：不依赖 rAF（后台/被遮挡窗口的 rAF 会被暂停，
      // 挂死导出——见 exportRenderFactory 同款注释）——强制同步布局读 +
      // 双定时器翻两轮事件循环。
      ts0 = performance.now();
      void content.scrollHeight;
      await new Promise((res) => setTimeout(res, 0));
      void content.scrollHeight;
      await new Promise((res) => setTimeout(res, 0));
      bump("settle", performance.now() - ts0);
      // 画布直取（EX 优化轮 #2/#8）：vector 模式优先直连 foreignObject 光栅
      // （原生克隆 + 样式表内嵌，跳过逐元素计算样式 diff）；异常回退
      // domToCanvas（ms 上下文）。raster 模式始终走 domToCanvas（外链图片
      // 需要库内抓取内联）。
      ts0 = performance.now();
      msContext.width = a.contentWidthPx;
      msContext.height = chunkSpan;
      let chunkCanvas: HTMLCanvasElement;
      if (directOk) {
        try {
          chunkCanvas = await rasterWindowDirect(
            win,
            directCss!,
            a.contentWidthPx,
            chunkSpan,
            a.scale,
            bg
          );
        } catch {
          directOk = false;
          sub["serialize.directFallback"] = 1;
          chunkCanvas = await domToCanvas(msContext);
        }
      } else {
        chunkCanvas = await domToCanvas(msContext);
      }
      bump("serialize", performance.now() - ts0);
      trim.restore();
      const img = chunkCanvas;
      const plan = pageSlicePlan(chunk, chunkTop, a.scale);
      // EX 优化轮 #6：本 chunk 全部页的裁片一次画完并把 toBlob 编码全部
      // 立刻挂起（浏览器编码线程池并行）——编码与逐页 addPage 的主线程
      // 工作重叠，替代「每页画→等编码→入册」的串行等待。
      const chunkPatchBytes: Array<Promise<Array<{ bytes: Uint8Array; mime: "image/png" } & PatchSource>>> =
        chunk.map(() => Promise.resolve([]));
      if (a.vectorActive && patchPlacements) {
        ts0 = performance.now();
        for (let i = 0; i < chunk.length; i++) {
          const pageIndex = start + i;
          const wTop = chunk[i].top;
          const pendingCrops: Array<{ crop: PatchCrop; x: number; y: number; w: number; h: number }> = [];
          for (const p of patchPlacements[pageIndex]) {
            const crop: PatchCrop = {
              canvas: null as unknown as HTMLCanvasElement,
              x: p.x,
              y: p.y,
              w: p.w,
              h: p.h,
            };
            if (
              cropPatch(
                img,
                p.x * a.scale,
                (wTop + p.y - chunkTop) * a.scale,
                p.w * a.scale,
                p.h * a.scale,
                crop
              )
            ) {
              pendingCrops.push({ crop, x: p.x, y: p.y, w: p.w, h: p.h });
            }
          }
          chunkPatchBytes[i] = encodePatches(pendingCrops);
        }
        bump("crop", performance.now() - ts0);
      }
      for (let i = 0; i < chunk.length; i++) {
        const pageIndex = start + i;
        const wTop = chunk[i].top;
        // 矢量模式：补丁裁片（页窗口可见部分从 chunk 位图裁出）+ 原生图；
        // 满铺位图退位。raster 模式：整页位图不变。
        let pageImage: { bytes: Uint8Array; mime: "image/png" | "image/jpeg" } | null = null;
        if (!(a.vectorActive && patchPlacements)) {
          ts0 = performance.now();
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
          bump("crop", performance.now() - ts0);
          pageImage = { bytes: dataUrlToBytes(pageDataUrl), mime: useJpeg ? "image/jpeg" : "image/png" };
          a.onPagePng?.(pageIndex, pageDataUrl);
        }
        // 调试页图（矢量模式）：底色 + 补丁合成（近似位图层视图）。源仍取
        // chunk 位图浮点源矩形（与历史字节可比，作视觉回归基准面）。
        if (a.vectorActive && a.onPagePng && patchPlacements) {
          pageCtx.fillStyle = bg;
          pageCtx.fillRect(0, 0, pw, ph);
          for (const p of patchPlacements[pageIndex]) {
            pageCtx.drawImage(
              img,
              p.x * a.scale,
              (wTop + p.y - chunkTop) * a.scale,
              p.w * a.scale,
              p.h * a.scale,
              p.x * a.scale,
              p.y * a.scale,
              p.w * a.scale,
              p.h * a.scale
            );
          }
          a.onPagePng(pageIndex, pageCanvas.toDataURL("image/png"));
        }
        // 补丁 PNG 编码等待（EX 优化轮 #10 计时归位：并行 toBlob 的池吞吐
        // 等待原先落在 raster 桶的未归类区间）。
        ts0 = performance.now();
        const patches = a.vectorActive ? await chunkPatchBytes[i] : [];
        bump("encodeWait", performance.now() - ts0);
        ts0 = performance.now();
        await a.assembler.addPage(
          pageImage,
          runsPerPage[pageIndex],
          decosPerPage[pageIndex] ?? undefined,
          patches.length > 0 ? patches : undefined,
          nativePerPage[pageIndex].length > 0
            ? nativePerPage[pageIndex].map((n) => ({
                id: n.id,
                src: n.src,
                mime: n.mime,
                x: n.x,
                y: n.pageY,
                w: n.w,
                h: n.h,
              }))
            : undefined
        );
        bump("addPage", performance.now() - ts0);
        a.onProgress(pageIndex + 1, pages.length);
      }
      // 即弃：分块画布随下一轮 GC；无需显式断引用（无 dataURL 常驻串）。
    }
  } finally {
    undoDecor?.();
    undoTransparency?.();
    trim.restore();
    try {
      destroyContext(msContext);
    } catch {
      /* 上下文已随页面销毁 */
    }
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

let latinBytesCache: LatinFontBytes | null | undefined;

/** Inter 变体字节（RVF 阶段一；会话内缓存）。Regular 必得（其余变体缺位
 *  时组装器退 regular/主字体）；全缺 → null（拉丁 run 回合成路径，与
 *  阶段一之前行为等价）。 */
export async function loadLatinFontBytes(
  urls: {
    regular: string;
    bold: string;
    italic: string;
    boldItalic: string;
  } = LATIN_FONT_URLS
): Promise<LatinFontBytes | null> {
  if (latinBytesCache !== undefined) return latinBytesCache;
  const load = async (u: string): Promise<Uint8Array | null> => {
    try {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    } catch {
      return null; // 单变体缺位：不阻断，该字重/字型退主字体
    }
  };
  const [regular, bold, italic, boldItalic] = await Promise.all([
    load(urls.regular),
    load(urls.bold),
    load(urls.italic),
    load(urls.boldItalic),
  ]);
  latinBytesCache = regular ? { regular, ...(bold ? { bold } : {}), ...(italic ? { italic } : {}), ...(boldItalic ? { boldItalic } : {}) } : null;
  return latinBytesCache;
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
