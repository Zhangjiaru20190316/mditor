// KaTeX 渲染结果 LRU 缓存（lib/katexCache.ts）：命中/未命中、宏签名隔离、
// 条数上限淘汰（含 MRU 提升）、字节上限淘汰（含单条超限自我淘汰）。
import { afterEach, describe, expect, it } from "vitest";
import {
  __getKatexCacheStatsForTests,
  __setKatexCacheCapsForTests,
  peekCached,
  putCached,
  renderToStringCached,
} from "./katexCache";
import { DEFAULT_MATH_CONFIG, setMathRenderConfig } from "./mathConfig";

// 缓存与数学配置都是模块级共享态：每条用例后复位（清缓存 + 恢复默认配置）。
afterEach(() => {
  setMathRenderConfig(DEFAULT_MATH_CONFIG);
  __setKatexCacheCapsForTests(8192, 8 * 1024 * 1024)();
});

describe("katexCache：KaTeX 渲染结果 LRU 缓存", () => {
  it("未命中渲染并落缓存；同键（配置+displayMode+源码）命中直返，异键未命中", () => {
    const a1 = renderToStringCached("x^2+y_2", false);
    expect(a1).toContain("katex");
    expect(peekCached("x^2+y_2", false)).toBe(a1);
    // displayMode 参与键：行内结果不能喂给块级查询
    expect(peekCached("x^2+y_2", true)).toBeUndefined();
    expect(peekCached("z^9", false)).toBeUndefined();
    // 同键再渲染命中（不重跑 KaTeX）
    expect(renderToStringCached("x^2+y_2", false)).toBe(a1);
  });

  it("宏配置变化（签名不同）不命中旧结果，新配置独立落缓存", () => {
    setMathRenderConfig({ autoNumber: false, macros: {} });
    const plain = renderToStringCached("\\RR", false);
    // 未定义宏 → throwOnError:false 错误回退（0.18.4 以内联 errorColor 呈现）
    expect(plain).toContain("#cc0000");
    setMathRenderConfig({ autoNumber: false, macros: { "\\RR": "\\mathbb{R}" } });
    expect(peekCached("\\RR", false)).toBeUndefined(); // 旧签名键不可见
    const withMacro = renderToStringCached("\\RR", false);
    expect(withMacro).not.toBe(plain);
    expect(withMacro).toContain("mathbb"); // 宏生效：\mathbb{R} 正常渲染（CSS 类呈现），无错误色
    expect(withMacro).not.toContain("#cc0000");
    expect(peekCached("\\RR", false)).toBe(withMacro);
  });

  it("条数上限：超限淘汰最旧；被访问过的条目提升 MRU 不先淘汰", () => {
    const restore = __setKatexCacheCapsForTests(2, 8 * 1024 * 1024);
    renderToStringCached("a", false);
    renderToStringCached("b", false);
    expect(__getKatexCacheStatsForTests().size).toBe(2);
    renderToStringCached("c", false); // 超限 → 淘汰插入序最旧的 "a"
    expect(__getKatexCacheStatsForTests().size).toBe(2);
    expect(peekCached("a", false)).toBeUndefined();
    expect(peekCached("b", false)).toBeTruthy();
    expect(peekCached("c", false)).toBeTruthy();
    peekCached("b", false); // MRU 提升：b 移到尾部
    renderToStringCached("d", false); // 超限 → 淘汰的是 "c" 而非 "b"
    expect(peekCached("c", false)).toBeUndefined();
    expect(peekCached("b", false)).toBeTruthy();
    expect(peekCached("d", false)).toBeTruthy();
    restore();
  });

  it("字节上限：键+值总字节超限从最旧逐条淘汰；单条超限自我淘汰但渲染照常返回", () => {
    // 用 putCached 精确控制条目字节（renderToString 的 HTML 长度不可控）。
    const reset = __setKatexCacheCapsForTests(8192, 1 << 20);
    putCached("k1", false, "x".repeat(40));
    const b1 = __getKatexCacheStatsForTests().bytes;
    expect(b1).toBeGreaterThan(40); // 键长计入
    const restore = __setKatexCacheCapsForTests(8192, b1); // 容量恰好一条
    putCached("k1", false, "x".repeat(40));
    expect(__getKatexCacheStatsForTests().size).toBe(1);
    putCached("k2", false, "y".repeat(40)); // 总字节超限 → 淘汰最旧 k1
    expect(peekCached("k1", false)).toBeUndefined();
    expect(peekCached("k2", false)).toBe("y".repeat(40));
    expect(__getKatexCacheStatsForTests().size).toBe(1);
    restore();
    reset();
    // 单条即超字节上限：照常返回 HTML，只是立即自我淘汰（不入缓存）。
    const tiny = __setKatexCacheCapsForTests(8192, 10);
    const html = renderToStringCached("x", false);
    expect(html).toContain("katex");
    expect(peekCached("x", false)).toBeUndefined();
    expect(__getKatexCacheStatsForTests().size).toBe(0);
    tiny();
  });
});
