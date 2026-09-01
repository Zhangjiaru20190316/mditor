// MD-1011 修复的打开时长 A/B：仅跑 baseline.mjs 的 open 场景（reload → 文件树
// 点击 → 内容稳定），用于同机同负载下对比修复前后（排除后台负载漂移）。
// 用法：MDITOR_DOC="CMC备战" node perf/md1011-open-ab.mjs [轮数]
import { findPageTarget, Cdp, mouse, sleep, LONGTASK_RECORDER } from "./cdp.mjs";

const DOC_NAME = process.env.MDITOR_DOC ?? "CMC备战";
const rounds = Number(process.argv[2] ?? 3);

const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);
await cdp.send("Runtime.enable");

const rowPos = () => cdp.eval(`(() => {
  const rows = [...document.querySelectorAll('.ft-row.ft-file')];
  const hit = rows.find((row) =>
    (row.querySelector('.ft-name')?.textContent ?? '').includes('${DOC_NAME}')
  );
  if (!hit) return null;
  hit.scrollIntoView({ block: 'center' });
  const rc = hit.getBoundingClientRect();
  return { x: Math.round(rc.x + 80), y: Math.round(rc.y + rc.height / 2) };
})()`);

const blocksNow = () =>
  cdp.eval(`document.querySelector('.ProseMirror')?.children.length ?? 0`);

const lt = {
  start: async () => {
    await cdp.eval(LONGTASK_RECORDER);
    await cdp.eval("window.__ltRecorder.start()");
  },
  stop: async () => (await cdp.eval("window.__ltRecorder.stop()")).events,
};
for (let i = 0; i < rounds; i++) {
  await cdp.send("Page.enable");
  await cdp.send("Page.reload");
  await sleep(4500); // 启动 + 会话恢复 + 文件树就绪
  const r = await rowPos();
  if (!r) throw new Error("file row not found");
  await lt.start();
  const t0 = Date.now();
  await m.click(r.x, r.y);
  // 轮询顶层块数稳定（与 baseline.mjs open 场景同口径）。
  let stable = 0;
  let last = -1;
  while (stable < 3 && Date.now() - t0 < 30_000) {
    await sleep(250);
    const b = await blocksNow();
    if (b === last && b > 0) stable++;
    else stable = 0;
    last = b;
  }
  const ms = Date.now() - t0;
  const longtasks = await lt.stop();
  console.log(`round ${i + 1}: open ${ms}ms blocks ${last} longtasks ${JSON.stringify(longtasks)}`);
  await sleep(1500);
}
