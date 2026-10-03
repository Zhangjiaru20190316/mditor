// diag-blocks.mjs —— R7 M3 诊断：块级公式 DOM 形态检查（一次性，不入库）
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { Cdp, mouse, sleep } from "../cdp.mjs";

const PORT = 9223;
const here = dirname(fileURLToPath(import.meta.url));
const MDITOR_DIR = resolve(here, "..", "..");
const STORE_PATH = join(process.env.APPDATA ?? ".", "com.mditor.app.dev", "mditor.json");

async function main() {
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  const holder = raw.settings ? raw : raw.value;
  holder.settings.devMode = false; holder.settings.bigDocViewport = true; holder.settings.bigDocPerformance = false;
  writeFileSync(STORE_PATH, JSON.stringify(raw, null, 2), "utf8");
  const child = spawn("cmd.exe", ["/c", "npx", "tauri", "dev", "--config", "src-tauri/tauri.dev.conf.json"], {
    cwd: MDITOR_DIR, env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: ["ignore", "ignore", "ignore"], windowsHide: true,
  });
  try {
    let target = null; const t0 = Date.now();
    while (Date.now() - t0 < 150_000 && !target) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(700) }); const p = (await r.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl); if (p) target = p; } catch {}
      await sleep(500);
    }
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const m = mouse(cdp);
    for (let i = 0; i < 120; i++) { if (await cdp.eval(`!!document.querySelector('.ProseMirror')`)) break; await sleep(500); }
    // 打开密度档
    for (let i = 0; i < 40; i++) {
      const p = await cdp.eval(`(() => { const h = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes('无穷级数_密度档')); if (!h) return null; const r = h.getBoundingClientRect(); if (!r.width) return null; return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
      if (p) { await m.click(p.x, p.y); break; } await sleep(500);
    }
    await sleep(9000);
    // 滚到中部块公式区再查视口内挂载状态
    for (let i = 0; i < 30; i++) { await m.wheel(640, 400, 0, 1200); await sleep(120); }
    await sleep(3000);
    const midInfo = await cdp.eval(`(() => {
      const host = document.querySelector('.mditor-editor-host');
      const r0 = host.getBoundingClientRect();
      const inVp = (el) => { const r = el.getBoundingClientRect(); return r.bottom > r0.top && r.top < r0.bottom; };
      const blocks = [...document.querySelectorAll('.milkdown-code-block')];
      const pres = [...document.querySelectorAll('.ProseMirror pre')];
      const vpPres = pres.filter(inVp);
      const vpBlocks = blocks.filter(inVp);
      return { totalPres: pres.length, totalMounted: blocks.length, vpPres: vpPres.length, vpMounted: vpBlocks.length,
        scrollTop: Math.round(host.scrollTop),
        vpSample: vpBlocks.slice(0, 3).map((b) => ({ K: !!b.querySelector('.preview .katex'), C: !!b.querySelector('.codemirror-host .cm-editor'), P: !!b.querySelector('.preview-panel'), lang: (b.querySelector('.language-picker, .tools button, .tools span')?.textContent || '').trim().slice(0, 16) })),
        vpPreSample: vpPres.slice(0, 3).map((p2) => ({ cls: p2.className.slice(0, 40), lang: (p2.dataset.language || p2.querySelector('code')?.className || '').slice(0, 30), hasCm: !!p2.querySelector('.cm-editor'), text: (p2.textContent || '').slice(0, 40) })) };
    })()`);
    console.log('MID:', JSON.stringify(midInfo, null, 1));
    const latexProbe = await cdp.eval(`(() => {
      // 找 latex 块的占位/挂载形态：任何带语言标记的元素
      const cands = new Map();
      for (const el of document.querySelectorAll('.ProseMirror [data-language], .ProseMirror [data-type], .ProseMirror code-block, .ProseMirror [class*=code]')) {
        const key = el.tagName + '.' + String(el.className).slice(0, 40);
        cands.set(key, (cands.get(key) || 0) + 1);
      }
      const host = document.querySelector('.mditor-editor-host');
      const r0 = host.getBoundingClientRect();
      // 视口内顶层块的标签分布
      const tags = new Map();
      for (const el of host.querySelector('.ProseMirror').children) {
        const r = el.getBoundingClientRect();
        if (r.bottom < r0.top || r.top > r0.bottom) continue;
        const k = el.tagName + (el.dataset?.type ? '[data-type=' + el.dataset.type + ']' : '') + (el.dataset?.language ? '[lang=' + el.dataset.language + ']' : '');
        tags.set(k, (tags.get(k) || 0) + 1);
      }
      // 视口内含 \begin 或 latex 源码特征的文本块
      let latexText = 0, sampleEl = null;
      for (const el of host.querySelector('.ProseMirror').children) {
        const t = el.textContent || '';
        if (/\sum|\frac|\begin|\displaystyle/.test(t)) { latexText++; if (!sampleEl && t.length < 300) sampleEl = { tag: el.tagName, cls: String(el.className).slice(0, 50), text: t.slice(0, 60) }; }
      }
      return { cands: [...cands.entries()], vpTopTags: [...tags.entries()], latexTextBlocks: latexText, sampleEl };
    })()`);
    console.log('LATEX:', JSON.stringify(latexProbe, null, 1));
    // 全文档块级公式盘点（不滚动，直接查 DOM 结构分布）
    const info = await cdp.eval(`(() => {
      const blocks = [...document.querySelectorAll('.milkdown-code-block')];
      const pres = [...document.querySelectorAll('.ProseMirror pre')];
      const sample = [];
      for (const b of blocks.slice(0, 3)) {
        sample.push({
          hasPreviewPanel: !!b.querySelector('.preview-panel'),
          hasPreview: !!b.querySelector('.preview'),
          hasKatexInPreview: !!b.querySelector('.preview .katex'),
          hasCm: !!b.querySelector('.codemirror-host .cm-editor'),
          cls: b.className.slice(0, 80),
          lang: (b.querySelector('.language-picker, .tools button, .tools span')?.textContent || '').trim().slice(0, 20),
          text: (b.textContent || '').slice(0, 50),
        });
      }
      return { blockCount: blocks.length, preCount: pres.length, sample };
    })()`);
    console.log(JSON.stringify(info, null, 1));
    cdp.close();
  } finally {
    try { spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); } catch {}
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
