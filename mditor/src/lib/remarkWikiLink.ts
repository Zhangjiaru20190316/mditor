// `[[目标]]` / `[[目标|显示文本]]` 双链语法的 remark 插件（v4.7 知识功能）。
//
// 消费方（与 remarkMark 同款三处注册契约）：
//   * Milkdown 编辑器 + worker 解析管线（lib/remarkPipeline）：native 模式，
//     text 节点里的 `[[…]]` 拆分为 `wikiLink` mdast 节点（target/label 属性，
//     ProseMirror 侧映射为 atom inline node，见 lib/wikiLinkNode.ts）；
//     序列化回写 `[[target|label]]` 原文（本地闭环）。
//   * 静态渲染管线（lib/renderMarkdown）与导出降级：export 模式，`[[…]]`
//     降级为标准 `link` 节点（resolver 命中）或带样式提示的纯文本 span
//     （未解析）——导出产物离开本工具仍可读（铁律 5）。
//
// 解析实现沿用 remarkMark 的 post-parse walk（不引入 micromark 扩展依赖）：
// code/inlineCode 的文本保存在独立节点类型里，walk 只碰 `text`，永不误伤。

interface MdastNode {
  type?: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
  target?: string;
  label?: string;
  [key: string]: unknown;
}

/** `[[target|label]]` / `[[target]]` / `[[target#heading]]`。 */
const WIKI_RE = /\[\[([^[\]\n]+)\]\]/g;

/** target|label 与 target#heading 拆解；label 缺省回退 target。 */
export function parseWikiLink(raw: string): { target: string; label: string } | null {
  const content = raw.trim();
  if (!content) return null;
  const [head, alias] = content.split("|");
  const target = head.split("#")[0].trim();
  if (!target) return null;
  const label = (alias ?? head).trim() || target;
  return { target, label };
}

export interface WikiLinkOptions {
  /**
   * export 模式：true 时把 wikiLink 节点降级为标准 link（resolver 命中）
   * 或样式化纯文本（未解析）。false = native 模式（编辑器/worker 管线，
   * 产出 wikiLink 节点供 PM schema 映射）。
   */
  exportMode?: boolean;
  /** export 模式的目标解析器：返回可链接的 href（相对路径），null = 未解析。 */
  resolve?: (target: string) => string | null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** native 模式：text → [text, wikiLink, text…]。 */
function splitWikiLinks(value: string): MdastNode[] {
  if (!value.includes("[[")) return [{ type: "text", value }];
  const out: MdastNode[] = [];
  let last = 0;
  for (const m of value.matchAll(WIKI_RE)) {
    const parsed = parseWikiLink(m[1]);
    if (!parsed) continue;
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    out.push({
      type: "wikiLink",
      target: parsed.target,
      label: parsed.label,
      children: [{ type: "text", value: parsed.label }],
    });
    last = m.index + m[0].length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/** export 模式：text → [text, link/html, text…]。 */
function splitWikiLinksExport(
  value: string,
  resolve: (t: string) => string | null
): MdastNode[] {
  if (!value.includes("[[")) return [{ type: "text", value }];
  const out: MdastNode[] = [];
  let last = 0;
  for (const m of value.matchAll(WIKI_RE)) {
    const parsed = parseWikiLink(m[1]);
    if (!parsed) continue;
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    const href = resolve(parsed.target);
    if (href != null) {
      out.push({
        type: "link",
        url: href,
        children: [{ type: "text", value: parsed.label }],
      });
    } else {
      // 未解析目标：纯文本 + 样式提示（rehype-raw 解析；sanitize schema 已
      // 放行 span.className）。
      out.push({
        type: "html",
        value: `<span class="wikilink-unresolved" title="未链接的笔记：${escapeHtml(parsed.target)}">${escapeHtml(parsed.label)}</span>`,
      });
    }
    last = m.index + m[0].length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function transform(node: MdastNode | undefined, split: (v: string) => MdastNode[]): void {
  const kids = node?.children;
  if (!kids) return;
  const next: MdastNode[] = [];
  for (const child of kids) {
    if (child.type === "text" && typeof child.value === "string") {
      next.push(...split(child.value));
    } else {
      transform(child, split);
      next.push(child);
    }
  }
  node.children = next;
}

/**
 * unified 插件。注册惯例同 remarkMark：`.use(remarkWikiLink as Plugin)` /
 * Milkdown `$remark("remarkWikiLink", () => remarkWikiLink as never)`。
 * 可选参数经 `.use(remarkWikiLink, { exportMode: true, resolve })` 传入；
 * Milkdown 的 $remark 包装以零参调用——native 模式即默认行为。
 */
export function remarkWikiLink(this: { data(): Record<string, unknown> }, opts?: WikiLinkOptions) {
  const exportMode = opts?.exportMode === true;
  const resolve = opts?.resolve ?? (() => null);

  // 序列化（仅 native 闭环需要）：wikiLink 节点 → [[target|label]] 原文。
  // 必须挂 data.toMarkdownExtensions（remark-stringify v11 只读这个键，
  // 见 remarkMark.ts 的 v3.9.7 修复注释）。
  if (!exportMode) {
    const data = this.data() as Record<string, unknown[]>;
    const extensions = data.toMarkdownExtensions || (data.toMarkdownExtensions = []);
    extensions.push({
      handlers: {
        wikiLink: (node: MdastNode) => {
          const target = String(node.target ?? "");
          const label = String(node.label ?? "");
          if (!target) return label;
          return label && label !== target ? `[[${target}|${label}]]` : `[[${target}]]`;
        },
      },
    });
  }

  const split = exportMode
    ? (v: string) => splitWikiLinksExport(v, resolve)
    : splitWikiLinks;
  return (tree: unknown) => {
    transform(tree as MdastNode, split);
  };
}
