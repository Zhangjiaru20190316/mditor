// DX 轮：@turbodocx/html-to-docx 深路径 browser 构建的类型垫片（untyped
// ESM，包类型只声明了主入口）。加载点：exporterDocxBrowserBuild.test.ts
// ——根因回归测试直驱 webview 实际加载的那份构建（exports.browser 条件）。
// 签名与主入口 HTMLtoDOCX 一致（html, headerHTML, documentOptions, footerHTML）。
declare module "@turbodocx/html-to-docx/dist/html-to-docx.browser.esm.js" {
  const htmlToDocx: (
    html: string,
    header: string | null,
    opts?: Record<string, unknown>
  ) => Promise<Uint8Array>;
  export default htmlToDocx;
}
