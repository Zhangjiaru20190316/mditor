// 读 sysDebug 事件明细：file:write-slow 的真实数据 + 长任务期间的写盘节奏。
import { findPageTarget, Cdp } from "./cdp.mjs";

const t = await findPageTarget(9223);
const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
const evts = await cdp.eval(
  `window.__sysDebug.events().filter(e => e.type === 'file:write-slow' || e.type === 'file:write-fail').map(e => JSON.stringify(e.data))`
);
console.log(`file:write-slow/fail 共 ${evts.length} 条:`);
for (const e of evts) console.log(" ", e);
const all = await cdp.eval(
  `window.__sysDebug.events().filter(e => e.type.startsWith('io.')).slice(-10).map(e => e.type + ' ' + JSON.stringify(e.data))`
);
console.log("最近 io 事件:");
for (const e of all) console.log(" ", e);
cdp.close();
