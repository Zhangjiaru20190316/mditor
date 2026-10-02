// tmp-r6 一次性：量化 bench 采样器自身成本——querySelectorAll('.mditor-math-inline-lazy')
// + 全量 getBoundingClientRect 在 1MB 档的耗时（判定第五轮 f4 帧口径是否被
// 测量器污染）。不入库。
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Cdp, mouse, sleep } from "../cdp.mjs";

const PORT = 9223;
const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..", "..");
const FORENSICS_DIR = resolve(MDITOR_DIR, "..", ".workflow", "task2-forensics");
const STORE_PATH = join(process.env.APPDATA ?? ".", "com.mditor.app.dev", "mditor.json");

async function portFree(port = PORT) {
  try { await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(700) }); return false; } catch { return true; }
}
function run(cmd, args) { spawnSync(cmd, args, { stdio: "ignore", windowsHide: true }); }
function killChildTree(child) { try { if (child && child.pid) run("taskkill", ["/F", "/T", "/PID", String(child.pid)]); } catch { /* */ } }

async function main() {
  mkdirSync(FORENSICS_DIR, { recursive: true });
  const logFd = openSync(join(FORENSICS_DIR, "devlog-r6-recost.txt"), "w");
  const log = (m) => { try { writeSync(logFd, m + "\n"); } catch { /* */ } console.log(m); };
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  const holder = raw.settings ? raw : raw.value;
  holder.settings.devMode = false;
  holder.settings.bigDocViewport = true;
  holder.settings.bigDocPerformance = false;
  writeFileSync(STORE_PATH, JSON.stringify(raw, null, 2), "utf8");

  let child = null, cdp = null;
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
    try { await cdp.send("Page.enable"); await cdp.send("Page.bringToFront"); } catch {}
    const m = mouse(cdp);
    for (let i = 0; i < 120; i++) { if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break; await sleep(500); }
    for (let i = 0; i < 40; i++) {
      const p = await cdp.eval(`(() => {
        const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes('1MB压测'));
        if (!hit) return null; const r = hit.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (p) { await m.click(p.x, p.y); break; }
      await sleep(500);
    }
    await sleep(10000);
    // 滚到中部（有 lazy 元素在 DOM），静止后测三轮采样器成本
    for (let i = 0; i < 10; i++) { await m.wheel(640, 400, 0, 400); await sleep(150); }
    await sleep(3000);
    await cdp.eval(`(() => { window.__fps = { n: 0, last: 0, long: 0 }; const t = (ts) => { if (window.__fps.last) { const g = ts - window.__fps.last; window.__fps.n++; if (g > 50) window.__fps.long++; } window.__fps.last = ts; requestAnimationFrame(t); }; requestAnimationFrame(t); })()`);
    await sleep(5000);
    const fps = await cdp.eval(`window.__fps`);
    log(`独立rAF帧率(5s): ${JSON.stringify(fps)}`);
    const cost = await cdp.eval(`(() => {
      const out = { lazyCount: -1, qsaMs: [], fullMs: [], rafGaps: [] };
      // 1) querySelectorAll 成本
      for (let i = 0; i < 2; i++) {
        const t0 = performance.now();
        const els = document.querySelectorAll('.mditor-math-inline-lazy');
        out.qsaMs.push(Math.round(performance.now() - t0));
        out.lazyCount = els.length;
      }
      // 2) qsa + 全量 rect（bench REC 每帧做的事）
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const els = document.querySelectorAll('.mditor-math-inline-lazy');
        let vis = 0;
        for (const el of els) { const r = el.getBoundingClientRect(); if (r.bottom > 0 && r.top < 800) vis++; }
        out.fullMs.push(Math.round(performance.now() - t0));
        out.vis = vis;
      }
      return out;
    })()`);
    log(`成本: ${JSON.stringify(cost)}`);
    writeFileSync(join(MDITOR_DIR, "perf", "results", "r6-phase3-recost.json"), JSON.stringify(cost));
    try { cdp.close(); } catch { /* */ }
    killChildTree(child); child = null;
    return 0;
  } catch (e) {
    log("异常: " + (e?.stack || e));
    try { cdp && cdp.close(); } catch { /* */ }
    killChildTree(child);
    return 1;
  }
}
main().then((c) => process.exit(c ?? 0));
