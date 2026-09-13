// remarkMathGuard（v4.10.1）的行为锚点：remark-math v6 宽松单美元定界在正
// 文里把两个无关 `$`（金额 / 价格区间）误配成 inlineMath，渲染出 KaTeX 乱码。
// 这里锁定「降级规则只打掉非法形态、合法公式不受影响」的边界，防止后续
// remark-math 升级改变定界语义时静默回归。
//
// 管线与三条消费链一致：remarkParse → remarkMath → remarkMathGuard。
// （renderMarkdown / remarkPipeline / useMilkdown 三处同一注册序。）
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import { remarkMathGuard } from "./remarkMathGuard";

interface N {
  type?: string;
  value?: string;
  children?: N[];
  [k: string]: unknown;
}

const proc = unified()
  .use(remarkParse)
  .use(remarkMath)
  .use(remarkMathGuard as never);

function parse(md: string): N {
  return proc.runSync(proc.parse(md), md) as N;
}

/** 段落内联序（type 或 `text:value` 形态），用于断言降级后的段落内容。 */
function inlineSeq(md: string): string[] {
  const tree = parse(md);
  const para = (tree.children ?? []).find((c) => c.type === "paragraph") as
    | N
    | undefined;
  expect(para).toBeDefined();
  return (para?.children ?? []).map((c) =>
    c.type === "text" ? `text:${c.value}` : (c.type as string)
  );
}

describe("remarkMathGuard（宽松定界假公式降级）", () => {
  it("货币对：`价格是 $100，优惠 $50` 内容尾随空白 → 降级回文本", () => {
    // remark-math v6 把 `$100，优惠 $` 误配为 inlineMath("100，优惠 ")，
    // guard 必须把它降级回原文字面（文本节点 ` $100，优惠 $`，后续 `50`
    // 落在独立文本节点）。
    const seq = inlineSeq("价格是 $100，优惠 $50 元");
    expect(seq).not.toContain("inlineMath");
    expect(seq).toContain("text:$100，优惠 $");
  });

  it("价格区间：`范围 $1-$10 之间` 闭 $ 后跟数字 → 降级回文本", () => {
    const seq = inlineSeq("范围 $1-$10 之间");
    expect(seq).not.toContain("inlineMath");
  });

  it("合法行内公式 `$x^2$` 不降级", () => {
    expect(inlineSeq("公式 $x^2$ 保持")).toContain("inlineMath");
  });

  it("合法行内公式（数字内容）`$100$` 不降级——与 GitHub 行为一致", () => {
    // `$100$` 是「合法形态」的公式：首尾无空白、闭 $ 后无数字。语法层
    // 无法区分货币与公式，按 GitHub 语义渲染为公式。
    expect(inlineSeq("值 $100$ 整")).toContain("inlineMath");
  });

  it("首部空白的 `$ a$` 形态降级", () => {
    expect(inlineSeq("a $ b$ c")).not.toContain("inlineMath");
  });

  it("降级只包回原字面（往返稳定）：文本节点拼接 == 原文", () => {
    // 降级产物 `$100，优惠 $` + `50` 拼回原 markdown——不丢字符、不改写内容，
    // 序列化再解析同结果（幂等）。
    const para = (parse("价格是 $100，优惠 $50").children ?? []).find(
      (c) => c.type === "paragraph"
    ) as N | undefined;
    const text = (para?.children ?? [])
      .map((c) => (c.type === "text" ? (c.value ?? "") : ""))
      .join("");
    expect(text).toBe("价格是 $100，优惠 $50");
  });

  it("块级 `$$...$$` 公式不受 guard 影响", () => {
    const tree = parse("$$\nE=mc^2\n$$");
    expect((tree.children ?? [])[0]?.type).toBe("math");
  });

  it("无 `$` 文档零开销通过（树不变）", () => {
    expect(inlineSeq("普通文本，没有美元符号。")[0]).toBe(
      "text:普通文本，没有美元符号。"
    );
  });
});
