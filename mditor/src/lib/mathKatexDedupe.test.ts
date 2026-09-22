// v4.17.1 KaTeX 双实例归一（overrides katex=0.18.4）回归守卫。
//
// 背景：npm 树曾同时存在顶层 katex@0.18.4 与两个嵌套 katex@0.16.47
// （rehype-katex / micromark-extension-math 之下），静态管线（renderMarkdown →
// rehype-katex）用 0.16.47 产出旧类名 DOM（strut/base/sizing），而应用只加载
// 0.18.4 的 CSS（katex-strut/katex-base/katex-sizing）——类名镜像互补、整体
// 失配，分数 vlist 结构坍塌（用户截图三症状的机械成因，见
// .workflow/task1-forensics/static-chain.md）。修复：package.json overrides
// 钉 katex=0.18.4 全局单实例。
//
// 本文件锁定两件事，防止错位回归：
//   1. 静态管线产出的 DOM 与所载 CSS 同版本（strut 等结构类名带 katex- 前缀，
//      不存在 0.16.x 旧裸类名），且公式结构健康（无 katex-error、分数线、
//      上下标、∂、撇号俱全）——含用户真实文档（cmc/微分方程专题）摘录块。
//   2. 编辑器载入链（mathNormalize → remark 词法层 → buildEditorParseProcessor
//      全链）对块级公式源串逐字符零改写（复刻 task1 取证 harness，固化）。
// 另含 mhchem 单实例证据用例与 `\=` 现状固化用例（escapedEqDecision：不处理）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import type { Plugin } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkInlineLinks from "remark-inline-links";
// 生产里由 main.tsx side-effect import 的 mhchem——显式引入后若 rehype-katex
// 仍解析到嵌套 katex 实例，\ce 将 ParseError（→ katex-error），A3 用例转红。
// 它因此同时是"全局单实例"的运行时证据（静态断言见 A4 的文件系统检查）。
import "katex/contrib/mhchem";
import { renderMarkdown } from "./renderMarkdown";
import { normalizeMathDelimiters } from "./mathNormalize";
import { buildEditorParseProcessor } from "./remarkPipeline";

// 用户截图中的块级公式（F7）。
const SCREENSHOT_FORMULA = String.raw`\frac{\partial F}{\partial x} = F_1' \cdot 1 + F_2' \cdot y + F_3' \cdot 1`;

// 用户真实文档摘录（E:/笔记/cmc/微分方程专题_CMC备战笔记.md，Typora 双行 $$ 块）。
// 逐字符取自磁盘形态；测试不读外部路径（可移植），出处行号标注备查。
const REAL_DOC_BLOCKS: Array<{ at: string; latex: string }> = [
  {
    // L162-164：分离变量
    at: "微分方程专题_CMC备战笔记.md L163",
    latex: String.raw`y\,dx+(x^2-4x)\,dy=0 \;\Longrightarrow\; \frac{dy}{dx}=-\frac{y}{x^2-4x}=-\frac{y}{x(x-4)}`,
  },
  {
    // L180-182：两边积分（嵌套 \left\lvert frac）
    at: "微分方程专题_CMC备战笔记.md L181",
    latex: String.raw`\ln\lvert y\rvert=\frac{1}{4}\bigl(\ln\lvert x\rvert-\ln\lvert x-4\rvert\bigr)+C_1=\frac{1}{4}\ln\left\lvert\frac{x}{x-4}\right\rvert+C_1`,
  },
  {
    // L222-224：可分离条件（\text 中文 + msupsub 下标）
    at: "微分方程专题_CMC备战笔记.md L223",
    latex: String.raw`\frac{dy}{dx}=p(x)\cdot q(y) \qquad\text{或}\qquad M_1(x)M_2(y)\,dx+N_1(x)N_2(y)\,dy=0`,
  },
];

// 0.18.4 对截图公式的健康结构签名（本文件 A1 的期望值；与取证 F4 实测一致）。
const SIGNATURE_18 = { partial: 4, prime: 6, fracLine: 1, msupsub: 3 };

// 0.16.x 独有的旧结构类名 token（0.18.x 前缀化为 katex-base/katex-strut/
// katex-sizing）。DOM 里任何一个作为独立 class token 出现 = 嵌套 0.16 实例
// 回流、与应用所载 0.18.4 CSS 镜像失配（v4.17.1 修复的结构性缺陷回归）。
const LEGACY_16_CLASSES = ["strut", "base", "sizing"];

/** 提取 HTML 中所有 class 属性的独立 token 集合。 */
function classTokens(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const t of m[1].split(/\s+/)) if (t) out.add(t);
  }
  return out;
}

interface MdastNode {
  type?: string;
  value?: string;
  lang?: string | null;
  children?: MdastNode[];
  [k: string]: unknown;
}

function collect(node: MdastNode, pred: (n: MdastNode) => boolean, out: MdastNode[] = []): MdastNode[] {
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) collect(c, pred, out);
  return out;
}
const mathNodes = (root: MdastNode) => collect(root, (n) => n.type === "math");
const latexCodeNodes = (root: MdastNode) =>
  collect(root, (n) => n.type === "code" && typeof n.lang === "string" && n.lang.toLowerCase() === "latex");

// ---- 编辑器载入链各阶段（复刻 task1 取证 harness；与 remarkPipeline.ts 对应）----

// S2 词法层 = remarkPipeline.ts:104-108 + mathToCode 之前（remarkMath 直后）。
// removeEmptyLineBreaks 复刻 remarkPipeline.ts:50-66（commonmark
// preserve-empty-line 语义）。
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

function buildLexicalProcessor() {
  const stripBr: Plugin = () => (tree) => removeEmptyLineBreaks(tree as MdastNode);
  return unified()
    .use(remarkParse)
    .use(remarkInlineLinks)
    .use(stripBr)
    .use(remarkGfm)
    .use(remarkMath);
}

interface StageTrace {
  s1Mutated: boolean;
  s2Values: string[];
  s3Values: string[];
}

/** 逐阶段追踪块级公式源串：S1 mathNormalize（编辑器模式）→ S2 词法层 math 节点
 *  原始 value → S3 buildEditorParseProcessor(true) 全链后的 code(lang=LaTeX).value
 *  （= 到达 Crepe renderLatex 的 content，crepe/esm/index.js:3438-3445）。 */
function traceEditorChain(mdRaw: string): StageTrace {
  const md1 = normalizeMathDelimiters(mdRaw);
  const s2Root = buildLexicalProcessor().parse(md1);
  const s2 = buildLexicalProcessor().runSync(s2Root, md1) as MdastNode;
  const s3Root = buildEditorParseProcessor(true).parse(md1);
  const s3 = buildEditorParseProcessor(true).runSync(s3Root, md1) as MdastNode;
  return {
    s1Mutated: md1 !== mdRaw,
    s2Values: mathNodes(s2).map((n) => String(n.value ?? "")),
    s3Values: latexCodeNodes(s3).map((n) => String(n.value ?? "")),
  };
}

// ---- Part A：静态管线归一（防再次错位的核心断言）----

describe("mathKatexDedupe: 静态管线 DOM 与所载 CSS 同版本", () => {
  it("A1: 截图公式块级渲染健康且 strut 类名带 katex- 前缀", async () => {
    const html = await renderMarkdown(`$$\n${SCREENSHOT_FORMULA}\n$$\n`);
    expect(html).not.toContain("katex-error");
    expect((html.match(/∂/g) || []).length).toBe(SIGNATURE_18.partial);
    expect((html.match(/′/g) || []).length).toBe(SIGNATURE_18.prime);
    expect((html.match(/frac-line/g) || []).length).toBe(SIGNATURE_18.fracLine);
    expect((html.match(/msupsub/g) || []).length).toBe(SIGNATURE_18.msupsub);
    // 错位防回退核心断言：0.16.x 产裸 strut/base/sizing token，0.18.x 产
    // katex- 前缀版。若出现旧 token = 嵌套 0.16 实例回流，分数结构将对
    // 0.18 CSS 整体失配。
    const tokens = classTokens(html);
    expect(LEGACY_16_CLASSES.filter((c) => tokens.has(c))).toEqual([]);
    expect(tokens.has("katex-strut")).toBe(true);
  });

  it.each(REAL_DOC_BLOCKS.map((b) => [b.at, b.latex] as const))(
    "A2: 真实文档摘录块渲染健康（%s）",
    async (_at, latex) => {
      const html = await renderMarkdown(`$$\n${latex}\n$$\n`);
      expect(html).not.toContain("katex-error");
      expect(html).toContain("frac-line");
      const tokens = classTokens(html);
      expect(LEGACY_16_CLASSES.filter((c) => tokens.has(c))).toEqual([]);
      expect(tokens.has("katex-strut")).toBe(true);
      // 真实块含上下标（C_1 / M_1 等）
      expect(html).toContain("msupsub");
    }
  );

  it("A3: mhchem \\ce 在静态管线渲染成功（单实例运行时证据）", async () => {
    // 生产链：main.tsx 在顶层 katex 实例上注册 mhchem → rehype-katex 消费同一
    // 实例。双实例时代嵌套 0.16.47 无 \ce 宏 → 整条公式 ParseError 红字。
    const html = await renderMarkdown("$\\ce{H2O}$");
    expect(html).not.toContain("katex-error");
    expect(html).toContain("katex");
  });

  it("A4: npm 树中不存在 katex 嵌套副本（文件系统级防错位）", () => {
    const nm = join(import.meta.dirname, "..", "..", "node_modules");
    // overrides 前这两个目录分别持有 katex@0.16.47。
    expect(existsSync(join(nm, "rehype-katex", "node_modules", "katex"))).toBe(false);
    expect(existsSync(join(nm, "micromark-extension-math", "node_modules", "katex"))).toBe(false);
    expect(existsSync(join(nm, "katex"))).toBe(true);
  });
});

// ---- Part B：编辑器载入链源串逐阶段零改写 ----

describe("mathKatexDedupe: 编辑器链块级公式源串逐阶段不变", () => {
  it("B1: 截图公式·单行 $$ 块（定界符同行）S2/S3 逐字符 exact", () => {
    const t = traceEditorChain(`$$${SCREENSHOT_FORMULA}$$\n`);
    expect(t.s1Mutated).toBe(false);
    expect(t.s2Values).toEqual([SCREENSHOT_FORMULA]);
    expect(t.s3Values).toEqual([SCREENSHOT_FORMULA]);
  });

  it("B2: Typora 双行 $$ 独占行（LF 与 CRLF）S2/S3 逐字符 exact", () => {
    for (const eol of ["\n", "\r\n"]) {
      const t = traceEditorChain(`$$${eol}${SCREENSHOT_FORMULA}${eol}$$${eol}`);
      // exitMathFlow 剥一个首/尾换行 → 值恰为公式本体
      expect(t.s2Values).toEqual([SCREENSHOT_FORMULA]);
      expect(t.s3Values).toEqual([SCREENSHOT_FORMULA]);
    }
  });

  it("B3: 双行多行公式（aligned）内部换行原样保留", () => {
    const body = String.raw`\begin{aligned}` + "\n" + SCREENSHOT_FORMULA + String.raw` \\` + "\n" + String.raw`y = F_2' \cdot x` + "\n" + String.raw`\end{aligned}`;
    const t = traceEditorChain(`$$\n${body}\n$$\n`);
    expect(t.s2Values).toEqual([body]);
    expect(t.s3Values).toEqual([body]);
  });

  it("B4: \\tag/\\label 编辑器链不注入不剥除（对照静态管线的 harvest）", () => {
    const tagged = `${SCREENSHOT_FORMULA} \\tag{3} \\label{eq:chain}`;
    const t = traceEditorChain(`$$\n${tagged}\n$$\n`);
    expect(t.s2Values).toEqual([tagged]);
    expect(t.s3Values).toEqual([tagged]);
  });

  it("B5: 真实文档摘录块：编辑器链值 === 块本体（逐块 exact）+ guard 不降级", () => {
    for (const b of REAL_DOC_BLOCKS) {
      const t = traceEditorChain(`$$\n${b.latex}\n$$\n`);
      expect(t.s1Mutated).toBe(false);
      expect(t.s2Values).toEqual([b.latex]);
      expect(t.s3Values).toEqual([b.latex]); // guard 未把块降级为字面文本
    }
  });
});

// ---- Part C：`\=` 现状固化（escapedEqDecision：不处理，不写还原函数）----

describe("mathKatexDedupe: \\= 转义现状（escapedEqDecision）", () => {
  it("C1: $ 定界符外的 \\= 按 CommonMark 转义渲染为字面 =，管线零异常", async () => {
    // 裁定（escapedEqDecision）：渲染侧不写 \=→= 还原函数——\= 同时是 KaTeX
    // text-mode 合法重音宏，盲还原会误伤合法用途；用户文档三处 \= 均在定界符
    // 外的中文正文，按 CommonMark 转义为字面 =，本就零异常。此用例固化该现状。
    const html = await renderMarkdown("设 $x$ 为自变量，\\=y 表示均值，其中 $y>0$。");
    expect(html).not.toContain("katex-error");
    expect(html).toContain("=y");
    expect(html).toContain("katex"); // 行内公式 $x$/$y>0$ 正常渲染
  });
});
