// trimRoot 回归测试：旧实现把 lastIndexOf 返回的字符下标误当数组下标传给
// slice，深层路径（a/b/c/d.md）会截出空数组、只剩一个"…"。
import { describe, expect, it } from "vitest";
import { trimRoot } from "./QuickSwitcher";

describe("QuickSwitcher trimRoot", () => {
  it("无 / 的裸文件名原样显示", () => {
    expect(trimRoot("note.md")).toBe("note.md");
  });

  it("单层目录（两层以内）原样显示、不加省略号", () => {
    expect(trimRoot("docs/note.md")).toBe("docs/note.md");
  });

  it("深层路径只保留尾部两层并加 … 前缀", () => {
    const out = trimRoot("a/b/c/d.md");
    expect(out).toContain("…");
    expect(out.endsWith("c/d.md")).toBe(true);
    expect(out).toBe("…c/d.md");
  });

  it("Windows 反斜杠路径先归一化成 posix 再截取", () => {
    expect(trimRoot("a\\b\\c\\d.md")).toBe("…c/d.md");
  });
});
