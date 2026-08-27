// 数学定界符归一化（v4.6）：把 LaTeX 风格 `\( ... \)` / `\[ ... \]` 转换为
// remark-math 认识的 `$ ... $` / `$$ ... $$`。
//
// 两个消费方：
//   * 静态渲染管线（lib/renderMarkdown.ts）——AI 回复 / 批注预览在解析前过
//     一遍，同时把 Milkdown 批注往返产生的 `\$` 转义还原（unescapeDollar:
//     true）。它同时是渲染缓存键的一部分，两处必须一致。
//   * 编辑器整篇载入（useMilkdown 的 loadMarkdownFull / setValue 非载入分
//     支）——`unescapeDollar: false`：文件里作者写的 `\$` 是字面美元，不能
//     被误转成定界符。载入后 ProseMirror 序列化自然回写 `$` 风格（v4.6 既
//     定策略：打开含 \( 的文档并保存，定界符统一为美元风格）。
//
// 围栏代码 / 行内代码始终跳过——演示 LaTeX 语法的样例必须保持字面。

export interface NormalizeMathOptions {
  /**
   * true 时把 `\$` 还原为 `$`（静态管线的批注往返场景）；false 时保留
   * `\$` 字面（编辑器载入磁盘文件场景）。默认 false。
   */
  unescapeDollar?: boolean;
}

// 是否包含 LaTeX 风格定界符的快速探测——绝大多数文档一个字符都不含，直接
// 跳过整篇正则扫描（大文档上这趟扫描是 O(n) 的纯开销）。
const LATEX_DELIM_PROBE = /\\[([\]($]/;

/**
 * 归一化数学定界符。单趟从左到右：匹配围栏代码、行内代码、一对数学定界符
 * 或转义美元；只改写数学对/转义美元，代码原样返回。内容做了 trim，保证不会
 * 产生 `$ x $`（$ 后紧跟空格会被 remark-math 拒绝）。
 *
 * 幂等：已归一化的文本再跑一遍结果不变（`$` 定界符不在匹配集里）。
 */
export function normalizeMathDelimiters(
  md: string,
  options: NormalizeMathOptions = {}
): string {
  if (!md || !LATEX_DELIM_PROBE.test(md)) return md;
  const unescapeDollar = options.unescapeDollar === true;
  return md.replace(
    /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\\\$/g,
    (match, blockBody: string | undefined, inlineBody: string | undefined) => {
      if (blockBody !== undefined) return `$$${blockBody.trim()}$$`;
      if (inlineBody !== undefined) return `$${inlineBody.trim()}$`;
      if (unescapeDollar && match === "\\$") return "$";
      return match; // fenced/inline code（或未开启还原的 \$）——保持原样
    },
  );
}
