// switch-bench.mjs —— 文件切换/加载动画帧节奏基准（M3 / P4 切标签场景，D2）。
//
// 用法：
//   node perf/switch-bench.mjs --doc-a <子串A> --doc-b <子串B>
//        [--viewport on|off(默认off)] [--switches 20] [--tag 标签] [--settle-cap 90]
//
// 测什么（对照生产 MD-1003：解题技巧总汇切标签 1~4.5s 阻塞）：
//   两份大文档间往返切换 N 次，每次切换采集——
//     * switchMs：点击 → 切换 UI（.main.is-switching）消失且新文档 PM 顶层块稳定；
//     * 动画窗帧间隔（带时间戳的 rAF 采样）：p50/p95/max、>32ms/>50ms 帧数
//       （主线程被重活饿死时 rAF 不触发，跨阻塞期的 gap 即掉帧签名）；
//     * 长任务（PerformanceObserver longtask）：n/max/total。
//   产出按方向（A→B / B→A）聚合 + 逐次明细，追加 perf/results/switch-bench.jsonl。
//
// 场景纪律：单轮一 arm（代码版本由外部 git 切臂，ABAB 交错）；arm 自证 =
//   viewport off 时 host 无 data-big（默认急切渲染路径），on 时有 data-big。
//   不改任何 src/ 代码；bigDocPerformance 恒 false（红线：减配档永不启用）。
//
// 设计要点：切换完成判据用「UI 类消失 + PM 块数稳定 + 目标行 ft-active」三重，
//   与 open-1mb.mjs 的稳定判据同族；帧记录器带时间戳以便按切换窗口切片（本
//   脚本每窗单独 start/stop，天然分窗，时间戳仅作对账）。

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, writeSync, closeSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { findPageTarget, Cdp, mouse, sleep, LONGTASK_RECORDER } from "./cdp.mjs";

// ---------- 常量 / 路径 ------------------------------------------------------

const PORT = 9223;
const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..");
const REPO_ROOT = resolve(MDITOR_DIR, "..");
const FORENSICS_DIR = join(REPO_ROOT, ".workflow", "task2-forensics");
const RESULTS_JSONL = join(here, "results", "switch-bench.jsonl");
const STORE_PATH = join(process.env.APPDATA ?? ".", "com.mditor.app.dev", "mditor.json");

// ---------- 参数解析 ---------------------------------------------------------

function parseArgs(argv) {
  const a = { docA: null, docB: null, viewport: "off", switches: 20, tag: "run", settleCap: 90 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);
    if (k === "--doc-a") a.docA = next();
    else if (k === "--doc-b") a.docB = next();
    else if (k === "--viewport") a.viewport = next();
    else if (k === "--switches") a.switches = Number(next());
    else if (k === "--tag") a.tag = next();
    else if (k === "--settle-cap") a.settleCap = Number(next());
    else throw new Error("未知参数: " + k);
  }
  if (!a.docA || !a.docB) throw new Error("--doc-a 与 --doc-b 必填（workspace 内唯一匹配的文件名子串）");
  if (a.viewport !== "on" && a.viewport !== "off") throw new Error("--viewport 只认 on|off");
  if (!(a.switches >= 4)) throw new Error("--switches 必须 ≥4");
  return a;
}

// ---------- 工具（与 scroll-abab.mjs 同族）-----------------------------------

async function portFree(port = PORT) {
  try {
    await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(700) });
    return false;
  } catch {
    return true;
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "ignore", windowsHide: true });
  return r.status;
}

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
  try { if (child && child.pid) run("taskkill", ["/F", "/T", "/PID", String(child.pid)]); } catch { /* 已退出 */ }
  run("taskkill", ["/F", "/IM", "mditor.exe"]);
  for (let i = 0; i < 30; i++) {
    if (await portFree()) return true;
    if (i === 10) { log("10s 未释放，二次 taskkill /F /T /IM mditor.exe"); run("taskkill", ["/F", "/T", "/IM", "mditor.exe"]); }
    await sleep(500);
  }
  return false;
}

const sanitize = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);

function percentileSummary(gaps) {
  const s = [...gaps].sort((x, y) => x - y);
  const q = (p) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10 : 0);
  return {
    frames: gaps.length,
    p50: q(0.5), p90: q(0.9), p95: q(0.95),
    max: s.length ? Math.round(s[s.length - 1] * 10) / 10 : 0,
    over32: gaps.filter((g) => g > 32).length,
    over50: gaps.filter((g) => g > 50).length,
  };
}

function longtaskSummary(events) {
  if (!events.length) return { n: 0, totalMs: 0, maxMs: 0, over1000: 0, top: [] };
  const sorted = [...events].sort((a, b) => b.d - a.d);
  return {
    n: events.length,
    totalMs: events.reduce((s2, e) => s2 + e.d, 0),
    maxMs: sorted[0].d,
    over1000: events.filter((e) => e.d > 1000).length,
    top: sorted.slice(0, 5).map((e) => ({ t: e.t, d: e.d })),
  };
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// ---------- dev store 读写 ---------------------------------------------------

function editStore(viewportOn) {
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  let holder = null;
  if (raw && typeof raw === "object" && raw.settings && typeof raw.settings === "object") holder = raw;
  else if (raw && typeof raw.value === "object" && raw.value && raw.value.settings && typeof raw.value.settings === "object") holder = raw.value;
  else throw new Error("dev store 结构不认识，顶层键: " + JSON.stringify(Object.keys(raw ?? {})));
  holder.settings.devMode = false;
  holder.settings.bigDocViewport = viewportOn;
  holder.settings.bigDocPerformance = false; // 恒 false：绝不启用减配档
  writeFileSync(STORE_PATH, JSON.stringify(raw, null, 2), "utf8");
  const back = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  const s = (back.settings ? back : back.value).settings;
  if (s.devMode !== false || s.bigDocViewport !== viewportOn || s.bigDocPerformance !== false) {
    throw new Error(`store 回读校验失败: ${JSON.stringify(s)}`);
  }
  return { workspaces: Array.isArray(raw.workspaces) ? raw.workspaces : [] };
}

function resolveDocFile(workspaces, substr) {
  const low = substr.toLowerCase();
  const hits = [];
  for (const ws of workspaces) {
    let entries = [];
    try { entries = readdirSync(ws, { recursive: true, withFileTypes: false }); } catch { continue; }
    for (const e of entries) {
      const name = basename(String(e));
      if (name.toLowerCase().includes(low) && name.toLowerCase().endsWith(".md")) {
        hits.push(join(ws, String(e)));
      }
    }
  }
  const uniq = [...new Set(hits.map((p) => p.replaceAll("\\", "/").toLowerCase()))];
  if (uniq.length === 0) throw new Error(`workspace 里找不到匹配 "${substr}" 的 .md 文件`);
  if (uniq.length > 1) throw new Error(`"${substr}" 匹配到 ${uniq.length} 个文件（须唯一）: ${uniq.join("; ")}`);
  const text = readFileSync(hits[0], "utf8");
  let dollars = 0;
  for (const ch of text) if (ch === "$") dollars++;
  return {
    path: hits[0], name: basename(hits[0]),
    lines: text.split("\n").length,
    bytes: Buffer.byteLength(text),
    dollars,
  };
}

// ---------- 页内 evaluate 片段 -----------------------------------------------

/** 带时间戳的帧记录器：gaps[i] = { t(自start的ms), g(间隔ms) }，便于按窗口对账。 */
const TSFR_INSTALL = `(() => {
  if (window.__tsfr) return 'already';
  window.__tsfr = {
    gaps: [], _running: false, _raf: 0, _last: 0, _t0: 0,
    start() { this.gaps = []; this._t0 = performance.now(); this._last = this._t0; this._running = true;
      const tick = (t) => { if (!this._running) return; this.gaps.push({ t: Math.round(t - this._t0), g: Math.round((t - this._last) * 10) / 10 }); this._last = t; this._raf = requestAnimationFrame(tick); };
      this._raf = requestAnimationFrame(tick); },
    stop() { this._running = false; cancelAnimationFrame(this._raf); return this.gaps; },
  };
  return 'installed';
})()`;

/** 找到目标文件行并滚到可见，返回点击坐标；找不到返回 null。 */
const rowPosOf = (wantPath, wantName) => `(() => {
  const rows = [...document.querySelectorAll('.ft-row.ft-file')];
  const hit = rows.find(r => {
    const p = (r.getAttribute('data-path') || '').replaceAll('\\\\', '/').toLowerCase();
    const n = (r.querySelector('.ft-name')?.textContent || '').toLowerCase();
    return p.endsWith(${JSON.stringify("/" + wantName)}) || p === ${JSON.stringify(wantPath)} || n.includes(${JSON.stringify(wantName)});
  });
  if (!hit) return null;
  hit.scrollIntoView({ block: 'center' });
  const r = hit.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`;

/** 切换进行中标志 + 当前激活行 + PM 块数（一次 evaluate，轮询用）。 */
const SWITCH_STATE = `(() => {
  const main = document.querySelector('main.main');
  const act = document.querySelector('.ft-row.ft-file.ft-active .ft-name');
  const pm = document.querySelector('.ProseMirror');
  return { switching: !!(main && main.classList.contains('is-switching')),
           active: act ? act.textContent : null,
           blocks: pm ? pm.children.length : 0,
           dataBig: !!document.querySelector('.mditor-editor-host[data-big]') };
})()`;

// ---------- 主流程 -----------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const viewportOn = args.viewport === "on";

  mkdirSync(FORENSICS_DIR, { recursive: true });
  mkdirSync(dirname(RESULTS_JSONL), { recursive: true });
  const devlogPath = join(FORENSICS_DIR, `devlog-sw-${sanitize(args.tag)}.txt`);
  const logFd = openSync(devlogPath, "w");
  const log = (msg) => {
    writeSync(logFd, `[${new Date().toISOString()}] ${msg}\n`); console.log(msg);
  };

  let child = null, cdp = null;
  const row = {
    ts: new Date().toISOString(), tag: args.tag, viewport: args.viewport,
    docA: args.docA, docB: args.docB, switches: args.switches,
    bootS: null, armValidated: false, perSwitch: [], agg: null,
  };
  let exitCode = 0;

  try {
    // ---- a) 预检 ------------------------------------------------------------
    if (!(await portFree())) {
      log(`预检: 端口 ${PORT} 被占，执行硬清理`);
      const freed = await hardCleanup(null, (m) => log("  " + m));
      if (!freed) { log("预检失败: 硬清理后端口仍被占"); return (closeLog(), 2); }
    }
    const stale = vitePortPids();
    if (stale.length) {
      log(`预检失败: 端口 1420 被残留 vite 占用（PID ${stale.join(", ")}），请清理后重跑`);
      return (closeLog(), 2);
    }
    const { workspaces } = editStore(viewportOn);
    log(`store 已改并回读校验: devMode=false bigDocViewport=${viewportOn} bigDocPerformance=false`);
    const docA = resolveDocFile(workspaces, args.docA);
    const docB = resolveDocFile(workspaces, args.docB);
    log(`docA: ${docA.name} lines=${docA.lines} bytes=${docA.bytes} $=${docA.dollars}`);
    log(`docB: ${docB.name} lines=${docB.lines} bytes=${docB.bytes} $=${docB.dollars}`);

    // ---- b) 启动 tauri dev --------------------------------------------------
    const spawnAt = Date.now();
    child = spawn("cmd.exe", ["/c", "npx", "tauri", "dev", "--config", "src-tauri/tauri.dev.conf.json"], {
      cwd: MDITOR_DIR,
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let childDied = null;
    child.on("exit", (code2, sig) => { childDied = { code: code2, sig }; });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (d) => { try { writeSync(logFd, d); } catch { /* */ } });
    log(`tauri dev 已启动 pid=${child.pid}，等待 CDP ${PORT}（上限 120s）`);

    let target = null;
    {
      const deadline = spawnAt + 120_000;
      while (Date.now() < deadline) {
        if (childDied) { log(`启动失败: tauri dev 提前退出（详见 ${devlogPath}）`); return (closeLog(), 2); }
        try {
          const res = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(700) });
          const list = await res.json();
          const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
          if (page) { target = page; break; }
        } catch { /* 未就绪 */ }
        await sleep(500);
      }
      if (!target) { log("启动失败: 120s 内 CDP 未就绪"); return (closeLog(), 2); }
    }
    row.bootS = Math.round((Date.now() - spawnAt) / 100) / 10;
    log(`CDP 就绪 bootS=${row.bootS}`);

    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const m = mouse(cdp);
    try {
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    } catch { /* Network 域不可用时退化 */ }

    for (let i = 0; i < 120; i++) {
      if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break;
      if (i === 119) { log("失败: 60s 内 .ProseMirror 未出现"); return (closeLog(), 2); }
      await sleep(500);
    }

    // 强制无缓存整页重载（在壳出现后）：vite 预打包 chunk 的 ?v= 哈希不含
    // 内容指纹，node_modules 打补丁后 URL 不变，WebView 磁盘缓存会把旧
    // chunk 原样供出来（P0-B#1 首测即栽在此——钩子代码在磁盘上、跑的却是
    // 没有钩子的缓存块）。重载后重等壳 + 文件树（getWorkspaces 退避重试
    // 已保证树不空），确保后续测量跑在当前代码上。
    try {
      await cdp.send("Page.enable");
      await cdp.send("Page.reload", { ignoreCache: true });
      for (let i = 0; i < 120; i++) {
        if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break;
        if (i === 119) { log("失败: 重载后 60s 内 .ProseMirror 未出现"); return (closeLog(), 2); }
        await sleep(500);
      }
      log("无缓存重载完成，壳就绪");
    } catch { /* Page 域不可用时按旧流程测（风险自担） */ }
    await cdp.eval(LONGTASK_RECORDER);
    await cdp.eval(TSFR_INSTALL);

    // ---- c) 打开 docA 并稳定 -------------------------------------------------
    const openDoc = async (doc, label) => {
      const wantPath = doc.path.replaceAll("\\", "/").toLowerCase();
      const capMs = args.settleCap * 1000;
      for (let attempt = 1; attempt <= 3; attempt++) {
        let pos = null;
        for (let i = 0; i < 30 && !pos; i++) {
          pos = await cdp.eval(rowPosOf(wantPath, doc.name.toLowerCase()));
          if (!pos) await sleep(500);
        }
        if (!pos) { log(`${label} 尝试 ${attempt}/3: 文件树找不到 ${doc.name}`); continue; }
        await m.click(pos.x, pos.y);
        const t0 = Date.now();
        let lastCount = -1, stable = 0, settled = false;
        while (Date.now() - t0 < capMs) {
          await sleep(400);
          const st = await cdp.eval(SWITCH_STATE);
          if (!st.switching && st.active === doc.name && st.blocks >= 30) {
            if (st.blocks === lastCount) { if (++stable >= 3) { settled = true; break; } } else stable = 0;
          }
          lastCount = st ? st.blocks : -1;
        }
        if (settled) { log(`${label} 已打开并稳定 (${Math.round(Date.now() - t0)}ms)`); return true; }
        log(`${label} 尝试 ${attempt}/3 失败: settled=${settled}`);
      }
      return false;
    };
    if (!(await openDoc(docA, "docA"))) { log("失败: docA 打不开"); return (closeLog(), 2); }
    await sleep(1500);

    // ---- d) arm 自证 ----------------------------------------------------------
    const st0 = await cdp.eval(SWITCH_STATE);
    const dataBig = st0.dataBig;
    const armOk = viewportOn ? dataBig : !dataBig;
    row.armValidated = armOk;
    log(`arm 自证: viewport=${args.viewport} dataBig=${dataBig} → ${armOk ? "PASS" : "FAIL"}`);
    if (!armOk) exitCode = 1;

    // ---- e) 往返切换 ----------------------------------------------------------
    const seq = [];
    for (let i = 0; i < args.switches; i++) seq.push(i % 2 === 0 ? docB : docA); // 从 A 出发：先切到 B

    for (let i = 0; i < seq.length; i++) {
      const to = seq[i];
      const from = i % 2 === 0 ? docA : docB;
      const wantPath = to.path.replaceAll("\\", "/").toLowerCase();
      let pos = null;
      for (let k = 0; k < 30 && !pos; k++) {
        pos = await cdp.eval(rowPosOf(wantPath, to.name.toLowerCase()));
        if (!pos) await sleep(500);
      }
      if (!pos) { log(`switch ${i + 1}: 找不到目标行，跳过`); continue; }
      await sleep(600); // 上一轮余波落定
      await cdp.eval("window.__ltRecorder.start()");
      await cdp.eval("window.__tsfr.start()");
      const t0 = Date.now();
      await m.click(pos.x, pos.y);
      // 切换完成：UI 类消失 + 激活行是目标 + PM 块数稳定（上限 90s）
      let lastCount = -1, stable = 0, done = false, state = null;
      while (Date.now() - t0 < 90_000) {
        await sleep(150);
        state = await cdp.eval(SWITCH_STATE);
        if (state && !state.switching && state.active === to.name && state.blocks >= 30) {
          if (state.blocks === lastCount) { if (++stable >= 3) { done = true; break; } } else stable = 0;
        }
        lastCount = state ? state.blocks : -1;
      }
      const switchMs = Date.now() - t0;
      const gaps = await cdp.eval("window.__tsfr.stop()");
      const lt = await cdp.eval("window.__ltRecorder.stop()");
      const per = {
        i: i + 1, dir: `${from.name}→${to.name}`,
        toName: to.name,
        switchMs,
        done,
        frame: percentileSummary((gaps ?? []).map((x) => x.g)),
        longtask: longtaskSummary(lt?.events ?? []),
      };
      row.perSwitch.push(per);
      log(`switch ${i + 1} (${per.dir}): ${done ? "done" : "TIMEOUT"} ${switchMs}ms 帧=${JSON.stringify(per.frame)} LT=${per.longtask.n}个 max=${per.longtask.maxMs}ms`);
    }

    // ---- f) 聚合 ---------------------------------------------------------------
    const aggBy = (name) => {
      const xs = row.perSwitch.filter((p) => p.toName === name);
      const allGaps = [];
      for (const p of xs) allGaps.push(p.frame);
      const sumFrames = xs.reduce((s, p) => s + p.frame.frames, 0);
      const sumOver50 = xs.reduce((s, p) => s + p.frame.over50, 0);
      const sumOver32 = xs.reduce((s, p) => s + p.frame.over32, 0);
      const p95s = xs.map((p) => p.frame.p95).sort((a, b) => a - b);
      const maxFrame = Math.max(0, ...xs.map((p) => p.frame.max));
      const lts = xs.reduce((s, p) => s + p.longtask.n, 0);
      const ltMax = Math.max(0, ...xs.map((p) => p.longtask.maxMs));
      const ltOver1000 = xs.reduce((s, p) => s + p.longtask.over1000, 0);
      return {
        to: name, n: xs.length,
        switchMsMedian: median(xs.map((p) => p.switchMs)),
        switchMsMax: Math.max(0, ...xs.map((p) => p.switchMs)),
        frameP95Median: p95s.length ? p95s[Math.floor(p95s.length / 2)] : 0,
        frameMax: maxFrame, framesTotal: sumFrames, over32: sumOver32, over50: sumOver50,
        longtaskN: lts, longtaskMaxMs: ltMax, longtaskOver1000: ltOver1000,
      };
    };
    row.agg = { [docA.name]: aggBy(docA.name), [docB.name]: aggBy(docB.name) };
    log(`聚合: ${JSON.stringify(row.agg, null, 1)}`);

    // ---- g) 收尾 -----------------------------------------------------------------
    try { cdp.close(); } catch { /* */ }
    cdp = null;
    const freed = await hardCleanup(child, (s) => log("  " + s));
    child = null;
    log(`收尾: 进程已杀，端口${freed ? "已释放" : "未释放"}`);
    if (!freed) exitCode = 3;

    appendFileSync(RESULTS_JSONL, JSON.stringify(row) + "\n", "utf8");
    log(`结果已落盘: ${RESULTS_JSONL}`);
    return (closeLog(), exitCode);
  } catch (e) {
    log("异常: " + (e?.stack || e));
    try { cdp && cdp.close(); } catch { /* */ }
    await hardCleanup(child, (s) => { try { writeSync(logFd, "  " + s + "\n"); } catch { /* */ } });
    return (closeLog(), 1);
  }

  function closeLog() { try { closeSync(logFd); } catch { /* */ } }
}

main().then((code) => process.exit(code ?? 0), (e) => { console.error("致命: " + (e?.stack || e)); process.exit(2); });
