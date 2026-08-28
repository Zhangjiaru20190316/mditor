// 辅助：在当前 dev 实例里从文件树打开指定文档并等内容稳定。
// 用法：node perf/open-doc.mjs <文档名包含串> [等待ms]
import { findPageTarget, Cdp, mouse, sleep } from "./cdp.mjs";

const name = process.argv[2] ?? "1MB压测副本";
const waitMs = Number(process.argv[3] ?? 15000);

const t = await findPageTarget(9223);
const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
const m = mouse(cdp);

let tries = 0;
while (!(await cdp.eval(`!!document.querySelector('.ProseMirror')`).catch(() => false))) {
  if (++tries > 60) throw new Error("编辑器未就绪");
  await sleep(500);
}
let row = null;
for (let i = 0; i < 30 && !row; i++) {
  row = await cdp.eval(`(() => {
    const hit = [...document.querySelectorAll('.ft-row.ft-file')].find(r => (r.querySelector('.ft-name')?.textContent ?? '').includes('${name}'));
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!row) await sleep(500);
}
if (!row) throw new Error("文件树里找不到 " + name);
await m.click(row.x, row.y);
await sleep(waitMs);
const n = await cdp.eval(`document.querySelector('.ProseMirror')?.children.length ?? 0`);
console.log("opened, blocks:", n);
cdp.close();
