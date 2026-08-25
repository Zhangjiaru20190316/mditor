import { describe, expect, it } from "vitest";
import { matchAnchorIndex } from "./viewportAnchor";

describe("matchAnchorIndex（P1-4 恢复落点锚块匹配）", () => {
  const texts = [
    null, // widget（无指纹）
    "第一章 引言",
    "正文 A",
    "正文 B",
    "第二章 方法",
    null,
    "正文 C",
  ];
  const get = (i: number) => texts[i] ?? null;

  it("hits at the recorded index（无编辑的常规切回）", () => {
    expect(matchAnchorIndex(get, { text: "第二章 方法", index: 4 })).toBe(4);
    expect(matchAnchorIndex(get, { text: "第一章 引言", index: 1 })).toBe(1);
  });

  it("recovers when the index shifted（恢复前上方有过编辑）", () => {
    // 索引偏移 +2（上方插入两块）
    expect(matchAnchorIndex(get, { text: "第二章 方法", index: 6 })).toBe(4);
    // 索引偏移 -2（上方删了两块）
    expect(matchAnchorIndex(get, { text: "正文 A", index: 0 })).toBe(2);
  });

  it("probes near-before-far（等距时先验上方近邻）", () => {
    const dup = ["X", "A", "B", "target", "target", "C"];
    // 索引 3、4 同文：先验 3 直接命中。
    expect(matchAnchorIndex((i) => dup[i] ?? null, { text: "target", index: 3 })).toBe(3);
    // 先验 2 → 邻域扫描 d=1 先探 3（上方近邻）。
    expect(matchAnchorIndex((i) => dup[i] ?? null, { text: "target", index: 2 })).toBe(3);
  });

  it("gives up beyond the window or when the text is gone", () => {
    expect(matchAnchorIndex(get, { text: "已被删除的块", index: 3 })).toBe(-1);
    const far = Array.from({ length: 80 }, (_, i) => `块 ${i}`);
    expect(
      matchAnchorIndex((i) => far[i] ?? null, { text: "块 79", index: 0 }, 32)
    ).toBe(-1);
    // 放宽窗口后可达。
    expect(
      matchAnchorIndex((i) => far[i] ?? null, { text: "块 79", index: 0 }, 79)
    ).toBe(79);
  });

  it("empty anchor text never matches", () => {
    expect(matchAnchorIndex(get, { text: "", index: 1 })).toBe(-1);
  });
});
