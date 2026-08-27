// 静态表面的 copy-tex（v4.6）：从渲染结果反选出 LaTeX 源码。
//
// 不全局引入 katex/contrib/copy-tex：它挂 document 级 copy 监听，会与
// ProseMirror 的剪贴板序列化打架（编辑器里选区同时含正文与公式时，
// text/plain 被整体覆盖成纯 LaTeX，正文丢失）。这里把同一算法做成本容器
// 级监听，只挂在静态渲染表面（MarkdownText：AI 面板 / 批注预览）。编辑器
// 内的复制本就由 ProseMirror 输出 markdown 纯文本 + KaTeX HTML，无需增强。
//
// 算法与 copy-tex 相同：克隆选区，把每个 .katex-mathml（视觉隐藏的 MathML
// 副本）替换为其 <annotation encoding="application/x-tex"> 里的 LaTeX 源码、
// 移除 .katex-html（视觉副本，避免文本重复），再写回 text/plain 与
// text/html。区别于 copy-tex 的 textContent 直读：块级边界补换行，多段复制
// 时不至于粘成一坨。

const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6",
  "PRE", "BLOCKQUOTE", "TABLE", "TR", "BR", "DL", "DT", "DD",
]);

function serializePlainText(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node.textContent ?? "");
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const tag = (node as Element).tagName;
  if (tag === "BR") {
    out.push("\n");
    return;
  }
  for (const child of Array.from(node.childNodes)) {
    serializePlainText(child, out);
  }
  if (BLOCK_TAGS.has(tag)) out.push("\n");
}

/**
 * 在容器上挂 copy 监听：选区含 KaTeX 公式时，把剪贴板的 text/plain 替换为
//  「公式 → LaTeX 源码」的纯文本、text/html 替换为同变换后的 HTML；无公式
 * 时不动（浏览器默认行为）。返回解除挂载的函数。
 */
export function attachScopedCopyTex(root: HTMLElement): () => void {
  const onCopy = (e: ClipboardEvent) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    // 仅处理选区完全落在本容器内的复制（编辑器/其他表面的复制不碰）。
    if (!root.contains(range.commonAncestorContainer)) return;
    const clipboard = e.clipboardData;
    if (!clipboard) return;

    const fragment = range.cloneContents();
    const holder = document.createElement("div");
    holder.appendChild(fragment);
    if (!holder.querySelector(".katex-mathml")) return; // 无公式：默认行为

    // 公式 → LaTeX 源码（annotation 里是渲染时的原始 LaTeX 串）。
    holder.querySelectorAll(".katex-mathml").forEach((mathml) => {
      const anno = mathml.querySelector(
        "annotation[encoding='application/x-tex']"
      );
      mathml.replaceWith(document.createTextNode(anno?.textContent ?? ""));
    });
    holder.querySelectorAll(".katex-html").forEach((html) => html.remove());

    const parts: string[] = [];
    serializePlainText(holder, parts);
    const text = parts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    if (!text) return;
    clipboard.setData("text/plain", text);
    clipboard.setData("text/html", holder.innerHTML);
    e.preventDefault();
  };
  root.addEventListener("copy", onCopy);
  return () => root.removeEventListener("copy", onCopy);
}
