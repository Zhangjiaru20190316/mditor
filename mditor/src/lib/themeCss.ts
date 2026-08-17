// 导出/复制富文本时收集当前主题 CSS —— 从 App.tsx 抽出的纯 DOM 工具。
// 按 (当前主题, 样式表数量) 缓存：重复导出 / 复制富文本不再重算整段 cssText；
// 主题切换（懒加载新增 link 使 styleSheets.length 变化）或任何样式表增删
// 会令缓存自动失效。

let themeCssCache: { theme: string; sheetCount: number; css: string } | null = null;

export function collectThemeCss(): string {
  const theme = document.documentElement.getAttribute("data-theme") ?? "light";
  const sheetCount = document.styleSheets.length;
  if (
    themeCssCache &&
    themeCssCache.theme === theme &&
    themeCssCache.sheetCount === sheetCount
  ) {
    return themeCssCache.css;
  }
  let css = "";
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const href = sheet.href ?? "";
      // Collect our own bundled CSS (Vite emits under /assets/) plus any inline
      // (<style>) sheets — these carry the prose/theme/annotation/KaTeX/hljs
      // rules the exported document needs to look right. Cross-origin sheets
      // (fonts etc.) are skipped by the catch below.
      if (!href || href.includes("/assets/")) {
        for (const rule of Array.from(sheet.cssRules)) css += rule.cssText + "\n";
      }
    } catch {
      // cross-origin sheet; skip
    }
  }
  themeCssCache = { theme, sheetCount, css };
  return css;
}
