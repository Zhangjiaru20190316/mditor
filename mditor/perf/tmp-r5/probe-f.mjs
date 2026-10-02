// probe-f.mjs —— 第五轮 阶段二：症状 F（乱闪）复现探针（一次性，不入库）
//
// 用法：node perf/tmp-r5/probe-f.mjs --scenario upscroll|destroy --doc 无穷级数_密度档
//        [--viewport on|off(默认on)] [--tag r5f1]
// 场景：
//   upscroll —— 下滚 6000px 后上滚 3000px（阅读节奏 ~300px/格/180ms）：
//     rAF 级记录可见未渲染占位（.mditor-math-inline-lazy:not(.ready)）逐条
//     源码态可见时长 + 峰值并发数 + scrollTop 轨迹（上滚顶偏 J3 联测）
//   destroy —— 滚到代码块旁 → 滚离 1000px 停 16s（TEARDOWN_DELAY 15s）→ 回滚：
//     记录重见瞬间高度跳变、.cm-editor 重建间隔、源码占位可见时长
// 清理：只杀 spawn 的 dev 实例 PID 树。

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { findPageTarget, Cdp, mouse, sleep } from "../cdp.mjs";

const PORT = 9223;
const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..", "..");
const REPO_ROOT = resolve(MDITOR_DIR, "..");
const FORENSICS_DIR = join(REPO_ROOT, ".workflow", "task2-forensics");
const RESULTS_DIR = join(MDITOR_DIR, "perf", "results");
const STORE_PATH = join(process.env.APPDATA ?? ".", "com.mditor.app.dev", "mditor.json");

function parseArgs(argv) {
  const a = { scenario: "upscroll", doc: "无穷级数_密度档", viewport: "on", tag: "r5f" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);
    if (k === "--scenario") a.scenario = next();
    else if (k === "--doc") a.doc = next();
    else if (k === "--viewport") a.viewport = next();
    else if (k === "--tag") a.tag = next();
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
function killChildTree(child) { try { if (child && child.pid) run("taskkill", ["/F", "/T", "/PID", String(child.pid)]); } catch {} }
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
    } catch {}
  }
  return null;
}

// 页内记录器：逐占位跟踪源码态可见时长（rAF 采样）+ scrollTop 轨迹 + 帧间隔
const F_REC = `(() => {
  if (window.__r5f) return 'already';
  const st = { seq: 0, seen: new Map(), events: [], tops: [], gaps: [], running: true, _last: 0, _raf: 0 };
  window.__r5f = st;
  const tick = (t) => {
    if (!st.running) return;
    if (st._last) st.gaps.push(Math.round(t - st._last));
    st._last = t;
    try {
      const host = document.querySelector('.mditor-editor-host');
      if (host) {
        st.tops.push({ t: Math.round(t), top: Math.round(host.scrollTop) });
        if (st.tops.length > 12000) st.tops.splice(0, 4000);
        const vh = host.clientHeight;
        for (const el of document.querySelectorAll('.mditor-math-inline-lazy')) {
          const r = el.getBoundingClientRect();
          const vis = r.bottom > 0 && r.top < vh;
          const ready = el.classList.contains('mditor-math-inline-ready');
          const id = el.__r5id ?? (el.__r5id = 'f' + ++st.seq);
          const rec = st.seen.get(id);
          if (vis && !ready) {
            if (!rec) st.seen.set(id, { id, first: t, src: (el.textContent || '').slice(0, 24), rect: Math.round(r.top) });
            else rec.lastUnready = t;
          } else if (rec && rec.end == null) {
            rec.end = t; rec.dur = Math.round(t - rec.first); rec.endReason = ready ? 'ready' : 'left';
            if (rec.dur >= 30) st.events.push({ ...rec, src: rec.src, rect: rec.rect });
          }
        }
      }
    } catch {}
    st._raf = requestAnimationFrame(tick);
  };
  st._raf = requestAnimationFrame(tick);
  st.stop = () => { st.running = false; cancelAnimationFrame(st._raf);
    for (const rec of st.seen.values()) if (rec.end == null) st.events.push({ ...rec, dur: Math.round(performance.now() - rec.first), endReason: 'open' });
    return st; };
  return 'installed';
})()`;

// 块级观察器：追踪 15-45 号顶层块的高度/c-v 状态/公式就绪态（弹跳波归因）
const BLOCK_WATCH = `(() => {
  if (window.__r5bw) return 'already';
  const st = { rows: [], running: true, _raf: 0, last: {} };
  window.__r5bw = st;
  const pick = () => [...document.querySelectorAll('.ProseMirror > *')];
  const tick = (t) => {
    if (!st.running) return;
    try {
      const kids = pick();
      for (let i = 15; i <= 45 && i < kids.length; i++) {
        const el = kids[i];
        const h = Math.round(el.getBoundingClientRect().height);
        const key = i + ':' + h;
        if (st.last[i] !== key) {
          st.last[i] = key;
          const cv = getComputedStyle(el).contentVisibility;
          const cis = getComputedStyle(el).containIntrinsicSize;
          const styleAttr = el.getAttribute('style') || '';
          const lazy = el.querySelectorAll('.mditor-math-inline-lazy').length;
          const ready = el.querySelectorAll('.mditor-math-inline-ready').length;
          const h4 = el.querySelector('h4, h3, h2');
          st.rows.push({ t: Math.round(t), i, h, cv, cis, styleAttr, lazy, ready,
            tag: el.tagName + (h4 ? ':' + (h4.textContent || '').slice(0, 12) : ':' + (el.textContent || '').slice(0, 12)) });
        }
      }
      if (st.rows.length > 4000) st.running = false;
    } catch {}
    st._raf = requestAnimationFrame(tick);
  };
  st._raf = requestAnimationFrame(tick);
  return 'installed';
})()`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(FORENSICS_DIR, { recursive: true }); mkdirSync(RESULTS_DIR, { recursive: true });
  const devlogPath = join(FORENSICS_DIR, `devlog-r5f-${args.tag}.txt`);
  const logFd = openSync(devlogPath, "w");
  const log = (m) => { try { writeSync(logFd, `[${new Date().toISOString()}] ${m}\n`); } catch {} console.log(m); };

  let child = null, cdp = null;
  const row = { ts: new Date().toISOString(), tag: args.tag, scenario: args.scenario, doc: args.doc, viewport: args.viewport,
    wheelLog: [], placeholderEvents: [], tops: [], frameGaps: null, destroy: null, katexErrors: -1, notes: [] };
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
    for (const s of [child.stdout, child.stderr]) s.on("data", (d) => { try { writeSync(logFd, d); } catch {} });
    let target = null;
    while (Date.now() - spawnAt < 150_000) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(700) });
        const page = (await res.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) { target = page; break; }
      } catch {}
      await sleep(500);
    }
    if (!target) { log("CDP 未就绪"); return (closeLog(), 2); }
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const m = mouse(cdp);
    try { await cdp.send("Network.enable"); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }); } catch {}
    for (let i = 0; i < 120; i++) { if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break; await sleep(500); }
    try { await cdp.send("Page.enable"); await cdp.send("Page.reload", { ignoreCache: true }); } catch {}
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
    const readTop = () => cdp.eval(`Math.round(document.querySelector('.mditor-editor-host')?.scrollTop ?? -1)`);
    const cx = 640, cy = 400;
    const wheel = async (dy, pause = 180) => {
      row.wheelLog.push({ t: Date.now(), dy });
      await m.wheel(cx, cy, 0, dy);
      await sleep(pause);
    };

    if (!await openDoc(args.doc)) { log("文件树找不到目标文档"); return (closeLog(), 2); }
    await sleep(8000);
    const big = await cdp.eval(`(() => { const h = document.querySelector('.mditor-editor-host'); return h ? h.dataset.big !== undefined : null; })()`);
    log(`文档已开 big=${big}`);
    await cdp.eval(F_REC);
    await cdp.eval(BLOCK_WATCH);

    if (args.scenario === "upscroll") {
      // 下滚 ~6000px（阅读节奏），再上滚 ~3000px，再快速往返一次
      for (let i = 0; i < 20; i++) await wheel(300);
      log(`下滚完成 top=${await readTop()}`);
      await sleep(1500);
      for (let i = 0; i < 10; i++) await wheel(-300);
      log(`上滚完成 top=${await readTop()}`);
      await sleep(1500);
      for (const dy of [1200, -1200, 2000, -2000]) { await wheel(dy, 400); }
      await sleep(2500);
      row.katexErrors = await cdp.eval(`document.querySelectorAll('.katex-error').length`);
    } else if (args.scenario === "tabback") {
      // 空闲弹跳波终裁：下滚 8100 → 开第二文档 → 切回 → 纯静置观察（无滚动）
      for (let i = 0; i < 27; i++) await wheel(300);
      log(`预滚完成 top=${await readTop()}`);
      await sleep(2500);
      const doc2 = findDoc(workspaces, args.doc2 || "解题技巧");
      if (doc2 && await openDoc(args.doc2 || "解题技巧")) {
        await sleep(12000);
        const base = basename(docPath).replace(/\.md$/, "");
        for (let i = 0; i < 20; i++) {
          const p = await cdp.eval(`(() => {
            const hit = [...document.querySelectorAll('.tabbar-tab')].find(t => (t.textContent ?? '').includes(${JSON.stringify(base)}));
            if (!hit) return null;
            const r = hit.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          })()`);
          if (p) { await m.click(p.x, p.y); break; }
          await sleep(500);
        }
        log("已切回，静置观察 45s");
        await sleep(45000);
      } else { row.notes.push("doc2-unavailable"); await sleep(20000); }
      row.katexErrors = await cdp.eval(`document.querySelectorAll('.katex-error').length`);
    } else if (args.scenario === "destroy") {
      // 找一个含 .cm-editor 的代码块，滚到其下方 1000px 外停 16s 再回
      const found = await cdp.eval(`(() => {
        const blocks = [...document.querySelectorAll('.cm-editor')].map((cm) => {
          const blk = cm.closest('div');
          const r = (blk ?? cm).getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), top: Math.round(r.top), h: Math.round(r.height) };
        });
        return blocks.slice(0, 20);
      })()`);
      log(`cm 块数: ${found.length}`);
      if (!found.length) { row.notes.push("no-cm-blocks"); }
      else {
        const host = 400;
        for (let i = 0; i < 12; i++) { await wheel(400); if (await readTop() > 1500) break; }
        const probe = await cdp.eval(`(() => {
          const host = document.querySelector('.mditor-editor-host');
          const vh = host.clientHeight;
          for (const cm of document.querySelectorAll('.cm-editor')) {
            const blk = cm.closest('div');
            const r = (blk ?? cm).getBoundingClientRect();
            if (r.top > 0 && r.top < vh * 0.5) {
              return { h: Math.round(r.height), top: Math.round(r.top), hasCm: !!blk.querySelector('.cm-editor') };
            }
          }
          return null;
        })()`);
        log(`目标块: ${JSON.stringify(probe)}`);
        row.destroy = { before: probe };
        for (let i = 0; i < 6; i++) await wheel(400); // 滚离 ~1000px+
        log(`滚离 top=${await readTop()}，停 16.5s`);
        await sleep(16500);
        row.destroy.awaySnapshot = await cdp.eval(`(() => {
          const host = document.querySelector('.mditor-editor-host');
          let n = 0; for (const cm of document.querySelectorAll('.cm-editor')) n++;
          return { top: Math.round(host.scrollTop), cmCount: n };
        })()`);
        for (let i = 0; i < 8; i++) { await wheel(-400); const t = await readTop(); if (t < (row.destroy.before ? 800 : 400)) break; }
        // 回滚后 4s 内每 200ms 采样块状态
        const back = [];
        for (let i = 0; i < 20; i++) {
          back.push(await cdp.eval(`(() => {
            const host = document.querySelector('.mditor-editor-host');
            return { t: Math.round(performance.now()), top: Math.round(host.scrollTop), cmCount: document.querySelectorAll('.cm-editor').length };
          })()`));
          await sleep(200);
        }
        row.destroy.backTimeline = back;
        await sleep(2000);
        row.katexErrors = await cdp.eval(`document.querySelectorAll('.katex-error').length`);
      }
    }

    const st = await cdp.eval(`window.__r5f.stop()`);
    row.placeholderEvents = st.events;
    row.tops = st.tops;
    row.blockWatch = await cdp.eval(`window.__r5bw ? window.__r5bw.rows : []`);
    if (args.scenario === "tabback") {
      row.scrollDebugEvents = await cdp.eval(`(() => {
        const es = typeof window.__scrollDebug?.events === 'function' ? window.__scrollDebug.events() : [];
        return es.filter(e => e.level !== 'info' || e.kind === 'cv.relearn').slice(-60)
          .map(e => ({ ts: e.ts, kind: e.kind, msg: e.msg.slice(0, 120),
            via: e.data && e.data.via ? String(e.data.via).slice(0, 200) : null,
            data: e.data && e.data.from != null ? e.data.from + '->' + e.data.to : null }));
      })()`).catch(() => []);
    }
    const gaps = st.gaps.filter((g) => g > 0).sort((a, b) => a - b);
    const q = (p) => (gaps.length ? gaps[Math.floor(gaps.length * p)] : 0);
    row.frameGaps = { n: gaps.length, p50: q(0.5), p95: q(0.95), max: gaps.length ? gaps[gaps.length - 1] : 0, over50: gaps.filter((g) => g > 50).length };
    log(`占位事件 ${row.placeholderEvents.length} 条，帧 p95=${row.frameGaps.p95}ms`);

    try { cdp.close(); } catch {}
    cdp = null;
    killChildTree(child); child = null;
    const out = join(RESULTS_DIR, `r5-phase2-f-${args.scenario}-${args.tag}.json`);
    writeFileSync(out, JSON.stringify(row));
    log(`证据落盘 ${out}`);
    return (closeLog(), 0);
  } catch (e) {
    log("异常: " + (e?.stack || e));
    try { cdp && cdp.close(); } catch {}
    killChildTree(child);
    return (closeLog(), 1);
  }
  function closeLog() { try { closeSync(logFd); } catch {} }
}
main().then((c) => process.exit(c ?? 0), (e) => { console.error(e?.stack || e); process.exit(2); });
