// getWorkspaces 冷启动竞态重试回归（第四轮 D 基建前置修复）。
// 背景：LazyStore 插件就绪前首次 get 拒/读空，App 侧 catch 吞掉 → 文件树
// 0 行只能 reload 自愈（第三轮基准 3 失败 3 成功）。修复 = 空结果/异常
// 短退避重试三次；真无工作区走完重试后按原语义返回空/抛错。
import { describe, expect, it, vi } from "vitest";

let calls = 0;
const kv = new Map<string, unknown>();
let rejectFirstN = 0;

vi.mock("../platform", () => ({
  detectRuntime: () => "tauri",
  getAdapter: () => ({
    store: {
      get: async <T>(k: string) => {
        calls++;
        if (rejectFirstN > 0) {
          rejectFirstN--;
          throw new Error("store 尚未就绪（冷启动竞态模拟）");
        }
        return kv.get(k) as T | undefined;
      },
      set: async (k: string, v: unknown) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
      save: async () => undefined,
    },
    app: { emit: async () => undefined },
  }),
}));

import { getWorkspaces } from "./store";

describe("getWorkspaces 冷启动重试", () => {
  it("首次 get 拒绝时退避重试后拿到工作区", async () => {
    kv.clear();
    kv.set("workspaces", ["/tmp/ws-a", "/tmp/ws-b"]);
    calls = 0;
    rejectFirstN = 2; // 前两次拒（模拟插件就绪窗口）
    const t0 = Date.now();
    const list = await getWorkspaces();
    expect(list).toEqual(["/tmp/ws-a", "/tmp/ws-b"]);
    expect(calls).toBeGreaterThanOrEqual(3);
    // 两次退避（250+500ms）真实发生——防「重试循环被意外短路」。
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700);
  });

  it("读空同样重试（拿到 undefined 不是异常）", async () => {
    kv.clear();
    calls = 0;
    rejectFirstN = 0;
    kv.set("workspaces", undefined); // get 返回 undefined → normalize 空 → 重试
    const list = await getWorkspaces();
    expect(list).toEqual([]);
    expect(calls).toBe(8); // 4 次尝试 × 每次 2 get（workspaces + legacy workspace 探测）
  });

  it("正常路径一次命中不重试", async () => {
    kv.clear();
    kv.set("workspaces", ["/tmp/ws"]);
    calls = 0;
    rejectFirstN = 0;
    const list = await getWorkspaces();
    expect(list).toEqual(["/tmp/ws"]);
    expect(calls).toBe(1);
  });
});
