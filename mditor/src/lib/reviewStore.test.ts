// 复习进度持久化测试（模块 4）：IO 注入面 mock；损坏文件静默重建不崩
// （验收口径）；卡片键形态。

import { describe, expect, it, beforeEach } from "vitest";
import { ReviewStore, cardKey, type ReviewIO } from "./reviewStore";
import { newSchedule, scheduleAfter } from "./flashcards";

function makeIO(initial?: string): ReviewIO & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    readTextFile: async () => {
      if (initial === undefined) throw new Error("file not found");
      return initial;
    },
    writeTextFile: async (_p, s) => {
      writes.push(s);
    },
    mkdir: async () => undefined,
    appDataDir: async () => "C:/appdata",
  };
}

let store: ReviewStore;

beforeEach(() => {
  store = new ReviewStore(makeIO());
});

describe("cardKey", () => {
  it("路径 + 哈希 → 唯一键（含 \\u0000 分隔）", () => {
    expect(cardKey("a.md", "h1")).toBe("a.md\u0000h1");
    expect(cardKey("a.md", "h1")).not.toBe(cardKey("a.md", "h2"));
  });
});

describe("ReviewStore", () => {
  it("首跑无文件 → 空状态、不抛错", async () => {
    await store.ensureLoaded();
    expect(Object.keys(store.all()).length).toBe(0);
  });

  it("读入合法文件；自评后防抖写回（形态正确）", async () => {
    const t = 1_700_000_000_000;
    const s = scheduleAfter(newSchedule(t), 2, t);
    const io = makeIO(
      JSON.stringify({ version: 1, cards: { "a.md\u0000h1": s } })
    );
    const st = new ReviewStore(io);
    await st.ensureLoaded();
    expect(st.get("a.md\u0000h1")).toMatchObject({ box: 1, ease: 2.5 });

    st.set("b.md\u0000h2", newSchedule(t));
    await st.flush();
    expect(io.writes.length).toBe(1);
    const saved = JSON.parse(io.writes[0]);
    expect(saved.version).toBe(1);
    expect(Object.keys(saved.cards).sort()).toEqual(["a.md\u0000h1", "b.md\u0000h2"]);
  });

  it("损坏 JSON → 静默重建为空状态（不崩，验收口径）", async () => {
    const st = new ReviewStore(makeIO("{ 这不是合法 JSON"));
    await st.ensureLoaded();
    expect(Object.keys(st.all()).length).toBe(0);
    expect(st.get("x")).toBeNull();
  });

  it("cards 形态不对（version 不符）→ 亦静默重建", async () => {
    const st = new ReviewStore(makeIO(JSON.stringify({ version: 9, cards: [] })));
    await st.ensureLoaded();
    expect(Object.keys(st.all()).length).toBe(0);
  });

  it("remove 删除后落盘不再包含", async () => {
    const io = makeIO();
    const st = new ReviewStore(io);
    await st.ensureLoaded();
    st.set("k", newSchedule());
    st.remove("k");
    await st.flush();
    const saved = JSON.parse(io.writes[0]);
    expect(saved.cards["k"]).toBeUndefined();
  });

  it("订阅通知：load/set/remove 后触发（无变化不触发）", async () => {
    let ticks = 0;
    const un = store.subscribe(() => ticks++);
    await store.ensureLoaded();
    expect(ticks).toBe(1); // 加载完成
    store.set("k", newSchedule());
    expect(ticks).toBe(2);
    store.remove("k");
    expect(ticks).toBe(3);
    store.remove("不存在");
    expect(ticks).toBe(3);
    un();
  });
});
