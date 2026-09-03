// wikiLink 的 Milkdown 插件束（v4.7 知识功能）：atom inline node schema +
// $remark（lib/remarkWikiLink 的 native 模式）+ 输入规则 + 点击跳转 prose 插件。
//
// 注册（useMilkdown，crepe.editor.use，无条件——保持 remark 插件数恒定，
// 哨兵见 lib/remarkPipeline）：
//   crepe.editor.use(createWikiLinkPlugins())
// 「打开目标」回调经模块级 wikiLinkOpenRef 注入（App 挂载时写入）——编辑器
// 每次重建重新执行工厂，getter 恒读到最新回调。

import type { MilkdownPlugin } from "@milkdown/ctx";
import { InputRule } from "@milkdown/prose/inputrules";
import type { Node as PMNode } from "@milkdown/prose/model";
import { Plugin, PluginKey, TextSelection } from "@milkdown/prose/state";
import { $inputRule, $nodeSchema, $prose, $remark } from "@milkdown/utils";
import { parseWikiLink, remarkWikiLink } from "./remarkWikiLink";

const WIKILINK_ID = "wikiLink";

/// atom inline node：渲染为 <a class="wikilink" data-wikilink="target">。
/// attrs.target / attrs.label；序列化回写 [[target|label]] 原文。
const wikiLinkSchema = $nodeSchema(WIKILINK_ID, () => ({
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  marks: "",
  attrs: {
    target: { default: "", validate: "string" },
    label: { default: "", validate: "string" },
  },
  parseDOM: [
    {
      tag: "a[data-wikilink]",
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        return {
          target: dom.getAttribute("data-wikilink") ?? "",
          label: dom.textContent ?? "",
        };
      },
    },
  ],
  toDOM: (node: PMNode) => {
    const attrs = node.attrs as { target: string; label: string };
    return [
      "a",
      {
        class: "wikilink",
        "data-wikilink": attrs.target,
        title: `[[${attrs.target}]]`,
      },
      attrs.label || attrs.target,
    ];
  },
  parseMarkdown: {
    match: (node) => (node as unknown as { type?: string }).type === "wikiLink",
    runner: (state, node, type) => {
      const n = node as unknown as { target?: unknown; label?: unknown };
      state.addNode(type, {
        target: String(n.target ?? ""),
        label: String(n.label ?? ""),
      });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === WIKILINK_ID,
    runner: (state, node) => {
      const attrs = node.attrs as { target: string; label: string };
      state.addNode("wikiLink", [], undefined, {
        target: attrs.target,
        label: attrs.label,
      });
    },
  },
}));

/// remark 接线（native 模式：text → wikiLink mdast 节点 + 序列化回写）。
const wikiLinkRemark = $remark("remarkWikiLink", () => remarkWikiLink as never);

/// 输入规则：打完 `[[target|label]]`（第二个 ] 落键）即时替换为节点——
/// 与 preset-commonmark 的 image input rule 同款（否则纯文本要等重开文件
/// 才会变成 chip）。
const wikiLinkInputRule = $inputRule((ctx) =>
  new InputRule(/\[\[([^[\]\n]+)\]\]$/, (state, match, start, end) => {
    const parsed = parseWikiLink(match[1]);
    if (!parsed) return null;
    const node = wikiLinkSchema.type(ctx).create(parsed);
    if (!node) return null;
    return state.tr.replaceWith(start, end, node);
  })
);

export const wikiLinkClickKey = new PluginKey("WIKILINK_CLICK");

/**
 * 「打开目标」回调的进程级挂点：App 挂载时写入（resolveWikiTarget 消歧
 * 与跳转都在 App 侧）。编辑器插件经 getter 延迟读取，重建不失效。
 */
export const wikiLinkOpenRef: {
  current: ((target: string, label: string) => void) | null;
} = { current: null };

/// 点击跳转：handleClickOn 命中 atom 节点时把 target 交给回调。
/// 返回 true 吞掉默认 click（防止把光标塞进 atom 内部）。
function createWikiLinkClickPlugin(): Plugin {
  return new Plugin({
    key: wikiLinkClickKey,
    props: {
      handleClickOn: (view, _pos, node, _nodePos, event) => {
        if (node.type.name !== WIKILINK_ID) return false;
        const el = (event.target as HTMLElement | null)?.closest?.("a[data-wikilink]");
        if (!el) return false;
        view.focus();
        // 点击后光标落在 atom 节点后（对齐 PM 对不可选 atom 的默认行为）。
        const { to } = view.state.selection;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, to)));
        try {
          wikiLinkOpenRef.current?.(String(node.attrs.target ?? ""), String(node.attrs.label ?? ""));
        } catch {
          /* 跳转失败不影响编辑 */
        }
        return true;
      },
    },
  });
}

/** 组装插件束（remark 在前、schema 次之、input rule / prose 末）。 */
export function createWikiLinkPlugins(): MilkdownPlugin[] {
  return [
    wikiLinkRemark,
    wikiLinkSchema,
    wikiLinkInputRule,
    $prose(() => createWikiLinkClickPlugin()),
  ].flat() as unknown as MilkdownPlugin[];
}
