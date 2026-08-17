// Worker 侧的 remark 解析管线（阶段 2）：与 Milkdown 编辑器内部 remarkCtx 处
// 理器**同插件集、同行为**的复刻，跑在后台线程产出结构化 mdast 树（纯 JSON）。
// 主线程拿到树后经 @milkdown/transformer 的 ParserState 做轻量映射
// （mdast → ProseMirror 文档），映射远廉价于 remark 词法分析——这就是
// 「worker 做 remark 结构化，主线程做轻量映射」的降级实现，也是当前架构下
// 风险最低的解耦方式（无需在 worker 复刻 Schema 组装）。
//
// ── 一致性契约（关键！）────────────────────────────────────────────────
// 两端管线必须产出相同的 mdast，否则富文本渲染会与主线程解析路径出现差异。
// 保证手段：
//   1. 两侧引用**同一份 node_modules** 的同一批插件（remark-gfm / remark-math /
//      remark-inline-links / 我们自己的 remarkMark / remarkTextColor）；
//   2. Milkdown 内部自带的两个小变换（commonmark 的 preserve-empty-line、
//      Crepe latex 的 math→code 块化）按源码逐行复刻于下方，并注明出处；
//   3. lib/parsePipeline 在绑定编辑器时对 remarkPluginsCtx 的插件数量做
//      **哨兵校验**（expectedPluginCount）——将来任何人给 Milkdown 注册
//      新的 remark 插件，数量对不上即自动禁用 worker 路径、回退主线程解析，
//      绝不静默分叉。
//
// 插件顺序与 Milkdown 注册序一致（commonmark → gfm → latex → 本应用自定义）；
// 其中词法扩展（gfm/math）参与 tokenize、树变换（inline-links / 空行清理 /
// mark / textColor）彼此作用在不同节点属性上，顺序不敏感。

import { unified } from "unified";
import type { Plugin } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkInlineLinks from "remark-inline-links";
import { remarkMark } from "./remarkMark";
import { remarkTextColor } from "./remarkTextColor";

interface MdastNode {
  type?: string;
  value?: string;
  lang?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

/** 复刻自 @milkdown/preset-commonmark 的 remark-preserve-empty-line 插件：
 *  删除普通段落里由 `<br>` 变成的 html 节点（Milkdown 用 PM 的 hardbreak
 *  语义表示它，mdast 里不允许残留）。 */
function removeEmptyLineBreaks(node: MdastNode): void {
  const kids = node.children;
  if (!kids) return;
  const kept: MdastNode[] = [];
  for (const child of kids) {
    if (
      child.type === "html" &&
      typeof child.value === "string" &&
      ["<br />", "<br>", "<br >", "<br/>"].includes(child.value.trim())
    ) {
      continue;
    }
    removeEmptyLineBreaks(child);
    kept.push(child);
  }
  node.children = kept;
}

/** 复刻自 @milkdown/crepe latex feature 的 remarkMathBlock 插件：
 *  `math` 块节点改写为 lang=LaTeX 的 `code` 节点（由 CodeMirror 代码块承载
 *  并按需经 KaTeX 渲染预览）。 */
function mathBlocksToCode(node: MdastNode): void {
  const kids = node.children;
  if (!kids) return;
  for (const child of kids) {
    if (child.type === "math") {
      child.type = "code";
      child.lang = "LaTeX";
      // value 保留原值（math 节点的 value 即公式源码）。
    } else {
      mathBlocksToCode(child);
    }
  }
}

/** 构建 与编辑器等价的解析处理器。withMath 对应 Crepe 的 Latex 特性位
 *  （大文档模式关闭 latex → 无 remark-math，$$ 解析为普通文本，与编辑器
 *  行为一致）。同一处理器可重复 parse/runSync（unified 冻结只禁止继续
 *  use()，不影响复用——Milkdown 自己的 ParserState 也是这样复用的）。
 *  自定义小变换与 remarkMark/remarkTextColor 的注册沿用 renderMarkdown
 *  管线的 `as Plugin` 惯例（见 lib/remarkMark.ts 的类型说明）。 */
export function buildEditorParseProcessor(withMath: boolean) {
  const stripBr: Plugin = () => (tree) => {
    removeEmptyLineBreaks(tree as MdastNode);
  };
  const mathToCode: Plugin = () => (tree) => {
    mathBlocksToCode(tree as MdastNode);
  };
  const proc = unified()
    .use(remarkParse)
    .use(remarkInlineLinks)
    .use(stripBr)
    .use(remarkGfm);
  if (withMath) proc.use(remarkMath).use(mathToCode);
  return proc.use(remarkMark as unknown as Plugin).use(remarkTextColor as unknown as Plugin);
}

/** 哨兵校验用：Milkdown 实例应注册的 remark 插件总数（不含 parse/stringify
 *  基座）。commonmark(2) + gfm(1) + latex(2, 仅小文档) + 本应用(2)。 */
export function expectedPluginCount(withMath: boolean): number {
  return 2 + 1 + (withMath ? 2 : 0) + 2;
}

/** 解析入口（worker 调用；测试直接调用）。返回结构化 mdast 树。 */
export function parseMarkdownTree(
  proc: ReturnType<typeof buildEditorParseProcessor>,
  markdown: string
): MdastNode {
  const tree = proc.parse(markdown);
  // 与 @milkdown/transformer ParserState.run 相同的调用方式。
  return proc.runSync(tree, markdown) as MdastNode;
}
