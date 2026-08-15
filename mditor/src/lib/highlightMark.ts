// Milkdown plugin bundle for the ==highlight== mark (`<mark>`), which
// commonmark/GFM do not ship. Modelled on the local `strikethrough` preset
// (preset-gfm/mark/strike-through): a mark schema + toggle command + input rule
// + keymap, plus the shared `remarkMark` plugin so the parser/serializer speak
// `==text==`.
//
// Registered once in useMilkdown via `crepe.editor.use(highlightPlugins)` before
// `crepe.create()`. The schema id is "highlight"; the mdast node type produced
// by remarkMark is "mark".

import { commandsCtx } from "@milkdown/core";
import type { MilkdownPlugin } from "@milkdown/ctx";
import { markRule } from "@milkdown/prose";
import { toggleMark } from "@milkdown/prose/commands";
import { $command, $inputRule, $markSchema, $remark, $useKeymap } from "@milkdown/utils";
import { remarkMark } from "./remarkMark";

const MARK_ID = "highlight";

/// Highlight mark schema. `<mark>` round-trips through `==text==`.
const highlightSchema = $markSchema(MARK_ID, () => ({
  parseDOM: [{ tag: "mark" }],
  toDOM: () => ["mark", 0],
  parseMarkdown: {
    match: (node) => node.type === "mark",
    runner: (state, node, markType) => {
      state.openMark(markType);
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === MARK_ID,
    runner: (state, mark) => {
      state.withMark(mark, "mark");
    },
  },
}));

/// Command to toggle the highlight mark on the current selection.
export const toggleHighlightCommand = $command("ToggleHighlight", (ctx) => () =>
  toggleMark(highlightSchema.type(ctx))
);

/// Typing `==text==` applies the mark live (mirrors the strong/strike input rule).
const highlightInputRule = $inputRule((ctx) =>
  markRule(/(?<![\w:/])(==)([^=\n]+?)(==)(?!\w|\/)$/, highlightSchema.type(ctx))
);

/// Ctrl/Cmd+Shift+H toggles highlight in the editor.
const highlightKeymap = $useKeymap("highlightKeymap", {
  ToggleHighlight: {
    shortcuts: "Mod-Shift-h",
    command: (ctx) => {
      const commands = ctx.get(commandsCtx);
      return () => commands.call(toggleHighlightCommand.key);
    },
  },
});

/// Wires the `==text==` remark parse + stringify into Milkdown's transformer.
/// (The composable's expected type is a strongly-generic remark Plugin; our
/// shared `remarkMark` is loosely typed, so we satisfy the call with a cast.)
const highlightRemark = $remark("remarkMark", () => remarkMark as never);

/// Register in this order: remark + schema (parser/serializer wiring) first,
/// then the command / input-rule / keymap that depend on the schema.
///
/// Milkdown's `$markSchema`/`$remark`/`$useKeymap` composables are tuples
/// `[ctxSlice, plugin]`; `$command`/`$inputRule` are single plugins. `.flat()`
/// (the same pattern the built-in presets use) flattens the tuples into
/// individual plugin entries before handing them to `editor.use()`.
export const highlightPlugins = [
  highlightRemark,
  highlightSchema,
  toggleHighlightCommand,
  highlightInputRule,
  highlightKeymap,
].flat() as unknown as MilkdownPlugin[];
