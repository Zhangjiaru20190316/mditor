// D1 正确性快检：viewport-only 模式下 跨视口全选 / 查找 / 大纲跳转。
import { findPageTarget, Cdp, sleep, mouse } from "./cdp.mjs";

const t = await findPageTarget(9223);
const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
const m = mouse(cdp);

// 1) Ctrl+A 跨视口全选 → 选区字数应 ≈ 全文（c-v 跳过的块按需渲染）
await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
await sleep(1500);
const selLen = await cdp.eval("getSelection().toString().length");
const docLen = await cdp.eval("document.querySelector('.ProseMirror').textContent.length");
console.log(`1) Ctrl+A: selected=${selLen} vs docText=${docLen} -> ${selLen >= docLen * 0.95 ? "PASS" : "FAIL"}`);
await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(300);

// 2) 大纲跳转：点大纲面板中后部一个标题，验证滚动落点
const outlineItem = await cdp.eval(`(() => {
  const items = [...document.querySelectorAll('.ol-item, [class*="ol-"] li, .outline li')];
  if (!items.length) return null;
  const it = items[Math.floor(items.length * 0.7)];
  const r = it.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: it.textContent.slice(0, 20) };
})()`);
if (outlineItem) {
  await m.click(outlineItem.x, outlineItem.y);
  await sleep(1800);
  const vis = await cdp.eval(`(() => {
    const host = document.querySelector('.mditor-editor-host');
    const h = [...document.querySelectorAll('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3')];
    const vh = host.clientHeight;
    let found = null;
    for (const el of h) { const r = el.getBoundingClientRect(); const hr = host.getBoundingClientRect(); if (r.top > hr.top && r.bottom < hr.bottom) { found = el.textContent.slice(0, 20); break; } }
    return { scrollTop: Math.round(host.scrollTop), headingInView: found };
  })()`);
  console.log(`2) outline jump: target="${outlineItem.label}" -> inView="${vis.headingInView}" scrollTop=${vis.scrollTop} -> ${vis.scrollTop > 5000 ? "PASS(jumped)" : "CHECK"}`);
} else {
  console.log("2) outline: no items found (panel closed?) — SKIP");
}

// 3) 查找 Ctrl+F：搜正文词，验证命中与跳转
await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "f", code: "KeyF", windowsVirtualKeyCode: 70 });
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "f", code: "KeyF", windowsVirtualKeyCode: 70 });
await sleep(600);
const findInput = await cdp.eval(`(() => {
  const inp = document.querySelector('.find-input, input[type="text"], .find input');
  if (!inp) return null;
  const r = inp.getBoundingClientRect();
  return { x: Math.round(r.x + 10), y: Math.round(r.y + r.height / 2), cls: inp.className.slice(0, 30) };
})()`);
if (findInput) {
  await m.click(findInput.x, findInput.y);
  await sleep(200);
  await cdp.send("Input.insertText", { text: "极限" });
  await sleep(1500);
  const findState = await cdp.eval(`(() => {
    const marks = document.querySelectorAll('.find-hit, [class*="find"], mark');
    const txt = document.querySelector('.find-count, .find-status')?.textContent ?? '';
    return { marks: marks.length, status: txt.slice(0, 40) };
  })()`);
  console.log(`3) find "极限": marks=${findState.marks} status="${findState.status}"`);
} else {
  console.log("3) find: input not found — SKIP");
}
await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
cdp.close();
