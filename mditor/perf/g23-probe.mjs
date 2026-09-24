// G3 探针：打字 → 停顿窗（监听器序列化 200ms+rIC + cv 重建 1.2s + S1 预热）
// 内的 >50ms 长任务计数与 max。前置：dev 实例已打开 1MB 文档（cv 档）。
import { findPageTarget, Cdp, mouse, sleep, typeText, LONGTASK_RECORDER } from "./cdp.mjs";

const t = await findPageTarget(9223);
const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
const m = mouse(cdp);
await cdp.send("Runtime.enable");

// 等文档就绪
let blocks = 0;
for (let k = 0; k < 60; k++) {
  blocks = await cdp.eval(`document.querySelector('.ProseMirror')?.children.length ?? 0`);
  if (blocks > 1000) break;
  await sleep(500);
}
console.log("blocks:", blocks);

// 点入第 700 块
const r = await cdp.eval(`(() => {
  const pm = document.querySelector('.ProseMirror');
  const host = document.querySelector('.mditor-editor-host');
  const k = pm.children[700];
  host.scrollTop = Math.max(0, k.offsetTop - 150);
  const rc = k.getBoundingClientRect();
  return { x: Math.round(rc.x + Math.min(rc.width / 2, 300)), y: Math.round(rc.y + Math.min(rc.height / 2, 120)) };
})()`);
await m.click(r.x, r.y);
await sleep(2000);

// 长任务记录 + 打字 12 字 + 停顿窗 3s
await cdp.eval(LONGTASK_RECORDER);
await cdp.eval("window.__ltRecorder.start()");
const t0 = Date.now();
await typeText(cdp, "打字基准测试abc123", { delay: 90 });
await sleep(3000); // 停顿窗：监听器(200ms+rIC) + cv 重建(1.2s 防抖→分片) + S1 预热
const events = (await cdp.eval("window.__ltRecorder.stop()"))?.events ?? [];
const lts = (events ?? []).filter((e) => e.d > 50);
console.log(
  `G3 打字+停顿窗(${Math.round((Date.now() - t0) / 1000)}s): >50ms 长任务 ${lts.length} 个, max ${lts.length ? Math.max(...lts.map((e) => e.d)) : 0}ms`
);
console.log("长任务明细:", JSON.stringify(lts));

// 撤销打字（防 fixture 污染）
for (let i = 0; i < 14; i++) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90 });
  await sleep(60);
}
console.log("已撤销打字");
cdp.close();
