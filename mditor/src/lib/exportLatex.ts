// Markdown → LaTeX 纯前端转换（模块 3，铁律 2：不调 pandoc、不加 shell 权限）。
//
// 输入是 Markdown 源码（而非编辑器 HTML）——公式源即 LaTeX 天然平移、
// [@key] → \cite{key}、图表编号/交叉引用交给 LaTeX 计数器（\caption/\label/
// \ref）、文末 References 标题处生成 thebibliography 环境。简单 GFM 表格直转
// tabular（booktabs 风格）；单元格含块级内容时降级为纯文本。产物面向
// Overleaf（XeLaTeX + ctexart，含中文），demo 验收文档即编译样例。
//
// 解析管线与导出共用 remarkCitation/remarkWikiLink 的 native 模式（得到
// citation / wikiLink mdast 节点），语法降级规则与 HTML 导出一致。

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { asRemarkPlugin } from "./pluginCast";
import { remarkCitation } from "./remarkCitation";
import { remarkWikiLink } from "./remarkWikiLink";
import { remarkFlash } from "./remarkFlash";
import { parseFigureAttr, parseTableCaption } from "./figureNumbering";
import { buildReferences, formatReference, isReferencesHeadingText } from "./citation";
import { bibliography } from "./bibliography";
import { findBibEntry } from "./bibtex";

interface MdastNode {
  type?: string;
  depth?: number;
  value?: string;
  url?: string;
  alt?: string | null;
  title?: string | null;
  lang?: string | null;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  align?: Array<"left" | "center" | "right" | null> | null;
  identifier?: string;
  label?: string;
  children?: MdastNode[];
  keys?: string[];
  locator?: string;
  raw?: string;
  target?: string;
  [key: string]: unknown;
}

let processor: ReturnType<typeof buildTexProcessor> | null = null;

function buildTexProcessor() {
  // remarkFlash 与静态管线（remarkPipeline）同源注册：编辑器序列化把闪卡
  // 写回 `:::flash … :::` 原文，不接插件时标记按 CommonMark 并进段落——
  // `:::flash` 字面与卡内 setext 陷阱（`问题？\n---` 成 H2）全部漏进 .tex，
  // 下方 case "flashcard" 的引用块降级即成死代码（MC 轮 P1 定罪）。
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(asRemarkPlugin(remarkCitation))
    .use(asRemarkPlugin(remarkWikiLink))
    .use(asRemarkPlugin(remarkFlash));
}

function getProcessor() {
  if (!processor) processor = buildTexProcessor();
  return processor;
}

// ---- 基础转义 ----------------------------------------------------------------

const ESCAPE_MAP: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

function texEscape(s: string): string {
  let out = "";
  for (const ch of s) out += ESCAPE_MAP[ch] ?? ch;
  return out;
}

/** 含 `*斜体*` 的轻量 Markdown 串（参考文献表产物）→ LaTeX。 */
function texFromMarkdownLite(s: string): string {
  const parts = s.split(/\*(.+?)\*/g);
  return parts
    .map((part, i) => (i % 2 === 1 ? `\\textit{${texEscape(part)}}` : texEscape(part)))
    .join("");
}

// ---- 行内节点 ----------------------------------------------------------------

/** 行内发射上下文：标题是移动参数（moving argument），\verb 不能出现
 *  （XeLaTeX + hyperref 直接编译失败——MC 轮 P2）；mixed 标记图文混排段
 *  （行内图按宽度约束而非 1em 高，截图可读）。 */
interface InlineCtx {
  inHeading?: boolean;
  mixed?: boolean;
}

/** \href 的 URL 参数转义：hyperref 对 URL 参数只认 `\%`/`\#` 转义形态，
 *  文本宏（\textasciitilde{} 等）会成为 URL 的一部分——含 `~` 的链接直接
 *  损坏。反斜杠/空格先行百分号编码，再做 %/# 转义。 */
function texUrlEscape(u: string): string {
  return u
    .replace(/\\/g, "%5C")
    .replace(/%/g, "\\%")
    .replace(/#/g, "\\#")
    .replace(/ /g, "%20");
}

function inlineNodes(nodes: MdastNode[] | undefined, ctx?: InlineCtx): string {
  if (!nodes) return "";
  return nodes.map((n) => inlineNode(n, ctx)).join("");
}

function inlineNode(node: MdastNode, ctx?: InlineCtx): string {
  switch (node.type) {
    case "text":
      return texWithRefs(String(node.value ?? ""));
    case "emphasis":
      return `\\emph{${inlineNodes(node.children, ctx)}}`;
    case "strong":
      return `\\textbf{${inlineNodes(node.children, ctx)}}`;
    case "delete":
      return `\\sout{${inlineNodes(node.children, ctx)}}`;
    case "inlineCode": {
      const v = String(node.value ?? "");
      // 标题（移动参数）禁 \verb：定界内容不可靠，恒走 \texttt 转义。
      if (!ctx?.inHeading) {
        // \verb 定界符避开内容字符；内容含全部候选时退回 \texttt 转义。
        for (const d of ["|", "!", "#", "=", "+", "~"]) {
          if (!v.includes(d)) return `\\verb${d}${v}${d}`;
        }
      }
      return `\\texttt{${texEscape(v)}}`;
    }
    case "inlineMath":
      return `$${String(node.value ?? "")}$`;
    case "math":
      // 行内位置的块公式（少见）——按展示公式处理。
      return displayMath(String(node.value ?? ""));
    case "link":
      return `\\href{${texUrlEscape(String(node.url ?? ""))}}{${inlineNodes(node.children, ctx)}}`;
    case "image":
      // 行内图：图文混排段按宽度约束（1em 高会把截图压到字号高度不可读——
      // MC 轮 P2）；纯文字流里的小图保持 1em。
      if (ctx?.mixed) {
        return `\\includegraphics[width=0.5\\linewidth]{${texEscape(String(node.url ?? ""))}}`;
      }
      return `\\includegraphics[height=1em]{${texEscape(String(node.url ?? ""))}}`;
    case "break":
      return "\\\\";
    case "citation": {
      const keys = (node.keys ?? []).map((k) => findBibEntry(bibliography.all(), k)?.key ?? k);
      if (keys.length === 0) return texEscape(String(node.raw ?? ""));
      const locator = String(node.locator ?? "").trim();
      const opt = locator ? `[${texEscape(locator)}]` : "";
      return `\\cite${opt}{${keys.join(", ")}}`;
    }
    case "wikiLink":
      // 降级为纯文本显示名（铁律 6：导出产物离开本工具仍可读）。
      return texEscape(String(node.children?.[0]?.value ?? node.target ?? ""));
    case "footnoteReference":
      return `\\footnote{${footnoteText(String(node.identifier ?? ""))}}`;
    case "html":
      return ""; // 原生 HTML 不进 LaTeX
    default:
      return inlineNodes(node.children, ctx) || texEscape(String(node.value ?? ""));
  }
}

function displayMath(src: string): string {
  return `\\begin{equation}\n${src.trim()}\n\\end{equation}`;
}

/** 正文文本：先解析 @fig:id/@tbl:id 交叉引用（→ \ref），其余转义。 */
function texWithRefs(text: string): string {
  if (!text.includes("@fig:") && !text.includes("@tbl:")) return texEscape(text);
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(/@(fig|tbl):([A-Za-z0-9_\-.:]+)/g)) {
    // 引用是否真实存在（有对应的 figure/table 标记）在块级阶段收集；
    // 这里先统一发 \ref，未定义的 id 由 LaTeX 报 "??"——同 pandoc 行为。
    parts.push(texEscape(text.slice(last, m.index)));
    parts.push(`\\ref{${m[1]}:${m[2]}}`);
    last = m.index + m[0].length;
  }
  parts.push(texEscape(text.slice(last)));
  return parts.join("");
}

// ---- 脚注定义 ----------------------------------------------------------------

let footnoteDefs = new Map<string, MdastNode[]>();

function footnoteText(identifier: string): string {
  const def = footnoteDefs.get(identifier);
  if (!def) return "";
  return inlineNodes(def);
}

// ---- 块级节点 ----------------------------------------------------------------

/** 首个 H1 摘为 \title 后，其余标题整体上移一级（H2 → \section…）。 */
let headingShift = 0;

function headingLevelCmd(depth: number): string {
  const eff = Math.max(1, depth - headingShift);
  switch (eff) {
    case 1:
      return "section";
    case 2:
      return "subsection";
    case 3:
      return "subsubsection";
    default:
      return "paragraph";
  }
}

/** verbatim 块：内容含字面 `\end{verbatim}` 时环境会被提前终止（LaTeX
 *  教程类文档完全可达），后续代码裸漏为 LaTeX 源码流——拆段发射，终止符
 *  经 \verb 桥接（MC 轮 P2）。 */
function verbatimBlock(src: string): string {
  const TERM = "\\end{verbatim}";
  if (!src.includes(TERM)) {
    return `\\begin{verbatim}\n${src}\n\\end{verbatim}\n`;
  }
  const parts = src.split(TERM);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) out += `\\verb|${TERM}|\n`;
    out += `\\begin{verbatim}\n${parts[i]}\n\\end{verbatim}\n`;
  }
  return out;
}

function blockNode(node: MdastNode, i: number, siblings: MdastNode[]): string {
  switch (node.type) {
    case "heading": {
      // 标题是移动参数：行内 \verb 禁用（InlineCtx.inHeading）。
      const text = inlineNodes(node.children, { inHeading: true });
      const depth = node.depth ?? 1;
      if (isReferencesHeadingText(plainText(node))) {
        // 空文献表（无条目或无可解析引用）不再吞掉用户手写的标题本身
        // （MC 轮 P1：返回空串曾使整个标题块从产物消失）。
        const bib = theBibliography();
        if (bib) return bib;
        return `\\${headingLevelCmd(depth)}*{${text}}\n`;
      }
      const cmd = headingLevelCmd(depth);
      return `\\${cmd}{${text}}`;
    }
    case "paragraph": {
      const kids = node.children ?? [];
      const hasImage = kids.some((c) => c.type === "image");
      // 图片独占段（尾随 {#fig:id} 属性或下一段为属性段）→ figure 环境。
      if (hasImage) return figureBlock(node, i, siblings);
      return `${inlineNodes(kids)}\n`;
    }
    case "code":
      return verbatimBlock(String(node.value ?? ""));
    case "math":
      return `${displayMath(String(node.value ?? ""))}\n`;
    case "thematicBreak":
      return "\\noindent\\rule{\\linewidth}{0.4pt}\n";
    case "blockquote":
      return `\\begin{quote}\n${blockNodes(node.children)}\\end{quote}\n`;
    case "list": {
      const env = node.ordered ? "enumerate" : "itemize";
      const items = (node.children ?? [])
        .map((li) => {
          const checked = li.checked;
          const marker = checked === null || checked === undefined ? "" : checked ? "[$\\blacksquare$]" : "[$\\square$]";
          const body = blockNodes(li.children).trimEnd();
          return `\\item${marker} ${body}`;
        })
        .join("\n");
      return `\\begin{${env}}\n${items}\n\\end{${env}}\n`;
    }
    case "table":
      return tableBlock(node, i, siblings);
    case "footnoteDefinition":
      return ""; // 已在预收集阶段进 footnoteDefs
    case "html":
      return ""; // 原生 HTML 不进 LaTeX
    case "flashcard":
      // 模块 4 闪卡降级：引用块承载问答。
      return `\\begin{quote}\n${blockNodes(node.children)}\\end{quote}\n`;
    default:
      if (node.children) return blockNodes(node.children);
      return typeof node.value === "string" ? `${texEscape(node.value)}\n` : "";
  }
}

function blockNodes(nodes: MdastNode[] | undefined): string {
  if (!nodes) return "";
  return nodes.map((n, i) => blockNode(n, i, nodes ?? [])).join("");
}

function plainText(node: MdastNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(plainText).join("");
}

/** 图片独占段 → figure 环境（caption=alt，label=fig:id）。 */
function figureBlock(para: MdastNode, i: number, siblings: MdastNode[]): string {
  const kids = para.children ?? [];
  let attrId: string | null = null;
  const imgs: MdastNode[] = [];
  const inlineRest: MdastNode[] = [];
  for (const k of kids) {
    if (k.type === "image") imgs.push(k);
    else if (k.type === "text") {
      const attr = parseFigureAttr(String(k.value ?? ""));
      if (attr && attr.kind === "fig") attrId = attr.id;
      else inlineRest.push(k);
    } else inlineRest.push(k);
  }
  // 独立属性段（`{#fig:id}` 自成一段，紧随图片段）。
  if (!attrId) {
    const next = siblings[i + 1];
    if (
      next?.type === "paragraph" &&
      (next.children ?? []).length === 1 &&
      next.children?.[0]?.type === "text"
    ) {
      const attr = parseFigureAttr(String(next.children[0].value ?? ""));
      if (attr && attr.kind === "fig") attrId = attr.id;
    }
  }
  if (imgs.length !== 1 || inlineRest.length > 0) {
    // 多图/图文混排：不做 figure 环境，行内 includegraphics（mixed 上下文
    // → 宽度约束，截图可读）。
    return `${inlineNodes(kids, { mixed: true })}\n`;
  }
  const img = imgs[0];
  const caption = String(img.alt ?? "").trim();
  const cap = caption ? `  \\caption{${texEscape(caption)}}\n` : "";
  const label = attrId ? `  \\label{fig:${attrId}}\n` : "";
  const title = img.title ? `  % ${texEscape(String(img.title))}\n` : "";
  return `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${texEscape(
    String(img.url ?? "")
  )}}\n${title}${cap}${label}\\end{figure}\n`;
}

/** GFM 表格 → tabular（booktabs 风格）；说明行 `: cap {#tbl:id}` → caption+label。
 *  说明段本身的跳过由主循环的 isTableCaptionOf 判定完成。 */
function tableBlock(table: MdastNode, i: number, siblings: MdastNode[]): string {
  const rows = (table.children ?? []) as Array<{ type?: string; children?: MdastNode[] }>;
  if (rows.length === 0) return "";
  const align = table.align ?? [];
  const colCmd = (a: "left" | "center" | "right" | null) =>
    a === "center" ? "c" : a === "right" ? "r" : "l";
  const cols = Math.max(...rows.map((r) => (r.children ?? []).length));
  const spec = Array.from({ length: cols }, (_, c) => colCmd(align[c] ?? null)).join("");

  const cellText = (cell: MdastNode | undefined): string => {
    if (!cell) return "";
    // 单元格内容平铺为行内文本（块级内容降级为纯文本——简单表格直转边界）。
    return inlineNodes(cell.children).trim();
  };
  const rowTex = (row: { children?: MdastNode[] }, rowIdx: number): string => {
    const cells = Array.from({ length: cols }, (_, c) => cellText(row.children?.[c]));
    const line = cells.join(" & ");
    const mid = rowIdx === 0 ? "\n\\midrule" : "";
    return `${line} \\\\${mid}`;
  };

  // 相邻说明行（前或后）→ caption + label。
  let caption = "";
  let label = "";
  const attach = (p: MdastNode | undefined): boolean => {
    if (p?.type !== "paragraph") return false;
    const cap = parseTableCaption(plainText(p));
    if (!cap?.id) return false;
    caption = `  \\caption{${texEscape(cap.caption)}}\n`;
    label = `  \\label{tbl:${cap.id}}\n`;
    return true;
  };
  if (!attach(siblings[i - 1])) attach(siblings[i + 1]);

  const body = rows.map((r, idx) => rowTex(r, idx)).join("\n");
  const inner = `\\begin{tabular}{${spec}}\n\\toprule\n${body}\n\\bottomrule\n\\end{tabular}\n`;
  if (caption || label) {
    return `\\begin{table}[htbp]\n  \\centering\n${inner}${caption}${label}\\end{table}\n`;
  }
  return inner;
}

function theBibliography(): string {
  const entries = bibliography.all();
  const keysInOrder = citedKeys;
  // 与 HTML 导出/静态渲染同源取用户样式（author-year 用户的编号/排序语义
  // 不再被静默改写——thebibliography 环境本身即编号形态，author-year 退
  // 数值但排序与出现序一致）。
  const refs = buildReferences(entries, keysInOrder, bibliography.getStyle());
  if (refs.length === 0) return "";
  const items = refs
    .map((r) => `\\bibitem{${texEscape(r.key)}} ${texFromMarkdownLite(formatReference(r.entry))}`)
    .join("\n");
  return `\\begin{thebibliography}{99}\n${items}\n\\end{thebibliography}\n`;
}

/** 文档序收集的引用键（emit 前的预扫描写入）。 */
let citedKeys: string[] = [];

function collectCitedKeys(node: MdastNode): void {
  if (node.type === "citation") {
    for (const k of node.keys ?? []) citedKeys.push(k);
  }
  for (const c of node.children ?? []) collectCitedKeys(c);
}

/** 兼容闪卡（模块 4 后 remarkFlash 产出 flashcard 节点；此处只做块级降级，
 *  预扫描/emit 均天然覆盖 children）。 */

// ---- 文档组装 ----------------------------------------------------------------

export interface LatexResult {
  tex: string;
  /** 提示性信息（如未解析的引用键数）。 */
  warnings: string[];
}

/** 把 Markdown 源码转换为完整可编译的 .tex 文档字符串。 */
export function markdownToLatex(md: string, docTitle?: string): LatexResult {
  const tree = getProcessor().parse(md);
  const root = getProcessor().runSync(tree, md) as MdastNode;

  // 预扫描：脚注定义 + 引用键。
  footnoteDefs = new Map();
  citedKeys = [];
  for (const child of root.children ?? []) {
    if (child.type === "footnoteDefinition") {
      footnoteDefs.set(String(child.identifier ?? ""), child.children ?? []);
    }
    collectCitedKeys(child);
  }

  // 首个非 References 的 H1 作为文档标题（其余标题整体上移一级）。
  const kids = [...(root.children ?? [])];
  let title = docTitle?.trim() ?? "";
  let titleUsed = false;
  if (!title && kids[0]?.type === "heading" && (kids[0].depth ?? 0) === 1) {
    const t = plainText(kids[0]).trim();
    if (t && !isReferencesHeadingText(t)) {
      title = t;
      titleUsed = true;
    }
  }
  headingShift = titleUsed ? 1 : 0;

  // 表格 caption 段的消费：紧邻表格的 `: cap {#tbl:id}` 段不再独立输出。
  // 图片属性段（`{#fig:id}` 自成一段、被前段图片的 figure 环境消费为
  // \label）同款跳过——此前残段会以转义文本 `\{\#fig:...\}` 漏进正文
  // （MC 轮 P1，与 isTableCaptionOf 对称）。
  const emitted: string[] = [];
  const src = titleUsed ? kids.slice(1) : kids;
  for (let i = 0; i < src.length; i++) {
    const node = src[i];
    const prev = src[i - 1];
    const next = src[i + 1];
    if (
      node.type === "paragraph" &&
      ((prev?.type === "table" && isTableCaptionOf(node, prev)) ||
        (next?.type === "table" && isTableCaptionOf(node, next)) ||
        isFigureAttrOf(node, prev))
    ) {
      continue;
    }
    emitted.push(blockNode(node, i, src));
  }
  const body = emitted.join("");

  const unresolved = citedKeys.filter((k) => !findBibEntry(bibliography.all(), k));
  const warnings: string[] = [];
  if (unresolved.length > 0) {
    warnings.push(
      `${unresolved.length} 个引用键未在文献库中解析（\\cite 将显示 [?]）：${[...new Set(unresolved)].slice(0, 5).join("、")}${unresolved.length > 5 ? "…" : ""}`
    );
  }

  const titleTex = title ? `\\title{${texEscape(title)}}\n\\author{}\n\\date{}\n\\maketitle\n` : "";
  const tex = `\\documentclass[UTF8]{ctexart}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{hyperref}
\\usepackage[normalem]{ulem}
\\usepackage[a4paper,margin=2.5cm]{geometry}
\\hypersetup{hidelinks}
\\begin{document}
${titleTex}
${body}\\end{document}
`;
  return { tex, warnings };
}

/** 段落是否为指定表格的 `: caption {#tbl:id}` 说明行。 */
function isTableCaptionOf(para: MdastNode, table: MdastNode): boolean {
  const cap = parseTableCaption(plainText(para));
  return !!cap?.id && !!table.align;
}

/** 段落是否为前一图片段的独立 `{#fig:id}` 属性段（figureBlock 会把它消费
 *  为 \label——判定条件与 figureBlock 的消费条件逐项对称：前段恰一图、
 *  无其他行内内容、自身无内联属性；本段单文本且解析为 fig 属性）。 */
function isFigureAttrOf(para: MdastNode, imgPara: MdastNode | undefined): boolean {
  if (imgPara?.type !== "paragraph") return false;
  const kids = imgPara.children ?? [];
  let imgs = 0;
  let rest = 0;
  let ownAttr = false;
  for (const k of kids) {
    if (k.type === "image") imgs++;
    else {
      rest++;
      if (k.type === "text") {
        const a = parseFigureAttr(String(k.value ?? ""));
        if (a?.kind === "fig") ownAttr = true;
      }
    }
  }
  if (imgs !== 1 || rest > 0 || ownAttr) return false; // 前段非 figure 消费形态
  const pKids = para.children ?? [];
  if (pKids.length !== 1 || pKids[0]?.type !== "text") return false;
  const attr = parseFigureAttr(String(pKids[0].value ?? ""));
  return attr?.kind === "fig";
}

// 供测试直接访问纯函数层。
export { texEscape, texFromMarkdownLite };
