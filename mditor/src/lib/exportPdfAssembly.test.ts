// PDF 组装器单测（EX 轮阶段三）：node 环境真跑 pdf-lib + fontkit（组装侧
// 无 DOM 依赖；光栅位图用合成 PNG 喂入）。文本层对位/光栅的浏览器侧由
// dev 实例 CDP 验收（perf/ex3-*）。

import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPdfAssembler } from "./exportPdfAssembly";

// 1×1 PNG（合法最小位图；组装器只关心 embedPng 可解码）。
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));
// 同一字节的 data URL 形态（原生嵌入路径用）。
const PNG_DATAURL = `data:image/png;base64,${PNG_B64}`;

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = { top: 42.52, right: 42.52, bottom: 42.52, left: 42.52 }; // 15mm
const CONTENT_PX = { w: 680, h: 950 };

let fontBytes: Uint8Array | null = null;
beforeAll(async () => {
  try {
    fontBytes = new Uint8Array(
      await readFile(join(__dirname, "../../assets/fonts/NotoSansSC-Regular.otf"))
    );
  } catch {
    fontBytes = null; // 字体缺位（CI 无字体）：文本层用例走降级断言
  }
});

/** 重载产物并解出第一页内容流文本（Tr 3/文本算子存在性断言用）。 */
async function contentStreamText(bytes: Uint8Array): Promise<string> {
  const { PDFDocument, PDFArray, PDFRef, decodePDFRawStream } = await import(
    "pdf-lib"
  );
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const deref = (o: unknown): unknown =>
    o instanceof PDFRef ? doc.context.lookup(o) : o;
  const contents = deref(page.node.Contents());
  const streams: { decode(): Uint8Array }[] = [];
  if (contents instanceof PDFArray) {
    for (const item of contents.asArray()) {
      const s = deref(item) as { decode(): Uint8Array };
      if (s) streams.push(s);
    }
  } else if (contents) {
    streams.push(contents as { decode(): Uint8Array });
  }
  let text = "";
  for (const s of streams) {
    text += new TextDecoder("latin1").decode(decodePDFRawStream(s as never).decode());
  }
  return text;
}

/** 产物内 /Font 子类型对象数（重载后枚举间接对象）。 */
async function fontCount(bytes: Uint8Array): Promise<number> {
  const { PDFDocument, PDFName } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  let n = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj as { dict?: Map<unknown, unknown> };
    if (dict?.dict?.get(PDFName.of("Type"))?.toString() === "/Font") n++;
  }
  return n;
}

describe("createPdfAssembler", () => {
  it("纯光栅（无字体）：出合法 PDF，页数/页尺寸/无字体", async () => {
    const a = await createPdfAssembler({
      pageWidthPt: A4.width,
      pageHeightPt: A4.height,
      marginPt: MARGIN,
      contentWidthPx: CONTENT_PX.w,
      contentHeightPx: CONTENT_PX.h,
      fontBytes: null,
    });
    await a.addPage({ bytes: TINY_PNG, mime: "image/png" }, []);
    await a.addPage({ bytes: TINY_PNG, mime: "image/png" }, []);
    const bytes = await a.save();
    expect(a.info().pages).toBe(2);
    expect(a.info().fontEmbedded).toBe(false);
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    const size = doc.getPage(0).getSize();
    expect(size.width).toBeCloseTo(A4.width, 1);
    expect(size.height).toBeCloseTo(A4.height, 1);
    expect(await fontCount(bytes)).toBe(0);
  });

  it("坏字体字节 → 降级纯光栅不抛错（fontEmbedded=false 如实报告）", async () => {
    const a = await createPdfAssembler({
      pageWidthPt: A4.width,
      pageHeightPt: A4.height,
      marginPt: MARGIN,
      contentWidthPx: CONTENT_PX.w,
      contentHeightPx: CONTENT_PX.h,
      fontBytes: new Uint8Array([1, 2, 3, 4, 5]),
    });
    await a.addPage({ bytes: TINY_PNG, mime: "image/png" }, [{ text: "测试", x: 10, baselineY: 20, size: 16 }]);
    expect(a.info().fontEmbedded).toBe(false);
    expect(a.info().textRunsPlaced).toBe(0); // 无字体不铺字
    await expect(a.save()).resolves.toBeInstanceOf(Uint8Array);
  });

  it.runIf(
    // 字体在位才跑（模块头注明：CI 无字体环境跳过文本层结构断言）。
    true
  )("文本层：CJK 子集内嵌 + Tr 3 隐形算子进内容流", async () => {
    if (!fontBytes) return; // 字体缺位：跳过（不 FAIL——见 runIf 说明）
    const a = await createPdfAssembler({
      pageWidthPt: A4.width,
      pageHeightPt: A4.height,
      marginPt: MARGIN,
      contentWidthPx: CONTENT_PX.w,
      contentHeightPx: CONTENT_PX.h,
      fontBytes,
      title: "t",
    });
    await a.addPage({ bytes: TINY_PNG, mime: "image/png" }, [
      { text: "无穷级数密度档压测", x: 24, baselineY: 40, size: 17 },
      { text: "series x⃗ = Σaₙ", x: 24, baselineY: 70, size: 17 },
    ]);
    const bytes = await a.save();
    const info = a.info();
    expect(info.pages).toBe(1);
    expect(info.fontEmbedded).toBe(true);
    expect(info.textRunsPlaced).toBe(2);
    // Type0 复合字体 = 父字典 + descendant CID 字典，共两个 /Font 对象。
    expect(await fontCount(bytes)).toBe(2);
    // 体积门：两 run 文本 + 1×1 位图 + 子集字体（~20 字形）→ 数十 KB 级。
    expect(bytes.length).toBeLessThan(200_000);
    expect(bytes.length).toBeGreaterThan(1_000);
    // Tr 3 存在性：解压内容流应含 "3 Tr"。
    const streamText = await contentStreamText(bytes);
    expect(streamText).toContain("3 Tr");
    expect(streamText).toContain("BT");
  });

  it("逐字锚定分支：advances 驱动逐字符铺字（glyphsPlaced 计数）", async () => {
    if (!fontBytes) return;
    const a = await createPdfAssembler({
      pageWidthPt: A4.width,
      pageHeightPt: A4.height,
      marginPt: MARGIN,
      contentWidthPx: CONTENT_PX.w,
      contentHeightPx: CONTENT_PX.h,
      fontBytes,
    });
    await a.addPage({ bytes: TINY_PNG, mime: "image/png" }, [
      {
        text: "abc",
        x: 10,
        baselineY: 30,
        size: 16,
        advances: [9.5, 9.7, 8.2],
      },
    ]);
    const info = a.info();
    expect(info.textRunsPlaced).toBe(1);
    expect(info.glyphsPlaced).toBe(3); // 逐字（无空格）
    await expect(a.save()).resolves.toBeInstanceOf(Uint8Array);
  });

  it("空文本 run 与空格字符：跳过/不铺字但不失败", async () => {
    if (!fontBytes) return;
    const a = await createPdfAssembler({
      pageWidthPt: A4.width,
      pageHeightPt: A4.height,
      marginPt: MARGIN,
      contentWidthPx: CONTENT_PX.w,
      contentHeightPx: CONTENT_PX.h,
      fontBytes,
    });
    await a.addPage({ bytes: TINY_PNG, mime: "image/png" }, [
      { text: "", x: 0, baselineY: 0, size: 16 },
      { text: "a b", x: 0, baselineY: 20, size: 16, advances: [9, 5, 9] },
    ]);
    expect(a.info().textRunsPlaced).toBe(1); // 空 run 不计
    expect(a.info().glyphsPlaced).toBe(2); // 空格不铺
  });

  // ---- RV 轮阶段一：矢量可见绘制（正常 Tr + 填色）----
  it("vectorText 模式：非 shadow 带色 run 可见绘制（0 Tr + rg 填色 + 可见计数）", async () => {
    if (!fontBytes) return;
    const a = await createPdfAssembler({
      pageWidthPt: A4.width,
      pageHeightPt: A4.height,
      marginPt: MARGIN,
      contentWidthPx: CONTENT_PX.w,
      contentHeightPx: CONTENT_PX.h,
      fontBytes,
      vectorText: true,
    });
    await a.addPage({ bytes: TINY_PNG, mime: "image/png" }, [
      // 可见矢量 run（正文色 #1f2328）
      { text: "矢量正文", x: 24, baselineY: 40, size: 16, color: { r: 31, g: 35, b: 40 } },
      // 影子 run（位图承载视觉）
      { text: "影子", x: 24, baselineY: 70, size: 16, shadow: true },
    ]);
    const info = a.info();
    expect(info.visibleRunsPlaced).toBe(1);
    expect(info.visibleGlyphsPlaced).toBe(4);
    expect(info.textRunsPlaced).toBe(2);
    const bytes = await a.save();
    const streamText = await contentStreamText(bytes);
    // 可见 run：Fill 模式（0 Tr）+ 非灰填色算子（rg）；影子 run：3 Tr。
    expect(streamText).toContain("0 Tr");
    expect(streamText).toContain("3 Tr");
    expect(streamText).toMatch(/0\.121569 0\.137255 0\.156863 rg/); // 31/35/40
  });

  it("vectorText 关闭（缺省）：带色 run 也走 Tr 3（旧满铺行为零扰动）", async () => {
    if (!fontBytes) return;
    const a = await createPdfAssembler({
      pageWidthPt: A4.width,
      pageHeightPt: A4.height,
      marginPt: MARGIN,
      contentWidthPx: CONTENT_PX.w,
      contentHeightPx: CONTENT_PX.h,
      fontBytes,
    });
    await a.addPage({ bytes: TINY_PNG, mime: "image/png" }, [
      { text: "颜色不生效", x: 0, baselineY: 20, size: 16, color: { r: 31, g: 35, b: 40 } },
    ]);
    const info = a.info();
    expect(info.visibleRunsPlaced).toBe(0);
    const bytes = await a.save();
    const streamText = await contentStreamText(bytes);
    expect(streamText).toContain("3 Tr");
    expect(streamText).not.toMatch(/\drg/); // 无填色算子
  });

  // ---- RV 轮阶段四：合成字重/斜体 + 补丁/原生图 ----
  it("合成加粗：FillAndOutline（2 Tr）+ 线宽 + 描边色进内容流", async () => {
    if (!fontBytes) return;
    const a = await createPdfAssembler({
      pageWidthPt: A4.width,
      pageHeightPt: A4.height,
      marginPt: MARGIN,
      contentWidthPx: CONTENT_PX.w,
      contentHeightPx: CONTENT_PX.h,
      fontBytes,
      vectorText: true,
    });
    await a.addPage({ bytes: TINY_PNG, mime: "image/png" }, [
      { text: "加粗标题", x: 24, baselineY: 40, size: 20, color: { r: 31, g: 35, b: 40 }, syntheticBold: true },
    ]);
    expect(a.info().visibleGlyphsPlaced).toBe(4);
    const streamText = await contentStreamText(await a.save());
    expect(streamText).toContain("2 Tr");
    expect(streamText).toMatch(/ w\n/); // setLineWidth
    expect(streamText).toMatch(/ RG\n/); // setStrokingColor
  });

  it("合成斜体：文本矩阵带剪切（xSkew → Tm 的 b 分量非零）", async () => {
    if (!fontBytes) return;
    const a = await createPdfAssembler({
      pageWidthPt: A4.width,
      pageHeightPt: A4.height,
      marginPt: MARGIN,
      contentWidthPx: CONTENT_PX.w,
      contentHeightPx: CONTENT_PX.h,
      fontBytes,
      vectorText: true,
    });
    await a.addPage({ bytes: TINY_PNG, mime: "image/png" }, [
      { text: "italic", x: 24, baselineY: 40, size: 16, color: { r: 0, g: 0, b: 0 }, syntheticItalic: true },
    ]);
    const streamText = await contentStreamText(await a.save());
    // Tm = [a b c d e f]；xSkew 使 b（第二分量）非零。
    const m = streamText.match(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) Tm/);
    expect(m).toBeTruthy();
    expect(parseFloat(m![2])).toBeGreaterThan(0.05); // b = tan(12°) ≈ 0.2126 × size 缩放
  });

  it("满铺位图退位：image=null + 补丁/原生图入册（页数与图片计数）", async () => {
    if (!fontBytes) return;
    const a = await createPdfAssembler({
      pageWidthPt: A4.width,
      pageHeightPt: A4.height,
      marginPt: MARGIN,
      contentWidthPx: CONTENT_PX.w,
      contentHeightPx: CONTENT_PX.h,
      fontBytes,
      vectorText: true,
    });
    await a.addPage(
      null,
      [{ text: "补丁页", x: 24, baselineY: 40, size: 16, color: { r: 0, g: 0, b: 0 } }],
      { rects: [{ x: 0, y: 0, w: CONTENT_PX.w, h: CONTENT_PX.h, color: { r: 250, g: 249, b: 245 } }], lines: [] },
      [{ bytes: TINY_PNG, mime: "image/png", x: 10, y: 10, w: 20, h: 20 }],
      [{ id: "native-1", src: PNG_DATAURL, mime: "image/png", x: 40, y: 10, w: 30, h: 30 }]
    );
    expect(a.info().pages).toBe(1);
    const bytes = await a.save();
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(bytes);
    // 1 补丁 + 1 原生 = 2 张图（无满铺）。
    const imgs = doc.context.enumerateIndirectObjects().filter(([, o]) => {
      const s = String(o);
      return s.includes("/Subtype") && s.includes("/Image");
    });
    expect(imgs.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// RVF 阶段一：Inter 变体内嵌——拉丁 run 真粗/斜体（合成 2 Tr 退位为 CJK 兜底）。
// ---------------------------------------------------------------------------
import { runVariants } from "./exportVectorText";
import type { LatinFontBytes } from "./exportPdfAssembly";

describe("createPdfAssembler：Inter 变体（RVF 阶段一）", () => {
  let notoBytes: Uint8Array | null = null;
  let interBytes: LatinFontBytes | null = null;
  beforeAll(async () => {
    const read = (p: string) =>
      readFile(join(__dirname, `../../public/assets/fonts/${p}`)).then(
        (b) => new Uint8Array(b)
      );
    try {
      notoBytes = await read("NotoSansSC-Regular.otf");
    } catch {
      notoBytes = null;
    }
    try {
      const [regular, bold, italic, boldItalic] = await Promise.all([
        read("Inter-Medium.ttf"),
        read("Inter-Bold.ttf"),
        read("Inter-MediumItalic.ttf"),
        read("Inter-BoldItalic.ttf"),
      ]);
      interBytes = { regular, bold, italic, boldItalic };
    } catch {
      interBytes = null;
    }
  });

  const opts = () => ({
    pageWidthPt: A4.width,
    pageHeightPt: A4.height,
    marginPt: MARGIN,
    contentWidthPx: CONTENT_PX.w,
    contentHeightPx: CONTENT_PX.h,
  });

  it("拉丁真粗体：syntheticBold 标记不再触发 2 Tr（Inter-Bold 承担）", async () => {
    if (!notoBytes || !interBytes) return;
    const asm = await createPdfAssembler({
      ...opts(),
      fontBytes: notoBytes,
      latinFontBytes: interBytes,
      vectorText: true,
    });
    const text = "Bold latin text";
    await asm.addPage(
      null,
      [
        {
          text,
          x: 10,
          baselineY: 100,
          size: 16,
          advances: Array.from(text, () => 8),
          color: { r: 20, g: 20, b: 20 },
          syntheticBold: true,
          variants: runVariants(text, 700, "normal"),
        },
      ],
      undefined,
      undefined,
      undefined
    );
    const bytes = await asm.save();
    // 按需嵌入：只嵌用到的 latin-bold（零使用字体不入册——空 CFF subset
    // 在 save 编码挂死，纯拉丁页也不触 8.3MB 主字体解码）
    expect(asm.info().latinFontsEmbedded).toBe(1);
    expect(asm.info().fontEmbedded).toBe(false);
    const cs = await contentStreamText(bytes);
    expect(cs).not.toContain("2 Tr");
  }, 60_000);

  it("CJK 粗体兜底保留合成（2 Tr 在）且混合 run 真假粗并存", async () => {
    if (!notoBytes || !interBytes) return;
    const asm = await createPdfAssembler({
      ...opts(),
      fontBytes: notoBytes,
      latinFontBytes: interBytes,
      vectorText: true,
    });
    const text = "Bold 加粗标题";
    await asm.addPage(
      null,
      [
        {
          text,
          x: 10,
          baselineY: 100,
          size: 16,
          advances: Array.from(text, () => 8),
          color: { r: 20, g: 20, b: 20 },
          syntheticBold: true,
          variants: runVariants(text, 700, "normal"),
        },
      ],
      undefined,
      undefined,
      undefined
    );
    const bytes = await asm.save();
    const cs = await contentStreamText(bytes);
    // CJK 段仍走 FillAndOutline 合成（2 Tr ≥1）；拉丁段（Bold+空格）真字体
    // 不描边——2 Tr 次数应小于段数（只有 CJK 段贡献）。
    const twoTr = cs.split("2 Tr").length - 1;
    expect(twoTr).toBeGreaterThanOrEqual(1);
    // 按需嵌入：main + latin-bold（Type0+Descendant 各 2 个 /Font 对象）
    expect(await fontCount(bytes)).toBeGreaterThanOrEqual(4);
    expect(asm.info().latinFontsEmbedded).toBe(1);
  }, 60_000);

  it("影子 run 忽略 variants（Tr 3 主字体，不拆段）", async () => {
    if (!notoBytes || !interBytes) return;
    const asm = await createPdfAssembler({
      ...opts(),
      fontBytes: notoBytes,
      latinFontBytes: interBytes,
      vectorText: true,
    });
    const text = "shadow 混排 中文";
    await asm.addPage(
      null,
      [
        {
          text,
          x: 10,
          baselineY: 100,
          size: 16,
          advances: Array.from(text, () => 8),
          shadow: true,
          variants: runVariants(text, 400, "normal"),
        },
      ],
      undefined,
      undefined,
      undefined
    );
    await asm.save();
    const info = asm.info();
    expect(info.visibleRunsPlaced).toBe(0);
    // 影子层拉丁也用 Inter（bbox 一致性）：按需嵌入 latin-regular
    expect(info.latinFontsEmbedded).toBe(1);
  }, 60_000);

  it("Inter 字节全缺 → latinFontsEmbedded=0，拉丁 run 回主字体（无 notdef 风险面不变）", async () => {
    if (!notoBytes) return;
    const asm = await createPdfAssembler({
      ...opts(),
      fontBytes: notoBytes,
      latinFontBytes: null,
      vectorText: true,
    });
    const text = "fallback latin";
    await asm.addPage(
      null,
      [
        {
          text,
          x: 10,
          baselineY: 100,
          size: 16,
          advances: Array.from(text, () => 8),
          color: { r: 20, g: 20, b: 20 },
          variants: runVariants(text, 400, "normal"),
        },
      ],
      undefined,
      undefined,
      undefined
    );
    await asm.save();
    expect(asm.info().latinFontsEmbedded).toBe(0);
  }, 60_000);
});
