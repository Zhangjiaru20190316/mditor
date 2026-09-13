import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import { renderMarkdown } from "./renderMarkdown";

// Typora/Obsidian 式 `$$` 块语义回归（v4.12.2，patch micromark-extension-math
// math-flow）。用户真实文档（Typora/AI 生成）大量使用「开行 `$$` 后跟内容、
// 行尾 `$$` 闭合」的贴邻形态；上游只认「`$$` 独占开闭行」的 fence 形态，贴邻
// 形态会把首行内容当 fence meta 丢弃、永不闭合、吞掉后续所有行（图片/正文
// 全部进公式节点 → 「图片不显示 + 公式红字」双症状）。单行独立 `$$x$$` 此前
// 落到 text tokenizer 成为 inlineMath，`\tag` 直接 KaTeX 报错。以下用例锁死
// 补丁行为；任何 micromark-extension-math / remark-math 升级导致漂移都应先
// 在这里红。

interface N {
  type?: string;
  value?: string;
  children?: N[];
  [k: string]: unknown;
}

function parse(md: string): N {
  return (unified().use(remarkParse).use(remarkMath) as never as {
    parse: (s: string) => N;
  }).parse(md);
}

function collect(node: N, type: string): N[] {
  const out: N[] = [];
  const walk = (n: N) => {
    if (n.type === type) out.push(n);
    (n.children ?? []).forEach(walk);
  };
  walk(node);
  return out;
}

const BS = String.fromCharCode(92);

describe("Typora $$ 块（math-flow patch）", () => {
  it("多行贴邻块：完整 value（首行不丢）、闭合行文本进公式、后续图片存活", () => {
    const md = [
      `$$u(t)=${BS}begin{cases}0, & t<0${BS}${BS} 1, & t>0${BS}end{cases}${BS}qquad`,
      `u(t-t_0)=${BS}begin{cases}0, & t<t_0${BS}${BS} 1, & t>t_0${BS}end{cases}$$`,
      "",
      "![图](assets/figures/fig.png)",
    ].join("\n");
    const tree = parse(md);
    const maths = collect(tree, "math");
    expect(maths).toHaveLength(1);
    expect(maths[0].value).toBe(
      `u(t)=${BS}begin{cases}0, & t<0${BS}${BS} 1, & t>0${BS}end{cases}${BS}qquad\n` +
        `u(t-t_0)=${BS}begin{cases}0, & t<t_0${BS}${BS} 1, & t>t_0${BS}end{cases}`
    );
    // 图片必须是公式的兄弟节点（补丁前被吞进 math value）。
    expect(collect(tree, "image")).toHaveLength(1);
    expect(collect(tree, "inlineMath")).toHaveLength(0);
  });

  it("单行独立 $$x$$ 是 display math（含 \\tag 不再红错）", () => {
    const tree = parse(`$$U_{CD} = U_0 ${BS}, L_{CD} ${BS}tag{1}$$`);
    expect(collect(tree, "math")).toHaveLength(1);
    expect(collect(tree, "inlineMath")).toHaveLength(0);
    expect(collect(tree, "math")[0].value).toContain(`${BS}tag{1}`);
  });

  it("经典 fence 形态不受影响", () => {
    const tree = parse("$$\n\\frac{1}{2}\n$$");
    const maths = collect(tree, "math");
    expect(maths).toHaveLength(1);
    expect(maths[0].value).toBe(`${BS}frac{1}{2}`);
  });

  it("段落中的 $$x$$ 保持行内语义（无中断）", () => {
    const tree = parse("前文 $$x$$ 后文");
    expect(collect(tree, "inlineMath")).toHaveLength(1);
    expect(collect(tree, "math")).toHaveLength(0);
  });

  it("未闭合块运行到 EOF 且保留开行内容", () => {
    const tree = parse("$$x = 1\ny = 2\n");
    const maths = collect(tree, "math");
    expect(maths).toHaveLength(1);
    expect(maths[0].value).toBe("x = 1\ny = 2");
  });

  it("闭合行带缩进前缀也识别（列表内 2 空格）", () => {
    const tree = parse("- $$x = 1\n  y = 2$$\n");
    const maths = collect(tree, "math");
    expect(maths).toHaveLength(1);
    expect(maths[0].value).toBe("x = 1\ny = 2");
  });

  it("引用块内的 Typora 块", () => {
    const tree = parse("> $$E=mc^2$$");
    expect(collect(tree, "math")).toHaveLength(1);
    expect(collect(tree, "math")[0].value).toBe("E=mc^2");
  });

  it("单个 $ 在行中段是内容（探测失败整行作内容，块到 EOF）", () => {
    // `a$b$$`：探测在单 $ 处 nok → 整行（含尾 $$）成为内容。文档化局限：
    // display 公式体内的裸单 $ 极罕见；Typora 会闭合成 a$b，这里选择保守。
    const tree = parse("$$a$b$$\n");
    const maths = collect(tree, "math");
    expect(maths).toHaveLength(1);
    expect(maths[0].value).toBe("a$b$$");
  });

  it("空白行在块内是内容换行（不闭合）", () => {
    const tree = parse("$$a\n\nb$$\n");
    const maths = collect(tree, "math");
    expect(maths).toHaveLength(1);
    expect(maths[0].value).toBe("a\n\nb");
  });

  it("静态管线端到端：多行块 + 图片 + \\tag 全渲染、零 katex-error", async () => {
    const md = [
      `$$f(t)=${BS}begin{cases}0, & t<0${BS}${BS} 1, & t>0${BS}end{cases}$$`,
      "",
      "![图](assets/x.png)",
      "",
      "$$E = mc^2 " + BS + "tag{7}$$",
    ].join("\n");
    const html = await renderMarkdown(md);
    expect(html).not.toContain("katex-error");
    expect(html).toContain("katex-display");
    expect((html.match(/<img/g) ?? []).length).toBe(1);
  });
});
