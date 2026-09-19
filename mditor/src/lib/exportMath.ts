// 导出路径的公式修复（v4.6）。
//
// 背景：块级公式（$$...$$）在 ProseMirror 里是 code_block(language=LaTeX)，
// getHTML() 按 preset-commonmark 的 toDOM 序列化为
// `<pre data-language="LaTeX"><code>原始 LaTeX 源码</code></pre>`——导出的
// HTML/PDF/DOCX 里块级公式因此一直是一段代码而不是渲染结果（行内公式反而
// 正常，math_inline 的 toDOM 直接内嵌了 KaTeX 标记）。
//
// 本模块在导出前把编辑器 HTML 里的这类 <pre> 再渲染为 KaTeX HTML：
//   * renderBlockMath —— 纯字符串实现（node 测试环境可直跑）：编号核心
//     （lib/mathNumbering，与静态管线共享）→ katex.renderToString → 替换；
//     随后做全文 \ref/\eqref 解析（跳过 pre/code 区段）。
//   * rasterizeFormulas —— DOM 实现：把公式逐个离屏栅格化为 PNG（Word 渲
//     染不了 KaTeX 的 CSS 布局，栅格化是 DOCX/复制富文本唯一高保真方案）。
//   * inlineKatexFonts —— 独立 HTML 导出时把 KaTeX woff2 字体内嵌为 base64
//     （导出文件里相对/绝对字体路径都失效）。

import katex from "katex";
import { getMathRenderConfig } from "./mathConfig";
import {
  assignNumbers,
  harvestMathMeta,
  injectAutoTag,
  resolveRefsInLatex,
} from "./mathNumbering";

export interface BlockMathResult {
  html: string;
  /** 文档是否含公式（决定是否需要内嵌字体 / 栅格化等后续处理）。 */
  hasMath: boolean;
}

// 编辑器序列化的代码块（含公式块）。lang 大小写不敏感：math 块固定写
// "LaTeX"，用户手写的 ```latex 围栏在编辑器里也会被 blockLatexSchema 当作
// 公式块（toMarkdown 对 latex 不分大小写），序列化时保留原大小写。
const PRE_RE = /<pre data-language="([^"]*)"[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/g;

// 全文 \ref/\eqref 扫描：pre/code 整段跳过（演示语法的样例保持字面），
// 其余位置的引用替换为编号文本。
const REF_SCAN_RE = /<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>|\\(?:eq)?ref\{([^{}]*)\}/g;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&"); // &amp; 必须最后（避免二次解码）
}

/**
 * 把导出 HTML 里的块级公式 <pre> 再渲染为 KaTeX HTML（display 模式）。
 * 无公式时原样返回。配置（自动编号 / 宏）来自 lib/mathConfig（useSettings
 * 同步维护）。
 */
export function renderBlockMath(html: string): BlockMathResult {
  if (!html.includes("data-language=")) {
    return { html, hasMath: html.includes("katex") };
  }
  const { autoNumber, macros } = getMathRenderConfig();

  // 第一遍：收集公式源码，做编号分配（\ref 可能出现在公式之前，必须先有
  // 全文 label→编号映射才能替换）。
  const blocks: { latex: string; number: string | null; autoTag: boolean }[] = [];
  for (const m of html.matchAll(PRE_RE)) {
    const lang = m[1].trim().toLowerCase();
    if (lang !== "latex") continue;
    blocks.push({ latex: decodeHtmlEntities(m[2]), number: null, autoTag: false });
  }
  if (blocks.length === 0) {
    return { html, hasMath: html.includes("katex") };
  }

  const metas = blocks.map((b) => harvestMathMeta(b.latex));
  const assignment = assignNumbers(metas, autoNumber);
  for (let i = 0; i < blocks.length; i++) {
    blocks[i].number = assignment.numbers[i];
    blocks[i].autoTag = assignment.autoTagIndexes.has(i);
  }

  // 第二遍：逐个渲染并替换（用剥除 \label 后的源码——metas 里才是净化结
  // 果，blocks[i].latex 是原始串）。
  let idx = 0;
  const replaced = html.replace(PRE_RE, (whole, lang: string) => {
    if (lang.trim().toLowerCase() !== "latex") return whole;
    const i = idx++;
    let latex = resolveRefsInLatex(metas[i].latex, assignment.labelMap);
    if (blocks[i].autoTag && blocks[i].number !== null) {
      latex = injectAutoTag(latex, blocks[i].number);
    }
    try {
      const katexHtml = katex.renderToString(latex, {
        displayMode: true,
        throwOnError: false,
        macros: { ...macros },
      });
      return `<div class="md-math-block">${katexHtml}</div>`;
    } catch {
      return whole; // 极端解析失败：保留原 <pre>（至少源码可见）
    }
  });

  // 第三遍：正文文本里的 \ref{key} / \eqref{key} → 编号 / (编号)。
  let out = replaced;
  if (assignment.labelMap.size > 0) {
    out = replaced.replace(REF_SCAN_RE, (whole, key: string | undefined) => {
      if (key === undefined) return whole; // pre/code 区段
      const n = assignment.labelMap.get(key);
      if (n === undefined) return whole;
      return whole.startsWith("\\eqref") ? `(${n})` : n;
    });
  }

  return { html: out, hasMath: true };
}

/**
 * 把导出 HTML 里的公式（块级 .md-math-block + 行内 math_inline）逐个栅格化
 * 为 PNG <img>（DOCX / 复制富文本用——Word 无法渲染 KaTeX 的 CSS 布局）。
 * 单个公式失败保留原标记；Word 页面白底，公式文字强制深色（暗色主题下导
 * 出不至于得到一片空白）。onProgress 用于导出进度提示。
 */
export async function rasterizeFormulas(
  html: string,
  onProgress?: (done: number, total: number) => void
): Promise<string> {
  // S10：栅格化容器 innerHTML 前同样过兜底消毒（幂等——调用方已消毒时无变化）。
  const { sanitizeExportHtml } = await import("./exportSanitize");
  const safe = sanitizeExportHtml(html);
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-99999px;top:0;";
  host.innerHTML = safe;
  document.body.appendChild(host);
  try {
    if (document.fonts?.ready) await document.fonts.ready;
    const nodes = Array.from(
      host.querySelectorAll<HTMLElement>(".md-math-block, span[data-type='math_inline']")
    );
    if (nodes.length === 0) return html;
    const { domToPng } = await import("modern-screenshot");
    let done = 0;
    for (const node of nodes) {
      node.style.color = "#111111"; // 白底文档里的公式文字
      const w = Math.max(1, Math.round(node.offsetWidth));
      const h = Math.max(1, Math.round(node.offsetHeight));
      try {
        const dataUrl = await domToPng(node, {
          scale: 3, // 3 倍采样：打印/缩放仍清晰
          backgroundColor: "#ffffff",
          width: w,
          height: h,
        });
        const img = document.createElement("img");
        img.src = dataUrl;
        img.alt = "公式";
        img.width = w;
        img.height = h;
        img.style.verticalAlign = "middle";
        node.replaceWith(img);
      } catch {
        /* 单式栅格化失败：保留 KaTeX HTML（Word 里近似线性展示） */
      }
      done++;
      onProgress?.(done, nodes.length);
    }
    return host.innerHTML;
  } finally {
    host.remove();
  }
}

const KATEX_WOFF2_RE = /url\(\s*["']?([^"')]*KaTeX[^"')]*\.woff2[^"')]*)["']?\s*\)/g;

/**
 * 独立 HTML 导出：把 CSS 里引用的 KaTeX woff2 字体内嵌为 base64 data URL。
 * 导出文件在磁盘上打开时，字体相对/绝对路径都会失效，公式会退化到回退字
 * 体（布局错乱）。只内嵌 woff2（@font-face src 列表的第一候选，现代浏览器
 * 与 WebView 全部支持；woff/ttf 候选留在原样，不会被用到）。仅读取同源
 * 资源；读取失败的引用保持原样（字体退化但导出仍完成）。
 */
export async function inlineKatexFonts(css: string): Promise<string> {
  const urls = new Set<string>();
  for (const m of css.matchAll(KATEX_WOFF2_RE)) urls.add(m[1]);
  if (urls.size === 0) return css;
  const dataUrls = new Map<string, string>();
  for (const u of urls) {
    try {
      const abs = new URL(u, document.baseURI);
      // 只内嵌本应用打包产物（同源 assets），外部字体引用不动。
      if (abs.origin !== window.location.origin) continue;
      const res = await window.fetch(abs.href);
      if (!res.ok) continue;
      const blob = await res.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      });
      dataUrls.set(u, dataUrl);
    } catch {
      /* 读取失败：保留原引用 */
    }
  }
  if (dataUrls.size === 0) return css;
  return css.replace(KATEX_WOFF2_RE, (whole, u: string) => {
    const d = dataUrls.get(u);
    return d ? `url("${d}")` : whole;
  });
}
