// RC-4 补充取证：切片对照定量 + 全量 15 分钟封顶重跑（日志即时落盘）。
// 前置：window.__rc4.full（23MB wrapHtml 产物）已在页面暂存（ex1-repro.mjs rc4 留下）。
// 产物：perf/results/ex-phase1-rc4b.json + ex-phase1-rc4b-slice10.pdf
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "results");
mkdirSync(outDir, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);

const has = await cdp.eval(`!!(window.__rc4 && window.__rc4.full)`);
if (!has) throw new Error("window.__rc4.full 不在——先跑 ex1-repro.mjs rc4");
const totalBlocks = await cdp.eval(`(() => {
  const dp = new DOMParser();
  const doc = dp.parseFromString(window.__rc4.full, 'text/html');
  return { blocks: doc.body.children.length, kb: Math.round(window.__rc4.full.length / 1024) };
})()`);
log("stash:", JSON.stringify(totalBlocks));

// ---- 切片 10%：DOMParser 取前 10% 顶层块 ------------------------------------
const sliceFile = "ex-phase1-rc4b-slice10.html";
const sliceInfo = await cdp.eval(`(() => {
  const dp = new DOMParser();
  const doc = dp.parseFromString(window.__rc4.full, 'text/html');
  const n = Math.ceil(doc.body.children.length / 10);
  const keep = [...doc.body.children].slice(0, n);
  doc.body.replaceChildren(...keep);
  window.__rc4.slice10 = '<!DOCTYPE html>' + doc.documentElement.outerHTML;
  return { blocks: n, kb: Math.round(window.__rc4.slice10.length / 1024) };
})()`);
log("slice10:", JSON.stringify(sliceInfo));

// 切片落盘（分块回读）
{
  const totalLen = await cdp.eval(`window.__rc4.slice10.length`);
  const chunks = [];
  for (let i = 0; i < totalLen; i += 1_000_000) {
    chunks.push(await cdp.eval(`window.__rc4.slice10.slice(${i}, ${Math.min(i + 1_000_000, totalLen)})`, { returnByValue: true }));
  }
  writeFileSync(join(outDir, sliceFile), Buffer.from(chunks.join(""), "utf8"));
}

/** 对指定 @fs HTML 文件跑 printToPDF，返回 {pages, ms} 或 {error, ms}。 */
async function printFile(htmlFile, pdfFile, boundMs) {
  const url = `http://127.0.0.1:1420/@fs/C:/Users/hh/Desktop/Tp/mditor/perf/results/${htmlFile}`;
  const created = await cdp.send("Target.createTarget", { url });
  await sleep(5000);
  const list = await (await fetch("http://127.0.0.1:9223/json")).json();
  const aux = list.find((t) => t.id === created.targetId);
  if (!aux) return { error: "aux target gone", url };
  const cdp2 = await Cdp.connect(aux.webSocketDebuggerUrl);
  await cdp2.send("Page.enable");
  const t0 = Date.now();
  let out;
  try {
    const r = await Promise.race([
      cdp2.send("Page.printToPDF", {
        printBackground: true, paperWidth: 8.27, paperHeight: 11.69,
        marginTop: 0.394, marginBottom: 0.394, marginLeft: 0.394, marginRight: 0.394, scale: 1,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("BOUND_TIMEOUT")), boundMs)),
    ]);
    const buf = Buffer.from(r.data, "base64");
    writeFileSync(join(outDir, pdfFile), buf);
    const latin = buf.toString("latin1");
    const pages = (latin.match(/\/Type\s*\/Page[^s]/g) || []).length;
    const countMatch = latin.match(/\/Count\s+(\d+)/);
    out = { ms: Date.now() - t0, bytes: buf.length, pageObjects: pages, countNode: countMatch ? Number(countMatch[1]) : null };
  } catch (e) {
    out = { error: String(e).slice(0, 200), ms: Date.now() - t0 };
  }
  try { await cdp.send("Target.closeTarget", { targetId: created.targetId }); } catch { /* best-effort */ }
  cdp2.close();
  await sleep(2000);
  return out;
}

// ---- 1) 10% 切片打印（封顶 5 分钟）------------------------------------------
log("print slice10 ...");
const slicePdf = await printFile(sliceFile, "ex-phase1-rc4b-slice10.pdf", 300_000);
log("slice10 pdf:", JSON.stringify(slicePdf));

// ---- 2) 全量重跑（封顶 15 分钟）----------------------------------------------
log("print full (bound 15min) ...");
const fullPdf = await printFile("ex-phase1-rc4-1mb.html", "ex-phase1-rc4b-full.pdf", 900_000);
log("full pdf:", JSON.stringify(fullPdf));

writeFileSync(join(outDir, "ex-phase1-rc4b.json"), JSON.stringify({
  when: new Date().toISOString(),
  stash: totalBlocks, slice: sliceInfo, slicePdf, fullPdf,
  note: "全量首跑（ex1-repro.mjs rc4，Target.createTarget 版）23 分钟无返回被杀，本表 fullPdf 为 15 分钟封顶重跑",
}, null, 2));
cdp.close();
