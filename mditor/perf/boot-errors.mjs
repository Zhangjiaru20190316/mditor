// 全程启动错误抓取：attach → reload → 25s 全量 console/异常/overlay。
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const t = await findPageTarget(9223);
const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
const logs = [];
cdp.on("Runtime.consoleAPICalled", (e) => {
  if (e.type === "debug") return;
  const txt = (e.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 400);
  logs.push(`[console.${e.type}] ${txt}`);
});
cdp.on("Runtime.exceptionThrown", (e) => {
  const d = e.exceptionDetails;
  logs.push(`[exception] ${d.text} ${d.exception?.description ?? d.stackTrace?.map(f => f.functionName + "@" + f.url.split("/").slice(-1)[0] + ":" + f.lineNumber).join(" <- ") ?? ""}`.slice(0, 600));
});
await cdp.send("Runtime.enable");
await cdp.send("Log.enable").catch(() => {});

await cdp.eval("location.reload()");
await sleep(25000);
const state = await cdp.eval(`({
  blocks: document.querySelector('.ProseMirror')?.children.length ?? 0,
  overlay: !!document.querySelector('vite-error-overlay'),
  overlayText: document.querySelector('vite-error-overlay')?.textContent?.slice(0, 300) ?? null,
})`);
console.log("state:", JSON.stringify(state));
console.log("--- all captured ---");
for (const l of logs) console.log(l);
cdp.close();
