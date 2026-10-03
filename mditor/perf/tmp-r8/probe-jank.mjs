// probe-jank.mjs —— R8 阶段一/二：症状 U（上滚掉帧）取证探针（一次性，不入库）
//
// 用法：node perf/tmp-r8/probe-jank.mjs --scenario down-fast|down-slow|up-fast|up-slow
//        [--doc 无穷级数_密度档|1MB] [--tag r8p1] [--phase 1] [--run 1]
//        [--up-px 5000] [--depth 0.6] [--prewarm-wait] [--quiet-secs 10]
//
// 蓝本 probe-drift.mjs（R7，同款起 dev(9223)/开档/滚轮驱动/PID 清理），U 组新增：
//  - 驱动期逐帧 rAF 间隔记录（performance.now 差分，gap>32ms 判掉帧帧）；
//  - 页内 Longtask Observer（>50ms，含 attribution 尽量取）；
//  - 三哨兵 rect 逐帧（区分掉帧 vs 内容跳位，|Δtop|>4px 判位移帧）；
//  - 250ms 定期四路快照：mathTrack（ready/unready）+ __mathPumpStats +
//    __scrollDebug.counters 摘要，供 node 侧与掉帧帧时间对齐归因；
//  - marks 打点：down-leg（up 臂预备下滚段，分析时排除）/ drive-begin /
//    up-begin（上滚段起点）/ drive-end；分窗 scrollPhase=[段起点, drive-end
//    +400ms 静止门]、quietPhase=[drive-end+400, +quiet-secs]。
// 分析口径（U1/U2/U3）：scrollPhase 窗 gap>32ms 帧数与 gap p95 的 up/down 比、
// >32ms 帧占比、>50ms longtask 计数；U4/T 口径：quietPhase mathTrack unready。
// 红线：只加观测不改任何 src/ 行为；结果只追加 perf/results/r8-*.json。

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
  const a = { scenario: "up-fast", doc: "无穷级数_密度档", tag: "r8p1", phase: 1, run: 1,
    upPx: 5000, depth: 0.6, startDepth: 0, prewarmWait: false, quietSecs: 10 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);
    if (k === "--scenario") a.scenario = next();
    else if (k === "--doc") a.doc = next();
    else if (k === "--tag") a.tag = next();
    else if (k === "--phase") a.phase = Number(next() ?? 1);
    else if (k === "--run") a.run = Number(next() ?? 1);
    else if (k === "--up-px") a.upPx = Number(next() ?? 5000);
    else if (k === "--depth") a.depth = Number(next() ?? 0.6);
    else if (k === "--start-depth") a.startDepth = Number(next() ?? 0);
    else if (k === "--prewarm-wait") a.prewarmWait = true;
    else if (k === "--quiet-secs") a.quietSecs = Number(next() ?? 10);
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
/** 兜底清理：vite(1420)/WebView2(9223) 偶发脱离 cmd 树存活，预检端口惯例
 *  自证——只杀本次 run 期间确认存在（自 spawn）的监听 PID，不碰其他窗口的
 *  进程（本探针预检保证起跑前两端口空闲，见 main 预检分支）。 */
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
  holder.settings.bigDocViewport = true; // 复刻生产用户实况（R5~R7 探针同款）
  holder.settings.bigDocPerformance = false;
  if ("typewriterMode" in holder.settings) holder.settings.typewriterMode = false;
  writeFileSync(STORE_PATH, JSON.stringify(raw, null, 2), "utf8");
  return { workspaces: raw.workspaces ?? [] };
}
/** cargo watch 残留防呆：watcher 被复用时 tauri dev 起的 WebView2 不带
 *  CDP 环境变量（spawn 树外的旧 watcher 未知端口意图），CDP 永不就绪——
 *  预检即失败退出并提示，不自动杀（避免误伤其他工作区编译）。 */
function cargoResidue() {
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq cargo.exe", "/FO", "CSV"], { encoding: "utf8", windowsHide: true });
  return String(r.stdout || "").split("\n").filter((l) => /cargo\.exe/i.test(l)).length;
}
function findDoc(workspaces, sub) {
  for (const ws of workspaces) {
    try {
      for (const e of readdirSync(ws, { recursive: true })) {
        const n = basename(String(e));
        if (n.toLowerCase().includes(sub.toLowerCase()) && n.endsWith(".md")) return join(ws, String(e));
      }
    } catch { /* */ }
  }
  return null;
}

// 页内采样器：持续 rAF（node 侧置 __r8jank.stop 后收尾）。每帧轻量记录，
// 250ms 批量快照（math/pump/counters），Longtask Observer 独立时间线。
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
  const rec = { perf0: performance.now(), frames: 0, framesList: [], marks: [], longtasks: [],
    snap: [], sentinelInfo: sentinels.map((s) => ({ name: s.name, tag: s.el.tagName,
      text: (s.el.textContent || '').slice(0, 24) })), stop: false, done: false, err: null };
  window.__r8jank = rec;
  // Longtask 时间线（startTime 与帧 t 同 performance.now 时基）
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
          if (/^(prewarm\.|anchor\.|write\.|demote|io\.)/.test(k)) pickCtr[k] = counters[k];
        }
      }
      rec.snap.push({ t: Math.round(performance.now() - rec.perf0), math, pump, ctr: pickCtr });
    } catch { /* */ }
  };
  let lastSnapAt = 0;
  const tick = () => {
    try {
      if (rec.stop) { snapOnce(); rec.done = true; return; }
      const now = performance.now();
      const t = Math.round(now - rec.perf0);
      const row = { t, st: Math.round(host.scrollTop * 10) / 10 };
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

const mark = (label) => `window.__r8jank && window.__r8jank.marks.push({ t: Math.round(performance.now() - window.__r8jank.perf0), label: ${JSON.stringify(label)} }), 'ok'`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(FORENSICS_DIR, { recursive: true }); mkdirSync(RESULTS_DIR, { recursive: true });
  const devlogPath = join(FORENSICS_DIR, `devlog-r8-${args.tag}-${args.scenario}-${args.run}.txt`);
  const logFd = openSync(devlogPath, "w");
  const log = (m) => { try { writeSync(logFd, `[${new Date().toISOString()}] ${m}\n`); } catch { /* */ } console.log(m); };

  let child = null, cdp = null;
  const row = { ts: new Date().toISOString(), tag: args.tag, phase: args.phase, scenario: args.scenario,
    doc: args.doc, upPx: args.upPx, depth: args.depth, prewarmWait: args.prewarmWait, run: args.run, ok: false };
  try {
    if (!(await portFree())) { log("预检失败: 9223 被占"); return (closeLog(), 2); }
    const stale = vitePortPids();
    if (stale.length) { log(`预检失败: vite 残留 PID ${stale.join(",")}`); return (closeLog(), 2); }
    if (cargoResidue() > 0) { log("预检失败: cargo watch 残留（复用 watcher 会丢 CDP 端口），请先 taskkill cargo/mditor dev 树"); return (closeLog(), 2); }
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

    const readScroll = () => cdp.eval(`(() => { const h = document.querySelector('.mditor-editor-host'); return h ? { top: Math.round(h.scrollTop), h: Math.round(h.scrollHeight), vh: h.clientHeight } : null; })()`);
    await sleep(args.prewarmWait ? 6000 : 8000);
    const big = await cdp.eval(`(() => { const h = document.querySelector('.mditor-editor-host'); return h ? h.dataset.big !== undefined : null; })()`);
    let s = await readScroll();
    log(`文档已开 big=${big} scroll=${JSON.stringify(s)}`);
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
      s = await readScroll();
    }

    // 启动采样器（覆盖整个驱动期 + quietPhase）
    const startRes = await cdp.eval(JANK_SAMPLER);
    log(`采样器: ${startRes}`);
    if (!String(startRes).startsWith("started")) return (closeLog(), 2);

    const cx = 640, cy = 400;
    const wheel = async (dy, pause) => { await m.wheel(cx, cy, 0, dy); await sleep(pause); };
    const fast = async (px) => { const n = Math.ceil(Math.abs(px) / 1200); for (let i = 0; i < n; i++) await wheel(Math.sign(px) * 1200, 90); };
    const slow = async (px) => { const n = Math.ceil(Math.abs(px) / 220); for (let i = 0; i < n; i++) await wheel(Math.sign(px) * 220, 450); };
    const dir = args.scenario.split("-")[0];
    const spd = args.scenario.split("-")[1];

    await cdp.eval(mark("probe-begin"));
    const targetTop = Math.round((s.h - s.vh) * args.depth);
    if (dir === "down") {
      // 对照臂：默认从顶部下滚 upPx（与 up 臂上滚段同强度）；
      // --start-depth>0 时先下滚到该深度（预备段，分析窗排除）再下滚 upPx
      // ——深位 down 对照（exp1）：与 up 臂同文档位置，控位置混杂变量。
      if (args.startDepth > 0) {
        await cdp.eval(mark("down-leg"));
        await fast(targetTop - s.top);
        await sleep(1200);
        s = await readScroll();
      }
      const dist = Math.min(args.upPx, (s.h - s.vh) - s.top);
      await cdp.eval(mark("drive-begin"));
      if (spd === "fast") await fast(dist); else await slow(dist);
      await cdp.eval(mark("drive-end"));
    } else {
      // up 臂：先下滚到深度（预备段单独标记，分析时排除），停 1.2s，再上滚 upPx
      await cdp.eval(mark("down-leg"));
      await fast(targetTop - s.top);
      await sleep(1200);
      s = await readScroll();
      const upDist = Math.min(args.upPx, s.top);
      await cdp.eval(mark("drive-begin"));
      await cdp.eval(mark("up-begin"));
      if (spd === "fast") await fast(-upDist); else await slow(-upDist);
      await cdp.eval(mark("drive-end"));
    }
    s = await readScroll();
    log(`滚动完成 top=${s.top} h=${s.h}`);
    row.endScroll = s;

    // quietPhase 观察窗（静止门 400ms 后开始计，采满 quietSecs）
    await sleep(400 + args.quietSecs * 1000);
    await cdp.eval(`window.__r8jank.stop = true`);
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const st = await cdp.eval(`window.__r8jank ? { done: window.__r8jank.done, frames: window.__r8jank.frames } : null`);
      if (st && st.done) break;
      await sleep(300);
    }
    const jank = await cdp.eval(`JSON.parse(JSON.stringify(window.__r8jank))`);
    const baseCounters = jank.snap.length ? jank.snap[0].ctr : null;
    const endCounters = jank.snap.length ? jank.snap[jank.snap.length - 1].ctr : null;
    const eventsInWindow = await cdp.eval(`(() => { const sd = window.__scrollDebug; if (!sd) return []; const es = typeof sd.events === 'function' ? sd.events() : sd.events; return (es ?? []).slice(-40).map(e => ({ ts: e.ts, level: e.level, kind: e.kind, msg: (e.msg || '').slice(0, 160) })); })()`);
    const trapLog = await cdp.eval(`window.__scrollDebug && window.__scrollDebug.trap ? window.__scrollDebug.trap() : []`);
    const pumpEnd = await cdp.eval(`typeof window.__mathPumpStats === 'function' ? window.__mathPumpStats() : null`);

    // ---- node 侧分窗分析 ----
    const frames = jank.framesList ?? [];
    const findMark = (label) => { const hit = [...(jank.marks ?? [])].reverse().find((x) => x.label === label); return hit ? hit.t : null; };
    const driveBegin = findMark("drive-begin"), driveEnd = findMark("drive-end"), upBegin = findMark("up-begin");
    const segStart = upBegin ?? driveBegin ?? 0;
    const QUIET_GATE = 400;
    const scrollPhase = driveEnd != null ? [segStart, driveEnd + QUIET_GATE] : null;
    const quietPhase = driveEnd != null ? [driveEnd + QUIET_GATE, driveEnd + QUIET_GATE + args.quietSecs * 1000] : null;
    const inWin = (t, w) => w && t >= w[0] && t < w[1];
    const scrollFrames = frames.filter((f) => inWin(f.t, scrollPhase));
    const quietFrames = frames.filter((f) => inWin(f.t, quietPhase));
    const quantile = (arr, q) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * q))] * 10) / 10; };
    const scrollGaps = scrollFrames.map((f) => f.gap).filter((g) => g != null);
    const quietGaps = quietFrames.map((f) => f.gap).filter((g) => g != null);
    const jankScroll = scrollFrames.filter((f) => f.gap > 32);
    const jankQuiet = quietFrames.filter((f) => f.gap > 32);
    const ltScroll = (jank.longtasks ?? []).filter((e) => inWin(e.t, scrollPhase) || (inWin(e.t + e.dur, scrollPhase)));
    const ltQuiet = (jank.longtasks ?? []).filter((e) => inWin(e.t, quietPhase) || (inWin(e.t + e.dur, quietPhase)));
    // 位移帧（U-f：区分掉帧 vs 跳位）。滚动中正常平移 Δrect.top ≈ -ΔscrollTop，
    // 残差 = Δrect.top + ΔscrollTop >4px 才是内容相对视口真跳位；另记 rawShift
    // （R7 D1 停滚口径同款，供 quietPhase 复用）。
    const shiftFrames = [];
    let prevF = null;
    for (const f of frames) {
      if (prevF && inWin(f.t, scrollPhase)) {
        const stD = Math.round((f.st - prevF.st) * 10) / 10;
        for (const nm of ["top", "mid", "bot"]) {
          const a = prevF[nm], b = f[nm];
          if (a == null || b == null) continue;
          const d = Math.round((b - a) * 10) / 10;
          const residual = Math.round((d + stD) * 10) / 10;
          if (Math.abs(residual) > 4) { shiftFrames.push({ t: f.t, s: nm, d, stD, residual, gap: f.gap }); break; }
        }
      }
      prevF = f;
    }
    // mathTrack（U4/T 口径：quietPhase unready 变化）
    const mathQuiet = (jank.snap ?? []).filter((x) => inWin(x.t, quietPhase) && x.math);
    const mathScroll = (jank.snap ?? []).filter((x) => inWin(x.t, scrollPhase) && x.math);
    row.analysis = {
      scrollWin: scrollPhase, quietWin: quietPhase,
      scroll: { frames: scrollFrames.length, jank32: jankScroll.length, jank32Ratio: scrollFrames.length ? +(jankScroll.length / scrollFrames.length).toFixed(5) : null,
        gapP50: quantile(scrollGaps, 0.5), gapP95: quantile(scrollGaps, 0.95), gapMax: quantile(scrollGaps, 1),
        longtask50: ltScroll.length, ltDurSumMs: Math.round(ltScroll.reduce((s, e) => s + e.dur, 0)),
        shiftFrames: shiftFrames.length,
        mathUnreadyMin: mathScroll.length ? Math.min(...mathScroll.map((x) => x.math.unready)) : null,
        mathUnreadyMax: mathScroll.length ? Math.max(...mathScroll.map((x) => x.math.unready)) : null },
      quiet: { frames: quietFrames.length, jank32: jankQuiet.length,
        gapP95: quantile(quietGaps, 0.95), gapMax: quantile(quietGaps, 1),
        longtask50: ltQuiet.length, ltDurSumMs: Math.round(ltQuiet.reduce((s, e) => s + e.dur, 0)),
        mathUnreadyStart: mathQuiet.length ? mathQuiet[0].math.unready : null,
        mathUnreadyEnd: mathQuiet.length ? mathQuiet[mathQuiet.length - 1].math.unready : null },
      totalFrames: frames.length, longtasksTotal: (jank.longtasks ?? []).length,
      marks: jank.marks, sentinelInfo: jank.sentinelInfo,
    };
    row.jank = { framesList: frames, marks: jank.marks, longtasks: jank.longtasks, snap: jank.snap };
    row.countersBase = baseCounters; row.countersEnd = endCounters;
    row.eventsInWindow = eventsInWindow;
    row.trap = trapLog;
    row.pumpEnd = pumpEnd;
    const a = row.analysis;
    log(`U 汇总 scrollPhase: frames=${a.scroll.frames} jank32=${a.scroll.jank32}(${a.scroll.jank32Ratio}) p95=${a.scroll.gapP95} max=${a.scroll.gapMax} lt50=${a.scroll.longtask50} shift=${a.scroll.shiftFrames}`);
    log(`U 汇总 quietPhase: frames=${a.quiet.frames} jank32=${a.quiet.jank32} p95=${a.quiet.gapP95} lt50=${a.quiet.longtask50} unreadyEnd=${a.quiet.mathUnreadyEnd}`);
    row.ok = true;

    try { cdp.close(); } catch { /* */ }
    cdp = null;
    killChildTree(child);
    killStalePorts();
    child = null;
    const fixtureShort = args.doc.includes("1MB") ? "1mb" : args.doc.includes("无穷级数") ? "density" : args.doc.includes("解题技巧") ? "switch" : "other";
    const out = join(RESULTS_DIR, `r8-phase${args.phase}-jank-${args.scenario}-${fixtureShort}-${args.tag}-${args.run}.json`);
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
