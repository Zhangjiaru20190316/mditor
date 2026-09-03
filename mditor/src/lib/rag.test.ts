// RAG 纯函数测试（模块 5）：分块（标题分节/目标大小/重叠）、余弦相似、
// top-k 检索、来源条目与问答消息组装。

import { describe, expect, it } from "vitest";
import {
  buildRagMessages,
  chunkDocument,
  CHUNK_TARGET_CHARS,
  cosineSimilarity,
  RAG_TOP_K,
  toSources,
  topKBySimilarity,
  type RagChunk,
} from "./rag";

describe("chunkDocument（分块）", () => {
  it("按标题分节，节标题进块文本前缀", () => {
    const md = [
      "# 我的笔记",
      "",
      "## 背景",
      "背景内容。",
      "",
      "## 方法",
      "方法内容。",
    ].join("\n");
    const chunks = chunkDocument("我的笔记", md, "notes/我的笔记.md");
    const headings = chunks.map((c) => c.heading);
    expect(headings).toContain("背景");
    expect(headings).toContain("方法");
    const method = chunks.find((c) => c.heading === "方法")!;
    expect(method.text).toContain("我的笔记 > 方法");
    expect(method.text).toContain("方法内容。");
  });

  it("长节按目标大小切分，块间重叠 1 句", () => {
    const para = Array.from(
      { length: 80 },
      (_, i) => `第${i}句话说的是第${i}个知识点。`
    ).join("\n");
    const chunks = chunkDocument("T", para, "a.md");
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // 逐行累进：超出目标的幅度 ≤ 一行 + 语境前缀。
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS + 60);
    }
    // 相邻块有重叠：后块开头承接前块末句。
    if (chunks.length >= 2) {
      const prevTail = chunks[0].text.trim().slice(-12);
      expect(chunks[1].text.includes(prevTail)).toBe(true);
    }
  });

  it("空文档/极短碎片不产块", () => {
    expect(chunkDocument("T", "", "a.md")).toEqual([]);
    expect(chunkDocument("T", "ab", "a.md")).toEqual([]);
  });

  it("块 id 含路径与行号，hash 稳定（增量判定的前提）", () => {
    const md = "# T\n\n内容一。\n\n## S\n\n内容二。\n";
    const chunks = chunkDocument("T", md, "p.md");
    const again = chunkDocument("T", md, "p.md");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].id).toContain("\u0000");
    chunks.forEach((c, i) => {
      expect(c.hash).toBe(again[i].hash);
      expect(c.id).toBe(again[i].id);
    });
  });
});

describe("cosineSimilarity / topKBySimilarity（检索）", () => {
  it("余弦：同向 1、正交 0、反向 -1、零向量 0", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });

  it("top-k 按相似度降序截断，零相似块不进结果", () => {
    const mk = (id: string, v: number[]): { chunk: RagChunk; vector: number[] } => ({
      chunk: { id, path: `${id}.md`, heading: "h", text: id, hash: id, line: 0 },
      vector: v,
    });
    const entries = [
      mk("a", [1, 0]),
      mk("b", [0.9, 0.1]),
      mk("c", [0, 1]),
      mk("d", [0.5, 0.5]),
    ];
    const top = topKBySimilarity([1, 0], entries, 3);
    expect(top.map((t) => t.chunk.id)).toEqual(["a", "b", "d"]);
    expect(top[0].score).toBeGreaterThanOrEqual(top[1].score);
    const none = topKBySimilarity([1, 0], [mk("z", [0, 1])], RAG_TOP_K);
    expect(none).toEqual([]);
  });

  it("toSources：文件名去扩展、snippet 裁剪、携带相似度", () => {
    const scored = [
      {
        chunk: {
          id: "x",
          path: "C:/notes/dir/我的笔记.md",
          heading: "方法",
          text: "x".repeat(400),
          hash: "x",
          line: 3,
        },
        score: 0.876,
      },
    ];
    const [src] = toSources(scored);
    expect(src.name).toBe("我的笔记");
    expect(src.heading).toBe("方法");
    expect(src.snippet.endsWith("…")).toBe(true);
    expect(src.snippet.length).toBe(300);
    expect(src.score).toBeCloseTo(0.876);
  });
});

describe("buildRagMessages（问答消息组装）", () => {
  it("system 提示 + <source> 上下文标注来源文件与节标题", () => {
    const msgs = buildRagMessages("库里怎么记引用？", [
      { path: "a.md", name: "a", heading: "引用", snippet: "用 [@key] 语法", score: 0.9 },
    ]);
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].content).toContain("库里怎么记引用？");
    expect(msgs[1].content).toContain('<source index="1" file="a" heading="引用">');
    expect(msgs[1].content).toContain("用 [@key] 语法");
  });

  it("无来源时上下文标注为空（模型据此说明未找到）", () => {
    const msgs = buildRagMessages("问题", []);
    expect(msgs[1].content).toContain("（无相关片段）");
  });
});
