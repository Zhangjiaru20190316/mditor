// ghost-stress.mjs —— MD-1001/1002/1011 复现压力场景（D3 / M2）。
//
// 场景设计（对照生产证据）：
//   * 4.17.1 ghost 簇：数学密集文档滚读 + 告警卡/侧栏开合交替（41-42px 往复），
//     lastWrite=file-open（无用户编辑）——滚读时 UI 开合引发视口位移；
//   * MD-1011：AI 写入/揭示类整批顶层块替换 → remembered size 丢失 → 3em 占位
//     回落 → 视口跳变（-937/+382 块级海啸）。
//   * 场景时长默认 10min（--minutes），可拉长到 30min。
//
// 读数：
//   * window.__scrollDebug（哨兵计数器：session.ghost / layout:shift / block.rebase
//     等 + frameStats 窗口口径）；
//   * dev-anomalies 日志（MD-1001/1002/1011）——本脚本收尾时汇总本次会话新增条数
//     （读 %APPDATA%/com.mditor.app.dev/logs/dev-anomalies.log 的行数差）。
//   * 每阶段帧分布（rAF gaps p95 + over50）。
//
// 用法：node perf/ghost-stress.mjs [--doc <子串>] [--minutes 10] [--tag 名]
// 自管实例（与 scroll-abab 同族预检/store/启停/清理）。

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, writeSync, closeSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { findPageTarget, Cdp, mouse, sleep, LONGTASK_RECORDER } from "./cdp.mjs";

const PORT = 9223;
const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..");
const REPO_ROOT = resolve(MDITOR_DIR, "..");
const FORENSICS_DIR = join(REPO_ROOT, ".workflow", "task2-forensics");
const RESULTS_JSONL = join(here, "results", "ghost-stress.jsonl");
const STORE_PATH = join(process.env.APPDATA ?? ".", "com.mditor.app.dev", "mditor.json");
const ANOMALY_LOG = join(process.env.APPDATA ?? ".", "com.mditor.app.dev", "logs", "dev-anomalies.log");

function parseArgs(argv) {
  const a = { doc: "无穷级数_密度档", minutes: 10, tag: "ghost" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);
    if (k === "--doc") a.doc = next();
    else if (k === "--minutes") a.minutes = Number(next());
    else if (k === "--tag") a.tag = next();
    else throw new Error("未知参数: " + k);
  }
  if (!(a.minutes >= 3)) throw new Error("--minutes 必须 ≥3");
  return a;
}

async function portFree(port = PORT) {
  try {
    await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(700) });
    return false;
  } catch { return true; }
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
async function hardCleanup(child, log = () => {}) {
  try { if (child && child.pid) run("taskkill", ["/F", "/T", "/PID", String(child.pid)]); } catch { /* */ }
  run("taskkill", ["/F", "/IM", "mditor.exe"]);
  for (let i = 0; i < 30; i++) {
    if (await portFree()) return true;
    if (i === 10) { log("10s 未释放，二次 taskkill"); run("taskkill", ["/F", "/T", "/IM", "mditor.exe"]); }
    await sleep(500);
  }
  return false;
}
const sanitize = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);

function editStore() {
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  const holder = raw.settings ? raw : raw.value;
  holder.settings.devMode = false;
  holder.settings.bigDocViewport = false;
  holder.settings.bigDocPerformance = false;
  writeFileSync(STORE_PATH, JSON.stringify(raw, null, 2), "utf8");
  return { workspaces: raw.workspaces ?? [] };
}

function anomalyCount() {
  try { return readFileSync(ANOMALY_LOG, "utf8").split("\n").filter((l) => l.trim()).length; } catch { return 0; }
}

const TSFR_INSTALL = `(() => {
  if (window.__tsfr) return 'already';
  window.__tsfr = { gaps: [], _running: false, _raf: 0, _last: 0,
    start() { this.gaps = []; this._last = performance.now(); this._running = true;
      const tick = (t) => { if (!this._running) return; this.gaps.push(t - this._last); this._last = t; this._raf = requestAnimationFrame(tick); };
      this._raf = requestAnimationFrame(tick); },
    stop() { this._running = false; cancelAnimationFrame(this._raf);
      const s = this.gaps.slice().sort((a,b)=>a-b);
      const q = (p) => s.length ? Math.round(s[Math.floor(s.length*p)]) : 0;
      return { frames: this.gaps.length, p50: q(0.5), p95: q(0.95), max: s.length ? Math.round(s[s.length-1]) : 0,
               over50: this.gaps.filter(g=>g>50).length }; } };
  return 'installed';
})()`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(FORENSICS_DIR, { recursive: true });
  const devlogPath = join(FORENSICS_DIR, `devlog-ghost-${sanitize(args.tag)}.txt`);
  const logFd = openSync(devlogPath, "w");
  const log = (m) => { writeSync(logFd, `[${new Date().toISOString()}] ${m}\n`); console.log(m); };

  let child = null, cdp = null;
  const row = { ts: new Date().toISOString(), tag: args.tag, doc: args.doc, minutes: args.minutes,
                phases: [], anomaliesBefore: 0, anomaliesAfter: 0, verdict: null };
  try {
    if (!(await portFree())) {
      const freed = await hardCleanup(null, (m) => log("  " + m));
      if (!freed) { log("预检失败: 端口仍被占"); return (closeLog(), 2); }
    }
    const stale = vitePortPids();
    if (stale.length) { log(`预检失败: vite 残留 PID ${stale.join(",")}`); return (closeLog(), 2); }
    const { workspaces } = editStore();
    // 解析文档
    let docPath = null;
    for (const ws of workspaces) {
      try { for (const e of readdirSync(ws, { recursive: true })) {
        const n = basename(String(e));
        if (n.toLowerCase().includes(args.doc.toLowerCase()) && n.endsWith(".md")) { docPath = join(ws, String(e)); break; }
      } } catch { /* */ }
      if (docPath) break;
    }
    if (!docPath) { log(`找不到文档 ${args.doc}`); return (closeLog(), 2); }

    row.anomaliesBefore = anomalyCount();
    const spawnAt = Date.now();
    child = spawn("cmd.exe", ["/c", "npx", "tauri", "dev", "--config", "src-tauri/tauri.dev.conf.json"], {
      cwd: MDITOR_DIR, env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    for (const s of [child.stdout, child.stderr]) s.on("data", (d) => { try { writeSync(logFd, d); } catch { /* */ } });
    let target = null;
    while (Date.now() - spawnAt < 120_000) {
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
    await cdp.eval(LONGTASK_RECORDER);
    await cdp.eval(TSFR_INSTALL);

    // 打开目标文档
    const docName = basename(docPath);
    let p = null;
    for (let i = 0; i < 30 && !p; i++) {
      p = await cdp.eval(`(() => {
        const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes(${JSON.stringify(args.doc)}));
        if (!hit) return null;
        const r = hit.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (!p) await sleep(500);
    }
    if (!p) { log("文件树找不到目标"); return (closeLog(), 2); }
    await m.click(p.x, p.y);
    await sleep(8000); // 打开余波

    const scrollDebug = () => cdp.eval(`window.__scrollDebug ? window.__scrollDebug.counters() : null`);
    const frameStats = () => cdp.eval(`window.__scrollDebug ? window.__scrollDebug.frameStats() : null`);
    const readTop = () => cdp.eval(`document.querySelector('.mditor-editor-host')?.scrollTop ?? 0`);

    const phase = async (name, fn) => {
      await cdp.eval("window.__tsfr.start()");
      const c0 = await scrollDebug();
      const t0 = Date.now();
      await fn();
      const fr = await cdp.eval("window.__tsfr.stop()");
      const c1 = await scrollDebug();
      const delta = {};
      if (c0 && c1) for (const k of ["session.ghost", "layout:shift", "block.rebase", "pm:rebuild", "session.user"]) {
        if (c1[k] != null) delta[k] = c1[k] - (c0[k] ?? 0);
      }
      row.phases.push({ name, durS: Math.round((Date.now() - t0) / 100) / 10, frame: fr, delta });
      log(`阶段 ${name}: ${fn.length ? "" : ""}${JSON.stringify(fr)} Δ${JSON.stringify(delta)}`);
    };

    const cx = 640, cy = 400;
    const openCloseSidebar = async () => {
      // 侧栏开合 ×3（找侧栏切换按钮或点热键）
      for (let i = 0; i < 3; i++) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "b", code: "KeyB", windowsVirtualKeyCode: 66, modifiers: 2 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "b", code: "KeyB", windowsVirtualKeyCode: 66, modifiers: 2 });
        await sleep(1200);
      }
    };
    const scrollRead = async (secs) => {
      const t = Date.now();
      let dir = 1;
      while (Date.now() - t < secs * 1000) {
        await m.wheel(cx, cy, 0, dir * 240);
        const top = await readTop();
        if (top > 12000) dir = -1; else if (top < 100) dir = 1;
        await sleep(160);
      }
    };

    // 阶段1：滚读（基线）
    await phase("scroll-read", () => scrollRead(60));
    // 阶段2：滚读 + 侧栏开合交替（4.17.1 ghost 簇场景）
    await phase("scroll+sidebar", async () => {
      const t = Date.now();
      let dir = 1, n = 0;
      while (Date.now() - t < 90_000) {
        await m.wheel(cx, cy, 0, dir * 240);
        const top = await readTop();
        if (top > 12000) dir = -1; else if (top < 100) dir = 1;
        await sleep(160);
        if (++n % 18 === 0) await openCloseSidebar();
      }
    });
    // 阶段3：结构海啸模拟（MD-1011 场景：整批顶层块隐藏-恢复循环）
    await phase("structural-tsunami", async () => {
      for (let i = 0; i < 6; i++) {
        // 程序化折叠/展开大纲面板型 UI 开合 + 大幅程序化滚动往返（AI 写入
        // 后视口位移的激发子集；真实 AI 写入需 API key，此处用程序化 scrollTop
        // 大跳 + 锚定恢复路径施压——ghost 归因器会把「无用户输入源的位移」
        // 记为 session.ghost 候选）。
        await cdp.eval(`(() => { const h = document.querySelector('.mditor-editor-host'); if (h) h.scrollTop += 4000; })()`);
        await sleep(600);
        await cdp.eval(`(() => { const h = document.querySelector('.mditor-editor-host'); if (h) h.scrollTop -= 4000; })()`);
        await sleep(900);
      }
    });
    // 阶段4：编辑 + 滚读混合
    await phase("type+scroll", async () => {
      const t = Date.now();
      let dir = 1, k = 0;
      while (Date.now() - t < 60_000) {
        await m.wheel(cx, cy, 0, dir * 300);
        const top = await readTop();
        if (top > 10000) dir = -1; else if (top < 100) dir = 1;
        await sleep(200);
        if (++k % 10 === 0) {
          await cdp.eval(`(() => { const s = window.getSelection(); const pm = document.querySelector('.ProseMirror'); pm?.dispatchEvent(new KeyboardEvent('keydown', {key: 'End'})); })()`);
        }
      }
    });

    await sleep(35_000); // 心跳窗（30s）落定，异常分类器跑完
    row.anomaliesAfter = anomalyCount();
    const fs2 = await frameStats();
    row.finalFrameStats = fs2;
    const ghosts = row.phases.reduce((s, ph) => s + (ph.delta["session.ghost"] ?? 0), 0);
    row.verdict = { ghostSessions: ghosts, anomaliesAdded: row.anomaliesAfter - row.anomaliesBefore };
    log(`判定: ghost=${ghosts} anomalies+${row.anomaliesAfter - row.anomaliesBefore} finalStats=${JSON.stringify(fs2)}`);

    try { cdp.close(); } catch { /* */ }
    cdp = null;
    await hardCleanup(child, (s) => log("  " + s));
    child = null;
    appendFileSync(RESULTS_JSONL, JSON.stringify(row) + "\n", "utf8");
    log(`结果落盘 ${RESULTS_JSONL}`);
    return (closeLog(), 0);
  } catch (e) {
    log("异常: " + (e?.stack || e));
    try { cdp && cdp.close(); } catch { /* */ }
    await hardCleanup(child, (s) => { try { writeSync(logFd, "  " + s + "\n"); } catch { /* */ } });
    return (closeLog(), 1);
  }
  function closeLog() { try { closeSync(logFd); } catch { /* */ } }
}
main().then((c) => process.exit(c ?? 0), (e) => { console.error(e?.stack || e); process.exit(2); });
