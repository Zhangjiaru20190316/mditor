// ```math 围栏代码块 → 展示公式（v4.6）。
//
// remark-math 6 只认 $ / $$ 定界符，GitHub 风格的 ```math 围栏会被解析成
// 普通 code 节点。本插件在树层面把 `code(lang=math)` 改写为 `math` 节点
// （remark-math 的展示公式节点形态，value 即公式源码），后续 rehype-katex
// 照常渲染。
//
// ```latex 不动——那是「展示 LaTeX 代码」的语义（代码示例），不是公式。
//
// 只用于静态管线（renderMarkdown.ts）。编辑器侧的等价转换见
// useMilkdown 注册的 codeFenceMathToLatex（code(lang=math) → lang=LaTeX，
// 直接产出 Crepe 认的代码块形态）。

interface MdastNode {
  type?: string;
  value?: string;
  lang?: string | null;
  meta?: string | null;
  children?: MdastNode[];
  data?: Record<string, unknown> | null;
  [key: string]: unknown;
}

function fenceMathToMathNode(node: MdastNode): void {
  const kids = node.children;
  if (!kids) return;
  for (const child of kids) {
    if (
      child.type === "code" &&
      typeof child.value === "string" &&
      typeof child.lang === "string" &&
      child.lang.trim().toLowerCase() === "math"
    ) {
      // 复刻 mdast-util-math 的 math 节点形态：mdast→hast 映射不读 type，
      // 而是读 node.data（hName=pre + hChildren=[code.language-math.
      // math-display>text]），rehype-katex 再吃这个 hast code 的文本。
      // 缺了 data 结构整个节点会在 remark-rehype 处被丢弃。
      const value = child.value;
      child.type = "math";
      child.lang = null;
      child.meta = null;
      child.data = {
        hName: "pre",
        hChildren: [
          {
            type: "element",
            tagName: "code",
            properties: { className: ["language-math", "math-display"] },
            children: [{ type: "text", value }],
          },
        ],
      };
    } else {
      fenceMathToMathNode(child);
    }
  }
}

/**
 * The unified plugin. Register with `.use(remarkMathFence as Plugin)`（静态
 * 管线惯例，同 remarkMark）。必须在 remarkMathNumbering 之前注册。
 */
export function remarkMathFence(this: unknown): (tree: unknown) => void {
  return (tree: unknown) => {
    fenceMathToMathNode(tree as MdastNode);
  };
}
