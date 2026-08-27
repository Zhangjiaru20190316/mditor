// 大文档性能基准：驱动真实 Tauri dev 实例（CDP）测量 打开/点击/选区/输入/滚动/全选。
//
// 前置：
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npx tauri dev --config src-tauri/tauri.dev.conf.json
//   （dev identifier = com.mditor.app.dev，workspace 预置 perf/fixtures，用文档副本，不碰真实笔记）
//
// 用法：node perf/baseline.mjs [标签名]   → perf/results/<标签名>.json
// 场景（每轮完全一致的脚本化交互，before/after 同法复测）：
//   open        文件树点击打开文档 → 内容稳定
//   clicks      视口中央依次点击 10 个段落（scroll 定位 → 单击）
//   select      双击选词 + 选区工具栏按钮（加粗）
//   typing      段落内连续输入 12 字符（含中文），逐键事件延迟 + 长任务
//   scroll      30 次滚轮 ×400px，帧间隔分布
//   selectAll   Ctrl+A 全选 + Esc
//   undo        Ctrl+Z 收尾恢复原文（打字场景的编辑全部回退）

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findPageTarget, Cdp, mouse, typeText, sleep, LONGTASK_RECORDER, FRAME_RECORDER } from "./cdp.mjs";

const label = process.argv[2] ?? "run";
const here = dirname(fileURLToPath(import.meta.url));
const DOC_NAME = "一元微分学习题集";

// ---------- 页内辅助（Runtime.evaluate 里的字符串） ---------------------------

/** 取第 idx 个顶层块的视口坐标（先滚到它上方 150px，等两帧再读 rect）。 */
const scrollBlockIntoView = (idx) => `(() => {
  const pm = document.querySelector('.ProseMirror');
  const host = document.querySelector('.mditor-editor-host');
  if (!pm || !host) return null;
  const kids = pm.children;
  if (!kids.length) return null;
  const k = kids[Math.min(${idx}, kids.length - 1)];
  host.scrollTop = Math.max(0, k.offsetTop - 150);
  return true;
})()`;

const blockRect = (idx) => `(() => {
  const pm = document.querySelector('.ProseMirror');
  if (!pm) return null;
  const kids = pm.children;
  const k = kids[Math.min(${idx}, kids.length - 1)];
  const r = k.getBoundingClientRect();
  return { x: Math.round(r.x + Math.min(r.width / 2, 300)), y: Math.round(r.y + Math.min(r.height / 2, 120)), tag: k.tagName };
})()`;

const docReady = `(() => {
  const pm = document.querySelector('.ProseMirror');
  return pm ? pm.children.length : 0;
})()`;

/** 事件时延观察器（InteractionObserver 等价物：PerformanceObserver 'event'）。 */
const EVENT_RECORDER = `(() => {
  if (window.__evRec) return 'already';
  const buf = [];
  window.__evRec = {
    events: buf,
    start() { buf.length = 0; this.obs?.disconnect();
      this.obs = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) buf.push({ t: Math.round(e.startTime), d: Math.round(e.duration), type: e.name });
      });
      this.obs.observe({ type: 'event', durationThreshold: 16 }); },
    stop() { this.obs?.disconnect();
      const sorted = buf.slice().sort((a,b)=>a.d-b.d);
      const q = (p) => sorted.length ? sorted[Math.floor(sorted.length*p)].d : 0;
      return { n: buf.length, p50: q(0.5), p95: q(0.95), max: sorted.length ? sorted[sorted.length-1].d : 0, over100: buf.filter(e=>e.d>100).length, events: buf.slice(0, 40) }; },
  };
  return 'installed';
})()`;

const summary = (events) => {
  if (!events.length) return { n: 0, total: 0, max: 0, over200: 0 };
  const sorted = [...events].sort((a, b) => b.d - a.d);
  return {
    n: events.length,
    total: events.reduce((s, e) => s + e.d, 0),
    max: sorted[0].d,
    over200: events.filter((e) => e.d > 200).length,
    top: sorted.slice(0, 5).map((e) => ({ t: e.t, d: e.d })),
  };
};

// ---------- 主流程 -----------------------------------------------------------

const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);
console.log("connected:", target.url);

await cdp.eval(LONGTASK_RECORDER);
await cdp.eval(FRAME_RECORDER);
await cdp.eval(EVENT_RECORDER);

const results = { label, ts: new Date().toISOString(), scenarios: {} };
const win = await cdp.eval(`({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})`);
results.viewport = win;
console.log("viewport:", win);

const lt = { start: () => cdp.eval("window.__ltRecorder.start()"), stop: async () => summary((await cdp.eval("window.__ltRecorder.stop()")).events) };
const fr = { start: () => cdp.eval("window.__frameRec.start()"), stop: () => cdp.eval("window.__frameRec.stop()") };
const ev = { start: () => cdp.eval("window.__evRec.start()"), stop: () => cdp.eval("window.__evRec.stop()") };

// ---- 等应用就绪 -------------------------------------------------------------
let bootTries = 0;
while ((await cdp.eval(`!!document.querySelector('.ProseMirror')`)) !== true) {
  if (++bootTries > 60) throw new Error("编辑器未就绪");
  await sleep(500);
}
console.log("editor ready");

// ---- 场景 1：打开文档（reload → 干净启动 → 文件树点击 → 内容稳定）----------
// heal snapshot 只在内存守护 reload 时写入 sessionStorage，location.reload 后
// 不存在 → 每轮都是「干净 boot + 文件树点击打开」的完整冷路径。
{
  await cdp.eval("location.reload()");
  await sleep(2500);
  // reload 清掉了页内记录器，重新注入
  await cdp.eval(LONGTASK_RECORDER);
  await cdp.eval(FRAME_RECORDER);
  await cdp.eval(EVENT_RECORDER);
  let bootTries = 0;
  while (!(await cdp.eval(`!!document.querySelector('.ProseMirror')`))) {
    if (++bootTries > 40) throw new Error("reload 后编辑器未就绪");
    await sleep(500);
  }
  // 找到文件树里的目标文档行（工作区扫描可能晚于编辑器就绪，轮询）
  let row = null;
  for (let i = 0; i < 30 && !row; i++) {
    row = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('.ft-row.ft-file')];
      const hit = rows.find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes('${DOC_NAME}'));
      if (!hit) return null;
      const r = hit.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!row) await sleep(500);
  }
  if (!row) throw new Error("文件树里找不到目标文档");
  await lt.start(); await fr.start();
  const t0 = Date.now();
  await m.click(row.x, row.y);
  // 等 PM 内容到位且长任务停歇
  let settle = 0, lastCount = -1, stable = 0;
  while (settle < 40) {
    await sleep(250);
    const n = await cdp.eval(docReady);
    if (n > 100 && n === lastCount) { stable++; if (stable >= 3) break; } else stable = 0;
    lastCount = n; settle++;
  }
  const openMs = Date.now() - t0;
  const longtasks = await lt.stop();
  const frames = await fr.stop();
  const blocks = await cdp.eval(docReady);
  results.scenarios.open = { openMs, blocks, longtasks, frames };
  console.log("open:", openMs + "ms", "blocks:", blocks, "longtasks:", JSON.stringify(longtasks));
  await sleep(1500); // 首次打开后的余波（预热/盖章）落定
}

// ---- 场景 2：点击段落（阅读中点段落正文——日志中的高频交互） -------------------
{
  await lt.start(); await ev.start(); await fr.start();
  const clicked = [];
  for (let i = 60; i < 60 + 10; i++) {
    await cdp.eval(scrollBlockIntoView(i * 37));
    await sleep(90);
    const r = await cdp.eval(blockRect(i * 37));
    if (r) { await m.click(r.x, r.y); clicked.push(r.tag); }
    await sleep(220);
  }
  const longtasks = await lt.stop();
  const events = await ev.stop();
  const frames = await fr.stop();
  results.scenarios.clicks = { clicked: clicked.length, longtasks, events, frames };
  console.log("clicks:", JSON.stringify({ longtasks, ev: { n: events.n, p95: events.p95, max: events.max } }));
}

// ---- 场景 3：双击选词 + 选区工具栏按钮 --------------------------------------
{
  // 找一个有实际文字的段落（P 且文本 ≥ 30 字），滚过去
  const r = await cdp.eval(`(() => {
    const pm = document.querySelector('.ProseMirror');
    const host = document.querySelector('.mditor-editor-host');
    const kids = [...pm.children];
    // 从中部往后找第一个长文本段落（跳过标题/代码/表格）
    const k = kids.slice(500).find(el => el.tagName === 'P' && (el.textContent ?? '').trim().length >= 30);
    if (!k) return null;
    host.scrollTop = Math.max(0, k.offsetTop - 150);
    return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
      const rc = k.getBoundingClientRect();
      // 点在文字中部（近似词内）
      res({ x: Math.round(rc.x + Math.min(rc.width / 2, 200)), y: Math.round(rc.y + Math.min(rc.height / 2, 100)) });
    })));
  })()`);
  if (!r) throw new Error("找不到可双击的文本段落");
  await lt.start(); await ev.start();
  await m.click(r.x, r.y); await sleep(60);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 2 });
  await sleep(80);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 2 });
  await sleep(350);
  const btn = await cdp.eval(`(() => {
    const b = document.querySelector('.sel-btn');
    if (!b) return null;
    const rect = b.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`);
  let toolbarAction = "no-toolbar";
  if (btn) {
    const t0 = Date.now();
    await m.click(btn.x, btn.y);
    await sleep(900);
    toolbarAction = Date.now() - t0 + "ms";
  }
  const longtasks = await lt.stop();
  const events = await ev.stop();
  results.scenarios.select = { toolbar: toolbarAction, foundBtn: !!btn, longtasks, events };
  console.log("select:", toolbarAction, JSON.stringify(summary(longtasks.events ?? [])));
}

// ---- 场景 4：输入（逐键延迟 + 长任务） ---------------------------------------
{
  await cdp.eval(scrollBlockIntoView(700));
  await sleep(120);
  const r = await cdp.eval(blockRect(700));
  await m.click(r.x, r.y);
  await sleep(250);
  await lt.start(); await ev.start();
  await typeText(cdp, "性能基准输入测试xyz", { delay: 60 });
  await sleep(400);
  const longtasks = await lt.stop();
  const events = await ev.stop();
  results.scenarios.typing = { chars: 9, longtasks, events };
  console.log("typing:", JSON.stringify({ lt: summary(longtasks.events ?? []), ev: { n: events.n, p95: events.p95, max: events.max } }));
}

// ---- 场景 5：滚动 ------------------------------------------------------------
{
  await lt.start(); await fr.start();
  const cx = Math.round(win.w / 2), cy = Math.round(win.h / 2);
  for (let i = 0; i < 30; i++) {
    await m.wheel(cx, cy, 0, 400);
    await sleep(100);
  }
  const longtasks = await lt.stop();
  const frames = await fr.stop();
  results.scenarios.scroll = { longtasks, frames };
  console.log("scroll:", JSON.stringify(frames));
}

// ---- 场景 6：Ctrl+A 全选 -----------------------------------------------------
{
  await lt.start(); await ev.start(); await fr.start();
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
  await sleep(1500);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(400);
  const longtasks = await lt.stop();
  const events = await ev.stop();
  const frames = await fr.stop();
  results.scenarios.selectAll = { longtasks, events, frames };
  console.log("selectAll:", JSON.stringify(summary(longtasks.events ?? [])));
}

// ---- 场景 7：撤销恢复（打字的 9 字符退回；文档字节回到打开时状态） ------------
{
  await lt.start();
  for (let i = 0; i < 12; i++) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90 });
    await sleep(120);
  }
  await sleep(600);
  const longtasks = await lt.stop();
  results.scenarios.undo = { longtasks };
  console.log("undo:", JSON.stringify(summary(longtasks.events ?? [])));
}

mkdirSync(join(here, "results"), { recursive: true });
const out = join(here, "results", `${label}.json`);
writeFileSync(out, JSON.stringify(results, null, 1), "utf8");
console.log("saved:", out);
cdp.close();
