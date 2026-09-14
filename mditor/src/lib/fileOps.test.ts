// fileOps 删除去向文案单测（v4.13 P5）：deleteConfirmLine / trashDestinationNote
// 按能力与运行时如实分支——桌面=系统回收站；鸿蒙=应用回收站（30 天）；
// 无能力=永久删除。修复跨平台既有 bug：桌面文案曾声称「永久删除不进回收站」
// 而行为自 v4.9 起已走系统回收站。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeName } from "../platform/types";

let mockRuntime: RuntimeName = "tauri";
let mockTrash = true;

vi.mock("../platform", () => ({
  detectRuntime: () => mockRuntime,
  getAdapter: () => ({ capabilities: { trash: mockTrash } }),
}));

import { deleteConfirmLine, trashDestinationNote } from "./fileOps";

beforeEach(() => {
  mockRuntime = "tauri";
  mockTrash = true;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("deleteConfirmLine（FileTree 确认弹窗）", () => {
  it("桌面：系统回收站（可恢复）", () => {
    expect(deleteConfirmLine()).toBe("此操作将移入系统回收站（可恢复）。");
  });

  it("鸿蒙：应用回收站（30 天自动清理），不声称可从文件管理器恢复", () => {
    mockRuntime = "harmony";
    const line = deleteConfirmLine();
    expect(line).toContain("应用回收站");
    expect(line).toContain("30 天");
    expect(line).not.toContain("文件管理器");
    expect(line).not.toContain("永久删除");
  });

  it("无回收站能力：保持永久删除警示原文", () => {
    mockTrash = false;
    expect(deleteConfirmLine()).toBe("此操作不可恢复（永久删除，不进回收站）。");
  });
});

describe("trashDestinationNote（Agent delete_note 说明）", () => {
  it("三态短版", () => {
    expect(trashDestinationNote()).toBe("移入系统回收站（可恢复）");
    mockRuntime = "harmony";
    expect(trashDestinationNote()).toContain("应用回收站");
    mockTrash = false;
    expect(trashDestinationNote()).toContain("永久删除");
  });
});
