// MF 轮阶段 1：docNote 纯函数单测（扩展名判别 / TabItem 构造 / key 稳定性 /
// 大小写 / .doc 明确不支持）。对齐 htmlNote.test.ts 的锚点风格。

import { describe, expect, it } from "vitest";

import {
  DOC_NOTE_EXTS,
  DOC_NOTE_RE,
  DOCX_EXTS,
  PDF_EXTS,
  dataUrlImageExt,
  docTabKey,
  isDocNote,
  isDocTab,
  isDocxNote,
  isDocxTab,
  isPdfNote,
  isPdfTab,
  makeDocxTab,
  makePdfTab,
  rebuildPdfParagraphs,
  splitDataUrl,
  type PdfTextPiece,
} from "./docNote";
import type { TabItem } from "../types";

const mdTab: TabItem = {
  key: "untitled-1",
  path: null,
  name: "未命名.md",
  dirty: false,
  content: "",
};

// ---- 扩展名判别 ---------------------------------------------------------------

describe("PDF_EXTS / DOCX_EXTS / DOC_NOTE_EXTS", () => {
  it("集合形态：并集恰为 .pdf + .docx，不含 .doc", () => {
    expect(PDF_EXTS.has(".pdf")).toBe(true);
    expect(DOCX_EXTS.has(".docx")).toBe(true);
    expect(DOCX_EXTS.has(".doc")).toBe(false);
    expect([...DOC_NOTE_EXTS].sort()).toEqual([".docx", ".pdf"]);
  });
});

describe("isPdfNote / isDocxNote / isDocNote", () => {
  it("大小写不敏感；排除近形扩展名 / 无扩展名 / .doc", () => {
    expect(isPdfNote("a.pdf")).toBe(true);
    expect(isPdfNote("B.PDF")).toBe(true);
    expect(isPdfNote("c.pdfx")).toBe(false);
    expect(isPdfNote("d.md")).toBe(false);
    expect(isPdfNote("noext")).toBe(false);
    expect(isDocxNote("e.docx")).toBe(true);
    expect(isDocxNote("F.DOCX")).toBe(true);
    // .doc（97-2003 老格式）明确不支持——不进任何集合。
    expect(isDocxNote("g.doc")).toBe(false);
    expect(isDocNote("g.doc")).toBe(false);
    expect(isDocNote("a.pdf")).toBe(true);
    expect(isDocNote("e.docx")).toBe(true);
    expect(isDocNote("h.md")).toBe(false);
    expect(isDocNote("noext")).toBe(false);
  });

  it("路径形态（分隔符与多段扩展名）", () => {
    expect(isPdfNote("C:\\Notes\\我的 文件\\x.Pdf")).toBe(true);
    expect(isDocxNote("C:/a.b/c.DOCX")).toBe(true);
    expect(isPdfNote("C:/a/pdf")).toBe(false); // 扩展名为空
  });
});

describe("DOC_NOTE_RE（拖拽/CLI 判定）", () => {
  it("匹配 pdf/docx（大小写不敏感），排除 .doc 与近形", () => {
    expect(DOC_NOTE_RE.test("x.PDF")).toBe(true);
    expect(DOC_NOTE_RE.test("y.docx")).toBe(true);
    expect(DOC_NOTE_RE.test("z.doc")).toBe(false);
    expect(DOC_NOTE_RE.test("z.pptx")).toBe(false);
    expect(DOC_NOTE_RE.test("z.pdfx")).toBe(false);
  });
});

// ---- TabItem 构造 / 判别 ------------------------------------------------------

describe("makePdfTab / makeDocxTab", () => {
  it("kind=pdf、dirty 恒 false、content 恒空、key 前缀 pdf- 且路径归一小写", () => {
    const t = makePdfTab("C:\\Notes\\Demo.PDF");
    expect(t.kind).toBe("pdf");
    expect(t.dirty).toBe(false);
    expect(t.content).toBe("");
    expect(t.name).toBe("Demo.PDF");
    expect(t.key).toBe("pdf-c:/notes/demo.pdf"); // Windows 大小写不敏感
  });

  it("kind=docx、key 前缀 docx-（与 pdf 标签同路径不碰撞）", () => {
    const t = makeDocxTab("C:\\Notes\\Resume.docx");
    expect(t.kind).toBe("docx");
    expect(t.dirty).toBe(false);
    expect(t.content).toBe("");
    expect(t.key).toBe("docx-c:/notes/resume.docx");
  });

  it("docTabKey：同一函数按扩展名分发前缀（单一来源）", () => {
    expect(docTabKey("C:/Notes/a.pdf")).toBe("pdf-c:/notes/a.pdf");
    expect(docTabKey("C:/Notes/a.docx")).toBe("docx-c:/notes/a.docx");
    // 反斜杠路径归一为 posix。
    expect(docTabKey("C:\\Notes\\A.PDF")).toBe("pdf-c:/notes/a.pdf");
  });
});

describe("isPdfTab / isDocxTab / isDocTab", () => {
  it("undefined kind = md（兼容既有构造点）；null/undefined 标签为 false", () => {
    expect(isPdfTab(mdTab)).toBe(false);
    expect(isDocxTab(mdTab)).toBe(false);
    expect(isDocTab(mdTab)).toBe(false);
    expect(isPdfTab({ ...mdTab, kind: "md" })).toBe(false);
    expect(isDocTab({ ...mdTab, kind: "md" })).toBe(false);
    expect(isPdfTab(makePdfTab("C:/x.pdf"))).toBe(true);
    expect(isDocxTab(makeDocxTab("C:/x.docx"))).toBe(true);
    expect(isDocTab(makePdfTab("C:/x.pdf"))).toBe(true);
    expect(isDocTab(makeDocxTab("C:/x.docx"))).toBe(true);
    expect(isPdfTab(null)).toBe(false);
    expect(isDocTab(null)).toBe(false);
    expect(isDocTab(undefined)).toBe(false);
  });
});

// ---- 转 Markdown：PDF 段落重建启发式（纯函数）--------------------------------

/** piece 构造捷径（h=10 → 分行容差 5、段落阈值 19）。 */
function P(str: string, x: number, y: number, w = 20, h = 10): PdfTextPiece {
  return { str, x, y, width: w, height: h };
}

describe("rebuildPdfParagraphs", () => {
  it("近行距合并为一段（西文补空格）；大行距分段", () => {
    const page = [
      P("Hello", 0, 100, 30),
      P("world", 0, 88, 25), // 行距 12 < 10×1.9 → 同段
      P("Para two", 0, 70, 40), // 行距 18 → 仍同段？ 88-70=18 < 19 → 同段
    ];
    // 说明：阈值 19 下 12/18 均为软换行；再抬一档验证分段。
    const page2 = [P("A", 0, 100, 8), P("B", 0, 70, 8)]; // 行距 30 > 19 → 分段
    expect(rebuildPdfParagraphs([page])).toBe("Hello world Para two");
    expect(rebuildPdfParagraphs([page2])).toBe("A\n\nB");
  });

  it("CJK 邻接直连（行内与跨行都不补空格）", () => {
    const sameLine = [P("中", 0, 100, 10), P("文", 11, 100, 10)];
    expect(rebuildPdfParagraphs([sameLine])).toBe("中文");
    const crossLine = [P("第一行", 0, 100, 30), P("第二行", 0, 88, 30)];
    expect(rebuildPdfParagraphs([crossLine])).toBe("第一行第二行");
  });

  it("行内间距超阈值补空格（西文词间距）", () => {
    const line = [P("Hel", 0, 100, 20), P("lo", 24, 100, 10)]; // gap 4 > 1
    expect(rebuildPdfParagraphs([line])).toBe("Hel lo");
  });

  it("项目符号转 MD 列表语法（DE 轮 M4）", () => {
    const page = [
      P("• 项目一", 0, 100, 50),
      P("• 项目二", 0, 88, 50),
    ];
    expect(rebuildPdfParagraphs([page])).toBe("- 项目一\n\n- 项目二");
  });

  it("M4：数字/字母编号转 MD 有序列表（保留原编号；软换行并入列表项）", () => {
    const page = [
      P("1、采购清单如下", 0, 100, 20),
      P("2、验收标准见附录", 0, 86, 20),
      P("b) 次要条款", 0, 72, 20),
    ];
    expect(rebuildPdfParagraphs([page])).toBe(
      "1. 采购清单如下\n\n2. 验收标准见附录\n\nb. 次要条款"
    );
    // 软换行延续并入前一项（gap 16 < 20×1.9，无新 bullet）。
    const wrapped = [
      P("- 第一项开头", 0, 100, 20),
      P("第一项的换行延续", 0, 84, 20),
    ];
    expect(rebuildPdfParagraphs([wrapped])).toBe("- 第一项开头第一项的换行延续");
  });

  it("M4：字号聚类映射标题层级（#/##/###）", () => {
    // 正文行占多数 → 页中位字号 20；24→###、30→##、40→#；标题与前行距需
    // > 1.2×中位（真实页面正文占多数，中位数即正文字号）。P 第 5 参为字号。
    const page = [
      P("大标题一级", 0, 700, 60, 40),
      P("二级标题样例", 0, 650, 60, 30),
      P("三级小节标题", 0, 610, 60, 24),
      P("正文第一行占位，字号二十。", 0, 570, 60, 20),
      P("正文第二行占位，字号二十。", 0, 556, 60, 20),
      P("正文第三行占位，字号二十。", 0, 542, 60, 20),
      P("正文第四行占位，字号二十。", 0, 528, 60, 20),
      P("正文第五行软换行延续", 0, 514, 60, 20),
    ];
    const out = rebuildPdfParagraphs([page]);
    expect(out).toContain("# 大标题一级");
    expect(out).toContain("## 二级标题样例");
    expect(out).toContain("### 三级小节标题");
    expect(out.startsWith("# 大标题一级")).toBe(true);
  });

  it("M4：软换行的大字号行不误判为标题（行距不足 1.2×中位）", () => {
    const page = [P("大字行", 0, 100, 40, 30), P("大字行续", 0, 88, 40, 30)];
    expect(rebuildPdfParagraphs([page])).toBe("大字行大字行续");
  });

  it("页间 --- 分隔；空页跳过", () => {
    const p1 = [P("one", 0, 100, 20)];
    const p3 = [P("three", 0, 100, 30)];
    expect(rebuildPdfParagraphs([p1, [], p3])).toBe("one\n\n---\n\nthree");
    expect(rebuildPdfParagraphs([[], []])).toBe("");
  });

  it("乱序输入按位置重排（x 序、y 降序）", () => {
    const page = [P("world", 0, 88, 25), P("Hello", 0, 100, 30)];
    expect(rebuildPdfParagraphs([page])).toBe("Hello world");
  });
});

// ---- 转 Markdown：data URL 拆解（纯函数）--------------------------------------

describe("splitDataUrl / dataUrlImageExt", () => {
  it("base64 data URL → mime + 字节", () => {
    const r = splitDataUrl("data:image/png;base64,aGk=");
    expect(r?.mime).toBe("image/png");
    expect(r && Array.from(r.bytes)).toEqual([0x68, 0x69]); // "hi"
  });

  it("非 base64 形态返回 null（不落盘）", () => {
    expect(splitDataUrl("data:text/plain,hello")).toBeNull();
    expect(splitDataUrl("https://example.com/a.png")).toBeNull();
  });

  it("mime → 扩展名映射（未知兜底 png）", () => {
    expect(dataUrlImageExt("image/png")).toBe("png");
    expect(dataUrlImageExt("image/JPEG")).toBe("jpg");
    expect(dataUrlImageExt("image/x-emf")).toBe("emf");
    expect(dataUrlImageExt("image/webp")).toBe("png");
  });
});
