// @vitest-environment jsdom
// FileTree 键盘可达性测试（report3 遗留项 N21，WAI-ARIA tree 模式最小子集）。
// 可行性结论：整组件挂载成本可控——依赖面只有三处 mock（tauriFs 的
// readDirLevel 喂夹具、filePrefetch / dialogs 换空实现），懒加载目录 +
// useSyncExternalStore 行订阅 + memo 方案都能在 jsdom 里跑通，无需退化为
// 「纯逻辑 + DOM 冒烟」；故以下用例直接覆盖真实挂载下的键盘行为。
//   * vitest globals 未开——API 一律显式 import 自 "vitest"（同
//     QuickSwitcher.test.tsx 的 N19 范式）；
//   * RTL v16 在无全局 afterEach 的框架里不自动 cleanup——显式调用；
//   * jsdom 实现了 HTMLElement.focus 的焦点管理（activeElement 会真实转移），
//     且 N21 实现不调用 scrollIntoView，无需补桩；
//   * 键盘事件用 fireEvent.keyDown(行元素) 派发——委托处理器挂在 .ft-scroll
//     上，经冒泡命中，e.target 即焦点行。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FileTree } from "./FileTree";

// 懒加载夹具：两级目录树（vi.hoisted 与 vi.mock 一同提升，工厂可引用）。
//   C:/ws            （工作区根）
//     notes/         （目录，首展走 readDirLevel("C:/ws/notes")）
//       n1.md
//     a.md
//     b.md
const { TREE } = vi.hoisted(() => {
  const TREE: Record<string, Array<{ name: string; path: string; isDir: boolean }>> = {
    "C:/ws": [
      { name: "notes", path: "C:/ws/notes", isDir: true },
      { name: "a.md", path: "C:/ws/a.md", isDir: false },
      { name: "b.md", path: "C:/ws/b.md", isDir: false },
    ],
    "C:/ws/notes": [{ name: "n1.md", path: "C:/ws/notes/n1.md", isDir: false }],
  };
  return { TREE };
});

// readDirLevel / collectMdPathsFromDisk 换夹具；dirOf 等 pure 帮助函数保留
// 真实实现（importOriginal），与渲染无关的 FS 调用（删除枚举）永远 resolve []。
vi.mock("../lib/tauriFs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauriFs")>();
  return {
    ...actual,
    readDirLevel: (dir: string) => Promise.resolve(TREE[dir] ?? []),
    collectMdPathsFromDisk: () => Promise.resolve([]),
  };
});

// hover 预读 / 原生确认弹窗在 jsdom 里没有后端——替换为空实现。
vi.mock("../lib/filePrefetch", () => ({ prefetchFile: () => undefined }));
vi.mock("../lib/dialogs", () => ({
  confirmDialog: () => Promise.resolve(false),
  showAlert: () => Promise.resolve(),
}));

const ROOT = "C:/ws";

/** 挂载 FileTree 并等根级行出现。onOpen 为 mock，activePath 可指定。 */
async function mountTree(activePath: string | null = null) {
  const onOpen = vi.fn();
  render(
    <FileTree
      roots={[ROOT]}
      activePath={activePath}
      onOpen={onOpen}
      excludedPaths={new Set()}
    />
  );
  await waitFor(() => expect(rows()).toHaveLength(3));
  return { onOpen };
}

/** 当前 DOM 中全部可见行（.ft-row，document order）。 */
const rows = () => [...document.querySelectorAll<HTMLElement>(".ft-row")];

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe("FileTree 键盘可达（roving tabindex + 方向键导航）", () => {
  it("初始 tab stop：无 activePath 时为第一行；仅该行 tabIndex=0", async () => {
    await mountTree();
    expect(rows()[0].tabIndex).toBe(0);
    expect(rows()[1].tabIndex).toBe(-1);
    expect(rows()[2].tabIndex).toBe(-1);
  });

  it("初始 tab stop：有 activePath 时为活动文件行", async () => {
    await mountTree("C:/ws/b.md");
    // DOM 序：notes, a.md, b.md —— tab stop 落在 b.md 行。
    expect(rows()[0].tabIndex).toBe(-1);
    expect(rows()[2].tabIndex).toBe(0);
  });

  it("ArrowDown / ArrowUp 沿 DOM 序移动焦点，tab stop 随之转移", async () => {
    await mountTree();
    const [notes, a] = rows();
    fireEvent.keyDown(notes, { key: "ArrowDown" });
    await waitFor(() => expect(a).toHaveFocus());
    expect(a.tabIndex).toBe(0); // 新焦点行接管唯一 tab stop
    expect(notes.tabIndex).toBe(-1);
    fireEvent.keyDown(a, { key: "ArrowUp" });
    await waitFor(() => expect(notes).toHaveFocus());
    // 不越界：首行再按 ArrowUp 焦点原地不动。
    fireEvent.keyDown(notes, { key: "ArrowUp" });
    expect(notes).toHaveFocus();
  });

  it("Enter 打开文件：onOpen 收到该行路径", async () => {
    const { onOpen } = await mountTree();
    const a = rows()[1];
    fireEvent.keyDown(a, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("C:/ws/a.md");
  });

  it("ArrowRight：目录展开（子行出现）；再按进第一个子行", async () => {
    await mountTree();
    const notes = rows()[0];
    fireEvent.keyDown(notes, { key: "ArrowRight" });
    // 首展走异步 readDirLevel → 子行挂载后 DOM 序：notes, n1.md, a.md, b.md。
    await waitFor(() => expect(rows()).toHaveLength(4));
    const n1 = rows()[1];
    expect(n1.dataset.path).toBe("C:/ws/notes/n1.md");
    // 已展开 → 进第一个子行。
    fireEvent.keyDown(notes, { key: "ArrowRight" });
    await waitFor(() => expect(n1).toHaveFocus());
    // 文件行 ArrowRight 无操作（焦点不移动、不抛错）。
    fireEvent.keyDown(n1, { key: "ArrowRight" });
    expect(n1).toHaveFocus();
  });

  it("ArrowLeft：子行回父行；已展开目录折叠（子行卸载、tab stop 归还）", async () => {
    await mountTree();
    const notes = rows()[0];
    fireEvent.keyDown(notes, { key: "ArrowRight" });
    await waitFor(() => expect(rows()).toHaveLength(4));
    const n1 = rows()[1];
    // 子行 → 父行。
    fireEvent.keyDown(n1, { key: "ArrowLeft" });
    await waitFor(() => expect(notes).toHaveFocus());
    // 已展开目录 → 折叠（n1 行卸载；notes 行保住 tab stop）。
    fireEvent.keyDown(notes, { key: "ArrowLeft" });
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(notes).toHaveFocus();
    expect(notes.tabIndex).toBe(0);
    // 顶层目录未展开时 ArrowLeft：无父行 → 无操作（焦点原地）。
    fireEvent.keyDown(notes, { key: "ArrowLeft" });
    expect(notes).toHaveFocus();
    expect(rows()).toHaveLength(3);
  });

  it("Home / End 跳到首末行", async () => {
    await mountTree();
    const [notes, , b] = rows();
    fireEvent.keyDown(notes, { key: "End" });
    await waitFor(() => expect(b).toHaveFocus());
    fireEvent.keyDown(b, { key: "Home" });
    await waitFor(() => expect(notes).toHaveFocus());
  });

  it("批量模式下 Enter 勾选而非打开", async () => {
    const { onOpen } = await mountTree();
    fireEvent.click(screen.getByTitle("批量选择模式"));
    const a = rows()[1];
    fireEvent.focus(a); // 聚焦推进 roving tab stop（同鼠标点击的焦点语义）
    fireEvent.keyDown(a, { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();
    await waitFor(() => expect(a.classList.contains("ft-selected")).toBe(true));
  });
});
