// ```math 围栏别名（编辑器 + worker 复刻共用，v4.6）。
//
// Crepe 的 Latex 特性只认 `$$...$$`（remark-math 定界符）。GitHub 风格的
// ```math 围栏会被 commonmark 解析成普通 `code` 节点。本插件把
// `code(lang=math)` 的 lang 改写为 `LaTeX`——与 Crepe latex 特性
// remarkMathBlockPlugin 的产物形态一致（lang 大小写不敏感：其 toMarkdown 与
// renderPreview 都按 `language.toLowerCase() === "latex"` 判定），因此直接
// 获得公式块的 KaTeX 预览，且保存时经 blockLatexSchema 序列化回 `$$...$$`
// （v4.6 既定策略：```math 在保存后统一改写为美元定界符）。
//
// 本文件不得 import @milkdown/*——lib/remarkPipeline.ts（worker 侧）会引用
// 这里的纯变换，保持 worker 模块图纯净。编辑器侧的 $remark 包装在
// useMilkdown.ts 内完成。
//
// 与静态管线的 remarkMathFence（lib/remarkMathFence.ts，code(lang=math) →
// math 节点）是同一需求的两条路径实现：静态管线后接 rehype-katex 吃 math
// 节点；编辑器/worker 管线后接 Crepe 的 code-block 承载，吃 lang=LaTeX。

interface MdastNode {
  type?: string;
  lang?: string | null;
  children?: MdastNode[];
  [key: string]: unknown;
}

function fenceMathToLatex(node: MdastNode): void {
  const kids = node.children;
  if (!kids) return;
  for (const child of kids) {
    if (
      child.type === "code" &&
      typeof child.lang === "string" &&
      child.lang.trim().toLowerCase() === "math"
    ) {
      child.lang = "LaTeX";
    } else {
      fenceMathToLatex(child);
    }
  }
}

/**
 * The unified plugin（worker 与编辑器共用）。Register with
 * `.use(remarkMathFenceAlias as Plugin)` 或经 $remark 包装进 Milkdown。
 */
export function remarkMathFenceAlias(this: unknown): (tree: unknown) => void {
  return (tree: unknown) => {
    fenceMathToLatex(tree as MdastNode);
  };
}
