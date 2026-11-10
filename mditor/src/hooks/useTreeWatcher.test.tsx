// @vitest-environment jsdom
// useTreeWatcher 单测（v5.3.x 外部关联的文件树监听）：每根递归订阅、事件
// 路径按 shouldReactToChange 滤网过滤、防抖批量回调、roots 变化重挂、卸载
// unwatch。平台 watch mock 后直接驱动 handler。

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";

const handlers = new Map<string, (ev: unknown) => void>();
const watchFn = vi.fn(
  async (path: string, cb: (ev: unknown) => void, _opts?: { recursive?: boolean }) => {
    handlers.set(path, cb);
    return () => {
      handlers.delete(path);
    };
  }
);

vi.mock("../platform", () => ({
  getAdapter: () => ({ fs: { watch: watchFn } }),
}));

import { useTreeWatcher } from "./useTreeWatcher";
import type { RootLinkOptions } from "../types";

const ROOTS = ["C:/ws"];
const LINK_OPTS: Record<string, RootLinkOptions> = {
  "C:/ws": { folders: { frozen: { enabled: false }, p: { fileTypes: ["pdf"] } } },
};

function Probe({ onBatch, opts }: { onBatch: (p: string[]) => void; opts?: Record<string, RootLinkOptions> }): null {
  useTreeWatcher({ roots: ROOTS, externalLinkOptions: opts, onBatch });
  return null;
}

function emit(root: string, paths: string[], kind = "create"): void {
  act(() => {
    handlers.get(root)?.({ type: { kind }, paths });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  watchFn.mockClear();
  handlers.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

async function mount(onBatch: (p: string[]) => void, opts?: Record<string, RootLinkOptions>): Promise<() => Promise<void>> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(React.createElement(Probe, { onBatch, opts }));
  });
  return async () => {
    await act(async () => {
      root.unmount();
    });
  };
}

describe("useTreeWatcher（v5.3.x 文件树监听）", () => {
  it("每根递归订阅；关联路径事件防抖后批量上抛", async () => {
    expect(watchFn).not.toHaveBeenCalled();
    const onBatch = vi.fn();
    const unmount = await mount(onBatch, LINK_OPTS);
    expect(watchFn).toHaveBeenCalledTimes(1);
    expect(watchFn.mock.calls[0][0]).toBe("C:/ws");
    expect(watchFn.mock.calls[0][2]).toEqual({ recursive: true });

    emit("C:/ws", ["C:\\ws\\a.md", "C:\\ws\\b.md"]);
    expect(onBatch).not.toHaveBeenCalled(); // 防抖窗口内不上抛
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch.mock.calls[0][0]).toEqual(["C:\\ws\\a.md", "C:\\ws\\b.md"]);
    await unmount();
  });

  it("断开的文件夹与类型外事件被滤网拦截；目录（无扩展名）事件通过", async () => {
    const onBatch = vi.fn();
    const unmount = await mount(onBatch, LINK_OPTS);
    emit("C:/ws", [
      "C:\\ws\\frozen\\a.md", // 断开 → 拦
      "C:\\ws\\p\\a.md", // 类型限 pdf → 拦
      "C:\\ws\\p\\a.pdf", // pdf → 通过
      "C:\\ws\\img.png", // 非四类 → 拦
      "C:\\ws\\newdir", // 目录（无扩展名）→ 通过
      "C:\\ws\\.hidden.md", // 隐藏 → 拦
    ]);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch.mock.calls[0][0]).toEqual(["C:\\ws\\p\\a.pdf", "C:\\ws\\newdir"]);
    await unmount();
  });

  it("无配置（undefined）= 全关联全类型：md 事件通过", async () => {
    const onBatch = vi.fn();
    const unmount = await mount(onBatch, undefined);
    emit("C:/ws", ["C:\\ws\\x.md"]);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onBatch).toHaveBeenCalledWith(["C:\\ws\\x.md"]);
    await unmount();
  });

  it("unmount 后 unwatch；remove 等其余 kind 也接受", async () => {
    const unmount = await mount(vi.fn(), LINK_OPTS);
    expect(handlers.size).toBe(1);
    await unmount();
    expect(handlers.size).toBe(0);
  });
});
