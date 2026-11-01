// DE 轮阶段 0 spike ④-B：Word 编辑面独立 Crepe 实例往返稳定性（dev-only）。
//
// 页面上下文执行（CDP eval 或控制台）：
//   await import("/src/dev/deSpikeEdit.ts").then(m => m.runCrepeRoundtrip(html))
// 链路 = 生产候选路径：mammoth HTML → convertHtmlToMarkdown（turndown）→
// 独立 Crepe 实例（offscreen 挂载）→ getHTML → 再转 md → 二次水合 → getHTML，
// 评估往返漂移（内容一致性 / 图片 data URL 存活 / 表格降级）。
// 主编辑器（useMilkdown/Editor.tsx）零接触——本模块只建独立实例。

import { Crepe } from "@milkdown/crepe";
import { getHTML } from "@milkdown/utils";
import { convertHtmlToMarkdown } from "../lib/htmlToMarkdown";

export interface SpikeRoundtripResult {
  htmlInLen: number;
  mdLen: number;
  html1Len: number;
  md2Len: number;
  html2Len: number;
  mdStable: boolean; // md → crepe → getHTML → md 是否逐字稳定
  htmlStable: boolean; // 两次水合的 getHTML 是否逐字稳定
  firstDiff: string | null; // mdStable=false 时的首个差异摘要
  mdSample: string; // md 中表格段（诊断用）
  html1HasTable: boolean;
  html1TableCtx: string;
  imgDataUrlAlive: boolean;
  tableAlive: boolean;
  footnoteAlive: boolean;
  h1Alive: boolean;
  h2Alive: boolean;
  mdHasPipeTable: boolean;
  md3Stable: boolean; // 第二→第三轮 md 是否逐字稳定（幂等收敛）
  timings: { toMd: number; mount1: number; getHtml1: number; mount2: number; getHtml2: number };
}

function firstDiffOf(a: string, b: string): string | null {
  if (a === b) return null;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ctx = 24;
  return `@${i}: [${a.slice(Math.max(0, i - ctx), i + ctx)}] vs [${b.slice(Math.max(0, i - ctx), i + ctx)}]`;
}

function offscreenHost(): HTMLElement {
  const host = document.createElement("div");
  host.setAttribute("data-de-spike-crepe", "");
  host.style.cssText =
    "position:fixed;left:-99999px;top:0;width:820px;height:600px;overflow:hidden;visibility:hidden;";
  document.body.appendChild(host);
  return host;
}

async function mountCrepe(md: string): Promise<{ crepe: Crepe; host: HTMLElement; ms: number }> {
  const host = offscreenHost();
  const t0 = performance.now();
  const crepe = new Crepe({
    root: host,
    defaultValue: md,
    features: {
      [Crepe.Feature.TopBar]: false,
      [Crepe.Feature.Toolbar]: false,
      [Crepe.Feature.AI]: false,
    },
  });
  await crepe.create();
  return { crepe, host, ms: Math.round(performance.now() - t0) };
}

export async function runCrepeRoundtrip(
  htmlIn: string,
  opts?: { unwrapTableCells?: boolean; preprocessAll?: boolean }
): Promise<SpikeRoundtripResult> {
  const r: SpikeRoundtripResult = {
    htmlInLen: htmlIn.length, mdLen: 0, html1Len: 0, md2Len: 0, html2Len: 0,
    mdStable: false, htmlStable: false, firstDiff: null,
    imgDataUrlAlive: false, tableAlive: false, footnoteAlive: false, mdSample: "",
    html1HasTable: false, html1TableCtx: "",
    h1Alive: false, h2Alive: false, mdHasPipeTable: false, md3Stable: false,
    timings: { toMd: 0, mount1: 0, getHtml1: 0, mount2: 0, getHtml2: 0 },
  };
  // 表格预处理（M2 候选）：mammoth 把单元格内容包成 <p>，turndown-gfm 因此
  // 拒绝转 GFM 管道表而保留原始 HTML 表（Crepe 解析 md 时丢弃）。解包后可转。
  function unwrapTableCellParas(html: string): string {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("td p, th p").forEach((p) => {
      const span = document.createElement("span");
      span.innerHTML = p.innerHTML;
      p.replaceWith(span);
    });
    // turndown-gfm 表格规则要求首行为 th——mammoth 输出全是 td，首行提升；
    // GFM 管道表无 colspan/rowspan，各行列数必须一致：截齐/补齐到最大列数
    // （合并单元格降级为平铺——内容不丢，结构扁平化，M2 文案明示）。
    doc.querySelectorAll("table").forEach((t) => {
      const rows = [...t.querySelectorAll("tr")];
      const maxCells = Math.max(0, ...rows.map((r) => r.querySelectorAll("td,th").length));
      rows.forEach((r, ri) => {
        const cells = [...r.querySelectorAll("td,th")];
        while (cells.length > maxCells) { cells.pop()?.remove(); }
        while (r.querySelectorAll("td,th").length < maxCells) {
          const c = document.createElement(ri === 0 ? "th" : "td");
          r.appendChild(c);
        }
        if (ri === 0) {
          r.querySelectorAll("td").forEach((td) => {
            const th = document.createElement("th");
            th.innerHTML = td.innerHTML;
            td.replaceWith(th);
          });
        }
      });
    });
    return doc.body.innerHTML;
  }
  const pre = (h: string): string =>
    opts?.preprocessAll || opts?.unwrapTableCells ? unwrapTableCellParas(h) : h;
  const srcHtml = pre(htmlIn);
  let t0 = performance.now();
  const md = await convertHtmlToMarkdown(srcHtml);
  r.timings.toMd = Math.round(performance.now() - t0);
  r.mdLen = md.length;
  r.mdSample = md.slice(md.indexOf("|") - 20, md.indexOf("|") + 220);

  const i1 = await mountCrepe(md);
  r.timings.mount1 = i1.ms;
  t0 = performance.now();
  const html1 = i1.crepe.editor.action(getHTML());
  r.timings.getHtml1 = Math.round(performance.now() - t0);
  r.html1Len = html1.length;
  r.html1HasTable = /<table/.test(html1);
  if (!r.html1HasTable) {
    const ti = md.indexOf("|");
    r.html1TableCtx = html1.slice(Math.max(0, html1.indexOf("表头横跨两列") - 120), html1.indexOf("表头横跨两列") + 160);
  }

  const md2 = await convertHtmlToMarkdown(pre(html1));
  r.md2Len = md2.length;
  r.mdStable = md === md2;
  r.firstDiff = r.mdStable ? null : firstDiffOf(md, md2);

  const i2 = await mountCrepe(md2);
  r.timings.mount2 = i2.ms;
  t0 = performance.now();
  const html2 = i2.crepe.editor.action(getHTML());
  r.timings.getHtml2 = Math.round(performance.now() - t0);
  r.html2Len = html2.length;
  r.htmlStable = html1 === html2;

  // 第三轮（幂等收敛验证：切走标签再切回不应累积漂移）
  const md3 = await convertHtmlToMarkdown(pre(html2));
  r.md3Stable = md3 === md2;

  r.imgDataUrlAlive = /<img[^>]+src="data:/.test(html2);
  r.tableAlive = /<table/.test(html2);
  r.footnoteAlive = /footnote/i.test(html2);
  r.h1Alive = /<h1/.test(html2);
  r.h2Alive = /<h2/.test(html2);
  r.mdHasPipeTable = /^\|/m.test(md2);

  await i1.crepe.destroy();
  await i2.crepe.destroy();
  i1.host.remove();
  i2.host.remove();
  return r;
}

// 控制台便捷口（挂 window 供 CDP/手测调用）。
(globalThis as unknown as { __deSpikeEdit?: unknown }).__deSpikeEdit = { runCrepeRoundtrip };

// 最小管道表探针：canonical GFM 表在默认 Crepe 配置下能否活到 getHTML。
export async function pipeTableProbe(): Promise<{ tableAlive: boolean; html: string }> {
  const md = "| A | B |\n| --- | --- |\n| 甲 | 乙 |\n";
  const i = await mountCrepe(md);
  const html = i.crepe.editor.action(getHTML());
  await i.crepe.destroy();
  i.host.remove();
  return { tableAlive: /<table/.test(html), html };
}
(globalThis as unknown as { __deSpikeEdit2?: unknown }).__deSpikeEdit2 = { pipeTableProbe };

// 夹具同款管道表探针（空单元格 + CJK 表头）。
export async function fixtureTableProbe(): Promise<{ tableAlive: boolean; html: string }> {
  const md = "| 表头横跨两列 |  |\n| --- | --- |\n| 纵向合并起点 | 右侧单元 1 |\n| 右侧单元 2 |  |\n";
  const i = await mountCrepe(md);
  const html = i.crepe.editor.action(getHTML());
  await i.crepe.destroy();
  i.host.remove();
  return { tableAlive: /<table/.test(html), html };
}
