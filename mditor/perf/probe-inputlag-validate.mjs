// D4 探针验证 v2：e.timeStamp 打点后，两个场景都要过——
//   场景1：keydown 后同任务阻塞（旧行为兼容，~200ms）
//   场景2：keydown 被已运行的长任务排队（新增覆盖，预期 ~300ms+；旧探针测 ~0）
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");

const state = () => cdp.eval(`window.__scrollDebug ? window.__scrollDebug.frameStats() : null`);

// 等待 HMR 后的探针稳定（避免读到热更新间隙）
await sleep(1500);

const before = await state();
console.log("before:", JSON.stringify(before));

// 场景 1：keydown 后立刻同任务阻塞 200ms
await cdp.eval(`(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  const t0 = performance.now();
  while (performance.now() - t0 < 200) { /* busy block */ }
})()`);
await sleep(300);
const after1 = await state();
const d1 = { lag: after1.worstInputLagMs - before.worstInputLagMs, ev: after1.inputLagEvents - before.inputLagEvents };
console.log("场景1(同任务阻塞): Δlag=" + d1.lag.toFixed(1) + "ms Δevents=" + d1.ev);

// 场景 2：受信任按键被已运行的长任务排队（新探针应测到排队延迟）
const s2 = await cdp.eval(`(() => {
  const t0 = performance.now();
  setTimeout(() => { while (performance.now() - t0 < 500) { /* 500ms 长 */ } }, 0);
  return 'armed';
})()`);
if (s2 !== "armed") throw new Error("arm failed");
// 立刻派发受信任 keydown：IPC 到达时页面大概率已进入 500ms 阻塞 → 事件排队
await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "x", text: "x", unmodifiedText: "x", code: "KeyX", windowsVirtualKeyCode: 88 });
await sleep(900);
const after2 = await state();
const d2 = { lag: after2.worstInputLagMs - after1.worstInputLagMs, ev: after2.inputLagEvents - after1.inputLagEvents };
console.log("场景2(排队型): Δlag=" + d2.lag.toFixed(1) + "ms Δevents=" + d2.ev);
console.log(d2.lag > 100 ? "PASS: 排队型输入延迟被测到（旧探针盲区已覆盖）" : "检查: 排队场景 lag=" + d2.lag.toFixed(1) + "（<100 可能是按键赶在阻塞前处理了，重跑一次看分布）");
cdp.close();
