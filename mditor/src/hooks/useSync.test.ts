// @vitest-environment jsdom
// useSync 单测（§7.5.5）：harmony 恒 {status:"idle", supported:false} 且零
// 监听注册；tauri 订阅 sync-state 并随事件更新；syncNow 转发 sync-request。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RuntimeName } from "../platform/types";
import type { SyncStateEvent } from "../lib/sync/types";

let mockRuntime: RuntimeName = "tauri";
const listenMock = vi.fn(
  async (_event: string, _handler: unknown) => () => undefined
);
const emitMock = vi.fn(async (_event: string, _payload?: unknown) => undefined);

vi.mock("../platform", () => ({
  detectRuntime: () => mockRuntime,
  getAdapter: () => ({
    app: {
      listen: listenMock,
      emit: emitMock,
      invoke: async () => {
        throw new Error("useSync.test: unexpected invoke");
      },
      appDataDir: async () => "C:/appdata",
    },
  }),
}));

import { useSync, type SyncApi } from "./useSync";

/** 渲染一个调用 useSync 的探针组件，返回最新快照读取器。 */
function renderProbe(): { get: () => SyncApi; unmount: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let latest: SyncApi;
  function Probe(): null {
    latest = useSync();
    return null;
  }
  let root: Root;
  act(() => {
    root = createRoot(host);
    root.render(createElement(Probe));
  });
  return {
    get: () => latest!,
    unmount: () => {
      act(() => root!.unmount());
      host.remove();
    },
  };
}

beforeEach(() => {
  mockRuntime = "tauri";
  listenMock.mockClear();
  emitMock.mockClear();
});

afterEach(() => {
  vi.clearAllTimers();
});

describe("useSync：鸿蒙降级（§7.5.5）", () => {
  it("恒 idle + supported=false；不注册监听；syncNow 不发事件", () => {
    mockRuntime = "harmony";
    const probe = renderProbe();
    expect(probe.get().status).toBe("idle");
    expect(probe.get().supported).toBe(false);
    expect(listenMock).not.toHaveBeenCalled();
    act(() => {
      probe.get().syncNow();
    });
    expect(emitMock).not.toHaveBeenCalled();
    probe.unmount();
  });
});

describe("useSync：tauri 正常路径", () => {
  it("订阅 sync-state；事件到达后状态更新", async () => {
    const probe = renderProbe();
    expect(probe.get().supported).toBe(true);
    expect(probe.get().status).toBe("idle");
    expect(listenMock).toHaveBeenCalledWith("sync-state", expect.any(Function));

    const handler = listenMock.mock.calls[0][1] as (ev: { payload: SyncStateEvent }) => void;
    const evt: SyncStateEvent = { status: "syncing", phase: "scan", root: "C:/ws", done: 0, total: 3 };
    await act(async () => {
      handler({ payload: evt });
    });
    expect(probe.get().status).toBe("syncing");
    expect(probe.get().last).toEqual(evt);
    probe.unmount();
  });

  it("syncNow → emit sync-request", () => {
    const probe = renderProbe();
    act(() => {
      probe.get().syncNow();
    });
    expect(emitMock).toHaveBeenCalledWith("sync-request");
    probe.unmount();
  });

  it("卸载后取消订阅", async () => {
    const probe = renderProbe();
    const unlisten = vi.fn();
    listenMock.mockImplementationOnce(async () => unlisten);
    // 重新挂载一次拿到新 unlisten。
    const probe2 = renderProbe();
    probe.unmount();
    await Promise.resolve();
    expect(unlisten).not.toHaveBeenCalled(); // 第二个探针的 unlisten 才是 mock 的
    probe2.unmount();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalled();
  });
});
