// 探针：3 次击键期间 .ProseMirror 的 childList 变更规模——
// 局部编辑应只见 1~2 个段落级重写；全文档替换事务会显示成千上万节点变更。
import { findPageTarget, Cdp, mouse, sleep, typeText } from "./cdp.mjs";

const t = await findPageTarget(9223);
const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
const m = mouse(cdp);

// 定位第 700 块并点入
const r = await cdp.eval(`(() => {
  const pm = document.querySelector('.ProseMirror');
  const host = document.querySelector('.mditor-editor-host');
  const k = pm.children[700];
  host.scrollTop = Math.max(0, k.offsetTop - 150);
  return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
    const rc = k.getBoundingClientRect();
    res({ x: Math.round(rc.x + Math.min(rc.width / 2, 300)), y: Math.round(rc.y + Math.min(rc.height / 2, 120)) });
  })));
})()`);
await m.click(r.x, r.y);
await sleep(1500);

await cdp.eval(`(() => {
  window.__moStats = { childList: 0, added: 0, removed: 0, characterData: 0, batches: [] };
  const pm = document.querySelector('.ProseMirror');
  let cur = null;
  const flush = () => { if (cur) { window.__moStats.batches.push(cur); cur = null; } };
  const mo = new MutationObserver((muts) => {
    for (const mu of muts) {
      if (!cur) cur = { childList: 0, added: 0, removed: 0, characterData: 0 };
      if (mu.type === 'childList') { cur.childList++; cur.added += mu.addedNodes.length; cur.removed += mu.removedNodes.length; }
      else cur.characterData++;
    }
    clearTimeout(window.__moT);
    window.__moT = setTimeout(flush, 60);
  });
  mo.observe(pm, { childList: true, characterData: true, subtree: true });
  window.__moDisconnect = () => { flush(); mo.disconnect(); return window.__moStats; };
  return 'observer on';
})()`);

await typeText(cdp, "甲乙丙", { delay: 150 });
await sleep(400);

const stats = await cdp.eval("window.__moDisconnect()");
console.log("3 键的 DOM 变更批次:");
for (const b of stats.batches) console.log(" ", JSON.stringify(b));
console.log("合计:", JSON.stringify({ childList: stats.batches.reduce((s,b)=>s+b.childList,0), added: stats.batches.reduce((s,b)=>s+b.added,0), removed: stats.batches.reduce((s,b)=>s+b.removed,0), characterData: stats.batches.reduce((s,b)=>s+b.characterData,0) }));
cdp.close();
