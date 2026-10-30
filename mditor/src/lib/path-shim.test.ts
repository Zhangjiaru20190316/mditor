// path-shim.join 单测（2026-10-31 鸿蒙真机「文件树打不开」修复锁定）：
// join 曾把首段的前导斜杠也剥掉 → /Docs/ws-1 的子路径全变 Docs/ws-1/...，
// UriMapper 只认 /Docs/ 前缀 → 打开失败（无法解析的虚拟路径）。修复后
// 首段带根（POSIX / 或盘符）保留根；Windows 桌面行为逐字节不变。

import { describe, expect, it } from "vitest";
import { basename, dirname, join, joinAbs } from "./path-shim";

describe("join（根保留语义）", () => {
  it("鸿蒙虚拟路径：首段 /Docs 根保留，子路径可用", () => {
    expect(join("/Docs/ws-1", "00_冲刺总控.md")).toBe("/Docs/ws-1/00_冲刺总控.md");
    expect(join("/Docs/ws-1", "01_专题笔记", "a.md")).toBe("/Docs/ws-1/01_专题笔记/a.md");
    expect(join("/AppData", "logs", "x.log")).toBe("/AppData/logs/x.log");
  });

  it("Windows 桌面：盘符根保留（与旧实现一致）", () => {
    expect(join("E:\\笔记\\cmc", "a.md")).toBe("E:/笔记/cmc/a.md");
    expect(join("E:/笔记/cmc", "子", "b.md")).toBe("E:/笔记/cmc/子/b.md");
  });

  it("POSIX 绝对路径：根保留（Linux/macOS 桌面修复）", () => {
    expect(join("/home/u/notes", "a.md")).toBe("/home/u/notes/a.md");
  });

  it("后续部分的前导斜杠仍剥掉（拼接语义不变）", () => {
    expect(join("/Docs/ws-1", "/sub", "x.md")).toBe("/Docs/ws-1/sub/x.md");
    expect(join("base", "/abs-ish", "y")).toBe("base/abs-ish/y");
  });

  it("相对首段不带根：行为与旧实现一致", () => {
    expect(join("rel", "a.md")).toBe("rel/a.md");
    expect(join("rel/dir/", "a.md")).toBe("rel/dir/a.md");
  });

  it("空段过滤；全空返回空串", () => {
    expect(join("/Docs/ws-1", "", "a.md")).toBe("/Docs/ws-1/a.md");
    expect(join("", "")).toBe("");
  });
});

describe("joinAbs 与 join 根语义一致性", () => {
  it("同输入同输出（绝对基线）", () => {
    expect(joinAbs("/Docs/ws-1", "a.md")).toBe(join("/Docs/ws-1", "a.md"));
    expect(joinAbs("E:\\笔记", "a.md")).toBe(join("E:\\笔记", "a.md"));
  });
});

describe("dirname/basename 回归（根不丢）", () => {
  it("dirname 保留前导斜杠", () => {
    expect(dirname("/Docs/ws-1/a.md")).toBe("/Docs/ws-1");
    expect(dirname("/a.md")).toBe("/");
  });

  it("basename 取尾段", () => {
    expect(basename("/Docs/ws-1/a.md")).toBe("a.md");
    expect(basename("E:\\笔记\\a.md")).toBe("a.md");
  });
});
