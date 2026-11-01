// DE 轮 M3：PDF 微编辑纯函数 + applyPdfPatches 应用面单测（vitest node）。
// 纯函数（选字族/收缩/覆盖几何/upsert/revert/行聚类）直接断言；applyPdfPatches
// 在 node 环境全链实测：pdf-lib 造源 PDF → pdfjs legacy 提取行 → patchFromLine
// → 应用 → pdfjs 回读验证（新文本落位基线 dx/dy≈0，spike② 恒等映射回归锚）。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PDFDocument, degrees } from "pdf-lib";

import { applyPdfPatches } from "./docNotePdfEdit";
import {
  chooseFontKind,
  coverRectOf,
  fitFontSize,
  hexToRgbTuple,
  patchFromLine,
  revertPatch,
  upsertPatch,
} from "./docNotePdfPatch";
import { piecesToEditLines, type PdfTextPiece } from "./docNote";
import type { PdfPatch } from "./docNote";

const NOTO = readFileSync(
  fileURLToPath(new URL("../../public/assets/fonts/NotoSansSC-Regular.otf", import.meta.url))
);
const INTER = readFileSync(
  fileURLToPath(new URL("../../public/assets/fonts/Inter-Medium.ttf", import.meta.url))
);

// ---- 纯函数 ---------------------------------------------------------------------

describe("chooseFontKind", () => {
  it("CJK/全角标点/混排 → cjk；纯 ASCII/拉丁 → latin", () => {
    expect(chooseFontKind("纯中文")).toBe("cjk");
    expect(chooseFontKind("，。；")).toBe("cjk");
    expect(chooseFontKind("Mixed 中英")).toBe("cjk");
    expect(chooseFontKind("Latin only 123")).toBe("latin");
    expect(chooseFontKind("")).toBe("latin");
  });
});

describe("fitFontSize（spike③ 一发公式）", () => {
  // 宽度与字号线性：w(s) = k·s（k=10/pt）。
  const widthOf = (t: string, s: number) => t.length * 10 * s;
  it("不超宽：原字号直放", () => {
    expect(fitFontSize(widthOf, "ab", 14, 500)).toEqual({ size: 14, ok: true });
  });
  it("超宽：精确收缩（size* = size₀·W/w₀）", () => {
    const r = fitFontSize(widthOf, "abcdefghijklmnopqrstuvwxyz", 10, 1500); // w=2600 → size*≈5.77（≥0.55 下限）
    expect(r.size).toBeCloseTo((10 * 1500) / 2600, 8);
    expect(r.ok).toBe(true);
  });
  it("收缩低于 0.55 下限 → 拒绝", () => {
    expect(fitFontSize(widthOf, "abcdefghijklmnopqrstuvwxyz", 10, 100).ok).toBe(false);
  });
});

describe("coverRectOf / patchFromLine（spike② 覆盖几何）", () => {
  it("行 → patch → 覆盖矩形：左右 +1pt、上下扩 6%（bbox 自带 0.30/1.12 带）", () => {
    const line = { page: 1, key: "1@720@72", text: "旧文本", x0: 72, y: 720, width: 100, height: 14 };
    const p = patchFromLine(line, "新文本");
    expect(p.bbox).toEqual([72, 720 - 4.2, 172, 720 + 15.68]);
    expect(p.baseline).toEqual({ x: 72, y: 720 });
    expect(p.fontSize).toBe(14);
    const cr = coverRectOf(p);
    expect(cr.x).toBe(71);
    expect(cr.width).toBe(102);
    expect(cr.y).toBeCloseTo(720 - 4.2 - 0.84, 6);
    expect(cr.height).toBeCloseTo(19.88 + 1.68, 6);
  });
});

describe("upsertPatch / revertPatch", () => {
  const mk = (key: string, o: string, n: string): PdfPatch => ({
    page: 1, lineKey: key, origText: o, newText: n,
    bbox: [0, 0, 10, 10], baseline: { x: 0, y: 0 }, fontSize: 10,
  });
  it("upsert 同 key 覆盖；回原值 = 移除（撤销语义）", () => {
    const a = mk("k1", "甲", "乙");
    const b = mk("k1", "甲", "丙");
    expect(upsertPatch([a], b)).toEqual([b]);
    expect(upsertPatch([a], mk("k1", "甲", "甲"))).toEqual([]);
  });
  it("不同 key 追加；revert 按 key 移除", () => {
    const a = mk("k1", "甲", "乙");
    const c = mk("k2", "丙", "丁");
    const list = upsertPatch([a], c);
    expect(list).toHaveLength(2);
    expect(revertPatch(list, "k1")).toEqual([c]);
  });
});

describe("hexToRgbTuple", () => {
  it("#rrggbb 解析；非法回退白", () => {
    expect(hexToRgbTuple("#ff8000")).toEqual([1, 128 / 255, 0]);
    expect(hexToRgbTuple("ffffff")).toEqual([1, 1, 1]);
    expect(hexToRgbTuple(undefined)).toEqual([1, 1, 1]);
    expect(hexToRgbTuple("#xyz")).toEqual([1, 1, 1]);
  });
});

describe("piecesToEditLines（旋转 run 过滤 + 行键）", () => {
  const pieces: Array<PdfTextPiece & { rotated?: boolean }> = [
    { str: "第一行", x: 72, y: 720, width: 60, height: 14 },
    { str: "文字", x: 132, y: 720, width: 30, height: 14 },
    { str: "第二行", x: 72, y: 690, width: 60, height: 14 },
    { str: "旋转run", x: 300, y: 500, width: 50, height: 12, rotated: true },
    { str: "  ", x: 400, y: 400, width: 4, height: 12 },
  ];
  it("聚类成行（含同 y 拼接）+ 旋转/空白剔除 + page/key", () => {
    const lines = piecesToEditLines(3, pieces);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ page: 3, text: "第一行文字", x0: 72, y: 720 });
    expect(lines[0].key).toBe("3@720@72");
    expect(lines[1].text).toBe("第二行");
  });
});

// ---- applyPdfPatches（node 全链）-----------------------------------------------

async function textItems(buf: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: buf.slice() });
  const doc = await task.promise;
  const pages: Array<Array<{ str: string; tx: number[]; w: number; h: number }>> = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(
      (tc.items as unknown[]).map((raw) => {
        const it = raw as { str?: string; transform?: number[]; width?: number; height?: number };
        return { str: it.str ?? "", tx: it.transform ?? [0, 0, 0, 0, 0, 0], w: it.width ?? 0, h: it.height ?? 0 };
      }).filter((it) => it.str !== "" || it.tx[4] !== 0)
    );
  }
  await task.destroy();
  return pages;
}

/** pdfjs items → 编辑行（复刻视图映射：transform[4]/[5] + b/c 旋转标记）。 */
function itemsToEditLines(page: number, items: Array<{ str: string; tx: number[]; w: number; h: number }>) {
  return piecesToEditLines(
    page,
    items.map((it) => ({
      str: it.str,
      x: it.tx[4],
      y: it.tx[5],
      width: it.w,
      height: it.h,
      rotated: Math.abs(it.tx[1]) > 0.01 || Math.abs(it.tx[2]) > 0.01,
    }))
  );
}

describe("applyPdfPatches（node 全链：pdf-lib 造源 → 行提取 → 应用 → 回读）", () => {
  it(
    "正常替换 + 三类拒绝（旋转页/缺字形/超宽），产物新文本落位原基线（全量并发下较重，单独放宽时限）",
    async () => {
    // 源 PDF：页1 三行中文；页2 旋转 90°；页3 一行拉丁（超宽拒绝靶）。
    const src = await PDFDocument.create();
    src.registerFontkit((await import("@pdf-lib/fontkit")).default ?? (await import("@pdf-lib/fontkit")));
    const helv = await src.embedFont(NOTO, { subset: false });
    const p1 = src.addPage([595, 842]);
    p1.drawText("微编辑目标行：将被替换的内容。", { x: 72, y: 720, size: 14, font: helv });
    p1.drawText("同行邻接文字", { x: 320, y: 720, size: 14, font: helv });
    p1.drawText("无关行保持原样。", { x: 72, y: 680, size: 12, font: helv });
    const p2 = src.addPage([595, 842]);
    p2.setRotation(degrees(90));
    p2.drawText("旋转页内容", { x: 72, y: 720, size: 14, font: helv });
    const p3 = src.addPage([595, 842]);
    p3.drawText("short", { x: 72, y: 700, size: 10, font: helv });
    const srcBytes = await src.save({ useObjectStreams: false });

    const pages = await textItems(srcBytes);
    const l1 = itemsToEditLines(1, pages[0]);
    const l3 = itemsToEditLines(3, pages[2]);
    const target = l1.find((l) => l.text.includes("微编辑目标行"));
    expect(target).toBeTruthy();
    const shortLine = l3.find((l) => l.text === "short");
    expect(shortLine).toBeTruthy();

    const patches: PdfPatch[] = [
      patchFromLine(target!, "已替换：这是新的中文内容。"),
      // 旋转页 patch（页2 的行——构造同几何即可，page=2 触发整页拒绝）。
      { ...patchFromLine({ ...target!, page: 2, key: "2@720@72" }, "任何文本") },
      // 缺字形（emoji——Noto 无字形，fontkit 守护拒绝）。
      patchFromLine({ ...target!, key: "1@680@72" }, "含 emoji \u{1F600} 文本"),
      // 超宽拒绝（short 行宽 ~27pt，塞 60 字符必超 0.55 下限）。
      patchFromLine(shortLine!, "012345678901234567890123456789012345678901234567890123456789"),
    ];
    const r = await applyPdfPatches(srcBytes, patches, { cjk: NOTO, latin: INTER });
    expect(r.applied).toBe(1);
    expect(r.rejected).toHaveLength(3);
    expect(r.rejected.map((x) => x.reason)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("旋转页"),
        expect.stringContaining("字库未覆盖"),
        expect.stringContaining("字号收缩超下限"),
      ])
    );

    // 回读：新文本 item 落位原基线（dx/dy≈0——spike② 恒等映射回归锚）；
    // 原文本仍在文本层（patch 是视觉覆盖，非删除）。
    const back = await textItems(r.bytes);
    const newItem = back[0].find((it) => it.str.startsWith("已替换"));
    expect(newItem).toBeTruthy();
    expect(newItem!.tx[4]).toBeCloseTo(target!.x0, 1);
    expect(newItem!.tx[5]).toBeCloseTo(target!.y, 1);
    expect(back[0].some((it) => it.str.includes("微编辑目标行"))).toBe(true);
    expect(back[0].some((it) => it.str.includes("无关行"))).toBe(true);
    },
    30_000
  );

  it("零 patch：原字节直返（不重写不碰字体）", async () => {
    const src = await PDFDocument.create();
    const bytes = await src.save();
    const r = await applyPdfPatches(bytes, [], { cjk: NOTO });
    expect(r.bytes).toBe(bytes);
    expect(r.applied).toBe(0);
  });

  it("全拒：抛错列报（不产出零改动假成功）", async () => {
    const src = await PDFDocument.create();
    src.registerFontkit((await import("@pdf-lib/fontkit")).default ?? (await import("@pdf-lib/fontkit")));
    const helv = await src.embedFont(NOTO, { subset: false });
    src.addPage([595, 842]).drawText("目标", { x: 72, y: 720, size: 14, font: helv });
    const bytes = await src.save();
    const patch: PdfPatch = {
      page: 1, lineKey: "k", origText: "目标", newText: "\u{1F600}",
      bbox: [72, 710, 120, 730], baseline: { x: 72, y: 720 }, fontSize: 14,
    };
    await expect(applyPdfPatches(bytes, [patch], { cjk: NOTO })).rejects.toThrow("补丁被拒绝");
  });
});
