// 图表编号 / caption / 交叉引用的静态管线适配（模块 3，v4.7）。
//
// 只注册进 renderMarkdown（静态渲染与 HTML/PDF/DOCX 导出共用）——编辑器内
// 图片/表格保持原样（remark 不随键入重跑，实时编号会过期，与公式自动编号
// 同款决策，见 types.ts mathAutoNumber 注释）。LaTeX 导出在 exportLatex
// 内按同一套纯函数（lib/figureNumbering）独立编号。
//
// 行为：
//   * `![标题](x.png){#fig:id}` → 图片原位渲染，其后追加 caption 段
//     （斜体「图 N：标题」）；`{#fig:id}` 标记本身从产物中消失；
//   * `: 标题 {#tbl:id}`（表格相邻行）→ 替换为斜体「表 N：标题」段；
//   * 正文 `@fig:id` / `@tbl:id` → 「图 N」/「表 N」（未定义 id 保留原文）；
//   * code / inlineCode / math 永不触碰。

import {
  FigureNumbering,
  parseFigureAttr,
  parseTableCaption,
  resolveFigureRefs,
} from "./figureNumbering";

interface MdastNode {
  type?: string;
  value?: string;
  alt?: string | null;
  url?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

function emphasis(text: string): MdastNode {
  return { type: "emphasis", children: [{ type: "text", value: text }] };
}

function isImageOnlyParagraph(node: MdastNode): boolean {
  return (
    node.type === "paragraph" &&
    (node.children ?? []).every((c) => c.type === "image")
  );
}

/** 段落末尾的 `{#fig:id}` 文本 → 属性（从段中剥除后返回）。 */
function takeTrailingFigureAttr(node: MdastNode): { kind: "fig" | "tbl"; id: string } | null {
  const kids = node.children ?? [];
  const last = kids[kids.length - 1];
  if (!last || last.type !== "text" || typeof last.value !== "string") return null;
  const attr = parseFigureAttr(last.value);
  if (!attr) return null;
  kids.pop();
  if (kids.length === 0 || (kids.length === 1 && kids[0].type === "text" && kids[0].value === "")) {
    // 属性文本独占一段（无图片）——不处理，还原。
    kids.push(last);
    return null;
  }
  if (kids[kids.length - 1]?.type === "text" && kids[kids.length - 1]?.value === "") kids.pop();
  return attr;
}

/**
 * The unified plugin. Register with `.use(remarkFigureNumbering as Plugin)`
 * （静态管线惯例）。
 */
export function remarkFigureNumbering(this: unknown): (tree: unknown) => void {
  return (tree: unknown) => {
    const numbering = new FigureNumbering();

    // 第一遍：编号 + caption 改写（文档序，深度优先）。
    const processChildren = (arr: MdastNode[]): MdastNode[] => {
      const out: MdastNode[] = [];
      for (let i = 0; i < arr.length; i++) {
        const node = arr[i];

        // 独立属性段紧跟图片段：`![…](x)\n\n{#fig:id}`——并入前一个图片段。
        if (
          node.type === "paragraph" &&
          (node.children ?? []).length === 1 &&
          node.children?.[0]?.type === "text" &&
          parseFigureAttr(String(node.children[0].value ?? ""))
        ) {
          const prev = out[out.length - 1];
          if (prev && isImageOnlyParagraph(prev)) {
            const attr = parseFigureAttr(String(node.children?.[0]?.value ?? ""));
            if (attr && attr.kind === "fig") {
              const img = prev.children?.find((c) => c.type === "image");
              const n = numbering.assign("fig", attr.id);
              const caption = String(img?.alt ?? "").trim();
              out.push(emphasis(caption ? `图 ${n}：${caption}` : `图 ${n}`));
            }
            continue; // 属性段已消费
          }
          out.push(node);
          continue;
        }

        if (node.type === "paragraph") {
          // 图片段尾随属性。
          const kids = node.children ?? [];
          const hasImage = kids.some((c) => c.type === "image");
          const attr = hasImage ? takeTrailingFigureAttr(node) : null;
          if (attr && attr.kind === "fig") {
            const img = kids.find((c) => c.type === "image");
            const n = numbering.assign("fig", attr.id);
            const caption = String(img?.alt ?? "").trim();
            out.push(node);
            out.push(emphasis(caption ? `图 ${n}：${caption}` : `图 ${n}`));
            continue;
          }
          // 表格说明行：`: caption {#tbl:id}`，与前/后相邻的 table 配对。
          const text = kids.map((c) => (typeof c.value === "string" ? c.value : "")).join("");
          const cap = parseTableCaption(text);
          if (cap && cap.id) {
            const prev = out[out.length - 1];
            const next = arr[i + 1];
            const adjacentTable =
              prev?.type === "table" || next?.type === "table";
            if (adjacentTable) {
              const n = numbering.assign("tbl", cap.id);
              out.push(emphasis(`表 ${n}：${cap.caption}`));
              continue;
            }
          }
          out.push(node);
          continue;
        }

        if (node.children) {
          out.push({ ...node, children: processChildren(node.children) });
          continue;
        }
        out.push(node);
      }
      return out;
    };

    const root = tree as MdastNode;
    if (root.children) root.children = processChildren(root.children);

    // 第二遍：正文 @fig:/@tbl: 引用解析（跳过 code / inlineCode / math）。
    const resolveRefs = (node: MdastNode): void => {
      const kids = node.children;
      if (!kids) return;
      for (const child of kids) {
        if (child.type === "text" && typeof child.value === "string") {
          child.value = resolveFigureRefs(
            child.value,
            numbering.figNumbers(),
            numbering.tblNumbers()
          );
        } else if (child.type !== "code" && child.type !== "inlineCode" && child.type !== "math" && child.type !== "inlineMath") {
          resolveRefs(child);
        }
      }
    };
    resolveRefs(root);
  };
}
