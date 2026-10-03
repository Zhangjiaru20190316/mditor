// exp-metrics.mjs —— R8 阶段四 exp2：1MB 上/下滚段 Performance.getMetrics 差分
// （一次性，不入库）。回答：掉帧帧间隔期间主线程耗时在哪（Layout/RecalcStyle/
// Task/Script/GCTask），定位布局墙 vs 脚本 vs 合成器侧。
//
// 用法：node perf/tmp-r8/exp-metrics.mjs --scenario up-fast|down-fast [--tag r8exp] [--run 1]
// 流程：起 dev(9223) → 开 1MB压测 → prewarm-wait → Performance.enable →
//   段驱动（up 臂=down-leg→settle→up 5000px；down 臂=--start-depth 0.6 深位下滚
//   5000px）→ 每段边界取 getMetrics 快照 → 段间差分落盘 perf/results/r8-exp2-metrics-*.json
// 红线：只加观测不改 src。

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
  const a = { scenario: "up-fast", tag: "r8exp", run: 1 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);
    if (k === "--scenario") a.scenario = next();
    else if (k === "--tag") a.tag = next();
    else if (k === "--run") a.run = Number(next() ?? 1);
  }
  return a;
}
async function portFree(port = PORT) {
  try { await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(700) }); return false; } catch { return true; }
}
function run(cmd, args) { spawnSync(cmd, args, { stdio: "ignore", windowsHide: true }); }
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
function cargoResidue() {
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq cargo.exe", "/FO", "CSV"], { encoding: "utf8", windowsHide: true });
  return String(r.stdout || "").split("\n").filter((l) => /cargo\.exe/i.test(l)).length;
}
function editStore() {
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  const holder = raw.settings ? raw : raw.value;
  holder.settings.devMode = false;
  holder.settings.bigDocViewport = true;
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
  const devlogPath = join(FORENSICS_DIR, `devlog-r8exp-${args.tag}-${args.scenario}-${args.run}.txt`);
  const logFd = openSync(devlogPath, "w");
  const log = (m) => { try { writeSync(logFd, `[${new Date().toISOString()}] ${m}\n`); } catch { /* */ } console.log(m); };

  let child = null, cdp = null;
  const row = { ts: new Date().toISOString(), tag: args.tag, scenario: args.scenario, run: args.run, ok: false };
  try {
    if (!(await portFree())) { log("预检失败: 9223 被占"); return (closeLog(), 2); }
    if (cargoResidue() > 0) { log("预检失败: cargo watch 残留"); return (closeLog(), 2); }
    const { workspaces } = editStore();
    const docPath = findDoc(workspaces, "1MB压测");
    if (!docPath) { log("找不到 1MB压测"); return (closeLog(), 2); }
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
    if (!await openDoc("1MB压测")) { log("文件树找不到目标文档"); return (closeLog(), 2); }

    const readScroll = () => cdp.eval(`(() => { const h = document.querySelector('.mditor-editor-host'); return h ? { top: Math.round(h.scrollTop), h: Math.round(h.scrollHeight), vh: h.clientHeight } : null; })()`);
    await sleep(6000);
    let s = await readScroll();
    log(`文档已开 scroll=${JSON.stringify(s)}`);

    // 等预热完成
    const t0p = Date.now();
    while (Date.now() - t0p < 150_000) {
      const done = await cdp.eval(`(() => { const sd = window.__scrollDebug; if (!sd) return false; const es = typeof sd.events === 'function' ? sd.events() : sd.events; return (es ?? []).some(e => e.kind === 'prewarm.done'); })()`);
      if (done) { log("预热已完成"); break; }
      await sleep(2000);
    }

    try { await cdp.send("Performance.enable"); } catch { /* */ }
    const getMetrics = async () => {
      const r = await cdp.send("Performance.getMetrics").catch(() => null);
      if (!r) return null;
      const o = {};
      for (const x of r.metrics) o[x.name] = x.value;
      return o;
    };
    const snapAll = async (label) => {
      const mm = await getMetrics();
      const st = await readScroll();
      row.segs.push({ label, t: Date.now() - spawnAt, st, metrics: mm });
      log(`[${label}] ${JSON.stringify(st)} layout=${mm?.LayoutDuration?.toFixed?.(3)} recalc=${mm?.RecalcStyleDuration?.toFixed?.(3)} task=${mm?.TaskDuration?.toFixed?.(3)} script=${mm?.ScriptDuration?.toFixed?.(3)}`);
    };

    row.segs = [];
    const cx = 640, cy = 400;
    const wheel = async (dy, pause) => { await m.wheel(cx, cy, 0, dy); await sleep(pause); };
    const fast = async (px) => { const n = Math.ceil(Math.abs(px) / 1200); for (let i = 0; i < n; i++) await wheel(Math.sign(px) * 1200, 90); };
    const dir = args.scenario.split("-")[0];
    const targetTop = Math.round((s.h - s.vh) * 0.6);

    await snapAll("baseline");
    if (dir === "down") {
      await fast(targetTop - s.top);
      await sleep(1200);
      await snapAll("after-positioning");
      s = await readScroll();
      await fast(Math.min(5000, (s.h - s.vh) - s.top));
      await snapAll("after-drive-5000px");
    } else {
      await fast(targetTop - s.top);
      await snapAll("after-down-leg");
      await sleep(1200);
      await snapAll("after-settle");
      s = await readScroll();
      await fast(-Math.min(5000, s.top));
      await snapAll("after-up-5000px");
    }
    await sleep(10_000);
    await snapAll("after-quiet-10s");

    // 段间差分汇总
    const segs = row.segs;
    const diff = [];
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1].metrics, b = segs[i].metrics;
      const d = {};
      for (const k of ["LayoutDuration", "RecalcStyleDuration", "TaskDuration", "ScriptDuration", "LayoutCount", "RecalcStyleCount", "TaskCount", "JSHeapUsedSize"]) {
        if (a && b && a[k] != null && b[k] != null) d[k] = +(b[k] - a[k]).toFixed(3);
      }
      diff.push({ from: segs[i - 1].label, to: segs[i].label, wallMs: segs[i].t - segs[i - 1].t, ...d });
    }
    row.diff = diff;
    log("=== 段间差分 ===");
    for (const d of diff) log(JSON.stringify(d));
    row.ok = true;

    try { cdp.close(); } catch { /* */ }
    cdp = null;
    killChildTree(child);
    killStalePorts();
    child = null;
    const out = join(RESULTS_DIR, `r8-exp2-metrics-${args.scenario}-${args.tag}-${args.run}.json`);
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
