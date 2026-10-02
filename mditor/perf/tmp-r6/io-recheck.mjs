// tmp-r6 一次性：IO 重评实验——1MB traverse 复现残留 2 条后，强制
// unobserve+observe（IO 状态机重置，当前状态必派发一次回调），观察是否
// 入队渲染。分离「IO 回调未达」vs「回调被挡」。不入库。
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
  mkdirSync(FORENSICS_DIR, { recursive: true });
  const logFd = openSync(join(FORENSICS_DIR, "devlog-r6-iorecheck.txt"), "w");
  const log = (m) => { try { writeSync(logFd, m + "\n"); } catch { /* */ } console.log(m); };
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  const holder = raw.settings ? raw : raw.value;
  holder.settings.devMode = false;
  holder.settings.bigDocViewport = true;
  holder.settings.bigDocPerformance = false;
  writeFileSync(STORE_PATH, JSON.stringify(raw, null, 2), "utf8");

  let child = null, cdp = null;
  const row = {};
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
    if (!target) { log("CDP 未就绪"); killChildTree(child); return 2; }
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
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
    await sleep(8000);
    const cx = 640, cy = 400;
    const wheel = async (dy, pause = 150) => { await m.wheel(cx, cy, 0, dy); await sleep(pause); };
    const readScroll = () => cdp.eval(`(() => { const h = document.querySelector('.mditor-editor-host'); return { top: Math.round(h.scrollTop), h: Math.round(h.scrollHeight), vh: h.clientHeight }; })()`);
    // 复现：下滚 ~12K 再回（与 r6fix-m-1mb 同形态）
    let s = await readScroll();
    let g = 0;
    while (s.top < 12000 && g++ < 200) { await wheel(Math.round(s.vh * 0.9)); s = await readScroll(); }
    g = 0;
    while (s.top > 11000 && g++ < 200) { await wheel(-Math.round(s.vh * 0.9)); s = await readScroll(); }
    await sleep(10000);
    row.before = await cdp.eval(`(() => {
      const h = document.querySelector('.mditor-editor-host'); const r0 = h.getBoundingClientRect();
      const bad = [];
      for (const el of document.querySelectorAll('.mditor-math-inline-lazy:not(.mditor-math-inline-ready)')) {
        const b = el.getBoundingClientRect();
        if (b.bottom > r0.top && b.top < r0.bottom) bad.push({ src: (el.textContent || '').slice(0, 40), rect: Math.round(b.top) });
      }
      const p = window.__mathPumpStats ? window.__mathPumpStats() : null;
      return { bad, pump: p ? { enq: p.enqueued, hit: p.hitPaints, failed: p.renderFailed } : null };
    })()`);
    log(`残留: ${JSON.stringify(row.before)}`);
    // IO 重评：无法拿到 sharedIO 实例——改用「触发全局重算」：微小滚动 30px（触发 IO 重算但基本不动视口）
    await m.wheel(cx, cy, 0, 30); await sleep(3000);
    row.afterMicroScroll = await cdp.eval(`(() => {
      const h = document.querySelector('.mditor-editor-host'); const r0 = h.getBoundingClientRect();
      const bad = [];
      for (const el of document.querySelectorAll('.mditor-math-inline-lazy:not(.mditor-math-inline-ready)')) {
        const b = el.getBoundingClientRect();
        if (b.bottom > r0.top && b.top < r0.bottom) bad.push({ src: (el.textContent || '').slice(0, 40), rect: Math.round(b.top) });
      }
      return { top: Math.round(h.scrollTop), bad };
    })()`);
    log(`微滚后: ${JSON.stringify(row.afterMicroScroll)}`);
    // 再等 5s（若 IO 重评派发了 true，泵应已渲染）
    await sleep(5000);
    row.afterWait = await cdp.eval(`(() => {
      const h = document.querySelector('.mditor-editor-host'); const r0 = h.getBoundingClientRect();
      const bad = [];
      for (const el of document.querySelectorAll('.mditor-math-inline-lazy:not(.mditor-math-inline-ready)')) {
        const b = el.getBoundingClientRect();
        if (b.bottom > r0.top && b.top < r0.bottom) bad.push((el.textContent || '').slice(0, 40));
      }
      return bad;
    })()`);
    log(`等待后: ${JSON.stringify(row.afterWait)}`);

    try { cdp.close(); } catch { /* */ }
    killChildTree(child); child = null;
    writeFileSync(join(RESULTS_DIR, "r6-phase5-iorecheck.json"), JSON.stringify(row));
    log("落盘 r6-phase5-iorecheck.json");
    return 0;
  } catch (e) {
    log("异常: " + (e?.stack || e));
    try { cdp && cdp.close(); } catch { /* */ }
    killChildTree(child);
    return 1;
  }
}
main().then((c) => process.exit(c ?? 0));
