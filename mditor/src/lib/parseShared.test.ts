import { describe, expect, it } from "vitest";
import { contentFingerprint } from "./parseShared";

describe("contentFingerprint", () => {
  it("同一内容指纹稳定", () => {
    const md = "# 标题\n\n正文 with **markdown** & unicode ✨";
    expect(contentFingerprint(md)).toBe(contentFingerprint(md));
  });

  it("内容变化（哪怕一个字符）指纹变化", () => {
    const base = "a".repeat(10_000);
    expect(contentFingerprint(base)).not.toBe(contentFingerprint(base + "x"));
    expect(contentFingerprint(base)).not.toBe(
      contentFingerprint(base.slice(0, -1) + "b")
    );
  });

  it("长度参与指纹：同哈希不同长度也不冲突", () => {
    // FNV-1a 对空串与某些短串可能同哈希，长度前缀保证区分。
    const fps = new Set<string>();
    for (let i = 0; i < 500; i++) fps.add(contentFingerprint("x".repeat(i)));
    expect(fps.size).toBe(500);
  });

  it("空串有稳定指纹", () => {
    expect(contentFingerprint("")).toBe(contentFingerprint(""));
    expect(contentFingerprint("")).toMatch(/^0:/);
  });
});
