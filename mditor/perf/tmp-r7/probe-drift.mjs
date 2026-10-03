// probe-drift.mjs —— R7 阶段二：症状 D（停滚自漂移）复现与取证探针（一次性，不入库）
//
// 用法：node perf/tmp-r7/probe-drift.mjs --scenario down-fast|down-slow|up-fast|up-slow
//        [--doc 无穷级数_密度档|1MB] [--tag r7p2] [--watch-secs 10] [--settle-ms 8000]
//        [--depth 0.6] [--up-px 5000] [--prewarm-wait]
//
// 流程：起 dev(9223) → 打开 fixture → 稳定 → 按场景滚轮驱动深滚 → 停止输入
//  → 等 420ms（静止门生效）→ 页内 rAF 采样器（视口顶/中/底三哨兵 rect +
//  scrollTop + scrollHeight，每帧）跑 watch-secs → 取回帧序列 +
//  __scrollDebug counters/events 差分 + __mathPumpStats 差分 + writeTrap 栈。
// 位移帧判定：任一哨兵 |Δrect.top| > 4px（rAF 帧粒度，D1①口径）。
// 清理：只杀自 spawn 的 dev PID 树（taskkill /F /T /PID），绝不 /IM。

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
  const a = { scenario: "down-fast", doc: "无穷级数_密度档", tag: "r7p2", watchSecs: 10,
    settleMs: 8000, depth: 0.6, upPx: 5000, prewarmWait: false, typewriter: false, run: 1 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);
    if (k === "--scenario") a.scenario = next();
    else if (k === "--doc") a.doc = next();
    else if (k === "--tag") a.tag = next();
    else if (k === "--watch-secs") a.watchSecs = Number(next() ?? 10);
    else if (k === "--settle-ms") a.settleMs = Number(next() ?? 8000);
    else if (k === "--depth") a.depth = Number(next() ?? 0.6);
    else if (k === "--up-px") a.upPx = Number(next() ?? 5000);
    else if (k === "--prewarm-wait") a.prewarmWait = true;
    else if (k === "--typewriter") a.typewriter = true;
    else if (k === "--run") a.run = Number(next() ?? 1);
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
function editStore(typewriter = false) {
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  const holder = raw.settings ? raw : raw.value;
  holder.settings.devMode = false;
  holder.settings.bigDocViewport = true; // 复刻生产用户实况（R5/R6 探针同款）
  holder.settings.bigDocPerformance = false;
  if (typewriter) holder.settings.typewriterMode = true;
  else if ("typewriterMode" in holder.settings) holder.settings.typewriterMode = false;
  writeFileSync(STORE_PATH, JSON.stringify(raw, null, 2), "utf8");
  return { workspaces: raw.workspaces ?? [] };
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

// 页内 rAF 采样器：启动即选哨兵（视口顶/中/底三块），每帧记录 scrollTop/
// scrollHeight/哨兵 rect.top；位移事件（任一哨兵 |Δtop|>threshold）逐条记；
// 另每 250ms 数一次全文档行内公式 ready/unready 占位数（demote 潮/补绘潮
// 的直接信号：unready 跳升=demote 潮，unready 下降=补绘潮）。
// 结果挂 window.__r7drift，node 侧轮询取回。
const DRIFT_SAMPLER = (watchMs, threshold) => `(() => {
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
  const rec = { startedAt: Date.now(), perf0: performance.now(), frames: 0, shifts: [], samples: [],
    mathTrack: [], quietGateMs: 400,
    sentinelInfo: sentinels.map((s) => ({ name: s.name, tag: s.el.tagName, text: (s.el.textContent || '').slice(0, 24) })),
    done: false, err: null };
  window.__r7drift = rec;
  let prev = null;
  const countMath = () => {
    try {
      let ready = 0, unready = 0;
      for (const el of pm.querySelectorAll('.mditor-math-inline-lazy')) {
        if (el.classList.contains('mditor-math-inline-ready')) ready++; else unready++;
      }
      rec.mathTrack.push({ t: Math.round(performance.now() - rec.perf0), ready, unready });
    } catch { /* */ }
  };
  countMath();
  let lastCountAt = performance.now();
  const tick = () => {
    try {
      const now = performance.now();
      const t = Math.round(now - rec.perf0);
      const row = { t, st: Math.round(host.scrollTop * 10) / 10, sh: Math.round(host.scrollHeight) };
      for (const s of sentinels) {
        const v = s.el.isConnected ? Math.round(s.el.getBoundingClientRect().top * 10) / 10 : null;
        row[s.name] = v;
      }
      rec.frames++;
      rec.samples.push(row);
      if (prev) {
        for (const s of sentinels) {
          const a = prev[s.name], b = row[s.name];
          if (a == null || b == null) continue;
          const d = b - a;
          if (Math.abs(d) > ${threshold}) { rec.shifts.push({ t, s: s.name, from: a, to: b, d: Math.round(d * 10) / 10, st: row.st, stD: Math.round((row.st - prev.st) * 10) / 10, sh: row.sh }); }
        }
      }
      prev = row;
      if (now - lastCountAt >= 250) { lastCountAt = now; countMath(); }
      if (t < ${Math.round(watchMs)}) requestAnimationFrame(tick);
      else { countMath(); rec.done = true; }
    } catch (e) { rec.err = String(e); rec.done = true; }
  };
  requestAnimationFrame(tick);
  return 'started:' + sentinels.length;
})()`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(FORENSICS_DIR, { recursive: true }); mkdirSync(RESULTS_DIR, { recursive: true });
  const devlogPath = join(FORENSICS_DIR, `devlog-r7-${args.tag}-${args.scenario}-${args.run}.txt`);
  const logFd = openSync(devlogPath, "w");
  const log = (m) => { try { writeSync(logFd, `[${new Date().toISOString()}] ${m}\n`); } catch { /* */ } console.log(m); };

  let child = null, cdp = null;
  const row = { ts: new Date().toISOString(), tag: args.tag, scenario: args.scenario, doc: args.doc,
    watchSecs: args.watchSecs, settleMs: args.settleMs, depth: args.depth, upPx: args.upPx,
    prewarmWait: args.prewarmWait, typewriter: args.typewriter, run: args.run, ok: false };
  try {
    if (!(await portFree())) { log("预检失败: 9223 被占"); return (closeLog(), 2); }
    const stale = vitePortPids();
    if (stale.length) { log(`预检失败: vite 残留 PID ${stale.join(",")}`); return (closeLog(), 2); }
    const { workspaces } = editStore(args.typewriter);
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
    await sleep(args.settleMs);
    const big = await cdp.eval(`(() => { const h = document.querySelector('.mditor-editor-host'); return h ? h.dataset.big !== undefined : null; })()`);
    let s = await readScroll();
    log(`文档已开 big=${big} scroll=${JSON.stringify(s)}`);
    row.big = big;

    if (args.prewarmWait) {
      // 等预热完成（events 出现 prewarm.done 或超时 60s）
      const t0 = Date.now();
      while (Date.now() - t0 < 150_000) {
        const done = await cdp.eval(`(() => { const sd = window.__scrollDebug; if (!sd) return false; const es = typeof sd.events === 'function' ? sd.events() : sd.events; return (es ?? []).some(e => e.kind === 'prewarm.done'); })()`);
        if (done) { log("预热已完成"); break; }
        await sleep(2000);
      }
      row.prewarmed = true;
      s = await readScroll();
    }

    // 场景滚动驱动（wheel 在编辑器中心）
    const cx = 640, cy = 400;
    const wheel = async (dy, pause) => { await m.wheel(cx, cy, 0, dy); await sleep(pause); };
    const fast = async (px) => { const n = Math.ceil(px / 1200); for (let i = 0; i < n; i++) await wheel(1200, 90); };
    const slow = async (px) => { const n = Math.ceil(px / 220); for (let i = 0; i < n; i++) await wheel(220, 450); };
    const dir = args.scenario.split("-")[0];
    const spd = args.scenario.split("-")[1];

    const targetTop = Math.round((s.h - s.vh) * args.depth);
    if (dir === "down") {
      const dist = targetTop - s.top;
      if (spd === "fast") await fast(dist); else await slow(dist);
    } else {
      // up：先快速下滚到深度，停 1s，再上滚 upPx
      await fast(targetTop - s.top);
      await sleep(1000);
      s = await readScroll();
      if (spd === "fast") await fast(-Math.min(args.upPx, s.top)); else await slow(-Math.min(args.upPx, s.top));
    }
    s = await readScroll();
    log(`滚动完成 top=${s.top} h=${s.h}`);
    row.endScroll = s;

    // 停止输入 → 立即采基线并启动 rAF 采样器（t=0 起，含 400ms 静止门预备期；
    // D1 口径分析时只统计 t≥400ms 的位移帧——静止门生效前属惯性收尾）。
    const baseCounters = await cdp.eval(`window.__scrollDebug ? (typeof window.__scrollDebug.counters === 'function' ? window.__scrollDebug.counters() : window.__scrollDebug.counters) : null`);
    const baseEventsLen = await cdp.eval(`(() => { const sd = window.__scrollDebug; if (!sd) return -1; const es = typeof sd.events === 'function' ? sd.events() : sd.events; return es.length; })()`);
    const basePump = await cdp.eval(`typeof window.__mathPumpStats === 'function' ? window.__mathPumpStats() : null`);
    const startRes = await cdp.eval(DRIFT_SAMPLER(args.watchSecs * 1000, 4));
    log(`采样器: ${startRes}`);

    // 采样期间 node 侧轮询（每 2s 报一次 shift 计数）
    const t0 = Date.now();
    while (Date.now() - t0 < args.watchSecs * 1000 + 2000) {
      await sleep(2000);
      const st = await cdp.eval(`window.__r7drift ? { done: window.__r7drift.done, frames: window.__r7drift.frames, shifts: window.__r7drift.shifts.length } : null`);
      if (!st) { log("采样器丢失"); break; }
      if (st.done) break;
    }
    const drift = await cdp.eval(`window.__r7drift ? JSON.parse(JSON.stringify(window.__r7drift)) : null`);
    const endCounters = await cdp.eval(`window.__scrollDebug ? (typeof window.__scrollDebug.counters === 'function' ? window.__scrollDebug.counters() : window.__scrollDebug.counters) : null`);
    const winEvents = await cdp.eval(`(() => { const sd = window.__scrollDebug; if (!sd) return []; const es = typeof sd.events === 'function' ? sd.events() : sd.events; return (es ?? []).slice(${baseEventsLen}).map(e => ({ ts: e.ts, level: e.level, kind: e.kind, msg: (e.msg || '').slice(0, 160), data: e.data })); })()`);
    const endPump = await cdp.eval(`typeof window.__mathPumpStats === 'function' ? window.__mathPumpStats() : null`);
    const trapLog = await cdp.eval(`window.__scrollDebug && window.__scrollDebug.trap ? window.__scrollDebug.trap() : []`);

    row.drift = drift;
    row.countersBase = baseCounters; row.countersEnd = endCounters;
    row.eventsInWindow = winEvents;
    row.pumpBase = basePump; row.pumpEnd = endPump;
    row.trap = trapLog;
    // 汇总
    const md1001 = winEvents.filter((e) => e.kind === "session:ghost").length;
    const md1002 = winEvents.filter((e) => e.kind === "layout:shift" && e.level === "warn").length;
    const writeKeys = {};
    for (const [k, v] of Object.entries(endCounters ?? {})) {
      if (String(k).startsWith("write.") && (baseCounters?.[k] ?? 0) !== v) writeKeys[k] = v - (baseCounters?.[k] ?? 0);
    }
    row.summary = {
      shiftFrames: drift ? drift.shifts.filter((x) => x.t >= 400).length : -1,
      shiftFramesAll: drift ? drift.shifts.length : -1,
      totalFrames: drift ? drift.frames : -1,
      scrollTopChanges: drift ? drift.samples.filter((x, i, arr) => i > 0 && x.t >= 400 && Math.abs(x.st - arr[i - 1].st) > 0.5).length : -1,
      programmaticWrites: writeKeys,
      anchorCompCount: (endCounters?.["anchor.comp"] ?? 0) - (baseCounters?.["anchor.comp"] ?? 0),
      md1001, md1002,
      pumpQuietDelta: (endPump && basePump) ? (endPump.quietFrames ?? 0) - (basePump.quietFrames ?? 0) : null,
      pumpRenderedDelta: (endPump && basePump) ? ((endPump.rendered ?? 0) + (endPump.hitPaints ?? 0) - (basePump.rendered ?? 0) - (basePump.hitPaints ?? 0)) : null,
      mathTrackUnreadyRange: drift && drift.mathTrack.length ? [Math.min(...drift.mathTrack.map((x) => x.unready)), Math.max(...drift.mathTrack.map((x) => x.unready))] : null,
      mathTrackJump: (() => {
        if (!drift || !drift.mathTrack.length) return null;
        let best = { d: 0 };
        for (let i = 1; i < drift.mathTrack.length; i++) {
          const d = drift.mathTrack[i].unready - drift.mathTrack[i - 1].unready;
          if (Math.abs(d) > Math.abs(best.d)) best = { d, t: drift.mathTrack[i].t };
        }
        return best;
      })(),
    };
    log(`D1 汇总: shiftFrames=${row.summary.shiftFrames}/${row.summary.totalFrames} scrollTopChanges=${row.summary.scrollTopChanges} writes=${JSON.stringify(writeKeys)} anchor.compΔ=${row.summary.anchorCompCount} MD1001=${md1001} MD1002=${md1002} pumpQuietΔ=${row.summary.pumpQuietDelta} renderedΔ=${row.summary.pumpRenderedDelta}`);
    if (drift && drift.shifts.length) {
      log(`位移事件前 8: ${JSON.stringify(drift.shifts.slice(0, 8))}`);
    }
    row.ok = true;

    try { cdp.close(); } catch { /* */ }
    cdp = null;
    killChildTree(child);
    child = null;
    const fixtureShort = args.doc.includes("1MB") ? "1mb" : args.doc.includes("无穷级数") ? "density" : "switch";
    const out = join(RESULTS_DIR, `r7-phase2-drift-${args.scenario}-${fixtureShort}-${args.tag}-${args.run}.json`);
    writeFileSync(out, JSON.stringify(row), "utf8");
    log(`证据落盘 ${out}`);
    return (closeLog(), 0);
  } catch (e) {
    log("异常: " + (e?.stack || e));
    try { cdp && cdp.close(); } catch { /* */ }
    killChildTree(child);
    return (closeLog(), 1);
  }
  function closeLog() { try { closeSync(logFd); } catch { /* */ } }
}
main().then((c) => process.exit(c ?? 0), (e) => { console.error(e?.stack || e); process.exit(2); });
