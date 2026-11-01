// MF 轮 M2：PdfNoteView 降级/缺失/错误态单测（不触 pdfjs——懒加载路径在
// jsdom 无 Worker，真实渲染留给桌面手测清单）。平台层 mock 范式沿用
// SettingsModal.test.tsx（vi.hoisted 夹具 + vi.mock("../platform")）。

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PdfNoteView } from "./PdfNoteView";

const { ADAPTER } = vi.hoisted(() => ({
  ADAPTER: {
    runtime: "tauri" as const,
    capabilities: { pdfNoteView: true },
    fs: {
      exists: vi.fn(),
      readFile: vi.fn(),
    },
  },
}));

vi.mock("../platform", () => ({
  detectRuntime: () => "tauri" as const,
  getAdapter: () => ADAPTER,
}));

// onOpenExternal 稳定引用（memo 组件不因回调身份重渲染）。
const openExternal = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  ADAPTER.capabilities.pdfNoteView = true;
  // 默认实现：文件在、字节读挂起（不触 pdfjs 懒加载路径）。
  ADAPTER.fs.exists.mockResolvedValue(true);
  ADAPTER.fs.readFile.mockReturnValue(new Promise<Uint8Array>(() => {}));
  // jsdom 无 ResizeObserver——最小桩（不触发回调即可）。
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PdfNoteView 降级/缺失/错误态", () => {
  it("能力位关闭（harmony）→ 降级卡片 + 「用系统应用打开」，不假成功", () => {
    ADAPTER.capabilities.pdfNoteView = false;
    render(<PdfNoteView path="C:/x/a.pdf" onOpenExternal={openExternal} />);
    expect(screen.getByText("当前平台暂不支持应用内预览 PDF（预览能力待真机验证）。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "用系统应用打开" }));
    expect(openExternal).toHaveBeenCalledWith("C:/x/a.pdf");
  });

  it("文件不存在 → 缺失态（fs.exists=false）", async () => {
    ADAPTER.fs.exists.mockResolvedValue(false);
    render(<PdfNoteView path="C:/x/gone.pdf" onOpenExternal={openExternal} />);
    expect(
      await screen.findByText("文件不存在或已被移动。")
    ).toBeInTheDocument();
  });

  it("读字节失败 → 通用错误态 + 重试按钮（不触 pdfjs 加载）", async () => {
    ADAPTER.fs.exists.mockResolvedValue(true);
    ADAPTER.fs.readFile.mockRejectedValue(new Error("EACCES"));
    render(<PdfNoteView path="C:/x/locked.pdf" onOpenExternal={openExternal} />);
    expect(await screen.findByText("打开 PDF 失败。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("读取挂起 → 加载遮罩（loading 态可见）", async () => {
    ADAPTER.fs.exists.mockResolvedValue(true);
    ADAPTER.fs.readFile.mockReturnValue(new Promise<Uint8Array>(() => {}));
    render(<PdfNoteView path="C:/x/slow.pdf" onOpenExternal={openExternal} />);
    await waitFor(() => {
      expect(screen.getByText("加载中…")).toBeInTheDocument();
    });
  });
});
