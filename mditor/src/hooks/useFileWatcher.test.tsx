// @vitest-environment jsdom
// useFileWatcher 订阅门单测（v5.3.x 外部关联）：shouldWatch=false → 不订阅
// 目录监听（断开的文件夹 / 类型不在生效集合）；缺省与 true → 既有行为。

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";

const watchFn = vi.fn(
  async (_path: string, _cb: (event: unknown) => void, _opts?: { recursive?: boolean }) =>
    () => undefined
);

vi.mock("../platform", () => ({
  getAdapter: () => ({
    fs: { watch: watchFn, readTextFile: vi.fn(async () => "x") },
  }),
}));

import { useFileWatcher } from "./useFileWatcher";

let cleanup: (() => void) | null = null;

function mountWatcher(path: string | null, shouldWatch?: (p: string) => boolean): void {
  function Probe(): null {
    useFileWatcher({
      path,
      dirty: false,
      getContent: () => "",
      onReload: () => {},
      isSavingRef: { current: false },
      ...(shouldWatch ? { shouldWatch } : {}),
    });
    return null;
  }
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(React.createElement(Probe));
  });
  cleanup = () =>
    act(() => {
      root.unmount();
    });
}

beforeEach(() => {
  watchFn.mockClear();
});
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("useFileWatcher.shouldWatch（v5.3.x 外部关联订阅门）", () => {
  it("缺省 → 照常订阅（打开文件父目录，非递归）", () => {
    mountWatcher("E:/ws/a.md");
    expect(watchFn).toHaveBeenCalledTimes(1);
    expect(watchFn.mock.calls[0][0]).toBe("E:/ws");
    expect(watchFn.mock.calls[0][2]).toEqual({ recursive: false });
  });

  it("shouldWatch=false → 不订阅", () => {
    mountWatcher("E:/ws/frozen/a.md", () => false);
    expect(watchFn).not.toHaveBeenCalled();
  });

  it("shouldWatch=true → 订阅；path 为 null 不订阅（既有行为）", () => {
    mountWatcher("E:/ws/a.md", () => true);
    expect(watchFn).toHaveBeenCalledTimes(1);
    watchFn.mockClear();
    mountWatcher(null, () => true);
    expect(watchFn).not.toHaveBeenCalled();
  });
});
