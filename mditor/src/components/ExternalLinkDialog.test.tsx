// @vitest-environment jsdom
// ExternalLinkDialog 组件测试（v5.3.x 外部关联）：懒加载树行三态、快捷
// 开关、详情块继承/覆盖、根级类型、saved 预填与取消。树行为异步懒加载，
// 断言前先 await flushUI() 冲刷 readDir 微任务。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExternalLinkDialog } from "./ExternalLinkDialog";
import type { RootLinkOptions } from "../types";

const { readDirMock } = vi.hoisted(() => ({ readDirMock: vi.fn() }));

vi.mock("../platform", () => ({
  getAdapter: () => ({
    fs: {
      readDir: readDirMock,
    },
  }),
}));

async function renderDialog(opts: {
  saved?: RootLinkOptions;
  initialDir?: string;
  onCommit?: (o: RootLinkOptions | undefined) => void;
  onClose?: () => void;
}): Promise<{ onCommit: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> }> {
  const onCommit = vi.fn(opts.onCommit ?? (() => undefined));
  const onClose = vi.fn(opts.onClose ?? (() => undefined));
  render(
    <ExternalLinkDialog
      open
      root="C:/ws"
      saved={opts.saved}
      initialDir={opts.initialDir}
      onCommit={onCommit}
      onClose={onClose}
    />
  );
  // 懒加载树行要跨「effect → readDir 微任务 → 二次 setTree」数轮冲刷。
  for (let i = 0; i < 4; i++) await flushUI();
  return { onCommit, onClose };
}

const flushUI = () => act(async () => {});

const rowCheckbox = (name: string) => screen.getByRole("checkbox", { name });
const clickSeg = (group: string, label: string) => {
  const groupEl = screen.getByRole("radiogroup", { name: group });
  const btn = [...groupEl.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!btn) throw new Error(`seg button ${label} not found in ${group}`);
  fireEvent.click(btn);
};
const chip = (label: string) => screen.getByRole("button", { name: label });
const confirm = () => fireEvent.click(screen.getByRole("button", { name: "确定" }));
const cancel = () => fireEvent.click(screen.getByRole("button", { name: "取消" }));
const selectDir = (rel: string) => fireEvent.click(screen.getByRole("button", { name: rel }));

beforeEach(() => {
  vi.clearAllMocks();
  readDirMock.mockImplementation(async (dir: string) =>
    dir === "C:/ws"
      ? [
          { name: "notes", isDirectory: true },
          { name: "frozen", isDirectory: true },
          { name: "a.md", isDirectory: false },
        ]
      : []
  );
});
afterEach(() => {
  cleanup();
});

describe("ExternalLinkDialog（v5.3.x）", () => {
  it("默认全关联：根复选框选中；树行 notes/frozen 均勾选；根行有 ws 名", async () => {
    await renderDialog({});
    expect(rowCheckbox("ws")).toBeChecked();
    expect(rowCheckbox("notes")).toBeChecked();
    expect(rowCheckbox("frozen")).toBeChecked();
    // a.md 是文件不入树。
    expect(screen.queryByRole("checkbox", { name: "a.md" })).toBeNull();
  });

  it("快捷开关：取消勾选 frozen → 确定写出显式 enabled:false；再勾回 → 回继承删键", async () => {
    const m1 = await renderDialog({});
    fireEvent.click(rowCheckbox("frozen"));
    confirm();
    expect(m1.onCommit).toHaveBeenCalledWith({ folders: { frozen: { enabled: false } } });
    cleanup();
    // 已有显式关 + 父级开 → 勾回 = 回到继承（键被删除 → onCommit(undefined)）。
    const m2 = await renderDialog({ saved: { folders: { frozen: { enabled: false } } } });
    expect(rowCheckbox("frozen")).not.toBeChecked();
    fireEvent.click(rowCheckbox("frozen"));
    confirm();
    expect(m2.onCommit).toHaveBeenCalledWith(undefined);
  });

  it("详情块：选中文件夹 → 继承父级默认；点断开写显式 false", async () => {
    const m = await renderDialog({});
    selectDir("frozen");
    expect(screen.getByText("frozen 的规则")).toBeInTheDocument();
    clickSeg("文件夹关联开关", "断开");
    confirm();
    expect(m.onCommit).toHaveBeenCalledWith({ folders: { frozen: { enabled: false } } });
  });

  it("详情块类型：自定义初始为空集，只勾 Markdown → folders 显式子集", async () => {
    const m = await renderDialog({ initialDir: "notes" });
    expect(screen.getByText("notes 的规则")).toBeInTheDocument();
    clickSeg("文件夹生效类型", "自定义");
    fireEvent.click(chip("Markdown")); // 空集 → 勾上 md
    confirm();
    expect(m.onCommit).toHaveBeenCalledWith({
      folders: { notes: { fileTypes: ["md"] } },
    });
  });

  it("根级类型：自定义（预勾全四类）+ 反选三类 → fileTypes:[md]；根开关关闭 → enabled:false", async () => {
    const m = await renderDialog({});
    clickSeg("生效类型模式", "自定义");
    fireEvent.click(chip("✓ HTML"));
    fireEvent.click(chip("✓ PDF"));
    fireEvent.click(chip("✓ Word"));
    fireEvent.click(rowCheckbox("ws"));
    confirm();
    expect(m.onCommit).toHaveBeenCalledWith({
      enabled: false,
      fileTypes: ["md"],
    });
  });

  it("saved 预填：根类型子集回显自定义；无改动确定 = 原样回传", async () => {
    const saved: RootLinkOptions = { fileTypes: ["md", "pdf"] };
    const m = await renderDialog({ saved });
    const groupEl = screen.getByRole("radiogroup", { name: "生效类型模式" });
    const customBtn = [...groupEl.querySelectorAll("button")].find(
      (b) => b.textContent === "自定义"
    );
    expect(customBtn?.className).toContain("active");
    confirm();
    expect(m.onCommit).toHaveBeenCalledWith(saved);
  });

  it("取消只关闭、不回传", async () => {
    const m = await renderDialog({});
    cancel();
    expect(m.onCommit).not.toHaveBeenCalled();
    expect(m.onClose).toHaveBeenCalled();
  });
});
