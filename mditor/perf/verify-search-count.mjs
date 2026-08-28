// Bug A 复验：SearchBar 计数对含「极限」215 次的文档是否正确计数。
// 阶段1 基准里 count=0 疑为读取竞态（防抖 200ms + 序列化 599ms ≈ 读点 800ms）。
// 本脚本：开 224KB 文档 → Ctrl+F → 输入「极限」→ 每 200ms 轮询计数 3s。
import { findPageTarget, Cdp, mouse, sleep } from "./cdp.mjs";

const t = await findPageTarget(9223);
const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
const m = mouse(cdp);

let tries = 0;
while (!(await cdp.eval(`!!document.querySelector('.ProseMirror')`).catch(() => false))) {
  if (++tries > 60) throw new Error("编辑器未就绪");
  await sleep(500);
}
// 打开 224KB 原始 fixture（极限出现 215 次）
let row = null;
for (let i = 0; i < 30 && !row; i++) {
  row = await cdp.eval(`(() => {
    const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes('CMC备战'));
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!row) await sleep(500);
}
await m.click(row.x, row.y);
await sleep(6000);

// Ctrl+F 开搜索栏
await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "f", code: "KeyF", windowsVirtualKeyCode: 70 });
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "f", code: "KeyF", windowsVirtualKeyCode: 70 });
await sleep(300);
const open = await cdp.eval(`!!document.querySelector('.sb-root input')`);
console.log("SearchBar 打开:", open);
if (!open) { cdp.close(); process.exit(1); }

// 输入「极限」并轮询计数
await cdp.eval(`(() => {
  const inp = document.querySelector('.sb-root input');
  inp.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(inp, '极限');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
const samples = [];
for (let i = 0; i < 15; i++) {
  await sleep(200);
  const c = await cdp.eval(`document.querySelector('.sb-count')?.textContent ?? '(无)'`);
  samples.push(`${i * 200 + 200}ms:${c}`);
}
console.log(samples.join(" | "));
const final = samples[samples.length - 1];
console.log(final.includes("0 个") ? "❌ 计数为 0——真 Bug" : "✅ 计数非 0——阶段1 的 0 为测量竞态");
cdp.close();
