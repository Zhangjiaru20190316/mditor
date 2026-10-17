// HX 轮 E-H1 定罪（症状：导出 HTML 浏览器打开后滚动锁死）。
// 步骤 1：在 dev 实例里用「与 doExport→exportHtml 完全同源的真源函数」
//   复刻导出链（getHTML → 预处理 → collectThemeCss → sanitize →
//   inlineKatexFonts → wrapHtml），落盘导出文件。
//   与生产唯一差异：不经 pickSaveFile 原生对话框、inlineImages=false
//   （内联图片只改 <img src>，与 CSS/滚动无关——报告已注明）。
// 步骤 2（Node 侧）：文件完整性判别（S-H4 排除）——尾部 </html>、字节
//   大小、首尾内容标记齐全；嫌疑规则 cssText 原文检索（S-H1 静态证据）。
// 产物：perf/results/ex-hx-repro/demo-export.html + ex-hx-html-evidence.json
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT = join(ROOT, "perf", "results", "ex-hx-repro");
mkdirSync(OUT, { recursive: true });
const DOC = join(ROOT, "docs", "demo.md");

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");

// ---- 1. 打开 demo.md 并复刻导出链 ----
const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(DOC)})`);
if (!opened) throw new Error("open(demo.md) failed");
await sleep(6000); // 大文档解析/公式渲染就绪

const t0 = Date.now();
const standalone = await cdp.eval(`(async () => {
  const dbg = window.__exportDebug;
  const raw = dbg.getHTML();
  // —— 镜像 doExport 预处理序（App.tsx :1787-1836）——
  let html = raw;
  if (dbg.isBigDoc()) { try { html = (await import('/src/lib/exportMath.ts')).renderDegradedMath(html).html; } catch {} }
  html = (await import('/src/lib/exportMath.ts')).renderBlockMath(html).html;
  try { html = (await import('/src/lib/wikiLinkExport.ts')).resolveWikiLinksInHtml(html, dbg.docPath()); } catch {}
  try { html = (await import('/src/lib/citationExport.ts')).resolveCitationsForExport(html); } catch {}
  try { html = (await import('/src/lib/flashcardExport.ts')).degradeFlashcardsInHtml(html); } catch {}
  // —— 镜像 exportHtml（exporter.ts :401-433，inlineImages=false 分支）——
  // exporter 加 cache-bust：CDP 侧动态 import 不走 vite HMR 簿记，须强制取
  // 当前源（否则修复后仍复用页面内旧模块，误判修复无效）。
  const { sanitizeExportHtml } = await import('/src/lib/exportSanitize.ts');
  const { wrapHtml } = await import('/src/lib/exporter.ts?t=' + Date.now());
  const { collectThemeCss } = await import('/src/lib/themeCss.ts');
  const sanitized = sanitizeExportHtml(html);
  let css = collectThemeCss();
  if (sanitized.includes('katex')) {
    try { css = await (await import('/src/lib/exportMath.ts')).inlineKatexFonts(css); } catch {}
  }
  const theme = document.documentElement.getAttribute('data-theme') ?? 'light';
  const standalone = wrapHtml(sanitized, css, 'demo', theme);
  // 诊断：收集到的 css 里嫌疑规则的原文与计数
  const findRule = (re) => { const m = css.match(re); return m ? m[0].slice(0, 300) : null; };
  return JSON.stringify({
    standalone,
    rawLen: raw.length,
    sanitizedLen: sanitized.length,
    cssLen: css.length,
    theme,
    ruleBodyOverflow: findRule(/body\\s*\\{[^}]*overflow:\\s*hidden[^}]*\\}/),
    ruleHtmlBodyHeight: findRule(/html,\\s*body,\\s*#root\\s*\\{[^}]*height:\\s*100%[^}]*\\}/),
    sheetCount: document.styleSheets.length,
  });
})()`, { awaitPromise: true, returnByValue: true });
console.log(`export-chain mirror: ${Date.now() - t0}ms`);

const r = JSON.parse(standalone);
const file = join(OUT, "demo-export.html");
writeFileSync(file, r.standalone, "utf8");

// ---- 2. 文件完整性判别（S-H4 排除）----
const s = r.standalone;
const tailOk = /<\/html>\s*$/.test(s.trim());
// 首尾内容标记：文档第一个与最后一个块级标签原文在文件里可见
const firstH = (s.match(/<h1[^>]*>[\s\S]{0,80}?</) || [])[0] ?? null;
const lastText = (() => {
  const body = s.slice(s.indexOf("<body"), s.indexOf("</body>"));
  const texts = body.replace(/<[^>]+>/g, " ").match(/[\u4e00-\u9fa5A-Za-z0-9]{2,}/g) ?? [];
  return texts.length ? texts[texts.length - 1] : null;
})();
const evidence = {
  startedAt: new Date().toISOString(),
  doc: DOC,
  theme: r.theme,
  bytes: Buffer.byteLength(s, "utf8"),
  rawLen: r.rawLen,
  sanitizedLen: r.sanitizedLen,
  cssLen: r.cssLen,
  sheetCount: r.sheetCount,
  // S-H4 判别：全文完整性
  s4_fileTruncation: {
    tailHtmlClosed: tailOk,
    lastVisibleText: lastText,
    headFirstHeading: firstH,
    verdict: tailOk && lastText ? "排除：文件完整，非截断" : "可疑：需人工复核",
  },
  // S-H1 静态证据：致瘫规则原文进文件
  s1_shellRulesInExport: {
    bodyOverflowHidden: r.ruleBodyOverflow,
    htmlBodyHeight100: r.ruleHtmlBodyHeight,
  },
  file: file.replace(/\\\\/g, "/"),
};
writeFileSync(join(OUT, "ex-hx-html-evidence.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
cdp.close();
