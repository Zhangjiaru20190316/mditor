import { describe, expect, it } from "vitest";
import { MIN_SWITCH_MS, needsPaintYield, remainingSwitchDelay } from "./switchTiming";

describe("remainingSwitchDelay", () => {
  it("未达最短可见时长 → 返回还需等待的毫秒数", () => {
    // startedAt=1000，now=1150，min=300 → 还需 150ms。
    expect(remainingSwitchDelay(1000, 1150, 300)).toBe(150);
  });

  it("已达标 → ≤0（调用方立即收尾，不挂定时器）", () => {
    expect(remainingSwitchDelay(1000, 1300, 300)).toBe(0);
    expect(remainingSwitchDelay(1000, 2000, 300)).toBeLessThanOrEqual(0);
  });

  it("默认使用 MIN_SWITCH_MS", () => {
    expect(remainingSwitchDelay(0, MIN_SWITCH_MS - 1)).toBe(1);
    expect(remainingSwitchDelay(0, MIN_SWITCH_MS)).toBe(0);
  });
});

describe("needsPaintYield", () => {
  it("首次亮起动画（此前没有切换在跑）→ 需要等帧", () => {
    expect(needsPaintYield(false, false, false)).toBe(true);
    expect(needsPaintYield(false, false, true)).toBe(true);
  });

  it("动画已在屏上且档位一致（openPath 委托 activateTab）→ 不等", () => {
    expect(needsPaintYield(true, false, false)).toBe(false);
    expect(needsPaintYield(true, true, true)).toBe(false);
  });

  it("大文档遮罩刚被点亮/撤下 → 需要等帧让遮罩先绘制", () => {
    expect(needsPaintYield(true, false, true)).toBe(true);
    expect(needsPaintYield(true, true, false)).toBe(true);
  });
});
