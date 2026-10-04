// probe-focus-jank.mjs —— R9 阶段二/三：症状 F（专注模式滚动掉帧）取证探针（一次性，不入库）
//
// 用法：node perf/tmp-r9/probe-focus-jank.mjs --scenario down-slow|down-fast|up-slow|up-fast
//        [--doc 无穷级数_密度档|1MB] [--tag r9p2] [--phase 2] [--run 1]
//        [--depth 0.6] [--up-px 5000] [--arms 3] [--prewarm-wait] [--quiet-secs 10]
//        [--settle-ms 2000] [--width-ctrl] [--first-arm normal|focus] [--stride-px 0]
//
// 蓝本 perf/tmp-r8/probe-jank.mjs（同款起 dev(9223)/开档/滚轮驱动/PID 清理）。
// 本轮（R9）新增——模式对称性口径（任务书 §5）：
//  - 同一会话内 focus/normal 双臂 ABAB 交错（默认 A B B A A B，arms=3 对）：
//    normal→focus 点状态栏按钮（button.sb-icon-btn[title="焦点模式"]），
//    focus→normal 派发 Esc（useMenuCommands 全局 keydown，不改任何 src）。
//    同会话切换保护高度表内存态（reload 会清空 cvMemory store，破坏 F-a
//    实验条件）。
//  - 每臂：切换后 settle（默认 2s，F5 切换段单独分窗）→ 按文档深度比例回位
//    （leg 段排除）→ 同序列滚动（fast=1200px/90ms / slow=220px/450ms）→
//    停滚 quiet 观察窗（D1 双臂口径：rawShift>4px 帧数 + trap 写入差分）。
//  - 帧级新增采样：每帧 host.scrollHeight（F4 方差口径）+ .ProseMirror
//    clientWidth（宽度突变自证）+ 墙钟 Date.now()（与事件流对齐）。
//  - 快照计数器差分口径扩充：cv.relearn / layout:* / block.* / anchor.* /
//    prewarm.* / write.*（scrollEmit 每发必计数，不受 cv.relearn 1s 限流
//    影响的是 emit 侧——计数同样限流，作存在性/节律证据用，低估留档）。
//  - --width-ctrl：宽度对齐控制臂（F-b 隔离实验）——normal 模式下用
//    Browser.setWindowBounds 把窗口加宽至 .ProseMirror 内容宽度 ≈ 专注模式
//    宽度（先量 focus 臂宽度差再二次运行时直接指定增量），臂序 A W A W A W，
//    与 focus run 的对照走分析期对齐（自证两臂宽度差 <10px）。
// 分析口径：scrollPhase=[drive-begin, drive-end+400ms]（F1/F2/F3）；
//   quietPhase=[drive-end+400, +quiet-secs]（D1）；switchPhase=[切臂起点,
//   settle 末]（F5）；对称比 = focus 臂指标中位 / normal 臂指标中位。
// 红线：只加观测不改任何 src/ 行为；结果只追加 perf/results/r9-*.json。

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { Cdp, mouse, sleep } from "../cdp.mjs";

const PORT = 9223;
const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..", "..");
const REPO_ROOT = resolve(MDITOR_DIR, "..");
const FORENSICS_DIR = join(REPO_ROOT, ".workflow", "task2-forensics");
const RESULTS_DIR = join(MDITOR_DIR, "perf", "results");
const STORE_PATH = join(process.env.APPDATA ?? ".", "com.mditor.app.dev", "mditor.json");

function parseArgs(argv) {
  const a = { scenario: "down-slow", doc: "无穷级数_密度档", tag: "r9p2", phase: 2, run: 1,
    depth: 0.6, upPx: 5000, arms: 3, prewarmWait: false, quietSecs: 10, settleMs: 2000, widthCtrl: false, widthPx: 0,
    firstArm: "normal", stridePx: 0 };
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
    else if (k === "--arms") a.arms = Number(next() ?? 3);
    else if (k === "--prewarm-wait") a.prewarmWait = true;
    else if (k === "--quiet-secs") a.quietSecs = Number(next() ?? 10);
    else if (k === "--settle-ms") a.settleMs = Number(next() ?? 2000);
    else if (k === "--width-ctrl") a.widthCtrl = true;
    else if (k === "--width-px") a.widthPx = Number(next() ?? 0);
    else if (k === "--first-arm") a.firstArm = next();
    else if (k === "--stride-px") a.stridePx = Number(next() ?? 0);
  }
  return a;
}
async function portFree(port = PORT) {
  try { await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(700) }); return false; } catch { return true; }
}
function run(cmd, args) { spawnSync(cmd, args, { stdio: "ignore", windowsHide: true }); }
function vitePortPids() {
  const r = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
  const pids = new Set();
  for (const line of String(r.stdout || "").split("\n")) {
    if (/TCP\s+\S+:1420\s+\S+\s+LISTENING/i.test(line)) {
      const pid = line.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid)) pids.add(pid);
    }
  }
  return [...pids];
}
function killChildTree(child) { try { if (child && child.pid) run("taskkill", ["/F", "/T", "/PID", String(child.pid)]); } catch { /* */ } }
function killStalePorts() {
  const r = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
  for (const line of String(r.stdout || "").split("\n")) {
    if (/TCP\s+\S+:(1420|9223)\s+\S+\s+LISTENING/i.test(line)) {
      const pid = line.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid)) run("taskkill", ["/F", "/T", "/PID", pid]);
    }
  }
}
function editStore() {
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  const holder = raw.settings ? raw : raw.value;
  holder.settings.devMode = false;
  holder.settings.bigDocViewport = true; // 复刻生产用户实况（R5~R8 探针同款）
  holder.settings.bigDocPerformance = false;
  holder.settings.focusMode = false; // 起始臂固定 normal（会话内运行时切换）
  if ("typewriterMode" in holder.settings) holder.settings.typewriterMode = false;
  writeFileSync(STORE_PATH, JSON.stringify(raw, null, 2), "utf8");
  return { workspaces: raw.workspaces ?? [] };
}
function cargoResidue() {
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq cargo.exe", "/FO", "CSV"], { encoding: "utf8", windowsHide: true });
  return String(r.stdout || "").split("\n").filter((l) => /cargo\.exe/i.test(l)).length;
}
function findDoc(workspaces, sub) {
  for (const ws of workspaces) {
    try {
      for (const e of readdirSync(ws, { recursive: true })) {
        const n = basename(String(e));
        if (n.startsWith(".")) continue; // .pristine-* 镜像不入口径
        if (n.toLowerCase().includes(sub.toLowerCase()) && n.endsWith(".md")) return join(ws, String(e));
      }
    } catch { /* */ }
  }
  return null;
}

// 页内采样器（蓝本 R8 JANK_SAMPLER；R9 增量：每帧 scrollHeight + pm 宽度 +
// 墙钟；跨臂长跑，marks 划臂界）。每帧固定读 3×rect + 2×布局缓存属性——
// 观测税两臂对称，不影响对称比；绝对值口径全程同款自比。
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

// 页内分臂分析（R9 v3：收尾卡死防御——run5 实测大对象 CDP 导出可无限挂起，
// 分析移入浏览器端轻量返回；帧明细大导出退化为 best-effort，超时即弃——
// 摘要含全部门禁指标，明细仅诊断用）。
const ANALYZE_EXPR = (armMetasJson, optsJson) => `(() => {
  const armMetas = ${armMetasJson};
  const opts = ${optsJson};
  const rec = window.__r9focus;
  if (!rec) return { error: 'no-rec' };
  const frames = rec.framesList ?? [];
  const marks = rec.marks ?? [];
  const findMark = (label) => { const hit = [...marks].reverse().find((x) => x.label === label); return hit ? hit.t : null; };
  const inWin = (t, w) => w && t >= w[0] && t < w[1];
  const quantile = (arr, q) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * q))] * 10) / 10; };
  const variance = (arr) => { if (!arr.length) return null; const mu = arr.reduce((s, x) => s + x, 0) / arr.length; return Math.round(arr.reduce((s, x) => s + (x - mu) * (x - mu), 0) / arr.length); };
  const arms = [];
  for (const meta of armMetas) {
    const lab = 'arm-' + meta.i + '-' + meta.mode;
    const swB = findMark(lab + '-switch-begin'), swE = findMark(lab + '-settle-end');
    const legB = findMark(lab + '-leg-begin'), dB = findMark(lab + '-drive-begin'), dE = findMark(lab + '-drive-end'), aE = findMark(lab + '-arm-end');
    if (swB == null || dB == null || dE == null || aE == null) { arms.push({ i: meta.i, mode: meta.mode, error: 'marks-missing' }); continue; }
    const QUIET_GATE = 400;
    const switchWin = [swB, swE], scrollWin = [dB, dE + QUIET_GATE], quietWin = [dE + QUIET_GATE, aE];
    const scrollFrames = frames.filter((f) => inWin(f.t, scrollWin));
    const quietFrames = frames.filter((f) => inWin(f.t, quietWin));
    const swFrames = frames.filter((f) => inWin(f.t, switchWin));
    const scrollGaps = scrollFrames.map((f) => f.gap).filter((g) => g != null);
    const quietGaps = quietFrames.map((f) => f.gap).filter((g) => g != null);
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
        gapP95: quantile(quietGaps, 0.95), longtask50: (rec.longtasks ?? []).filter((e) => inWin(e.t, quietWin)).length,
        driftShift: shiftQuiet.length, driftDetail: shiftQuiet.slice(0, 12),
        stStart: quietFrames[0]?.st ?? null, stEnd: quietFrames[quietFrames.length - 1]?.st ?? null },
      ctrDelta,
    });
  }
  const med = (arr) => { const a = arr.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
  const pickArm = (mode, field) => arms.filter((x) => x.mode === mode && x.scroll && !x.error).map((x) => x.scroll[field]);
  const symmetry = {};
  if (!opts.widthCtrl) {
    const fJ = pickArm('focus', 'jank32'), nJ = pickArm('normal', 'jank32');
    const fP = pickArm('focus', 'gapP95'), nP = pickArm('normal', 'gapP95');
    symmetry.jank32Median = { focus: med(fJ), normal: med(nJ) };
    symmetry.jank32Ratio = (med(nJ) ?? 0) > 0 ? +(med(fJ) / med(nJ)).toFixed(3) : (med(fJ) ? 'inf(normal=0)' : 1);
    symmetry.p95Median = { focus: med(fP), normal: med(nP) };
    symmetry.p95Ratio = (med(nP) ?? 0) > 0 ? +(med(fP) / med(nP)).toFixed(3) : null;
    symmetry.width = { focus: med(arms.filter((x) => x.mode === 'focus' && x.scroll).map((x) => x.scroll.pwStart)),
      normal: med(arms.filter((x) => x.mode === 'normal' && x.scroll).map((x) => x.scroll.pwStart)) };
  } else {
    symmetry.wctrlJank32Median = { wctrl: med(pickArm('wctrl', 'jank32')), normal: med(pickArm('normal', 'jank32')) };
    symmetry.wctrlP95Median = { wctrl: med(pickArm('wctrl', 'gapP95')), normal: med(pickArm('normal', 'gapP95')) };
    symmetry.width = { wctrl: med(arms.filter((x) => x.mode === 'wctrl' && x.scroll).map((x) => x.scroll.pwStart)),
      normal: med(arms.filter((x) => x.mode === 'normal' && x.scroll).map((x) => x.scroll.pwStart)) };
  }
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
  mkdirSync(FORENSICS_DIR, { recursive: true }); mkdirSync(RESULTS_DIR, { recursive: true });
  const devlogPath = join(FORENSICS_DIR, `devlog-r9-${args.tag}-${args.scenario}-${args.run}.txt`);
  const logFd = openSync(devlogPath, "w");
  const log = (m) => { try { writeSync(logFd, `[${new Date().toISOString()}] ${m}\n`); } catch { /* */ } console.log(m); };

  let child = null, cdp = null;
  const row = { ts: new Date().toISOString(), tag: args.tag, phase: args.phase, scenario: args.scenario,
    doc: args.doc, depth: args.depth, upPx: args.upPx, arms: args.arms, prewarmWait: args.prewarmWait,
    widthCtrl: args.widthCtrl, widthPx: args.widthPx, settleMs: args.settleMs, run: args.run, ok: false };
  try {
    if (!(await portFree())) { log("预检失败: 9223 被占"); return (closeLog(), 2); }
    const stale = vitePortPids();
    if (stale.length) { log(`预检失败: vite 残留 PID ${stale.join(",")}`); return (closeLog(), 2); }
    if (cargoResidue() > 0) { log("预检失败: cargo watch 残留"); return (closeLog(), 2); }
    const { workspaces } = editStore();
    const docPath = findDoc(workspaces, args.doc);
    if (!docPath) { log(`找不到文档 ${args.doc}`); return (closeLog(), 2); }
    log(`目标文档: ${docPath}`);

    const spawnAt = Date.now();
    child = spawn("cmd.exe", ["/c", "npx", "tauri", "dev", "--config", "src-tauri/tauri.dev.conf.json"], {
      cwd: MDITOR_DIR, env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    for (const s of [child.stdout, child.stderr]) s.on("data", (d) => { try { writeSync(logFd, d); } catch { /* */ } });
    let target = null;
    while (Date.now() - spawnAt < 150_000) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(700) });
        const page = (await res.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) { target = page; break; }
      } catch { /* */ }
      await sleep(500);
    }
    if (!target) { log("CDP 未就绪"); return (closeLog(), 2); }
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const m = mouse(cdp);
    try { await cdp.send("Network.enable"); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }); } catch { /* */ }
    for (let i = 0; i < 120; i++) { if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break; await sleep(500); }
    try { await cdp.send("Page.enable"); await cdp.send("Page.reload", { ignoreCache: true }); } catch { /* */ }
    for (let i = 0; i < 120; i++) { if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break; await sleep(500); }

    const openDoc = async (sub) => {
      for (let i = 0; i < 40; i++) {
        const p = await cdp.eval(`(() => {
          const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes(${JSON.stringify(sub)}));
          if (!hit) return null;
          const r = hit.getBoundingClientRect();
          if (r.width === 0) return null;
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`);
        if (p) { await m.click(p.x, p.y); return true; }
        await sleep(500);
      }
      return false;
    };
    if (!await openDoc(args.doc)) { log("文件树找不到目标文档"); return (closeLog(), 2); }

    await sleep(args.prewarmWait ? 6000 : 8000);
    const big = await cdp.eval(`(() => { const h = document.querySelector('.mditor-editor-host'); return h ? h.dataset.big !== undefined : null; })()`);
    let s = await cdp.eval(READ_GEO);
    log(`文档已开 big=${big} geo=${JSON.stringify(s)}`);
    row.big = big;
    row.pumpAvailable = await cdp.eval(`typeof window.__mathPumpStats === 'function'`);

    if (args.prewarmWait) {
      const t0 = Date.now();
      while (Date.now() - t0 < 150_000) {
        const done = await cdp.eval(`(() => { const sd = window.__scrollDebug; if (!sd) return false; const es = typeof sd.events === 'function' ? sd.events() : sd.events; return (es ?? []).some(e => e.kind === 'prewarm.done'); })()`);
        if (done) { log("预热已完成"); break; }
        await sleep(2000);
      }
      row.prewarmed = true;
      s = await cdp.eval(READ_GEO);
    }

    // ---- 模式切换器（运行时，不 reload：保护高度表内存态） ----
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
        if (!p) { log("找不到焦点模式按钮（状态栏被隐藏？）"); return null; }
        await m.click(p.x, p.y);
      } else {
        await sendEsc();
      }
      // 等类名翻转（最长 3s）
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        geo = await cdp.eval(READ_GEO);
        if (geo.isFocus === wantFocus) return geo;
      }
      log(`模式切换失败: 期望 isFocus=${wantFocus}`);
      return null;
    };

    // ---- 窗口宽度控制（--width-ctrl 臂用） ----
    let winBounds0 = null, winId = null;
    const getWin = async () => {
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId });
      winId = windowId; winBounds0 = bounds;
      return bounds;
    };
    const setWinWidth = async (width) => {
      await cdp.send("Browser.setWindowBounds", { windowId: winId, bounds: { width } });
      await sleep(300);
    };

    // 启动采样器（覆盖全部臂）
    const startRes = await cdp.eval(JANK_SAMPLER);
    log(`采样器: ${startRes}`);
    if (!String(startRes).startsWith("started")) return (closeLog(), 2);

    const cx = 640, cy = 400;
    const wheel = async (dy, pause) => { await m.wheel(cx, cy, 0, dy); await sleep(pause); };
    const fast = async (px) => { const n = Math.ceil(Math.abs(px) / 1200); for (let i = 0; i < n; i++) await wheel(Math.sign(px) * 1200, 90); };
    const slow = async (px) => { const n = Math.ceil(Math.abs(px) / 220); for (let i = 0; i < n; i++) await wheel(Math.sign(px) * 220, 450); };
    const dir = args.scenario.split("-")[0];
    const spd = args.scenario.split("-")[1];
    const drive = async (dist) => { if (spd === "fast") await fast(dist); else await slow(dist); };

    // 臂序（R9 修正案）：普通 run 用 X Y Y X X Y（X=first-arm，Y=另一臂，
    // 3 对 XY）；1MB 冷区上「重复滚同区间」会因 KaTeX 缓存/变现态持久化产生
    // 单调加热曲线（r9p2-2 实测 arm0 8fps → arm5 82fps），对称比被臂序混杂
    // 污染——改为每臂滚独立相邻区间（stride，默认 upPx+5000 不重叠），两 run
    // 交换 first-arm 抵消预热进度偏差（后臂略热的方向性）。
    const first = args.firstArm === "focus" ? "focus" : "normal";
    const other = first === "focus" ? "normal" : "focus";
    const seq = [];
    if (args.widthCtrl) {
      const w = first === "focus" ? "wctrl" : "normal"; // width-ctrl 通常以 normal 先
      const o = w === "normal" ? "wctrl" : "normal";
      for (let i = 0; i < args.arms; i++) { seq.push(w); seq.push(o); }
    } else {
      seq.push(first, other, other, first, first, other);
      if (args.arms > 3) for (let i = 3; i < args.arms; i++) seq.push(other, first);
    }
    row.armSeq = seq;
    log(`臂序: ${seq.join(",")}`);

    if (args.widthCtrl) {
      await getWin();
      if (!args.widthPx) {
        // 一次运行内先量 focus 宽度差（切过去量完即回）——只在本 run 首次
        const g0 = await cdp.eval(READ_GEO);
        const gf = await setMode(true);
        await sleep(800);
        const g1 = await cdp.eval(READ_GEO);
        args.widthPx = Math.max(0, (g1?.pw ?? 0) - (g0?.pw ?? 0));
        row.widthPx = args.widthPx;
        await setMode(false);
        await sleep(800);
        log(`宽度对齐增量实测: ${args.widthPx}px（focus pw=${g1?.pw} normal pw=${g0?.pw}）`);
      }
    }

    await cdp.eval(mark("probe-begin"));
    const armMetas = [];
    for (let ai = 0; ai < seq.length; ai++) {
      const mode = seq[ai];
      const armLabel = `arm-${ai}-${mode}`;
      await cdp.eval(mark(`${armLabel}-switch-begin`));
      if (mode === "wctrl") {
        await getWin();
        await setWinWidth(winBounds0.width + args.widthPx);
      } else if (mode === "focus") {
        const g = await setMode(true);
        if (!g) throw new Error("切 focus 失败");
      } else {
        const g = await setMode(false);
        if (!g) throw new Error("切 normal 失败");
      }
      await cdp.eval(mark(`${armLabel}-switched`));
      // 切换段（F5）：settle 期内持续采帧
      await sleep(args.settleMs);
      await cdp.eval(mark(`${armLabel}-settle-end`));
      // 回位（leg 段排除）：按深度比例重算目标（模式切换后 scrollHeight 已变）。
      // 每臂独立区间：base + ai×stride（默认 upPx+5000 不重叠），消除 1MB 冷区
      // 「重复滚同区间」的加热曲线混杂；越界夹取（密度档短文档配小 stride）。
      let g = await cdp.eval(READ_GEO);
      const stride = args.stridePx > 0 ? args.stridePx : args.upPx + 5000;
      const maxStart = Math.max(0, (g.h - g.vh) - args.upPx - 200);
      let startTop;
      if (dir === "down") {
        startTop = Math.round((g.h - g.vh) * args.depth) + ai * stride;
      } else {
        const downStart = Math.round((g.h - g.vh) * args.depth) + ai * stride;
        startTop = Math.min(g.h - g.vh, downStart + Math.min(args.upPx, (g.h - g.vh) - downStart));
      }
      if (startTop > maxStart) {
        log(`${armLabel}: 区间越界夹取 ${startTop}→${maxStart}（与其他臂可能重叠，减 stride）`);
        startTop = maxStart;
      }
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
      armMetas.push({ i: ai, mode, startTop, dist, endTop: g.top, h: g.h, pw: g.pw });
      log(`${armLabel}: start=${startTop} dist=${dist} end=${g.top} h=${g.h} pw=${g.pw}`);
      // quietPhase（D1 双臂）：停滚静止门 400ms + quietSecs
      await sleep(400 + args.quietSecs * 1000);
      await cdp.eval(mark(`${armLabel}-arm-end`));
    }
    await cdp.eval(mark("probe-end"));

    await cdp.eval(`window.__r9focus.stop = true`);
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const st = await cdp.eval(`window.__r9focus ? { done: window.__r9focus.done, frames: window.__r9focus.frames } : null`);
      if (st && st.done) break;
      await sleep(300);
    }
    // ① 页内分析（轻量，必得——防大导出挂死丢全部数据）
    const analysis = await cdp.eval(ANALYZE_EXPR(JSON.stringify(armMetas), JSON.stringify({ widthCtrl: args.widthCtrl })));
    if (!analysis || analysis.error) throw new Error("页内分析失败: " + JSON.stringify(analysis));
    // ② 帧明细大导出 best-effort（90s 超时即弃，摘要已保住）
    const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
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
    const a0 = analysis.arms.find((x) => !x.error);
    if (a0) {
      log(`臂0 (${a0.mode}) scroll: frames=${a0.scroll.frames} jank32=${a0.scroll.jank32}(${a0.scroll.jank32Ratio}) p95=${a0.scroll.gapP95} shVar=${a0.scroll.shVar} lt=${a0.scroll.longtask50}`);
    }
    if (!jankBig) log("警告: 帧明细大导出超时，仅落盘摘要");
    log(`对称汇总: ${JSON.stringify(analysis.symmetry)}`);
    row.ok = true;

    try { cdp.close(); } catch { /* */ }
    cdp = null;
    killChildTree(child);
    killStalePorts();
    child = null;
    const fixtureShort = args.doc.includes("1MB") ? "1mb" : args.doc.includes("无穷级数") ? "density" : args.doc.includes("解题技巧") ? "switch" : "other";
    const modeTag = args.widthCtrl ? "wctrl" : "abab";
    const out = join(RESULTS_DIR, `r9-phase${args.phase}-jank-${modeTag}-${args.scenario}-${fixtureShort}-${args.tag}-${args.run}.json`);
    writeFileSync(out, JSON.stringify(row), "utf8");
    log(`证据落盘 ${out}`);
    return (closeLog(), 0);
  } catch (e) {
    log("异常: " + (e?.stack || e));
    try { cdp && cdp.close(); } catch { /* */ }
    killChildTree(child);
    killStalePorts();
    return (closeLog(), 1);
  }
  function closeLog() { try { closeSync(logFd); } catch { /* */ } }
}
main().then((c) => process.exit(c ?? 0), (e) => { console.error(e?.stack || e); process.exit(2); });
