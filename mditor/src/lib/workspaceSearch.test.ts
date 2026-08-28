import { afterEach, describe, expect, it, vi } from "vitest";
import { collectHits, matchLine, searchWorkspaces } from "./workspaceSearch";

// searchWorkspaces 的并发读取回归网（V4.6.2）：文件读取从串行改为限并发池
// （plugin-fs readTextFile 为 IPC 延迟主导，串行 500 文件实测 ~12s）。
// mock 掉插件边界，锚定「保序 / 截断 / 单文件失败跳过」三个语义。
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: vi.fn(),
  readTextFile: vi.fn(),
}));

describe("matchLine", () => {
  it("finds case-insensitively by default", () => {
    expect(matchLine("Hello World", "world", false)).toBe(6);
    expect(matchLine("Hello World", "world", true)).toBe(-1);
    expect(matchLine("Hello World", "World", true)).toBe(6);
  });

  it("handles CJK needles", () => {
    expect(matchLine("标题：会议纪要", "会议", true)).toBe(3);
  });

  it("empty needle never matches", () => {
    expect(matchLine("abc", "", false)).toBe(-1);
  });
});

describe("collectHits", () => {
  const doc = "# 标题\n\n正文包含 needle 一处\nanother NEEDLE here\n最后一行";

  it("collects per-line hits with 0-based line numbers", () => {
    const hits = collectHits(doc, "needle", false, 50);
    expect(hits).toHaveLength(2);
    expect(hits[0].line).toBe(2);
    expect(hits[1].line).toBe(3);
    expect(hits[1].text).toContain("NEEDLE");
  });

  it("respects case sensitivity", () => {
    expect(collectHits(doc, "needle", true, 50)).toHaveLength(1);
  });

  it("caps hits at maxHits", () => {
    const hits = collectHits("a\na\na\na", "a", false, 2);
    expect(hits).toHaveLength(2);
  });

  it("clips long lines around the match", () => {
    const long = "x".repeat(300) + "needle" + "y".repeat(300);
    const hits = collectHits(long, "needle", false, 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].text.length).toBeLessThanOrEqual(161);
    expect(hits[0].text).toContain("needle");
  });
});

/* -------------------------------------------------------------------------- */
/* searchWorkspaces（并发池语义，mock plugin-fs）                              */
/* -------------------------------------------------------------------------- */

import { readDir, readTextFile } from "@tauri-apps/plugin-fs";

const mockedReadDir = vi.mocked(readDir);
const mockedReadTextFile = vi.mocked(readTextFile);

/** 造 N 个 md 文件目录项；每个文件 i 行数不同、命中数不同，读延迟乱序
 *  （模拟 IPC 并发完成顺序 ≠ 文件顺序——结果仍必须按文件顺序输出）。 */
function setupFiles(n: number, opts: { failIndex?: number; hitsPerFile?: number } = {}) {
  const entries = Array.from({ length: n }, (_, i) => ({
    name: `note-${String(i).padStart(3, "0")}.md`,
    isDirectory: false,
  }));
  mockedReadDir.mockResolvedValue(entries as never);
  const hitsPerFile = opts.hitsPerFile ?? 1;
  mockedReadTextFile.mockImplementation(async (path: unknown) => {
    const idx = Number(/note-(\d+)\.md$/.exec(String(path))?.[1] ?? -1);
    // 乱序延迟：偶数索引慢、奇数快，逼出「完成顺序 ≠ 输出顺序」
    await new Promise((r) => setTimeout(r, idx % 2 === 0 ? 12 : 2));
    if (idx === (opts.failIndex ?? -1)) throw new Error("boom");
    return Array.from({ length: 5 }, (_, line) => `第${line}行 needle 内容`).join("\n").repeat(1) + (hitsPerFile > 1 ? "\nneedle 更多" : "");
  });
}

afterEach(() => {
  mockedReadDir.mockReset();
  mockedReadTextFile.mockReset();
});

describe("searchWorkspaces（并发池）", () => {
  it("并发完成顺序乱序时结果仍按文件顺序输出", async () => {
    setupFiles(20);
    const r = await searchWorkspaces(["C:/ws"], "needle");
    expect(r.scanned).toBe(20);
    expect(r.files).toHaveLength(20);
    // 文件顺序 = note-000..note-019
    expect(r.files[0].name).toBe("note-000.md");
    expect(r.files[19].name).toBe("note-019.md");
    expect(r.totalHits).toBeGreaterThan(0);
    expect(r.truncated).toBe(false);
  });

  it("单个文件读取失败被跳过，其余照常返回", async () => {
    setupFiles(10, { failIndex: 5 });
    const r = await searchWorkspaces(["C:/ws"], "needle");
    expect(r.scanned).toBe(10);
    expect(r.files).toHaveLength(9);
    expect(r.files.find((f) => f.name === "note-005.md")).toBeUndefined();
  });

  it("命中预算耗尽时置 truncated（并发下允许少量超出）", async () => {
    setupFiles(30, { hitsPerFile: 2 });
    const r = await searchWorkspaces(["C:/ws"], "needle", { maxTotalHits: 10 });
    expect(r.truncated).toBe(true);
    // 允许超出 ≤ 并发窗口 × 单文件命中
    expect(r.totalHits).toBeLessThanOrEqual(10 + 16 * 7);
  });

  it("空 query / 空根直接返回空结果（不触 IPC）", async () => {
    const r1 = await searchWorkspaces(["C:/ws"], "  ");
    const r2 = await searchWorkspaces([], "x");
    expect(r1.files).toHaveLength(0);
    expect(r2.files).toHaveLength(0);
    expect(mockedReadDir).not.toHaveBeenCalled();
  });
});
