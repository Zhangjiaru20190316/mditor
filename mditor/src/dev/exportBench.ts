// 导出性能基准（大文档 × 多公式）——由 perf/mexport.mjs 经 CDP 驱动，仅在
// vite dev 页面内动态 import 运行，不进任何生产路径。
//
// 度量面：
//   * benchMath       —— renderBlockMath / renderDegradedMath / crepe 行内
//                        toDOM 等价路径（编辑器侧公式序列化成本）
//   * benchSanitize   —— sanitizeExportHtml（prepareExportHtml 的主成本）
//   * benchPdf        —— runPdfPipeline 全管线（meta.timings 分阶段）
//
// fixture 用固定种子 PRNG 生成，跨运行逐字节一致（同一文档形态可比）。

import katexCssRaw from "katex/dist/katex.min.css?raw";

/** 工厂 iframe 里字体 URL 基准不同：katex css 的相对 fonts/ 重写到
 *  /node_modules/katex/dist/fonts/（vite dev 静态可达）。 */
function katexCssForFactory(): string {
  return katexCssRaw.replace(
    /url\((['"]?)fonts\//g,
    "url($1/node_modules/katex/dist/fonts/"
  );
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 习题集风格公式语料（分式/求和/积分/极限/矩阵/align，长度分布接近真实）。 */
const LATEX_CORPUS: string[] = [
  "\\dfrac{a+b}{c+d} = \\dfrac{1}{2}",
  "\\sum_{k=1}^{n} k^2 = \\dfrac{n(n+1)(2n+1)}{6}",
  "\\int_{0}^{\\infty} e^{-x^2}\\,dx = \\dfrac{\\sqrt{\\pi}}{2}",
  "\\lim_{x \\to 0} \\dfrac{\\sin x}{x} = 1",
  "f'(x) = 2ax + b",
  "a^2 + b^2 = c^2",
  "\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}",
  "\\mathbf{F} = m\\mathbf{a}",
  "\\frac{\\partial u}{\\partial t} = \\alpha \\nabla^2 u",
  "\\prod_{i=1}^{n} i = n!",
  "\\left| \\int_a^b f(x)\\,dx \\right| \\le \\int_a^b |f(x)|\\,dx",
  "\\ln(xy) = \\ln x + \\ln y",
  "\\binom{n}{k} = \\dfrac{n!}{k!(n-k)!}",
  "\\sum_{n=1}^{\\infty} \\dfrac{1}{n^2} = \\dfrac{\\pi^2}{6}",
  "e^{i\\pi} + 1 = 0",
  "\\tan \\theta = \\dfrac{\\sin \\theta}{\\cos \\theta}",
  "\\nabla \\cdot \\mathbf{E} = \\dfrac{\\rho}{\\varepsilon_0}",
  "\\det(A - \\lambda I) = 0",
  "\\oint_C \\mathbf{F} \\cdot d\\mathbf{r} = 0",
  "y = C_1 e^{\\lambda_1 x} + C_2 e^{\\lambda_2 x}",
  "x_{1,2} = \\dfrac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
  "\\Gamma(n) = (n-1)!",
  "\\iint_D f(x,y)\\,dx\\,dy",
  "\\hat{y} = \\beta_0 + \\beta_1 x + \\varepsilon",
  "\\frac{d}{dx}\\arctan x = \\frac{1}{1+x^2}",
];

const TEXT_CORPUS: string[] = [
  "设函数 $F$ 在区间上连续可微，考察其在不定条件下的一致收敛性质，并证明估计式对任意参数成立。",
  "由归纳假设可知，对一切正整数结论成立；将上式代入递推关系并整理即得所需不等式。",
  "考虑级数的部分和序列，其单调有界，故收敛；记极限为 S，下面估计其余项的衰减速度。",
  "将该方程两边同时微分，代入初始条件后化简，得到关于待定常数的线性方程组。",
  "注意到被积函数在原点附近的奇性，需要分部积分并利用分界线处的匹配条件处理边界项。",
  "对任意给定的正数 ε，存在正整数 N，使得当 n 大于 N 时，偏差不超过 ε，这就完成了证明。",
  "把矩阵按列分块，逐列验证线性无关性，从而系数行列式非零，解的存在唯一性随之确立。",
  "在实际计算中，迭代格式的收敛阶决定了所需步数，二阶方法在精度与代价之间取得较好的平衡。",
];

export interface FixtureOptions {
  blocks?: number;
  /** 行内:块级 公式条数比中的块级占比（0.2 = 每 5 条公式 1 条块级）。 */
  displayRatio?: number;
  /** 重复率：公式抽取时复用语料的比例（习题集真实形态）。 */
  dupRatio?: number;
  seed?: number;
}

export interface Fixture {
  html: string;
  degradedHtml: string;
  counts: { inline: number; display: number; blocks: number };
}

/** 生成「编辑器 getHTML 后」形态的导出 HTML。 */
export function buildFixture(o: FixtureOptions = {}): Fixture {
  const blocks = o.blocks ?? 500;
  const displayRatio = o.displayRatio ?? 0.2;
  const dupRatio = o.dupRatio ?? 0.4;
  const rnd = mulberry32(o.seed ?? 20261028);
  const pickLatex = (): string => {
    if (rnd() < dupRatio && used.length > 0) {
      return used[(rnd() * used.length) | 0];
    }
    const s = LATEX_CORPUS[(rnd() * LATEX_CORPUS.length) | 0];
    used.push(s);
    return s;
  };
  const used: string[] = [];
  const parts: string[] = [];
  const dParts: string[] = [];
  let inline = 0;
  let display = 0;
  for (let i = 0; i < blocks; i++) {
    if (i % 15 === 0) {
      parts.push(`<h2>${(i / 15 + 1)}.${i}. 章节标题：级数与微分方程</h2>`);
      dParts.push(`<h2>${(i / 15 + 1)}.${i}. 章节标题：级数与微分方程</h2>`);
      continue;
    }
    const r = rnd();
    if (r < displayRatio) {
      // 块级公式：编辑器序列化为 <pre data-language="LaTeX"><code>源码</code></pre>
      const latex = pickLatex() + `\\label{eq:${display}}`;
      parts.push(
        `<pre data-language="LaTeX"><code>${latex
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</code></pre>`
      );
      dParts.push(`<p>$$${latex}$$</p>`);
      display++;
      continue;
    }
    // 文本段：语料句 + 1~3 个行内公式（编辑器形态 = toDOM 已渲染 katex）。
    const para = TEXT_CORPUS[(rnd() * TEXT_CORPUS.length) | 0];
    const nInline = 1 + ((rnd() * 3) | 0);
    const pieces: string[] = [];
    const dPieces: string[] = [];
    let cursor = 0;
    for (let k = 0; k < nInline; k++) {
      const at = para.indexOf("$", cursor);
      const pos = at < 0 ? cursor : at;
      pieces.push(para.slice(cursor, pos));
      dPieces.push(para.slice(cursor, pos));
      const latex = pickLatex();
      pieces.push(
        `<span data-type="math_inline" data-value="${latex.replace(/"/g, "&quot;")}">${katexRenderToString(
          latex
        )}</span>`
      );
      dPieces.push(`$${latex}$`);
      inline++;
      cursor = pos;
      if (at < 0) break;
    }
    pieces.push(para.slice(cursor));
    dPieces.push(para.slice(cursor));
    parts.push(`<p>${pieces.join("")}</p>`);
    dParts.push(`<p>${dPieces.join("")}</p>`);
  }
  return {
    html: parts.join("\n"),
    degradedHtml: dParts.join("\n"),
    counts: { inline, display, blocks },
  };
}

import katex from "katex";
function katexRenderToString(src: string): string {
  return katex.renderToString(src, { throwOnError: false, displayMode: false });
}

// ---- 页面接口（CDP Runtime.evaluate 调用）----------------------------------

const w = window as unknown as {
  __mexport?: Record<string, unknown>;
};

async function benchMath(fixture: Fixture, reps = 3): Promise<Record<string, number>> {
  const { renderBlockMath, renderDegradedMath } = await import(
    "../lib/exportMath"
  );
  const out: Record<string, number> = {};
  const time = async (name: string, fn: () => unknown): Promise<void> => {
    let best = Infinity;
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      fn();
      const dt = performance.now() - t0;
      if (dt < best) best = dt;
    }
    out[name] = Math.round(best * 10) / 10;
  };
  await time("renderBlockMath", () => renderBlockMath(fixture.html));
  await time("renderDegradedMath", () =>
    renderDegradedMath(fixture.degradedHtml)
  );
  return out;
}

async function benchSanitize(html: string, reps = 3): Promise<number> {
  const { sanitizeExportHtml } = await import("../lib/exportSanitize");
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    sanitizeExportHtml(html);
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  return Math.round(best * 10) / 10;
}

export interface PdfBenchOptions {
  mode?: "vector" | "raster";
  rasterScale?: number;
  textLayer?: boolean;
  /** 落盘页数上限（onPagePng dataURL 收集，驱动侧写文件做像素对比）。 */
  dumpPages?: number;
}

async function benchPdf(
  html: string,
  o: PdfBenchOptions = {}
): Promise<Record<string, unknown>> {
  const { runPdfPipeline } = await import("../lib/exportPdfPipeline");
  // 视觉回归：onPagePng 逐页 SHA-256（矢量模式 = 底色+补丁合成视图；
  // 位图模式 = 整页位图）。跨迭代对比哈希序列，任何渲染差异立刻暴露。
  const pageHashes: string[] = [];
  const pageDumps: string[] = [];
  const onPagePng = (index: number, dataUrl: string): void => {
    if (o.dumpPages !== undefined && index < o.dumpPages) pageDumps[index] = dataUrl;
    const bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    void crypto.subtle.digest("SHA-256", bytes).then((ab) => {
      const arr = new Uint8Array(ab);
      let hex = "";
      for (const b of arr) hex += b.toString(16).padStart(2, "0");
      pageHashes[index] = hex.slice(0, 16);
    });
  };
  // 大 dataURL 不随结果整体回传（CDP returnByValue 大负载挂死）——挂到
  // window，驱动逐页取。
  (window as unknown as { __lastPdfDumps?: string[] }).__lastPdfDumps = pageDumps;
  const t0 = performance.now();
  const r = await runPdfPipeline(html, katexCssForFactory(), {
    mode: o.mode ?? "vector",
    rasterScale: o.rasterScale ?? 2,
    textLayer: o.textLayer ?? true,
    onPagePng,
  });
  const wall = performance.now() - t0;
  // 等哈希收尾（digest 异步）。
  await new Promise((res) => setTimeout(res, 50));
  return {
    wallMs: Math.round(wall),
    timings: r.meta.timings,
    pages: r.meta.pages,
    bytes: r.bytes.length,
    pageHashes,
    dumpCount: pageDumps.length,
    patchPlan: r.meta.patchPlan,
    textPlan: r.meta.textPlan
      ? {
          totalChars: r.meta.textPlan.totalChars,
          vectorChars: r.meta.textPlan.vectorChars,
          shadowChars: r.meta.textPlan.shadowChars,
          reasons: r.meta.textPlan.reasons,
        }
      : null,
    vectorMode: r.meta.vectorMode,
    vectorFallback: r.meta.vectorFallback ?? null,
    assemble: r.meta.assemble,
  };
}

w.__mexport = {
  buildFixture,
  benchMath,
  benchSanitize,
  benchPdf,
  katexCssForFactory,
  /** 探针用：行内/块级 KaTeX 渲染（浏览器侧裸 katex 不可直接动态 import）。 */
  renderKatexToString: katexRenderToString,
};
