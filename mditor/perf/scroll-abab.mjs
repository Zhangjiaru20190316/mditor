// scroll-abab.mjs —— 大文档滚动 ABAB 基准（单轮一 arm，供交错编排逐次调用）。
//
// 用法：
//   node perf/scroll-abab.mjs --doc <文件名子串> --viewport on|off --round N
//        [--devmode on] [--duration 秒(默认60)] [--tag 标签]
//   node perf/scroll-abab.mjs --selftest                 # D1 全流程 15s 门禁
//   node perf/scroll-abab.mjs --validate --expect '<JSON数组>'
//
// 职责（单轮）：
//   预检(端口占用→taskkill 硬清理) → 改 dev store(devMode/bigDocViewport，回读校验)
//   → 启动 tauri dev(日志落 .workflow/task2-forensics/devlog-*.txt) → CDP 就绪
//   → 文件树点击打开目标文档(重试3次) → 等渲染稳定 → 【arm 自证】
//   → 带密度统计的连续滚轮滚动(≥duration 秒，含 2-3 次快速往返)
//   → rAF 帧间隔/longtask 指标 → 杀进程+确认端口释放 → 结果追加 jsonl。
//
// arm 自证判据（DOM 层，见 bench-design.md）：
//   签名 A：.mditor-editor-host[data-big]（Editor.tsx:1259，cv 档挂载）存在与否
//   签名 B：远离视口的 .ProseMirror 顶层块 computed content-visibility 非 "visible"
//   签名 C：顶层块 inline style 含 contain-intrinsic-size（cvMemory decoration）
//   过线文档+viewport=on：A=true 且 B 非 visible 占比 ≥90%（容忍预热在飞批次 ≤10%）
//   过线文档+viewport=off：A=false 且 B 全 visible 且全树 inline cv:visible=0
//   不过线文档(D1)两 arm：同 off 判据（若非如此立即失败——宁缺毋滥）
//
// 红线遵守：不改任何 src/ 代码；bigDocPerformance 恒 false（减配档永不启用，
// 公式渲染保留）；不改既有 perf/ 文件。

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, writeSync, closeSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { findPageTarget, Cdp, mouse, sleep, LONGTASK_RECORDER } from "./cdp.mjs";

// ---------- 常量 / 路径 ------------------------------------------------------

const PORT = 9223;
const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..");
const REPO_ROOT = resolve(MDITOR_DIR, "..");
const FORENSICS_DIR = join(REPO_ROOT, ".workflow", "task2-forensics");
const RESULTS_JSONL = join(here, "results", "scroll-abab.jsonl");
const STORE_PATH = join(process.env.APPDATA ?? ".", "com.mditor.app.dev", "mditor.json");
const BIG_DOC_LINES = 3000;      // src/lib/memory.ts:75
const BIG_DOC_BYTES = 500_000;   // src/lib/memory.ts:76
const SELFTEST_DOC = "微分方程专题_CMC备战_基准副本"; // D1：1267 行/53KB，不过线

// ---------- 参数解析 ---------------------------------------------------------

function parseArgs(argv) {
  const a = {
    doc: null, viewport: null, round: null, devmode: false,
    duration: 60, tag: "run", selftest: false, validate: false, expect: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);
    if (k === "--doc") a.doc = next();
    else if (k === "--viewport") a.viewport = next();
    else if (k === "--round") a.round = next();
    else if (k === "--devmode") { const v = next(); if (v !== "on" && v !== "off") throw new Error("--devmode 只认 on|off"); a.devmode = v === "on"; }
    else if (k === "--duration") a.duration = Number(next());
    else if (k === "--tag") a.tag = next();
    else if (k === "--selftest") a.selftest = true;
    else if (k === "--validate") a.validate = true;
    else if (k === "--expect") a.expect = next();
    else throw new Error("未知参数: " + k);
  }
  if (Number.isNaN(a.duration) || a.duration < 5) throw new Error("--duration 必须 ≥5 秒");
  return a;
}

// ---------- 工具 -------------------------------------------------------------

/** 9223 端口是否已空闲（连接被拒 = 空闲）。 */
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

/** 1420（vite dev server）占用者 PID 列表（防 stale vite 供旧代码毁掉基准）。 */
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

/** 硬清理：npx 树(若有 child) + mditor.exe；等端口释放。返回 portFree。 */
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
    p50: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99),
    max: s.length ? Math.round(s[s.length - 1] * 10) / 10 : 0,
    over32: gaps.filter((g) => g > 32).length,
    over100: gaps.filter((g) => g > 100).length,
  };
}

function longtaskSummary(events) {
  if (!events.length) return { n: 0, totalMs: 0, maxMs: 0, over200: 0, top: [] };
  const sorted = [...events].sort((a, b) => b.d - a.d);
  return {
    n: events.length,
    totalMs: events.reduce((s2, e) => s2 + e.d, 0),
    maxMs: sorted[0].d,
    over200: events.filter((e) => e.d > 200).length,
    top: sorted.slice(0, 5).map((e) => ({ t: e.t, d: e.d })),
  };
}

function metricsComplete(m) {
  const f = m && m.frame, l = m && m.longtask;
  return !!(
    f && typeof f.frames === "number" && f.frames > 0 &&
    ["p50", "p90", "p95", "p99", "max", "over32", "over100"].every((k) => typeof f[k] === "number") &&
    l && typeof l.n === "number" && typeof l.totalMs === "number" && typeof l.maxMs === "number"
  );
}

// ---------- dev store 读写 ---------------------------------------------------

/** 改 dev 设置（须在 app 关闭时调用）。防御两种结构：{settings} / {value:{settings}}。 */
function editStore(viewportOn, devModeOn) {
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  let holder = null;
  if (raw && typeof raw === "object" && raw.settings && typeof raw.settings === "object") holder = raw;
  else if (raw && typeof raw.value === "object" && raw.value && raw.value.settings && typeof raw.value.settings === "object") holder = raw.value;
  else throw new Error("dev store 结构不认识，顶层键: " + JSON.stringify(Object.keys(raw ?? {})));
  holder.settings.devMode = devModeOn;
  holder.settings.bigDocViewport = viewportOn;
  holder.settings.bigDocPerformance = false; // 恒 false：绝不启用减配档（红线2）
  writeFileSync(STORE_PATH, JSON.stringify(raw, null, 2), "utf8");
  // 回读校验
  const back = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  const s = (back.settings ? back : back.value).settings;
  if (s.devMode !== devModeOn || s.bigDocViewport !== viewportOn || s.bigDocPerformance !== false) {
    throw new Error(`store 回读校验失败: devMode=${s.devMode} bigDocViewport=${s.bigDocViewport} bigDocPerformance=${s.bigDocPerformance}`);
  }
  return { workspaces: Array.isArray(raw.workspaces) ? raw.workspaces : [] };
}

/** 从 workspace 里按文件名子串解析目标文档（0 或 ≥2 个匹配都算失败）。 */
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
  const lines = text.split("\n").length;
  const bytes = Buffer.byteLength(text);
  return {
    path: hits[0], name: basename(hits[0]),
    lines, bytes,
    overThreshold: lines > BIG_DOC_LINES || bytes > BIG_DOC_BYTES,
  };
}

// ---------- 页内 evaluate 片段 -----------------------------------------------

/** 增强帧记录器（cdp.mjs 的 FRAME_RECORDER 只有 p50/p95，这里补 p90/p99/over32）。 */
const SFR_INSTALL = `(() => {
  if (window.__sfr) return 'already';
  window.__sfr = {
    gaps: [], _running: false, _raf: 0, _last: 0,
    start() { this.gaps = []; this._last = performance.now(); this._running = true;
      const tick = (t) => { if (!this._running) return; this.gaps.push(t - this._last); this._last = t; this._raf = requestAnimationFrame(tick); };
      this._raf = requestAnimationFrame(tick); },
    stop() { this._running = false; cancelAnimationFrame(this._raf); return { frames: this.gaps.length }; },
  };
  return 'installed';
})()`;

const SFR_STOP_COLLECT = `(() => {
  const r = window.__sfr; if (!r) return null;
  r._running = false; cancelAnimationFrame(r._raf);
  return r.gaps;
})()`;

/** arm 自证：data-big 签名 + 远离视口顶层块 computed content-visibility 采样。 */
const ARM_CHECK = `(() => {
  const host = document.querySelector('.mditor-editor-host');
  const pm = document.querySelector('.ProseMirror');
  if (!host || !pm) return { ok: false, why: 'no-host-or-pm' };
  const kids = [...pm.children].filter(el => !el.classList.contains('ProseMirror-widget'));
  if (!kids.length) return { ok: false, why: 'no-top-blocks' };
  const vh = innerHeight, MARGIN = 2500;
  // 远离视口块全量定位（cv:auto 块按 intrinsic size 回答 rect，不触发布局子树）
  const far = [];
  let near = 0;
  for (const el of kids) {
    const r = el.getBoundingClientRect();
    if (r.top > vh + MARGIN || r.bottom < -MARGIN) far.push(el); else near++;
  }
  const stride = Math.max(1, Math.ceil(far.length / 120)); // 采样 ≤120，散布全文档
  let sFar = 0, sVisible = 0, sAuto = 0, sInlineVisible = 0, sIntrinsic = 0;
  for (let i = 0; i < far.length; i += stride) {
    const el = far[i]; sFar++;
    const cv = getComputedStyle(el).contentVisibility;
    if (cv === 'visible') sVisible++;
    else if (cv === 'auto') sAuto++;
    const st = el.getAttribute('style') || '';
    if (/content-visibility\\s*:\\s*visible/i.test(st)) sInlineVisible++;
    if (/contain-intrinsic-size/i.test(st)) sIntrinsic++;
  }
  let inlineVisibleTotal = 0, intrinsicTotal = 0;
  for (const el of kids) {
    const st = el.getAttribute('style') || '';
    if (/content-visibility\\s*:\\s*visible/i.test(st)) inlineVisibleTotal++;
    if (/contain-intrinsic-size/i.test(st)) intrinsicTotal++;
  }
  return { ok: true, dataBig: host.hasAttribute('data-big'), totalTop: kids.length,
    farCount: far.length, nearCount: near, sampled: sFar,
    farVisible: sVisible, farAuto: sAuto, farInlineVisible: sInlineVisible, farIntrinsic: sIntrinsic,
    inlineVisibleTotal, intrinsicTotal };
})()`;

/** 密度统计：每 1000px 带内 .katex 与代码块(pre/.cm-editor) 数量（一次 evaluate）。 */
const DENSITY_SCAN = `(() => {
  const host = document.querySelector('.mditor-editor-host');
  const pm = document.querySelector('.ProseMirror');
  if (!host || !pm) return null;
  const kids = [...pm.children].filter(el => !el.classList.contains('ProseMirror-widget'));
  const BAND = 1000;
  const top = host.scrollTop;
  const nB = Math.max(1, Math.ceil((host.scrollHeight || 1) / BAND));
  const kB = new Array(nB).fill(0), cB = new Array(nB).fill(0);
  let katex = 0, code = 0;
  for (const el of kids) {
    const y = el.getBoundingClientRect().top + top;
    const b = Math.min(nB - 1, Math.max(0, Math.floor(y / BAND)));
    if (el.querySelector('.katex')) { const c = el.querySelectorAll('.katex').length; kB[b] += c; katex += c; }
    if (el.querySelector('pre, .cm-editor')) { const c = el.querySelectorAll('pre, .cm-editor').length; cB[b] += c; code += c; }
  }
  const topQuartile = (arr) => {
    const idx = arr.map((v, i) => [i, v]).sort((a, b) => b[1] - a[1]).filter(x => x[1] > 0);
    return idx.slice(0, Math.max(1, Math.ceil(nB * 0.15))).map(x => x[0]);
  };
  return { bandPx: BAND, nBands: nB, scrollHeight: host.scrollHeight,
    katexTotal: katex, codeTotal: code, denseBands: topQuartile(kB), codeBands: topQuartile(cB) };
})()`;

const SCROLL_TOP_READ = `document.querySelector('.mditor-editor-host')?.scrollTop ?? 0`;

// ---------- 主流程 -----------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ---- --validate：只对 jsonl 做完备性校验，不起 app --------------------------
  if (args.validate) return cmdValidate(args);

  // ---- --selftest：D1 + duration 15 + 完整启停 --------------------------------
  let docArg = args.doc, viewportArg = args.viewport, roundArg = args.round;
  let durationS = args.duration, tag = args.tag, devModeOn = args.devmode;
  if (args.selftest) {
    docArg = SELFTEST_DOC; viewportArg = "off"; roundArg = "selftest";
    durationS = 15; tag = "selftest"; devModeOn = false;
  }
  if (!docArg || !viewportArg || roundArg == null) {
    console.error("用法: --doc <子串> --viewport on|off --round N [--devmode on] [--duration 秒] [--tag 标签] | --selftest | --validate --expect <JSON>");
    return 2;
  }
  if (viewportArg !== "on" && viewportArg !== "off") {
    console.error("--viewport 只认 on|off"); return 2;
  }
  const viewportOn = viewportArg === "on";

  mkdirSync(FORENSICS_DIR, { recursive: true });
  mkdirSync(dirname(RESULTS_JSONL), { recursive: true });
  const devlogPath = join(FORENSICS_DIR, `devlog-${sanitize(tag)}-${sanitize(docArg)}-${sanitize(roundArg)}.txt`);
  const logFd = openSync(devlogPath, "w");
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    writeSync(logFd, line); console.log(msg);
  };

  let child = null, cdp = null;
  const row = {
    ts: new Date().toISOString(), tag, doc: docArg, viewport: viewportArg,
    devMode: devModeOn, round: roundArg, durationS, armValidated: false,
    bootS: null, openS: null, metrics: null,
  };
  let exitCode = 0;

  try {
    // ---- a) 预检：端口占用 → 硬清理；改 store；解析文档体量 -------------------
    if (!(await portFree())) {
      log(`预检: 端口 ${PORT} 被占，执行硬清理 taskkill /F /IM mditor.exe`);
      const freed = await hardCleanup(null, (m) => log("  " + m));
      if (!freed) { log("预检失败: 硬清理后端口仍被占"); return (closeLog(), 2); }
    }
    log(`预检: 端口 ${PORT} 空闲`);
    const stale = vitePortPids();
    if (stale.length) {
      // 宁缺毋滥：stale vite 会让 app 加载旧代码（tauri.dev.conf.json 的 devUrl 钉在 1420），
      // 基准测到的是过期构建 → 本轮作废，报出 PID 让操作者定向清理（不误杀任意 node）。
      log(`预检失败: 端口 1420 被残留 vite 占用（PID ${stale.join(", ")}），请 taskkill //F //PID <pid> 后重跑`);
      return (closeLog(), 2);
    }
    const { workspaces } = editStore(viewportOn, devModeOn);
    log(`store 已改并回读校验: devMode=${devModeOn} bigDocViewport=${viewportOn} bigDocPerformance=false`);
    const docInfo = resolveDocFile(workspaces, docArg);
    log(`目标文档: ${docInfo.name} lines=${docInfo.lines} bytes=${docInfo.bytes} 过线=${docInfo.overThreshold}（阈值 >${BIG_DOC_LINES} 行或 >${BIG_DOC_BYTES}B）`);

    // ---- b) 启动 tauri dev，日志落盘，轮询 CDP（超时 120s） -------------------
    const spawnAt = Date.now();
    child = spawn("cmd.exe", ["/c", "npx", "tauri", "dev", "--config", "src-tauri/tauri.dev.conf.json"], {
      cwd: MDITOR_DIR,
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let childDied = null;
    child.on("exit", (code2, sig) => { childDied = { code: code2, sig }; });
    const pipe = (stream, prefix) => stream.on("data", (d) => {
      try { writeSync(logFd, d); } catch { /* 盘满等极端情况不中断 */ }
    });
    pipe(child.stdout, "out"); pipe(child.stderr, "err");
    log(`tauri dev 已启动 pid=${child.pid}，等待 CDP ${PORT}（上限 120s）`);

    let target = null;
    {
      const deadline = spawnAt + 120_000;
      while (Date.now() < deadline) {
        if (childDied) { log(`启动失败: tauri dev 提前退出 code=${childDied.code} sig=${childDied.sig}（详见 ${devlogPath}）`); return (closeLog(), 2); }
        try {
          const res = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(700) });
          const list = await res.json();
          const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
          if (page) { target = page; break; }
        } catch { /* 未就绪 */ }
        await sleep(500);
      }
      if (!target) { log("启动失败: 120s 内 CDP 未就绪（详见 devlog）"); return (closeLog(), 2); }
    }
    row.bootS = Math.round((Date.now() - spawnAt) / 100) / 10;
    log(`CDP 就绪 bootS=${row.bootS} target=${target.url}`);

    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const m = mouse(cdp);

    // 等编辑器壳就绪
    for (let i = 0; i < 120; i++) {
      if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break;
      if (i === 119) { log("失败: 60s 内 .ProseMirror 未出现"); return (closeLog(), 2); }
      await sleep(500);
    }
    await cdp.eval(LONGTASK_RECORDER);
    await cdp.eval(SFR_INSTALL);
    const win = await cdp.eval(`({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})`);

    // ---- c) 文件树点击打开（重试 3 次），等渲染稳定 ----------------------------
    const wantPath = docInfo.path.replaceAll("\\", "/").toLowerCase();
    const wantName = docInfo.name.toLowerCase();
    const settleTimeoutMs = 30_000 + Math.min(90_000, Math.round(docInfo.bytes / 20_000));
    let opened = false, openMs = 0;
    for (let attempt = 1; attempt <= 3 && !opened; attempt++) {
      let rowPos = null;
      for (let i = 0; i < 30 && !rowPos; i++) {
        rowPos = await cdp.eval(`(() => {
          const rows = [...document.querySelectorAll('.ft-row.ft-file')];
          const hit = rows.find(r => {
            const p = (r.getAttribute('data-path') || '').replaceAll('\\\\', '/').toLowerCase();
            const n = (r.querySelector('.ft-name')?.textContent || '').toLowerCase();
            return p.endsWith(${JSON.stringify("/" + wantName)}) || p === ${JSON.stringify(wantPath)} || n.includes(${JSON.stringify(wantName)});
          });
          if (!hit) return null;
          const r = hit.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), name: hit.querySelector('.ft-name')?.textContent };
        })()`);
        if (!rowPos) await sleep(500);
      }
      if (!rowPos) { log(`打开尝试 ${attempt}/3: 文件树找不到 ${docInfo.name}`); continue; }
      const t0 = Date.now();
      await m.click(rowPos.x, rowPos.y);
      // 稳定判据：PM 子元素数连续 2s 不变（4×500ms 轮询）且 ≥30 块，且目标行 ft-active
      let lastCount = -1, stable = 0, settled = false;
      while (Date.now() - t0 < settleTimeoutMs) {
        await sleep(500);
        const n = await cdp.eval(`document.querySelector('.ProseMirror').children.length`);
        if (n >= 30 && n === lastCount) { if (++stable >= 4) { settled = true; break; } } else stable = 0;
        lastCount = n;
      }
      const activeOk = await cdp.eval(`(() => {
        const act = document.querySelector('.ft-row.ft-file.ft-active');
        if (!act) return false;
        const p = (act.getAttribute('data-path') || '').replaceAll('\\\\', '/').toLowerCase();
        return p.endsWith(${JSON.stringify("/" + wantName)});
      })()`);
      if (settled && activeOk) {
        openMs = Date.now() - t0; opened = true;
        row.openS = Math.round(openMs / 100) / 10;
        log(`文档已打开并稳定: openS=${row.openS}（尝试 ${attempt}）`);
      } else {
        log(`打开尝试 ${attempt}/3 失败: settled=${settled} ftActive=${activeOk}`);
      }
    }
    if (!opened) { log("失败: 3 次尝试均未打开目标文档"); return (closeLog(), 2); }
    await sleep(1500); // 首开余波（预热调度 delay 350ms + 余量）落定

    // ---- 预热等待：cv 档过线文档才需要（prewarm 完成 → arm 判据不受在飞批次干扰）
    let prewarm = { waited: false, done: null, waitS: 0 };
    if (viewportOn && docInfo.overThreshold) {
      const capMs = 45_000 + Math.min(105_000, Math.round(docInfo.bytes / 15_000));
      const t0 = Date.now();
      while (Date.now() - t0 < capMs) {
        const c = await cdp.eval(`window.__scrollDebug ? window.__scrollDebug.counters() : null`);
        if (c && (c["prewarm.done"] || c["prewarm.abort"])) { prewarm.done = c["prewarm.done"] ? "done" : "abort"; break; }
        await sleep(1000);
      }
      prewarm.waited = true;
      prewarm.waitS = Math.round((Date.now() - t0) / 100) / 10;
      log(`预热等待: ${prewarm.done ?? "超时"} waitS=${prewarm.waitS}（上限 ${Math.round(capMs / 1000)}s）`);
    }

    // ---- d) arm 自证（关键门禁）----------------------------------------------
    const ev = await cdp.eval(ARM_CHECK);
    const farNonVisibleRatio = ev.sampled ? (ev.sampled - ev.farVisible) / ev.sampled : 0;
    let armReason = "";
    if (docInfo.overThreshold && viewportOn) {
      if (!ev.dataBig) armReason = "过线+on 但 host 无 data-big";
      else if (farNonVisibleRatio < 0.9) armReason = `远处块非 visible 占比 ${(farNonVisibleRatio * 100).toFixed(1)}% <90%（含预热在飞批次的 10% 容忍）`;
      else if (ev.intrinsicTotal === 0) armReason = "过线+on 但无任何 contain-intrinsic-size decoration（cvMemory 未生效）";
    } else {
      // off 档（任意体量）与 D1 两档：必须全 visible、无 data-big、无 inline cv
      if (ev.dataBig) armReason = `${docInfo.overThreshold ? "过线" : "不过线"}+${viewportArg} 但 host 带 data-big`;
      else if (ev.sampled > 0 && ev.farVisible !== ev.sampled) armReason = `远处块存在非 visible: ${ev.sampled - ev.farVisible}/${ev.sampled}`;
      else if (ev.inlineVisibleTotal !== 0) armReason = `全树 inline content-visibility:visible 共 ${ev.inlineVisibleTotal} 处`;
    }
    row.armValidated = armReason === "";
    log(`arm 自证: dataBig=${ev.dataBig} 顶层块=${ev.totalTop} 远处=${ev.farCount} 采样=${ev.sampled} farVisible=${ev.farVisible} farAuto=${ev.farAuto} intrinsic=${ev.intrinsicTotal} → ${row.armValidated ? "PASS" : "FAIL: " + armReason}`);
    if (!row.armValidated) exitCode = 1; // 宁缺毋滥：arm 失败本轮作废（仍走收尾杀进程）

    // ---- e) 带密度统计的滚动场景（≥duration 秒）-------------------------------
    const dens = await cdp.eval(DENSITY_SCAN);
    log(`密度统计: bands=${dens.nBands} katex=${dens.katexTotal} code=${dens.codeTotal} 密集带(k)=${JSON.stringify(dens.denseBands)} 代码带=${JSON.stringify(dens.codeBands)}`);

    const cx = Math.round(win.w / 2), cy = Math.round(win.h / 2);
    const denseSet = new Set([...(dens.denseBands ?? []), ...(dens.codeBands ?? [])]);
    await cdp.eval(`(() => { const h = document.querySelector('.mditor-editor-host'); if (h) h.scrollTop = 0; })()`);
    await sleep(400);
    await cdp.eval("window.__ltRecorder.start()");
    await cdp.eval("window.__sfr.start()");

    const durationMs = durationS * 1000;
    const tScroll0 = Date.now();
    const nRt = Math.max(2, Math.min(3, Math.round(durationS / 25)));
    let roundTrips = 0, nextRtAt = durationMs / (nRt + 1);
    let ticks = 0, denseTicks = 0, lastTop = 0;
    const jump = async (expr) => { await cdp.eval(`(() => { const h = document.querySelector('.mditor-editor-host'); if (h) h.scrollTop = ${expr}; })()`); };
    while (Date.now() - tScroll0 < durationMs) {
      const elapsed = Date.now() - tScroll0;
      if (elapsed >= nextRtAt && roundTrips < nRt) {
        roundTrips++;
        nextRtAt = (durationMs / (nRt + 1)) * (roundTrips + 1);
        // 快速往返：跳底 → 驻留 → 跳顶 → 驻留 → 跳中 → 驻留
        await jump(`h.scrollHeight`); await sleep(700);
        await jump(`0`); await sleep(700);
        await jump(`Math.floor(h.scrollHeight / 2 - h.clientHeight / 2)`); await sleep(700);
        continue;
      }
      if (ticks % 6 === 0) lastTop = await cdp.eval(SCROLL_TOP_READ);
      const band = Math.floor(lastTop / (dens.bandPx ?? 1000));
      const dense = denseSet.has(band);
      if (dense) denseTicks++;
      await m.wheel(cx, cy, 0, dense ? 240 : 400); // 密集带慢滚驻留，稀疏带快滚
      await sleep(dense ? 150 : 70);
      ticks++;
    }
    const actualS = Math.round((Date.now() - tScroll0) / 100) / 10;

    // ---- f) 指标 -------------------------------------------------------------
    const gaps = await cdp.eval(SFR_STOP_COLLECT);
    const lt = await cdp.eval("window.__ltRecorder.stop()");
    const finalTop = await cdp.eval(SCROLL_TOP_READ);
    row.metrics = {
      frame: percentileSummary(gaps ?? []),
      longtask: longtaskSummary(lt?.events ?? []),
      scroll: { ticks, denseTicks, roundTrips, finalTopPx: finalTop, actualS, win },
      armEvidence: { ...ev, farNonVisibleRatio: Math.round(farNonVisibleRatio * 1000) / 1000 },
      prewarm,
      doc: { name: docInfo.name, lines: docInfo.lines, bytes: docInfo.bytes, overThreshold: docInfo.overThreshold },
    };
    log(`指标: frame=${JSON.stringify(row.metrics.frame)} longtask=${JSON.stringify(row.metrics.longtask)} ticks=${ticks} dense=${denseTicks} rt=${roundTrips} actualS=${actualS}`);
    if (!metricsComplete(row.metrics)) {
      log("失败: metrics 不完整（frame.frames=" + row.metrics.frame.frames + "）");
      exitCode = 1;
    }

    // ---- g) 收尾：杀进程 + 端口释放 + 结果落盘 -------------------------------
    try { cdp.close(); } catch { /* already */ }
    cdp = null;
    const freed = await hardCleanup(child, (s) => log("  " + s));
    child = null;
    log(`收尾: 进程已杀，端口${freed ? "已释放" : "未释放(15s)"}`);
    if (!freed) exitCode = 3;

    row.durationS = actualS;
    appendFileSync(RESULTS_JSONL, JSON.stringify(row) + "\n", "utf8");
    log(`结果已落盘: ${RESULTS_JSONL} armValidated=${row.armValidated}`);

    if (args.selftest) {
      const ok = selftestVerify(row.ts);
      log(`selftest: ${ok ? "PASS（结果行落盘 + armValidated=true + metrics 完整）" : "FAIL"}`);
      return ok ? (closeLog(), 0) : (closeLog(), 1);
    }
    return (closeLog(), exitCode);
  } catch (e) {
    log("异常: " + (e?.stack || e));
    try { cdp && cdp.close(); } catch { /* */ }
    await hardCleanup(child, (s) => { try { writeSync(logFd, "  " + s + "\n"); } catch { /* */ } });
    return (closeLog(), 1);
  }

  function closeLog() { try { closeSync(logFd); } catch { /* */ } }
}

/** selftest 成功标准：本 ts 的行在 jsonl 中 armValidated=true 且 metrics 完整。 */
function selftestVerify(ts) {
  if (!existsSync(RESULTS_JSONL)) return false;
  const rows = readFileSync(RESULTS_JSONL, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const mine = rows.filter((r) => r.ts === ts);
  return mine.length === 1 && mine[0].armValidated === true && metricsComplete(mine[0].metrics);
}

// ---- --validate --------------------------------------------------------------
function cmdValidate(args) {
  if (!args.expect) { console.error("--validate 需要 --expect <JSON数组>"); return 2; }
  let expect;
  try { expect = JSON.parse(args.expect); } catch (e) { console.error("--expect JSON 解析失败: " + e.message); return 2; }
  if (!Array.isArray(expect)) { console.error("--expect 必须是数组"); return 2; }
  if (!existsSync(RESULTS_JSONL)) {
    if (expect.length === 0) { console.log("validate OK: expect 为空"); return 0; }
    console.error(`缺少: 全部 ${expect.length} 项（jsonl 不存在）`);
    return 1;
  }
  const rows = readFileSync(RESULTS_JSONL, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const missing = [], dup = [];
  for (const e of expect) {
    if (typeof e.doc !== "string" || !e.viewport || e.round == null) { console.error("expect 项缺字段: " + JSON.stringify(e)); return 2; }
    const hits = rows.filter((r) =>
      r.doc === e.doc && r.viewport === String(e.viewport).toLowerCase() &&
      String(r.round) === String(e.round) && r.devMode !== true && r.armValidated === true);
    if (hits.length === 0) missing.push(e);
    else if (hits.length > 1) dup.push({ ...e, count: hits.length });
  }
  if (missing.length || dup.length) {
    console.error("validate FAIL");
    for (const e of missing) console.error(`  缺少: doc=${e.doc} viewport=${e.viewport} round=${e.round}（无 armValidated=true 的非 devMode 行）`);
    for (const e of dup) console.error(`  重复: doc=${e.doc} viewport=${e.viewport} round=${e.round} 有 ${e.count} 条 armValidated=true 行（须恰有一条）`);
    return 1;
  }
  console.log(`validate OK: ${expect.length}/${expect.length} 项各有恰一条 armValidated=true 行（devMode 轮已排除）`);
  return 0;
}

main().then((code) => process.exit(code ?? 0), (e) => { console.error("致命: " + (e?.stack || e)); process.exit(2); });
