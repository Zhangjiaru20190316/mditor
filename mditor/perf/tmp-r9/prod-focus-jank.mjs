// prod-focus-jank.mjs —— R9 阶段二/三：打包版（用户安装 v5.0.0）症状 F 复现探针
// （一次性，不入库）
//
// 用法：node perf/tmp-r9/prod-focus-jank.mjs --scenario down-slow|down-fast
//        [--doc 1MB压测|密度档压测|题型方法] [--tag r9p2p] [--run 1]
//        [--depth 0.6] [--up-px 5000] [--arms 3] [--prewarm-max 180]
//        [--quiet-secs 10] [--settle-ms 2000] [--first-arm normal|focus]
//
// 背景：dev 探针（probe-focus-jank）六 run 全部复现失败——focus 不劣于
// normal（p95 比 0.58~1.05）。环境归因：dev 构建预热 1 块/26ms 爬行死锁，
// 1MB 表冷（F-a「表满载×布局贵」条件不成立）；密度档布局便宜。用户症状在
// 打包 v5.0.0 正式版——release 构建预热 20~60s 可完成 → F-a 全条件在场。
// 本探针 = 唯一接近用户环境的路径。
//
// 与 dev 探针的差异：
//  - 启动 %LOCALAPPDATA%/Mditor/mditor.exe（用户安装版，= 症状版本），
//    CDP 9224（避让惯例）；**prod store 只读**（不 editStore——用户真实库）。
//  - 打开文档走 prod 文件树（递归展开目录），候选名列表匹配。
//  - 预热等待强化：轮询 prewarm.done 事件上限 180s（release 可完成）；
//    若超时则记录 prewarmTimeot 继续测（冷表态也有价值——用户早期会话态）。
//  - 采样/分析/切换与 dev 版同款（页内分析 + 大导出超时兜底）。
// 红线：只读观测 + 滚轮驱动 + focus 切换（用户日常操作）；不改设置默认值
//（focusMode 退出时归位 false）；不改任何 src/。

import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Cdp, mouse, sleep } from "../cdp.mjs";

const PORT = 9224;
const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..", "..");
const RESULTS_DIR = join(MDITOR_DIR, "perf", "results");
const EXE_CANDIDATES = [
  resolve(process.env.LOCALAPPDATA ?? "", "Mditor", "mditor.exe"),
  resolve(MDITOR_DIR, "src-tauri", "target", "release", "mditor.exe"),
];

function parseArgs(argv) {
  const a = { scenario: "down-slow", doc: "1MB压测", tag: "r9p2p", run: 1,
    depth: 0.6, upPx: 5000, arms: 3, prewarmMax: 180, quietSecs: 10, settleMs: 2000, firstArm: "normal", stridePx: 0, widthCtrl: false, widthPx: 0, exp: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);
    if (k === "--scenario") a.scenario = next();
    else if (k === "--doc") a.doc = next();
    else if (k === "--tag") a.tag = next();
    else if (k === "--run") a.run = Number(next() ?? 1);
    else if (k === "--depth") a.depth = Number(next() ?? 0.6);
    else if (k === "--up-px") a.upPx = Number(next() ?? 5000);
    else if (k === "--arms") a.arms = Number(next() ?? 3);
    else if (k === "--prewarm-max") a.prewarmMax = Number(next() ?? 180);
    else if (k === "--quiet-secs") a.quietSecs = Number(next() ?? 10);
    else if (k === "--settle-ms") a.settleMs = Number(next() ?? 2000);
    else if (k === "--first-arm") a.firstArm = next();
    else if (k === "--stride-px") a.stridePx = Number(next() ?? 0);
    else if (k === "--width-ctrl") a.widthCtrl = true;
    else if (k === "--width-px") a.widthPx = Number(next() ?? 0);
    else if (k === "--exp") a.exp = next();
    else if (k === "--exe") a.exePath = next();
    else if (k === "--expect-keepwarm") a.expectKeepwarm = true;
  }
  return a;
}

// 采样器（与 dev 版 probe-focus-jank 同款）
const JANK_SAMPLER = `(() => {
  const host = document.querySelector('.mditor-editor-host');
  const pm = host && host.querySelector('.ProseMirror');
  if (!host || !pm) return 'no-host';
  const hr = host.getBoundingClientRect();
  const pick = (yFrac) => {
    const y = hr.top + hr.height * yFrac;
    let fallback = null;
    for (const el of pm.children) {
      const r = el.getBoundingClientRect();
      if (r.height < 8) continue;
      if (!fallback && r.top <= y && r.bottom >= y) fallback = el;
      if (r.top >= y - 4 && r.top <= y + hr.height * 0.3) return el;
    }
    return fallback;
  };
  const sentinels = [];
  const names = ['top', 'mid', 'bot'];
  const fracs = [0.12, 0.5, 0.85];
  for (let i = 0; i < 3; i++) { const el = pick(fracs[i]); if (el) sentinels.push({ name: names[i], el }); }
  const rec = { perf0: performance.now(), wall0: Date.now(), frames: 0, framesList: [], marks: [], longtasks: [],
    snap: [], sentinelInfo: sentinels.map((s) => ({ name: s.name, tag: s.el.tagName,
      text: (s.el.textContent || '').slice(0, 24) })), stop: false, done: false, err: null };
  window.__r9focus = rec;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const a = (e.attribution && e.attribution[0]) || {};
        rec.longtasks.push({ t: Math.round(e.startTime), dur: Math.round(e.duration * 10) / 10,
          name: e.name, ct: a.containerType || '', cn: (a.containerName || '').slice(0, 40) });
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { rec.ltErr = String(e); }
  let prev = null;
  const snapOnce = () => {
    try {
      let math = null;
      try {
        let ready = 0, unready = 0;
        for (const el of pm.querySelectorAll('.mditor-math-inline-lazy')) {
          if (el.classList.contains('mditor-math-inline-ready')) ready++; else unready++;
        }
        math = { ready, unready };
      } catch { /* */ }
      let pump = null;
      try { pump = typeof window.__mathPumpStats === 'function' ? window.__mathPumpStats() : null; } catch { /* */ }
      let counters = null;
      try {
        const sd = window.__scrollDebug;
        const c = sd ? (typeof sd.counters === 'function' ? sd.counters() : sd.counters) : null;
        if (c) { const o = {}; for (const [k, v] of Object.entries(c)) { if (v) o[k] = v; } counters = o; }
      } catch { /* */ }
      const pickCtr = {};
      if (counters) {
        for (const k of Object.keys(counters)) {
          if (/^(prewarm\\.|anchor\\.|write\\.|demote|io\\.|cv\\.|layout:|block\\.|session\\.|pm\\.|ghost)/.test(k)) pickCtr[k] = counters[k];
        }
      }
      rec.snap.push({ t: Math.round(performance.now() - rec.perf0), w: Date.now(), math, pump, ctr: pickCtr });
    } catch { /* */ }
  };
  let lastSnapAt = 0;
  const tick = () => {
    try {
      if (rec.stop) { snapOnce(); rec.done = true; return; }
      const now = performance.now();
      const t = Math.round(now - rec.perf0);
      const row = { t, w: Date.now(), st: Math.round(host.scrollTop * 10) / 10,
        sh: Math.round(host.scrollHeight), pw: Math.round(pm.clientWidth) };
      for (const s of sentinels) {
        row[s.name] = s.el.isConnected ? Math.round(s.el.getBoundingClientRect().top * 10) / 10 : null;
      }
      if (prev) row.gap = Math.round((now - prev.at) * 10) / 10;
      row.at = now;
      rec.frames++;
      rec.framesList.push(row);
      prev = row;
      if (now - lastSnapAt >= 250) { lastSnapAt = now; snapOnce(); }
      requestAnimationFrame(tick);
    } catch (e) { rec.err = String(e); rec.done = true; }
  };
  requestAnimationFrame(tick);
  return 'started:' + sentinels.length;
})()`;

const mark = (label) => `window.__r9focus && window.__r9focus.marks.push({ t: Math.round(performance.now() - window.__r9focus.perf0), w: Date.now(), label: ${JSON.stringify(label)} }), 'ok'`;

const ANALYZE_EXPR = (armMetasJson) => `(() => {
  const armMetas = ${armMetasJson};
  const rec = window.__r9focus;
  if (!rec) return { error: 'no-rec' };
  const frames = rec.framesList ?? [];
  const marks = rec.marks ?? [];
  const findMark = (label) => { const hit = [...marks].reverse().find((x) => x.label === label); return hit ? hit.t : null; };
  const inWin = (t, w) => w && t >= w[0] && t < w[1];
  const quantile = (arr, q) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.floor(arr.length * q))] * 10) / 10; };
  const variance = (arr) => { if (!arr.length) return null; const mu = arr.reduce((s, x) => s + x, 0) / arr.length; return Math.round(arr.reduce((s, x) => s + (x - mu) * (x - mu), 0) / arr.length); };
  const arms = [];
  for (const meta of armMetas) {
    const lab = 'arm-' + meta.i + '-' + meta.mode;
    const swB = findMark(lab + '-switch-begin'), swE = findMark(lab + '-settle-end');
    const dB = findMark(lab + '-drive-begin'), dE = findMark(lab + '-drive-end'), aE = findMark(lab + '-arm-end');
    if (swB == null || dB == null || dE == null || aE == null) { arms.push({ i: meta.i, mode: meta.mode, error: 'marks-missing' }); continue; }
    const QUIET_GATE = 400;
    const switchWin = [swB, swE], scrollWin = [dB, dE + QUIET_GATE], quietWin = [dE + QUIET_GATE, aE];
    const scrollFrames = frames.filter((f) => inWin(f.t, scrollWin));
    const quietFrames = frames.filter((f) => inWin(f.t, quietWin));
    const swFrames = frames.filter((f) => inWin(f.t, switchWin));
    const scrollGaps = scrollFrames.map((f) => f.gap).filter((g) => g != null);
    const jankScroll = scrollFrames.filter((f) => f.gap > 32);
    const ltScroll = (rec.longtasks ?? []).filter((e) => inWin(e.t, scrollWin) || inWin(e.t + e.dur, scrollWin));
    const shiftScroll = [], shiftQuiet = [];
    let prevF = null;
    for (const f of frames) {
      if (prevF) {
        if (inWin(f.t, scrollWin)) {
          const stD = Math.round((f.st - prevF.st) * 10) / 10;
          for (const nm of ['top', 'mid', 'bot']) {
            const a = prevF[nm], b = f[nm];
            if (a == null || b == null) continue;
            const d = Math.round((b - a) * 10) / 10;
            const residual = Math.round((d + stD) * 10) / 10;
            if (Math.abs(residual) > 4) { shiftScroll.push({ t: f.t, s: nm, d, stD, residual, gap: f.gap }); break; }
          }
        } else if (inWin(f.t, quietWin)) {
          for (const nm of ['top', 'mid', 'bot']) {
            const a = prevF[nm], b = f[nm];
            if (a == null || b == null) continue;
            const d = Math.round((b - a) * 10) / 10;
            if (Math.abs(d) > 4) { shiftQuiet.push({ t: f.t, s: nm, d, st: f.st, gap: f.gap }); break; }
          }
        }
      }
      prevF = f;
    }
    const snapIn = (rec.snap ?? []).filter((x) => inWin(x.t, scrollWin) || inWin(x.t, quietWin));
    const ctrDelta = {};
    if (snapIn.length >= 2) {
      const a = snapIn[0].ctr ?? {}, b = snapIn[snapIn.length - 1].ctr ?? {};
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const d = (b[k] ?? 0) - (a[k] ?? 0);
        if (d) ctrDelta[k] = d;
      }
    }
    const shSeries = scrollFrames.map((f) => f.sh);
    const pwSeries = scrollFrames.map((f) => f.pw).filter((p) => p != null);
    const mathScroll = snapIn.filter((x) => x.math);
    arms.push({
      i: meta.i, mode: meta.mode, meta,
      switchWin, scrollWin, quietWin,
      switch: { frames: swFrames.length, jank32: swFrames.filter((f) => f.gap > 32).length,
        gapMax: quantile(swFrames.map((f) => f.gap).filter((g) => g != null), 1) },
      scroll: { frames: scrollFrames.length, jank32: jankScroll.length,
        jank32Ratio: scrollFrames.length ? +(jankScroll.length / scrollFrames.length).toFixed(5) : null,
        gapP50: quantile(scrollGaps, 0.5), gapP95: quantile(scrollGaps, 0.95), gapMax: quantile(scrollGaps, 1),
        longtask50: ltScroll.length, ltDurSumMs: Math.round(ltScroll.reduce((s, e) => s + e.dur, 0)),
        shiftFrames: shiftScroll.length, shiftDetail: shiftScroll.slice(0, 20),
        shVar: variance(shSeries), shMin: shSeries.length ? Math.min(...shSeries) : null,
        shMax: shSeries.length ? Math.max(...shSeries) : null,
        pwStart: pwSeries[0] ?? null, pwEnd: pwSeries[pwSeries.length - 1] ?? null,
        mathUnreadyMax: mathScroll.length ? Math.max(...mathScroll.map((x) => x.math.unready)) : null },
      quiet: { frames: quietFrames.length, jank32: quietFrames.filter((f) => f.gap > 32).length,
        gapP95: quantile(quietFrames.map((f) => f.gap).filter((g) => g != null), 0.95),
        longtask50: (rec.longtasks ?? []).filter((e) => inWin(e.t, quietWin)).length,
        driftShift: shiftQuiet.length, driftDetail: shiftQuiet.slice(0, 12),
        stStart: quietFrames[0]?.st ?? null, stEnd: quietFrames[quietFrames.length - 1]?.st ?? null },
      ctrDelta,
    });
  }
  const med = (arr) => { const a = arr.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
  const pickArm = (mode, field) => arms.filter((x) => x.mode === mode && x.scroll && !x.error).map((x) => x.scroll[field]);
  const fJ = pickArm('focus', 'jank32'), nJ = pickArm('normal', 'jank32');
  const fP = pickArm('focus', 'gapP95'), nP = pickArm('normal', 'gapP95');
  const wJ = pickArm('wctrl', 'jank32'), wP = pickArm('wctrl', 'gapP95');
  const hJ = pickArm('vhctrl', 'jank32'), hP = pickArm('vhctrl', 'gapP95');
  const symmetry = {
    jank32Median: { focus: med(fJ), normal: med(nJ) },
    jank32Ratio: (med(nJ) ?? 0) > 0 ? +(med(fJ) / med(nJ)).toFixed(3) : (med(fJ) ? 'inf(normal=0)' : 1),
    p95Median: { focus: med(fP), normal: med(nP) },
    p95Ratio: (med(nP) ?? 0) > 0 ? +(med(fP) / med(nP)).toFixed(3) : null,
    wctrlJank32Median: { wctrl: med(wJ) }, wctrlP95Median: { wctrl: med(wP) },
    vhctrlJank32Median: { vhctrl: med(hJ) }, vhctrlP95Median: { vhctrl: med(hP) },
    width: { focus: med(arms.filter((x) => x.mode === 'focus' && x.scroll).map((x) => x.scroll.pwStart)),
      wctrl: med(arms.filter((x) => x.mode === 'wctrl' && x.scroll).map((x) => x.scroll.pwStart)),
      vhctrl: med(arms.filter((x) => x.mode === 'vhctrl' && x.scroll).map((x) => x.scroll.pwStart)),
      normal: med(arms.filter((x) => x.mode === 'normal' && x.scroll).map((x) => x.scroll.pwStart)) },
  };
  return { arms, symmetry, totalFrames: frames.length, longtasksTotal: (rec.longtasks ?? []).length,
    marks, sentinelInfo: rec.sentinelInfo, wall0: rec.wall0 };
})()`;

const READ_GEO = `(() => {
  const host = document.querySelector('.mditor-editor-host');
  const pm = document.querySelector('.mditor-editor-host .ProseMirror');
  return host ? { top: Math.round(host.scrollTop), h: Math.round(host.scrollHeight), vh: host.clientHeight,
    pw: pm ? Math.round(pm.clientWidth) : null,
    isFocus: document.querySelector('.app').classList.contains('is-focus') } : null;
})()`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fs = await import("node:fs");
  if (args.exePath) EXE_CANDIDATES.unshift(args.exePath);
  const EXE = EXE_CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!EXE) { console.log("FAIL: 找不到打包版 exe"); process.exit(2); }
  console.log(`exe: ${EXE}`);
  // 预清理：杀掉所有残留 mditor 实例（run27/28 教训——single-instance 插件
  // 把新 spawn 转发给旧实例后自退，CDP 9224 连上的是旧进程 = 测错代码）
  const prekill = spawnSync("taskkill", ["/F", "/T", "/IM", "mditor.exe"], { stdio: "pipe", encoding: "utf8" });
  console.log(prekill.status === 0 ? `预清理: ${String(prekill.stdout || "").trim()}` : "预清理: 无残留实例");
  await sleep(2500);
  const row = { ts: new Date().toISOString(), tag: args.tag, phase: 2, scenario: args.scenario,
    doc: args.doc, depth: args.depth, upPx: args.upPx, arms: args.arms, settleMs: args.settleMs,
    prewarmMax: args.prewarmMax, run: args.run, exe: EXE, ok: false };

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
    // 转发劫持检测：spawn 的进程若已退出，说明 single-instance 转发给了残留
    // 实例（其 WebView2 占着 9224），CDP 连接对象不可信
    if (child.exitCode !== null) {
      console.log(`FAIL: spawn 进程已退出(exitCode=${child.exitCode})——疑似 single-instance 转发给残留实例，连接不可信`);
      kill(); process.exit(2);
    }
    row.childPid = child.pid;
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const m = mouse(cdp);
    for (let i = 0; i < 40; i++) { if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break; await sleep(1000); }
    // exe 身份钉：主样式表应含 focus-keepwarm keyframes（Fix-A 构建才有；
    // exp 注入的 style 元素此时还不存在，不会误报）
    const hasKw = await cdp.eval(`(() => { try { for (const sh of document.styleSheets) { let rr; try { rr = sh.cssRules; } catch { continue; } for (const r of rr) { if (r instanceof CSSKeyframesRule && r.name === "focus-keepwarm") return true; } } } catch { /* */ } return false; })()`);
    row.hasKeepwarmCSS = !!hasKw;
    console.log(`focus-keepwarm CSS: ${hasKw ? "存在" : "缺失"}`);
    if (args.expectKeepwarm && !hasKw) { console.log("FAIL: --expect-keepwarm 但样式表无 focus-keepwarm（exe 不含修复？）"); kill(); process.exit(2); }

    // 打开目标文档（prod 文件树）。run2~4 实测 CDP 坐标点击在 prod 窗口对
    // ft-row 不生效（dpr 1.75 坐标换算疑点）——改 DOM el.click() 直接触发
    // React onClick（handleRowClick → onToggle/onOpen），行为等价受信点击。
    const expandDir = async (dirName) => {
      const ok = await cdp.eval(`(() => {
        const hit = [...document.querySelectorAll('.ft-row.ft-dir')].find(r => {
          const n = r.querySelector('.ft-name')?.textContent ?? '';
          return n.includes(${JSON.stringify(dirName)});
        });
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
      console.log(`expandDir(${dirName}): ${ok ? "clicked" : "miss"}`);
      if (!ok) return false;
      await sleep(1500);
      return true;
    };
    const openDoc = async (sub) => {
      for (let i = 0; i < 12; i++) {
        const ok = await cdp.eval(`(() => {
          const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes(${JSON.stringify(sub)}));
          if (!hit) return false;
          hit.click();
          return true;
        })()`);
        if (ok) { console.log(`openDoc(${sub}): clicked (try ${i})`); return true; }
        if (i === 11) console.log(`openDoc(${sub}): 12 tries miss; ftRows=${await cdp.eval(`document.querySelectorAll(".ft-row").length`)}`);
        await sleep(800);
      }
      return false;
    };
    let opened = false;
    // 侧栏可能收起（上次会话残留）——.ft-row 不可见时先开侧栏（el.click 同款）
    for (let i = 0; i < 3; i++) {
      const vis = await cdp.eval(`(() => { const r = document.querySelector(".ft-row"); if (!r) return false; return r.getBoundingClientRect().width > 0; })()`);
      if (vis) break;
      await cdp.eval(`document.querySelector(".sidebar-opener")?.click()`);
      await sleep(1200);
    }
    // 候选序列：先试文件名直配（用户库或已添加的 fixtures 工作区），失败展开常见目录
    if (await openDoc(args.doc)) opened = true;
    if (!opened) {
      for (const d of ["01_专题笔记", "02_习题集", "cmc", "perf", "fixtures"]) {
        if (await expandDir(d) && await openDoc(args.doc)) { opened = true; break; }
      }
    }
    if (!opened) { console.log(`FAIL: prod 文件树找不到「${args.doc}」`); process.exit(2); }
    console.log(`文档已开: ${args.doc}`);
    await sleep(8000);
    const big = await cdp.eval(`(() => { const h = document.querySelector('.mditor-editor-host'); return h ? h.dataset.big !== undefined : null; })()`);
    let s = await cdp.eval(READ_GEO);
    console.log(`big=${big} geo=${JSON.stringify(s)}`);
    row.big = big;

    // 预热等待（release 应可完成；超时记录后继续 = 用户早期会话态）
    const t1 = Date.now();
    let prewarmDone = false;
    while (Date.now() - t1 < args.prewarmMax * 1000) {
      const done = await cdp.eval(`(() => { const sd = window.__scrollDebug; if (!sd) return false; const es = typeof sd.events === 'function' ? sd.events() : sd.events; return (es ?? []).some(e => e.kind === 'prewarm.done'); })()`);
      if (done) { prewarmDone = true; break; }
      await sleep(3000);
    }
    row.prewarmDone = prewarmDone;
    row.prewarmWaitMs = Date.now() - t1;
    console.log(`预热${prewarmDone ? "完成" : "超时"}（${row.prewarmWaitMs}ms）`);
    s = await cdp.eval(READ_GEO);

    // 切换器（同 dev 版）
    const focusBtnPos = async () => cdp.eval(`(() => {
      const b = document.querySelector('button.sb-icon-btn[title="焦点模式"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    const sendEsc = async () => {
      for (const type of ["keyDown", "keyUp"]) {
        await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape",
          windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      }
    };
    const setMode = async (wantFocus) => {
      let geo = await cdp.eval(READ_GEO);
      if (geo.isFocus === wantFocus) return geo;
      if (wantFocus) {
        const p = await focusBtnPos();
        if (!p) return null;
        await m.click(p.x, p.y);
      } else {
        await sendEsc();
      }
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        geo = await cdp.eval(READ_GEO);
        if (geo.isFocus === wantFocus) return geo;
      }
      return null;
    };

    const startRes = await cdp.eval(JANK_SAMPLER);
    console.log(`采样器: ${startRes}`);
    if (!String(startRes).startsWith("started")) process.exit(2);

    const cx = 640, cy = 400;
    const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
    const wheel = async (dy, pause) => { await m.wheel(cx, cy, 0, dy); await sleep(pause); };
    const fast = async (px) => { const n = Math.ceil(Math.abs(px) / 1200); for (let i = 0; i < n; i++) await wheel(Math.sign(px) * 1200, 90); };
    const slow = async (px) => { const n = Math.ceil(Math.abs(px) / 220); for (let i = 0; i < n; i++) await wheel(Math.sign(px) * 220, 450); };
    const dir = args.scenario.split("-")[0];
    const spd = args.scenario.split("-")[1];
    const drive = async (dist) => { if (spd === "fast") await fast(dist); else await slow(dist); };

    const isNafExp = () => /^naf-/.test(args.exp);
        const first = args.firstArm === "focus" ? "focus" : "normal";
    const other = first === "focus" ? "normal" : "focus";
    let seq = [first, other, other, first, first, other];
    // width-ctrl 臂（F-b 隔离实验）：normal 模式下窗口加宽至 .ProseMirror ≈
    // focus 宽度（先切 focus 量差再回），臂序 N W N W N W——与 focus run 数据
    // 跨 run 对比（wctrl ≈ focus → 宽度定罪；wctrl ≈ normal → 模式特有机制）。
    let winId = null, winW0 = 0, winH0 = 0, widthPx = args.widthPx, vhDelta = 0;
    if (args.widthCtrl) {
      seq = ["normal", "wctrl", "normal", "wctrl", "normal", "wctrl"];
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId });
      winId = windowId; winW0 = bounds.width;
      if (!widthPx) {
        const gn = await cdp.eval(READ_GEO);
        const gf = await setMode(true);
        await sleep(800);
        const g1 = await cdp.eval(READ_GEO);
        widthPx = Math.max(0, (g1?.pw ?? 0) - (gn?.pw ?? 0));
        await setMode(false);
        await sleep(800);
      }
      row.widthPx = widthPx;
      console.log(`width-ctrl 增量: ${widthPx}px（窗口 ${winW0}→${winW0 + widthPx}）`);
    } else if (args.exp === "vh-align" || args.exp === "wh-align" || args.exp === "normal-as-focus" || isNafExp()) {
      // vh 对齐对照：normal 模式 + 窗口加高（wh-align 再加宽）至 host 几何 ≈ focus
      seq = ["normal", "vhctrl", "normal", "vhctrl", "normal", "vhctrl"];
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId });
      winId = windowId; winW0 = bounds.width; winH0 = bounds.height;
      const gn = await cdp.eval(READ_GEO);
      await setMode(true); await sleep(800);
      const gf = await cdp.eval(READ_GEO);
      await setMode(false); await sleep(800);
      vhDelta = Math.max(0, (gf?.vh ?? 0) - (gn?.vh ?? 0));
      if (!widthPx) widthPx = Math.max(0, (gf?.pw ?? 0) - (gn?.pw ?? 0));
      row.vhDelta = vhDelta; row.widthPx = (args.exp === "wh-align" || args.exp === "normal-as-focus" || isNafExp()) ? widthPx : 0;
      console.log(`${args.exp} 增量: vh+${vhDelta}px pw+${args.exp === "wh-align" ? widthPx : 0}px（normal ${gn?.pw}×${gn?.vh} → focus ${gf?.pw}×${gf?.vh}）`);
    }
    row.armSeq = seq;
    console.log(`臂序: ${seq.join(",")}`);

    await cdp.eval(mark("probe-begin"));
    const armMetas = [];
    for (let ai = 0; ai < seq.length; ai++) {
      const mode = seq[ai];
      const armLabel = `arm-${ai}-${mode}`;
      await cdp.eval(mark(`${armLabel}-switch-begin`));
      if (args.widthCtrl) {
        // 全程 normal 模式；wctrl 臂拉宽窗口、normal 臂还原
        const g0 = await setMode(false);
        if (!g0) throw new Error("切 normal 失败");
        await cdp.send("Browser.setWindowBounds", { windowId: winId,
          bounds: { width: winW0 + (mode === "wctrl" ? widthPx : 0) } });
        await sleep(600);
      } else if (args.exp === "vh-align" || args.exp === "wh-align" || args.exp === "normal-as-focus" || isNafExp()) {
        // 全程 normal 模式；vhctrl 臂加高（wh-align 同时加宽）、normal 臂还原
        const g0 = await setMode(false);
        if (!g0) throw new Error("切 normal 失败");
        const dW = mode === "vhctrl" && (args.exp === "wh-align" || args.exp === "normal-as-focus" || isNafExp()) ? widthPx : 0;
        await cdp.send("Browser.setWindowBounds", { windowId: winId,
          bounds: { width: winW0 + dW, height: winH0 + (mode === "vhctrl" ? vhDelta : 0) } });
        await sleep(600);
      } else {
        const g0 = await setMode(mode === "focus");
        if (!g0) throw new Error(`切 ${mode} 失败`);
      }
      // 原型实验（--exp，跑完即恢复，不合入）：focus 臂上隔离 focus 特有
      // 差异——CSS 二分定罪（临时注入 style，arm 末移除）。
      // normal-as-focus（挂在 vhctrl 臂）：normal 模式 + is-focus 等效 CSS
      //（chrome display:none + padding/border 归零 + sidebar 塌缩）+ 双维
      // 几何对齐——分离「CSS 视觉层效应」vs「React 卸载差异」（Sidebar/
      // Opener/AiPanel 卸载与 hover-zone 挂载只存在于真 focus）。
      const INJECTS = {
        "no-hover-zone": `.focus-hover-zone{display:none!important}`,
        "no-toolbar": `.focus-toolbar{display:none!important}`,
        "restore-main": `.is-focus .main{border:1px solid var(--border);border-radius:var(--radius-l);box-shadow:var(--shadow)}`,
        "restore-main-radius": `.is-focus .main{border-radius:var(--radius-l)}`,
        "restore-main-shadow": `.is-focus .main{box-shadow:var(--shadow)}`,
        "restore-app-pad": `.is-focus .app{padding:var(--frame-pad)}`,
        "normal-as-focus": `.titlebar,.tabbar,.sb-status,.resizer,.sidebar-opener,.ai-fab{display:none!important}` +
          `.app{padding:0}.main{border:none;border-radius:0;box-shadow:none}` +
          `.sidebar{width:0;opacity:0;border:none;pointer-events:none;transform:translateX(-12px)}`,
        // normal-as-focus 分组二分（判定哪一组是触发面；几何对齐同 naf-*）
        "naf-titlebar": `.titlebar{display:none!important}`,
        "naf-tabbar": `.tabbar{display:none!important}`,
        "naf-status": `.sb-status{display:none!important}`,
        "naf-sidebar": `.sidebar{width:0;opacity:0;border:none;pointer-events:none;transform:translateX(-12px)}`,
        "naf-chrome-all": `.titlebar,.tabbar,.sb-status,.resizer,.sidebar-opener,.ai-fab{display:none!important}`,
        "naf-chrome-pair-ts": `.titlebar,.sb-status{display:none!important}`,
        "naf-chrome-tts": `.titlebar,.tabbar,.sb-status{display:none!important}`,
        "fab-noanim": `.ai-fab:not(.active)::after{animation:none!important}`,
        "keepwarm2": `.focus-hover-zone::after{content:"";position:absolute;left:0;top:0;width:1px;height:1px;pointer-events:none;animation:focus-keepwarm2 1.2s linear infinite}@keyframes focus-keepwarm2{0%,100%{opacity:0}50%{opacity:0.02}}`,
        "fab-invisible": `.is-focus .ai-fab{display:flex!important;opacity:0!important;pointer-events:none!important}`,
        "fab-ghost": `.is-focus .ai-fab{display:flex!important;opacity:0.05!important;pointer-events:none!important}`,
        "main-jitter": `.is-focus .main{animation:r9jitter 2.4s linear infinite!important}@keyframes r9jitter{0%,100%{transform:translateZ(0)}50%{transform:translateZ(0.001px)}}`,
        "keepwarm": `.focus-hover-zone::after{content:"";position:absolute;left:0;top:0;width:1px;height:1px;pointer-events:none;opacity:0;animation:focus-keepwarm 2.4s linear infinite}@keyframes focus-keepwarm{0%,100%{transform:translateZ(0)}50%{transform:translateZ(0.001px)}}`,
        "naf-fab-noanim": `.ai-fab:not(.active)::after{animation:none!important}`,
        "naf-resizer": `.resizer{display:none!important}`,
        "naf-fab": `.ai-fab{display:none!important}`,
        "naf-chrome-rest": `.resizer,.sidebar-opener,.ai-fab{display:none!important}`,
      };
      const isNaf = /^naf-/.test(args.exp);
      const injectFor = args.exp === "normal-as-focus" || isNaf
        ? (mode === "vhctrl" ? INJECTS[args.exp] : "")
        : (mode === "focus" ? INJECTS[args.exp] : null);
      if (injectFor != null) {
        if (injectFor) {
          await cdp.eval(`(() => { let s = document.getElementById("r9-exp-style"); if (!s) { s = document.createElement("style"); s.id = "r9-exp-style"; document.head.appendChild(s); } s.textContent = ${JSON.stringify(injectFor)}; })()`);
          console.log(`${armLabel}: exp=${args.exp} 注入`);
        } else {
          await cdp.eval(`(() => { const s = document.getElementById("r9-exp-style"); if (s) s.textContent = ""; })()`);
        }
      }
      await cdp.eval(mark(`${armLabel}-switched`));
      await sleep(args.settleMs);
      await cdp.eval(mark(`${armLabel}-settle-end`));
      let g = await cdp.eval(READ_GEO);
      // 保温动画活性（focus 臂实测）：证明测量期间 Fix-A 动画真的挂在 .main 上
      const kwLive = mode === "focus"
        ? await cdp.eval(`(() => { const el = document.querySelector('.main'); if (!el) return null; const cs = getComputedStyle(el); return { name: cs.animationName, ps: cs.animationPlayState }; })()`)
        : null;
      const stride = args.stridePx > 0 ? args.stridePx : args.upPx + 5000;
      const maxStart = Math.max(0, (g.h - g.vh) - args.upPx - 200);
      let startTop;
      if (dir === "down") {
        startTop = Math.round((g.h - g.vh) * args.depth) + ai * stride;
      } else {
        const downStart = Math.round((g.h - g.vh) * args.depth) + ai * stride;
        startTop = Math.min(g.h - g.vh, downStart + Math.min(args.upPx, (g.h - g.vh) - downStart));
      }
      if (startTop > maxStart) startTop = maxStart;
      await cdp.eval(mark(`${armLabel}-leg-begin`));
      if (Math.abs(startTop - g.top) > 10) await fast(startTop - g.top);
      await sleep(1200);
      g = await cdp.eval(READ_GEO);
      const dist = dir === "down"
        ? Math.max(100, Math.min(args.upPx, (g.h - g.vh) - g.top))
        : Math.max(100, Math.min(args.upPx, g.top));
      await cdp.eval(mark(`${armLabel}-drive-begin`));
      await drive(dir === "down" ? dist : -dist);
      await cdp.eval(mark(`${armLabel}-drive-end`));
      g = await cdp.eval(READ_GEO);
      armMetas.push({ i: ai, mode, startTop, dist, endTop: g.top, h: g.h, pw: g.pw, kw: kwLive });
      console.log(`${armLabel}: start=${startTop} dist=${dist} end=${g.top} h=${g.h} pw=${g.pw}${kwLive ? ` kw=${kwLive.name}/${kwLive.ps}` : ""}`);
      await sleep(400);
      // quiet 观察窗（D1）：rAF 采样器在页面里自跑；这里每 5s 一次轻量 eval
      // 保活 CDP ws（run1 实测长空闲后 ws 死链——eval 永久挂起）
      for (let q = 0; q < args.quietSecs; q += 5) {
        await sleep(Math.min(5000, (args.quietSecs - q) * 1000));
        await withTimeout(cdp.eval(`window.__r9focus ? 1 : 0`), 8000);
      }
      await cdp.eval(mark(`${armLabel}-arm-end`));
      // 原型 style 清场（exp 注入的 focus 臂结束即恢复原样式）
      await cdp.eval(`(() => { const s = document.getElementById("r9-exp-style"); if (s) s.textContent = ""; })()`);
    }
    await cdp.eval(mark("probe-end"));

    // 收尾（全 eval 带 8~30s 超时保护——run1 实测 CDP 死链会永久挂起无超时的 eval）
    await withTimeout(cdp.eval(`window.__r9focus.stop = true`), 8000);
    const tw = Date.now();
    while (Date.now() - tw < 5000) {
      const st = await withTimeout(cdp.eval(`window.__r9focus ? { done: window.__r9focus.done } : null`), 8000);
      if (!st) break; // eval 超时：不再等，直接尝试分析
      if (st.done) break;
      await sleep(300);
    }
    const analysis = await withTimeout(cdp.eval(ANALYZE_EXPR(JSON.stringify(armMetas))), 30_000);
    if (!analysis || analysis.error) {
      console.log("FAIL: 页内分析失败/超时: " + JSON.stringify(analysis));
      kill();
      process.exit(2);
    }
    const jankBig = await withTimeout(cdp.eval(`JSON.parse(JSON.stringify(window.__r9focus))`), 90_000);
    const eventsInWindow = await withTimeout(cdp.eval(`(() => { const sd = window.__scrollDebug; if (!sd) return []; const es = typeof sd.events === 'function' ? sd.events() : sd.events; return (es ?? []).slice(-160).map(e => ({ ts: e.ts, level: e.level, kind: e.kind, msg: (e.msg || '').slice(0, 160) })); })()`), 30_000);
    const trapLog = await withTimeout(cdp.eval(`window.__scrollDebug && window.__scrollDebug.trap ? window.__scrollDebug.trap() : []`), 30_000);
    const pumpEnd = await withTimeout(cdp.eval(`typeof window.__mathPumpStats === 'function' ? window.__mathPumpStats() : null`), 30_000);

    row.analysis = { arms: analysis.arms, symmetry: analysis.symmetry };
    row.jank = jankBig
      ? { framesList: jankBig.framesList, marks: analysis.marks, longtasks: jankBig.longtasks, snap: jankBig.snap, sentinelInfo: analysis.sentinelInfo, wall0: analysis.wall0 }
      : { skipped: "export-timeout", marks: analysis.marks, sentinelInfo: analysis.sentinelInfo, wall0: analysis.wall0 };
    row.eventsInWindow = eventsInWindow ?? { skipped: "export-timeout" };
    row.trap = trapLog ?? { skipped: "export-timeout" };
    row.pumpEnd = pumpEnd ?? { skipped: "export-timeout" };
    console.log(`对称汇总: ${JSON.stringify(analysis.symmetry)}`);
    row.ok = true;
    // 证据先落盘（r9fix2-run29 教训：归位收尾挂起会吞掉整 run 数据）
    const fixtureShort = args.doc.includes("1MB") ? "1mb" : args.doc.includes("密度档") ? "density" : "other";
    const out = join(RESULTS_DIR, `r9-phase2-prod-jank-abab-${args.scenario}-${fixtureShort}-${args.tag}-${args.run}.json`);
    writeFileSync(out, JSON.stringify(row), "utf8");
    console.log(`证据落盘 ${out}`);
    // focusMode 归位 + 窗口尺寸还原（prod 用户环境不残留；best-effort 8s 超时
    // ——run29 实测此处无超时 eval 在 CDP 慢死链上永久挂起，故数据已先行落盘）
    await withTimeout(setMode(false), 8000);
    if ((args.widthCtrl || args.exp === "vh-align") && winId != null) {
      try { await withTimeout(cdp.send("Browser.setWindowBounds", { windowId: winId, bounds: { width: winW0, height: winH0 } }), 8000); } catch { /* */ }
    }
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
