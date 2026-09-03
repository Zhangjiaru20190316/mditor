// citation 的 Milkdown 插件束（模块 3）：atom inline node schema + $remark
// （lib/remarkCitation 的 native 模式）+ 输入规则 + 「参考文献」标题下的
// 自动生成 widget（编辑器内直接可见——正文引用 chip 显示作者-年份形态，
// 编号形态由静态渲染/导出统一处理，见 docs/research-features.md）。
//
// 注册（useMilkdown，无条件——保持 remark 插件数恒定，哨兵见
// lib/remarkPipeline）：
//   crepe.editor.use(createCitationPlugins())
// 文献数据经 lib/bibliography 模块单例同步读取；异步加载完成后由插件的
// view 订阅派发空事务，触发 widget 重建。

import type { MilkdownPlugin } from "@milkdown/ctx";
import { InputRule } from "@milkdown/prose/inputrules";
import { Plugin, PluginKey } from "@milkdown/prose/state";
import type { EditorState } from "@milkdown/prose/state";
import type { Node as PMNode } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import { $inputRule, $nodeSchema, $prose, $remark } from "@milkdown/utils";
import { parseCitationInner, buildReferences, formatInlineCitation, isReferencesHeadingText } from "./citation";
import { remarkCitation } from "./remarkCitation";
import { bibliography } from "./bibliography";

const CITATION_ID = "citation";

/// atom inline node：渲染为 <span class="citation" data-citation="k1;k2">。
/// 序列化回写 raw 原文（[@k1; k2, p. 12]）。
const citationSchema = $nodeSchema(CITATION_ID, () => ({
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  marks: "",
  attrs: {
    raw: { default: "", validate: "string" },
    keys: { default: [] as string[], validate: "array<string>" },
    locator: { default: "", validate: "string" },
  },
  parseDOM: [
    {
      tag: "span[data-citation]",
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        const keys = (dom.getAttribute("data-citation") ?? "")
          .split(";")
          .map((k) => k.trim())
          .filter(Boolean);
        if (keys.length === 0) return false;
        const locator = dom.getAttribute("data-locator") ?? "";
        return {
          raw: `[@${keys.join("; ")}${locator ? `, ${locator}` : ""}]`,
          keys,
          locator,
        };
      },
    },
  ],
  toDOM: (node: PMNode) => {
    const attrs = node.attrs as { raw: string; keys: string[]; locator: string };
    const entries = bibliography.all();
    // 编辑器 chip 统一显示作者-年份形态（编号依赖全文序，留给静态渲染/导出）。
    const display = entries.length
      ? formatInlineCitation(entries, attrs.keys, attrs.locator, "author-year", new Map())
      : attrs.raw;
    const first = entries.length ? bibliography.get(attrs.keys[0] ?? "") : null;
    const tooltip = first
      ? buildReferences(entries, attrs.keys, "author-year")
          .map((r) => r.text)
          .join("\n")
      : attrs.raw;
    return [
      "span",
      {
        class: "citation",
        "data-citation": attrs.keys.join(";"),
        "data-locator": attrs.locator,
        title: tooltip || undefined,
      },
      display,
    ];
  },
  parseMarkdown: {
    match: (node) => (node as unknown as { type?: string }).type === "citation",
    runner: (state, node, type) => {
      const n = node as unknown as { raw?: unknown; keys?: unknown; locator?: unknown };
      const keys = Array.isArray(n.keys) ? (n.keys as string[]).map(String) : [];
      state.addNode(type, {
        raw: String(n.raw ?? ""),
        keys,
        locator: String(n.locator ?? ""),
      });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === CITATION_ID,
    runner: (state, node) => {
      const attrs = node.attrs as { raw: string; keys: string[]; locator: string };
      state.addNode("citation", [], undefined, {
        raw: attrs.raw,
        keys: attrs.keys,
        locator: attrs.locator,
      });
    },
  },
}));

/// remark 接线（native 模式：text → citation mdast 节点 + 序列化回写）。
const citationRemark = $remark("remarkCitation", () => remarkCitation as never);

/// 输入规则：打完 `[@key]`（] 落键）即时替换为节点（同 wikiLink 的即时性）。
const citationInputRule = $inputRule((ctx) =>
  new InputRule(/\[(@[^[\]\n]+)\]$/, (state, match, start, end) => {
    const parsed = parseCitationInner(match[1]);
    if (!parsed) return null;
    const node = citationSchema.type(ctx).create({
      raw: match[0],
      keys: parsed.keys,
      locator: parsed.locator,
    });
    if (!node) return null;
    return state.tr.replaceWith(start, end, node);
  })
);

export const citationRefsWidgetKey = new PluginKey("CITATION_REFS_WIDGET");

interface RefsWidgetState {
  deco: DecorationSet | null;
  bibVersion: number;
}

/** 「参考文献」标题下追加 widget：自动生成的文献表（只读展示，不进文档）。 */
function buildRefsDecoration(state: EditorState): DecorationSet | null {
  const entries = bibliography.all();
  if (entries.length === 0) return null;
  let widgetPos: number | null = null;
  state.doc.descendants((node: PMNode, pos: number) => {
    if (widgetPos !== null) return false;
    if (node.type.name !== "heading") return true;
    if ((node.attrs.level ?? 6) > 2) return true;
    if (isReferencesHeadingText(node.textContent)) {
      widgetPos = pos + node.nodeSize;
      return false;
    }
    return true;
  });
  if (widgetPos === null) return null;
  const pos = widgetPos;
  return DecorationSet.create(state.doc, [
    Decoration.widget(pos, () => buildRefsDom(state), {
      side: -1,
      key: `refs-${bibliography.version}`,
      ignoreSelection: true,
    }),
  ]);
}

function buildRefsDom(state: EditorState): HTMLElement {
  const host = document.createElement("div");
  host.className = "md-refs-widget";
  host.contentEditable = "false";
  const keysInOrder: string[] = [];
  state.doc.descendants((node: PMNode) => {
    if (node.type.name === CITATION_ID) {
      const attrs = node.attrs as { keys?: string[] };
      for (const k of attrs.keys ?? []) keysInOrder.push(k);
    }
    return true;
  });
  const refs = buildReferences(bibliography.all(), keysInOrder, bibliography.getStyle());
  const note = document.createElement("div");
  note.className = "md-refs-widget-note";
  note.textContent =
    refs.length > 0
      ? `由文献库自动生成（${refs.length} 条，${bibliography.getStyle() === "numeric" ? "编号" : "作者-年份"}样式）`
      : "文献库中未解析到本文引用的条目";
  host.appendChild(note);
  if (refs.length > 0) {
    const ol = document.createElement("ol");
    ol.className = "md-refs-widget-list";
    for (const r of refs) {
      const li = document.createElement("li");
      li.textContent = r.text;
      ol.appendChild(li);
    }
    host.appendChild(ol);
  }
  return host;
}

function createCitationRefsPlugin(): Plugin {
  return new Plugin({
    key: citationRefsWidgetKey,
    state: {
      init: (_: unknown, state: EditorState): RefsWidgetState => ({
        deco: buildRefsDecoration(state),
        bibVersion: bibliography.version,
      }),
      apply: (tr, prev: RefsWidgetState, _oldState, newState): RefsWidgetState => {
        if (!tr.docChanged && prev.bibVersion === bibliography.version) return prev;
        return { deco: buildRefsDecoration(newState), bibVersion: bibliography.version };
      },
    },
    props: {
      decorations: (state: EditorState) =>
        (citationRefsWidgetKey.getState(state) as RefsWidgetState | undefined)?.deco ?? null,
    },
    // 文献库异步加载/样式变更后派发空事务，触发 apply 重建 widget。
    view: (view: EditorView) => {
      const unsub = bibliography.subscribe(() => {
        view.dispatch(view.state.tr);
      });
      return { destroy: () => unsub() };
    },
  });
}

/** 组装插件束（remark 在前、schema 次之、input rule / prose 末）。 */
export function createCitationPlugins(): MilkdownPlugin[] {
  return [
    citationRemark,
    citationSchema,
    citationInputRule,
    $prose(() => createCitationRefsPlugin()),
  ].flat() as unknown as MilkdownPlugin[];
}
