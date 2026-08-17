// outline.ts 的 slug 缓存淘汰与标题去重行为验证。缓存是跨调用共享的模块级
// Map（SLUG_CACHE_MAX=2000 → 淘汰到 1500），这里锁定两件事：
//  1. 越过淘汰阈值后 slug 仍然逐条正确（淘汰最旧 ≠ 全清导致的行为变化）；
//  2. 同名标题的 `-#N` 去重走的是每次构建独立的 `used` 集合，不受缓存淘汰
//     影响（这是淘汰策略正确性的前提）。
//
// findHeadingLine / stampHeadingOccurrences：sv 模式大纲跳转的点击时重解析
// —— 大纲树来自防抖快照，其行号可能落后 live 文档 150ms+，跳转必须用
// (text, occurrence) 在点击瞬间重新解析 live 源码定位标题。
import { describe, expect, it } from "vitest";
import {
  buildOutline,
  findHeadingLine,
  headingSlugBase,
  stampHeadingOccurrences,
} from "./outline";

describe("outline slug cache eviction", () => {
  it("returns correct slugs for 2100 distinct headings (crosses the 2000 eviction threshold)", () => {
    // 超过 SLUG_CACHE_MAX(2000)，触发“淘汰最旧 500”而非 clear()。
    // 抽样断言而非逐条，避免测试输出被失败刷屏。
    for (let i = 0; i < 2100; i++) {
      const slug = headingSlugBase(`标题 ${i}`);
      if (i % 97 === 0) expect(slug).toBe(`标题-${i}`);
    }
    // 淘汰发生后再访问早期条目：缓存未命中 → 重新计算，结果必须不变
    // （缓存只是 memo，淘汰不影响正确性）。
    expect(headingSlugBase("标题 0")).toBe("标题-0");
    expect(headingSlugBase("标题 1")).toBe("标题-1");
  });

  it("dedups identical heading texts with -#N suffixes (per-build used set, cache-independent)", () => {
    const md = "# same\n# same\n# same\n## same\n# same";
    const flat = buildOutline(md);
    // 树结构：3 个 H1 root + 1 个挂在第 3 个 H1 下的 H2。
    const roots = flat.map((n) => n.id);
    expect(roots).toEqual(["same", "same-#2", "same-#3", "same-#5"]);
    expect(flat[2].children.map((c) => c.id)).toEqual(["same-#4"]);
  });

  it("slugifies lowercase + collapses whitespace + falls back to 'heading'", () => {
    expect(headingSlugBase("Hello   World!")).toBe("hello-world");
    expect(headingSlugBase("!!!")).toBe("heading");
  });
});

describe("click-time heading re-resolution", () => {
  const md = [
    "# 简介", // 0
    "正文", // 1
    "## 步骤", // 2
    "# 步骤", // 3 — 同名标题第 2 次出现
    "```", // 5 前的围栏开始
    "# 围栏里的假标题", // 5 — 必须被跳过
    "```",
    "## 步骤", // 7 — 同名标题第 3 次出现
  ].join("\n");

  it("stampHeadingOccurrences numbers same-text headings in document order", () => {
    const tree = stampHeadingOccurrences(buildOutline(md));
    const flat: Array<{ text: string; occ: number }> = [];
    const walk = (nodes: typeof tree) => {
      for (const n of nodes) {
        flat.push({ text: n.text, occ: n.occurrence ?? -1 });
        walk(n.children);
      }
    };
    walk(tree);
    expect(flat).toEqual([
      { text: "简介", occ: 0 },
      { text: "步骤", occ: 0 },
      { text: "步骤", occ: 1 },
      { text: "步骤", occ: 2 },
    ]);
  });

  it("findHeadingLine resolves by (text, occurrence) against live source", () => {
    expect(findHeadingLine(md, "简介", 0)).toBe(0);
    expect(findHeadingLine(md, "步骤", 0)).toBe(2);
    expect(findHeadingLine(md, "步骤", 1)).toBe(3);
    expect(findHeadingLine(md, "步骤", 2)).toBe(7);
  });

  it("ignores headings inside fenced code blocks", () => {
    expect(findHeadingLine(md, "围栏里的假标题", 0)).toBeNull();
  });

  it("returns null when the heading no longer exists (deleted / renamed)", () => {
    expect(findHeadingLine("# 其他\n\n正文", "简介", 0)).toBeNull();
    // occurrence 越界 = 该同名标题已被删除。
    expect(findHeadingLine(md, "步骤", 3)).toBeNull();
    expect(findHeadingLine("", "简介", 0)).toBeNull();
  });
});
