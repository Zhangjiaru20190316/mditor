import { describe, expect, it } from "vitest";
import { Schema, Node as PMNode } from "@milkdown/prose/model";
import { EditorState, NodeSelection, TextSelection } from "@milkdown/prose/state";
import type { Decoration } from "@milkdown/prose/view";
import {
  BLOCK_SELECTION_CLASS,
  blockSelectionKey,
  buildBlockSelectionDecos,
  createBlockSelectionHighlightPlugin,
  isBlockSelectionTarget,
} from "./blockSelectionHighlight";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      toDOM: () => ["p", 0],
      parseDOM: [{ tag: "p" }],
    },
    text: { group: "inline" },
    code_block: {
      content: "text*",
      group: "block",
      code: true,
      toDOM: () => ["pre", ["code", 0]],
      parseDOM: [{ tag: "pre" }],
    },
    image: {
      group: "block",
      atom: true,
      toDOM: () => ["img"],
      parseDOM: [{ tag: "img" }],
    },
    horizontal_rule: {
      group: "block",
      atom: true,
      toDOM: () => ["hr"],
      parseDOM: [{ tag: "hr" }],
    },
    blockquote: {
      content: "block+",
      group: "block",
      toDOM: () => ["blockquote", 0],
      parseDOM: [{ tag: "blockquote" }],
    },
  },
  marks: {},
});

/** paraA / code / hr / image / paraB —— 位置：0-5 / 5-14 / 14 / 15 / 16-21 */
function makeDoc(): PMNode {
  return schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("AAA")]),
    schema.node("code_block", null, [schema.text("let a=1")]),
    schema.node("horizontal_rule"),
    schema.node("image"),
    schema.node("paragraph", null, [schema.text("BBB")]),
  ]);
}

const doc = makeDoc();

function classesOf(decos: Decoration[]): string[] {
  return decos.map((d) => String(d.spec.class));
}

describe("isBlockSelectionTarget（非原生可选块名单）", () => {
  it("code_block/image/horizontal_rule 命中，paragraph 不命中", () => {
    expect(isBlockSelectionTarget(doc.child(1))).toBe(true); // code_block
    expect(isBlockSelectionTarget(doc.child(2))).toBe(true); // hr
    expect(isBlockSelectionTarget(doc.child(3))).toBe(true); // image
    expect(isBlockSelectionTarget(doc.child(0))).toBe(false); // paragraph
    expect(isBlockSelectionTarget(doc.child(4))).toBe(false); // paragraph
  });
});

describe("buildBlockSelectionDecos（完全覆盖判定）", () => {
  it("跨块拖选（段内→段内）：中间 code_block/hr/image 全部命中", () => {
    const decos = buildBlockSelectionDecos(doc, 2, 19);
    expect(decos.map((d) => d.from).sort((a, b) => a - b)).toEqual([5, 14, 15]);
    expect(classesOf(decos).every((c) => c === BLOCK_SELECTION_CLASS)).toBe(true);
  });

  it("纯文本选区（同段内）：零装饰", () => {
    expect(buildBlockSelectionDecos(doc, 1, 4)).toEqual([]);
  });

  it("collapsed 选区：零装饰", () => {
    expect(buildBlockSelectionDecos(doc, 3, 3)).toEqual([]);
  });

  it("起点在 code_block 内（部分覆盖）：该块不加，其后目标块照常", () => {
    const decos = buildBlockSelectionDecos(doc, 7, 21);
    expect(decos.map((d) => d.from)).toEqual([14, 15]);
  });

  it("选区恰好整选一个代码块：命中", () => {
    const decos = buildBlockSelectionDecos(doc, 5, 14);
    expect(decos.map((d) => d.from)).toEqual([5]);
  });

  it("容器嵌套（blockquote > code_block）：下钻命中嵌套目标块", () => {
    const doc2 = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("X")]),
      schema.node("blockquote", null, [
        schema.node("code_block", null, [schema.text("Y")]),
      ]),
      schema.node("paragraph", null, [schema.text("Z")]),
    ]);
    // 位置：paraX 0-3，blockquote 3-8（code 在 4-7），paraZ 8-11
    const decos = buildBlockSelectionDecos(doc2, 1, 10);
    expect(decos.map((d) => d.from)).toEqual([4]);
  });
});

describe("createBlockSelectionHighlightPlugin（集成）", () => {
  function stateWithPlugin(): EditorState {
    return EditorState.create({ doc, plugins: [createBlockSelectionHighlightPlugin()] });
  }

  it("跨块 TextSelection → 中间块装饰在场；collapsed → 清空", () => {
    const st0 = stateWithPlugin();
    const st1 = st0.apply(st0.tr.setSelection(TextSelection.create(st0.doc, 2, 19)));
    const decos = blockSelectionKey.getState(st1);
    expect(decos).not.toBeNull();
    expect(decos!.find().length).toBe(3);

    const st2 = st1.apply(st1.tr.setSelection(TextSelection.create(st1.doc, 2, 2)));
    expect(blockSelectionKey.getState(st2)!.find().length).toBe(0);
  });

  it("NodeSelection（点选图片）不补装饰——已有 ProseMirror-selectednode 样式", () => {
    const st0 = stateWithPlugin();
    const st1 = st0.apply(
      st0.tr.setSelection(NodeSelection.create(st0.doc, 15))
    );
    expect(blockSelectionKey.getState(st1)!.find().length).toBe(0);
  });

  it("纯编辑事务（docChanged 不动选区）装饰随映射保持", () => {
    const st0 = stateWithPlugin();
    const st1 = st0.apply(st0.tr.setSelection(TextSelection.create(st0.doc, 2, 19)));
    expect(blockSelectionKey.getState(st1)!.find().length).toBe(3);
    // 在 paraA 内打字（插入不触发 selectionSet 的替换路径）→ 装饰位置平移
    const st2 = st1.apply(st1.tr.insert(1, schema.text("!")));
    const after = blockSelectionKey.getState(st2)!;
    expect(after.find().length).toBe(3);
    expect(after.find().every((d) => d.from >= 5)).toBe(true);
  });
});
