// probe-flicker.mjs —— R10 阶段二/三：症状 S（滚动底部闪刷/换装可见）dev 取证
// 探针（一次性，不入库惯例，实际随 commit 入库）
//
// 用法：node perf/tmp-r10/probe-flicker.mjs --scenario down-slow|down-fast|up-slow
//        |up-fast|roundtrip|revisit [--doc 无穷级数_密度档|1MB压测|解题技巧]
//        [--tag r10p2] [--phase 2] [--run 1] [--depth 0.6] [--up-px 5000]
//        [--hold-secs 17] [--quiet-secs 10] [--prewarm-wait] [--mode normal|focus]
//
// 蓝本：tmp-r8/probe-jank.mjs（起 dev(9223)/开档/滚轮驱动/PID 清理）+
// tmp-r9/prod-focus-jank.mjs（focus 切换/marks 臂结构）+ flicker-watcher.mjs
//（页内巡视器：换装可见事件 = 换装完成时刻 × 元素与视口相交的联合判定，
// 历轮未覆盖的缺口口径）。
//
// 场景：
//  - down-slow/down-fast：顶部 → 慢/快滚到 depth（S-Ⅰ 前向换装主战场）
//  - up-slow/up-fast：快滚到 depth（预备段排除）→ 慢/快上滚 upPx
//  - roundtrip：±1500/2500/3500 快速往返 ×6（频带边缘 churn）
//  - revisit：快滚到 depth → 静置 hold-secs(17s > TEARDOWN 15s) → 慢上滚
//    upPx 回访 → 静 3s → 快下滚回访（S-Ⅱ 已渲染重闪专用）
// 每段尾 quiet 窗（默认 10s，M1/M2/停滚 sh 漂移观测）。
// 红线：只加观测不改任何 src/ 行为；dev 复现为参照臂（prod 优先，R9 教训）。

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { Cdp, mouse, sleep } from "../cdp.mjs";
import { FLICKER_WATCHER, summarizeFlicker } from "./flicker-watcher.mjs";

const PORT = 9223;
const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..", "..");
const REPO_ROOT = resolve(MDITOR_DIR, "..");
const FORENSICS_DIR = join(REPO_ROOT, ".workflow", "task2-forensics");
const RESULTS_DIR = join(MDITOR_DIR, "perf", "results");
const STORE_PATH = join(process.env.APPDATA ?? ".", "com.mditor.app.dev", "mditor.json");

function parseArgs(argv) {
  const a = { scenario: "down-slow", doc: "无穷级数_密度档", tag: "r10p2", phase: 2, run: 1,
    depth: 0.6, upPx: 5000, holdSecs: 17, quietSecs: 10, prewarmWait: false, mode: "normal" };
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
    else if (k === "--prewarm-wait") a.prewarmWait = true;
    else if (k === "--mode") a.mode = next() ?? "normal";
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
    if (/TCP\s+\S+:9223\s+\S+\s+LISTENING/i.test(line)) {
      const pid = line.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid)) run("taskkill", ["/F", "/T", "/PID", pid]);
    }
  }
}
function cargoResidue() {
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq cargo.exe", "/FO", "CSV"], { encoding: "utf8", windowsHide: true });
  return String(r.stdout || "").split("\n").filter((l) => /cargo\.exe/i.test(l)).length;
}
function editStore() {
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  const holder = raw.settings ? raw : raw.value;
  holder.settings.devMode = false;
  holder.settings.bigDocViewport = true; // 复刻生产用户实况（R5~R9 探针同款）
  holder.settings.bigDocPerformance = false;
  if ("typewriterMode" in holder.settings) holder.settings.typewriterMode = false;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(FORENSICS_DIR, { recursive: true }); mkdirSync(RESULTS_DIR, { recursive: true });
  const devlogPath = join(FORENSICS_DIR, `devlog-r10-${args.tag}-${args.scenario}-${args.run}.txt`);
  const logFd = openSync(devlogPath, "w");
  const log = (m) => { try { writeSync(logFd, `[${new Date().toISOString()}] ${m}\n`); } catch { /* */ } console.log(m); };

  let child = null, cdp = null;
  const row = { ts: new Date().toISOString(), tag: args.tag, phase: args.phase, scenario: args.scenario,
    doc: args.doc, depth: args.depth, upPx: args.upPx, holdSecs: args.holdSecs, mode: args.mode,
    prewarmWait: args.prewarmWait, run: args.run, env: "dev", ok: false };
  try {
    if (!(await portFree())) { log("预检失败: 9223 被占"); return (closeLog(), 2); }
    const stale = vitePortPids();
    if (stale.length) { log(`预检失败: vite 残留 PID ${stale.join(",")}`); return (closeLog(), 2); }
    if (cargoResidue() > 0) { log("预检失败: cargo watch 残留（复用 watcher 会丢 CDP 端口）"); return (closeLog(), 2); }
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
    if (!target) { log("CDP 未就绪"); killChildTree(child); return (closeLog(), 2); }
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
          hit.click(); // R9 复检：CDP 坐标点击对 .ft-row 无效（dpr 1.75），el.click() 直触 React onClick
          return true;
        })()`);
        if (p) return true;
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
    if (!big) { log("非 cv 档文档（data-big 缺席）——本轮主战场要求 cv 档，臂无效"); return (closeLog(), 2); }

    if (args.prewarmWait) {
      const t0 = Date.now();
      let done = false;
      while (Date.now() - t0 < 150_000) {
        done = await cdp.eval(`(() => { const sd = window.__scrollDebug; if (!sd) return false; const es = typeof sd.events === 'function' ? sd.events() : sd.events; return (es ?? []).some(e => e.kind === 'prewarm.done'); })()`);
        if (done) break;
        await sleep(2000);
      }
      row.prewarmed = done;
      log(done ? "预热已完成" : "预热等待超时（dev 爬行常态，R9 教训）");
      s = await readScroll();
    }

    // 模式切换（正常/专注同测；R9 setMode 同款）
    const READ_GEO = `(() => { const h = document.querySelector('.mditor-editor-host'); const app = document.querySelector('.app'); return h ? { top: Math.round(h.scrollTop), h: Math.round(h.scrollHeight), vh: h.clientHeight, isFocus: !!(app && app.classList.contains('is-focus')) } : null; })()`;
    const focusBtnPos = async () => cdp.eval(`(() => { const b = document.querySelector('button.sb-icon-btn[title="焦点模式"]'); if (!b) return null; const r = b.getBoundingClientRect(); if (r.width === 0) return null; return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
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
      } else await sendEsc();
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        geo = await cdp.eval(READ_GEO);
        if (geo.isFocus === wantFocus) return geo;
      }
      return null;
    };
    if (args.mode === "focus") {
      const g = await setMode(true);
      if (!g) { log("切 focus 失败"); return (closeLog(), 2); }
      log(`focus 模式已开 vh=${g.vh}`);
      await sleep(1500);
      s = await readScroll();
    }

    // 巡视器安装（一次性全量注册 + IO 关注集）
    const inst = await cdp.eval(FLICKER_WATCHER);
    log(`巡视器: ${inst}`);
    if (!String(inst).startsWith("installed")) return (closeLog(), 2);

    const cx = 640, cy = 400;
    const wheel = async (dy, pause) => { await m.wheel(cx, cy, 0, dy); await sleep(pause); };
    const fast = async (px) => { const n = Math.ceil(Math.abs(px) / 1200); for (let i = 0; i < n; i++) await wheel(Math.sign(px) * 1200, 90); };
    const slow = async (px) => { const n = Math.ceil(Math.abs(px) / 220); for (let i = 0; i < n; i++) await wheel(Math.sign(px) * 220, 450); };
    const mark0 = (label) => `window.__r10flicker.marks.push({ t: Math.round(performance.now() - window.__r10flicker.perf0), label: ${JSON.stringify(label)} }), 'ok'`;
    const mark = (label) => cdp.eval(mark0(label));

    await cdp.eval(`window.__r10flicker.marks = []; 'ok'`);
    await mark("probe-begin");
    const drive = async (seg, dist, spd) => {
      await cdp.eval(mark0(`${seg}-drive-begin`));
      if (spd === "fast") await fast(dist); else await slow(dist);
      await cdp.eval(mark0(`${seg}-drive-end`));
    };

    const targetTop = Math.round((s.h - s.vh) * args.depth);
    if (args.scenario === "down-slow" || args.scenario === "down-fast") {
      await drive("down", Math.max(100, Math.min(targetTop - s.top, targetTop)), args.scenario.split("-")[1]);
      await sleep(args.quietSecs * 1000);
    } else if (args.scenario === "up-slow" || args.scenario === "up-fast") {
      await cdp.eval(mark0("down-leg-begin"));
      await fast(targetTop - s.top);
      await sleep(1200);
      s = await readScroll();
      await cdp.eval(mark0("down-leg-end"));
      await drive("up", -Math.min(args.upPx, s.top), args.scenario.split("-")[1]);
      await sleep(args.quietSecs * 1000);
    } else if (args.scenario === "roundtrip") {
      for (const dy of [1500, -1500, 2500, -2500, 3500, -3500, 3500, -3500, 2500, -2500, 1500, -1500]) {
        await cdp.eval(mark0(`rt-drive-begin`));
        await fast(dy);
        await cdp.eval(mark0(`rt-drive-end`));
        await sleep(600);
      }
      await sleep(args.quietSecs * 1000);
    } else if (args.scenario === "revisit") {
      // S-Ⅱ 专用：下滚到 depth → 静置 >TEARDOWN_DELAY → 上滚回访（已渲染区
      // 拆卸后重挂应稳定复现）→ 静 3s → 下滚回访
      await cdp.eval(mark0("down-leg-begin"));
      await fast(targetTop - s.top);
      await cdp.eval(mark0("down-leg-end"));
      log(`revisit: 下滚到 ${targetTop}，静置 ${args.holdSecs}s（越过 TEARDOWN 15s）`);
      await sleep(args.holdSecs * 1000);
      s = await readScroll();
      await drive("revisit-up", -Math.min(args.upPx, s.top), "slow");
      await sleep(3000);
      s = await readScroll();
      await drive("revisit-down", Math.min(args.upPx, (s.h - s.vh) - s.top), "fast");
      await sleep(args.quietSecs * 1000);
    }
    await mark("probe-end");

    // M1/M2/M3 收尾读数（quiet 窗末）
    row.mGates = await cdp.eval(`(() => {
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
    })()`);

    await cdp.eval(`window.__r10flicker.stop()`);
    await sleep(400);
    const flicker = await cdp.eval(`JSON.parse(JSON.stringify(window.__r10flicker))`);
    const marksRaw = await cdp.eval(`JSON.parse(JSON.stringify(window.__r10flicker.marks || []))`);
    row.summary = summarizeFlicker(flicker, marksRaw, args.quietSecs);
    row.flicker = { events: flicker.events, tops: flicker.tops, sh: flicker.sh, snap: flicker.snap, gaps: flicker.gaps };
    row.marks = marksRaw;
    log(`S1 汇总: total=${row.summary.s1Total} fresh=${row.summary.drives.map(d=>d.s1.fresh).join("/")} byType=${JSON.stringify(row.summary.drives.map(d=>d.s1.byType))}`);
    log(`S2 汇总: reflash=${row.summary.s2Total} teardownVis=${row.summary.drives.map(d=>d.s2.teardownVis).join("/")} demoteVis=${row.summary.drives.map(d=>d.s2.demoteVis).join("/")}`);
    log(`S3: hdelta=${row.summary.drives.map(d=>d.s3.hdelta).join("/")} shDrift=${row.summary.drives.map(d=>d.s3.shDriftFrames).join("/")}`);
    log(`帧: ${JSON.stringify(row.summary.frame)}`);
    row.ok = true;

    try { cdp.close(); } catch { /* */ }
    cdp = null;
    killChildTree(child);
    killStalePorts();
    child = null;
    const fixtureShort = args.doc.includes("1MB") ? "1mb" : args.doc.includes("无穷级数") ? "density" : args.doc.includes("解题技巧") ? "switch" : "other";
    const out = join(RESULTS_DIR, `r10-phase${args.phase}-flicker-dev-${args.scenario}-${fixtureShort}-${args.tag}-${args.run}.json`);
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
