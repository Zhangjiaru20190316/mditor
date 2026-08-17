// 块级命令（BlockContextMenu）的纯 ProseMirror 辅助函数 —— 从
// hooks/useMilkdown.ts 抽出（无 React 依赖），useMilkdown 的 facade 直接调用。
//
// “当前块”的判定：光标所在顶层块（doc 的直接子节点）。若该顶层块是列表，则取
// 光标所在的最外层 list_item（整项移动/复制，携带其嵌套内容）。表格、引用等
// 复合块整体作为单元处理（与 Notion 的块语义一致）。

import { lift, setBlockType as pmSetBlockType, wrapIn } from "@milkdown/prose/commands";
import { liftListItem, wrapInList } from "@milkdown/prose/schema-list";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import type { Mark, Node as PMNode, ResolvedPos } from "@milkdown/prose/model";
import type { BlockInfo, BlockTargetKind } from "../types";

/** The "movable unit" at $pos: the top-level block, or — inside a top-level
 *  list — the shallowest list_item (the visible whole item). */
export function movableUnit($pos: ResolvedPos): { depth: number; node: PMNode } | null {
  if ($pos.depth < 1) return null;
  const top = $pos.node(1);
  if (top.type.name === "bullet_list" || top.type.name === "ordered_list") {
    for (let d = 2; d <= $pos.depth; d++) {
      if ($pos.node(d).type.name === "list_item") {
        return { depth: d, node: $pos.node(d) };
      }
    }
  }
  return { depth: 1, node: top };
}

function isEmptyParagraph(n: PMNode): boolean {
  return n.type.name === "paragraph" && n.childCount === 0;
}

/** Index of the nearest sibling of `idx` in direction `step`, skipping empty
 *  paragraphs (the markdown “空行” — moving across one reads as jumping a
 *  visual gap, so it should not block the move). Returns -1 / childCount when
 *  the edge is reached. */
export function nearestSibling(parent: PMNode, idx: number, step: 1 | -1): number {
  let i = idx + step;
  while (i >= 0 && i < parent.childCount && isEmptyParagraph(parent.child(i))) {
    i += step;
  }
  return i;
}

/** Semantic kind of a block node. A list_item is classified by its parent
 *  list (task items carry a non-null `checked` attr — gfm preset). */
export function classifyUnit(node: PMNode, parentName: string): BlockInfo["kind"] {
  switch (node.type.name) {
    case "paragraph":
      return "paragraph";
    case "heading":
      return "heading";
    case "blockquote":
      return "blockquote";
    case "code_block":
      return "code_block";
    case "horizontal_rule":
      return "hr";
    case "table":
      return "table";
    case "image":
      return "image";
    case "math":
    case "math_block":
      return "math_block";
    case "html":
    case "html_block":
      return "html";
    case "list_item":
      if (parentName === "bullet_list") {
        return node.attrs.checked != null ? "task_list" : "bullet_list";
      }
      if (parentName === "ordered_list") return "ordered_list";
      return "other";
    default:
      return "other";
  }
}

/** The contiguous range of the link mark around `pos`, or null. Expansion
 *  walks neighbour text nodes carrying an equal link mark — the standard
 *  “mark range at caret” resolution. */
export function linkRangeAt(
  doc: PMNode,
  pos: number
): { from: number; to: number; href: string } | null {
  const $p = doc.resolve(pos);
  const findLink = (marks: readonly Mark[] | undefined) =>
    marks?.find((m) => m.type.name === "link");
  const mark = findLink($p.marks()) ?? findLink($p.nodeBefore?.marks) ?? findLink($p.nodeAfter?.marks);
  if (!mark) return null;
  const hasLink = (n: PMNode | null | undefined): boolean =>
    !!n && !!findLink(n.marks)?.eq(mark);
  let from = pos;
  let to = pos;
  while (from > 0 && hasLink(doc.resolve(from - 1).nodeBefore)) from--;
  while (to < doc.content.size && hasLink(doc.resolve(to).nodeAfter)) to++;
  if (from >= to) return null;
  return { from, to, href: ((mark.attrs.href as string | undefined) ?? "") };
}

/** The image node at (or immediately around) `pos` — clicked directly, or via
 *  its caption/wrapper (the block image hosts the caption text). */
export function imageAt($pos: ResolvedPos, pos: number): { pos: number; src: string } | null {
  // Caption / wrapper click: the image is an ancestor.
  for (let d = $pos.depth; d >= 1; d--) {
    if ($pos.node(d).type.name === "image") {
      return {
        pos: $pos.before(d),
        src: (($pos.node(d).attrs.src as string | undefined) ?? ""),
      };
    }
  }
  // Direct hit: check the node starting at / adjacent to the click position.
  for (const p of [pos, pos + 1, Math.max(0, pos - 1)]) {
    const n = p <= $pos.doc.content.size ? $pos.doc.nodeAt(p) : null;
    if (n && n.type.name === "image") {
      return { pos: p, src: ((n.attrs.src as string | undefined) ?? "") };
    }
  }
  return null;
}

/** Depth of the nearest ancestor of the given type names, or 0. */
export function ancestorDepth($pos: ResolvedPos, names: string[]): number {
  for (let d = $pos.depth; d >= 1; d--) {
    if (names.includes($pos.node(d).type.name)) return d;
  }
  return 0;
}

/** Whether the list_item containing the caret is a task item (checked != null). */
function currentItemIsTask($pos: ResolvedPos): boolean {
  const d = ancestorDepth($pos, ["list_item"]);
  return d > 0 && $pos.node(d).attrs.checked != null;
}

/** Switch the nearest ancestor list's flavour: bullet ⇄ ordered, and plain ⇄
 *  task (task state lives on the `list_item` children's `checked` attr). Used
 *  both after wrapInList (to seed task items) and for in-place conversion —
 *  converting the whole list matches the familiar editor behaviour. */
function switchListKind(view: EditorView, kind: BlockTargetKind): void {
  const state = view.state;
  const N = state.schema.nodes;
  const $from = state.selection.$from;
  const listDepth = ancestorDepth($from, ["bullet_list", "ordered_list"]);
  if (!listDepth) return;
  const list = $from.node(listDepth);
  const listPos = $from.before(listDepth);
  const wantType = kind === "ordered_list" ? N.ordered_list : N.bullet_list;
  const wantTask = kind === "task_list";
  const tr = state.tr.setNodeMarkup(listPos, wantType ?? undefined, list.attrs);
  const liType = N.list_item;
  if (liType && liType.spec.attrs && "checked" in liType.spec.attrs) {
    let p = listPos + 1;
    for (let i = 0; i < list.childCount; i++) {
      const c = list.child(i);
      if (c.type.name === "list_item") {
        tr.setNodeMarkup(p, undefined, {
          ...c.attrs,
          checked: wantTask ? false : null,
        });
      }
      p += c.nodeSize;
    }
  }
  view.dispatch(tr.scrollIntoView());
}

/** Apply a block-type target chosen from the context menu, with toggle
 *  semantics (clicking the current flavour converts back to a paragraph). */
export function applyBlockTarget(
  view: EditorView,
  kind: BlockTargetKind,
  level?: number
): void {
  const N = view.state.schema.nodes;
  const $from = view.state.selection.$from;
  const run = (cmd: (state: typeof view.state, dispatch?: typeof view.dispatch) => boolean) =>
    cmd(view.state, view.dispatch);
  const inQuote = ancestorDepth($from, ["blockquote"]) > 0;
  const listName =
    ancestorDepth($from, ["bullet_list"]) > 0
      ? "bullet_list"
      : ancestorDepth($from, ["ordered_list"]) > 0
        ? "ordered_list"
        : null;
  const parent = $from.parent; // nearest textblock

  switch (kind) {
    case "paragraph":
      if (listName && N.list_item) run(liftListItem(N.list_item));
      else if (inQuote) run(lift);
      else run(pmSetBlockType(N.paragraph));
      break;
    case "heading": {
      const lv = Math.min(6, Math.max(1, level ?? 2));
      if (parent.type.name === "heading" && parent.attrs.level === lv) {
        run(pmSetBlockType(N.paragraph)); // same level again → back to paragraph
        break;
      }
      // heading isn't valid inside list_item — lift out first, then apply.
      if (listName && N.list_item) run(liftListItem(N.list_item));
      run(pmSetBlockType(N.heading, { level: lv }));
      break;
    }
    case "blockquote":
      if (inQuote) run(lift);
      else if (N.blockquote) run(wrapIn(N.blockquote));
      break;
    case "code_block":
      if (parent.type.name === "code_block") {
        run(pmSetBlockType(N.paragraph));
        break;
      }
      if (listName && N.list_item) run(liftListItem(N.list_item));
      run(pmSetBlockType(N.code_block));
      break;
    case "bullet_list":
    case "ordered_list":
    case "task_list": {
      const curTask = listName === "bullet_list" && currentItemIsTask($from);
      // Toggle off when already this exact flavour.
      if (
        (kind === "bullet_list" && listName === "bullet_list" && !curTask) ||
        (kind === "ordered_list" && listName === "ordered_list") ||
        (kind === "task_list" && curTask)
      ) {
        if (N.list_item) run(liftListItem(N.list_item));
        break;
      }
      if (!listName) {
        const wrapType = kind === "ordered_list" ? N.ordered_list : N.bullet_list;
        if (wrapType) run(wrapInList(wrapType));
        if (kind === "task_list") switchListKind(view, "task_list");
        break;
      }
      // Different flavour / plain ⇄ task → convert the whole list in place.
      switchListKind(view, kind);
      break;
    }
    case "hr": {
      const hrType = N.horizontal_rule;
      if (!hrType) break;
      // hr must live at the top level: insert after the current top-level block.
      const after = $from.after(1);
      const tr = view.state.tr.insert(after, hrType.create());
      tr.setSelection(
        TextSelection.near(tr.doc.resolve(Math.min(after + 1, tr.doc.content.size)), 1)
      );
      view.dispatch(tr.scrollIntoView());
      break;
    }
  }
  view.focus();
}

/** Swap the movable unit with its nearest (empty-paragraph-skipping) sibling.
 *  Implemented as delete + insert in ONE transaction so undo collapses the
 *  move into a single step and the caret travels with the block. */
export function moveBlockCommand(view: EditorView, dir: "up" | "down"): boolean {
  const state = view.state;
  const $from = state.selection.$from;
  const unit = movableUnit($from);
  if (!unit) return false;
  const parentDepth = unit.depth - 1;
  const parent = $from.node(parentDepth);
  const start = $from.before(unit.depth);
  const end = $from.after(unit.depth);
  const step = dir === "down" ? 1 : -1;
  const j = nearestSibling(parent, $from.index(parentDepth), step as 1 | -1);
  if (j < 0 || j >= parent.childCount) return false;
  // Doc range of the target sibling. start(parentDepth) is the content start
  // of the parent, which equals the position of its FIRST child (0 for doc,
  // Ls+1 for a list at Ls) — no extra offset needed.
  let tStart = 0;
  let tEnd = 0;
  let p = $from.start(parentDepth);
  for (let i = 0; i < parent.childCount; i++) {
    if (i === j) tStart = p;
    p += parent.child(i).nodeSize;
    if (i === j) tEnd = p;
  }
  // NOTE: PM's node.copy() with no argument yields an EMPTY node (content
  // defaults to null → Fragment.empty); the content must be passed explicitly.
  const copy = unit.node.copy(unit.node.content);
  // Caret offset inside the unit so it stays at the same reading spot.
  const headOff = Math.max(
    1,
    Math.min(unit.node.nodeSize - 1, state.selection.head - start)
  );
  const tr = state.tr;
  tr.delete(start, end);
  const ins = tr.mapping.map(dir === "down" ? tEnd : tStart);
  tr.insert(ins, copy);
  tr.setSelection(TextSelection.near(tr.doc.resolve(ins + headOff), 1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Insert a copy of the movable unit right below itself; caret moves into the
 *  copy (same reading offset, clamped to the copy's interior). */
export function duplicateBlockCommand(view: EditorView): void {
  const state = view.state;
  const $from = state.selection.$from;
  const unit = movableUnit($from);
  if (!unit) return;
  const start = $from.before(unit.depth);
  const end = $from.after(unit.depth);
  const headOff = Math.max(
    1,
    Math.min(unit.node.nodeSize - 1, state.selection.head - start)
  );
  const tr = state.tr.insert(end, unit.node.copy(unit.node.content));
  tr.setSelection(TextSelection.near(tr.doc.resolve(end + headOff), 1));
  view.dispatch(tr.scrollIntoView());
}

/** Delete the movable unit; caret falls to the end of the preceding neighbour
 *  (or the start of what follows when deleting the first block). */
export function deleteBlockCommand(view: EditorView): void {
  const state = view.state;
  const $from = state.selection.$from;
  const unit = movableUnit($from);
  if (!unit) return;
  const start = $from.before(unit.depth);
  const end = $from.after(unit.depth);
  const tr = state.tr.delete(start, end);
  tr.setSelection(
    TextSelection.near(tr.doc.resolve(Math.min(start, tr.doc.content.size)), -1)
  );
  view.dispatch(tr.scrollIntoView());
}
