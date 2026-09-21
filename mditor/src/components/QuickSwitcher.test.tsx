// @vitest-environment jsdom
// QuickSwitcher 组件测试（仓内首批组件测试，N19 范式首例）：
//   * vitest globals 未开——API 一律显式 import 自 "vitest"；
//   * 单例依赖经 vi.mock 替换：vaultIndex 用 importOriginal 保留真实
//     rankEntry（过滤断言因此覆盖真实打分逻辑），仅覆盖单例的
//     entries()/stats()/subscribe()；stats 返回稳定引用，loadRecent
//     微任务里的二次 refresh 可被 React bailout 吞掉（避免 act 环境
//     外的多余重渲告警）；store 只 mock loadRecent（resolve 空表，无
//     recency 加权，空查询排序退化为路径字典序）；
//   * vi.mock 工厂提升先于 import 执行——夹具数据经 vi.hoisted 声明；
//   * RTL v16 在无全局 afterEach 的框架里不自动 cleanup——显式调用；
//   * jsdom 未实现 scrollIntoView（外壳滚动跟随会调用）——模块级补桩。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QuickSwitcher } from "./QuickSwitcher";

// 固定索引夹具：3 条条目（vi.hoisted 与 vi.mock 一同提升，工厂可引用）。
const { FIXTURE, STATS } = vi.hoisted(() => {
  const FIXTURE: import("../lib/vaultIndex").VaultEntry[] = [
    { path: "notes/alpha.md", title: "Alpha 笔记", headings: [], links: [], tags: [], mtime: 1, flashcards: [] },
    { path: "notes/beta.md", title: "Beta 笔记", headings: [], links: [], tags: [], mtime: 2, flashcards: [] },
    { path: "docs/report.md", title: "季度报告", headings: [], links: [], tags: [], mtime: 3, flashcards: [] },
  ];
  return {
    FIXTURE,
    STATS: { scanning: false, total: FIXTURE.length, done: 0, scanTotal: 0, version: 1 },
  };
});

vi.mock("../lib/vaultIndex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/vaultIndex")>();
  return {
    ...actual,
    vaultIndex: {
      entries: () => FIXTURE,
      stats: () => STATS,
      subscribe: () => () => undefined,
    },
  };
});

vi.mock("../lib/store", () => ({
  loadRecent: () => Promise.resolve([]),
}));

// jsdom 不实现 scrollIntoView——外壳的 [data-idx] 滚动跟随需要它。
Element.prototype.scrollIntoView = vi.fn();

/** 渲染打开态的 QuickSwitcher，返回回调 mock 与 RTL 视图。 */
function renderSwitcher() {
  const onClose = vi.fn();
  const onOpen = vi.fn();
  const view = render(<QuickSwitcher open onClose={onClose} onOpen={onOpen} />);
  return { onClose, onOpen, view };
}

/** 当前列表条目（.qs-item）。 */
const items = () => [...document.querySelectorAll<HTMLElement>(".qs-item")];

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe("QuickSwitcher", () => {
  it("打开后渲染 role=dialog 的 overlay，输入框自动获得焦点", async () => {
    renderSwitcher();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const input = screen.getByRole("textbox");
    // 聚焦在打开后 30ms 定时器里——waitFor 轮询等待。
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("空查询列出全部条目（3 条，同分按路径字典序）", () => {
    renderSwitcher();
    expect(items()).toHaveLength(3);
    expect(items()[0]).toHaveTextContent("季度报告"); // docs/report.md 排最前
    expect(items()[2]).toHaveTextContent("Beta 笔记");
  });

  it("输入过滤走真实 rankEntry：beta 只命中 1 条", () => {
    renderSwitcher();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "beta" } });
    expect(items()).toHaveLength(1);
    expect(items()[0]).toHaveTextContent("notes/beta.md"); // 两层以内 trimRoot 原样显示
    expect(screen.queryByText("Alpha 笔记")).not.toBeInTheDocument();
  });

  it("ArrowDown/ArrowUp 移动选中项并触发滚动跟随", () => {
    renderSwitcher();
    const input = screen.getByRole("textbox");
    expect(items()[0].className).toContain("sel");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(items()[1].className).toContain("sel");
    expect(items()[0].className).not.toContain("sel");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(items()[0].className).toContain("sel");
  });

  it("Enter 以当前选中条目调用 onOpen 并关闭", () => {
    const { onClose, onOpen } = renderSwitcher();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("notes/beta.md");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape 触发 onClose", () => {
    const { onClose } = renderSwitcher();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点击 overlay 背景关闭；点击 panel 内部不关闭", () => {
    const { onClose } = renderSwitcher();
    fireEvent.click(document.querySelector(".qs-panel")!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("`>` 进入命令模式：前缀变 >、显示提示且不出候选", () => {
    renderSwitcher();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: ">" } });
    expect(document.querySelector(".qs-prefix")?.textContent).toBe(">");
    expect(
      screen.getByText("命令面板即将推出——目前仅支持文件跳转。")
    ).toBeInTheDocument();
    expect(items()).toHaveLength(0);
    // 命令模式下继续输入：输入框显示 slice(1)，查询回填 ">"+v。
    fireEvent.change(input, { target: { value: "foo" } });
    expect(input).toHaveValue("foo");
    expect(items()).toHaveLength(0);
  });

  it("关闭后带 closing 类保留退场，180ms 动画播完才卸载", async () => {
    const { onClose, view } = renderSwitcher();
    const overlay = screen.getByRole("dialog");
    view.rerender(<QuickSwitcher open={false} onClose={onClose} onOpen={() => undefined} />);
    expect(overlay.className).toContain("closing");
    await new Promise((r) => setTimeout(r, 220));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
