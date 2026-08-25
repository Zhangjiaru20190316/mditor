// devContext 行为验证：node 环境（无 DOM）下的降级契约、操作环、文档概况
// provider、组合快照——全部接口永不抛错。
import { describe, expect, it } from "vitest";
import {
  buildDevContext,
  clearDevActions,
  devDocInfo,
  devEnvSnapshot,
  noteUserAction,
  recentUserActions,
  setDevDocInfoProvider,
} from "./devContext";

describe("devContext（node 无 DOM 环境降级）", () => {
  it("env snapshot degrades gracefully without DOM", () => {
    const env = devEnvSnapshot();
    expect(env.ver).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof env.platform).toBe("string");
    // 无 window/document 时字段为 null/默认值，接口不抛错。
    expect(env.maximized).toBe(false);
  });

  it("action ring keeps the last 16, oldest dropped", () => {
    clearDevActions();
    for (let i = 0; i < 20; i++) noteUserAction("click", `btn-${i}`);
    const acts = recentUserActions();
    expect(acts).toHaveLength(16);
    expect(acts[0].label).toBe("btn-4");
    expect(acts.at(-1)?.label).toBe("btn-19");
    expect(acts.at(-1)?.kind).toBe("click");
  });

  it("action labels are length-capped (never blow up log lines)", () => {
    clearDevActions();
    noteUserAction("ui", "x".repeat(500));
    expect(recentUserActions()[0].label.length).toBeLessThanOrEqual(80);
  });

  it("doc info provider: absent → null; registered → invoked once per call", () => {
    setDevDocInfoProvider(null);
    expect(devDocInfo()).toBeNull();
    let calls = 0;
    setDevDocInfoProvider(() => {
      calls += 1;
      return {
        tabs: 3,
        activeTab: "a.md",
        path: "C:/x/a.md",
        chars: 1234,
        lines: 40,
        images: 5,
      };
    });
    const d = devDocInfo();
    expect(calls).toBe(1);
    expect(d?.tabs).toBe(3);
    // provider 抛错 → null，不外溢。
    setDevDocInfoProvider(() => {
      throw new Error("boom");
    });
    expect(devDocInfo()).toBeNull();
    setDevDocInfoProvider(null);
  });

  it("buildDevContext composes env/actions/doc without throwing", () => {
    clearDevActions();
    noteUserAction("key", "Ctrl+S");
    const ctx = buildDevContext();
    expect(ctx.env.ver).toMatch(/^\d/);
    expect(ctx.actions.at(-1)?.label).toBe("Ctrl+S");
    expect(ctx.doc).toBeNull();
  });
});
