// §4.4 编辑器块级预览目检：打开最小公式 fixture，检查 KaTeX DOM 结构。
import { findPageTarget, Cdp, mouse, sleep } from "./cdp.mjs";

const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);
await cdp.send("Runtime.enable");

// 等编辑器壳
for (let i = 0; i < 60; i++) {
  if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break;
  await sleep(500);
}

// 打开最小公式文档
const pos = await cdp.eval(`(() => {
  const rows = [...document.querySelectorAll('.ft-row.ft-file')];
  const hit = rows.find(r => (r.querySelector('.ft-name')?.textContent || '').includes('公式下标最小复现'));
  if (!hit) return null;
  hit.scrollIntoView({ block: 'center' });
  const r = hit.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);
if (!pos) throw new Error("文件树找不到公式下标最小复现");
await m.click(pos.x, pos.y);
await sleep(3000);

const check = await cdp.eval(`(() => {
  const pm = document.querySelector('.ProseMirror');
  if (!pm) return { ok: false, why: 'no-pm' };
  const blocks = [...pm.querySelectorAll('.katex-display .katex, .math-block .katex')];
  const inlines = [...pm.querySelectorAll('.math_inline .katex, .katex:not(.katex-display *)')].filter(k => !k.closest('.katex-display'));
  const errs = pm.querySelectorAll('.katex-error').length;
  // 类名代际：0.18.4 用 katex-strut/katex-base；0.16.x 用裸 strut/base
  const bareStrut = pm.querySelectorAll('.strut:not(.katex-strut)').length;
  const katexStrut = pm.querySelectorAll('.katex-strut').length;
  // 块公式结构：mfrac 分子分母 + msupsub
  const first = blocks[0];
  const fracs = first ? first.querySelectorAll('mfrac, .mfrac, .vlist-t [class*="frac"]') : [];
  const msupsub = pm.querySelectorAll('.msupsub').length;
  const msub = pm.querySelectorAll('msub, msubsup').length;
  const mo = first ? first.querySelectorAll('mo, mi').length : 0;
  const tex = first ? first.textContent : null;
  return { ok: true, blocks: blocks.length, inlines: inlines.length, errs, bareStrut, katexStrut,
           fracNodes: fracs.length, msupsub, msub, moCount: mo, firstTex: tex };
})()`);
console.log("编辑器 KaTeX DOM 检查:", JSON.stringify(check, null, 1));

// 截图留档
await cdp.send("Page.enable");
const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
const { writeFileSync } = await import("node:fs");
writeFileSync(new URL("./results/formula44-editor-check.png", import.meta.url), Buffer.from(shot.data, "base64"));
console.log("截图: perf/results/formula44-editor-check.png");
cdp.close();
