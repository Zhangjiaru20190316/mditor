// @vitest-environment jsdom
// CitationPicker 组件测试（N19 范式）：
//   * 本文件 **不 mock 任何单例**——lib/bibliography 的 BibliographyManager
//     提供同步 loadText(path, src)（离线数据注入，不碰平台 IO/store），
//     all()/search()/subscribe()/getErrors() 全走真实实现；lib/bibtex
//     解析与 lib/citation 的 authorShort 亦真实（判断依据：setPath 读盘
//     之外存在纯内存落地路径 loadText，可离线用，故按任务要求优先真实）。
//     数据经 beforeEach 的 loadText 重置，测试间互不污染；
//   * vitest globals 未开——API 显式 import 自 "vitest"；jsdom 未实现
//     scrollIntoView——模块级补桩；RTL 显式 cleanup（同 QuickSwitcher）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CitationPicker } from "./CitationPicker";
import { bibliography } from "../lib/bibliography";

// 3 条固定文献：1 作者 / 2 作者 / 4 作者（覆盖 authorShort 三档形态）。
const BIB_SRC = `@article{einstein1915,
  author = {Einstein, Albert},
  title = {The Field Equations of Gravitation},
  year = {1915},
}
@book{knuth1984,
  author = {Knuth, Donald E.},
  title = {The TeXbook},
  year = {1984},
}
@inproceedings{chen2020,
  author = {Chen, Wei and Lee, Min and Park, Soo and Kim, Da},
  title = {A Survey of Deep Learning},
  year = {2020},
}
`;

// jsdom 不实现 scrollIntoView——外壳的 [data-idx] 滚动跟随需要它。
Element.prototype.scrollIntoView = vi.fn();

/** 渲染打开态的 CitationPicker，返回回调 mock 与 RTL 视图。 */
function renderPicker() {
  const onClose = vi.fn();
  const onInsert = vi.fn();
  const view = render(<CitationPicker open onClose={onClose} onInsert={onInsert} />);
  return { onClose, onInsert, view };
}

/** 当前列表条目（.qs-item.cp-item）。 */
const items = () => [...document.querySelectorAll<HTMLElement>(".qs-item")];

beforeEach(() => {
  bibliography.loadText("fixture.bib", BIB_SRC);
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe("CitationPicker", () => {
  it("打开后渲染 role=dialog 的 overlay，输入框自动获得焦点", async () => {
    renderPicker();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const input = screen.getByRole("textbox");
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("空查询列出全部文献（3 条，含键与作者短形态）", () => {
    renderPicker();
    expect(items()).toHaveLength(3);
    const first = items()[0];
    expect(first).toHaveTextContent("einstein1915");
    expect(first).toHaveTextContent("The Field Equations of Gravitation");
    expect(first).toHaveTextContent("Einstein · 1915 · article");
    expect(items()[2]).toHaveTextContent("Chen et al. · 2020 · inproceedings");
  });

  it("检索走真实 search：knuth 命中 1 条，无命中给出提示", () => {
    renderPicker();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "knuth" } });
    expect(items()).toHaveLength(1);
    expect(items()[0]).toHaveTextContent("knuth1984"); // cp-key 文本
    fireEvent.change(input, { target: { value: "zzz-不存在的键" } });
    expect(items()).toHaveLength(0);
    expect(screen.getByText("无匹配条目")).toBeInTheDocument();
  });

  it("ArrowDown/ArrowUp 移动选中项并触发滚动跟随", () => {
    renderPicker();
    const input = screen.getByRole("textbox");
    expect(items()[0].className).toContain("sel");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(items()[1].className).toContain("sel");
    expect(items()[0].className).not.toContain("sel");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(items()[0].className).toContain("sel");
  });

  it("Enter 以当前选中条目调用 onInsert（[@citekey]）并关闭", () => {
    const { onClose, onInsert } = renderPicker();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "knuth" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onInsert).toHaveBeenCalledWith("[@knuth1984]");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape 触发 onClose", () => {
    const { onClose } = renderPicker();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点击 overlay 背景关闭；点击 panel 内部不关闭", () => {
    const { onClose } = renderPicker();
    fireEvent.click(document.querySelector(".qs-panel")!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("空库时提示到设置中配置 .bib 路径", () => {
    bibliography.loadText("none", "");
    renderPicker();
    expect(items()).toHaveLength(0);
    expect(
      screen.getByText("文献库为空——请在「设置 → 知识功能」中配置 .bib 文件路径")
    ).toBeInTheDocument();
  });

  it("关闭后带 closing 类保留退场，180ms 动画播完才卸载", async () => {
    const { onClose, view } = renderPicker();
    const overlay = screen.getByRole("dialog");
    view.rerender(<CitationPicker open={false} onClose={onClose} onInsert={() => undefined} />);
    expect(overlay.className).toContain("closing");
    await new Promise((r) => setTimeout(r, 220));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
