// 大文档多公式导出性能基准驱动（mexport 轮）。
//
//   node perf/mexport.mjs [--label base] [--blocks 500] [--scale 2]
//                          [--mode vector] [--no-pdf] [--no-math] [--reps 3]
//                          [--out perf/results/mexport/<label>.json]
//
// 自带 headless Edge：连 127.0.0.1:9224，开 vite dev 页面，动态 import
// src/dev/exportBench.ts 跑各阶段计时。每次运行 Page.navigate 取新文档，
// 保证 import 的是当前源码（无模块缓存残留）。

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null && !args[i + 1].startsWith("--")
    ? args[i + 1]
    : def;
};
const flag = (name) => args.includes(`--${name}`);

const LABEL = arg("label", "run");
const BLOCKS = Number(arg("blocks", 500));
const SCALE = Number(arg("scale", 2));
const MODE = arg("mode", "vector");
const REPS = Number(arg("reps", 3));
const URL = arg("url", "http://127.0.0.1:1420/");
const PORT = Number(arg("port", 9224));
const OUT =
  arg("out", null) ?? path.join(ROOT, "perf", "results", "mexport", `${LABEL}.json`);
const DUMP = Number(arg("dump", 0));
const NO_DIRECT = flag("no-direct");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
// 每次运行独立 profile：强杀残留的 Edge 会留下锁死的 profile，让后续实例
// 卡在启动恢复。跑完即弃（perf/tmp/mexport-profile-<ts>）。
const PROFILE = path.join(
  ROOT,
  "perf",
  "tmp",
  `mexport-profile-${process.pid}-${Date.now()}`
);

// ---- 启动 headless Edge ----------------------------------------------------

mkdirSync(path.dirname(OUT), { recursive: true });
const browser = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--window-size=1400,2000",
    "about:blank",
  ],
  { stdio: "ignore" }
);
// 兜底：驱动本体意外挂住时不要留下孤儿 Edge。
const watchdog = setTimeout(() => {
  try { browser.kill(); } catch { /* noop */ }
  process.exit(2);
}, 30 * 60 * 1000);
watchdog.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpHttp(endpoint) {
  const res = await fetch(`http://127.0.0.1:${PORT}${endpoint}`, {
    method: "PUT",
  }).catch(() => null);
  return res ? await res.json() : null;
}

let version = null;
for (let i = 0; i < 60; i++) {
  version = await cdpHttp("/json/version").catch(() => null);
  if (version) break;
  await sleep(500);
}
if (!version) {
  browser.kill();
  throw new Error("headless Edge 未在 30s 内开放 CDP 端口");
}

// ---- 最小 CDP（复用 perf/cdp.mjs 语义，独立内联避免改公共文件）--------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        }
        return;
      }
      this.events.push(msg);
      for (const w of this.waiters.splice(0)) {
        if (!w(msg)) this.waiters.push(w);
      }
    });
    this.ready = new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    const c = new Cdp(ws);
    await c.ready;
    return c;
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  waitFor(predicate, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      const w = (msg) => {
        if (predicate(msg)) {
          clearTimeout(timer);
          resolve(msg);
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("waitFor 超时"));
      }, timeoutMs);
      // 先扫历史事件。
      for (let i = 0; i < this.events.length; i++) {
        if (w(this.events[i])) {
          this.events.splice(i, 1);
          return;
        }
      }
      this.waiters.push(w);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        "eval 异常: " +
          (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      );
    }
    return r.result?.value;
  }
  close() {
    this.ws.close();
  }
}

const browserCdp = await Cdp.connect(version.webSocketDebuggerUrl);
try {
  const { targetId } = await browserCdp.send("Target.createTarget", {
    url: "about:blank",
  });
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find((t) => t.id === targetId);
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: URL });
    await cdp.waitFor((m) => m.method === "Page.loadEventFired", 60_000);
    // 页面（应用）加载完再等一拍字体/静态资源。
    await sleep(1500);

    const result = {
      label: LABEL,
      blocks: BLOCKS,
      scale: SCALE,
      mode: MODE,
      reps: REPS,
      ts: new Date().toISOString(),
    };

    const fixture = await cdp.eval(
      `(async () => { if (!window.__mexport) await import('/src/dev/exportBench.ts?t=${Date.now()}'); ${NO_DIRECT ? "window.__noDirectRaster = true;" : ""} window.__fixture = window.__mexport.buildFixture({ blocks: ${BLOCKS} }); return window.__fixture; })()`
    );
    result.counts = fixture.counts;

    if (!flag("no-math")) {
      result.math = await cdp.eval(
        `(async () => window.__mexport.benchMath(window.__fixture ?? (window.__fixture = window.__mexport.buildFixture({ blocks: ${BLOCKS} })), ${REPS}))()`
      );
      result.sanitize = await cdp.eval(
        `(async () => window.__mexport.benchSanitize(window.__fixture.html, ${REPS}))()`
      );
    }

    if (!flag("no-pdf")) {
      // fixture 重建：benchMath 可能污染 katexCache（这正是要度量的行为之一，
      // 保持同一顺序语义：math 先跑、pdf 后跑，与真实导出「编辑器已渲染过」
      // 的热缓存形态接近）。
      result.pdf = await cdp.eval(
        `(async () => window.__mexport.benchPdf(window.__fixture.html, { mode: '${MODE}', rasterScale: ${SCALE}, textLayer: true, dumpPages: ${DUMP} }))()`
      );
      if (DUMP > 0 && result.pdf.dumpCount > 0) {
        const dir = path.join(ROOT, "perf", "results", "mexport", `${LABEL}-pages`);
        mkdirSync(dir, { recursive: true });
        const n = result.pdf.dumpCount;
        delete result.pdf.dumpCount;
        for (let i = 0; i < n; i++) {
          const d = await cdp.eval(`window.__lastPdfDumps[${i}]`);
          if (d) {
            writeFileSync(
              path.join(dir, `page-${String(i).padStart(3, "0")}.png`),
              Buffer.from(d.slice(d.indexOf(",") + 1), "base64")
            );
          }
        }
        console.log(`pages dumped to ${dir}`);
      }
    }

    writeFileSync(OUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    cdp.close();
  }
} finally {
  try {
    await browserCdp.send("Browser.close");
  } catch {
    /* already gone */
  }
  browser.kill();
}
