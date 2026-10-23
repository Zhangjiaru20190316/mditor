// PDF 组装器（EX 轮阶段三/四）：pdf-lib + @pdf-lib/fontkit，两者一律函数内
// 懒加载（exporter.ts:27-30 依赖纪律——重型导出包不得进首屏）。
//
// 每页两层：
//   * 视觉层：页位图（离屏工厂分块光栅的 PNG）满铺内容区；
//   * 文本层（EX-P，可选）：隐形文本（Tr 3 / TextRenderingMode.Invisible）
//     + CJK 子集内嵌（fontkit subset:true，OFL 字体 NotoSansSC）——为选中/
//     复制/检索提供定位文本，不影响视觉。对位策略（D-2 分治）：CJK 等
//     宽 run 单点锚定（嵌入字体与实测同为 1em 字宽，按构造零漂移）；拉丁
//     run 给出逐字符期望 advances 时逐字锚定（cumulative x 精确到实测位）。
//
// 授权口径（EX-P 门槛）：字体源 = Noto Sans SC（SIL OFL 1.1，允许再分发、
// 修改、子集内嵌；assets/fonts/NotoSansSC-Regular.otf）。禁止读系统字体
// 嵌入（微软雅黑等不可再分发）。字体文件缺失 → 纯光栅降级（info.
// fontEmbedded = false），不静默假装有文本层。

import { decorationLineGeometry } from "./exportVectorDecor";
import {
  CJK_VARIANT,
  isLatinScript,
  type LatinFontVariant,
  type RunFontVariant,
} from "./exportVectorText";

/** CSS px → pt 的名义比（96dpi 语义下 1px = 0.75pt；实际换算用内容盒比）。 */
export const PT_PER_PX = 72 / 96;

export interface PdfTextRun {
  text: string;
  /** run 起点 x（CSS px，相对内容盒左上）。 */
  x: number;
  /** 行盒顶（CSS px，相对页窗口顶；run 背景矩形的几何输入）。 */
  top?: number;
  /** 行盒高（CSS px）。 */
  height?: number;
  /** 基线 y（CSS px，相对内容盒顶部，向下正）。 */
  baselineY: number;
  /** 字号（CSS px）。 */
  size: number;
  /** 逐字符期望宽度（px，与 text 等长）。给出则逐字锚定，否则 run 单锚。 */
  advances?: number[];
  /** 矢量可见绘制色（RV 轮）：给出且非 shadow 时正常 Tr 模式绘制。 */
  color?: { r: number; g: number; b: number };
  /** true = 位图承载视觉、此处只铺 Tr 3 影子（旧满铺行为/降级域文本）。 */
  shadow?: boolean;
  /** 合成加粗（RV 阶四）：Tr 2 FillAndStroke + ~0.026em 细描边。RVF 阶段一
   *  起仅对 CJK 段生效（拉丁段走 Inter-Bold 真字体）。 */
  syntheticBold?: boolean;
  /** 合成斜体（RV 阶四）：xSkew 12° 剪切。RVF 阶段一起仅对 CJK 段生效。 */
  syntheticItalic?: boolean;
  /** 逐字符字体变体（与 Array.from(text) 等长；RVF 阶段一）：Latin 字符
   *  指向 Inter 四变体、其余 CJK_VARIANT 走主字体。缺省 = 全程主字体
   *  （shadow run/旧调用：拉丁 NotoSansSC 也有字形，不会 notdef）。 */
  variants?: RunFontVariant[];
  /** 装饰线（下划线/删除线；shadow run 也画——位图已统一摘线）。 */
  decor?: { kinds: Array<"underline" | "line-through">; color: { r: number; g: number; b: number } };
  /** inline 背景（mark 高亮等；rect = 片段行盒）。 */
  bg?: { color: { r: number; g: number; b: number } };
}

/** Inter 变体字节表（RVF 阶段一；缺项 = 该变体退主字体 + 合成）。 */
export interface LatinFontBytes {
  regular: Uint8Array;
  bold?: Uint8Array;
  italic?: Uint8Array;
  boldItalic?: Uint8Array;
}

export interface PdfAssemblerOptions {
  pageWidthPt: number;
  pageHeightPt: number;
  marginPt: { top: number; right: number; bottom: number; left: number };
  /** 内容盒宽（CSS px）——px→pt 换算基准（高按同比例）。 */
  contentWidthPx: number;
  contentHeightPx: number;
  /** 文本层字体字节（null/undefined/嵌入失败 = 纯光栅）。 */
  fontBytes?: Uint8Array | null;
  /** Inter 四变体字节（RVF 阶段一：拉丁 run 真粗/斜体；嵌入失败逐变体退主字体）。 */
  latinFontBytes?: LatinFontBytes | null;
  title?: string;
  /** 矢量文本模式（RV 轮）：非 shadow 且带色的 run 以正常 Tr 可见绘制；
   *  false（缺省）= 旧行为，全部 Tr 3 影子。 */
  vectorText?: boolean;
}

export interface PdfAssembleInfo {
  pages: number;
  fontEmbedded: boolean;
  /** Inter 变体实际嵌入数（0-4；RVF 阶段一）。 */
  latinFontsEmbedded: number;
  embedFontMs: number;
  textRunsPlaced: number;
  glyphsPlaced: number;
  /** 实际铺字 drawText 调用数（ε-合并组数；D-2 粒度/性能口径）。 */
  textOpsPlaced: number;
  /** 矢量可见绘制（RV 轮）：可见 run 数与字形数（覆盖率报告口径）。 */
  visibleRunsPlaced: number;
  visibleGlyphsPlaced: number;
}

/** 逐页喂图（pipeline 分块光栅后即喂即释放，不整本驻留内存）。 */
export interface PdfPageImage {
  bytes: Uint8Array;
  /** image/png = 无损（默认）；image/jpeg = 内存护栏大文档档（DCT 直通）。 */
  mime: "image/png" | "image/jpeg";
}

/** 局部补丁（RV 阶段三）：非矢量视觉的位图裁片（页坐标 CSS px）。 */
export type PdfPatchImage = import("./exportVectorPatch").PatchSource & {
  bytes: Uint8Array;
  mime: "image/png";
};

/** 原生嵌入图片（png/jpeg 字节 + 页内放置矩形）。 */
export interface PdfNativeImage {
  id: string;
  src: string;
  mime: "image/png" | "image/jpeg";
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfAssembler {
  addPage(
    image: PdfPageImage | null,
    textRuns: PdfTextRun[],
    deco?: import("./exportVectorDecor").PageDeco,
    patches?: PdfPatchImage[],
    natives?: PdfNativeImage[]
  ): Promise<void>;
  save(): Promise<Uint8Array>;
  info(): PdfAssembleInfo;
}

/** run 的横向跨度（px；advances 优先，缺省按字号粗估）。 */
function runWidthPx(run: PdfTextRun): number {
  if (run.advances && run.advances.length > 0) {
    return run.advances.reduce((s, v) => s + v, 0);
  }
  return Array.from(run.text).length * run.size * 0.6;
}

/** data URL → 字节（原生嵌入图片解码用）。 */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const i = dataUrl.indexOf(",");
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
  return bytes;
}

export async function createPdfAssembler(
  o: PdfAssemblerOptions
): Promise<PdfAssembler> {
  // 懒加载红线：pdf-lib / fontkit 只在真正导出 PDF 时进内存。
  const pdfLib = await import("pdf-lib");
  const { PDFDocument, TextRenderingMode } = pdfLib;
  const fontkitMod = (await import("@pdf-lib/fontkit")) as unknown as {
    default?: unknown;
  };
  const fontkit = fontkitMod.default ?? fontkitMod;

  const doc = await PDFDocument.create();
  doc.setProducer("mditor 自研导出管线");
  doc.setCreator("mditor");
  if (o.title) doc.setTitle(o.title);
  if (o.fontBytes && o.fontBytes.byteLength > 0) {
    try {
      doc.registerFontkit(fontkit as never);
    } catch {
      /* fontkit 注册失败：后续嵌入逐项报失败 */
    }
  }

  // ---- 按需字体嵌入（RVF 阶段一）：零使用的字体不入册。立嵌的空 CFF
  // subset 在 save 编码时挂死（fontkit 空 charstrings 越界，实测纯拉丁
  // 文档 main=Noto 零使用必触发）——且省 8.3MB 主字体解码与产物体积。
  // 每页 addPage 预扫描 runs 需要的字体面（main + 用到的 Inter 变体），
  // 首次使用时嵌入（doc 级缓存，跨页复用）。
  let mainFont: import("pdf-lib").PDFFont | null = null;
  let mainFontFailed = false;
  const latinFonts = new Map<LatinFontVariant, import("pdf-lib").PDFFont>();
  let embedFontMs = 0;
  const latinBytesOf = (
    v: LatinFontVariant
  ): Uint8Array | undefined =>
    (
      {
        "latin-regular": o.latinFontBytes?.regular,
        "latin-bold": o.latinFontBytes?.bold,
        "latin-italic": o.latinFontBytes?.italic,
        "latin-bolditalic": o.latinFontBytes?.boldItalic,
      } as Record<LatinFontVariant, Uint8Array | undefined>
    )[v];
  const ensureMain = async (): Promise<boolean> => {
    if (mainFont) return true;
    if (mainFontFailed) return false;
    if (!o.fontBytes || o.fontBytes.byteLength === 0) {
      mainFontFailed = true;
      return false;
    }
    const t = Date.now();
    try {
      mainFont = await doc.embedFont(o.fontBytes, { subset: true });
      info.fontEmbedded = true;
    } catch {
      mainFontFailed = true; // 字体损坏/不支持 → 该字体永久缺位
    }
    embedFontMs += Date.now() - t;
    return !!mainFont;
  };
  const ensureLatin = async (v: LatinFontVariant): Promise<boolean> => {
    if (latinFonts.has(v)) return true;
    const bytes = latinBytesOf(v);
    if (!bytes || bytes.byteLength === 0) return false;
    const t = Date.now();
    try {
      latinFonts.set(v, await doc.embedFont(bytes, { subset: true }));
    } catch {
      return false; // 该变体嵌入失败：拉丁 run 该字重/字型退主字体
    }
    embedFontMs += Date.now() - t;
    return true;
  };

  // px→pt 统一比例：内容盒水平方向的真实比（版心宽按此构造，垂直同比例）。
  const k =
    (o.pageWidthPt - o.marginPt.left - o.marginPt.right) / o.contentWidthPx;
  const contentWpt = o.contentWidthPx * k;
  const contentHpt = o.contentHeightPx * k;
  // 原生图片嵌入缓存（同图多次引用只嵌一次）。
  const nativeCache = new Map<string, Awaited<ReturnType<typeof doc.embedPng>>>();

  const info: PdfAssembleInfo = {
    pages: 0,
    fontEmbedded: false, // 按需嵌入：首次成功嵌入 main 后置 true
    latinFontsEmbedded: 0, // info() 动态取 latinFonts.size
    embedFontMs: 0, // ensure* 累计
    textRunsPlaced: 0,
    glyphsPlaced: 0,
    textOpsPlaced: 0,
    visibleRunsPlaced: 0,
    visibleGlyphsPlaced: 0,
  };

  return {
    async addPage(image, textRuns, deco, patches, natives) {
      // 宏任务让渡（EX-P 实测教训：pdf-lib 铺字/编码是重同步 JS，不让渡
      // 会饱和主线程——进度 UI 冻结、取消信号无机会处理、CDP 观测饿死）。
      // 逐页一次：粒度 ≈ 每页铺字时长（亚秒~秒级），UI 呼吸感足够。
      await new Promise((res) => setTimeout(res, 0));
      const page = doc.addPage([o.pageWidthPt, o.pageHeightPt]);
      const toRgb = (c: { r: number; g: number; b: number }) =>
        pdfLib.rgb(c.r / 255, c.g / 255, c.b / 255);
      // px→pt 辅助：x 水平、y 自内容盒顶向下（PDF 原点左下，翻转）。
      const px = (v: number): number => o.marginPt.left + v * k;
      const py = (v: number): number => o.pageHeightPt - o.marginPt.top - v * k;
      // 满铺位图（raster 模式；vector 模式 image=null，底色走 deco.rects[0]）。
      if (image) {
        // embedJpg 直通压缩字节（DCTDecode），embedPng 会解码并驻留 RGBA 到
        // save——大文档 JPEG 档是内存护栏（EX-P 实测：87 页 × 2x PNG 解码
        // 驻留 ~1GB 撞内存墙）。
        const img =
          image.mime === "image/jpeg"
            ? await doc.embedJpg(image.bytes)
            : await doc.embedPng(image.bytes);
        // PDF 原点在左下：内容盒左上 = (marginL, pageH - marginT)。
        page.drawImage(img, {
          x: o.marginPt.left,
          y: o.pageHeightPt - o.marginPt.top - contentHpt,
          width: contentWpt,
          height: contentHpt,
        });
      }
      info.pages++;
      // ---- 块级矢量装饰（RV 阶段二）：页底色（rects[0]）→ 引用底色/竖条 →
      // 表格边框/hr 线。底色必须垫底（vector 模式无满铺位图，它就是纸面）；
      // 补丁/原生图随后压上（补丁自带块底色，如代码块底）。----
      if (deco) {
        for (const r of deco.rects) {
          page.drawRectangle({
            x: px(r.x),
            y: py(r.y + r.h),
            width: Math.max(r.w * k, 0.1),
            height: Math.max(r.h * k, 0.1),
            color: toRgb(r.color),
          });
        }
        for (const l of deco.lines) {
          page.drawLine({
            start: { x: px(l.x1), y: py(l.y1) },
            end: { x: px(l.x2), y: py(l.y2) },
            thickness: Math.max(l.width * k, 0.3),
            color: toRgb(l.color),
          });
        }
      }
      // ---- 局部补丁 + 原生图片（RV 阶段三）：装饰之上、文本之下 ----
      if (patches) {
        for (const p of patches) {
          const img = await doc.embedPng(p.bytes);
          page.drawImage(img, {
            x: px(p.x),
            y: py(p.y + p.h),
            width: Math.max(p.w * k, 0.1),
            height: Math.max(p.h * k, 0.1),
          });
        }
      }
      if (natives) {
        for (const n of natives) {
          let img = nativeCache.get(n.id);
          if (!img) {
            img =
              n.mime === "image/jpeg"
                ? await doc.embedJpg(dataUrlToBytes(n.src))
                : await doc.embedPng(dataUrlToBytes(n.src));
            nativeCache.set(n.id, img);
          }
          page.drawImage(img, {
            x: px(n.x),
            y: py(n.y + n.h),
            width: Math.max(n.w * k, 0.1),
            height: Math.max(n.h * k, 0.1),
          });
        }
      }
      // ---- 按需嵌入（RVF 阶段一）：预扫描本页 runs 的字体面 ----
      // needMain = 影子 run / 无 variants run / variants 含 CJK 段或该变体
      // 无字节（回主字体）；否则只嵌用到的 Inter 变体（纯拉丁页不触 8.3MB
      // 主字体解码，也规避空 CFF subset 的 save 挂死）。
      let needMain = false;
      const needLatin = new Set<LatinFontVariant>();
      for (const run of textRuns) {
        if (!run.text) continue;
        const vars =
          run.variants && run.variants.length === Array.from(run.text).length
            ? run.variants
            : undefined;
        if (!vars) {
          needMain = true;
          continue;
        }
        for (const v of vars) {
          if (v === CJK_VARIANT || !latinBytesOf(v as LatinFontVariant)) {
            needMain = true;
          } else {
            needLatin.add(v as LatinFontVariant);
          }
        }
      }
      const latinOk = await Promise.all([...needLatin].map((v) => ensureLatin(v)));
      if (latinOk.some((ok) => !ok)) needMain = true; // 变体失败回主字体
      if (needMain && !(await ensureMain())) return; // 主字体缺位：整页文本层跳过（旧语义）

      // ---- run 级背景（mark 高亮等）：铺字前画（垫在文字下）----
      for (const run of textRuns) {
        if (!run.bg || run.top == null || run.height == null) continue;
        const w = runWidthPx(run);
        if (w <= 0) continue;
        page.drawRectangle({
          x: px(run.x),
          y: py(run.top + run.height),
          width: w * k,
          height: run.height * k,
          color: toRgb(run.bg.color),
        });
      }
      // 文本渲染模式（RV 轮）：可见矢量 run 用 Fill（显式重推——Tr 状态跨
      // 文本对象持久，防止前序 3 Tr 污染后续绘制）；合成加粗用 FillAndStroke
      // + ~0.026em 细描边（描边同填色）；影子 run 用 Tr 3。
      const trFill = () =>
        page.pushOperators(pdfLib.setTextRenderingMode(TextRenderingMode.Fill));
      const trBold = (sizePt: number, c: { r: number; g: number; b: number }): void => {
        page.pushOperators(
          pdfLib.setTextRenderingMode(TextRenderingMode.FillAndOutline),
          pdfLib.setLineWidth(Math.max(sizePt * 0.026, 0.24)),
          pdfLib.setStrokingColor(pdfLib.rgb(c.r / 255, c.g / 255, c.b / 255))
        );
      };
      // 隐形文本层（EX-P）：Tr 3 对后续文本对象生效（文本状态可设于 BT
      // 外）。逐 run 重推一次（4 字节/run）——对 pdf-lib 内部可能的 q/Q
      // 包裹免疫，不依赖跨 BT/ET 的状态持久假设。
      const tr3 = () =>
        page.pushOperators(
          pdfLib.setTextRenderingMode(TextRenderingMode.Invisible)
        );
      /** ε-合并组铺字：期望 advance 与嵌入字体自然 advance 一致（<0.5px）
       *  的连续字符合并为一次 drawText（CJK 全宽字符几乎总命中——算子数
       *  骤减）；不一致处断组、按实测位重锚（拉丁逐字精度，D-2 分治）。
       *  RVF 阶段一：字体变体变化处同断组——拉丁段切 Inter 变体（真粗/斜），
       *  CJK 段回主字体（合成兜底），混合 run 并存。 */
      const EPS_PX = 0.5;
      // 拉丁字符逐字锚定（RVF 阶段一，字符级规则——影子/可见同规则）：
      // 嵌入字体（Inter 可见层 / Noto 影子层）的自然 advance 都与编辑器
      // 实测（Segoe UI 复合字体）有系统性小差，任何合并容差内的漂移都会
      // 让抽取器的空格推断在两模式间不一致（实测 ε=0.5 差 21 处）——
      // 拉丁字符 ε=0 逐字重锚（位置只取实测位），CJK 全宽字符维持 0.5px
      // 合并（Noto 自然 advance 与实测一致，零漂移且算子数骤减）。
      const epsFor = (ch: string): number => (isLatinScript(ch) ? 0 : EPS_PX);
      /** 字形自然宽度缓存（EX-P 实测热点：fontkit 逐字 layout 是铺字主要
       *  成本；CJK 字符高频重复，(font, char, size) 级缓存把重复字形查询压
       *  到 O(1)）。 */
      interface SlotFont {
        font: import("pdf-lib").PDFFont;
        /** 缓存键（区分字体实例）。 */
        key: string;
        /** Inter 变体段（真粗/斜，禁合成）。 */
        latin: boolean;
      }
      // needMain=false 时主字体未嵌入：预扫描保证该页无 run 引用 mainSlot。
      const mainSlot: SlotFont = { font: mainFont!, key: "cjk", latin: false };
      const slotOfVariant = (v: RunFontVariant | undefined): SlotFont => {
        if (v && v !== CJK_VARIANT) {
          const f =
            latinFonts.get(v as LatinFontVariant) ??
            latinFonts.get("latin-regular");
          if (f) return { font: f, key: v, latin: true };
        }
        return mainSlot;
      };
      const naturalCache = new Map<string, number>();
      const naturalWidth = (
        slot: SlotFont,
        ch: string,
        size: number
      ): number => {
        const key = slot.key + "\u0000" + ch + "\u0000" + size;
        let w = naturalCache.get(key);
        if (w === undefined) {
          w = slot.font.widthOfTextAtSize(ch, size) / k;
          naturalCache.set(key, w);
        }
        return w;
      };
      for (const run of textRuns) {
        if (!run.text) continue;
        const sizePt = Math.max(run.size * k, 0.1);
        const yPt = o.pageHeightPt - o.marginPt.top - run.baselineY * k;
        const chars = Array.from(run.text);
        // 可见矢量 or Tr 3 影子（vectorText 关闭 = 全影子，旧满铺行为）。
        const visible = !!(o.vectorText && !run.shadow && run.color);
        const fillColor = visible
          ? pdfLib.rgb(run.color!.r / 255, run.color!.g / 255, run.color!.b / 255)
          : undefined;
        if (visible) info.visibleRunsPlaced++;
        info.textRunsPlaced++;
        // 影子 run 同样按逐字符变体取段字体（Tr 3 隐形但字形 bbox 参与
        // 抽取器的分词推断——两模式字形面必须一致）；无 variants 的旧式
        // run 一律主字体。
        const variants =
          run.variants && run.variants.length === chars.length
            ? run.variants
            : undefined;
        if (run.advances && run.advances.length === chars.length) {
          const positions: number[] = new Array(chars.length);
          {
            let x = run.x;
            for (let i = 0; i < chars.length; i++) {
              positions[i] = x;
              x += run.advances[i];
            }
          }
          let start = 0;
          let slot = variants ? slotOfVariant(variants[0]) : mainSlot;
          const emit = (end: number, segSlot: SlotFont): void => {
            if (end <= start) return;
            const s = chars.slice(start, end).join("");
            if (visible) {
              // 合成粗/斜体仅对 CJK 段生效（拉丁段已是 Inter 真变体）。
              if (!segSlot.latin && run.syntheticBold && run.color) {
                trBold(sizePt, run.color);
              } else {
                trFill();
              }
              info.visibleGlyphsPlaced += end - start;
            } else {
              tr3();
            }
            page.drawText(s, {
              x: o.marginPt.left + positions[start] * k,
              y: yPt,
              size: sizePt,
              font: segSlot.font,
              ...(fillColor ? { color: fillColor } : {}),
              ...(!segSlot.latin && run.syntheticItalic
                ? { xSkew: pdfLib.degrees(12) }
                : {}),
            });
            info.textOpsPlaced++;
            info.glyphsPlaced += end - start;
          };
          for (let i = 0; i < chars.length - 1; i++) {
            if (chars[i] === " " && !run.syntheticItalic) {
              // 空格不铺字（词距即位置差，抽取器按间隙还原词边界）。合成
              // 斜体例外：xSkew 使字形盒错位，抽取器的间隙推断失效会把
              // 「italic text」粘成「italictext」——空格照铺（字形空白，
              // 视觉不变）保词界。
              emit(i, slot);
              start = i + 1;
              slot = variants ? slotOfVariant(variants[start]) : mainSlot;
              continue;
            }
            if (variants && variants[i + 1] !== variants[start]) {
              // 字体变体边界（拉丁↔CJK / Regular↔Bold）：断组切字体。
              emit(i + 1, slot);
              start = i + 1;
              slot = slotOfVariant(variants[start]);
              continue;
            }
            const natural = naturalWidth(slot, chars[i], sizePt) + positions[i];
            const desired = positions[i + 1];
            if (Math.abs(desired - natural) > epsFor(chars[i])) {
              emit(i + 1, slot);
              start = i + 1;
            }
          }
          emit(chars.length, slot);
        } else {
          // 单锚路径（管线实测恒带 advances；防御路径）：主字体整体绘制
          // （NotoSansSC 拉丁亦有字形，不会 notdef）。
          if (visible) {
            if (run.syntheticBold && run.color) trBold(sizePt, run.color);
            else trFill();
            info.visibleGlyphsPlaced += chars.length;
          } else {
            tr3();
          }
          page.drawText(run.text, {
            x: o.marginPt.left + run.x * k,
            y: yPt,
            size: sizePt,
            font: mainSlot.font,
            ...(fillColor ? { color: fillColor } : {}),
            ...(run.syntheticItalic ? { xSkew: pdfLib.degrees(12) } : {}),
          });
          info.textOpsPlaced++;
          info.glyphsPlaced += chars.length;
        }
      }

      // ---- run 级装饰线（下划线/删除线；shadow run 也画——位图已摘线）----
      for (const run of textRuns) {
        if (!run.decor) continue;
        const w = runWidthPx(run);
        if (w <= 0) continue;
        for (const kind of run.decor.kinds) {
          const g = decorationLineGeometry(run.baselineY, run.size, kind);
          page.drawLine({
            start: { x: px(run.x), y: py(g.y) },
            end: { x: px(run.x + w), y: py(g.y) },
            thickness: Math.max(g.thickness * k, 0.3),
            color: toRgb(run.decor.color),
          });
        }
      }
    },
    async save() {
      return doc.save();
    },
    info: () => ({ ...info, latinFontsEmbedded: latinFonts.size }),
  };
}
