// R9 Fix-A 专注模式合成器保温动画的回归守卫（样式钉）。
//
// 背景（第九轮专项定罪，perf/results/r9-phase4-attribution.md）：普通模式
// .ai-fab 呼吸动画逐 vsync 驱动合成器产帧，DXGISwapChain 常热；专注模式
// `.is-focus .ai-fab { display: none }`（产品设计）连带消灭该动画 → 滚轮
// 间隙零产帧 → swapchain/DWM 冷却 → 下一滚动帧 Present 阻塞 40~124ms
// （用户所见"一顿一顿"）。修复 = `.is-focus .main` 挂 translateZ 亚像素
// 无限动画（视觉零变化）保温呈现管线。本文件把四件事钉死，防止样式被
// 无感删改：①保温动画在位且 infinite；②keyframes 只动 translateZ（不掺
// 2D 位移——掺了就是可感抖动，违反零视觉变化约束）；③.app-idle 暂停
// 纪律在位（窗口隐藏不空烧）；④专注模式 fab 隐藏规则仍在（保温是管线
// 补偿，不是把 fab 显示回来）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");

/** 去掉注释与空白后的紧凑正文（断言对格式不敏感）。 */
const compact = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");

describe("专注模式合成器保温动画（R9 Fix-A 样式钉）", () => {
  it("① .is-focus .main 挂 infinite 保温动画", () => {
    const m = compact.match(/\.is-focus \.main\s*\{[^}]*animation:\s*focus-keepwarm[^}]*infinite[^}]*\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain("infinite");
  });

  it("② focus-keepwarm keyframes 只动 translateZ（零 2D 位移）", () => {
    const m = css.match(/@keyframes\s+focus-keepwarm\s*\{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    const body = m![0];
    expect(body).toContain("translateZ(0)");
    expect(body).toContain("translateZ(0.001px)");
    // 不允许任何 2D 位移混入（可感抖动即违约定罪）
    expect(body).not.toMatch(/translate\(|translateX|translateY|scale|rotate/);
  });

  it("③ .app-idle 暂停纪律在位", () => {
    expect(compact).toMatch(/\.app-idle \.main\s*\{\s*animation-play-state:\s*paused/);
  });

  it("④ 专注模式 fab 隐藏（产品定案）未被顺手动回", () => {
    // fab 隐藏在 .is-focus 组选择器链里（与 titlebar/tabbar 等共享声明块）
    expect(compact).toContain(".is-focus .ai-fab");
    expect(compact).toMatch(/\.is-focus \.tabbar\s*\{\s*display:\s*none\s*!important/);
  });
});
