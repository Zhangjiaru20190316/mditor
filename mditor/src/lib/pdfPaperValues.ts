// PDF 纸张/边距值域（零依赖轻量模块）：store.ts（首屏路径，不能引重模块
// exportPdfPipeline——懒加载纪律）与 exportPdfPipeline / PrintDialog 三处
// 此前各自手写同一值域，加纸张/边距档位时 store 归一会把合法新值静默打回
// 默认。抽到这里作单一事实源（types.ts PrintPrefs 注释同步指向）。

export const PDF_PAPERS = {
  A4: { widthPt: 595.28, heightPt: 841.89, label: "A4（210×297mm）" },
  Letter: { widthPt: 612, heightPt: 792, label: "Letter（216×279mm）" },
  A3: { widthPt: 841.89, heightPt: 1190.55, label: "A3（297×420mm）" },
} as const;
export type PdfPaperId = keyof typeof PDF_PAPERS;

export const PDF_MARGIN_CHOICES = [10, 15, 20, 25] as const; // mm

/** 纸张 id 白名单（store 归一/打印链校验共用）。 */
export const PDF_PAPER_IDS = Object.keys(PDF_PAPERS) as PdfPaperId[];
