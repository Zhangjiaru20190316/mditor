// flashcard 的 Milkdown 插件束（模块 4）：block node schema + $remark
// （lib/remarkFlash 的 native 模式）+ `:::flash` 输入规则。
//
// 注册（useMilkdown，无条件——保持 remark 插件数恒定，哨兵见
// lib/remarkPipeline）：
//   crepe.editor.use(createFlashcardPlugins())
//
// 编辑器内形态：<div class="md-flashcard" data-flashcard="1"> 包裹原始块，
// 内部 `---`（thematicBreak）渲染为分隔线——上半是问题、下半是答案，
// 卡片观感由 CSS（.md-flashcard）承载，内容仍可直接编辑。

import type { MilkdownPlugin } from "@milkdown/ctx";
import { InputRule } from "@milkdown/prose/inputrules";
import type { Node as PMNode } from "@milkdown/prose/model";
import { TextSelection } from "@milkdown/prose/state";
import { $inputRule, $nodeSchema, $remark } from "@milkdown/utils";
import { remarkFlash } from "./remarkFlash";

const FLASHCARD_ID = "flashcard";

/// block 节点：content "block+"，渲染为卡片容器 div。
const flashcardSchema = $nodeSchema(FLASHCARD_ID, () => ({
  content: "block+",
  group: "block",
  defining: true,
  isolating: true,
  attrs: {},
  parseDOM: [{ tag: "div[data-flashcard]" }],
  toDOM: () => ["div", { class: "md-flashcard", "data-flashcard": "1" }, 0],
  parseMarkdown: {
    match: (node) => (node as unknown as { type?: string }).type === "flashcard",
    runner: (state, node, type) => {
      const kids = (node as unknown as { children?: unknown[] }).children ?? [];
      state.openNode(type);
      for (const child of kids) state.next(child as never);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === FLASHCARD_ID,
    runner: (state, node) => {
      state.openNode("flashcard");
      state.next(node.content as unknown as PMNode);
      state.closeNode();
    },
  },
}));

/// remark 接线（native 模式：:::flash 块 → flashcard mdast 节点 + 回写）。
const flashcardRemark = $remark("remarkFlash", () => remarkFlash as never);

/// 输入规则：空段打出 `:::flash`（末字符 h 落键）即时成卡——
/// 卡内预填「问题段 / 分隔线 / 答案段」骨架，光标留在问题段。
const flashcardInputRule = $inputRule(() =>
  new InputRule(/^:::flash\s*$/, (state, _match, start, end) => {
    const schema = state.schema;
    const cardType = schema.nodes[FLASHCARD_ID];
    const para = schema.nodes.paragraph;
    const hr = schema.nodes.horizontal_rule;
    if (!cardType || !para || !hr) return null;
    const $start = state.doc.resolve(start);
    // 仅空文本段触发（避免吞正文；非文本块如代码块不触发）。
    if (!$start.parent.isTextblock || $start.parent.content.size > 0) return null;
    const q = para.create(null, null);
    const a = para.create(null, null);
    const card = cardType.create(null, [q, hr.create(null, null), a]);
    if (!card) return null;
    const tr = state.tr.replaceWith(start, end, card);
    // 光标放进问题段（卡片节点起点 + 1）。
    return tr.setSelection(TextSelection.create(tr.doc, start + 1));
  })
);

/** 组装插件束（remark 在前、schema 次之、input rule 末）。 */
export function createFlashcardPlugins(): MilkdownPlugin[] {
  return [flashcardRemark, flashcardSchema, flashcardInputRule].flat() as unknown as MilkdownPlugin[];
}
