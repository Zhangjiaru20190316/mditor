// 文件切换动画的纯时序逻辑（从 App.tsx 抽出以便单测；DOM/rAF 部分留在
// hooks/useSwitchFlow.ts）。

/** Minimum visible duration of the file-switch animation (ms). The loading bar
 *  always plays at least this long so every switch — even a cached/instant one
 *  — gives clear feedback. Kept short so quick switching never feels sluggish. */
export const MIN_SWITCH_MS = 300;

/**
 * 距离满足最短可见时长还需等待的毫秒数。≤0 表示已达标、可立即收尾；
 * >0 即 finishSwitch 要挂起的延时（定时器收尾仍须复核 token，见 hook）。
 */
export function remainingSwitchDelay(
  startedAt: number,
  now: number,
  minMs: number = MIN_SWITCH_MS
): number {
  return minMs - (now - startedAt);
}

/**
 * 进入重活（读取/整篇重解析）前是否需要先等两帧让动画提交：
 *   * 首次亮起动画（此前没有切换在跑）—— 必须等；
 *   * 大文档遮罩档位刚被点亮（遮罩是叠加层，不亮屏等于没画）—— 必须等；
 *   * 动画已在屏上且档位不变（openPath 委托 activateTab 的场景）—— 不等，
 *     不多付两帧延迟。
 */
export function needsPaintYield(
  wasSwitching: boolean,
  prevHeavy: boolean,
  heavy: boolean
): boolean {
  return !wasSwitching || prevHeavy !== heavy;
}
