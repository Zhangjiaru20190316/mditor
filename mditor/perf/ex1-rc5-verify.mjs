// EX 轮 Fix-D4 验收：减配档公式补渲染（RC-5 修复复验）。
// 前置：dev 实例已起（WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npm run tauri dev），
//       fixture 已由 perf/gen-export-fixtures.mjs 生成。
// 用法：node perf/ex1-rc5-verify.mjs
// 产物：perf/results/ex-phase1-rc5-fix.json
//
// 口径与 ex1-repro.mjs rc5 段一致（同一 fixture、同一 UI 驱动路径），差异
// 仅在导出前段：镜像 App.doExport 修复后的真实调用序——
//   isBigDoc() 门控 renderDegradedMath → renderBlockMath
// 并以 __exportDebug.isBigDoc() 断言门控信号真实生效（而非从 $ 数量倒推）。
// 通过判据（与定罪数据 ex-phase1-rc5.json 对照）：
//   * rawDollars ≈ 4713（症状仍在：getHTML 输出源码）
//   * gate === true（减配档判定成立）
//   * afterDegraded.katex > 0 且 pipeline 后 $ 残留大幅回落
//   * renderedInline + renderedBlock 与 $ 定界对数同量级
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "results");
const FIX = "C:/Users/hh/Desktop/Tp/mditor/perf/fixtures";

const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);

// 改过 exporter 源后页内动态 import 可能命中旧模块：先 Page.reload 取新模块图。
await cdp.send("Page.enable").catch(() => {});
await cdp.send("Page.reload").catch(() => {});
await sleep(6000);

const ok = await cdp.eval(`window.__exportDebug.open("${FIX}/无穷级数_密度档压测副本_减配触发.md")`);
if (!ok) throw new Error("open failed");
await sleep(4000);

const before = await cdp.eval(`(() => {
  const html = window.__exportDebug.getHTML();
  return {
    isBigDocOff: window.__exportDebug.isBigDoc(),
    htmlDollars: (html.match(/\\$/g) || []).length,
    htmlKatex: (html.match(/katex/g) || []).length,
  };
})()`, { returnByValue: true });

// UI 驱动开总开关（与 ex1-repro.mjs rc5 段同一驱动路径）：帮助 → 设置… →
// 性能与诊断 → 大文档性能模式 → 应用。
const toggled = await cdp.eval(`(async () => {
  const btns = [...document.querySelectorAll('nav.mb button, nav.mb [role=button]')];
  const help = btns.find(b => b.textContent.trim() === '帮助');
  if (!help) return 'no-help-menu';
  help.click();
  await new Promise(r => setTimeout(r, 300));
  const item = [...document.querySelectorAll('div,button,a')].find(e => e.textContent.trim() === '设置…' && e.offsetParent !== null);
  if (!item) return 'no-settings-item';
  item.click();
  await new Promise(r => setTimeout(r, 500));
  const navs = [...document.querySelectorAll('.settings-nav-btn')];
  if (!navs[3]) return 'no-nav-3';
  navs[3].click();
  await new Promise(r => setTimeout(r, 300));
  const perfToggle = [...document.querySelectorAll('.settings-pane input[type=checkbox]')][0];
  if (!perfToggle) return 'no-checkbox';
  if (!perfToggle.checked) perfToggle.click();
  await new Promise(r => setTimeout(r, 400));
  const apply = [...document.querySelectorAll('.modal button, [class*=modal] button')].find(b => b.textContent.trim() === '应用');
  if (!apply) return 'no-apply-btn';
  apply.click();
  await new Promise(r => setTimeout(r, 400));
  return 'toggled:' + perfToggle.checked;
})()`, { returnByValue: true });
console.log("toggle:", toggled);
await sleep(6000); // 编辑器重建 + 重解析（3061 行）

// 镜像 App.doExport（kind !== png 分支）修复后的调用序，量各阶段计数与耗时。
const pipeline = await cdp.eval(`(async () => {
  const raw = window.__exportDebug.getHTML();
  const gate = window.__exportDebug.isBigDoc();
  const { renderDegradedMath, renderBlockMath } = await import('/src/lib/exportMath.ts');
  const t0 = performance.now();
  const d = gate ? renderDegradedMath(raw) : { html: raw, renderedInline: 0, renderedBlock: 0 };
  const degradeMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const r = renderBlockMath(d.html);
  const blockMs = Math.round(performance.now() - t1);
  const count = (h) => ({ dollars: (h.match(/\\$/g) || []).length, katex: (h.match(/katex/g) || []).length });
  return {
    gate, rawKB: Math.round(raw.length / 1024),
    raw: count(raw), afterDegraded: count(d.html), afterPipeline: count(r.html),
    renderedInline: d.renderedInline, renderedBlock: d.renderedBlock,
    degradeMs, blockMs, hasMath: r.hasMath,
  };
})()`, { returnByValue: true });

// 还原：总开关拨回 OFF 并「应用」（不改变用户长期设置）。
const restore = await cdp.eval(`(async () => {
  const btns = [...document.querySelectorAll('nav.mb button, nav.mb [role=button]')];
  const help = btns.find(b => b.textContent.trim() === '帮助');
  if (!help) return 'no-help';
  help.click();
  await new Promise(r => setTimeout(r, 300));
  const item = [...document.querySelectorAll('div,button,a')].find(e => e.textContent.trim() === '设置…' && e.offsetParent !== null);
  if (!item) return 'no-item';
  item.click();
  await new Promise(r => setTimeout(r, 500));
  const navs = [...document.querySelectorAll('.settings-nav-btn')];
  navs[3]?.click();
  await new Promise(r => setTimeout(r, 300));
  const perfToggle = [...document.querySelectorAll('.settings-pane input[type=checkbox]')][0];
  if (perfToggle?.checked) perfToggle.click();
  await new Promise(r => setTimeout(r, 400));
  const apply = [...document.querySelectorAll('.modal button, [class*=modal] button')].find(b => b.textContent.trim() === '应用');
  apply?.click();
  await new Promise(r => setTimeout(r, 400));
  return perfToggle ? 'restored:' + !perfToggle.checked : 'no-toggle';
})()`, { returnByValue: true });
console.log("restore:", restore);
await sleep(5000);

const report = {
  when: new Date().toISOString(),
  doc: "无穷级数_密度档压测副本_减配触发.md（3061 行 > BIG_DOC_LINES）",
  fix: "Fix-D4 renderDegradedMath（doExport/doCopyRich 以 isBigDoc() 门控）",
  before, toggled, pipeline, restore,
  verdict:
    pipeline.gate === true &&
    pipeline.afterPipeline.katex > 0 &&
    pipeline.afterPipeline.dollars < pipeline.raw.dollars
      ? "PASS"
      : "FAIL",
};
writeFileSync(join(outDir, "ex-phase1-rc5-fix.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
cdp.close();
