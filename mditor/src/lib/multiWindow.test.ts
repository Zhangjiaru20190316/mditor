// 多窗口纯函数（v4.8）：URL 构建/解析往返、窗口标题格式、参数编码边界。
// 契约锚点：Rust 侧 commands.rs 的 urlencode / create_doc_window 按同一
// 格式拼 URL——这里的往返用例保证前端编码与解析不自相矛盾（中文、空格、
// `#`、`&` 等 URL 结构字符绝不能丢参或截断查询串）。

import { describe, expect, it } from "vitest";
import {
  buildDocWindowUrl,
  formatWindowTitle,
  parseBootParams,
} from "./multiWindow";

describe("buildDocWindowUrl / parseBootParams 往返", () => {
  it("只拼有值的参数：双参 / 单参 / 无参", () => {
    expect(buildDocWindowUrl()).toBe("index.html");
    expect(buildDocWindowUrl("C:/a.md")).toBe(
      `index.html?path=${encodeURIComponent("C:/a.md")}`
    );
    expect(buildDocWindowUrl(undefined, "ho-1-123")).toBe(
      "index.html?handoff=ho-1-123"
    );
    expect(buildDocWindowUrl("C:/a.md", "ho-1-123")).toBe(
      `index.html?path=${encodeURIComponent("C:/a.md")}&handoff=ho-1-123`
    );
  });

  it("往返：encode 后的 path 能被 parseBootParams 完整还原", () => {
    const cases = [
      "C:\\Users\\hh\\文档\\笔记 #1.md",
      "D:/a&b=c?.md",
      "/home/u/中文 目录/空 格.md",
      "E:\\#[&=]特殊·字符.md",
      "C:/emoji-🎉-path.md",
    ];
    for (const p of cases) {
      const url = buildDocWindowUrl(p, "ho-7-42");
      const search = url.slice(url.indexOf("?"));
      const parsed = parseBootParams(search);
      expect(parsed.path).toBe(p);
      expect(parsed.handoff).toBe("ho-7-42");
    }
  });

  it("parseBootParams：无参 / 空 search / 未知键 → 双 null", () => {
    expect(parseBootParams("")).toEqual({ path: null, handoff: null });
    expect(parseBootParams("?")).toEqual({ path: null, handoff: null });
    expect(parseBootParams("?foo=1")).toEqual({ path: null, handoff: null });
  });

  it("parseBootParams：空串值按缺省处理（不是空字符串）", () => {
    expect(parseBootParams("?path=&handoff=")).toEqual({
      path: null,
      handoff: null,
    });
  });

  it("parseBootParams 接受 location.search 的原样形态（含 ? 前缀）", () => {
    const p = parseBootParams(
      `?path=${encodeURIComponent("C:/a b#1.md")}&handoff=ho-0-999`
    );
    expect(p).toEqual({ path: "C:/a b#1.md", handoff: "ho-0-999" });
  });

  it("parseBootParams：+ 号形态的空格也能解码（URLSearchParams 语义）", () => {
    expect(parseBootParams("?path=a+b.md")).toEqual({
      path: "a b.md",
      handoff: null,
    });
  });
});

describe("formatWindowTitle（窗口标题 = 任务栏/Alt+Tab 名）", () => {
  it("干净：`name — Mditor`；脏：`• name — Mditor`", () => {
    expect(formatWindowTitle("笔记.md", false)).toBe("笔记.md — Mditor");
    expect(formatWindowTitle("笔记.md", true)).toBe("• 笔记.md — Mditor");
    expect(formatWindowTitle("未命名.md", false)).toBe("未命名.md — Mditor");
  });
});
