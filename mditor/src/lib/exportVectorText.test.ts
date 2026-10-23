// RV 轮阶段一纯逻辑单测：CSS 颜色解析 + 逐文本结点矢量化判定。
// 判定是「位图摘除」与「矢量补画」一致性的根——错判一批即丢字/重影。

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  BOLD_WEIGHT_MIN,
  decideTextVectorization,
  parseCssColor,
} from "./exportVectorText";

describe("parseCssColor", () => {
  it("rgb()/rgba() 十进制与百分比 alpha", () => {
    expect(parseCssColor("rgb(31, 35, 40)")).toEqual({ r: 31, g: 35, b: 40, a: 1 });
    expect(parseCssColor("rgba(31, 35, 40, 0.5)")).toEqual({ r: 31, g: 35, b: 40, a: 0.5 });
    expect(parseCssColor("rgba(31, 35, 40, 50%)")).toEqual({ r: 31, g: 35, b: 40, a: 0.5 });
    expect(parseCssColor("rgb(31 35 40 / 0.25)")).toEqual({ r: 31, g: 35, b: 40, a: 0.25 });
  });

  it("hex 3/4/6/8 位", () => {
    expect(parseCssColor("#e5e7eb")).toEqual({ r: 229, g: 231, b: 235, a: 1 });
    expect(parseCssColor("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseCssColor("#abc8")).toEqual({ r: 170, g: 187, b: 204, a: 0x88 / 255 });
    expect(parseCssColor("#1f2328ff")).toEqual({ r: 31, g: 35, b: 40, a: 1 });
  });

  it("超界钳制与解析失败（关键字/空串 → null）", () => {
    const clamped = parseCssColor("rgb(300, -5, 40)")!;
    expect(clamped.r).toBe(255);
    expect(clamped.g).toBe(0);
    expect(parseCssColor("currentColor")).toBeNull();
    expect(parseCssColor("")).toBeNull();
    expect(parseCssColor("rgb(1,2)")).toBeNull();
  });
});

describe("decideTextVectorization（阶段一口径）", () => {
  const plain = {
    inRasterScope: false,
    inKatex: false,
    fontWeight: 400,
    fontStyle: "normal",
    textDecorationLine: "none",
    fontFamily: '"Segoe UI", "Noto Sans SC", sans-serif',
    color: { r: 31, g: 35, b: 40, a: 1 },
  };

  it("常规正文 → 矢量", () => {
    expect(decideTextVectorization(plain)).toEqual({ vector: true, reason: "ok" });
  });

  it("块级降级域 / KaTeX 域优先级最高", () => {
    expect(decideTextVectorization({ ...plain, inRasterScope: true })).toEqual({
      vector: false,
      reason: "raster-scope",
    });
    expect(decideTextVectorization({ ...plain, inKatex: true })).toEqual({
      vector: false,
      reason: "katex",
    });
  });

  it(`字重 ≥${BOLD_WEIGHT_MIN}（bold 标题/加粗/th）→ 矢量 + 合成加粗（阶段四）`, () => {
    expect(decideTextVectorization({ ...plain, fontWeight: 700 })).toEqual({
      vector: true,
      reason: "ok",
      syntheticBold: true,
    });
    expect(decideTextVectorization({ ...plain, fontWeight: 500 })).toEqual({
      vector: true,
      reason: "ok",
    });
    expect(
      decideTextVectorization({ ...plain, fontWeight: 500 }).syntheticBold
    ).toBeUndefined();
  });

  it("斜体 → 矢量 + 合成斜体（阶段四）；等宽（行内代码）→ 留位图", () => {
    expect(decideTextVectorization({ ...plain, fontStyle: "italic" })).toEqual({
      vector: true,
      reason: "ok",
      syntheticItalic: true,
    });
    expect(
      decideTextVectorization({ ...plain, fontFamily: "ui-monospace, Consolas, monospace" })
    ).toEqual({ vector: false, reason: "mono-font" });
  });

  it("缺字形（glyphsCovered=false，emoji 等）→ 留位图走残留补丁", () => {
    expect(decideTextVectorization({ ...plain, glyphsCovered: false })).toEqual({
      vector: false,
      reason: "no-glyph",
    });
    expect(decideTextVectorization({ ...plain, glyphsCovered: true })).toEqual({
      vector: true,
      reason: "ok",
    });
  });

  it("文本装饰线：underline/line-through 可矢量（阶段二矢量画线）；overline 等罕见形态留位图", () => {
    expect(decideTextVectorization({ ...plain, textDecorationLine: "underline" })).toEqual({
      vector: true,
      reason: "ok",
    });
    expect(decideTextVectorization({ ...plain, textDecorationLine: "line-through" })).toEqual({
      vector: true,
      reason: "ok",
    });
    expect(decideTextVectorization({ ...plain, textDecorationLine: "underline line-through" })).toEqual({
      vector: true,
      reason: "ok",
    });
    expect(decideTextVectorization({ ...plain, textDecorationLine: "overline" })).toEqual({
      vector: false,
      reason: "decorated",
    });
  });

  it("半透明色 / 无色 → 留位图", () => {
    expect(
      decideTextVectorization({ ...plain, color: { r: 1, g: 1, b: 1, a: 0.4 } })
    ).toEqual({ vector: false, reason: "alpha-color" });
    expect(decideTextVectorization({ ...plain, color: null })).toEqual({
      vector: false,
      reason: "no-color",
    });
  });
});

// ---------------------------------------------------------------------------
// RVF 阶段一：拉丁 run 真字体变体（Inter 四变体映射 + script 拆分）。
// ---------------------------------------------------------------------------
import {
  CJK_VARIANT,
  isLatinScript,
  latinVariantFor,
  runVariants,
  splitRunByScript,
} from "./exportVectorText";

describe("isLatinScript（Inter 承担的字符域）", () => {
  it("ASCII/拉丁扩展/希腊/西里尔/通用标点/货币 → 拉丁域", () => {
    for (const s of ["A z9", "é ñ ü", "α β ψ", "Ж Д", "… — “” ‘’", "€ £ ¥", "™"]) {
      for (const ch of Array.from(s)) {
        if (ch.trim()) expect(isLatinScript(ch), JSON.stringify(ch)).toBe(true);
      }
    }
  });
  it("CJK/日文/全角/中文标点/emoji/数学符号 → CJK 域（NotoSansSC）", () => {
    for (const ch of ["中", "文", "あ", "，", "。", "『』", "😀", "∑", "≤"]) {
      expect(isLatinScript(ch), JSON.stringify(ch)).toBe(false);
    }
  });
});

describe("latinVariantFor（字重/字型 → Inter 变体；与合成判定同阈值）", () => {
  it("四象限映射", () => {
    expect(latinVariantFor(400, "normal")).toBe("latin-regular");
    expect(latinVariantFor(700, "normal")).toBe("latin-bold");
    expect(latinVariantFor(400, "italic")).toBe("latin-italic");
    expect(latinVariantFor(700, "italic")).toBe("latin-bolditalic");
  });
  it("就近映射：500 → regular、600 → bold（BOLD_WEIGHT_MIN 同阈）", () => {
    expect(latinVariantFor(500, "normal")).toBe("latin-regular");
    expect(latinVariantFor(600, "normal")).toBe("latin-bold");
    expect(latinVariantFor(600, "oblique")).toBe("latin-bolditalic");
  });
});

describe("runVariants（文本 → 逐字符变体）", () => {
  it("中英混排：拉丁按字重选变体、其余 CJK；与 Array.from 等长", () => {
    const text = "Hello 世界 mixed 中文";
    const v = runVariants(text, 700, "normal");
    expect(v).toHaveLength(Array.from(text).length);
    expect(v[0]).toBe("latin-bold"); // H
    expect(v[Array.from("Hello ").length]).toBe(CJK_VARIANT); // 世
    expect(v.join(",")).toContain("latin-bold");
  });
  it("全中文 → 全 CJK", () => {
    expect(runVariants("全部中文", 400, "normal").every((v) => v === CJK_VARIANT)).toBe(true);
  });
});

describe("splitRunByScript（连续同域分段）", () => {
  it("混合文本分段边界正确", () => {
    const segs = splitRunByScript("ab中cd。e");
    expect(segs.map((s) => (s.latin ? "L" : "C") + ":" + s.text)).toEqual([
      "L:ab",
      "C:中",
      "L:cd",
      "C:。",
      "L:e",
    ]);
  });
});
