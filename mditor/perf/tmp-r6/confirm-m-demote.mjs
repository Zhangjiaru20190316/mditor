// tmp-r6 一次性：M-d' 微滚验证——traverse 复现残留后，微滚 ±900px 让残留条目
// 离带再回带（IO 状态翻转），若残留归零则 IO 入队路径存活，漏渲染定罪于
// demote 竞态（回带不撤降级意图 + demote 不查带内 + IO 不再回调）。不入库。
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
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

const VP_SAMPLE = `(() => {
  const host = document.querySelector('.mditor-editor-host');
  const r = host.getBoundingClientRect(); let n = 0; const srcs = [];
  for (const el of document.querySelectorAll('.mditor-math-inline-lazy:not(.mditor-math-inline-ready)')) {
    const b = el.getBoundingClientRect();
    if (b.bottom > r.top && b.top < r.bottom) { n++; if (srcs.length < 8) srcs.push((el.textContent || '').slice(0, 30)); }
  }
  return { top: Math.round(host.scrollTop), n, srcs };
})()`;

async function main() {
  mkdirSync(FORENSICS_DIR, { recursive: true });
  const logFd = openSync(join(FORENSICS_DIR, "devlog-r6p-confirm.txt"), "w");
  const log = (m) => { try { writeSync(logFd, m + "\n"); } catch { /* */ } console.log(m); };
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  const holder = raw.settings ? raw : raw.value;
  holder.settings.devMode = false;
  holder.settings.bigDocViewport = true;
  holder.settings.bigDocPerformance = false;
  writeFileSync(STORE_PATH, JSON.stringify(raw, null, 2), "utf8");

  let child = null, cdp = null;
  const row = { steps: [] };
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
    // 开超限文档
    for (let i = 0; i < 40; i++) {
      const p = await cdp.eval(`(() => {
        const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes('唯一公式超限'));
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

    // 快速长滚到 ~36K 附近再回（复现窗口：与 traverse 探针同形态但缩短）
    let s = await readScroll();
    log(`初始 top=${s.top} h=${s.h} vh=${s.vh}`);
    const step = Math.round(s.vh * 0.9);
    let g = 0;
    while (s.top < 40000 && g++ < 200) { await wheel(step); s = await readScroll(); }
    log(`下滚至 top=${s.top}`);
    g = 0;
    while (s.top > 37000 && g++ < 200) { await wheel(-step); s = await readScroll(); }
    log(`微回至 top=${s.top}——停稳 8s`);
    await sleep(8000);
    row.steps.push({ phase: "post-scroll-quiet", sample: await cdp.eval(VP_SAMPLE) });
    log(`静止后: ${JSON.stringify(row.steps[0].sample)}`);
    // 微滚验证：+900（离带）→ 停 4s → -900（回带）→ 停 3s
    await wheel(900, 200); await sleep(4000);
    row.steps.push({ phase: "bump-down", sample: await cdp.eval(VP_SAMPLE) });
    await wheel(-900, 200); await sleep(3000);
    row.steps.push({ phase: "bump-back", sample: await cdp.eval(VP_SAMPLE) });
    for (const st of row.steps) log(`${st.phase}: top=${st.sample.top} unready=${st.sample.n} ${JSON.stringify(st.sample.srcs.slice(0, 3))}`);

    try { cdp.close(); } catch { /* */ }
    killChildTree(child); child = null;
    writeFileSync(join(RESULTS_DIR, "r6-phase2-confirm-m-demote.json"), JSON.stringify(row));
    log("落盘 r6-phase2-confirm-m-demote.json");
    return 0;
  } catch (e) {
    log("异常: " + (e?.stack || e));
    try { cdp && cdp.close(); } catch { /* */ }
    killChildTree(child);
    return 1;
  }
}
main().then((c) => process.exit(c ?? 0));
