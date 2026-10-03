// exp-lockbox.mjs —— R7 阶段五前置原型：demote 锁盒占位的行高中性性验证（一次性，不入库）
//
// 假设：demote 回占位时若把占位 span 锁成渲染态盒尺寸（inline-block,
// width=W, min-height=H, white-space:nowrap，源码文本保留、溢出可见），
// 则段落折行与行高不变（demote 高度中性 → 漂移消失）。
// 验证：真实 dev 实例中对视口内已渲染公式逐个替换为锁盒占位（变体 A 纯锁盒 /
// B 锁盒+vertical-align 校正 / C overflow:hidden+bottom），量替换前后
// 所在段落块 offsetHeight 差。|Δ|≤1px 视为中性。
// 用法：node perf/tmp-r7/exp-lockbox.mjs --variant A|B|C [--n 30] [--tag r7proto]

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
  const a = { variant: "A", n: 30, tag: "r7proto", doc: "无穷级数_密度档" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; const next = () => (i + 1 < argv.length ? argv[++i] : null);
    if (k === "--variant") a.variant = next();
    else if (k === "--n") a.n = Number(next() ?? 30);
    else if (k === "--tag") a.tag = next();
    else if (k === "--doc") a.doc = next();
  }
  return a;
}
async function portFree(port = PORT) { try { await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(700) }); return false; } catch { return true; } }
function run(cmd, args) { spawnSync(cmd, args, { stdio: "ignore", windowsHide: true }); }
function killChildTree(child) { try { if (child && child.pid) run("taskkill", ["/F", "/T", "/PID", String(child.pid)]); } catch { /* */ } }
function editStore() {
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  const holder = raw.settings ? raw : raw.value;
  holder.settings.devMode = false; holder.settings.bigDocViewport = true; holder.settings.bigDocPerformance = false;
  if ("typewriterMode" in holder.settings) holder.settings.typewriterMode = false;
  writeFileSync(STORE_PATH, JSON.stringify(raw, null, 2), "utf8");
  return raw.workspaces ?? [];
}
function findDoc(workspaces, sub) {
  for (const ws of workspaces) { try { for (const e of readdirSync(ws, { recursive: true })) { const n = basename(String(e)); if (n.toLowerCase().includes(sub.toLowerCase()) && n.endsWith(".md")) return join(ws, String(e)); } } catch { /* */ } }
  return null;
}

// 原型实验（页内）：对视口内 ready 公式逐个：量父块高 → 替换锁盒 → 量父块高 → 恢复。
// ignoreMutation 使 PM 不感知 DOM 改动；恢复用暂存的原始 outerHTML + style/class。
const LOCKBOX_EXP = (variant, n) => `(() => {
  const host = document.querySelector('.mditor-editor-host');
  const pm = host && host.querySelector('.ProseMirror');
  if (!pm) return null;
  const hr = host.getBoundingClientRect();
  const ready = [...pm.querySelectorAll('.mditor-math-inline-lazy.mditor-math-inline-ready')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > hr.top && r.top < hr.bottom;
  }).slice(0, ${n});
  const results = [];
  for (const el of ready) {
    const block = el.closest('.ProseMirror > *');
    if (!block) continue;
    const r = el.getBoundingClientRect();
    const w = Math.round(r.width * 10) / 10, h = Math.round(r.height * 10) / 10;
    const src = el.dataset.value || el.textContent || '';
    const html = el.innerHTML, cls = el.className, css = el.style.cssText;
    const before = block.offsetHeight;
    // —— 替换为锁盒占位 ——
    el.innerHTML = '';
    el.textContent = src;
    el.className = 'mditor-math-inline-lazy';
    if (${JSON.stringify(variant)} === 'A') {
      el.style.cssText = 'display:inline-block;width:' + w + 'px;min-height:' + h + 'px;white-space:nowrap;';
    } else if (${JSON.stringify(variant)} === 'B') {
      // 校正：把盒内文本 baseline 上移到渲染态位置（近似：下移量 = (h - 文本行高)/2 不精确，先取 bottom 校正对照）
      el.style.cssText = 'display:inline-block;width:' + w + 'px;min-height:' + h + 'px;white-space:nowrap;vertical-align:bottom;';
    } else {
      el.style.cssText = 'display:inline-block;width:' + w + 'px;height:' + h + 'px;white-space:nowrap;overflow:hidden;vertical-align:bottom;';
    }
    const during = block.offsetHeight;
    const rect2 = el.getBoundingClientRect();
    // —— 恢复 ——
    el.innerHTML = html; el.className = cls; el.style.cssText = css;
    const after = block.offsetHeight;
    results.push({ src: src.slice(0, 24), w, h, before, during, after, d: during - before, boxH: Math.round(rect2.height * 10) / 10 });
  }
  const ds = results.map((x) => Math.abs(x.d));
  const neutral = results.filter((x) => Math.abs(x.d) <= 1).length;
  return { variant: ${JSON.stringify(variant)}, count: results.length, neutral, maxAbsD: Math.max(0, ...ds),
    sumD: results.reduce((s, x) => s + x.d, 0), results: results.slice(0, 40) };
})()`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(FORENSICS_DIR, { recursive: true }); mkdirSync(RESULTS_DIR, { recursive: true });
  const logFd = openSync(join(FORENSICS_DIR, `devlog-r7-lockbox-${args.tag}-${args.variant}.txt`), "w");
  const log = (m) => { try { writeSync(logFd, m + "\n"); } catch { /* */ } console.log(m); };
  let child = null, cdp = null;
  try {
    if (!(await portFree())) { log("9223 被占"); return 2; }
    const workspaces = editStore();
    if (!findDoc(workspaces, args.doc)) { log("找不到文档"); return 2; }
    child = spawn("cmd.exe", ["/c", "npx", "tauri", "dev", "--config", "src-tauri/tauri.dev.conf.json"], {
      cwd: MDITOR_DIR, env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    for (const s of [child.stdout, child.stderr]) s.on("data", (d) => { try { writeSync(logFd, d); } catch { /* */ } });
    let target = null; const spawnAt = Date.now();
    while (Date.now() - spawnAt < 150_000) {
      try { const res = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(700) }); const page = (await res.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl); if (page) { target = page; break; } } catch { /* */ }
      await sleep(500);
    }
    if (!target) { log("CDP 未就绪"); killChildTree(child); return 2; }
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const m = mouse(cdp);
    for (let i = 0; i < 120; i++) { if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break; await sleep(500); }
    const openDoc = async (sub) => {
      for (let i = 0; i < 40; i++) {
        const p = await cdp.eval(`(() => { const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes(${JSON.stringify(sub)})); if (!hit) return null; const r = hit.getBoundingClientRect(); if (r.width === 0) return null; return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
        if (p) { await m.click(p.x, p.y); return true; } await sleep(500);
      } return false;
    };
    if (!await openDoc(args.doc)) { log("文档打开失败"); return 2; }
    await sleep(8000);
    // 滚到公式密集区（中段）再取视口样本
    for (let i = 0; i < 24; i++) { await m.wheel(640, 400, 0, 650); await sleep(120); }
    await sleep(3000);
    const diag = await cdp.eval(`(() => {
      const pm = document.querySelector('.ProseMirror');
      const host = document.querySelector('.mditor-editor-host');
      const lazy = pm ? pm.querySelectorAll('.mditor-math-inline-lazy').length : -1;
      const ready = pm ? pm.querySelectorAll('.mditor-math-inline-lazy.mditor-math-inline-ready').length : -1;
      return { lazy, ready, big: host ? !!host.dataset.big : null, top: host ? Math.round(host.scrollTop) : -1 };
    })()`);
    log('diag: ' + JSON.stringify(diag));
    const out = await cdp.eval(LOCKBOX_EXP(args.variant, args.n));
    log(JSON.stringify(out, null, 1).slice(0, 3000));
    writeFileSync(join(RESULTS_DIR, `r7-phase5-proto-lockbox-${args.variant}-${args.tag}.json`), JSON.stringify(out), "utf8");
    log("落盘完成");
    try { cdp.close(); } catch { /* */ }
    killChildTree(child);
    return 0;
  } catch (e) {
    log("异常: " + (e?.stack || e));
    try { cdp && cdp.close(); } catch { /* */ }
    killChildTree(child);
    return 1;
  } finally { try { closeSync(logFd); } catch { /* */ } }
}
main().then((c) => process.exit(c ?? 0));
