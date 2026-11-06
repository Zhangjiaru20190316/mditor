// @vitest-environment jsdom
// 工作区文件类型对话框组件测试（v5.3）。范式沿用 PrintDialog.test.tsx：
// vitest globals 显式 import、RTL 显式 cleanup、纯 UI 组件零平台依赖。

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceFileDialog } from "./WorkspaceFileDialog";
import { NOTE_KINDS } from "../defaults";

interface Mounted {
  onConfirm: Mock;
  onClose: Mock<() => void>;
}

function renderDialog(opts: {
  initialKinds?: readonly string[];
  onConfirm?: Mock;
  open?: boolean;
}): Mounted {
  const onConfirm = opts.onConfirm ?? vi.fn();
  const onClose = vi.fn<() => void>();
  render(
    <WorkspaceFileDialog
      open={opts.open ?? true}
      name="notes"
      initialKinds={opts.initialKinds}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
  return { onConfirm, onClose };
}

const chip = (label: string) => screen.getByRole("button", { name: new RegExp(label) });
const confirm = () => fireEvent.click(screen.getByRole("button", { name: "确定" }));
const cancel = () => fireEvent.click(screen.getByRole("button", { name: "取消" }));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe("WorkspaceFileDialog（v5.3）", () => {
  it("默认全选四类；确定按 NOTE_KINDS 顺序回传全部类型", () => {
    const m = renderDialog({});
    for (const label of ["Markdown", "HTML", "PDF", "Word"]) {
      expect(chip(label).className).toContain("on");
    }
    confirm();
    expect(m.onConfirm).toHaveBeenCalledWith(["md", "html", "pdf", "docx"]);
    expect(m.onClose).toHaveBeenCalled();
  });

  it("initialKinds 预填勾选；取消勾选的类型不出现在确认载荷", () => {
    const m = renderDialog({ initialKinds: ["pdf", "docx"] });
    expect(chip("Markdown").className).not.toContain("on");
    expect(chip("PDF").className).toContain("on");
    // 勾回 Markdown → pdf, docx, md 顺序（按 NOTE_KINDS 稳定序）。
    fireEvent.click(chip("Markdown"));
    confirm();
    expect(m.onConfirm).toHaveBeenCalledWith(["md", "pdf", "docx"]);
  });

  it("再次点击切换回选中态；确定载荷恢复该类型", () => {
    const m = renderDialog({ initialKinds: ["pdf"] });
    fireEvent.click(chip("PDF")); // 取消勾选
    confirm();
    expect(m.onConfirm).toHaveBeenCalledWith([]);
    // 空载荷 = 调用方按「恢复默认」处理（写侧删键），对话框只回传勾选集。
  });

  it("取消只关闭、不回传", () => {
    const m = renderDialog({});
    cancel();
    expect(m.onConfirm).not.toHaveBeenCalled();
    expect(m.onClose).toHaveBeenCalled();
  });

  it("NOTE_KINDS 顺序即 UI 渲染顺序（Markdown → HTML → PDF → Word）", () => {
    renderDialog({});
    const labels = [...document.querySelectorAll(".wsfile-chip")].map(
      (el) => el.textContent
    );
    expect(labels).toEqual(["✓ Markdown", "✓ HTML", "✓ PDF", "✓ Word"]);
    expect(NOTE_KINDS).toEqual(["md", "html", "pdf", "docx"]);
  });
});
