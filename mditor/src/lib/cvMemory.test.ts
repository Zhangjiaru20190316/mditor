import { afterEach, describe, expect, it } from "vitest";
import { Schema, Node as PMNode } from "@milkdown/prose/model";
import { EditorState } from "@milkdown/prose/state";
import {
  CV_STORE_CAP,
  PREWARM_MAX_CHUNK,
  PREWARM_MIN_CHUNK,
  PREWARM_START_CHUNK,
  cvClearStore,
  cvHash,
  cvStoreSize,
  cvSizeFor,
  createCvIntrinsicPlugin,
  cvIntrinsicKey,
  intrinsicStyleOf,
  nextChunkSize,
  noteCvSize,
  prewarmOrder,
} from "./cvMemory";

afterEach(() => cvClearStore());

describe("cvHash（内容寻址键）", () => {
  it("same content + type → same key; any difference → different key", () => {
    expect(cvHash("heading", "第1章")).toBe(cvHash("heading", "第1章"));
    expect(cvHash("heading", "第1章")).not.toBe(cvHash("paragraph", "第1章"));
    expect(cvHash("heading", "第1章")).not.toBe(cvHash("heading", "第2章"));
  });
});

describe("noteCvSize / cvSizeFor（高度表）", () => {
  it("stores and returns sizes; returns true only for new/changed entries", () => {
    expect(noteCvSize("k1", 800, 112)).toBe(true);
    expect(noteCvSize("k1", 800, 112)).toBe(false); // 完全相同
    expect(noteCvSize("k1", 800, 113)).toBe(false); // ±2px 内视为未变（量测噪声）
    expect(noteCvSize("k1", 800, 120)).toBe(true); // 实质变化
    expect(cvSizeFor("k1")).toEqual({ w: 800, h: 120 });
    expect(cvStoreSize()).toBe(1);
  });

  it("rejects invalid input", () => {
    expect(noteCvSize("", 10, 10)).toBe(false);
    expect(noteCvSize("k", 0, 10)).toBe(false);
    expect(noteCvSize("k", 10, -1)).toBe(false);
    expect(cvStoreSize()).toBe(0);
  });

  it("evicts the oldest half when exceeding the cap", () => {
    for (let i = 0; i < CV_STORE_CAP; i++) noteCvSize(`k${i}`, 100, i);
    expect(cvStoreSize()).toBe(CV_STORE_CAP);
    noteCvSize("fresh", 100, 1); // 触发淘汰
    expect(cvStoreSize()).toBeLessThanOrEqual(CV_STORE_CAP);
    expect(cvSizeFor("fresh")).toBeDefined();
    expect(cvSizeFor("k0")).toBeUndefined(); // 最旧的已被淘汰
    expect(cvSizeFor(`k${CV_STORE_CAP - 1}`)).toBeDefined(); // 较新的保留
  });
});

describe("intrinsicStyleOf（装饰 style）", () => {
  it("emits a two-value contain-intrinsic-size (width + height placeholders)", () => {
    expect(intrinsicStyleOf(812.4, 520.6)).toBe("contain-intrinsic-size: 812px 521px");
    expect(intrinsicStyleOf(0, 0)).toBe("contain-intrinsic-size: 1px 0px");
  });
});

describe("prewarmOrder（P0-1 预热顺序：视口优先、先下后上）", () => {
  it("band asc → doc end → band start-1 back to 0", () => {
    expect(prewarmOrder(10, 4, 7)).toEqual([4, 5, 6, 7, 8, 9, 3, 2, 1, 0]);
  });

  it("clamps out-of-range band", () => {
    // 负起点夹到 0：纯自顶向下（退化 = 旧行为）。
    expect(prewarmOrder(5, -3, 3)).toEqual([0, 1, 2, 3, 4]);
    // 带尾越过文末：向上段仍从带首前一块开始。
    expect(prewarmOrder(5, 3, 99)).toEqual([3, 4, 2, 1, 0]);
    // end < start：夹到空带，起点保持在视口处向上收尾。
    expect(prewarmOrder(4, 3, 1)).toEqual([3, 2, 1, 0]);
  });

  it("empty band degrades to pure top-down (old behavior)", () => {
    expect(prewarmOrder(6, 0, 0)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("covers every index exactly once regardless of band", () => {
    for (const [total, s, e] of [
      [100, 37, 42],
      [8088, 0, 0],
      [50, 48, 60],
      [1, 0, 1],
    ] as const) {
      const order = prewarmOrder(total, s, e);
      expect(order).toHaveLength(total);
      expect(new Set(order).size).toBe(total);
      expect(Math.min(...order)).toBe(0);
      expect(Math.max(...order)).toBe(total - 1);
    }
  });
});

describe("nextChunkSize（P0-2 批大小自适应：预算内提效、超预算让出）", () => {
  it("well under half budget → double, capped at MAX", () => {
    expect(nextChunkSize(12, 2, 8)).toBe(24);
    expect(nextChunkSize(50, 1, 8)).toBe(PREWARM_MAX_CHUNK);
  });

  it("over budget → halve, floored at MIN", () => {
    expect(nextChunkSize(100, 30, 8)).toBe(50);
    expect(nextChunkSize(3, 30, 8)).toBe(2);
    expect(nextChunkSize(2, 30, 8)).toBe(1);
    expect(nextChunkSize(1, 30, 8)).toBe(PREWARM_MIN_CHUNK);
  });

  it("middle band (half budget..budget) → keep current size", () => {
    expect(nextChunkSize(24, 5, 8)).toBe(24);
    expect(nextChunkSize(PREWARM_START_CHUNK, 6, 8)).toBe(PREWARM_START_CHUNK);
  });
});

/* -------------------------------------------------------------------------- */
/* 插件 apply 语义（增量映射）：大文档打字性能回归网                            */
/*                                                                            */
/* 1MB/1.16 万块实测（2026-08-28）：docChanged 上整树 buildDecos 会让            */
/* prosemirror-view 对每个键事务做全树装饰对账（~500ms/键，打字剖面 50%）。      */
/* apply 必须走 DecorationSet.map（O(变更)）；整树重建只允许发生在 meta 事务      */
/* （learned/prewarm）。下面的用例锚定这两个语义。                              */
/* -------------------------------------------------------------------------- */

const pluginSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block", toDOM: () => ["p", 0] },
    text: { group: "inline" },
  },
  marks: {},
});

function stateWithDocs(paragraphTexts: string[]) {
  const doc = PMNode.fromJSON(pluginSchema, {
    type: "doc",
    content: paragraphTexts.map((t) => ({ type: "paragraph", content: t ? [{ type: "text", text: t }] : [] })),
  });
  // 每块预置已知高度 → init 的 buildDecos 会给全部块发装饰
  doc.forEach((node, _offset, i) => {
    noteCvSize(cvHash(node.type.name, node.textContent), 800, 100 + i);
  });
  return EditorState.create({ doc, plugins: [createCvIntrinsicPlugin()] });
}

/** 插件当前装饰覆盖的顶层块索引集合（from 位置 = 块起点）。 */
function decoratedBlockStarts(state: EditorState): number[] {
  const set = cvIntrinsicKey.getState(state);
  if (set == null) throw new Error("插件状态缺失（decoration set 未初始化）");
  const starts: number[] = [];
  let pos = 0;
  state.doc.forEach((node) => {
    const found = set.find(pos, pos + node.nodeSize).filter((d) => d.from === pos);
    if (found.length > 0) starts.push(pos);
    pos += node.nodeSize;
  });
  return starts;
}

describe("cvIntrinsic 插件 apply：docChanged 走增量映射（性能回归网）", () => {
  it("init：已知高度的块全部拿到装饰", () => {
    const st = stateWithDocs(["甲", "乙", "丙"]);
    expect(decoratedBlockStarts(st)).toEqual([0, 3, 6]);
  });

  it("编辑他块：装饰集增量映射而非整树重建——全部装饰保留且位置随映射移动", () => {
    const st = stateWithDocs(["甲", "乙", "丙"]);
    // 在第 1 块末尾插入两个字（块 1 内容变化，其新 hash 不在高度表）
    const tr = st.tr.insertText("新增", st.doc.content.child(0).content.size + 1);
    const next = st.apply(tr);
    // map 语义：三块装饰全在（重建语义会丢掉内容已变的第 1 块）
    // 第 1 块 nodeSize 2→4，第 2/3 块起点 3→5、6→8 随映射移动
    expect(decoratedBlockStarts(next)).toEqual([0, 5, 8]);
  });

  it("learned meta：整树重建（拾起新 hash / 丢弃失效装饰的既有语义不变）", () => {
    const st = stateWithDocs(["甲", "乙", "丙"]);
    const tr = st.tr.insertText("新增", st.doc.content.child(0).content.size + 1);
    const edited = st.apply(tr);
    // 视口学习量到了新高度（模拟 noteCvSize 学到块 1 新内容的高度）
    const n1 = edited.doc.content.child(0);
    noteCvSize(cvHash(n1.type.name, n1.textContent), 800, 200);
    const rebuilt = edited.apply(edited.tr.setMeta(cvIntrinsicKey, { type: "learned" }));
    expect(decoratedBlockStarts(rebuilt)).toEqual([0, 5, 8]);
  });

  it("learned meta 在未学到新高度时丢掉内容已变块的旧装饰（重建语义）", () => {
    const st = stateWithDocs(["甲", "乙", "丙"]);
    const tr = st.tr.insertText("新增", st.doc.content.child(0).content.size + 1);
    const edited = st.apply(tr);
    // 不学习新高度，直接整树重建：块 1 的新 hash 查无尺寸 → 无装饰
    const rebuilt = edited.apply(edited.tr.setMeta(cvIntrinsicKey, { type: "learned" }));
    expect(decoratedBlockStarts(rebuilt)).toEqual([5, 8]);
  });

  it("非文档事务（纯选区）不动装饰集（同一引用）", () => {
    const st = stateWithDocs(["甲", "乙", "丙"]);
    const next = st.apply(st.tr.setSelection(st.selection));
    expect(cvIntrinsicKey.getState(next)).toBe(cvIntrinsicKey.getState(st));
  });

  it("R2 分片重建：多片 rebuild-slice + rebuild-end 的终态 == learned 整树重建", () => {
    const st = stateWithDocs(["甲", "乙", "丙"]);
    const tr = st.tr.insertText("新增", st.doc.content.child(0).content.size + 1);
    const edited = st.apply(tr);
    const n1 = edited.doc.content.child(0);
    noteCvSize(cvHash(n1.type.name, n1.textContent), 800, 200);
    const full = edited.apply(edited.tr.setMeta(cvIntrinsicKey, { type: "learned" }));

    // 分片路径：两片各盖一部分（片内块位置按 doc 计）
    const doc = edited.doc;
    const p0 = 0;
    const b1 = doc.child(0).nodeSize;
    const end = doc.content.size;
    let sliced = edited;
    sliced = sliced.apply(
      sliced.tr.setMeta(cvIntrinsicKey, { type: "rebuild-slice", from: p0, to: b1 })
    );
    sliced = sliced.apply(
      sliced.tr.setMeta(cvIntrinsicKey, { type: "rebuild-slice", from: b1, to: end })
    );
    sliced = sliced.apply(sliced.tr.setMeta(cvIntrinsicKey, { type: "rebuild-end" }));
    expect(decoratedBlockStarts(sliced)).toEqual(decoratedBlockStarts(full));
    // 装饰样式逐块等价（contain-intrinsic-size 串）
    const styleOf = (state: EditorState) => {
      const set = cvIntrinsicKey.getState(state) as unknown as { find: (a: number, b: number) => { spec: { attrs?: { style?: string } } }[] };
      return decoratedBlockStarts(state).map((start) => {
        const nodeEnd = start + 2;
        const d = set.find(start, nodeEnd)[0];
        return d?.spec.attrs?.style ?? null;
      });
    };
    expect(styleOf(sliced)).toEqual(styleOf(full));
  });
});
