// PDF 组装器单测（EX 轮阶段三）：node 环境真跑 pdf-lib + fontkit（组装侧
// 无 DOM 依赖；光栅位图用合成 PNG 喂入）。文本层对位/光栅的浏览器侧由
// dev 实例 CDP 验收（perf/ex3-*）。

import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPdfAssembler } from "./exportPdfAssembly";

// 1×1 PNG（合法最小位图；组装器只关心 embedPng 可解码）。
const TINY_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  ),
  (c) => c.charCodeAt(0)
);

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
    await a.addPage(TINY_PNG, []);
    await a.addPage(TINY_PNG, []);
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
    await a.addPage(TINY_PNG, [{ text: "测试", x: 10, baselineY: 20, size: 16 }]);
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
    await a.addPage(TINY_PNG, [
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
    await a.addPage(TINY_PNG, [
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
    await a.addPage(TINY_PNG, [
      { text: "", x: 0, baselineY: 0, size: 16 },
      { text: "a b", x: 0, baselineY: 20, size: 16, advances: [9, 5, 9] },
    ]);
    expect(a.info().textRunsPlaced).toBe(1); // 空 run 不计
    expect(a.info().glyphsPlaced).toBe(2); // 空格不铺
  });
});
