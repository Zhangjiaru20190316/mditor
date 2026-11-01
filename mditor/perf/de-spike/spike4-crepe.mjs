// DE 轮阶段 0 spike ④-B 驱动（Node）：headless Edge + CDP → dev 页面内跑
// src/dev/deSpikeEdit.ts 的 Crepe 往返。输入 = spike④-A 产出的 mammoth HTML。
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9331;
const URL = "http://127.0.0.1:1420/";

const browser = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${ROOT}/perf/de-spike/out/edge-profile-${Date.now()}`,
  "--no-first-run", "--hide-scrollbars", "--window-size=1400,2000", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let version = null;
for (let i = 0; i < 60; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
  catch { await sleep(500); }
}
if (!version) { console.error("CDP not up"); process.exit(1); }

class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); }
  static async connect(url) {
    const c = new Cdp(new WebSocket(url));
    await new Promise((res, rej) => { c.ws.addEventListener("open", res, { once: true }); c.ws.addEventListener("error", rej, { once: true }); });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
{
  const c = await Cdp.connect(version.webSocketDebuggerUrl);
  c.ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id != null) {
      const p = c.pending.get(m.id);
      if (p) { c.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    }
  });
  const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = await Cdp.connect(list.find((t) => t.id === targetId).webSocketDebuggerUrl);
  page.ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id != null) {
      const p = page.pending.get(m.id);
      if (p) { page.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    }
  });
  await page.send("Page.enable");
  await page.send("Page.navigate", { url: URL });
  await sleep(3500); // 等应用挂载 + Vite 模块图
  const evalJs = async (expression) => {
    const r = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };

  const htmlIn = readFileSync(path.join(ROOT, "perf", "de-spike", "out", "spike4-features.html"), "utf8");
  const result = await evalJs(`(async () => {
    const m = await import('/src/dev/deSpikeEdit.ts');
    return await m.runCrepeRoundtrip(${JSON.stringify(htmlIn)});
  })()`);
  const probe = await evalJs(`(async () => {
    const m = await import('/src/dev/deSpikeEdit.ts');
    return await m.pipeTableProbe();
  })()`);
  console.log("== pipeTableProbe ==", JSON.stringify(probe));
  const probe2 = await evalJs(`(async () => {
    const m = await import('/src/dev/deSpikeEdit.ts');
    return await m.fixtureTableProbe();
  })()`);
  console.log("== fixtureTableProbe ==", JSON.stringify(probe2));
  const resultUnwrap = await evalJs(`(async () => {
    const m = await import('/src/dev/deSpikeEdit.ts');
    return await m.runCrepeRoundtrip(${JSON.stringify(htmlIn)}, { unwrapTableCells: true, preprocessAll: true });
  })()`);
  console.log(JSON.stringify({ raw: result, unwrap: resultUnwrap }, null, 2));
  mkdirSync(path.join(ROOT, "perf", "de-spike", "results"), { recursive: true });
  writeFileSync(path.join(ROOT, "perf", "de-spike", "results", "spike4b.json"), JSON.stringify({ raw: result, unwrap: resultUnwrap }, null, 2));
  await page.send("Target.closeTarget", { targetId });
}
browser.kill();
process.exit(0);
