// motionEnabled 档位生效逻辑（v4.1 动效三档）：
// 用户档位 none → 瞬时；balanced/lively → 平滑；系统 prefers-reduced-motion
// 优先级最高，选中 lively 也按「无」处理。

import { afterEach, describe, expect, it, vi } from "vitest";
import { motionEnabled } from "./motion";

/** node 环境（vitest）无 window：stub 出带指定 reduce 偏好的 window。 */
function stubWindow(reduce: boolean) {
  vi.stubGlobal("window", { matchMedia: () => ({ matches: reduce }) });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("motionEnabled（动效档位生效逻辑）", () => {
  it("none 档：无论系统偏好如何都禁用动效", () => {
    stubWindow(false);
    expect(motionEnabled({ motionLevel: "none" })).toBe(false);
    stubWindow(true);
    expect(motionEnabled({ motionLevel: "none" })).toBe(false);
  });

  it("balanced / lively 档：系统未要求减少动效时启用", () => {
    stubWindow(false);
    expect(motionEnabled({ motionLevel: "balanced" })).toBe(true);
    expect(motionEnabled({ motionLevel: "lively" })).toBe(true);
  });

  it("prefers-reduced-motion 优先级最高：lively 也按「无」处理", () => {
    stubWindow(true);
    expect(motionEnabled({ motionLevel: "balanced" })).toBe(false);
    expect(motionEnabled({ motionLevel: "lively" })).toBe(false);
  });
});
