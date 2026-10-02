// formula-probe.mjs —— R6 阶段二：症状 T/M 复现与取证探针（一次性，不入库）
//
// 用法：node perf/tmp-r6/formula-probe.mjs --scenario traverse|upscroll|blocks|dominfo
//        --doc <子串> [--viewport on(默认)] [--tag r6p] [--quiet-ms 10000]
//
// 场景：
//   traverse —— 快速长滚遍历全文档往返（wheel 1200px/格/150ms 到底再回顶），
//     静止 --quiet-ms 后采 M1（视口/带内未 ready 残留 + 残留 DOM 位置直方图）
//     + M2（__mathPumpStats 队列深度/最老等待）+ katex-error 计数。
//   upscroll —— 下滚 6000px → 上滚 3000px → 静止 10s：每 250ms 采样视口内
//     unready 数收敛曲线（T1 拖尾形态）+ 泵统计轨迹。
//   blocks  —— 滚遍历中对每个视口内块级公式容器采样 KaTeX 预览挂载配对（M3）。
//   dominfo —— dump 视口内一个块级公式容器的外层结构（M3 选择器探明）。
// 清理：只杀自 spawn 的 dev PID 树。

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
  const a = { scenario: "traverse", doc: "无穷级数_密度档", viewport: "on", tag: "r6p", quietMs: 10000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);
    if (k === "--scenario") a.scenario = next();
    else if (k === "--doc") a.doc = next();
    else if (k === "--viewport") a.viewport = next();
    else if (k === "--tag") a.tag = next();
    else if (k === "--quiet-ms") a.quietMs = Number(next() ?? 10000);
  }
  return a;
}
async function portFree(port = PORT) {
  try { await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(700) }); return false; } catch { return true; }
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
function killChildTree(child) { try { if (child && child.pid) run("taskkill", ["/F", "/T", "/PID", String(child.pid)]); } catch { /* */ } }
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

// M1 采样：残留计数 + DOM 序位置直方图（M-a 指纹：尾部聚集？）+ 泵统计
const M_SAMPLE = `(() => {
  const host = document.querySelector('.mditor-editor-host');
  if (!host) return null;
  const vh = host.clientHeight, top = host.scrollTop;
  const all = [...document.querySelectorAll('.mditor-math-inline-lazy')];
  const unready = all.filter((el) => !el.classList.contains('mditor-math-inline-ready'));
  const r = host.getBoundingClientRect();
  const inVp = (el) => { const b = el.getBoundingClientRect(); return b.bottom > r.top && b.top < r.bottom; };
  const inBand = (el) => { const b = el.getBoundingClientRect(); return b.bottom > r.top - 800 && b.top < r.bottom + 800; };
  // 残留 DOM 序直方图（10 桶；M-a 指纹 = 尾部桶集中）
  const buckets = new Array(10).fill(0);
  const idxMap = new Map(all.map((el, i) => [el, i]));
  for (const el of unready) { const i = idxMap.get(el) ?? 0; buckets[Math.min(9, Math.floor((i / all.length) * 10))]++; }
  const pump = typeof window.__mathPumpStats === 'function' ? window.__mathPumpStats() : null;
  return {
    total: all.length, ready: all.length - unready.length,
    vpUnready: unready.filter(inVp).length, bandUnready: unready.filter(inBand).length,
    vpUnreadySrcs: unready.filter(inVp).slice(0, 8).map((el) => (el.textContent || '').slice(0, 40)),
    posBuckets: buckets,
    scrollTop: Math.round(top), scrollHeight: Math.round(host.scrollHeight),
    pump, katexErrors: document.querySelectorAll('.katex-error').length,
  };
})()`;

// 视口内 unready 快速计数（收敛曲线采样）
const VP_SAMPLE = `(() => {
  const host = document.querySelector('.mditor-editor-host');
  if (!host) return -1;
  const r = host.getBoundingClientRect(); let n = 0;
  for (const el of document.querySelectorAll('.mditor-math-inline-lazy:not(.mditor-math-inline-ready)')) {
    const b = el.getBoundingClientRect();
    if (b.bottom > r.top && b.top < r.bottom) n++;
  }
  return n;
})()`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(FORENSICS_DIR, { recursive: true }); mkdirSync(RESULTS_DIR, { recursive: true });
  const devlogPath = join(FORENSICS_DIR, `devlog-r6p-${args.tag}.txt`);
  const logFd = openSync(devlogPath, "w");
  const log = (m) => { try { writeSync(logFd, `[${new Date().toISOString()}] ${m}\n`); } catch { /* */ } console.log(m); };

  let child = null, cdp = null;
  const row = { ts: new Date().toISOString(), tag: args.tag, scenario: args.scenario, doc: args.doc,
    viewport: args.viewport, ok: false };
  try {
    if (!(await portFree())) { log("预检失败: 9223 被占"); return (closeLog(), 2); }
    const stale = vitePortPids();
    if (stale.length) { log(`预检失败: vite 残留 PID ${stale.join(",")}`); return (closeLog(), 2); }
    const { workspaces } = editStore(args.viewport === "on");
    if (!findDoc(workspaces, args.doc)) { log(`找不到文档 ${args.doc}`); return (closeLog(), 2); }

    const spawnAt = Date.now();
    child = spawn("cmd.exe", ["/c", "npx", "tauri", "dev", "--config", "src-tauri/tauri.dev.conf.json"], {
      cwd: MDITOR_DIR, env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    for (const s of [child.stdout, child.stderr]) s.on("data", (d) => { try { writeSync(logFd, d); } catch { /* */ } });
    let target = null;
    while (Date.now() - spawnAt < 150_000) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(700) });
        const page = (await res.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) { target = page; break; }
      } catch { /* */ }
      await sleep(500);
    }
    if (!target) { log("CDP 未就绪"); killChildTree(child); return (closeLog(), 2); }
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const m = mouse(cdp);
    try { await cdp.send("Network.enable"); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }); } catch { /* */ }
    for (let i = 0; i < 120; i++) { if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break; await sleep(500); }
    try { await cdp.send("Page.enable"); await cdp.send("Page.reload", { ignoreCache: true }); } catch { /* */ }
    for (let i = 0; i < 120; i++) { if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break; await sleep(500); }

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
    if (!await openDoc(args.doc)) { log("文件树找不到目标文档"); return (closeLog(), 2); }
    await sleep(8000);
    const big = await cdp.eval(`(() => { const h = document.querySelector('.mditor-editor-host'); return h ? h.dataset.big !== undefined : null; })()`);
    log(`文档已开 big=${big}`);
    row.big = big;

    const readScroll = () => cdp.eval(`(() => { const h = document.querySelector('.mditor-editor-host'); return { top: Math.round(h.scrollTop), h: Math.round(h.scrollHeight), vh: h.clientHeight }; })()`);
    const cx = 640, cy = 400;
    const wheel = async (dy, pause = 150) => { await m.wheel(cx, cy, 0, dy); await sleep(pause); };

    if (args.scenario === "dominfo") {
      // 下滚 5 屏到块级公式区域再探测（文档顶部多为标题/正文）
      for (let i = 0; i < 6; i++) await wheel(650, 200);
      await sleep(2000);
      row.dominfo = await cdp.eval(`(() => {
        const host = document.querySelector('.mditor-editor-host');
        const r0 = host.getBoundingClientRect();
        const out = { pres: [], katexDisplays: 0, samplePre: null, sampleKd: null };
        for (const pre of document.querySelectorAll('.ProseMirror pre')) {
          const r = pre.getBoundingClientRect();
          if (r.bottom < r0.top - 200 || r.top > r0.bottom + 200) continue;
          const blk = pre.closest('.ProseMirror > *') ?? pre;
          out.pres.push({ tag: blk.tagName, cls: (blk.className || '').slice(0, 50), h: Math.round(r.height),
            hasCm: !!blk.querySelector('.cm-editor'), hasKatex: !!blk.querySelector('.katex'),
            lang: (pre.querySelector('code')?.className || pre.dataset.language || '').slice(0, 30),
            text: (pre.textContent || '').slice(0, 40) });
        }
        out.katexDisplays = document.querySelectorAll('.ProseMirror .katex-display').length;
        const kd = document.querySelector('.ProseMirror .katex-display');
        if (kd) { let el = kd; const chain = [];
          for (let i = 0; i < 6 && el; i++) { chain.push(el.tagName + '.' + (el.className || '').toString().slice(0, 40)); el = el.parentElement; }
          out.sampleKd = { chain, html: kd.parentElement.outerHTML.slice(0, 300) }; }
        const cm = document.querySelector('.ProseMirror .cm-editor');
        if (cm) { let el = cm; const chain = [];
          for (let i = 0; i < 6 && el; i++) { chain.push(el.tagName + '.' + (el.className || '').toString().slice(0, 40)); el = el.parentElement; }
          out.samplePre = chain; }
        return out;
      })()`);
      log(`dominfo: ${JSON.stringify(row.dominfo).slice(0, 600)}`);
    } else if (args.scenario === "traverse") {
      // 快速长滚遍历：到底再回顶（覆盖全文档），静止后采 M1/M2
      let s = await readScroll();
      log(`初始 scroll: top=${s.top} h=${s.h} vh=${s.vh}`);
      const step = Math.round(s.vh * 0.9);
      let guard = 0;
      while (s.top + s.vh < s.h - 20 && guard++ < 400) { await wheel(step); s = await readScroll(); }
      log(`到底 top=${s.top} h=${s.h}（${guard} 步）`);
      await sleep(1500);
      guard = 0;
      while (s.top > 20 && guard++ < 400) { await wheel(-step); s = await readScroll(); }
      log(`回顶 top=${s.top}（${guard} 步）`);
      row.traverseSteps = guard;
      // 静止采样：每秒一次 pump 快照，最后采 M1
      row.pumpTail = [];
      for (let i = 0; i < Math.round(args.quietMs / 1000); i++) {
        await sleep(1000);
        row.pumpTail.push(await cdp.eval(`(() => { const p = typeof window.__mathPumpStats === 'function' ? window.__mathPumpStats() : null;
          const h = document.querySelector('.mditor-editor-host'); const r = h.getBoundingClientRect(); let n = 0;
          for (const el of document.querySelectorAll('.mditor-math-inline-lazy:not(.mditor-math-inline-ready)')) {
            const b = el.getBoundingClientRect(); if (b.bottom > r.top && b.top < r.bottom) n++; }
          return { s: ${i}, vpUnready: n, queue: p ? p.queueDepth : -1, live: p ? p.liveQueued : -1, oldestMs: p ? p.oldestWaitMs : -1 }; })()`));
      }
      row.m1 = await cdp.eval(M_SAMPLE);
      log(`M1: vpUnready=${row.m1.vpUnready} bandUnready=${row.m1.bandUnready} total=${row.m1.total} ready=${row.m1.ready} pump.queue=${row.m1.pump ? row.m1.pump.queueDepth : 'n/a'} katexErrors=${row.m1.katexErrors}`);
      log(`posBuckets=${JSON.stringify(row.m1.posBuckets)}`);
    } else if (args.scenario === "upscroll") {
      for (let i = 0; i < 20; i++) await wheel(300, 180);
      await sleep(1500);
      for (let i = 0; i < 10; i++) await wheel(-300, 180);
      // 静止后收敛曲线：每 250ms 采样视口内 unready + 泵队列，共 12s
      row.tail = [];
      for (let i = 0; i < 48; i++) {
        const vp = await cdp.eval(VP_SAMPLE);
        const p = await cdp.eval(`typeof window.__mathPumpStats === 'function' ? window.__mathPumpStats().queueDepth : -1`);
        row.tail.push({ t: i * 250, vpUnready: vp, queue: p });
        if (vp === 0 && i > 8) break;
        await sleep(250);
      }
      row.m1 = await cdp.eval(M_SAMPLE);
      log(`tail: ${JSON.stringify(row.tail.slice(0, 12))}... 末点=${JSON.stringify(row.tail[row.tail.length - 1])}`);
    } else if (args.scenario === "blocks") {
      // 块级公式挂载扫描（M3）：遍历文档，rAF 采样视口内 .milkdown-code-block
      // 的 KaTeX 预览挂载配对（dominfo 探明口径：预览态 = .preview .katex，
      // 源码态 = .codemirror-host .cm-editor；previewOnlyByDefault 时预览优先）
      await cdp.eval(`(() => {
        window.__r6blocks = { seen: new Map() };
        const host = document.querySelector('.mditor-editor-host');
        const tick = () => {
          try {
            const r0 = host.getBoundingClientRect();
            for (const b of document.querySelectorAll('.milkdown-code-block')) {
              const r = b.getBoundingClientRect();
              if (r.bottom < r0.top || r.top > r0.bottom) continue;
              const panel = b.querySelector('.preview-panel');
              const preview = b.querySelector('.preview');
              const hasKatex = !!b.querySelector('.preview .katex');
              const hasCm = !!b.querySelector('.codemirror-host .cm-editor');
              const text = (b.querySelector('.cm-content, .preview')?.textContent || b.textContent || '').slice(0, 40);
              // 状态：K=预览挂载（.preview .katex）；P=有预览容器未挂载；
              // C=仅 CodeMirror；B=裸块（无 cm 无预览容器）
              const st = hasKatex ? 'K' : (preview || panel) ? 'P' : hasCm ? 'C' : 'B';
              const lang = (b.querySelector('.language-picker, .tools button, .tools span')?.textContent || '').trim().slice(0, 16);
              if (!window.__r6blocks.seen.has(text)) window.__r6blocks.seen.set(text, { text, states: new Set(), langs: new Set() });
              const rec = window.__r6blocks.seen.get(text);
              rec.states.add(st);
              if (lang) rec.langs.add(lang);
            }
          } catch {}
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })()`);
      let s = await readScroll();
      let guard = 0;
      while (s.top + s.vh < s.h - 20 && guard++ < 400) { await wheel(Math.round(s.vh * 0.9)); s = await readScroll(); }
      guard = 0;
      while (s.top > 20 && guard++ < 400) { await wheel(-Math.round(s.vh * 0.9)); s = await readScroll(); }
      await sleep(4000);
      row.blocks = await cdp.eval(`(() => {
        const s = window.__r6blocks; if (!s) return null;
        // 分类以语言标签为准（K/P 态判定是循环论证）：langs 含 latex → 块级公式
        let latex = 0, latexK = 0, plain = 0;
        const neverK = [];
        for (const e of s.seen.values()) {
          if (e.text.trim().length < 2) continue;
          const st = [...e.states].join('');
          const isLatex = [...e.langs].some((l) => /latex/i.test(l)) || st.includes('K') || st.includes('P');
          if (isLatex) {
            latex++;
            if (st.includes('K')) latexK++;
            else if (neverK.length < 10) neverK.push({ text: e.text.slice(0, 30), st, langs: [...e.langs] });
          } else plain++;
        }
        return { latex, latexK, plain, neverK,
          mountRate: latex ? Math.round((latexK / latex) * 1000) / 1000 : null };
      })()`);
      log(`blocks: ${JSON.stringify(row.blocks)}`);
    }

    try { cdp.close(); } catch { /* */ }
    cdp = null;
    killChildTree(child); child = null;
    const out = join(RESULTS_DIR, `r6-phase2-${args.scenario}-${args.tag}.json`);
    writeFileSync(out, JSON.stringify(row));
    log(`证据落盘 ${out}`);
    return (closeLog(), 0);
  } catch (e) {
    log("异常: " + (e?.stack || e));
    try { cdp && cdp.close(); } catch { /* */ }
    killChildTree(child);
    return (closeLog(), 1);
  }
  function closeLog() { try { closeSync(logFd); } catch { /* */ } }
}
main().then((c) => process.exit(c ?? 0), (e) => { console.error(e?.stack || e); process.exit(2); });
