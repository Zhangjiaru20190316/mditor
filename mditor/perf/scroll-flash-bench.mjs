// scroll-flash-bench.mjs —— 第五轮：滚动闪变/乱动基准（症状 F/J 量化口径）
//
// 用法：
//   node perf/scroll-flash-bench.mjs --doc <子串> --viewport on|off --scenario upscroll|roundtrip|longread
//        --round N --tag <标签> [--minutes 3] [--watch-open 25]
//   单轮单臂（ABAB 交错由编排逐次调用），自管 dev 实例（同 scroll-abab 族：
//   预检端口→关闭 dev app 改 store→启动 tauri dev→CDP→ignoreCache 重载→
//   文件树点击开档→测量→PID 树清理）。
//
// 场景与指标：
//   upscroll  —— 下滚 6000px → 上滚 3000px（阅读节奏 300px/180ms）→ 快速往返：
//                F1 占位残留（峰值可见未渲染数 + 源码态可见时长 p50/p95/max）
//                + F4 滚动帧（rAF gap p95 / >50ms 帧数）+ 上滚顶偏（J3 联测）
//   roundtrip —— ±1200/2000px 快速往返 ×6：F4 + 占位往返重渲计数
//   longread  —— --minutes 分钟阅读节奏滚读（默认 3）：J4 分 60s 窗帧率序列
//                + F1 长窗累计
//   开档观察窗（--watch-open，默认 25s）：块高弹跳波计数（layout:block 事件
//   中同块往复变化对数）——发现 2 的量化口径。
//
// 臂自证（过线文档+viewport=on）：.mditor-editor-host[data-big] 存在且远离视口
// 顶层块 computed content-visibility 非 visible 占比 ≥90%；off 臂：data-big 缺席
// 且全 visible。不自证即失败退出（宁缺毋滥，同 scroll-abab 惯例）。
//
// 红线：不改任何 src/ 代码；bigDocPerformance 恒 false；结果只追加
// perf/results/scroll-flash-bench.jsonl。

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, writeSync, closeSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { findPageTarget, Cdp, mouse, sleep } from "./cdp.mjs";

const PORT = 9223;
const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..");
const REPO_ROOT = resolve(MDITOR_DIR, "..");
const FORENSICS_DIR = join(REPO_ROOT, ".workflow", "task2-forensics");
const RESULTS_JSONL = join(here, "results", "scroll-flash-bench.jsonl");
const STORE_PATH = join(process.env.APPDATA ?? ".", "com.mditor.app.dev", "mditor.json");

function parseArgs(argv) {
  const a = { doc: null, viewport: null, scenario: "upscroll", round: null, tag: "run", minutes: 3, watchOpen: 25 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);
    if (k === "--doc") a.doc = next();
    else if (k === "--viewport") a.viewport = next();
    else if (k === "--scenario") a.scenario = next();
    else if (k === "--round") a.round = next();
    else if (k === "--tag") a.tag = next();
    else if (k === "--minutes") a.minutes = Number(next() ?? 3);
    else if (k === "--watch-open") a.watchOpen = Number(next() ?? 25);
  }
  if (!a.doc || !a.viewport || !a.round) {
    console.error("用法: node perf/scroll-flash-bench.mjs --doc <子串> --viewport on|off --scenario <名> --round N --tag <标签>");
    process.exit(2);
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
function editStore(viewportOn) {
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  const holder = raw.settings ? raw : raw.value;
  holder.settings.devMode = false;
  holder.settings.bigDocViewport = viewportOn;
  holder.settings.bigDocPerformance = false;
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
const sanitize = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);

// 页内记录器：占位逐条跟踪 + scrollTop 轨迹 + 帧间隔（rAF）
const REC_INSTALL = `(() => {
  if (window.__sfb) return 'already';
  const st = { seq: 0, seen: new Map(), phEvents: [], tops: [], gaps: [], running: true, _last: 0, _raf: 0, live: 0, peak: 0 };
  window.__sfb = st;
  const tick = (t) => {
    if (!st.running) return;
    if (st._last) st.gaps.push(Math.round(t - st._last));
    st._last = t;
    try {
      const host = document.querySelector('.mditor-editor-host');
      if (host) {
        st.tops.push({ t: Math.round(t), top: Math.round(host.scrollTop) });
        if (st.tops.length > 60000) st.tops.splice(0, 20000);
        const vh = host.clientHeight;
        for (const el of document.querySelectorAll('.mditor-math-inline-lazy')) {
          const r = el.getBoundingClientRect();
          const vis = r.bottom > 0 && r.top < vh;
          const ready = el.classList.contains('mditor-math-inline-ready');
          const id = el.__sfbid ?? (el.__sfbid = 'f' + ++st.seq);
          const rec = st.seen.get(id);
          if (vis && !ready) {
            if (!rec) { st.seen.set(id, { id, first: t }); st.live++; if (st.live > st.peak) st.peak = st.live; }
            else rec.lastUnready = t;
          } else if (rec && rec.end == null) {
            rec.end = t; rec.dur = Math.round(t - rec.first); rec.endReason = ready ? 'ready' : 'left';
            st.live--;
            if (rec.dur >= 30) st.phEvents.push({ ...rec });
          }
        }
      }
    } catch {}
    st._raf = requestAnimationFrame(tick);
  };
  st._raf = requestAnimationFrame(tick);
  st.stop = () => { st.running = false; cancelAnimationFrame(st._raf);
    for (const rec of st.seen.values()) if (rec.end == null) st.phEvents.push({ ...rec, dur: Math.round(performance.now() - rec.first), endReason: 'open' });
    return st; };
  return 'installed';
})()`;

function quantile(sorted, p) { return sorted.length ? sorted[Math.floor(sorted.length * p)] : 0; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(FORENSICS_DIR, { recursive: true });
  const devlogPath = join(FORENSICS_DIR, `devlog-sfb-${sanitize(args.tag)}-r${args.round}.txt`);
  const logFd = openSync(devlogPath, "w");
  const log = (m) => { try { writeSync(logFd, `[${new Date().toISOString()}] ${m}\n`); } catch { /* */ } console.log(m); };

  let child = null, cdp = null;
  const row = { ts: new Date().toISOString(), tag: args.tag, scenario: args.scenario, doc: args.doc,
    viewport: args.viewport, round: args.round, ok: false };
  try {
    if (!(await portFree())) { log("预检失败: 9223 被占"); return (closeLog(), 2); }
    const stale = vitePortPids();
    if (stale.length) { log(`预检失败: vite 残留 PID ${stale.join(",")}`); return (closeLog(), 2); }
    const { workspaces } = editStore(args.viewport === "on");
    const docPath = findDoc(workspaces, args.doc);
    if (!docPath) { log(`找不到文档 ${args.doc}`); return (closeLog(), 2); }

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

    // 开档
    let opened = false;
    for (let i = 0; i < 40 && !opened; i++) {
      const p = await cdp.eval(`(() => {
        const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes(${JSON.stringify(args.doc)}));
        if (!hit) return null;
        const r = hit.getBoundingClientRect();
        if (r.width === 0) return null;
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (p) { await m.click(p.x, p.y); opened = true; }
      else await sleep(500);
    }
    if (!opened) { log("文件树找不到目标"); return (closeLog(), 2); }
    await sleep(8000);

    // 臂自证（同 scroll-abab 签名 A/B/C）
    const sig = await cdp.eval(`(() => {
      const host = document.querySelector('.mditor-editor-host');
      if (!host) return { A: false };
      const A = host.dataset.big !== undefined;
      const kids = [...host.querySelectorAll('.ProseMirror > *')];
      let off = 0, offNonVisible = 0, withIntrinsic = 0;
      const vh = host.clientHeight, top = host.scrollTop;
      for (const k of kids) {
        const r = k.getBoundingClientRect();
        if (r.bottom < -800 || r.top > vh + 800) {
          off++;
          if (getComputedStyle(k).contentVisibility !== 'visible') offNonVisible++;
          if ((k.getAttribute('style') || '').includes('contain-intrinsic-size')) withIntrinsic++;
        }
      }
      return { A, off, offNonVisible, withIntrinsic };
    })()`);
    const onArm = args.viewport === "on";
    if (onArm && (!sig.A || sig.offNonVisible / Math.max(1, sig.off) < 0.9)) {
      log(`臂自证失败(on): ${JSON.stringify(sig)}`); return (closeLog(), 2);
    }
    if (!onArm && (sig.A || sig.offNonVisible !== 0)) {
      log(`臂自证失败(off): ${JSON.stringify(sig)}`); return (closeLog(), 2);
    }
    log(`臂自证通过: ${JSON.stringify(sig)}`);
    row.armSig = sig;

    await cdp.eval(REC_INSTALL);
    const readTop = () => cdp.eval(`Math.round(document.querySelector('.mditor-editor-host')?.scrollTop ?? -1)`);
    const cx = 640, cy = 400;
    const wheel = async (dy, pause = 180) => { await m.wheel(cx, cy, 0, dy); await sleep(pause); };

    // 开档观察窗：块高变化事件携带的变更块总量（弹跳波代理口径）
    const t0 = Date.now();
    let blockEvents = 0;
    while (Date.now() - t0 < args.watchOpen * 1000) {
      const n = await cdp.eval(`(() => {
        const es = typeof window.__scrollDebug?.events === 'function' ? window.__scrollDebug.events() : [];
        let s = 0;
        for (const e of es) if (e.kind === 'layout:block' && e.data && typeof e.data.changes === 'number') s += e.data.changes;
        return s;
      })()`).catch(() => 0);
      blockEvents = Math.max(blockEvents, n);
      await sleep(1000);
    }
    row.openWindow = { seconds: args.watchOpen, blockChangeEvents: blockEvents };

    if (args.scenario === "upscroll") {
      for (let i = 0; i < 20; i++) await wheel(300);
      row.downTop = await readTop();
      await sleep(1500);
      for (let i = 0; i < 10; i++) await wheel(-300);
      row.upTop = await readTop();
      await sleep(1500);
      for (const dy of [1200, -1200, 2000, -2000]) await wheel(dy, 400);
      await sleep(2500);
    } else if (args.scenario === "roundtrip") {
      for (const dy of [1500, -1500, 1500, -1500, 2500, -2500, 2500, -2500, 3500, -3500, 3500, -3500]) await wheel(dy, 500);
      await sleep(2500);
    } else if (args.scenario === "longread") {
      const end = Date.now() + args.minutes * 60_000;
      let dir = 1;
      while (Date.now() < end) {
        await wheel(dir * 300, 400);
        const top = await readTop();
        if (top > 60000) dir = -1; else if (top < 300) dir = 1;
      }
    }

    const st = await cdp.eval(`window.__sfb.stop()`);
    const durs = st.phEvents.filter((e) => e.endReason !== "open").map((e) => e.dur).sort((a, b) => a - b);
    const tops = st.tops;
    // 上滚顶偏：wheel 向上时 scrollTop 反向大幅上移（>150px/步之外的非预期）
    row.f1 = {
      events: st.phEvents.length,
      peakConcurrent: st.peak ?? 0,
      durP50: quantile(durs, 0.5), durP95: quantile(durs, 0.95), durMax: durs.length ? durs[durs.length - 1] : 0,
      stillOpen: st.phEvents.filter((e) => e.endReason === "open").length,
    };
    const gaps = st.gaps.filter((g) => g > 0 && g < 5000).sort((a, b) => a - b);
    row.f4 = { frames: gaps.length, p50: quantile(gaps, 0.5), p95: quantile(gaps, 0.95),
      max: gaps.length ? gaps[gaps.length - 1] : 0, over50: gaps.filter((g) => g > 50).length };
    row.katexErrors = await cdp.eval(`document.querySelectorAll('.katex-error').length`);
    if (args.scenario === "longread") {
      const winMs = 60_000, wins = [];
      for (let s = 0; s < tops.length;) {
        const winTop = [], winStart = tops[s].t;
        while (s < tops.length && tops[s].t - winStart < winMs) { winTop.push(tops[s].t); s++; }
        if (winTop.length > 10) {
          const gs = [];
          for (let i = 1; i < winTop.length; i++) gs.push(winTop[i] - winTop[i - 1]);
          gs.sort((a, b) => a - b);
          wins.push({ p95: quantile(gs, 0.95), over50: gs.filter((g) => g > 50).length });
        }
      }
      row.j4windows = wins;
    }
    // 写入时间线尾 40 条（tag/时刻）供 J 归因
    row.writes = await cdp.eval(`(() => {
      const r = window.__scrollDebug ? window.__scrollDebug.recent() : null;
      const c = window.__scrollDebug ? window.__scrollDebug.counters() : {};
      return { recent: r ? { tag: r.tag, ageMs: Math.round(performance.now() - r.at) } : null,
        counters: Object.fromEntries(Object.entries(c).filter(([k]) => k.startsWith('session.') || k.includes('comp') || k.includes('ghost'))) };
    })()`).catch(() => null);
    row.ok = true;

    try { cdp.close(); } catch { /* */ }
    cdp = null;
    killChildTree(child); child = null;
    appendFileSync(RESULTS_JSONL, JSON.stringify(row) + "\n", "utf8");
    log(`f1=${JSON.stringify(row.f1)} f4=${JSON.stringify(row.f4)} openWindow=${JSON.stringify(row.openWindow)}`);
    log(`结果落盘 ${RESULTS_JSONL}`);
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
