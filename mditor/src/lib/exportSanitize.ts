// S10：导出 HTML 的兜底消毒（第二道防线）。
//
// 编辑器导出的 ctx.html 由 ProseMirror schema 产出，正常不含脚本向量；静态
// 管线（AI 面板/预览）有 rehype-sanitize。但导出路径（HTML 文件 / PDF 打印
// iframe / DOCX 转换 / 公式栅格化容器）此前没有任何一道 sanitize——若任何
// raw-HTML 直通漏出，导出产物就是全链路唯一无保护面。
//
// 采用 deny-list 而非复用 renderMarkdown 的 allow-list schema：编辑器合法
// 结构（KaTeX 的 span/class、批注的 data-* 属性、任务列表 input、颜色
// span 的内联 style）不在 defaultSchema 白名单内，allow-list 会误删它们。
// 这里只移除确定的执行/加载向量：
//   * <script> / <iframe> / <object> / <embed> / <base> / <meta> / <link>
//   * 全部 on* 事件属性
//   * href/src/xlink:href 的 javascript: / vbscript: 协议
// DOMParser 解析本身不执行脚本，处理过程安全；幂等（重复调用无变化）。

/** 确定禁止的标签：脚本执行 / 任意页面嵌入 / 文档基准劫持。 */
const DENY_TAGS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "base",
  "meta",
  "link",
]);

const URL_ATTRS = new Set(["href", "src", "xlink:href"]);

function isDangerousUrl(value: string): boolean {
  return /^\s*(javascript|vbscript):/i.test(value);
}

/**
 * 消毒一段 HTML 片段（body 内容级，非完整文档）。无变化时原样返回同一
 * 字符串引用，调用方可用于变更检测。DOMParser 在 jsdom（测试）与 WebView2
 * 下行为一致。
 */
export function sanitizeExportHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let touched = false;

  const walk = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      if (DENY_TAGS.has(child.tagName.toLowerCase())) {
        child.remove();
        touched = true;
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on")) {
          child.removeAttribute(attr.name);
          touched = true;
        } else if (URL_ATTRS.has(name) && isDangerousUrl(attr.value)) {
          child.removeAttribute(attr.name);
          touched = true;
        }
      }
      walk(child);
    }
  };
  walk(doc.body);

  return touched ? doc.body.innerHTML : html;
}
