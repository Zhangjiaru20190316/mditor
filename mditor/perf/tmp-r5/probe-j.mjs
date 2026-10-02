// probe-j.mjs —— 第五轮 阶段二：症状 J（乱动）复现探针（一次性，不入库）
//
// 用法：node perf/tmp-r5/probe-j.mjs --scenario alpha|beta|gamma --doc 无穷级数_密度档
//        [--doc2 解题技巧] [--viewport on|off(默认on)] [--tag r5j1] [--watch-secs 60]
// 场景：
//   alpha —— 开档静置观察（捕获迟发写入方：预热补偿/恢复重试/PM 内部滚动）+
//            双标签切换后静置（复现生产 +3000/+5000@+32s 形态）
//   beta  —— 文内锚点链接连击（复现大纲/TOC smooth 尾巴出窗误报 ghost）
//   gamma —— 开档后 25s 紧密采样（复现落点后 ±69~269px 漂移；与 alpha 共用数据）
// 陷阱：Element.prototype.scrollIntoView / scrollTop setter / scrollTo 调用栈捕获
//       （区分 JS 写入 vs 原生滚动；未打标写入方直接从栈里读出）
// 清理：只杀 spawn 的 dev 实例 PID 树（taskkill /F /T /PID），绝不 /IM。

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { findPageTarget, Cdp, mouse, sleep } from "../cdp.mjs";

const PORT = 9223;
const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..", "..");
const REPO_ROOT = resolve(MDITOR_DIR, "..");
const FORENSICS_DIR = join(REPO_ROOT, ".workflow", "task2-forensics");
const RESULTS_DIR = join(MDITOR_DIR, "perf", "results");
const STORE_PATH = join(process.env.APPDATA ?? ".", "com.mditor.app.dev", "mditor.json");

function parseArgs(argv) {
  const a = { scenario: "alpha", doc: "无穷级数_密度档", doc2: "解题技巧", viewport: "on", tag: "r5j", watchSecs: 60 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);
    if (k === "--scenario") a.scenario = next();
    else if (k === "--doc") a.doc = next();
    else if (k === "--doc2") a.doc2 = next();
    else if (k === "--viewport") a.viewport = next();
    else if (k === "--tag") a.tag = next();
    else if (k === "--watch-secs") a.watchSecs = Number(next() ?? 60);
  }
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
function killChildTree(child) {
  try { if (child && child.pid) run("taskkill", ["/F", "/T", "/PID", String(child.pid)]); } catch { /* */ }
}
function editStore(viewportOn) {
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  const holder = raw.settings ? raw : raw.value;
  holder.settings.devMode = false;
  holder.settings.bigDocViewport = viewportOn;
  holder.settings.bigDocPerformance = false;
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

// ── 页内陷阱：scrollIntoView / scrollTop setter / scrollTo / scroll 事件 ──
const TRAP = `(() => {
  if (window.__r5trap) return 'already';
  const log = [];
  window.__r5trap = log;
  const push = (kind, detail) => {
    try {
      const st = String(new Error().stack || '');
      log.push({ t: Math.round(performance.now()), ts: Date.now(), kind, ...detail,
        stack: st.split('\\n').slice(2, 6).map(s => s.trim().replace(/^at\\s+/, '')).join(' <= ') });
      if (log.length > 800) log.shift();
    } catch {}
  };
  const sif = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function(...a) {
    push('scrollIntoView', { arg: JSON.stringify(a[0] ?? null),
      el: this.tagName + (this.id ? '#'+this.id : '') + '.' + String(this.className).split(' ').slice(0,3).join('.') });
    return sif.apply(this, a);
  };
  const d = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (d && d.set) {
    Object.defineProperty(Element.prototype, 'scrollTop', {
      get: d.get,
      set(v) {
        if (this.id === 'mditor-editor' || (this.classList && (this.classList.contains('mditor-editor-host'))))
          push('set-scrollTop', { from: d.get.call(this), to: v });
        return d.set.call(this, v);
      },
      configurable: true,
    });
  }
  const sto = Element.prototype.scrollTo;
  if (sto) Element.prototype.scrollTo = function(...a) {
    push('scrollTo', { arg: JSON.stringify(a[0] ?? null), el: String(this.className).slice(0,50) });
    return sto.apply(this, a);
  };
  let last = -1;
  window.addEventListener('scroll', () => {
    const h = document.querySelector('.mditor-editor-host');
    if (!h) return;
    const top = Math.round(h.scrollTop);
    if (top !== last) { push('scroll-event', { top }); last = top; }
  }, { capture: true, passive: true });
  return 'installed';
})()`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(FORENSICS_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
  const devlogPath = join(FORENSICS_DIR, `devlog-r5j-${args.tag}.txt`);
  const logFd = openSync(devlogPath, "w");
  const log = (m) => { try { writeSync(logFd, `[${new Date().toISOString()}] ${m}\n`); } catch {} console.log(m); };

  let child = null, cdp = null;
  const row = { ts: new Date().toISOString(), tag: args.tag, scenario: args.scenario, doc: args.doc,
    viewport: args.viewport, ticks: [], trapAll: [], scrollDebugWarn: [], notes: [] };
  try {
    if (!(await portFree())) { log("预检失败: 9223 被占（不硬清理，退出）"); return (closeLog(), 2); }
    const stale = vitePortPids();
    if (stale.length) { log(`预检失败: vite 残留 PID ${stale.join(",")}`); return (closeLog(), 2); }
    const { workspaces } = editStore(args.viewport === "on");
    const docPath = findDoc(workspaces, args.doc);
    if (!docPath) { log(`找不到文档 ${args.doc}`); return (closeLog(), 2); }
    log(`目标文档: ${docPath}`);

    const spawnAt = Date.now();
    child = spawn("cmd.exe", ["/c", "npx", "tauri", "dev", "--config", "src-tauri/tauri.dev.conf.json"], {
      cwd: MDITOR_DIR, env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    for (const s of [child.stdout, child.stderr]) s.on("data", (d) => { try { writeSync(logFd, d); } catch {} });
    let target = null;
    while (Date.now() - spawnAt < 150_000) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(700) });
        const page = (await res.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) { target = page; break; }
      } catch {}
      await sleep(500);
    }
    if (!target) { log("CDP 未就绪"); return (closeLog(), 2); }
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const m = mouse(cdp);
    try { await cdp.send("Network.enable"); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }); } catch {}
    for (let i = 0; i < 120; i++) { if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break; await sleep(500); }
    try { await cdp.send("Page.enable"); await cdp.send("Page.reload", { ignoreCache: true }); } catch {}
    for (let i = 0; i < 120; i++) { if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break; await sleep(500); }
    await cdp.eval(TRAP);
    log("陷阱已装");

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
    const readTick = async () => cdp.eval(`(() => {
      const h = document.querySelector('.mditor-editor-host');
      return { t: Math.round(performance.now()), top: h ? Math.round(h.scrollTop) : -1,
        recent: window.__scrollDebug ? window.__scrollDebug.recent() : null,
        big: h ? h.dataset.big !== undefined : null,
        trapN: window.__r5trap ? window.__r5trap.length : -1 };
    })()`);
    const watch = async (secs, label) => {
      const t0 = Date.now();
      let trapIdx = await cdp.eval(`window.__r5trap ? window.__r5trap.length : 0`);
      while (Date.now() - t0 < secs * 1000) {
        const tick = await readTick();
        row.ticks.push({ w: label, ...tick });
        if (tick.trapN > trapIdx) {
          const fresh = await cdp.eval(`window.__r5trap.slice(${trapIdx})`);
          for (const e of fresh) row.trapAll.push({ w: label, ...e });
          trapIdx = tick.trapN;
        }
        await sleep(200);
      }
      let warn = [];
      try {
        warn = await cdp.eval(`window.__scrollDebug ? (() => { const es = typeof window.__scrollDebug.events === 'function' ? window.__scrollDebug.events() : window.__scrollDebug.events; return (es ?? []).filter(e => e.level !== 'info').slice(-40).map(e => ({ts: e.ts, kind: e.kind, msg: e.msg, data: e.data ? JSON.stringify(e.data).slice(0, 300) : null})); })() : []`);
      } catch (e) { row.notes.push("warn-fetch-fail:" + String(e).slice(0, 80)); }
      for (const w of warn) row.scrollDebugWarn.push({ w: label, ...w });
    };

    if (!await openDoc(args.doc)) { log("文件树找不到目标文档"); return (closeLog(), 2); }
    await sleep(8000);
    log(`文档已开，big=${(await readTick()).big}`);

    if (args.scenario === "alpha") {
      // 复刻生产形态：先把文档滚到 ~8000px（保存位置非 0，恢复梯子有目标）
      const cx = 640, cy = 400;
      for (let i = 0; i < 27; i++) { await m.wheel(cx, cy, 0, 300); await sleep(180); }
      log(`预滚完成 top=${await cdp.eval(`Math.round(document.querySelector('.mditor-editor-host')?.scrollTop ?? -1)`)}`);
      await sleep(3000);
      await watch(Math.min(args.watchSecs, 20), "open-idle");
      if (args.doc2) {
        const doc2Path = findDoc(workspaces, args.doc2);
        if (doc2Path && await openDoc(args.doc2)) {
          await sleep(12000);
          log("第二文档已开，切回目标标签");
          for (let i = 0; i < 20; i++) {
            const p = await cdp.eval(`(() => {
              const hit = [...document.querySelectorAll('.tabbar-tab')].find(t => (t.textContent ?? '').includes(${JSON.stringify(basename(docPath).replace(/\.md$/, ""))}));
              if (!hit) return null;
              const r = hit.getBoundingClientRect();
              return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
            })()`);
            if (p) { await m.click(p.x, p.y); break; }
            await sleep(500);
          }
          await watch(Math.max(args.watchSecs, 90), "tab-back-idle");
        } else { log("doc2 不可用，跳过切换段"); row.notes.push("doc2-unavailable"); }
      }
    } else if (args.scenario === "beta") {
      // 先切侧栏到大纲面板
      for (let i = 0; i < 10; i++) {
        const btn = await cdp.eval(`(() => {
          const b = document.querySelector('.sb-tabs button[title="大纲"]');
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`);
        if (btn) { await m.click(btn.x, btn.y); break; }
        await sleep(400);
      }
      await sleep(1200);
      // 文内锚点 / 大纲链接连击：先枚举可用锚点
      const anchors = await cdp.eval(`(() => {
        const host = document.querySelector('.mditor-editor-host');
        const inDoc = [...document.querySelectorAll('.ProseMirror a[href^="#"]')].map((a, i) => {
          const r = a.getBoundingClientRect();
          return { i, kind: 'in-doc', text: (a.textContent || '').slice(0, 24),
            x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), top: Math.round(r.top) };
        }).filter(a => a.x > 0).slice(0, 12);
        const outline = [...document.querySelectorAll('.ol-row')].map((a, i) => {
          const r = a.getBoundingClientRect();
          return { i: 100 + i, kind: 'outline', text: (a.textContent || '').slice(0, 24),
            x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), top: Math.round(r.top) };
        }).filter(a => a.x > 0 && a.y > 0).slice(0, 12);
        return { inDoc, outline, scrollH: host ? host.scrollHeight : 0 };
      })()`);
      log(`锚点: in-doc=${anchors.inDoc.length} outline=${anchors.outline.length} scrollH=${anchors.scrollH}`);
      row.notes.push(`anchors:${JSON.stringify({ i: anchors.inDoc.length, o: anchors.outline.length })}`);
      const pool = (() => {
        const src = anchors.outline.length >= 4 ? anchors.outline : anchors.inDoc;
        if (src.length < 2) return src;
        // 首选跨文档分布（复刻生产万级像素长动画），不足 5 个就均分取
        const idx = [0, Math.floor(src.length / 4), Math.floor(src.length / 2), Math.floor((src.length * 3) / 4), src.length - 1];
        return [...new Set(idx)].map((i) => src[Math.min(i, src.length - 1)]);
      })();
      if (pool.length < 2) { log("可用锚点不足"); row.notes.push("no-anchors"); }
      for (let k = 0; k < pool.length && k < 5; k++) {
        const a = pool[k];
        log(`第 ${k + 1} 击: ${a.kind} ${a.text}`);
        await m.click(a.x, a.y);
        await watch(4, `jump-${k + 1}`);
      }
    } else if (args.scenario === "gamma") {
      await watch(25, "open-drift");
    }

    try { cdp.close(); } catch {}
    cdp = null;
    killChildTree(child);
    child = null;
    const out = join(RESULTS_DIR, `r5-phase2-j-${args.scenario}-${args.tag}.json`);
    writeFileSync(out, JSON.stringify(row), "utf8");
    log(`证据落盘 ${out}`);
    return (closeLog(), 0);
  } catch (e) {
    log("异常: " + (e?.stack || e));
    try { cdp && cdp.close(); } catch {}
    killChildTree(child);
    return (closeLog(), 1);
  }
  function closeLog() { try { closeSync(logFd); } catch {} }
}
main().then((c) => process.exit(c ?? 0), (e) => { console.error(e?.stack || e); process.exit(2); });
