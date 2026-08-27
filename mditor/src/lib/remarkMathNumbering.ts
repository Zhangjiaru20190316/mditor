// 公式编号 / \label / \ref 的静态管线适配（v4.6）。
//
// 注册进 renderMarkdown 的 unified 管线（remarkMathFence 之后、rehype 之
// 前），做三件事：
//   1. 所有 math / inlineMath 节点剥除 \label（KaTeX 不认，留着报红）；
//   2. autoNumber 开启时给展示公式（math 节点）按序注入 \tag{n}；
//   3. 行内公式与正文 text 节点里的 \ref{key} / \eqref{key} 解析为编号文本。
//
// 配置在 transform 运行时从 lib/mathConfig 读取（useSettings 同步维护）；
// renderMarkdown 的 processor 缓存按 mathConfigSignature 重建，保证 macros
// 与编号行为随设置即时生效。code / inlineCode 节点永不触碰（演示 \ref 语
// 法的样例保持字面）。

import { getMathRenderConfig } from "./mathConfig";
import {
  assignNumbers,
  harvestMathMeta,
  injectAutoTag,
  resolveRefsInLatex,
} from "./mathNumbering";

interface MdastNode {
  type?: string;
  value?: string;
  children?: MdastNode[];
  data?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * 更新公式源码时同时同步 node.data.hChildren 里的文本——remark-math 生成
 * 的 math/inlineMath 节点在解析期就挂好了 mdast→hast 映射（data.hName +
 * hChildren），remark-rehype 渲染读的是 hChildren 里的文本而非 node.value：
 * 只改 value 会让 rehype-katex 拿到旧源码（\label 未剥 / \tag 未注入）。
 * 兼容两种形态：inlineMath 的 hChildren 直接是文本节点；math 的是
 * pre>code>text（见 mdast-util-math 的 enterMathFlow/enterMathText）。
 */
function setMathValue(node: MdastNode, value: string): void {
  node.value = value;
  const data = node.data as { hChildren?: unknown[] } | null | undefined;
  if (!data || !Array.isArray(data.hChildren)) return;
  for (const raw of data.hChildren) {
    const el = raw as {
      type?: string;
      value?: string;
      children?: Array<{ type?: string; value?: string }>;
    };
    if (el?.type === "text" && typeof el.value === "string") {
      el.value = value;
    } else if (Array.isArray(el?.children)) {
      const text = el.children.find((c) => c.type === "text");
      if (text) text.value = value;
    }
  }
}

/** 收集树里的公式节点（保持文档顺序）。 */
function collectMathNodes(
  node: MdastNode,
  display: MdastNode[],
  inline: MdastNode[]
): void {
  const kids = node.children;
  if (!kids) return;
  for (const child of kids) {
    if (child.type === "math") display.push(child);
    else if (child.type === "inlineMath") inline.push(child);
    else collectMathNodes(child, display, inline);
  }
}

/** 递归替换 text 节点（含行内公式源码）里的 \ref / \eqref。 */
function resolveRefsInTree(node: MdastNode, labelMap: Map<string, string>): void {
  const kids = node.children;
  if (!kids) return;
  for (const child of kids) {
    if (
      (child.type === "text" || child.type === "inlineMath") &&
      typeof child.value === "string"
    ) {
      child.value = resolveRefsInLatex(child.value, labelMap);
    } else if (child.type !== "math") {
      // math 节点的 value 已在主流程处理，不再重复扫描。
      resolveRefsInTree(child, labelMap);
    }
  }
}

/**
 * The unified plugin. Register with `.use(remarkMathNumbering as Plugin)`
 * （静态管线惯例，同 remarkMark）。
 */
export function remarkMathNumbering(this: unknown): (tree: unknown) => void {
  return (tree: unknown) => {
    const root = tree as MdastNode;
    const display: MdastNode[] = [];
    const inline: MdastNode[] = [];
    collectMathNodes(root, display, inline);

    // 行内公式：仅剥 \label（行内公式不参与编号）。
    for (const node of inline) {
      if (typeof node.value === "string") {
        setMathValue(node, harvestMathMeta(node.value).latex);
      }
    }

    const { autoNumber } = getMathRenderConfig();
    const metas = display.map((n) =>
      typeof n.value === "string" ? harvestMathMeta(n.value) : null
    );
    const valid = metas.filter((m): m is NonNullable<typeof m> => m !== null);
    const assignment = assignNumbers(valid, autoNumber);

    let vi = 0;
    for (let i = 0; i < display.length; i++) {
      const node = display[i];
      const meta = metas[i];
      if (meta === null || typeof node.value !== "string") continue;
      let latex = meta.latex;
      if (assignment.autoTagIndexes.has(vi)) {
        latex = injectAutoTag(latex, assignment.numbers[vi] as string);
      }
      setMathValue(node, latex);
      vi++;
    }

    if (assignment.labelMap.size > 0) {
      resolveRefsInTree(root, assignment.labelMap);
    }
  };
}
