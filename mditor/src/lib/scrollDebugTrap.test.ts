// @vitest-environment jsdom
// R5 观测补点：写入陷阱（未打标 scrollTop 写入 / scrollIntoView 调用栈捕获）
// 只转发不改行为；环形 12 条；ghost 事件附最近 400ms 记录。
import { afterEach, describe, expect, it } from "vitest";
import {
  installWriteTrapForTest,
  recentWriteTrap,
  scrollDebugClear,
  writeTrapLog,
} from "./scrollDebug";

afterEach(() => scrollDebugClear());

describe("写入陷阱（R5：未打标写入调用栈捕获）", () => {
  it("宿主 scrollTop 写入被捕获（含 from→to 与调用栈），他元素不捕获", () => {
    installWriteTrapForTest();
    const host = document.createElement("div");
    host.id = "mditor-editor";
    document.body.appendChild(host);
    const other = document.createElement("div");
    document.body.appendChild(other);

    host.scrollTop = 1234;
    other.scrollTop = 99;

    const rec = recentWriteTrap(1000);
    expect(rec).not.toBeNull();
    expect(rec!.kind).toBe("set-scrollTop");
    expect(rec!.detail).toContain("1234");
    expect(rec!.stack.length).toBeGreaterThan(0);
  });

  it("环形缓冲截断到 12 条", () => {
    installWriteTrapForTest();
    const host = document.createElement("div");
    host.className = "mditor-editor-host";
    document.body.appendChild(host);
    for (let i = 0; i < 20; i++) host.scrollTop = i;
    expect(writeTrapLog().length).toBe(12);
  });

  it("窗外的陷阱记录不返回（recentWriteTrap 时间窗）", () => {
    installWriteTrapForTest();
    const host = document.createElement("div");
    host.id = "mditor-editor";
    document.body.appendChild(host);
    host.scrollTop = 42;
    expect(recentWriteTrap(0)).toBeNull();
    expect(recentWriteTrap(60_000)).not.toBeNull();
  });
});
