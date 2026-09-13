// 行内公式定界降级（v4.10.1）：remark-math v6 把单美元定界当码元区间语义
// 解析——内容允许任意空白，导致正文里两个无关的 `$`（金额、价格区间）被
// 误配成行内公式，渲染出一截 KaTeX 乱码（「公式渲染出错」的高频来源）：
//
//     价格是 $100，优惠 $50   →  inlineMath("100，优惠 ")
//     范围 $1-$10 之间         →  inlineMath("1-")
//
// GitHub / Obsidian / Typora 的行内公式都拒绝这两种形态。本变换在树层面
// 把「不合法」的 inlineMath 节点降级回文本（`$原文$`），两条规则与
// cmark-gfm 的 dollar_math 对齐：
//
//   1. 内容首尾是空白（开 `$` 后 / 闭 `$` 前不能是空白）；
//   2. 闭 `$` 后紧跟数字（价格区间 `$1-$10`）。
//
// 只降级、不改写内容：序列化回 markdown 时原样输出 `$100，优惠 $`，往返稳定
// （再解析再降级，同一结果）。块级 `math`（`$$`）不降级——双美元无歧义。
//
// 消费方（与 remarkMathFenceAlias 同一约束——不得 import @milkdown/*，
// worker 复刻管线共用）：
//   * 静态渲染管线（lib/renderMarkdown.ts）；
//   * worker 复刻管线（lib/remarkPipeline.ts）；
//   * 编辑器 $remark 注册（useMilkdown 的 mathRemarkPlugins）。
// 三处都与 Latex 特性同开同关（big 档无 remark-math，也就没有 inlineMath 可降级）。

interface MdastNode {
  type?: string;
  value?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

/** 闭 `$` 后紧跟的字符（下一个文本兄弟节点的首字符）是数字 → 价格区间形态。 */
function followedByDigit(siblings: MdastNode[] | undefined, index: number): boolean {
  const next = siblings?.[index + 1];
  if (!next || next.type !== "text" || typeof next.value !== "string") return false;
  return next.value.length > 0 && next.value[0] >= "0" && next.value[0] <= "9";
}

function demoteSuspiciousInlineMath(node: MdastNode): void {
  const kids = node.children;
  if (!kids) return;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (child.type === "inlineMath") {
      const v = typeof child.value === "string" ? child.value : "";
      if (v !== v.trim() || followedByDigit(kids, i)) {
        // 降级为文本节点：内容原样包回 `$…$`（码元区间不含定界符本身）。
        kids[i] = { type: "text", value: `$${v}$` };
        continue; // 降级产物不再递归
      }
    }
    demoteSuspiciousInlineMath(child);
  }
}

/**
 * The unified plugin（worker 与编辑器共用）。Register with
 * `.use(remarkMathGuard as Plugin)` 或经 $remark 包装进 Milkdown。
 * 必须与 remark-math 同链使用（无 math 语法时树里没有 inlineMath，零开销）。
 */
export function remarkMathGuard(this: unknown): (tree: unknown) => void {
  return (tree: unknown) => {
    demoteSuspiciousInlineMath(tree as MdastNode);
  };
}
