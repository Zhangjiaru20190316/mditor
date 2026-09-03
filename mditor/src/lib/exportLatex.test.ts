// LaTeX 导出测试（模块 3）：转义、标题结构、公式平移、引用 → \cite、图表
// 环境、表格 tabular、参考文献 thebibliography、双链/HTML 降级。

import { describe, expect, it, beforeEach } from "vitest";
import { markdownToLatex, texEscape } from "./exportLatex";
import { bibliography } from "./bibliography";

const BIB_TEXT = `
@article{smith2020,
  author = {Smith, John and Lee, Kate},
  title = {A Study of Things},
  journal = {Journal of Examples},
  year = {2020},
  volume = {12},
  pages = {45--67}
}
`;

beforeEach(() => {
  bibliography.loadText("C:/fake/refs.bib", BIB_TEXT);
  bibliography.setStyle("numeric");
});

describe("texEscape", () => {
  it("LaTeX 特殊字符转义", () => {
    expect(texEscape("a & b")).toBe("a \\& b");
    expect(texEscape("100%")).toBe("100\\%");
    expect(texEscape("x_y")).toBe("x\\_y");
    expect(texEscape("a#b$c")).toBe("a\\#b\\$c");
    expect(texEscape("中文不转义")).toBe("中文不转义");
  });
});

describe("markdownToLatex（结构）", () => {
  it("首个 H1 → \\title，其余标题逐级下移", () => {
    const { tex } = markdownToLatex("# 我的论文\n\n## 方法\n\n### 细节\n\n正文\n");
    expect(tex).toContain("\\title{我的论文}");
    expect(tex).toContain("\\section{方法}");
    expect(tex).toContain("\\subsection{细节}");
    expect(tex).not.toContain("\\section{我的论文}");
  });

  it("行内格式：粗体/斜体/删除线/行内代码/链接", () => {
    const { tex } = markdownToLatex(
      "**粗** 与 *斜* 与 ~~删~~ 与 `code` 与 [链](https://x.example)\n"
    );
    expect(tex).toContain("\\textbf{粗}");
    expect(tex).toContain("\\emph{斜}");
    expect(tex).toContain("\\sout{删}");
    expect(tex).toContain("\\verb|code|");
    expect(tex).toContain("\\href{https://x.example}{链}");
  });

  it("公式天然平移：行内 $..$ 与块级 equation", () => {
    const { tex } = markdownToLatex("质能 $E=mc^2$ 如下：\n\n$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$\n");
    expect(tex).toContain("$E=mc^2$");
    expect(tex).toContain("\\begin{equation}");
    expect(tex).toContain("\\int_0^1 x\\,dx");
    // 公式源不被转义。
    expect(tex).not.toContain("\\\\int");
  });

  it("代码块 → verbatim（内容不转义）", () => {
    const { tex } = markdownToLatex("```\nif (a & b) { c }\n```\n");
    expect(tex).toContain("\\begin{verbatim}");
    expect(tex).toContain("if (a & b) { c }");
  });

  it("列表 → itemize / enumerate / 任务列表", () => {
    const { tex } = markdownToLatex("- 甲\n- 乙\n\n1. 一\n2. 二\n\n- [x] 完成\n- [ ] 待办\n");
    expect(tex).toContain("\\begin{itemize}");
    expect(tex).toContain("\\item 甲");
    expect(tex).toContain("\\begin{enumerate}");
    expect(tex).toContain("\\item 一");
    expect(tex).toContain("\\item[$\\blacksquare$] 完成");
    expect(tex).toContain("\\item[$\\square$] 待办");
  });

  it("块引用 → quote，分隔线 → rule，脚注 → \\footnote", () => {
    const { tex } = markdownToLatex("> 引用内容\n\n---\n\n正文[^1]\n\n[^1]: 脚注定义\n");
    expect(tex).toContain("\\begin{quote}");
    expect(tex).toContain("\\rule{\\linewidth}");
    expect(tex).toContain("\\footnote{脚注定义}");
  });
});

describe("markdownToLatex（引用与图表）", () => {
  it("[@key] → \\cite（定位符 → 可选参数；未解析键告警）", () => {
    const { tex, warnings } = markdownToLatex("引用 [@smith2020] 与 [@smith2020, p. 12] 与 [@ghost]。\n");
    expect(tex).toContain("\\cite{smith2020}");
    expect(tex).toContain("\\cite[p.~12]{smith2020}".replace("~", " ") /* locator 原文转义 */);
    expect(warnings.join(" ")).toContain("ghost");
  });

  it("References 标题 → thebibliography（引用序 \\bibitem）", () => {
    const { tex } = markdownToLatex("引 [@smith2020]。\n\n# References\n");
    expect(tex).toContain("\\begin{thebibliography}{99}");
    expect(tex).toContain("\\bibitem{smith2020}");
    expect(tex).toContain("Journal of Examples"); // 出处进表（textit 形态）
    expect(tex).not.toContain("\\section{References}");
  });

  it("图片 + {#fig:id} → figure 环境含 caption/label；@fig 引用 → \\ref", () => {
    const { tex } = markdownToLatex(
      "![实验结果](result.png){#fig:exp}\n\n如 @fig:exp 所示。\n"
    );
    expect(tex).toContain("\\begin{figure}[htbp]");
    expect(tex).toContain("\\includegraphics[width=0.8\\linewidth]{result.png}");
    expect(tex).toContain("\\caption{实验结果}");
    expect(tex).toContain("\\label{fig:exp}");
    expect(tex).toContain("\\ref{fig:exp}");
  });

  it("表格 + `: cap {#tbl:id}` → table/tabular 环境（对齐与 caption）", () => {
    const { tex } = markdownToLatex(
      "| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n\n: 实验对比 {#tbl:cmp}\n"
    );
    expect(tex).toContain("\\begin{table}[htbp]");
    expect(tex).toContain("\\begin{tabular}{lcr}");
    expect(tex).toContain("左 & 中 & 右 \\\\");
    expect(tex).toContain("\\midrule");
    expect(tex).toContain("\\caption{实验对比}");
    expect(tex).toContain("\\label{tbl:cmp}");
    expect(tex).not.toContain(": 实验对比");
  });

  it("无 caption 表格：裸 tabular", () => {
    const { tex } = markdownToLatex("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    expect(tex).toContain("\\begin{tabular}{ll}");
    expect(tex).not.toContain("\\begin{table}");
  });
});

describe("markdownToLatex（语法降级，铁律 6）", () => {
  it("[[双链]] → 纯文本显示名", () => {
    const { tex } = markdownToLatex("见 [[目标笔记|显示名]] 与 [[另一篇]]。\n");
    expect(tex).toContain("显示名");
    expect(tex).toContain("另一篇");
    expect(tex).not.toContain("[[");
  });

  it("原生 HTML 节点剔除", () => {
    const { tex } = markdownToLatex("前\n\n<div>块</div>\n\n后\n");
    expect(tex).not.toContain("<div>");
    expect(tex).toContain("前");
    expect(tex).toContain("后");
  });

  it("特殊字符正文转义", () => {
    const { tex } = markdownToLatex("价格 100% 的 A&B 与 C#D\n");
    expect(tex).toContain("100\\%");
    expect(tex).toContain("A\\&B");
    expect(tex).toContain("C\\#D");
  });

  it("文档骨架可编译形态（preamble + document）", () => {
    const { tex } = markdownToLatex("# T\n\n正文\n");
    expect(tex).toMatch(/^\\documentclass\[UTF8\]\{ctexart\}/);
    expect(tex).toContain("\\usepackage{amsmath,amssymb}");
    expect(tex).toContain("\\usepackage{booktabs}");
    expect(tex).toContain("\\begin{document}");
    expect(tex.trimEnd().endsWith("\\end{document}")).toBe(true);
  });
});
