// Shared remark plugin for the ==highlight== ("mark") syntax.
//
// Consumed by TWO places:
//   * Milkdown — registered via $remark in lib/highlightMark.ts, so the editor
//     parses `==text==` into a ProseMirror `highlight` mark AND serializes it
//     back to `==text==` on save.
//   * The static render pipeline (lib/renderMarkdown.ts) — so `==text==` renders
//     as <mark> in AI replies, annotation previews, and HTML/PNG/DOCX exports.
//
// PARSE side: a post-parse mdast walk that splits `text` nodes containing
// `==…==` into `mark` wrapper nodes. We deliberately do NOT ship a micromark
// extension (that would add two new deps); the walk is sufficient because code
// spans/blocks keep their text in `code`/`inlineCode` nodes, never `text`, so
// they are never touched. This mirrors how most Typora/Obsidian-style editors
// handle the non-standard `==` syntax.
//
// STRINGIFY side: registers a remark-stringify handler (the strikethrough
// pattern from mdast-util-gfm-strikethrough, with `~` swapped for `=`) so
// Milkdown's doc→markdown serializer emits `==text==`. (The render pipeline
// only ever goes md→html, so this is a harmless no-op there.)

// Markdown constructs where a bare `=` must NOT be treated as a mark delimiter
// during serialization (mirrors mdast-util-gfm-strikethrough's list).
const CONSTRUCTS_WITHOUT_MARK = [
  "autolink",
  "destinationLiteral",
  "destinationRaw",
  "reference",
  "titleQuote",
  "titleApostrophe",
];

interface MdastNode {
  type?: string;
  value?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

// `==content==` → { type:'mark', children:[{type:'text', value:content}] }
// Content cannot contain `=` or a newline, so `===` and multi-line spans are
// left untouched (matches Obsidian/Typora behaviour).
const MARK_RE = /==([^=\n]+?)==/g;

/** Split a text value into a flat list of `text` and `mark` mdast nodes. */
function splitMarks(value: string): MdastNode[] {
  if (!value.includes("==")) return [{ type: "text", value }];
  const out: MdastNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  MARK_RE.lastIndex = 0;
  while ((m = MARK_RE.exec(value))) {
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    out.push({ type: "mark", children: [{ type: "text", value: m[1] }] });
    last = MARK_RE.lastIndex;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/** Recursively rewrite `text` children that contain `==…==` into `mark` nodes. */
function transformMarks(node: MdastNode | undefined): void {
  const kids = node?.children;
  if (!kids) return;
  const next: MdastNode[] = [];
  for (const child of kids) {
    if (child.type === "text" && typeof child.value === "string") {
      next.push(...splitMarks(child.value));
    } else {
      transformMarks(child);
      next.push(child);
    }
  }
  node.children = next;
}

// ---- remark-stringify handler (serialize `mark` → ==content==) -------------
// We avoid importing mdast-util-to-markdown's types (it is a transitive dep,
// not declared in package.json), so the handler is loosely typed and the
// `state` methods we touch match that library's public surface.
type StringifyState = {
  createTracker: (info: unknown) => {
    move: (s: string) => string;
    current: () => Record<string, unknown>;
  };
  enter: (construct: string) => () => void;
  containerPhrasing: (node: MdastNode, opts: unknown) => string;
};

function handleMark(
  node: MdastNode,
  _parent: MdastNode | undefined,
  state: StringifyState,
  info: unknown
): string {
  const tracker = state.createTracker(info);
  const exit = state.enter("mark");
  let value = tracker.move("==");
  value += state.containerPhrasing(node, {
    ...tracker.current(),
    before: value,
    after: "=",
  });
  value += tracker.move("==");
  exit();
  return value;
}

/**
 * The unified plugin. Register with `.use(remarkMark as Plugin)` (render
 * pipeline) or via Milkdown's `$remark` (editor). It wires the stringify
 * handler + the parse transformer in one self-contained unit.
 *
 * Deliberately NOT annotated `: Plugin` — the stringify handler touches
 * mdast-util-to-markdown internals (a transitive dep), so we keep the types
 * loose and cast at the registration sites. `this` is the unified Processor,
 * which provides `data()` for stashing remark-stringify options.
 *
 * 序列化处理器必须挂到 `data.toMarkdownExtensions`（v3.9.7 修复）：remark-
 * stringify v11 的 compiler 只读这一个键（`extensions: self.data('toMarkdown-
 * Extensions') || []`，逐项经 mdast-util-to-markdown 的 configure 合并
 * handlers/unsafe），与 remark-gfm 同款注册路径。旧版写到 `data.toMarkdown`
 * ——没有任何消费者读它，`mark` 节点序列化时落到 unknown handler 直接抛
 * `Cannot handle unknown node 'mark'`，编辑器 getMarkdown() 整体失败回退旧
 * 缓存——「高光存不下来」的根因：解析方向（==x== → mark）一直正常，唯独
 * 保存方向丢标记。
 */
export function remarkMark(this: {
  data(): Record<string, unknown>;
}) {
  const data = this.data() as Record<string, unknown[]>;
  const extensions = data.toMarkdownExtensions || (data.toMarkdownExtensions = []);
  extensions.push({
    handlers: { mark: handleMark },
    unsafe: [
      { character: "=", inConstruct: "phrasing", notInConstruct: CONSTRUCTS_WITHOUT_MARK },
    ],
  });

  return (tree: unknown) => {
    transformMarks(tree as unknown as MdastNode);
  };
}
