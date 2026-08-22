// 动效档位的 JS 侧开关（v4.1 动效三档）。
//
// CSS 侧由 <html data-motion="..."> 属性驱动（useSettings.applyToDom 直写）：
// 「无」档并列 prefers-reduced-motion 的全局 kill switch，「生动」档增强规则
// 一律以 html[data-motion="lively"] 前缀惰性承载。本模块供事件驱动的 JS 动效
// 决策（大纲/批注平滑滚动等）读取「当前生效档位」：
//   * 用户档位为 none，或系统 prefers-reduced-motion: reduce → 瞬时；
//   * balanced / lively → 平滑。
//
// 约定：只在事件回调内调用（经 ref 镜像取 settings），禁止在 render 内联
// 读取——档位切换不触发使用方重渲染，回调调用点取值即为最新生效档位。

import type { Settings } from "../types";

/** OS「减少动态效果」优先级最高：选中 lively 也按「无」处理。 */
export function motionEnabled(s: Pick<Settings, "motionLevel">): boolean {
  if (s.motionLevel === "none") return false;
  // 测试环境（node）无 window：视为未要求减少动效（浏览器恒有 matchMedia）。
  if (typeof window === "undefined") return true;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
