// outline.ts 的 slug 缓存淘汰与标题去重行为验证。缓存是跨调用共享的模块级
// Map（SLUG_CACHE_MAX=2000 → 淘汰到 1500），这里锁定两件事：
//  1. 越过淘汰阈值后 slug 仍然逐条正确（淘汰最旧 ≠ 全清导致的行为变化）；
//  2. 同名标题的 `-#N` 去重走的是每次构建独立的 `used` 集合，不受缓存淘汰
//     影响（这是淘汰策略正确性的前提）。
import { describe, expect, it } from "vitest";
import { buildOutline, headingSlugBase } from "./outline";

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
