// RAG 索引管理器测试（模块 5）：嵌入函数 mock（零真实 API 调用）——增量
// 构建（mtime/块哈希两层去重）、暂停续跑、失败保留进度、检索命中。

import { describe, expect, it, beforeEach } from "vitest";
import { RagIndexManager, type RagIO } from "./ragIndex";

function makeIO(files: Record<string, string>): RagIO & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    readTextFile: async (p) => {
      const hit = files[p];
      if (hit === undefined) throw new Error("not found");
      return hit;
    },
    writeTextFile: async (_p, s) => {
      writes.push(s);
    },
    mkdir: async () => undefined,
    appDataDir: async () => "C:/appdata",
  };
}

const DOC_A = "# 笔记A\n\n## 甲\n\n甲的内容讲苹果。\n\n## 乙\n\n乙的内容讲香蕉。\n";
const DOC_B = "# 笔记B\n\n只有一小段。\n";

/** mock 嵌入：文本 → 简单 2 维向量（「苹果」命中 [1,0]，否则 [0,1]）。 */
function mockEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(texts.map((t) => (t.includes("苹果") ? [1, 0] : [0, 1])));
}

let files: Record<string, string>;
let io: ReturnType<typeof makeIO>;
let mgr: RagIndexManager;

beforeEach(() => {
  files = { "C:/v/a.md": DOC_A, "C:/v/b.md": DOC_B };
  io = makeIO(files);
  mgr = new RagIndexManager(io);
});

describe("RagIndexManager（嵌入 mock）", () => {
  it("全量构建 → 落盘 → 检索命中含元数据文本", async () => {
    const entries = [
      { path: "C:/v/a.md", title: "笔记A", mtime: 1 },
      { path: "C:/v/b.md", title: "笔记B", mtime: 2 },
    ];
    const ok = await mgr.build(entries, { ragEmbedModel: "mock-embed" }, mockEmbed);
    expect(ok).toBe(true);
    expect(mgr.stats().phase).toBe("done");
    expect(mgr.stats().docs).toBe(2);
    expect(io.writes.length).toBeGreaterThan(0);

    const hits = mgr.search([1, 0], 8);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.text).toContain("苹果");
    expect(hits[0].chunk.heading).toBe("甲");
  });

  it("增量：mtime 未变不读盘；文件改动只重嵌改动块", async () => {
    let reads = 0;
    const counted = {
      ...io,
      readTextFile: async (p: string) => {
        if (p.startsWith("C:/v/")) reads++; // 只统计笔记读盘（不含索引文件自身）
        return io.readTextFile(p);
      },
    };
    const m = new RagIndexManager(counted);
    const e1 = [{ path: "C:/v/a.md", title: "笔记A", mtime: 10 }];
    await m.build(e1, { ragEmbedModel: "mock" }, mockEmbed);
    expect(reads).toBe(1);
    let embedCalls = 0;
    const countingEmbed = (t: string[]) => {
      embedCalls += t.length;
      return mockEmbed(t);
    };
    // 同 mtime 再构建：零读盘零嵌入。
    await m.build(e1, { ragEmbedModel: "mock" }, countingEmbed);
    expect(reads).toBe(1);
    expect(embedCalls).toBe(0);
    // mtime 变化（保存）：重读，但块哈希未变 → 零嵌入。
    await m.build([{ path: "C:/v/a.md", title: "笔记A", mtime: 11 }], { ragEmbedModel: "mock" }, countingEmbed);
    expect(reads).toBe(2);
    expect(embedCalls).toBe(0);
    // 内容变化：改动块重新嵌入。
    files["C:/v/a.md"] = DOC_A.replace("香蕉", "樱桃与葡萄");
    await m.build([{ path: "C:/v/a.md", title: "笔记A", mtime: 12 }], { ragEmbedModel: "mock" }, countingEmbed);
    expect(reads).toBe(3);
    expect(embedCalls).toBeGreaterThan(0);
    expect(m.search([0, 1], 8).some((h) => h.chunk.text.includes("樱桃"))).toBe(true);
  });

  it("暂停 → 落盘保留进度；续跑从中断处继续", async () => {
    let call = 0;
    const pausingEmbed = (t: string[]) => {
      call++;
      if (call >= 2) mgr.pause(); // 第二批嵌入后暂停
      return mockEmbed(t);
    };
    // 大文档（>16 块 → 至少 2 个嵌入批次才会触发暂停）。
    files["C:/v/big.md"] =
      "# Big\n\n" +
      Array.from(
        { length: 60 },
        (_, i) => `第${i}段：` + "详".repeat(400) + `要点${i}。`
      ).join("\n\n");
    const entries = [
      { path: "C:/v/big.md", title: "Big", mtime: 1 },
      { path: "C:/v/b.md", title: "笔记B", mtime: 2 },
    ];
    const ok = await mgr.build(entries, { ragEmbedModel: "mock" }, pausingEmbed);
    expect(ok).toBe(false); // 暂停退出
    expect(mgr.progress.phase).toBe("paused");
    expect(io.writes.length).toBeGreaterThan(0); // 进度已落盘
    // 续跑：未嵌入的块继续，最终完成。
    const done = await mgr.resume(entries, { ragEmbedModel: "mock" }, mockEmbed);
    expect(done).toBe(true);
    expect(mgr.progress.phase).toBe("done");
    expect(mgr.stats().chunks).toBeGreaterThan(0);
  });

  it("嵌入失败：error 态 + 已建部分保留可检索", async () => {
    const entries = [{ path: "C:/v/a.md", title: "笔记A", mtime: 1 }];
    const ok = await mgr.build(entries, { ragEmbedModel: "m" }, () =>
      Promise.reject(new Error("boom"))
    );
    expect(ok).toBe(false);
    expect(mgr.progress.phase).toBe("error");
    expect(mgr.progress.error).toContain("boom");
    expect(mgr.search([1, 0], 8)).toEqual([]); // 无成功块
    // 修复后重试可续。
    const done = await mgr.resume(entries, { ragEmbedModel: "m" }, mockEmbed);
    expect(done).toBe(true);
    expect(mgr.search([1, 0], 8).length).toBeGreaterThan(0);
  });

  it("换嵌入模型 → 全量重建", async () => {
    const e = [{ path: "C:/v/b.md", title: "笔记B", mtime: 1 }];
    await mgr.build(e, { ragEmbedModel: "m1" }, mockEmbed);
    expect(mgr.isBuilt("m1")).toBe(true);
    expect(mgr.isBuilt("m2")).toBe(false);
    await mgr.build(e, { ragEmbedModel: "m2" }, mockEmbed);
    expect(mgr.isBuilt("m2")).toBe(true);
  });

  it("持久化往返：新实例从盘上恢复索引与检索能力", async () => {
    await mgr.build(
      [
        { path: "C:/v/a.md", title: "笔记A", mtime: 1 },
        { path: "C:/v/b.md", title: "笔记B", mtime: 2 },
      ],
      { ragEmbedModel: "mock" },
      mockEmbed
    );
    const saved = io.writes[io.writes.length - 1];
    const restored = new RagIndexManager(
      makeIO({ ...files, "C:/appdata/rag-index.json": saved })
    );
    await restored.ensureReady();
    const hits = restored.search([1, 0], 8);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.text).toContain("苹果");
  });
});
