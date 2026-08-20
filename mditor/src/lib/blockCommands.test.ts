// blockCommands 的派发回归测试（v3.9.5）。起因：v3.9.4 把块操作的滚动打点
// 统一到 dispatchScrolled 出口时写出了自递归（函数调用自己、从不
// view.dispatch）——6 条块命令（列表互转/转任务列表/分隔线/上移/下移/
// 复制/删除）的事务从不派发，文档从未改变；而 facade 的 catch 又把
// RangeError 静默吞掉，用户侧只看到「编辑没有保存下来」。tsc/eslint 与
// 现有测试对这种运行时递归全部免疫——本文件用 dispatch 间谍视图补上
// 这层网：任何「调用了命令但事务没派发/命令抛异常」的回归都会在这里红。
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Schema, Node as PMNode } from "@milkdown/prose/model";
import { EditorState, TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import {
  applyBlockTarget,
  deleteBlockCommand,
  duplicateBlockCommand,
  moveBlockCommand,
} from "./blockCommands";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block", toDOM: () => ["p", 0] },
    heading: {
      content: "inline*",
      group: "block",
      attrs: { level: { default: 2 } },
      toDOM: (n) => ["h" + n.attrs.level, 0],
    },
    blockquote: { content: "block+", group: "block", toDOM: () => ["blockquote", 0] },
    code_block: {
      content: "text*",
      group: "block",
      marks: "",
      toDOM: () => ["pre", ["code", 0]],
    },
    bullet_list: { content: "list_item+", group: "block", toDOM: () => ["ul", 0] },
    ordered_list: {
      content: "list_item+",
      group: "block",
      attrs: { order: { default: 1 }, tight: { default: true } },
      toDOM: () => ["ol", 0],
    },
    list_item: {
      content: "paragraph block*",
      attrs: { checked: { default: null } },
      toDOM: () => ["li", 0],
    },
    horizontal_rule: { group: "block", atom: true, toDOM: () => ["hr"] },
    text: { group: "inline" },
  },
  marks: {},
});

const t = (text: string) => ({ type: "text", text });
const para = (...inlines: unknown[]) => ({ type: "paragraph", content: inlines });
const li = (...blocks: unknown[]) => ({ type: "list_item", content: blocks });
const docOf = (...blocks: unknown[]) => PMNode.fromJSON(schema, { type: "doc", content: blocks });

interface MockView {
  view: EditorView;
  dispatch: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
}

/** 构造 headless 伪视图（PM 官方测试范式）：dispatch 间谍同时把事务
 * apply 回 state —— 多步命令（如 task_list = wrapInList + switchListKind）
 * 的后续步骤才能读到前一步派发后的文档。 */
function mockView(doc: PMNode, caretPos: number): MockView {
  const focus = vi.fn();
  const v: {
    state: EditorState;
    dispatch: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  } = {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, caretPos),
    }),
    dispatch: vi.fn(),
    focus,
  };
  v.dispatch = vi.fn((tr: Parameters<EditorView["dispatch"]>[0]) => {
    v.state = v.state.apply(tr);
  });
  return { view: v as unknown as EditorView, dispatch: v.dispatch, focus };
}

/** 三个段落 "aaa"/"bbb"/"ccc"：块尺寸 0..5/5..10/10..15，段二文本位 6..9。 */
function threeParas(): PMNode {
  return docOf(para(t("aaa")), para(t("bbb")), para(t("ccc")));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("blockCommands 派发回归（v3.9.5：dispatchScrolled 自递归曾让事务从不派发）", () => {
  it("moveBlock(up) 派发一个事务且文档确实交换了两块", () => {
    const { view, dispatch } = mockView(threeParas(), 6);
    expect(() => moveBlockCommand(view, "up")).not.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    const tr = dispatch.mock.calls[0][0];
    // "aaa"(0..5) 与 "bbb"(5..10) 交换 → 第二块现在是 aaa
    expect(tr.doc.child(1).textContent).toBe("aaa");
  });

  it("moveBlock(down) 派发一个事务", () => {
    const { view, dispatch } = mockView(threeParas(), 6);
    expect(moveBlockCommand(view, "down")).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const tr = dispatch.mock.calls[0][0];
    expect(tr.doc.child(1).textContent).toBe("ccc");
  });

  it("duplicateBlock 派发一个事务且副本紧跟原块", () => {
    const { view, dispatch } = mockView(threeParas(), 6);
    expect(() => duplicateBlockCommand(view)).not.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    const tr = dispatch.mock.calls[0][0];
    expect(tr.doc.childCount).toBe(4);
    expect(tr.doc.child(1).textContent).toBe("bbb");
    expect(tr.doc.child(2).textContent).toBe("bbb");
  });

  it("deleteBlock 派发一个事务且目标块被删除", () => {
    const { view, dispatch } = mockView(threeParas(), 6);
    expect(() => deleteBlockCommand(view)).not.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    const tr = dispatch.mock.calls[0][0];
    expect(tr.doc.childCount).toBe(2);
    expect(tr.doc.child(0).textContent).toBe("aaa");
    expect(tr.doc.child(1).textContent).toBe("ccc");
  });

  it("applyBlockTarget('hr') 派发一个事务（hr 只走 dispatchScrolled 出口）", () => {
    const { view, dispatch } = mockView(threeParas(), 6);
    expect(() => applyBlockTarget(view, "hr")).not.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    const tr = dispatch.mock.calls[0][0];
    // hr 插在当前块（bbb）之后：aaa, bbb, hr, ccc
    expect(tr.doc.child(1).textContent).toBe("bbb");
    expect(tr.doc.child(2).type.name).toBe("horizontal_rule");
  });

  it("applyBlockTarget 列表互转（bullet→ordered）派发事务且类型翻转", () => {
    // bullet_list(0..13) 内两项 "one"(1..5)/"two"(7..11)；光标在 one 文本位 2。
    const doc = docOf({
      type: "bullet_list",
      content: [li(para(t("one"))), li(para(t("two")))],
    });
    const { view, dispatch } = mockView(doc, 2);
    expect(() => applyBlockTarget(view, "ordered_list")).not.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    const tr = dispatch.mock.calls[0][0];
    expect(tr.doc.child(0).type.name).toBe("ordered_list");
  });

  it("applyBlockTarget('task_list') 包裹 + 派发后 list_item 带 checked 属性", () => {
    // 场景覆盖 switchListKind 的任务态翻转：先 run(wrapInList)（自己的派发），
    // 再 switchListKind → dispatchScrolled（回归点）。两步共 ≥2 次派发，
    // 最终态 list_item.checked === false（任务语义），而不是 null。
    const { view, dispatch } = mockView(threeParas(), 6);
    expect(() => applyBlockTarget(view, "task_list")).not.toThrow();
    expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(2);
    const last = dispatch.mock.calls[dispatch.mock.calls.length - 1][0];
    // 被包裹的是中间块 bbb：aaa, bullet_list[bbb→任务项], ccc
    expect(last.doc.child(1).type.name).toBe("bullet_list");
    expect(last.doc.child(1).child(0).attrs.checked).toBe(false);
  });
});
