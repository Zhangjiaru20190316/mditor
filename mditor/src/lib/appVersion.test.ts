import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTimeVersion, fetchAppVersion } from "./appVersion";

// 版本号取用（v4.12.2）：运行时适配层优先，异常/空值回退构建期内联的
// tauri.conf.json version。设置「关于」分区与 AboutModal 共用，锁定两级
// 回退语义与解析健壮性。

const { adapter } = vi.hoisted(() => {
  const adapter = {
    app: {
      version: async () => "9.9.9",
    },
  };
  return { adapter };
});

vi.mock("../platform", () => ({
  getAdapter: () => adapter,
}));

describe("appVersion", () => {
  beforeEach(() => {
    adapter.app.version = async () => "9.9.9";
  });

  it("运行时版本可用时直接采用", async () => {
    expect(await fetchAppVersion()).toBe("9.9.9");
  });

  it("运行时空串 → 回退构建期版本（来自 tauri.conf.json）", async () => {
    adapter.app.version = async () => "";
    expect(await fetchAppVersion()).toBe(buildTimeVersion());
    // 构建期版本必须非空且长得像版本号（防止 ?raw 引入悄悄失效）。
    expect(buildTimeVersion()).toMatch(/^\d+\.\d+/);
  });

  it("运行时 reject → 回退构建期版本", async () => {
    adapter.app.version = async () => {
      throw new Error("no impl");
    };
    expect(await fetchAppVersion()).toBe(buildTimeVersion());
  });
});
