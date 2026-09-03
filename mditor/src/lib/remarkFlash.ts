// `:::flash` 闪卡容器的 remark 插件（模块 4「间隔重复闪卡」，v4.7）。
//
// 语法（docs/research-features.md 为最终规范；对齐 remark directive 容器
// 风格，但不引入 micromark-extension-directive 依赖）：
//
//   :::flash
//   问题：……？
//   ---
//   答案：……
//   :::
//
// 消费方（与 remarkWikiLink/remarkCitation 同款三处注册契约）：
//   * Milkdown 编辑器 + worker 解析管线（native 模式）：把 `:::flash` 行、
//     内部块、`:::` 行组装为 `flashcard` mdast 节点（children = 原始块），
//     PM 侧映射为 block 节点（lib/flashcardNode.ts，卡片样式容器）；
//     序列化回写 `:::flash … :::` 原文（本地闭环）。
//   * 静态渲染管线（renderMarkdown）与编辑器 HTML 导出（render 模式）：
//     降级为 blockquote（铁律 6：导出产物离开本工具仍可读为普通引用块）。
//
// CommonMark 相邻行合并成段（`:::flash` 与问题文本常在同一 paragraph），
// 所以组装前先做「段内标记行拆分」：段落文本里整行恰好是 `:::flash` /
// `:::` 的位置切开。代码围栏天然是独立 code 节点，不受影响；未闭合的
// `:::flash` 保持原样（宽容：宁可不开卡也不吞正文）。

interface MdastNode {
  type?: string;
  value?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

export interface FlashRemarkOptions {
  /** render = 静态渲染/导出（降级为 blockquote）；native = 编辑器闭环。 */
  mode?: "native" | "render";
}

const OPEN_LINE = ":::flash";
const CLOSE_LINE = ":::";

function isMarkerLine(line: string): "open" | "close" | null {
  const t = line.trim();
  if (t === OPEN_LINE) return "open";
  if (t === CLOSE_LINE) return "close";
  return null;
}

function paragraphLines(node: MdastNode | undefined): string[] | null {
  if (node?.type !== "paragraph" && node?.type !== "heading") return null;
  const text = (node.children ?? [])
    .map((c) => (typeof c.value === "string" ? c.value : ""))
    .join("");
  return text.split("\n");
}

/** 段内标记行拆分：一个 paragraph → [段?, 标记段, 段?, …]（无标记则原样）。
 *
 *  另需处理 setext 标题陷阱：`问题？\n---` 被 CommonMark 解析为 H2 标题
 *  （`---` 是下划线）——卡内 `---` 分隔线紧跟问题文本时必然触发。多行
 *  文本的 heading（ATX 标题恒单行）即 setext 产物：按标记行拆分，并补回
 *  被 setext 吞掉的分隔线（synthetic thematicBreak）。
 */
function splitParagraphMarkers(node: MdastNode): MdastNode[] {
  const lines = paragraphLines(node);
  if (!lines) return [node];
  const isSetextHeading =
    node.type === "heading" && lines.length > 1;
  if (node.type === "paragraph") {
    // 只处理纯文本段（含行内标记的段不切，避免破坏粗体等结构语义）。
    const kids = node.children ?? [];
    if (kids.some((c) => c.type !== "text")) return [node];
  }
  let hit = false;
  for (const line of lines) {
    if (isMarkerLine(line)) {
      hit = true;
      break;
    }
  }
  if (!hit) return [node];

  const out: MdastNode[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    out.push({ type: "paragraph", children: [{ type: "text", value: buf.join("\n") }] });
    buf = [];
  };
  for (const line of lines) {
    const marker = isMarkerLine(line);
    if (marker) {
      flush();
      out.push({ type: "paragraph", children: [{ type: "text", value: line.trim() }] });
    } else {
      buf.push(line);
    }
  }
  flush();
  if (isSetextHeading) {
    // setext 的 `---` 下划线被标题吞掉——补回分隔线（卡内问答边界）。
    out.push({ type: "thematicBreak" });
  }
  return out;
}

/** 对一个 children 数组做 :::flash 组装（native：产出 flashcard 节点）。 */
function assembleNative(arr: MdastNode[]): MdastNode[] {
  // 先拆段内标记行，再做块级组装。
  const flat: MdastNode[] = [];
  for (const node of arr) flat.push(...splitParagraphMarkers(node));

  const out: MdastNode[] = [];
  let i = 0;
  while (i < flat.length) {
    const node = flat[i];
    const lines = paragraphLines(node);
    if (lines && lines.length === 1 && isMarkerLine(lines[0]) === "open") {
      // 收集到闭合行（或数组尽头——未闭合则原样保留，宽容降级）。
      let j = i + 1;
      let closed = -1;
      while (j < flat.length) {
        const innerLines = paragraphLines(flat[j]);
        if (innerLines && innerLines.length === 1 && isMarkerLine(innerLines[0]) === "close") {
          closed = j;
          break;
        }
        j++;
      }
      if (closed > i) {
        const inner = flat.slice(i + 1, closed).map((n) => deepAssemble(n));
        if (inner.length > 0) {
          out.push({ type: "flashcard", children: inner });
          i = closed + 1;
          continue;
        }
      }
    }
    out.push(deepAssemble(node));
    i++;
  }
  return out;
}

/** 嵌套容器（blockquote / listItem 等）里的 children 递归组装。 */
function deepAssemble(node: MdastNode): MdastNode {
  if (node.children) return { ...node, children: assembleNative(node.children) };
  return node;
}

/** render 模式：flashcard 节点（含嵌套）降级为 blockquote。 */
function degradeToBlockquote(node: MdastNode): MdastNode {
  if (node.type === "flashcard") {
    return {
      type: "blockquote",
      children: (node.children ?? []).map(degradeToBlockquote),
    };
  }
  if (node.children) {
    return { ...node, children: node.children.map(degradeToBlockquote) };
  }
  return node;
}

/**
 * unified 插件。注册惯例同 remarkWikiLink：`.use(remarkFlash as Plugin)` /
 * Milkdown `$remark("remarkFlash", () => remarkFlash as never)`（零参调用 =
 * native 模式）；静态管线 `.use(remarkFlash, { mode: "render" })`。
 */
export function remarkFlash(this: { data(): Record<string, unknown> }, opts?: FlashRemarkOptions) {
  const mode = opts?.mode ?? "native";

  // 序列化（仅 native 闭环）：flashcard → :::flash 包裹的原始块。
  if (mode === "native") {
    const data = this.data() as Record<string, unknown[]>;
    const extensions = data.toMarkdownExtensions || (data.toMarkdownExtensions = []);
    extensions.push({
      handlers: {
        flashcard: (
          node: MdastNode,
          parent: MdastNode | undefined,
          state: { containerFlow: (n: MdastNode, p?: MdastNode) => string }
        ) => {
          const inner = state.containerFlow(node, parent);
          return `:::flash\n${inner}:::\n`;
        },
      },
    });
  }

  return (tree: unknown) => {
    const root = tree as MdastNode;
    if (!root.children) return;
    // 两种模式都先做 native 组装（render 输入是原始 markdown——不组装
    // 就没有 flashcard 节点可降级）；render 随后降级为 blockquote。
    root.children = assembleNative(root.children);
    if (mode === "render") {
      root.children = root.children.map(degradeToBlockquote);
    }
  };
}
