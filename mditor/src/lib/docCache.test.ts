import { beforeEach, describe, expect, it } from "vitest";
import {
  cacheWorthy,
  clearDocCache,
  docCacheStats,
  hasDoc,
  putDoc,
  takeDoc,
} from "./docCache";

// docCache 是模块级单例（真实使用场景即如此）；每个用例先清空保证隔离。
beforeEach(() => {
  clearDocCache();
});

const SIG_A = "n[a,b]m[x]";
const SIG_B = "n[a,b,c]m[x]";

function big(s: string): string {
  return s + "占".repeat(200_000);
}

describe("docCache", () => {
  it("put → take 同内容命中并返回同一 JSON", () => {
    const content = big("doc1");
    const json = { type: "doc", content: [] };
    putDoc(content, json, SIG_A);
    expect(takeDoc(content, SIG_A)).toEqual(json);
  });

  it("内容被编辑（指纹变化）→ 未命中（自然失效）", () => {
    const content = big("doc2");
    putDoc(content, { v: 1 }, SIG_A);
    expect(takeDoc(content + "改动", SIG_A)).toBeNull();
    // 原内容仍在
    expect(takeDoc(content, SIG_A)).toEqual({ v: 1 });
  });

  it("schema 签名不匹配（编辑器重建换 Schema）→ 未命中且条目被弃用", () => {
    const content = big("doc3");
    putDoc(content, { v: 1 }, SIG_A);
    expect(takeDoc(content, SIG_B)).toBeNull();
    // 签名不符的读取已删除条目（避免下次再付指纹成本）
    expect(hasDoc(content, SIG_A)).toBe(false);
  });

  it("小文档不值得缓存（cacheWorthy=false，不占预算）", () => {
    expect(cacheWorthy("hello")).toBe(false);
    expect(cacheWorthy(big(""))).toBe(true);
  });

  it("容量上限触发 LRU 淘汰：最久未访问的先走", () => {
    const docs = [1, 2, 3, 4, 5, 6, 7].map((i) => big(`lru${i}`));
    docs.forEach((d, i) => putDoc(d, { i }, SIG_A));
    // 7 条 > 6 条上限：最旧的 lru1 被淘汰，其余 6 条保留。
    expect(takeDoc(docs[0], SIG_A)).toBeNull();
    expect(takeDoc(docs[1], SIG_A)).toEqual({ i: 1 });
    expect(takeDoc(docs[6], SIG_A)).toEqual({ i: 6 });
  });

  it("take 刷新 LRU：被访问过的条目活得更久", () => {
    // 6 条正好达上限；访问最旧的 touch1（刷新到最新），再塞第 7 条 →
    // 淘汰的应是最久未访问的 touch2，touch1 存活。
    const docs = [1, 2, 3, 4, 5, 6].map((i) => big(`touch${i}`));
    docs.forEach((d, i) => putDoc(d, { i }, SIG_A));
    expect(takeDoc(docs[0], SIG_A)).toEqual({ i: 0 });
    putDoc(big("touch7"), { i: 6 }, SIG_A);
    expect(takeDoc(docs[1], SIG_A)).toBeNull();
    expect(takeDoc(docs[0], SIG_A)).toEqual({ i: 0 });
  });

  it("字节预算：总量超限后从最旧条目开始回收", () => {
    // 8M 字符预算、单条 ~200k：塞 50 条必然超预算，只留最近若干条。
    const docs = Array.from({ length: 50 }, (_, i) => big(`budget${i}`));
    docs.forEach((d, i) => putDoc(d, { i }, SIG_A));
    const stats = docCacheStats();
    expect(stats.entries).toBeLessThan(50);
    expect(stats.totalChars).toBeLessThanOrEqual(8_000_000 + 200_100);
    // 最新的一定还在。
    expect(hasDoc(docs[49], SIG_A)).toBe(true);
  });

  it("clearForPressure 全量清空并返回条目数（内存守护接入）", () => {
    putDoc(big("p1"), { v: 1 }, SIG_A);
    putDoc(big("p2"), { v: 2 }, SIG_A);
    expect(clearDocCache()).toBe(2);
    expect(docCacheStats().entries).toBe(0);
    expect(takeDoc(big("p1"), SIG_A)).toBeNull();
  });
});
