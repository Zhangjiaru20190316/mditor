// prod-flicker.mjs —— R10 阶段二/三：打包版（用户安装 5.0.1-beta = 症状版本）
// 症状 S（滚动底部闪刷/换装可见）复现探针（一次性，不入库惯例，实际随 commit 入库）
//
// 用法：node perf/tmp-r10/prod-flicker.mjs --scenario down-slow|down-fast|up-slow
//        |up-fast|roundtrip|revisit [--doc 1MB压测|密度档|解题技巧] [--tag r10p2]
//        [--run 1] [--depth 0.6] [--up-px 5000] [--hold-secs 17] [--quiet-secs 10]
//        [--prewarm-max 180] [--mode normal|focus] [--expect-keepwarm]
//
// 复现 prod 优先（R9 教训制度化：dev 预热爬行 26ms/块，dev 复现不了 ≠ 没有）。
// 加固沿承 prod-focus-jank.mjs 全套：预杀残留 mditor.exe、单实例转发检测、
// exe 身份钉（--expect-keepwarm = R9 冒烟口径）、证据先落盘、restore 8s 超时、
// prod 文件树 el.click() 开文档。观测 = flicker-watcher.mjs 纯 DOM 巡视
//（用户安装版无 __blockMountStats 补丁出口也能跑；有则快照合并）。
// 红线：prod store 只读；focusMode 退出归位 false；不改任何 src/。

import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Cdp, mouse, sleep } from "../cdp.mjs";
import { FLICKER_WATCHER, summarizeFlicker } from "./flicker-watcher.mjs";

const PORT = 9224;
const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..", "..");
const RESULTS_DIR = join(MDITOR_DIR, "perf", "results");
const EXE_CANDIDATES = [
  resolve(process.env.LOCALAPPDATA ?? "", "Mditor", "mditor.exe"),
  resolve(MDITOR_DIR, "src-tauri", "target", "release", "mditor.exe"),
];

function parseArgs(argv) {
  const a = { scenario: "down-slow", doc: "1MB压测", tag: "r10p2", phase: 2, run: 1,
    depth: 0.6, upPx: 5000, holdSecs: 17, quietSecs: 10, prewarmMax: 180, mode: "normal" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);
    if (k === "--scenario") a.scenario = next();
    else if (k === "--doc") a.doc = next();
    else if (k === "--tag") a.tag = next();
    else if (k === "--phase") a.phase = Number(next() ?? 2);
    else if (k === "--run") a.run = Number(next() ?? 1);
    else if (k === "--depth") a.depth = Number(next() ?? 0.6);
    else if (k === "--up-px") a.upPx = Number(next() ?? 5000);
    else if (k === "--hold-secs") a.holdSecs = Number(next() ?? 17);
    else if (k === "--quiet-secs") a.quietSecs = Number(next() ?? 10);
    else if (k === "--prewarm-max") a.prewarmMax = Number(next() ?? 180);
    else if (k === "--mode") a.mode = next() ?? "normal";
    else if (k === "--exe") a.exePath = next();
    else if (k === "--expect-keepwarm") a.expectKeepwarm = true;
  }
  return a;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fs = await import("node:fs");
  if (args.exePath) EXE_CANDIDATES.unshift(args.exePath);
  const EXE = EXE_CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!EXE) { console.log("FAIL: 找不到打包版 exe"); process.exit(2); }
  console.log(`exe: ${EXE}`);
  const prekill = spawnSync("taskkill", ["/F", "/T", "/IM", "mditor.exe"], { stdio: "pipe", encoding: "utf8" });
  console.log(prekill.status === 0 ? `预清理: ${String(prekill.stdout || "").trim()}` : "预清理: 无残留实例");
  await sleep(2500);
  const row = { ts: new Date().toISOString(), tag: args.tag, phase: args.phase, scenario: args.scenario,
    doc: args.doc, depth: args.depth, upPx: args.upPx, holdSecs: args.holdSecs, mode: args.mode, env: "prod", ok: false };

  let child = null, cdp = null;
  const kill = () => { try { if (child?.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); } catch { /* */ } };
  process.on("exit", kill);
  try {
    child = spawn(EXE, [], {
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
      stdio: "ignore", windowsHide: true,
    });
    let target = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(700) });
        const page = (await res.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) { target = page; break; }
      } catch { /* */ }
      await sleep(1000);
    }
    if (!target) { console.log("FAIL: CDP 9224 未就绪"); process.exit(2); }
    if (child.exitCode !== null) {
      console.log(`FAIL: spawn 进程已退出(exitCode=${child.exitCode})——疑似 single-instance 转发给残留实例`);
      kill(); process.exit(2);
    }
    row.childPid = child.pid;
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const m = mouse(cdp);
    for (let i = 0; i < 40; i++) { if (await withTimeout(cdp.eval(`!!document.querySelector('.ProseMirror')`), 8000)) break; await sleep(1000); }
    // exe 身份钉（R9 冒烟口径：focus-keepwarm keyframes = Fix-A 构建硬身份）
    const hasKw = await withTimeout(cdp.eval(`(() => { try { for (const sh of document.styleSheets) { let rr; try { rr = sh.cssRules; } catch { continue; } for (const r of rr) { if (r instanceof CSSKeyframesRule && r.name === "focus-keepwarm") return true; } } } catch { /* */ } return false; })()`), 8000);
    row.hasKeepwarmCSS = !!hasKw;
    console.log(`focus-keepwarm CSS: ${hasKw ? "存在" : "缺失"}`);
    if (args.expectKeepwarm && !hasKw) { console.log("FAIL: --expect-keepwarm 但样式表无 focus-keepwarm"); kill(); process.exit(2); }

    const expandDir = async (dirName) => {
      const ok = await withTimeout(cdp.eval(`(() => {
        const hit = [...document.querySelectorAll('.ft-row.ft-dir')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes(${JSON.stringify(dirName)}));
        if (!hit) return false;
        hit.click();
        return true;
      })()`), 8000);
      console.log(`expandDir(${dirName}): ${ok ? "clicked" : "miss"}`);
      if (!ok) return false;
      await sleep(1500);
      return true;
    };
    const openDoc = async (sub) => {
      for (let i = 0; i < 12; i++) {
        const ok = await withTimeout(cdp.eval(`(() => {
          const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes(${JSON.stringify(sub)}));
          if (!hit) return false;
          hit.click();
          return true;
        })()`), 8000);
        if (ok) { console.log(`openDoc(${sub}): clicked (try ${i})`); return true; }
        await sleep(800);
      }
      return false;
    };
    let opened = false;
    for (let i = 0; i < 3; i++) {
      const vis = await withTimeout(cdp.eval(`(() => { const r = document.querySelector(".ft-row"); if (!r) return false; return r.getBoundingClientRect().width > 0; })()`), 8000);
      if (vis) break;
      await cdp.eval(`document.querySelector(".sidebar-opener")?.click()`);
      await sleep(1200);
    }
    if (await openDoc(args.doc)) opened = true;
    if (!opened) {
      for (const d of ["01_专题笔记", "02_习题集", "cmc", "perf", "fixtures"]) {
        if (await expandDir(d) && await openDoc(args.doc)) { opened = true; break; }
      }
    }
    if (!opened) { console.log(`FAIL: prod 文件树找不到「${args.doc}」`); process.exit(2); }
    console.log(`文档已开: ${args.doc}`);
    await sleep(8000);

    const READ_GEO = `(() => { const h = document.querySelector('.mditor-editor-host'); const app = document.querySelector('.app'); return h ? { top: Math.round(h.scrollTop), h: Math.round(h.scrollHeight), vh: h.clientHeight, isFocus: !!(app && app.classList.contains('is-focus')) } : null; })()`;
    const big = await withTimeout(cdp.eval(`(() => { const h = document.querySelector('.mditor-editor-host'); return h ? h.dataset.big !== undefined : null; })()`), 8000);
    let s = await withTimeout(cdp.eval(READ_GEO), 8000);
    console.log(`big=${big} geo=${JSON.stringify(s)}`);
    row.big = big;
    if (!big) { console.log("FAIL: 非 cv 档文档（data-big 缺席）——臂无效"); kill(); process.exit(2); }

    // 预热等待（release 应可完成；超时记录后继续 = 用户早期会话态）
    const t1 = Date.now();
    let prewarmDone = false;
    while (Date.now() - t1 < args.prewarmMax * 1000) {
      const done = await withTimeout(cdp.eval(`(() => { const sd = window.__scrollDebug; if (!sd) return false; const es = typeof sd.events === 'function' ? sd.events() : sd.events; return (es ?? []).some(e => e.kind === 'prewarm.done'); })()`), 8000);
      if (done) { prewarmDone = true; break; }
      await sleep(3000);
    }
    row.prewarmDone = prewarmDone;
    row.prewarmWaitMs = Date.now() - t1;
    console.log(`预热${prewarmDone ? "完成" : "超时"}（${row.prewarmWaitMs}ms）`);
    s = await withTimeout(cdp.eval(READ_GEO), 8000);

    const focusBtnPos = async () => cdp.eval(`(() => { const b = document.querySelector('button.sb-icon-btn[title="焦点模式"]'); if (!b) return null; const r = b.getBoundingClientRect(); if (r.width === 0) return null; return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    const sendEsc = async () => {
      for (const type of ["keyDown", "keyUp"]) {
        await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape",
          windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      }
    };
    const setMode = async (wantFocus) => {
      let geo = await withTimeout(cdp.eval(READ_GEO), 8000);
      if (geo.isFocus === wantFocus) return geo;
      if (wantFocus) {
        const p = await focusBtnPos();
        if (!p) return null;
        await m.click(p.x, p.y);
      } else await sendEsc();
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        geo = await withTimeout(cdp.eval(READ_GEO), 8000);
        if (geo.isFocus === wantFocus) return geo;
      }
      return null;
    };
    if (args.mode === "focus") {
      const g = await setMode(true);
      if (!g) { console.log("FAIL: 切 focus 失败"); kill(); process.exit(2); }
      console.log(`focus 模式已开 vh=${g.vh}`);
      await sleep(1500);
      s = await withTimeout(cdp.eval(READ_GEO), 8000);
    }

    const inst = await withTimeout(cdp.eval(FLICKER_WATCHER), 15000);
    console.log(`巡视器: ${inst}`);
    if (!String(inst).startsWith("installed")) { kill(); process.exit(2); }

    const cx = 640, cy = 400;
    const wheel = async (dy, pause) => { await m.wheel(cx, cy, 0, dy); await sleep(pause); };
    const fast = async (px) => { const n = Math.ceil(Math.abs(px) / 1200); for (let i = 0; i < n; i++) await wheel(Math.sign(px) * 1200, 90); };
    const slow = async (px) => { const n = Math.ceil(Math.abs(px) / 220); for (let i = 0; i < n; i++) await wheel(Math.sign(px) * 220, 450); };
    const mark0 = (label) => `window.__r10flicker.marks.push({ t: Math.round(performance.now() - window.__r10flicker.perf0), label: ${JSON.stringify(label)} }), 'ok'`;
    const mark = (label) => withTimeout(cdp.eval(mark0(label)), 8000);
    const drive = async (seg, dist, spd) => {
      await mark(`${seg}-drive-begin`);
      if (spd === "fast") await fast(dist); else await slow(dist);
      await mark(`${seg}-drive-end`);
    };

    await cdp.eval(`window.__r10flicker.marks = []; 'ok'`);
    await mark("probe-begin");
    const targetTop = Math.round((s.h - s.vh) * args.depth);
    if (args.scenario === "down-slow" || args.scenario === "down-fast") {
      await drive("down", Math.max(100, Math.min(targetTop - s.top, targetTop)), args.scenario.split("-")[1]);
      await sleep(args.quietSecs * 1000);
    } else if (args.scenario === "up-slow" || args.scenario === "up-fast") {
      await mark("down-leg-begin");
      await fast(targetTop - s.top);
      await sleep(1200);
      s = await withTimeout(cdp.eval(READ_GEO), 8000);
      await mark("down-leg-end");
      await drive("up", -Math.min(args.upPx, s.top), args.scenario.split("-")[1]);
      await sleep(args.quietSecs * 1000);
    } else if (args.scenario === "roundtrip") {
      for (const dy of [1500, -1500, 2500, -2500, 3500, -3500, 3500, -3500, 2500, -2500, 1500, -1500]) {
        await mark(`rt-drive-begin`);
        await fast(dy);
        await mark(`rt-drive-end`);
        await sleep(600);
      }
      await sleep(args.quietSecs * 1000);
    } else if (args.scenario === "revisit") {
      await mark("down-leg-begin");
      await fast(targetTop - s.top);
      await mark("down-leg-end");
      console.log(`revisit: 下滚到 ${targetTop}，静置 ${args.holdSecs}s（越过 TEARDOWN 15s）`);
      await sleep(args.holdSecs * 1000);
      s = await withTimeout(cdp.eval(READ_GEO), 8000);
      await drive("revisit-up", -Math.min(args.upPx, s.top), "slow");
      await sleep(3000);
      s = await withTimeout(cdp.eval(READ_GEO), 8000);
      await drive("revisit-down", Math.min(args.upPx, (s.h - s.vh) - s.top), "fast");
      await sleep(args.quietSecs * 1000);
    }
    await mark("probe-end");

    row.mGates = await withTimeout(cdp.eval(`(() => {
      const host = document.querySelector('.mditor-editor-host');
      const pm = document.querySelector('.mditor-editor-host .ProseMirror');
      const hTop = host.getBoundingClientRect().top, vh = host.clientHeight;
      let inlineUnreadyVis = 0, inlineUnreadyTotal = 0, katexErr = 0;
      for (const el of pm.querySelectorAll('.mditor-math-inline-lazy')) {
        if (!el.classList.contains('mditor-math-inline-ready')) {
          inlineUnreadyTotal++;
          const r = el.getBoundingClientRect();
          if (r.bottom > hTop && r.top < hTop + vh) inlineUnreadyVis++;
        }
      }
      for (const el of pm.querySelectorAll('.katex-error')) katexErr++;
      let blk = { total: 0, mounted: 0, done: 0 };
      for (const el of pm.querySelectorAll('.milkdown-code-block')) {
        const f = el.firstElementChild;
        const isPh = f && f.tagName === 'PRE' && f.classList.contains('milkdown-code-block-placeholder');
        const r = el.getBoundingClientRect();
        if (r.bottom > hTop && r.top < hTop + vh) {
          blk.total++;
          if (!isPh) blk.mounted++;
          if (el.querySelector('.preview .katex')) blk.done++;
        }
      }
      const pump = typeof window.__mathPumpStats === 'function' ? window.__mathPumpStats() : null;
      return { inlineUnreadyVis, inlineUnreadyTotal, katexErr, blk, pumpQueue: pump ? pump.liveQueued : null };
    })()`), 20000);

    await withTimeout(cdp.eval(`window.__r10flicker.stop()`), 8000);
    await sleep(400);
    const flicker = await withTimeout(cdp.eval(`JSON.parse(JSON.stringify(window.__r10flicker))`), 90_000);
    const marksRaw = await withTimeout(cdp.eval(`JSON.parse(JSON.stringify(window.__r10flicker.marks || []))`), 15000);
    if (!flicker) { console.log("FAIL: 巡视器导出超时"); kill(); process.exit(2); }
    row.summary = summarizeFlicker(flicker, marksRaw ?? [], args.quietSecs);
    row.flicker = { events: flicker.events, tops: flicker.tops, sh: flicker.sh, snap: flicker.snap, gaps: flicker.gaps };
    row.marks = marksRaw ?? [];
    console.log(`S1: total=${row.summary.s1Total} byType=${JSON.stringify(row.summary.drives.map((d) => d.s1.byType))}`);
    console.log(`S2: reflash=${row.summary.s2Total} teardownVis=${row.summary.drives.map((d) => d.s2.teardownVis).join("/")} demoteVis=${row.summary.drives.map((d) => d.s2.demoteVis).join("/")}`);
    console.log(`S3: hdelta=${row.summary.drives.map((d) => d.s3.hdelta).join("/")} shDrift=${row.summary.drives.map((d) => d.s3.shDriftFrames).join("/")}`);
    console.log(`帧: ${JSON.stringify(row.summary.frame)}`);
    row.ok = true;
    // 证据先落盘（R9 run29 教训）
    const fixtureShort = args.doc.includes("1MB") ? "1mb" : args.doc.includes("密度档") ? "density" : args.doc.includes("解题技巧") ? "switch" : "other";
    const out = join(RESULTS_DIR, `r10-phase${args.phase}-flicker-prod-${args.scenario}-${fixtureShort}-${args.tag}-${args.run}.json`);
    writeFileSync(out, JSON.stringify(row), "utf8");
    console.log(`证据落盘 ${out}`);
    // focusMode 归位（prod 用户环境不残留）
    await withTimeout(setMode(false), 8000);
    try { cdp.close(); } catch { /* */ }
    cdp = null;
    kill();
    child = null;
    process.exit(0);
  } catch (e) {
    console.log("异常: " + (e?.stack || e));
    try { cdp && cdp.close(); } catch { /* */ }
    kill();
    process.exit(1);
  }
}
main().then((c) => process.exit(c ?? 0), (e) => { console.error(e?.stack || e); process.exit(2); });
