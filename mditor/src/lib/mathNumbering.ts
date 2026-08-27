// 公式编号与引用核心（v4.6）：纯函数，被两条路径共享——
//   * 静态管线（lib/remarkMathNumbering.ts，mdast 层）
//   * 导出路径（lib/exportMath.ts，HTML 字符串层）
//
// KaTeX 不认识 \label / \ref / \eqref（amsmath 概念），只支持手动 \tag{}。
// 这里在渲染前做一次文档级预处理：
//   1. harvest：剥除并收集 \label{key}（不剥则 KaTeX 直接报红），探测显式
//      \tag{...} / \notag / \nonumber；
//   2. assign：按出现顺序给展示公式编号（autoNumber 开启时），显式 \tag 的
//      公式用作者给的编号、不消耗自动序号（amsmath 语义）；
//   3. 解析方把 \ref{key} → 编号文本、\eqref{key} → (编号文本)。
//
// 编辑器内不做实时自动编号（remark 不随键取重跑，编号会过期；注入的 \tag
// 还会被序列化污染文件）——\tag{} 手动编号在编辑器原生可用。

export interface MathMeta {
  /** 剥除 \label 后的公式源码（保持其余内容原样）。 */
  latex: string;
  /** 第一个 \label{key} 的 key；无 label 为 null。 */
  label: string | null;
  /** 是否带显式 \tag{...} / \notag / \nonumber。 */
  hasExplicitTag: boolean;
  /** 显式 \tag 的编号文本（如 "3" 或 "3a"）；无显式 tag 为 null。 */
  explicitTagText: string | null;
}

const LABEL_RE = /\\label\{([^{}]*)\}/g;
const TAG_TEXT_RE = /\\tag\{([^{}]*)\}/;
const NOTAG_RE = /\\(?:notag|nonumber)\b/;

/** 提取公式源码的编号元数据，并返回剥除 \label 后的源码。 */
export function harvestMathMeta(latex: string): MathMeta {
  let label: string | null = null;
  const stripped = latex.replace(LABEL_RE, (_whole: string, key: string) => {
    if (label === null) label = key;
    return "";
  });
  const tagMatch = latex.match(TAG_TEXT_RE);
  return {
    latex: stripped,
    label,
    hasExplicitTag: tagMatch !== null || NOTAG_RE.test(latex),
    explicitTagText: tagMatch ? tagMatch[1] : null,
  };
}

export interface NumberAssignment {
  /**
   * 与 metas 等长的编号表：显式 \tag 公式为其 tag 文本；autoNumber 开启时
   * 自动编号的公式为序号字符串；其余为 null（KaTeX 不加编号）。
   */
  numbers: (string | null)[];
  /** label key → 编号文本（只有拿到编号的 label 进表）。 */
  labelMap: Map<string, string>;
  /** 需要在渲染前注入 `\tag{n}` 的下标集合（= 自动编号的那些）。 */
  autoTagIndexes: Set<number>;
}

/**
 * 给公式列表分配编号。只对「展示公式」调用（行内公式永不编号——调用方负
 * 责只传展示公式；行内公式的 \label 仅剥除、\ref 仅解析）。
 */
export function assignNumbers(
  metas: MathMeta[],
  autoNumber: boolean
): NumberAssignment {
  const numbers: (string | null)[] = new Array(metas.length).fill(null);
  const labelMap = new Map<string, string>();
  const autoTagIndexes = new Set<number>();
  let next = 1;
  for (let i = 0; i < metas.length; i++) {
    const m = metas[i];
    if (m.hasExplicitTag) {
      // \notag/\nonumber：明确不要编号。显式 \tag{t}：用作者的 t，不占序号。
      if (m.explicitTagText !== null) {
        numbers[i] = m.explicitTagText;
        if (m.label !== null) labelMap.set(m.label, m.explicitTagText);
      }
      continue;
    }
    if (autoNumber) {
      const n = String(next++);
      numbers[i] = n;
      autoTagIndexes.add(i);
      if (m.label !== null) labelMap.set(m.label, n);
    }
  }
  return { numbers, labelMap, autoTagIndexes };
}

/** 把自动编号注入公式源码末尾（KaTeX display 模式下渲染为右侧 (n)）。 */
export function injectAutoTag(latex: string, number: string): string {
  return `${latex.replace(/\s+$/, "")} \\tag{${number}}`;
}

const REF_RE = /\\(?:eq)?ref\{([^{}]*)\}/g;

/**
 * 解析公式串（行内或展示）内部的 \ref / \eqref（KaTeX 不认，留着会报红）。
 * 未命中 labelMap 的引用原样保留——作者可能还没写对应公式。
 */
export function resolveRefsInLatex(
  latex: string,
  labelMap: Map<string, string>
): string {
  if (labelMap.size === 0) return latex;
  if (!latex.includes("\\ref") && !latex.includes("\\eqref")) return latex;
  return latex.replace(REF_RE, (whole: string, key: string) => {
    const n = labelMap.get(key);
    if (n === undefined) return whole;
    return whole.startsWith("\\eqref") ? `(${n})` : n;
  });
}
