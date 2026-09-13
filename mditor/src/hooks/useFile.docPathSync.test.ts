// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { useFile } from "./useFile";

// docPathSync 同步窗口回归（v4.12.3）：
//
// openPath/showDoc 在 setDoc（React 异步提交）之后**同步**触发 onLoaded →
// 编辑器 setValue → ProseMirror 节点视图创建，图片 src 在此刻按 docPath 解析
// （resolveImgSrc 相对引用拼接）。若 docPath 读 React state（.doc），节点视图
// 拿到的是上一篇文档的路径（首开为 null）→ 相对图片引用按错误目录拼接 →
// asset 404 → 永久裂图（组件 bindAttrs 只在节点更新时重解析）。
//
// 修复 = 路径赋值流（newDoc/openPath/showDoc/saveAs/updatePath）同步写
// docRef，docPathSync() 读 ref。本测试锁死：调用 openPath 后、React 提交前
// 的同一 tick 内 docPathSync 已是新路径，而 .doc 仍是旧值。

vi.mock("../lib/store", () => ({
  pushRecent: vi.fn(async () => {}),
}));

vi.mock("../lib/tauriFs", () => ({
  openMd: vi.fn(async () => null),
  saveMd: vi.fn(async () => {}),
  saveMdAs: vi.fn(async () => ""),
  baseName: (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p,
}));

let api: ReturnType<typeof useFile> | null = null;

function Probe(): null {
  api = useFile();
  return null;
}

async function mount(): Promise<ReturnType<typeof useFile>> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(React.createElement(Probe));
  });
  if (!api) throw new Error("probe did not mount");
  return api;
}

describe("useFile.docPathSync（同步窗口）", () => {
  it("openPath：同步 tick 内已是新路径（.doc 仍滞后为旧值）", async () => {
    const fa = await mount();
    expect(fa.docPathSync()).toBeNull();

    // 不 await：同步前缀（docRef 写入 + setDoc 排队 + onLoaded）立即执行。
    void fa.openPath("E:/笔记/信号与系统/a.md", "# t");
    // 编辑器节点视图创建发生在「此刻」到「React 提交」之间：
    expect(fa.docPathSync()).toBe("E:/笔记/信号与系统/a.md");
    // .doc 还是提交前的旧状态——证明同步窗口真实存在（读 .doc 必裂的原因）。
    expect(fa.doc.path).toBeNull();

    await act(async () => {});
    // 提交后 useMemo 重建（deps 含 doc），Probe 重渲染已更新模块级 api 引用。
    expect(api!.doc.path).toBe("E:/笔记/信号与系统/a.md");
  });

  it("showDoc（标签切换路径）：同样同步可读", async () => {
    const fa = await mount();
    void fa.showDoc({ path: "E:/x/one.md", content: "a", dirty: false });
    expect(fa.docPathSync()).toBe("E:/x/one.md");
    await act(async () => {});
    void fa.showDoc({ path: "E:/y/two.md", content: "b", dirty: false });
    expect(fa.docPathSync()).toBe("E:/y/two.md");
    await act(async () => {});
  });

  it("newDoc：路径同步归 null（未命名缓冲图片引用无从解析属预期）", async () => {
    const fa = await mount();
    void fa.openPath("E:/a/b.md", "x");
    await act(async () => {});
    fa.newDoc();
    expect(fa.docPathSync()).toBeNull();
    await act(async () => {});
  });
});
