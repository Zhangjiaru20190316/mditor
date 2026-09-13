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
//
// 误伤防护（v4.10.1）——LaTeX 风格定界符与「markdown 转义字符」形态相同，
// 三类常见的人写转义不改写：
//   1. `a\[1\]` / `S\[0\]`：`\[` 前紧邻 ASCII 字母数字——作者转义方括号
//      （数组下标等），转了就变成行内夹在文字里的 `$$1$$` 假公式。真公式
//      的 `\[` 前面是空白 / 行首 / 标点（CJK 后直接跟 `\[` 仍视为公式）。
//   2. `\[文字\]\(链接\)`：`\]` 后紧跟 `\(`——转义 markdown 链接语法的整对
//      写法，两者都必须保持字面（改成 $$..$$ / $..$ 双重乱码）。
//   3. `[文字]\(链接\)`：`\(` 前紧邻 `]`（`\]` 或 `]`）——上一条的未转义
//      方括号变体，CommonMark 里转义括号就是字面括号。

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

/** `\[` 前紧邻 ASCII 字母数字 → 视为转义方括号而非公式定界符（见头部注释 1）。 */
const ALNUM_BEFORE = /[A-Za-z0-9]$/;

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
    (match, blockBody: string | undefined, inlineBody: string | undefined, offset: number, whole: string) => {
      if (blockBody !== undefined) {
        // 误伤防护 1：`a\[1\]` 的转义方括号；防护 2：`\]` 后紧跟 `\(`。
        if (offset > 0 && ALNUM_BEFORE.test(whole[offset - 1])) {
          return match;
        }
        if (whole.startsWith("\\(", offset + match.length)) return match;
        return `$$${blockBody.trim()}$$`;
      }
      if (inlineBody !== undefined) {
        // 误伤防护 2/3：`\(` 前是 `]`（`\]` 或 `]`）——转义链接语法后半段。
        if (offset > 0 && whole[offset - 1] === "]") return match;
        return `$${inlineBody.trim()}$`;
      }
      if (unescapeDollar && match === "\\$") return "$";
      return match; // fenced/inline code（或未开启还原的 \$）——保持原样
    },
  );
}
