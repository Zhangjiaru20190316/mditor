// `[@citekey]` / `[@citekey, p. 12]` / `[@k1; @k2]` 行内引用的 remark 插件
// （模块 3「学术引用」，v4.7）。
//
// 消费方（与 remarkWikiLink 同款注册契约）：
//   * Milkdown 编辑器 + worker 解析管线（lib/remarkPipeline）：native 模式，
//     text 里的 `[@…]` 拆为 `citation` mdast 节点（raw/keys/locator 属性，
//     PM 侧映射为 atom inline node，见 lib/citationNode.ts）；序列化回写
//     raw 原文（本地闭环）。
//   * 静态渲染管线（lib/renderMarkdown）：render 模式——先用同一正则拆出
//     citation 节点，再按文档出现序编号、经 lib/citation 格式化为纯文本
//     （未解析键保留 `[@key]` 可读降级），最后在 References/参考文献 标题
//     下注入自动生成的参考文献表（铁律 6：导出产物离开本工具仍可读）。
//
// 配置（文献表 + 样式）在 transform 运行时从 lib/bibliography 读取；
// renderMarkdown 的缓存键含 bibliography.signature()，加载完成后即生效。

import {
  assignCitationNumbers,
  buildReferences,
  formatInlineCitation,
  isReferencesHeadingText,
  parseCitationInner,
} from "./citation";
import { bibliography } from "./bibliography";
import { findBibEntry, type BibEntry } from "./bibtex";

interface MdastNode {
  type?: string;
  depth?: number;
  value?: string;
  url?: string;
  children?: MdastNode[];
  raw?: string;
  keys?: string[];
  locator?: string;
  ordered?: boolean;
  spread?: boolean;
  [key: string]: unknown;
}

/** `[@…]` 行内引用（键支持 @ 前缀、`;`/`,` 分隔、尾随定位符）。 */
export const CITATION_RE = /\[@([^[\]\n]+)\]/g;

export interface CitationRemarkOptions {
  /** render = 静态渲染/导出（格式化 + 参考文献表注入）；native = 编辑器闭环。 */
  mode?: "native" | "render";
}

/** native/render 共用：text → [text, citation, text…]（citation 带 children）。 */
function splitCitations(value: string): MdastNode[] {
  if (!value.includes("[@")) return [{ type: "text", value }];
  const out: MdastNode[] = [];
  let last = 0;
  for (const m of value.matchAll(CITATION_RE)) {
    const parsed = parseCitationInner(m[1]);
    if (!parsed) continue;
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    out.push({
      type: "citation",
      raw: m[0],
      keys: parsed.keys,
      locator: parsed.locator,
      children: [{ type: "text", value: m[0] }],
    });
    last = m.index + m[0].length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/** 只替换 children 里的 text 节点（code/inlineCode 的文本在独立节点类型，
 *  永不误伤——同 remarkWikiLink 的 walk 纪律）。 */
function splitTextNodes(node: MdastNode | undefined): void {
  const kids = node?.children;
  if (!kids) return;
  const next: MdastNode[] = [];
  for (const child of kids) {
    if (child.type === "text" && typeof child.value === "string") {
      next.push(...splitCitations(child.value));
    } else {
      splitTextNodes(child);
      next.push(child);
    }
  }
  node.children = next;
}

/** 文档序收集全部 citation 节点。 */
function collectCitations(node: MdastNode, out: MdastNode[]): void {
  const kids = node.children;
  if (!kids) return;
  for (const child of kids) {
    if (child.type === "citation") out.push(child);
    else collectCitations(child, out);
  }
}

function textOf(node: MdastNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

/** References 标题（H1/H2）下注入/替换参考文献表；返回是否改动。
 *  keysInOrder 由调用方在 citation 节点被替换为文本**之前**收集。 */
function injectReferences(root: MdastNode, entries: BibEntry[], keysInOrder: string[]): boolean {
  const kids = root.children;
  if (!kids) return false;
  let idx = -1;
  let depth = 1;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].type !== "heading") continue;
    if (isReferencesHeadingText(textOf(kids[i]))) {
      idx = i;
      depth = kids[i].depth ?? 1;
      break;
    }
  }
  if (idx < 0) return false;

  // 标题与下一同级/更高级标题之间的旧内容全部由生成表替换（显式标记处
  // 「自动生成」语义——用户在标记下手写的占位内容不保留）。
  let end = kids.length;
  for (let i = idx + 1; i < kids.length; i++) {
    if (kids[i].type === "heading" && (kids[i].depth ?? 1) <= depth) {
      end = i;
      break;
    }
  }
  const refs = buildReferences(entries, keysInOrder, bibliography.getStyle());
  const listItems: MdastNode[] = refs.map((r) => ({
    type: "listItem",
    spread: false,
    children: [
      {
        type: "paragraph",
        children: [
          {
            type: "text",
            value: r.number !== null ? `[${r.number}] ${r.text}` : r.text,
          },
        ],
      },
    ],
  }));
  const list: MdastNode =
    listItems.length > 0
      ? { type: "list", ordered: false, spread: false, children: listItems }
      : {
          type: "paragraph",
          children: [{ type: "text", value: "（未解析到文献条目）" }],
        };
  root.children = [...kids.slice(0, idx + 1), list, ...kids.slice(end)];
  return true;
}

/**
 * unified 插件。注册惯例同 remarkWikiLink：`.use(remarkCitation as Plugin)` /
 * Milkdown `$remark("remarkCitation", () => remarkCitation as never)`（零参
 * 调用 = native 模式）；静态管线 `.use(remarkCitation, { mode: "render" })`。
 */
export function remarkCitation(this: { data(): Record<string, unknown> }, opts?: CitationRemarkOptions) {
  const mode = opts?.mode ?? "native";

  // 序列化（仅 native 闭环）：citation 节点 → raw 原文。
  if (mode === "native") {
    const data = this.data() as Record<string, unknown[]>;
    const extensions = data.toMarkdownExtensions || (data.toMarkdownExtensions = []);
    extensions.push({
      handlers: {
        citation: (node: MdastNode) => String(node.raw ?? ""),
      },
    });
  }

  return (tree: unknown) => {
    const root = tree as MdastNode;
    splitTextNodes(root);
    if (mode !== "render") return;

    // render：编号 → 格式化为纯文本 → 参考文献表注入。
    const entries = bibliography.all();
    const cites: MdastNode[] = [];
    collectCitations(root, cites);
    const keysInOrder: string[] = [];
    for (const c of cites) for (const k of c.keys ?? []) keysInOrder.push(k);
    // 编号只发给可解析键（未解析键保留键名文本，不占号——bib 内容变化时
    // 已解析键的编号保持稳定）。
    const numbers = assignCitationNumbers(
      keysInOrder.filter((k) => findBibEntry(entries, k) !== null)
    );
    const style = bibliography.getStyle();

    // citation 节点 → 纯 text 节点（父层 children 原位替换）。
    const replaceCitations = (node: MdastNode): void => {
      const kids = node.children;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.type === "citation") {
          const e = entries.length
            ? formatInlineCitation(entries, child.keys ?? [], String(child.locator ?? ""), style, numbers)
            : String(child.raw ?? "");
          kids[i] = { type: "text", value: e };
        } else {
          replaceCitations(child);
        }
      }
    };
    replaceCitations(root);

    if (entries.length > 0) injectReferences(root, entries, keysInOrder);
  };
}
