// 打开文档时抓异常/错误日志。
import { findPageTarget, Cdp, sleep, mouse } from "./cdp.mjs";

const t = await findPageTarget(9223);
const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
const logs = [];
cdp.on("Runtime.consoleAPICalled", (e) => {
  if (e.type === "debug" || e.type === "info") return;
  const txt = (e.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300);
  logs.push(`[console.${e.type}] ${txt}`);
});
cdp.on("Runtime.exceptionThrown", (e) => {
  const d = e.exceptionDetails;
  logs.push(`[exception] ${d.text} ${d.exception?.description ?? ""}`.slice(0, 500));
});
await cdp.send("Runtime.enable");

// 先切到未命名以外的干净态：直接点文件树里的目标文档
const row = await cdp.eval(`(() => {
  const hit = [...document.querySelectorAll(".ft-row.ft-file")].find(r => (r.querySelector(".ft-name")?.textContent ?? "").includes("一元微分"));
  if (!hit) return null;
  const r = hit.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);
const m = mouse(cdp);
await m.click(row.x, row.y);
await sleep(12000);
const state = await cdp.eval(`({
  blocks: document.querySelector('.ProseMirror')?.children.length ?? 0,
  big: document.querySelector('.mditor-editor-host')?.dataset.big !== undefined,
  placeholder: !!document.querySelector('.ProseMirror-placeholder, [data-placeholder]'),
})`);
console.log("state:", JSON.stringify(state));
console.log("--- logs during open ---");
for (const l of logs) console.log(l);
cdp.close();
