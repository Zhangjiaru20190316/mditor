// tmp-r6 一次性：打包版（release）冒烟——打开+滚动断言（任务书教训：
// typeText 不可靠）。起 src-tauri/target/release/mditor.exe（CDP 9222）→
// 打开密度档文档 → 滚动 → 断言行内公式 ready 挂载 + __mathPumpStats 出口
// 在打包 CSP 下可用。不入库。
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Cdp, mouse, sleep } from "../cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..", "..");
const EXE = resolve(MDITOR_DIR, "src-tauri", "target", "release", "mditor.exe");
const PORT = 9224; // 9222 被用户 Edge 占用（任务书端口避让惯例）；9223 是 dev 惯例

async function portReady() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(700) });
    const p = (await r.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    return p ?? null;
  } catch { return null; }
}

const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore", windowsHide: true,
});
const kill = () => { try { spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); } catch { /* */ } };
process.on("exit", kill);

const t0 = Date.now();
let target = null;
while (Date.now() - t0 < 60_000) {
  target = await portReady();
  if (target) break;
  await sleep(1000);
}
if (!target) { console.log("FAIL: CDP 9222 未就绪"); kill(); process.exit(2); }
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);
for (let i = 0; i < 40; i++) { if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break; await sleep(1000); }

// 打开密集档文档（prod store = 用户真实库；目标在折叠目录内——先展开
// 01_专题笔记 再找；多候选兜底），滚动+断言：__mathPumpStats 出口存在
// = 新包含 R6 前端。
const expandDir = async (dirName) => {
  for (let i = 0; i < 6; i++) {
    const p = await cdp.eval(`(() => {
      const hit = [...document.querySelectorAll('.ft-row')].find(r => {
        const n = r.querySelector('.ft-name')?.textContent ?? '';
        return n.includes(${JSON.stringify(dirName)}) && !n.endsWith('.md');
      });
      if (!hit) return null; const r = hit.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!p) return false;
    await m.click(p.x, p.y);
    await sleep(1200);
    return true;
  }
  return false;
};
await expandDir("01_专题笔记");
let opened = false;
for (const target of ["题型方法决策树", "密度档压测", "无穷级数"]) {
  if (opened) break;
  for (let i = 0; i < 8 && !opened; i++) {
    const p = await cdp.eval(`(() => {
      const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes(${JSON.stringify(target)}));
      if (!hit) return null; const r = hit.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (p) { await m.click(p.x, p.y); opened = true; } else await sleep(1000);
  }
  if (!opened && target === "题型方法决策树") await expandDir("02_习题集");
}
await sleep(6000);
const big = await cdp.eval(`!!document.querySelector('.mditor-editor-host')?.dataset.big`);
console.log(`打开密度档文档: ${opened} big=${big}`);

// 滚动 12 步 + 静止 3s
const cx = 640, cy = 400;
for (let i = 0; i < 12; i++) { await m.wheel(cx, cy, 0, 350); await sleep(180); }
await sleep(3000);

const info = await cdp.eval(`(() => ({
  lazy: document.querySelectorAll('.mditor-math-inline-lazy').length,
  ready: document.querySelectorAll('.mditor-math-inline-ready').length,
  katex: document.querySelectorAll('.katex').length,
  vpUnready: (() => { const h = document.querySelector('.mditor-editor-host'); if (!h) return -1;
    const r = h.getBoundingClientRect(); let n = 0;
    for (const el of document.querySelectorAll('.mditor-math-inline-lazy:not(.mditor-math-inline-ready)')) {
      const b = el.getBoundingClientRect(); if (b.bottom > r.top && b.top < r.bottom) n++; } return n; })(),
  pump: typeof window.__mathPumpStats === 'function' ? window.__mathPumpStats().enqueued : -1,
}))()`);
console.log("prod smoke:", JSON.stringify(info));
try { const ss = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(MDITOR_DIR, "perf", "results", "r6-prod-smoke.png"), Buffer.from(ss.data, "base64")); } catch { /* */ }
cdp.close();
kill();
const ok = info.lazy > 0 && info.katex > 0 && info.vpUnready === 0 && info.pump >= 0;
console.log(ok ? "PASS" : "CHECK-FAIL");
process.exit(ok ? 0 : 1);
