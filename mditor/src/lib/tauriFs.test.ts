// tauriFs 单测（v5.3 按工作区选文件树类型）：resolveTreeExts 纯函数 +
// readDirLevel 的 allowed 参数（目录恒保留、文件按扩展名白名单过滤、
// 默认行为零变化）。平台适配层 mock 内存目录。

import { describe, expect, it, vi } from "vitest";

const { ADAPTER } = vi.hoisted(() => ({
  ADAPTER: {
    fs: {
      exists: vi.fn(async () => true),
      readDir: vi.fn(async () => [
        { name: "notes", isDirectory: true },
        { name: "a.md", isDirectory: false },
        { name: "b.markdown", isDirectory: false },
        { name: "c.html", isDirectory: false },
        { name: "d.htm", isDirectory: false },
        { name: "e.pdf", isDirectory: false },
        { name: "f.docx", isDirectory: false },
        { name: "g.png", isDirectory: false },
        { name: ".hidden.md", isDirectory: false },
        { name: "node_modules", isDirectory: true },
      ]),
    },
  },
}));

vi.mock("../platform", () => ({
  detectRuntime: () => "tauri" as const,
  getAdapter: () => ADAPTER,
}));

import { NOTE_KIND_EXTS, readDirLevel, resolveTreeExts } from "./tauriFs";

describe("resolveTreeExts（v5.3 类型子集 → 扩展名并集）", () => {
  it("undefined / 空表 → undefined（不过滤）", () => {
    expect(resolveTreeExts(undefined)).toBeUndefined();
    expect(resolveTreeExts([])).toBeUndefined();
  });

  it("覆盖全部四类 → undefined（等价默认）", () => {
    expect(resolveTreeExts(["md", "html", "pdf", "docx"])).toBeUndefined();
  });

  it("子集展开为扩展名并集；白名单外类型忽略", () => {
    expect(resolveTreeExts(["pdf"])).toEqual(new Set([".pdf"]));
    expect(resolveTreeExts(["md", "html"])).toEqual(
      new Set([".md", ".markdown", ".mdx", ".mdown", ".html", ".htm"])
    );
    expect(resolveTreeExts(["md", "bogus"])).toEqual(
      new Set([".md", ".markdown", ".mdx", ".mdown"])
    );
  });

  it("NOTE_KIND_EXTS 与四类单一事实源同源（md 桶 = MD_EXTS 家族）", () => {
    expect(NOTE_KIND_EXTS.md.has(".markdown")).toBe(true);
    expect(NOTE_KIND_EXTS.html.has(".htm")).toBe(true);
    expect(NOTE_KIND_EXTS.pdf.has(".pdf")).toBe(true);
    expect(NOTE_KIND_EXTS.docx.has(".docx")).toBe(true);
  });
});

describe("readDirLevel 的 allowed 参数（v5.3）", () => {
  const names = (nodes: Array<{ name: string; isDir: boolean }>) =>
    nodes.map((n) => n.name);

  it("缺省 = 三谓词并集，既有行为零变化（四类全显、png/隐藏项不显）", async () => {
    const out = await readDirLevel("C:/ws");
    expect(names(out)).toEqual(["a.md", "b.markdown", "c.html", "d.htm", "e.pdf", "f.docx", "notes"]);
  });

  it("allowed = 「pdf」→ 目录保留，仅 pdf 文件显示", async () => {
    const out = await readDirLevel("C:/ws", undefined, resolveTreeExts(["pdf"]));
    expect(names(out)).toEqual(["e.pdf", "notes"]);
  });

  it("allowed = 「md + html」→ md 家族 + html/htm，pdf/docx/png 隐藏", async () => {
    const out = await readDirLevel("C:/ws", undefined, resolveTreeExts(["md", "html"]));
    expect(names(out)).toEqual(["a.md", "b.markdown", "c.html", "d.htm", "notes"]);
  });

  it("exclude 与 allowed 叠加生效", async () => {
    const out = await readDirLevel(
      "C:/ws",
      new Set(["C:/ws/e.pdf"]),
      resolveTreeExts(["pdf"])
    );
    expect(names(out)).toEqual(["notes"]);
  });
});
