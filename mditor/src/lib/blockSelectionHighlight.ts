// 跨块选区高亮（「一次选中文字 + 中间块」的视觉补全）。
//
// 根因：富文本档的代码块/公式块（公式块即 code_block(language:"LaTeX")，
// 见 remarkPipeline.mathBlocksToCode）是嵌套的 CodeMirror 编辑面
// （@milkdown/components code-block nodeview，stopEvent() 全吞）。浏览器原生
// 拖选无法把 DOM 选区伸进嵌套 contenteditable——跨块拖选时块被「绕过」：
// PM 状态选区其实已完整覆盖块（getSelection 的 textBetween、复制、批注锚点
// 全走状态选区，内容不丢），但浏览器只能在块外两侧画高亮，视觉上块像
// 「没被选中」，一次拖选拿不到「文字 + 中间块」的完整反馈。
//
// 根修：对「完全被选区覆盖」的非文本块（code_block / image / table /
// horizontal_rule）加 Decoration.node class，走 PM 官方装饰通道上 DOM
// （CustomNodeViewDesc.updateOuterDeco → patchOuterDeco 只在现有 DOM 上改
// 类名，实测 prosemirror-view dist L1485——不重建 nodeview、不重挂
// CodeMirror）。paragraph/heading 等文本块浏览器原生可画，不叠加（避免
// 双重高亮）；部分覆盖（如 CM 内三击整选后选区起于块内）不加——CM 自己画。
// 状态选区零改动——复制/SelectionToolbar/AI 划选问答行为不变，纯视觉补全。
//
// 纪律：仿 cvMemory——纯逻辑与插件分离（单测直接构造 EditorState）、全入口
// try/catch、绝不直写 PM 管辖 DOM。big 档（CodeMirror 特性关闭后 code_block
// 回落纯 pre/code、原生可画）由 CSS 在 .mditor-editor-host[data-big] 下隐藏
// 覆盖层，避免双重高亮（image/table 在 big 档仍是 nodeview，覆盖层保留）。

import { Plugin, PluginKey, TextSelection } from "@milkdown/prose/state";
import type { EditorState } from "@milkdown/prose/state";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import type { Node as PMNode } from "@milkdown/prose/model";
import { $prose } from "@milkdown/utils";

export const BLOCK_SELECTION_CLASS = "mditor-block-selected";

/** 跨块选区需要补高亮的块类型：内容不在浏览器原生选区绘制范围内的块。
 *  - code_block：含 LaTeX 公式块（Crepe 把 $$…$$ 归一为 lang=LaTeX 的
 *    code_block），CodeMirror 是嵌套编辑面，原生选区绕过；
 *  - image / table：nodeview 块（milkdown-image-block / milkdown-table-block）；
 *  - horizontal_rule：无文本叶子，原生拖选经它时什么都不画。
 *  paragraph/heading/blockquote/list 等文本容器原生可画，刻意不在名单。 */
const NON_NATIVE_BLOCKS = new Set(["code_block", "image", "table", "horizontal_rule"]);

export function isBlockSelectionTarget(node: PMNode): boolean {
  return node.isBlock && NON_NATIVE_BLOCKS.has(node.type.name);
}

/** 选区 [from,to) 内「完全覆盖」的目标块 → node 装饰。只遍历选区范围
 *  （O(sel)）；对命中的目标块不再下钻（其内容无嵌套目标块），对普通容器
 *  （blockquote/list）下钻——代码块/表格常嵌在容器里。 */
export function buildBlockSelectionDecos(
  doc: PMNode,
  from: number,
  to: number
): Decoration[] {
  const decos: Decoration[] = [];
  if (!(to > from)) return decos;
  try {
    doc.nodesBetween(from, to, (node, pos) => {
      if (!isBlockSelectionTarget(node)) return true;
      if (pos >= from && pos + node.nodeSize <= to) {
        // 第 3 参 attrs 生效到 DOM；第 4 参 spec 同值透出（自描述，单测可读）。
        decos.push(
          Decoration.node(
            pos,
            pos + node.nodeSize,
            { class: BLOCK_SELECTION_CLASS },
            { class: BLOCK_SELECTION_CLASS }
          )
        );
      }
      return false;
    });
  } catch {
    return [];
  }
  return decos;
}

export const blockSelectionKey = new PluginKey<DecorationSet>(
  "mditor-block-selection"
);

export function createBlockSelectionHighlightPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: blockSelectionKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, old, _oldState, newState) {
        try {
          if (!tr.selectionSet) {
            // 纯文档变化（罕见：程序化替换不动选区）：装饰随映射平移保持。
            return tr.docChanged ? old.map(tr.mapping, tr.doc) : old;
          }
          const sel = newState.selection;
          // 只认非空 TextSelection：NodeSelection 已有 ProseMirror-selectednode
          // 样式（selectNode）；GapCursor 无范围。空选区清空装饰。
          if (!(sel instanceof TextSelection) || sel.from >= sel.to) {
            return DecorationSet.empty;
          }
          return DecorationSet.create(
            newState.doc,
            buildBlockSelectionDecos(newState.doc, sel.from, sel.to)
          );
        } catch {
          return DecorationSet.empty;
        }
      },
    },
    props: {
      decorations(state: EditorState) {
        return blockSelectionKey.getState(state);
      },
    },
  });
}

export const blockSelectionHighlight = $prose(
  () => createBlockSelectionHighlightPlugin()
);
