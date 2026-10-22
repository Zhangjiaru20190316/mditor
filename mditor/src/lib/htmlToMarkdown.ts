// HN 轮阶段 2：HTML → Markdown 转换（可选工具，不是导入路径）。
//
// 铁律遵守：
//   * DOMParser 先剥除 script/style/noscript/template——转换的是内容文档，
//     交互脚本天然不进入产物；
//   * 预览必须走 renderMarkdown 现有管线（rehype-sanitize 白名单）后才进
//     主 DOM（调用方负责）；
//   * 确认后另存为 .md，原 HTML 笔记不动。
// turndown / gfm 插件惰性 import——转换是低频操作，不进主包。

/** 把 HTML 文档转换为 Markdown（纯函数；DOMParser 不执行脚本）。 */
export async function convertHtmlToMarkdown(html: string): Promise<string> {
  const [{ default: TurndownService }, gfmMod] = await Promise.all([
    import("turndown"),
    // @ts-expect-error turndown-plugin-gfm 无官方类型包（npm 无 @types）；
    // 运行时导出 { gfm }（见其 README），下方经断言取用。
    import("turndown-plugin-gfm"),
  ]);
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
  });
  const gfm = (gfmMod as unknown as { gfm: (service: typeof td) => void }).gfm;
  td.use(gfm);
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll("script,style,noscript,template")
    .forEach((el) => el.remove());
  // turndown-plugin-gfm 的表格规则对「无单元格的空表」（如脚本占位的
  // <table><tbody></tbody></table>）会崩溃（isHeadingRow 读 parentNode）；
  // 空表不承载内容，转换前剥除（内容无损）。
  doc.querySelectorAll("table").forEach((t) => {
    if (!t.querySelector("td,th")) t.remove();
  });
  const md = td.turndown(doc.body ?? doc.createElement("body"));
  return md.trim() + "\n";
}
