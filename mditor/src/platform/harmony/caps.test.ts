// 鸿蒙能力矩阵快照（v4.13 起）：每项能力翻转都有测试锚定——意外回退
// （比如误改 HARMONY_CAPS）会在门禁暴露，而不是等到真机验收。

import { describe, expect, it } from "vitest";
import { harmonyAdapter } from "./index";

describe("HARMONY_CAPS 能力矩阵", () => {
  const caps = harmonyAdapter.capabilities;

  it("富导出（PNG/DOCX/LaTeX）可用", () => {
    expect(caps.richExport).toBe(true);
  });

  it("AI（ArkTS SSE 代理）可用", () => {
    expect(caps.ai).toBe(true);
  });

  it("外部修改监听（ArkTS stat 轮询）可用", () => {
    expect(caps.watch).toBe(true);
  });

  it("回收站（应用内 /AppData/trash）可用", () => {
    expect(caps.trash).toBe(true);
  });

  it("PDF 待真机 spike（iframe print），保守 false", () => {
    expect(caps.pdfExport).toBe(false);
  });

  it("明确不做的能力保持 false（禁做清单）", () => {
    // remoteImageProxy：ArkWeb 无 CSP 锁定，webview 直连即工作模式（不需要代理）。
    // windowControls：系统窗口管理接管。
    expect(caps.remoteImageProxy).toBe(false);
    expect(caps.windowControls).toBe(false);
  });
});
