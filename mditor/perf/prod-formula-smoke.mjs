// 打包版公式渲染冒烟：启动 target/release/mditor.exe（CDP 9222）→ 逐键输入
// 块公式 → Enter → 校验 .katex 真身渲染（CSP nonce 根修 6bc1517 的打包验证）。
// 只输入不保存（杀进程即丢弃，不落盘）。
import { findPageTarget, Cdp, sleep, typeText } from "./cdp.mjs";
import { writeFileSync } from "node:fs";

const t = await findPageTarget(9222);
const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
await cdp.eval(`(() => { const pm = document.querySelector(".ProseMirror"); pm.focus(); return !!pm; })()`);
await sleep(300);
await typeText(cdp, "$$c=\sqrt{a^2+b^2}$$", { delay: 40 });
await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await sleep(1500);
const info = await cdp.eval(`({
  katex: document.querySelectorAll(".katex").length,
  blockMath: document.querySelectorAll("[data-type=math], .math-flow, .katex-display").length,
  text: document.querySelector(".ProseMirror")?.textContent?.slice(0, 60)
})`);
console.log("formula smoke:", JSON.stringify(info));
const ss = await cdp.send("Page.captureScreenshot", { format: "png" });
writeFileSync("perf/results/prod-4180-formula.png", Buffer.from(ss.data, "base64"));
cdp.close();
