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

// ---------------------------------------------------------------------------
// 减配档公式补渲染（EX 轮 Fix-D4，RC-5 修复）。
//
// 「大文档性能模式」总开关开 + 超阈值时 Crepe 以 [Latex]: !big 建实例——
// 公式在 ProseMirror 模型里就是普通文本，getHTML() 输出 $/$$ 源码，且
// renderBlockMath 的 PRE_RE（只认 <pre data-language="LaTeX">）匹配不到，
// PDF/HTML/DOCX 全格式覆没（定罪数据 ex-phase1-rc5：katex 231→0、$
// 源码 3→4713）。本函数在导出前把序列化 HTML 里的 $ 文本补渲染为与
// 非减配档逐形态一致的 KaTeX 标记：
//   * 行内 $x$   → <span data-type="math_inline" data-value="x">katex…
//     （与 Crepe math_inline toDOM 同形：katex.render 无宏——编辑器行内
//     公式本就不并应用户宏，导出保持一致）
//   * 整段 $$…$$ → <div class="md-math-block">katex…（renderBlockMath 产物
//     同形，含 \label/\ref 编号共享管线）；段落内嵌 $$ 片段用 span 级包装
//     （div 进 <p> 会在再解析时撕裂结构）。
//
// 定界规则镜像 remark-math v6 + remarkMathGuard 的合成语义（编辑器非减配
// 档的真实行为）：开定界后无空白、闭定界前无空白、内容无 $（内部换行合
// 法——段内软换行属于公式）、\$ 转义不算定界、闭 $ 后紧跟数字 → 价格区间
// 形态降级回字面；code/pre 与已渲染 katex 子树跳过。仅当编辑器确在减配档
// 时调用（App 侧以 handle.isBigDoc() 门控）——普通文档的合法 $ 字面（货币
// 等）不受影响。

export interface DegradedMathResult {
  html: string;
  renderedInline: number;
  renderedBlock: number;
}

/** 这些子树里的 $ 是合法字面（代码）或已渲染产物，不做补渲染。 */
const MATH_SKIP_TAGS = new Set(["PRE", "CODE", "SCRIPT", "STYLE", "TEXTAREA", "KBD"]);

/** 内联扫描不跨块边界（remark-math 的公式是段落级内联构造）。 */
const INLINE_BLOCK_TAGS = new Set([
  "P", "DIV", "UL", "OL", "LI", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH",
  "BLOCKQUOTE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "DL", "DT", "DD",
  "FIGURE", "FIGCAPTION", "SECTION", "ARTICLE", "ASIDE", "DETAILS", "SUMMARY",
]);

/** 逻辑串里的屏障占位（code/pre/块边界/已渲染 katex 子树）：文本里不会出现
 *  NUL，匹配内容含它即拒绝——公式不跨这些子树。 */
const BARRIER = "\u0000";

interface FormulaMatch {
  start: number;
  end: number;
  latex: string;
  display: boolean;
}

/** 逻辑串 → 公式匹配区间列表。定界规则镜像 remark-math v6 +
 *  remarkMathGuard 合成语义：\$ 转义 > $$（display 片段）> $（行内）；
 *  开定界后无空白、闭定界前无空白、内容无 $ 但允许内部换行（段内软换行
 *  属于公式）；闭 $ 后紧跟数字 → 价格区间形态降级回字面。 */
function scanFormulas(text: string): FormulaMatch[] {
  const out: FormulaMatch[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "$") {
      i += 2;
      continue;
    }
    if (ch !== "$") {
      i++;
      continue;
    }
    if (text[i + 1] === "$") {
      // display 片段：$$内容$$（内容非空、无 $ 无换行——跨行块级走整段通道）。
      const m = /^([^$\n]+)\$\$/.exec(text.slice(i + 2));
      if (m && !m[1].includes(BARRIER)) {
        out.push({ start: i, end: i + 2 + m[0].length, latex: m[1], display: true });
        i += 2 + m[0].length;
        continue;
      }
      i++;
      continue;
    }
    // 行内定界：内容无 $（内部空白/换行合法），闭前无空白，闭后非数字。
    const rest = text.slice(i + 1);
    const m = /^([^\s$][^$]*?)\$/.exec(rest);
    if (m) {
      const latex = m[1];
      const afterClose = rest[m[0].length] ?? "";
      if (
        !/\s$/.test(latex) &&
        !latex.includes(BARRIER) &&
        !(afterClose >= "0" && afterClose <= "9")
      ) {
        out.push({ start: i, end: i + 1 + m[0].length, latex, display: false });
        i += 1 + m[0].length;
        continue;
      }
    }
    i++;
  }
  return out;
}

type Unit =
  | { kind: "text"; node: Text; text: string }
  | { kind: "br" }
  | { kind: "barrier" };

/** 容器的内联逻辑串单元：文本节点直接入列，透明内联元素（em/strong/a/
 *  sub/sup…——remark 里它们与公式同层，公式内容可跨它们）DFS 展开，<br>
 *  记为换行，code/pre/块级/katex 子记为屏障。 */
function collectUnits(el: Element): Unit[] {
  const units: Unit[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      units.push({ kind: "text", node: n as Text, text: n.nodeValue ?? "" });
      return;
    }
    if (n.nodeType !== 1) return;
    const e = n as Element;
    if (e.tagName === "BR") {
      units.push({ kind: "br" });
      return;
    }
    if (
      MATH_SKIP_TAGS.has(e.tagName) ||
      INLINE_BLOCK_TAGS.has(e.tagName) ||
      e.classList.contains("katex")
    ) {
      units.push({ kind: "barrier" });
      return;
    }
    for (const c of Array.from(e.childNodes)) walk(c);
  };
  for (const c of Array.from(el.childNodes)) walk(c);
  return units;
}

/** 把匹配区间经 Range 手术替换为 KaTeX 节点（右到左——早先区间不受后续
 *  删除影响，捕获的节点引用保持有效）。 */
function applyFormulas(
  doc: Document,
  units: Unit[],
  matches: FormulaMatch[],
  stats: { inline: number; block: number }
): void {
  const lens = units.map((u) => (u.kind === "text" ? u.text.length : 1));
  const locate = (pos: number): [Text, number] | null => {
    let acc = 0;
    for (let j = 0; j < units.length; j++) {
      if (pos < acc + lens[j]) {
        const u = units[j];
        return u.kind === "text" ? [u.node, pos - acc] : null;
      }
      acc += lens[j];
    }
    return null;
  };
  for (let k = matches.length - 1; k >= 0; k--) {
    const { start, end, latex, display } = matches[k];
    const s = locate(start);
    const e = locate(end - 1); // 末字符所在节点；+1 把闭定界包进区间
    if (!s || !e) continue;
    try {
      const host = doc.createElement(display ? "span" : "span");
      if (display) host.setAttribute("class", "md-math-block");
      else {
        host.setAttribute("data-type", "math_inline");
        host.setAttribute("data-value", latex);
      }
      host.innerHTML = katex.renderToString(latex, {
        displayMode: display,
        throwOnError: false,
      });
      const rng = doc.createRange();
      rng.setStart(s[0], s[1]);
      rng.setEnd(e[0], e[1] + 1);
      rng.deleteContents();
      rng.insertNode(host);
      if (display) stats.block++;
      else stats.inline++;
    } catch {
      /* 渲染异常走字面保留 */
    }
  }
}

export function renderDegradedMath(html: string): DegradedMathResult {
  if (!html.includes("$")) return { html, renderedInline: 0, renderedBlock: 0 };
  const doc = new DOMParser().parseFromString(html, "text/html");
  const stats = { inline: 0, block: 0 };

  // ---- 块级：整段 $$…$$ 的块元素 → div.md-math-block（含编号管线）----
  const blockLatex: string[] = [];
  const blockHosts: Element[] = [];
  const blockLike = [...doc.body.querySelectorAll("p, li, td, th, div")];
  for (const el of blockLike) {
    // 宿主必须是「纯显示公式段」：整段文本被一对 $$ 包住（前后允许空白）。
    if (el.querySelector("pre, code, .katex")) continue;
    const t = el.textContent?.trim() ?? "";
    if (!(t.startsWith("$$") && t.endsWith("$$") && t.length >= 4)) continue;
    if (t.slice(2, -2).includes("$$")) continue; // 段内多于一对 → 非纯显示段
    blockLatex.push(t.slice(2, -2));
    blockHosts.push(el);
  }
  if (blockLatex.length > 0) {
    const { autoNumber, macros } = getMathRenderConfig();
    const metas = blockLatex.map((l) => harvestMathMeta(l));
    const assignment = assignNumbers(metas, autoNumber);
    blockHosts.forEach((host, i) => {
      let latex = resolveRefsInLatex(metas[i].latex, assignment.labelMap);
      if (assignment.autoTagIndexes.has(i) && assignment.numbers[i] !== null) {
        latex = injectAutoTag(latex, assignment.numbers[i]!);
      }
      const div = doc.createElement("div");
      div.setAttribute("class", "md-math-block");
      try {
        div.innerHTML = katex.renderToString(latex, {
          displayMode: true,
          throwOnError: false,
          macros: { ...macros },
        });
        host.replaceWith(div);
        stats.block++;
      } catch {
        /* 渲染失败保留原段（源码可见） */
      }
    });
    // 正文 \ref 解析（跳过 pre/code——与 renderBlockMath 第三遍同规则）。
    if (assignment.labelMap.size > 0) {
      const out = doc.body.innerHTML.replace(
        REF_SCAN_RE,
        (whole, key: string | undefined) => {
          if (key === undefined) return whole;
          const n = assignment.labelMap.get(key);
          if (n === undefined) return whole;
          return whole.startsWith("\\eqref") ? `(${n})` : n;
        }
      );
      doc.body.innerHTML = out;
    }
  }

  // ---- 行内：按块容器扫逻辑串（块级替换后再扫，$$ 残段按行内规则兜底）。
  // 减配档的公式源码会被内联标记撕碎——commonmark 先于公式把公式内的 `*`
  // 解析成 <em>（fixture 实证：$\dfrac{1-\mathbf{1}<em>{3\mid n}}{n}$），逐
  // 文本节点处理会漏——逻辑串把透明内联元素拼平后再匹配，Range 手术跨元
  // 素替换。定界符在 code/pre/块边界两侧不配对（屏障）。
  const containers = [
    ...doc.body.querySelectorAll(
      "p, li, td, th, div, h1, h2, h3, h4, h5, h6, blockquote, dt, dd, figcaption"
    ),
  ];
  for (const el of containers) {
    if (!el.textContent?.includes("$")) continue;
    const units = collectUnits(el);
    const logical = units
      .map((u) => (u.kind === "text" ? u.text : u.kind === "br" ? "\n" : BARRIER))
      .join("");
    if (!logical.includes("$")) continue;
    const matches = scanFormulas(logical);
    if (matches.length > 0) applyFormulas(doc, units, matches, stats);
  }

  if (stats.inline === 0 && stats.block === 0) return { html, renderedInline: 0, renderedBlock: 0 };
  return { html: doc.body.innerHTML, renderedInline: stats.inline, renderedBlock: stats.block };
}

const KATEX_WOFF2_RE = /url\(\s*["']?([^"')]*KaTeX[^"')]*\.woff2[^"')]*)["']?\s*\)/g;

/**
 * 独立 HTML 导出：把 CSS 里引用的 KaTeX woff2 字体内嵌为 base64 data URL。
 * 导出文件在磁盘上打开时，CSS 里的字体相对/绝对路径都会失效，公式会退化到回退字
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
