// tmp-r6 一次性：泵轨迹探针——upscroll 场景下每 300ms 采样 __mathPumpStats
// （queueDepth/hitPaints/coldRenders/deferred）+ 视口未 ready 数 + 帧间隔。
// 归因用：滚动中占位等待的主通路（命中直绘清得动 vs 冷算堵队）。不入库。
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Cdp, mouse, sleep } from "../cdp.mjs";

const PORT = 9223;
const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..", "..");
const FORENSICS_DIR = resolve(MDITOR_DIR, "..", ".workflow", "task2-forensics");
const RESULTS_DIR = join(MDITOR_DIR, "perf", "results");
const STORE_PATH = join(process.env.APPDATA ?? ".", "com.mditor.app.dev", "mditor.json");

async function portFree(port = PORT) {
  try { await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(700) }); return false; } catch { return true; }
}
function run(cmd, args) { spawnSync(cmd, args, { stdio: "ignore", windowsHide: true }); }
function killChildTree(child) { try { if (child && child.pid) run("taskkill", ["/F", "/T", "/PID", String(child.pid)]); } catch { /* */ } }

async function main() {
  const doc = process.argv[2] ?? "1MB压测";
  const tag = process.argv[3] ?? "r6pt";
  mkdirSync(FORENSICS_DIR, { recursive: true });
  const logFd = openSync(join(FORENSICS_DIR, `devlog-r6pt-${tag}.txt`), "w");
  const log = (m) => { try { writeSync(logFd, m + "\n"); } catch { /* */ } console.log(m); };
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  const holder = raw.settings ? raw : raw.value;
  holder.settings.devMode = false;
  holder.settings.bigDocViewport = true;
  holder.settings.bigDocPerformance = false;
  writeFileSync(STORE_PATH, JSON.stringify(raw, null, 2), "utf8");

  let child = null, cdp = null;
  const row = { doc, tag, trace: [] };
  try {
    if (!(await portFree())) { log("9223 被占"); return 2; }
    child = spawn("cmd.exe", ["/c", "npx", "tauri", "dev", "--config", "src-tauri/tauri.dev.conf.json"], {
      cwd: MDITOR_DIR, env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    for (const s of [child.stdout, child.stderr]) s.on("data", (d) => { try { writeSync(logFd, d); } catch { /* */ } });
    let target = null;
    const spawnAt = Date.now();
    while (Date.now() - spawnAt < 150_000) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(700) });
        const page = (await res.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) { target = page; break; }
      } catch { /* */ }
      await sleep(500);
    }
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const m = mouse(cdp);
    for (let i = 0; i < 120; i++) { if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break; await sleep(500); }
    for (let i = 0; i < 40; i++) {
      const p = await cdp.eval(`(() => {
        const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes(${JSON.stringify(doc)}));
        if (!hit) return null; const r = hit.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (p) { await m.click(p.x, p.y); break; }
      await sleep(500);
    }
    await sleep(8000);
    // 帧间隔打点（页内 rAF 计数）
    await cdp.eval(`(() => { window.__f = { n: 0, last: 0, long: 0, sum: 0 };
      const t = (ts) => { if (window.__f.last) { const g = ts - window.__f.last; window.__f.n++; window.__f.sum += g; if (g > 50) window.__f.long++; } window.__f.last = ts; requestAnimationFrame(t); };
      requestAnimationFrame(t); })()`);
    const cx = 640, cy = 400;
    const wheel = async (dy, pause = 180) => { await m.wheel(cx, cy, 0, dy); await sleep(pause); };
    const sample = () => cdp.eval(`(() => {
      const p = typeof window.__mathPumpStats === 'function' ? window.__mathPumpStats() : null;
      const h = document.querySelector('.mditor-editor-host');
      const r = h.getBoundingClientRect(); let n = 0;
      for (const el of document.querySelectorAll('.mditor-math-inline-lazy:not(.mditor-math-inline-ready)')) {
        const b = el.getBoundingClientRect(); if (b.bottom > r.top && b.top < r.bottom) n++;
      }
      const f = window.__f;
      return { t: Math.round(performance.now()), vpUnready: n,
        q: p ? p.queueDepth : -1, hit: p ? p.hitPaints : -1, cold: p ? p.coldRenders : -1,
        def: p ? p.deferred : -1, sf: p ? p.scrollFrames : -1, qf: p ? p.quietFrames : -1,
        fn: f.n, flong: f.long };
    })()`);
    // 开档即滚形态（不复置 25s 预热窗——拖尾主场景含首开争用）与 bench 形态（滚前预热完）各测一段
    row.trace.push({ phase: "pre", ...(await sample()) });
    // 段A：开档即滚（下滚 20 步 + 上滚 10 步）
    for (let i = 0; i < 5; i++) { row.trace.push({ phase: "A-scroll", ...(await sample()) }); for (let k = 0; k < 4; k++) await wheel(300); }
    for (let i = 0; i < 5; i++) { row.trace.push({ phase: "A-up", ...(await sample()) }); for (let k = 0; k < 2; k++) await wheel(-300); }
    for (let i = 0; i < 10; i++) { await sleep(300); row.trace.push({ phase: "A-quiet", ...(await sample()) }); }
    // 段B：静置 25s（预热完成窗）后重复
    await sleep(25000);
    for (let k = 0; k < 6; k++) await wheel(-300);
    for (let i = 0; i < 5; i++) { row.trace.push({ phase: "B-scroll", ...(await sample()) }); for (let k = 0; k < 4; k++) await wheel(300); }
    for (let i = 0; i < 5; i++) { row.trace.push({ phase: "B-up", ...(await sample()) }); for (let k = 0; k < 2; k++) await wheel(-300); }
    for (let i = 0; i < 10; i++) { await sleep(300); row.trace.push({ phase: "B-quiet", ...(await sample()) }); }
    for (const t of row.trace.filter((x) => x.phase !== "pre").slice(0, 100)) log(JSON.stringify(t));

    try { cdp.close(); } catch { /* */ }
    killChildTree(child); child = null;
    writeFileSync(join(RESULTS_DIR, `r6-phase3-pumptrace-${tag}.json`), JSON.stringify(row));
    log("落盘 r6-phase3-pumptrace-" + tag + ".json");
    return 0;
  } catch (e) {
    log("异常: " + (e?.stack || e));
    try { cdp && cdp.close(); } catch { /* */ }
    killChildTree(child);
    return 1;
  }
}
main().then((c) => process.exit(c ?? 0));
