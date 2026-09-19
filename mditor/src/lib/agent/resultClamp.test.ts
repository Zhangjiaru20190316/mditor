// E10/E11 回归：工具结果成败判定不再子串嗅探；超长结果字段级截断保持
// JSON 语法完整。
import { describe, expect, it } from "vitest";
import { clampResult, MAX_RESULT_CHARS } from "./tools";

// 与 loop.ts 内部同语义的判定（sniffFailed 未导出——经由 executeTool 才能触
// 达，这里直接验证策略本身：可解析看 ok 字段，破损看前缀）。
function sniffFailed(resultJson: string): boolean {
  try {
    const parsed = JSON.parse(resultJson) as { ok?: boolean };
    return parsed.ok === false;
  } catch {
    return resultJson.startsWith(`{"ok":false`);
  }
}

describe("E10：工具结果成败判定（策略）", () => {
  it("成功结果内容里含 '\"ok\":false' 字面量 → 仍判成功", () => {
    const r = JSON.stringify({
      ok: true,
      content: '他说 {"ok":false} 然后笔记继续……',
    });
    expect(sniffFailed(r)).toBe(false);
  });

  it("真失败（ok:false）→ 判失败；破损 fail 输出（前缀）→ 判失败", () => {
    expect(sniffFailed(JSON.stringify({ ok: false, error: "x" }))).toBe(true);
    const truncated = `{"ok":false,"error":"${"e".repeat(30000)}`.slice(0, MAX_RESULT_CHARS);
    expect(sniffFailed(truncated)).toBe(true);
  });

  it("破损的成功输出不误判（前缀不是 fail 形态）", () => {
    const truncated = `{"ok":true,"notes":[${"1,".repeat(20000)}`.slice(0, MAX_RESULT_CHARS);
    expect(sniffFailed(truncated)).toBe(false);
  });
});

describe("E11：clampResult 字段级截断", () => {
  it("短结果原样返回", () => {
    expect(clampResult({ ok: true, content: "hi" })).toBe(`{"ok":true,"content":"hi"}`);
  });

  it("单字段超长 → 字段截断，输出仍是合法 JSON（可解析且 ok 字段在）", () => {
    const big = "x".repeat(60_000);
    const out = clampResult({ ok: true, path: "a.md", content: big });
    expect(out.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 200);
    const parsed = JSON.parse(out) as { ok: boolean; content: string; path: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe("a.md"); // 小字段完整保留
    expect(parsed.content).toContain("已截断");
  });

  it("多个长字段同时截断后仍合法", () => {
    const out = clampResult({
      ok: true,
      a: "y".repeat(30_000),
      b: "z".repeat(30_000),
    });
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("结构本身超限（海量小字段）→ 兜底整体切片 + 截断标记", () => {
    const obj: Record<string, unknown> = { ok: true };
    for (let i = 0; i < 5000; i++) obj[`k${i}`] = i; // 序列化后远超 24k
    const out = clampResult(obj);
    expect(out.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 100);
    expect(out).toContain("已截断");
  });
});
