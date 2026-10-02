// beta-smoke.mjs —— v5.0.0-beta 打包版冒烟（一次性）：开真实密度档文档 + 滚动断言
// 口径沿 v4.20.0 先例（ab9582d）：不 typeText（￼ 化坑），用打开+滚动断言。
import { findPageTarget, Cdp, mouse, sleep } from "../cdp.mjs";
import { writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RESULTS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "results");
const PORT = 9224;
const target = await findPageTarget(PORT, 60000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);
const cx = 640, cy = 400;
const row = { ts: new Date().toISOString(), app: "Mditor_5.0.0-beta", checks: [] };
const check = (name, ok, detail = "") => { row.checks.push({ name, ok, detail }); console.log(ok ? "PASS" : "FAIL", name, detail); };

// 1) 版本
const ver = await cdp.eval(`(() => { const w = window; return (w.__mditorVersion || (w.__scrollDebug && 'scrollDebug-ok')) || 'unknown'; })()`);
const envVer = await cdp.eval(`window.__scrollDebug && window.__scrollDebug.stats ? 'stats-ok' : 'no-panel'`);
check("scrollDebug 面板在位（观测补点随包）", envVer === "stats-ok", envVer);
check("陷阱暴露（window.__scrollDebug.trap）", await cdp.eval(`typeof window.__scrollDebug?.trap === 'function'`));

// 2) 打开真实密度档文档（生产 store：侧栏可能关/标签可能非文件树/目录需展开）
const clickEl = async (sel) => {
  const p = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (p) { await m.click(p.x, p.y); return true; }
  return false;
};
if (!(await cdp.eval(`!!document.querySelector('.ft-row')`))) {
  await clickEl("button.sidebar-opener");
  await sleep(600);
}
await clickEl('.sb-tabs button[title="文件树"]');
await sleep(800);
let opened = false;
for (let attempt = 0; attempt < 12 && !opened; attempt++) {
  opened = await (async () => {
    const p = await cdp.eval(`(() => {
      const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes('无穷级数_习题集'));
      if (!hit) return null;
      const r = hit.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (p) { await m.click(p.x, p.y); return true; }
    return false;
  })();
  if (opened) break;
  // 展开一个可见的折叠目录
  const expanded = await cdp.eval(`(() => {
    const dirs = [...document.querySelectorAll('.ft-row.ft-dir')].filter(d => {
      const r = d.getBoundingClientRect();
      return r.width > 0 && r.bottom > 0 && r.top < innerHeight;
    });
    const d = dirs.find(x => !x.classList.contains('open') && (x.querySelector('.ft-name')?.textContent ?? '').includes('习题集'))
      ?? dirs.find(x => !x.classList.contains('open'));
    if (!d) return false;
    d.classList.add('__r5expand');
    return true;
  })()`);
  if (expanded) await clickEl(".__r5expand");
  else break;
  await sleep(500);
}
check("打开密度档文档", opened);
await sleep(12000);

// 3) 滚动前公式计数
const before = await cdp.eval(`document.querySelectorAll('.katex').length`);
// 4) 滚动 8000px（分 16 步）
for (let i = 0; i < 16; i++) { await m.wheel(cx, cy, 0, 500); await sleep(400); }
await sleep(3000);
const after = await cdp.eval(`document.querySelectorAll('.katex').length`);
const top = await cdp.eval(`Math.round(document.querySelector('.mditor-editor-host')?.scrollTop ?? -1)`);
check("滚动推进", top > 3000, `scrollTop=${top}`);
check("滚动后公式渲染增长", after > before, `katex ${before} → ${after}`);
const katexErr = await cdp.eval(`document.querySelectorAll('.katex-error').length`);
check("katex-error = 0", katexErr === 0, `count=${katexErr}`);

// 5) 观测计数器读取（写入陷阱/J2/cv.relearn 家族在包内可用）
const counters = await cdp.eval(`window.__scrollDebug ? window.__scrollDebug.counters() : null`);
check("计数器可读", counters != null, `ghost=${counters?.["session.ghost"] ?? "?"} smoothjump.set=${counters?.["smoothjump.set"] ?? "?"}`);

// 6) 视口档状态（该文档在生产开启 bigDocViewport 下应 data-big）
const big = await cdp.eval(`!!document.querySelector('.mditor-editor-host')?.dataset.big`);
row.big = big;

writeFileSync(join(RESULTS, "r5-beta-smoke.json"), JSON.stringify(row));
console.log("落盘", join(RESULTS, "r5-beta-smoke.json"));
cdp.close();
process.exit(row.checks.every((c) => c.ok) ? 0 : 1);
