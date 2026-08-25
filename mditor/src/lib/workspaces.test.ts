// workspaces 纯函数验证（V4.4 多根工作区）：大小写折叠比较、分隔符边界、
// 去重保序、store 迁移归一。全部脱离 Tauri 可跑。
import { describe, expect, it } from "vitest";
import {
  dedupeRoots,
  isUnderAnyRoot,
  isUnderRoot,
  normalizeStoredWorkspaces,
  rootOf,
  samePathFold,
} from "./workspaces";

describe("samePathFold / isUnderRoot 路径折叠比较", () => {
  it("samePathFold 忽略大小写与分隔符漂移", () => {
    expect(samePathFold("C:\\Notes", "c:/notes")).toBe(false); // 分隔符不同视为不同串（与旧实现一致：仅大小写折叠）
    expect(samePathFold("C:\\Notes", "c:\\notes")).toBe(true);
    expect(samePathFold("C:\\Notes", "C:\\Notes")).toBe(true);
  });

  it("isUnderRoot 含根本身与子路径，分隔符做边界", () => {
    expect(isUnderRoot("C:\\a\\note.md", "C:\\a")).toBe(true);
    expect(isUnderRoot("C:\\a", "C:\\a")).toBe(true);
    expect(isUnderRoot("C:\\A\\sub\\x.md", "c:\\a")).toBe(true); // 大小写漂移
    expect(isUnderRoot("C:\\ab\\x.md", "C:\\a")).toBe(false); // 边界：a ≠ ab
    expect(isUnderRoot("D:\\a\\x.md", "C:\\a")).toBe(false);
  });

  it("isUnderRoot 归一尾斜杠", () => {
    expect(isUnderRoot("C:/a/x.md", "C:\\a\\")).toBe(true);
    expect(isUnderRoot("C:\\a\\", "C:\\a")).toBe(true);
  });
});

describe("isUnderAnyRoot / rootOf 多根判定", () => {
  const roots = ["C:\\Notes", "D:\\Projects\\mditor"];

  it("isUnderAnyRoot 命中任一根", () => {
    expect(isUnderAnyRoot("C:\\Notes\\a.md", roots)).toBe(true);
    expect(isUnderAnyRoot("D:\\Projects\\mditor\\src\\App.tsx", roots)).toBe(true);
    expect(isUnderAnyRoot("D:\\Other\\a.md", roots)).toBe(false);
    expect(isUnderAnyRoot("C:\\Notes2\\a.md", roots)).toBe(false);
  });

  it("rootOf 返回第一个包含根的原字符串，无匹配为 null", () => {
    expect(rootOf("D:\\projects\\mditor\\README.md", roots)).toBe(
      "D:\\Projects\\mditor"
    );
    expect(rootOf("E:\\x.md", roots)).toBeNull();
    expect(rootOf("C:\\Notes", roots)).toBe("C:\\Notes"); // 根本身
  });

  it("嵌套根时返回靠前的根（判定确定性）", () => {
    const nested = ["C:\\a", "C:\\a\\sub"];
    expect(rootOf("C:\\a\\sub\\x.md", nested)).toBe("C:\\a");
  });
});

describe("dedupeRoots 大小写折叠去重保序", () => {
  it("去掉重复根（大小写/分隔符漂移），保留首次出现顺序", () => {
    expect(
      dedupeRoots(["C:\\Notes", "D:\\Proj", "c:\\notes", "D:\\Proj\\", "E:\\Tmp"])
    ).toEqual(["C:\\Notes", "D:\\Proj", "E:\\Tmp"]);
  });

  it("无重复时原样返回", () => {
    const roots = ["C:\\a", "D:\\b"];
    expect(dedupeRoots(roots)).toEqual(roots);
  });
});

describe("normalizeStoredWorkspaces store 迁移归一", () => {
  it("未写入（undefined）/ 非数组 → null（调用方回落旧单值键）", () => {
    expect(normalizeStoredWorkspaces(undefined)).toBeNull();
    expect(normalizeStoredWorkspaces(null)).toBeNull();
    expect(normalizeStoredWorkspaces("C:\\a")).toBeNull();
    expect(normalizeStoredWorkspaces(42)).toBeNull();
  });

  it("过滤非字符串与空串，保留合法项", () => {
    expect(
      normalizeStoredWorkspaces(["C:\\a", 123, "", "  ", "D:\\b"])
    ).toEqual(["C:\\a", "D:\\b"]);
  });

  it("空数组是合法状态（用户移除了全部根），原样返回", () => {
    expect(normalizeStoredWorkspaces([])).toEqual([]);
  });
});
