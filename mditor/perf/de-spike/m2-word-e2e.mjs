// M2 Word 编辑链端到端验收（headless Edge + CDP + dev server）：
//   fixtures/spike4-features.docx → 页面内 convertDocxBytesForEdit → Crepe →
//   buildDocx → 产物落盘 out/m2-word-e2e.docx + jszip 结构断言。
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9332;
const URL = "http://127.0.0.1:1420/";

const browser = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${ROOT}/perf/de-spike/out/edge-m2-${Date.now()}`,
  "--no-first-run", "--hide-scrollbars", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let version = null;
for (let i = 0; i < 60; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
  catch { await sleep(500); }
}
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
const hook = (c) => c.ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id != null) {
    const p = c.pending.get(m.id);
    if (p) { c.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  }
});
const bcdp = await Cdp.connect(version.webSocketDebuggerUrl); hook(bcdp);
const { targetId } = await bcdp.send("Target.createTarget", { url: "about:blank" });
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = await Cdp.connect(list.find((t) => t.id === targetId).webSocketDebuggerUrl); hook(page);
await page.send("Page.enable");
await page.send("Page.navigate", { url: URL });
await sleep(3500);
const evalJs = async (expression) => {
  const r = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};

const docx = readFileSync(path.join(ROOT, "perf", "de-spike", "out", "spike4-features.docx"));
const b64 = docx.toString("base64");
const result = await evalJs(`(async () => {
  const m = await import('/src/dev/deSpikeEdit.ts');
  return await m.runWordEditE2E(${JSON.stringify(b64)});
})()`);
console.log("checks:", JSON.stringify(result.checks));
console.log("sizes: md", result.markdownLen, "| html", result.htmlLen, "| docx out", result.outBytes);
const out = Buffer.from(result.outB64, "base64");
const outPath = path.join(ROOT, "perf", "de-spike", "out", "m2-word-e2e.docx");
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, out);

// 结构断言：合法 zip + OOXML 主文档含预期结构标签
const zip = await JSZip.loadAsync(out);
const docXml = await zip.file("word/document.xml").async("string");
const structural = {
  "zip有效+document.xml": !!docXml,
  w_body: docXml.includes("<w:body>"),
  w_tbl: docXml.includes("<w:tbl>"),
  w_numPr: /w:numPr/.test(docXml) || /编号项/.test(docXml),
  标题文本: docXml.includes("一级标题"),
  列表文本: /编号项 A/.test(docXml),
  表格文本: docXml.includes("表头横跨两列"),
  加粗文本: docXml.includes("加粗片段"),
  图片媒体: !!zip.file("word/media/image1.png") || Object.keys(zip.files).some((f) => f.startsWith("word/media/")),
};
console.log("structural:", JSON.stringify(structural, null, 1));
console.log("backSample:", result.backSample.slice(0, 200));
await page.send("Target.closeTarget", { targetId });
browser.kill();
process.exit(0);
