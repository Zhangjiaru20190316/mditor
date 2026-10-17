// HX 轮 E-H1 定罪步骤 2：真实浏览器（Edge headless）实测导出文件。
//  - 基线：滚动锁死复现（scrollTo 无效 / scrollHeight 被钳制）
//  - 对照实验 A/B/C：单独禁 overflow:hidden / 单独禁 height:100% / 双禁
//    ——钉死唯一致瘫声明（层叠链分析的行为验证）
//  - 开关复现：注入→解除→再注入（≥2 次稳定）
//  - S-H2 审计：导出 CSS 里所有命中本文档元素且含布局影响声明的规则
// 产物：perf/results/ex-hx-repro/ex-hx-html-browser.json
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT = join(ROOT, "perf", "results", "ex-hx-repro");
const HTML = "file:///C:/Users/hh/Desktop/Tp/mditor/perf/results/ex-hx-repro/demo-export.html";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PROFILE = join(ROOT, "perf", "results", "ex-hx-repro", "edge-profile");

const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  "--remote-debugging-port=9333",
  `--user-data-dir=${PROFILE}`,
  "--no-first-run", "--no-default-browser-check",
  "--window-size=1280,900",
  HTML,
], { stdio: "ignore" });
console.log("edge spawned pid", edge.pid);

const target = await findPageTarget(9333, 20_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected to", target.url.slice(0, 60));

// ——测量原语：当前滚动能力画像（以「用户滚动」语义为准：受信任滚轮事件；
//    scrollTo 对 overflow:hidden 视口也生效（hidden 盒可编程滚动），不能作判据）——
const MEASURE_PRE = `(() => {
  const de = document.documentElement, b = document.body;
  const cs = getComputedStyle(b), csHtml = getComputedStyle(de);
  const kids = b.children;
  const last = kids[kids.length - 1];
  const lastRect = last ? last.getBoundingClientRect() : null;
  // 文档在流内容的真实末底（所有直接子块 max bottom，相对文档顶）
  let flowBottom = 0;
  for (const k of kids) { const r = k.getBoundingClientRect(); flowBottom = Math.max(flowBottom, r.bottom + scrollY); }
  return { pre: JSON.stringify({
    viewportH: innerHeight,
    deScrollH: de.scrollHeight, deClientH: de.clientHeight,
    bodyScrollH: b.scrollHeight, bodyClientH: b.clientHeight,
    bodyOverflowY: cs.overflowY, bodyHeight: cs.height,
    htmlOverflowY: csHtml.overflowY, htmlHeight: csHtml.height,
    lastBlockTag: last ? last.tagName : null,
    lastBlockBottomDoc: lastRect ? Math.round(lastRect.bottom + scrollY) : null,
    flowBottomDoc: Math.round(flowBottom),
    scrollY: scrollY,
  }) };
})()`;

const measure = async (label) => {
  // 回顶 → 受信任滚轮 ×5（每次 600px，用户滚动语义）→ 记录用户可滚到的最深处
  await cdp.eval("window.scrollTo(0, 0)");
  await sleep(60);
  for (let i = 0; i < 5; i++) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 450, deltaX: 0, deltaY: 600 });
    await sleep(80);
  }
  const afterWheel = await cdp.eval("scrollY");
  // 再按 PageDown ×3（键盘通道交叉验证）
  for (let i = 0; i < 3; i++) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 });
    await sleep(80);
  }
  const afterKeys = await cdp.eval("scrollY");
  const pre = JSON.parse((await cdp.eval(MEASURE_PRE)).pre);
  const m = { ...pre, userScrollYAfterWheel5x600: afterWheel, userScrollYAfterPageDown3x: afterKeys,
              userScrollLocked: afterWheel === 0 && afterKeys === 0 };
  console.log(label, JSON.stringify(m));
  await cdp.eval("window.scrollTo(0, 0)");
  return m;
};

// 注入/移除覆盖样式（id 管理，等价 devtools 勾选禁用规则）
const INJECT = (id, css) => `(() => {
  document.getElementById('${id}')?.remove();
  if (${JSON.stringify(css)} !== null) {
    const s = document.createElement('style'); s.id = '${id}';
    s.textContent = ${JSON.stringify(css)};
    document.head.appendChild(s);
  }
  return 'ok';
})()`;

const evidence = { startedAt: new Date().toISOString(), browser: "Edge headless (Chromium)", runs: [] };

for (let round = 1; round <= 2; round++) {
  const one = { round };
  await cdp.send("Page.enable").catch(() => {});
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  one.baseline = await measure(`[r${round} baseline]`);
  // A：只解 overflow:hidden
  await cdp.eval(INJECT("hx-a", "body { overflow: visible !important; }"));
  one.expA_overflowVisibleOnly = await measure(`[r${round} expA]`);
  await cdp.eval(INJECT("hx-a", null));
  // B：只解 height:100%
  await cdp.eval(INJECT("hx-b", "html, body { height: auto !important; }"));
  one.expB_heightAutoOnly = await measure(`[r${round} expB]`);
  await cdp.eval(INJECT("hx-b", null));
  // 回基线复核（锁死恢复 → 因果闭环）
  one.relocked = await measure(`[r${round} relock]`);
  // C：双解（候选修复语义）
  await cdp.eval(INJECT("hx-c", "html, body { height: auto !important; overflow: visible !important; }"));
  one.expC_both = await measure(`[r${round} expC]`);
  await cdp.eval(INJECT("hx-c", null));
  evidence.runs.push(one);
}

// ——S-H2 审计：命中本文档且含布局影响声明的规则——
const audit = await cdp.eval(`(() => {
  const LAYOUT_PROPS = ['overflow','height','max-height','position','display','transform','visibility','grid-template','flex','z-index','top','left','right','bottom','margin','padding','width','max-width','min-height'];
  const hits = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(rules)) {
      if (rule.type !== 1 || !rule.selectorText) continue; // 只看样式规则
      const style = rule.style;
      const decls = [];
      for (const p of LAYOUT_PROPS) { const v = style.getPropertyValue(p); if (v) decls.push(p + ':' + v); }
      if (!decls.length) continue;
      let matched = 0, sample = null;
      try {
        const els = document.querySelectorAll(rule.selectorText);
        matched = els.length;
        sample = els[0]?.tagName ?? null;
      } catch { continue; } // 非法选择器
      if (matched > 0) hits.push({ sel: rule.selectorText.slice(0, 120), matched, sample, decls: decls.slice(0, 8).join(';').slice(0, 200) });
    }
  }
  return JSON.stringify({ total: hits.length, hits });
})()`);
evidence.s2_audit = JSON.parse(audit);

writeFileSync(join(OUT, "ex-hx-html-browser.json"), JSON.stringify(evidence, null, 2));
console.log("saved →", join(OUT, "ex-hx-html-browser.json"));
cdp.close();
edge.kill();
