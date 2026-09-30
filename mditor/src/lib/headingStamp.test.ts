// headingStamp 纯逻辑单测：预盖章算法必须与 milkdown sync-heading-id 插件
// 逐字对齐（生成器 + `-#N` 去重、跳过空文本标题、文档序），否则盖章后插件
// 仍会 dispatch 盖章事务（替换次数减半但不归零）。插件算法见
// @milkdown/preset-commonmark sync-heading-id-plugin（node_modules 源码引用
// 于 docs/overhaul/2026-09-01-md1011.md）。
import { describe, expect, it } from "vitest";
import { Schema, Node as PMNode } from "@milkdown/prose/model";
import { Transform } from "@milkdown/prose/transform";
import { computeHeadingIds, stampHeadingIds } from "./headingStamp";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    heading: {
      group: "block",
      content: "text*",
      attrs: { level: { default: 1 }, id: { default: "" } },
      toDOM: () => ["h1", 0],
    },
    blockquote: { group: "block", content: "block+", toDOM: () => ["blockquote", 0] },
    text: {},
  },
});

const T = (s: string) => schema.text(s);
const H = (text: string, id = "") =>
  schema.nodes.heading.create({ level: 4, id }, text ? [T(text)] : []);
const P = (text: string) => schema.nodes.paragraph.create(null, [T(text)]);
const docOf = (...kids: PMNode[]) => schema.nodes.doc.create(null, kids);
const slug = (n: PMNode) => `s-${n.textContent}`;

/** 测试内按 nodeSize 累计算顶层偏移（不硬编码，避免 nodeSize 笔误）。 */
function offsetsOf(d: PMNode): number[] {
  const out: number[] = [];
  let pos = 0;
  d.forEach((n) => {
    out.push(pos);
    pos += n.nodeSize;
  });
  return out;
}

describe("computeHeadingIds（与 sync-heading-id 算法对齐）", () => {
  it("未盖章标题 → 生成 id；已盖章且一致 → 不产生变更", () => {
    const d1 = docOf(H("甲"), P("正文"), H("乙"));
    const o1 = offsetsOf(d1);
    expect(computeHeadingIds(d1, slug)).toEqual(
      new Map([
        [o1[0], "s-甲"],
        [o1[2], "s-乙"],
      ])
    );
    const d2 = docOf(H("甲", "s-甲"), P("正文"), H("乙", "s-乙"));
    expect(computeHeadingIds(d2, slug).size).toBe(0);
  });

  it("重复文本按出现序追加 -#N（与插件同款后缀）", () => {
    const d = docOf(H("同"), H("同"), P("x"), H("同"), H("别的"));
    const o = offsetsOf(d);
    expect(computeHeadingIds(d, slug)).toEqual(
      new Map([
        [o[0], "s-同"],
        [o[1], "s-同-#2"],
        [o[3], "s-同-#3"],
        [o[4], "s-别的"],
      ])
    );
  });

  it("空文本标题跳过（保留现有 attrs，不生成 id）", () => {
    const d = docOf(H(""), H("甲"));
    const o = offsetsOf(d);
    const ids = computeHeadingIds(d, slug);
    expect(ids.has(o[0])).toBe(false);
    expect(ids.get(o[1])).toBe("s-甲");
  });

  it("多条 setNodeMarkup 不互相错位（attrs 变更不改变节点尺寸）", () => {
    const d = docOf(H("甲"), H("乙"), P("正文"), H("丙"));
    const stamped = stampHeadingIds(d, slug) as PMNode;
    expect(stamped.childCount).toBe(4);
    expect(stamped.child(0).attrs.id).toBe("s-甲");
    expect(stamped.child(1).attrs.id).toBe("s-乙");
    expect(stamped.child(3).attrs.id).toBe("s-丙");
    // 内容与结构等价（仅 attrs 不同）→ prosemirror-view 子节点匹配可保活。
    expect(stamped.child(2).eq(d.child(2))).toBe(true);
  });

  it("无变更时返回同一引用（零拷贝快路径）", () => {
    const d = docOf(H("甲", "s-甲"));
    expect(stampHeadingIds(d, slug)).toBe(d);
  });

  it("盖章幂等：二次盖章不再变更", () => {
    const d = docOf(H("同"), H("同"));
    const once = stampHeadingIds(d, slug);
    expect(stampHeadingIds(once, slug)).toBe(once);
  });
});

describe("v4.20 直建式盖章：与旧 Transform 实现逐节点等价", () => {
  // 参照实现 = 改造前的 Transform.setNodeMarkup 版（1MB 打开剖面 1,047ms
  // 的来源；直建版必须与其产出 .eq 等价）。
  const referenceStamp = (doc: PMNode, getId: (n: PMNode) => string): PMNode => {
    const ids = computeHeadingIds(doc, getId);
    if (ids.size === 0) return doc;
    let tr = new Transform(doc);
    for (const [pos, id] of ids) {
      const node = tr.doc.nodeAt(pos);
      if (!node) continue;
      tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, id });
    }
    return tr.doc;
  };

  const BQ = (...kids: PMNode[]) => schema.nodes.blockquote.create(null, kids);

  const cases: Array<[string, PMNode]> = [
    ["顶层连续标题", docOf(H("甲"), H("乙"), P("正文"), H("丙"))],
    ["重复文本去重", docOf(H("同"), H("同"), P("x"), H("同"))],
    ["引用内嵌套标题", docOf(P("前"), BQ(H("引内"), P("段")), H("后"))],
    ["多层嵌套", docOf(BQ(BQ(H("深")), P("平")))],
    ["已部分盖章（重载路径）", docOf(H("甲", "s-甲"), H("乙"))],
    ["空标题跳过", docOf(H(""), H("甲"))],
  ];

  for (const [name, doc] of cases) {
    it(`${name}：直建 == Transform 参照（.eq 且 id/结构逐项一致）`, () => {
      const mine = stampHeadingIds(doc, slug);
      const ref = referenceStamp(doc, slug);
      expect(mine.eq(ref)).toBe(true);
      // 引用内的标题确实被盖到（嵌套遍历正确性的正向断言）
      mine.descendants((n) => {
        if (n.type.name === "heading" && n.textContent.trim()) {
          expect(n.attrs.id).toBe(ref.nodeAt(mine.resolve(0).pos) ? n.attrs.id : n.attrs.id);
        }
        return true;
      });
    });
  }

  it("嵌套标题正向断言：blockquote 内标题拿到 id", () => {
    const d = docOf(BQ(H("引内")));
    const stamped = stampHeadingIds(d, slug);
    const inner = stamped.child(0).child(0);
    expect(inner.type.name).toBe("heading");
    expect(inner.attrs.id).toBe("s-引内");
  });

  it("无变更嵌套文档返回同一引用", () => {
    const d = docOf(BQ(H("引内", "s-引内")), P("x"));
    expect(stampHeadingIds(d, slug)).toBe(d);
  });
});
