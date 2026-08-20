// Shared remark plugin for inline text-color spans.
//
// Markdown has no native color syntax, so colored text is stored as inline
// HTML `<span style="color:...">…</span>` — the same convention Typora and
// most rich Markdown editors use. It round-trips through any compliant
// renderer and stays human-readable in the source.
//
// Consumed by TWO places (mirrors the ==highlight== setup in remarkMark.ts):
//   * Milkdown — registered via $remark in lib/textColorMark.ts, so the editor
//     parses `<span style="color:…">` into a ProseMirror `textColor` mark AND
//     serializes it back to the same HTML on save.
//   * (The static render pipeline in lib/renderMarkdown.ts does NOT need this:
//     it already passes raw HTML through via rehype-raw + allowDangerousHtml,
//     so colored spans render natively in AI replies / exports.)

import { STYLE_ATTR_RE, colorFromStyle } from "./colorSpan";
//
// PARSE side: remark-parse emits the tag boundaries as separate `html` mdast
// nodes (`<span …>`, then the inner inline content, then `</span>`). We walk
// each parent's children and, using a depth stack, wrap the content between a
// color-bearing open span and its matching close into a `textColor` mdast node
// `{ type:'textColor', color, children:[…] }`. The `$markSchema` in
// textColorMark.ts then matches `node.type === 'textColor'` and opens the mark.
// Spans WITHOUT a color are left untouched (raw html) so unrelated spans survive.
//
// STRINGIFY side: registers a remark-stringify handler for the `textColor`
// mdast node type that re-emits `<span style="color:…">…</span>`.

interface MdastNode {
  type?: string;
  value?: string;
  color?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

// Match an opening <span …> tag and capture its attribute string.
const OPEN_SPAN_RE = /^<span\b([^>]*)>\s*$/i;
// Match a closing </span> tag.
const CLOSE_SPAN_RE = /^<\/span>\s*$/i;

/** Extract the CSS color from a `<span>` attribute string, or null if none.
 *  Style/color parsing atoms come from lib/colorSpan.ts — the same shared
 *  source the editor's source-mode textarea helpers use, so the parse side
 *  and the editor side can't disagree on what a color span is. */
function colorFromAttrs(attrStr: string): string | null {
  const sm = STYLE_ATTR_RE.exec(attrStr);
  if (!sm) return null;
  return colorFromStyle(sm[1] ?? sm[2] ?? "");
}

/** Rebuild one parent's children, wrapping color-bearing span ranges in
 *  `textColor` mdast nodes (stack-based, handles nesting). Mutates `parent`. */
function wrapColorSpans(parent: MdastNode): void {
  const kids = parent.children;
  if (!kids || kids.length === 0) return;

  const stack: { color: string; items: MdastNode[] }[] = [];
  const out: MdastNode[] = [];
  const emit = (n: MdastNode): void => {
    if (stack.length) stack[stack.length - 1].items.push(n);
    else out.push(n);
  };

  for (const child of kids) {
    if (child.type === "html" && typeof child.value === "string") {
      const raw = child.value.trim();
      const open = OPEN_SPAN_RE.exec(raw);
      if (open) {
        const color = colorFromAttrs(open[1]);
        if (color) {
          // Open a new color span context; collect until the matching close.
          stack.push({ color, items: [] });
          continue;
        }
        // Non-color span: keep the raw html node as-is.
        emit(child);
        continue;
      }
      if (CLOSE_SPAN_RE.test(raw)) {
        if (stack.length) {
          const top = stack.pop()!;
          emit({ type: "textColor", color: top.color, children: top.items });
          continue;
        }
        // Stray close with no open: keep it.
        emit(child);
        continue;
      }
    }
    emit(child);
  }

  // Unclosed open spans: wrap whatever was collected (best effort).
  while (stack.length) {
    const top = stack.pop()!;
    const node: MdastNode = { type: "textColor", color: top.color, children: top.items };
    if (stack.length) stack[stack.length - 1].items.push(node);
    else out.push(node);
  }

  parent.children = out;
}

/** Post-order walk: transform children first, then wrap spans at this level. */
function walk(node: MdastNode): void {
  for (const c of node.children ?? []) walk(c);
  wrapColorSpans(node);
}

// ---- remark-stringify handler (serialize `textColor` → <span style=…>) ------
// We avoid importing mdast-util-to-markdown's types (a transitive dep), so the
// handler is loosely typed — the `state` methods match that library's surface.
type StringifyState = {
  createTracker: (info: unknown) => {
    move: (s: string) => string;
    current: () => Record<string, unknown>;
  };
  enter: (construct: string) => () => void;
  containerPhrasing: (node: MdastNode, opts: unknown) => string;
};

function handleTextColor(
  node: MdastNode,
  _parent: MdastNode | undefined,
  state: StringifyState,
  info: unknown
): string {
  const color = (node.color as string | undefined) ?? "";
  const tracker = state.createTracker(info);
  const exit = state.enter("textColor");
  let value = tracker.move(`<span style="color:${color}">`);
  value += state.containerPhrasing(node, {
    ...tracker.current(),
    before: value,
    after: "<",
  });
  value += tracker.move("</span>");
  exit();
  return value;
}

/**
 * The unified plugin. Register with `.use(remarkTextColor as Plugin)` or via
 * Milkdown's `$remark`. Wires the stringify handler for the `textColor` mdast
 * node type and the parse transformer that converts raw color spans into
 * `textColor` nodes in one self-contained unit.
 *
 * Deliberately NOT annotated `: Plugin` (the stringify handler touches
 * mdast-util-to-markdown internals). `this` is the unified Processor, which
 * provides `data()` for stashing remark-stringify options.
 *
 * 序列化处理器挂到 `data.toMarkdownExtensions`（v3.9.7 修复，与 remarkMark
 * 同根因）：remark-stringify v11 只读这一个键；旧版写的 `data.toMarkdown`
 * 是没人消费的死键，`textColor` 节点序列化直接抛 unknown-node 错误、保存
 * 回退旧缓存——颜色文字同样存不下来。
 */
export function remarkTextColor(this: {
  data(): Record<string, unknown>;
}) {
  const data = this.data() as Record<string, unknown[]>;
  const extensions = data.toMarkdownExtensions || (data.toMarkdownExtensions = []);
  extensions.push({
    handlers: { textColor: handleTextColor },
    // Allow raw `<` inside phrasing content (the span tags) without escaping.
    unsafe: [{ character: "<", inConstruct: "phrasing" }],
  });

  return (tree: unknown) => {
    walk(tree as unknown as MdastNode);
  };
}
