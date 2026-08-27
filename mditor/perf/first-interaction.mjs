// 首交互阶梯实验：boot → 滚动定位 → 静置 → 依次触发
//   ① .ProseMirror.focus()（纯焦点） ② mousedown（不 up）③ mouseup（成单击）
//   ④ 再点一次（对照）
// 每步之间收集 PerformanceObserver longtask，定位 1.4s 全款由哪一步触发。
import { findPageTarget, Cdp, sleep, LONGTASK_RECORDER } from "./cdp.mjs";

const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
await cdp.eval(LONGTASK_RECORDER);

const between = await (async () => {
  await cdp.eval("window.__ltRecorder.start()");
  const r = await cdp.eval(`(() => {
    const pm = document.querySelector('.ProseMirror');
    const host = document.querySelector('.mditor-editor-host');
    const k = pm.children[900];
    host.scrollTop = Math.max(0, k.offsetTop - 150);
    return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
      const rc = k.getBoundingClientRect();
      res({ x: Math.round(rc.x + Math.min(rc.width / 2, 300)), y: Math.round(rc.y + Math.min(rc.height / 2, 120)) });
    })));
  })()`);
  await sleep(3000);
  return r;
})();

const report = async (label) => {
  const { events } = await cdp.eval("window.__ltRecorder.stop()");
  const sum = (events ?? []).reduce((s, e) => s + e.d, 0);
  const top = (events ?? []).slice(0, 3).map((e) => e.d + "ms").join(", ");
  console.log(`${label}: longtasks=${(events ?? []).length} total=${sum}ms ${top}`);
  await cdp.eval("window.__ltRecorder.start()");
};

console.log("pos:", between);
await report("settle");

// ① 纯 focus
await cdp.eval(`document.querySelector('.ProseMirror').focus({ preventScroll: true })`);
await sleep(1200);
await report("focus()");

// ② mousedown only
await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: between.x, y: between.y, button: "left", clickCount: 1 });
await sleep(1200);
await report("mousedown");

// ③ mouseup → 完整单击
await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: between.x, y: between.y, button: "left", clickCount: 1 });
await sleep(1500);
await report("mouseup(click)");

// ④ 第二次点击（对照）
await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: between.x + 60, y: between.y, button: "left", clickCount: 1 });
await sleep(150);
await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: between.x + 60, y: between.y, button: "left", clickCount: 1 });
await sleep(1500);
await report("second click");

cdp.close();
