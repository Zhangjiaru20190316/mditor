// Milkdown plugin bundle for the `textColor` mark — inline font color stored as
// `<span style="color:…">` in Markdown. Commonmark/GFM ship no color mark, so we
// register our own, modelled on the local ==highlight== preset (lib/highlightMark.ts):
// a mark schema + the shared `remarkTextColor` plugin so the parser/serializer
// speak `<span style="color:…">…</span>`.
//
// Registered once in useMilkdown via `crepe.editor.use(textColorPlugins)` before
// `crepe.create()`. The schema id is "textColor"; the mdast node type produced
// by remarkTextColor is "textColor".
//
// Unlike highlight there is NO input rule or keymap — color is applied through
// the floating selection toolbar's color palette (which calls the setTextColor /
// clearTextColor facade methods, built on ProseMirror transactions directly).

import type { MilkdownPlugin } from "@milkdown/ctx";
import { $markSchema, $remark } from "@milkdown/utils";
import { remarkTextColor } from "./remarkTextColor";

const MARK_ID = "textColor";

/// Text-color mark schema. `<span style="color:X">` round-trips through the
/// `textColor` mdast node. parseDOM only claims a span when its inline style
/// actually declares a `color` (returning false leaves plain spans alone).
export const textColorSchema = $markSchema(MARK_ID, () => ({
  attrs: {
    color: { default: null },
  },
  parseDOM: [
    {
      tag: "span[style]",
      getAttrs: (el) => {
        const color = (el as HTMLElement).style.color;
        // `false` tells ProseMirror to ignore this element for this mark, so
        // spans used for other styling are not swallowed.
        return color ? { color } : false;
      },
    },
  ],
  toDOM: (mark) => ["span", { style: `color:${mark.attrs.color}` }, 0],
  parseMarkdown: {
    match: (node) => node.type === MARK_ID,
    runner: (state, node, markType) => {
      state.openMark(markType, { color: (node as { color?: string }).color ?? null });
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === MARK_ID,
    runner: (state, mark) => {
      state.withMark(mark, MARK_ID, undefined, { color: mark.attrs.color });
    },
  },
}));

/// Wires the `<span style="color:…">` remark parse + stringify into Milkdown's
/// transformer. (The composable's expected type is a strongly-generic remark
/// Plugin; our `remarkTextColor` is loosely typed, so we satisfy the call with a
/// cast — same pattern as highlightMark.ts.)
export const textColorRemark = $remark("remarkTextColor", () => remarkTextColor as never);

/// Register remark (parser/serializer wiring) before the schema is built.
/// Milkdown's `$markSchema`/`$remark` composables are tuples `[ctxSlice, plugin]`;
/// `.flat()` (the built-in presets' pattern) flattens them before `editor.use()`.
export const textColorPlugins = [textColorRemark, textColorSchema].flat() as unknown as MilkdownPlugin[];
