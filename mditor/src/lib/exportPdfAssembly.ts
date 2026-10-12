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

/** CSS px → pt 的名义比（96dpi 语义下 1px = 0.75pt；实际换算用内容盒比）。 */
export const PT_PER_PX = 72 / 96;

export interface PdfTextRun {
  text: string;
  /** run 起点 x（CSS px，相对内容盒左上）。 */
  x: number;
  /** 基线 y（CSS px，相对内容盒顶部，向下正）。 */
  baselineY: number;
  /** 字号（CSS px）。 */
  size: number;
  /** 逐字符期望宽度（px，与 text 等长）。给出则逐字锚定，否则 run 单锚。 */
  advances?: number[];
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
  title?: string;
}

export interface PdfAssembleInfo {
  pages: number;
  fontEmbedded: boolean;
  embedFontMs: number;
  textRunsPlaced: number;
  glyphsPlaced: number;
  /** 实际铺字 drawText 调用数（ε-合并组数；D-2 粒度/性能口径）。 */
  textOpsPlaced: number;
}

/** 逐页喂图（pipeline 分块光栅后即喂即释放，不整本驻留内存）。 */
export interface PdfAssembler {
  addPage(pngBytes: Uint8Array, textRuns: PdfTextRun[]): Promise<void>;
  save(): Promise<Uint8Array>;
  info(): PdfAssembleInfo;
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

  const t0 = Date.now();
  let font: import("pdf-lib").PDFFont | null = null;
  if (o.fontBytes && o.fontBytes.byteLength > 0) {
    try {
      doc.registerFontkit(fontkit as never);
      font = await doc.embedFont(o.fontBytes, { subset: true });
    } catch {
      font = null; // 字体损坏/不支持 → 纯光栅（info 如实报告）
    }
  }
  const embedFontMs = Date.now() - t0;

  // px→pt 统一比例：内容盒水平方向的真实比（版心宽按此构造，垂直同比例）。
  const k =
    (o.pageWidthPt - o.marginPt.left - o.marginPt.right) / o.contentWidthPx;
  const contentWpt = o.contentWidthPx * k;
  const contentHpt = o.contentHeightPx * k;

  const info: PdfAssembleInfo = {
    pages: 0,
    fontEmbedded: !!font,
    embedFontMs,
    textRunsPlaced: 0,
    glyphsPlaced: 0,
    textOpsPlaced: 0,
  };

  return {
    async addPage(pngBytes, textRuns) {
      const page = doc.addPage([o.pageWidthPt, o.pageHeightPt]);
      const img = await doc.embedPng(pngBytes);
      // PDF 原点在左下：内容盒左上 = (marginL, pageH - marginT)。
      page.drawImage(img, {
        x: o.marginPt.left,
        y: o.pageHeightPt - o.marginPt.top - contentHpt,
        width: contentWpt,
        height: contentHpt,
      });
      info.pages++;
      if (!font) return;

      // 隐形文本层（EX-P）：Tr 3 对后续文本对象生效（文本状态可设于 BT
      // 外）。逐 run 重推一次（4 字节/run）——对 pdf-lib 内部可能的 q/Q
      // 包裹免疫，不依赖跨 BT/ET 的状态持久假设。
      const tr3 = () =>
        page.pushOperators(
          pdfLib.setTextRenderingMode(TextRenderingMode.Invisible)
        );
      /** ε-合并组铺字：期望 advance 与嵌入字体自然 advance 一致（<0.5px）
       *  的连续字符合并为一次 drawText（CJK 全宽字符几乎总命中——算子数
       *  骤减）；不一致处断组、按实测位重锚（拉丁逐字精度，D-2 分治）。 */
      const EPS_PX = 0.5;
      for (const run of textRuns) {
        if (!run.text) continue;
        const sizePt = Math.max(run.size * k, 0.1);
        const yPt = o.pageHeightPt - o.marginPt.top - run.baselineY * k;
        const chars = Array.from(run.text);
        info.textRunsPlaced++;
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
          const emit = (end: number): void => {
            if (end <= start) return;
            const s = chars.slice(start, end).join("");
            tr3();
            page.drawText(s, {
              x: o.marginPt.left + positions[start] * k,
              y: yPt,
              size: sizePt,
              font,
            });
            info.textOpsPlaced++;
            info.glyphsPlaced += end - start;
          };
          for (let i = 0; i < chars.length - 1; i++) {
            if (chars[i] === " ") {
              // 空格不铺字（词距即位置差，抽取器按间隙还原词边界）。
              emit(i);
              start = i + 1;
              continue;
            }
            const natural =
              (font.widthOfTextAtSize(chars[i], sizePt) / k) +
              positions[i];
            const desired = positions[i + 1];
            if (Math.abs(desired - natural) > EPS_PX) {
              emit(i + 1);
              start = i + 1;
            }
          }
          emit(chars.length);
        } else {
          tr3();
          page.drawText(run.text, {
            x: o.marginPt.left + run.x * k,
            y: yPt,
            size: sizePt,
            font,
          });
          info.textOpsPlaced++;
          info.glyphsPlaced += chars.length;
        }
      }
    },
    async save() {
      return doc.save();
    },
    info: () => ({ ...info }),
  };
}
