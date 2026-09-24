// 1MB 档打开时长基准（G1 专用驱动）。
// 口径与 perf/md1011-open-ab.mjs 完全一致：点击文件树行 → 顶层块数连续 3 次
// 稳定 → openMs；长任务用同一 LONGTASK_RECORDER。差异仅在前置可靠性等待：
// md1011 版固定 sleep 4500ms 后点击，会话恢复（重活 2-4s）仍在进行时点击会被
// 切换遮罩吞掉（实测点开 224KB 旧档、1MB 行无响应）——本脚本等应用真正静置
// （无 .is-switching、树就绪、静置 800ms 无长任务）后才点击。
// 用法：MDITOR_DOC=1MB node perf/open-1mb.mjs [轮数=3] [标签=openbench]
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findPageTarget, Cdp, mouse, sleep, LONGTASK_RECORDER } from "./cdp.mjs";

const DOC_NAME = process.env.MDITOR_DOC ?? "1MB";
const rounds = Number(process.argv[2] ?? 3);
const label = process.argv[3] ?? "openbench";
const here = dirname(fileURLToPath(import.meta.url));

const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const m = mouse(cdp);
await cdp.send("Runtime.enable");
// 旁路 HTTP 缓存：dev 实例的 WebView 磁盘缓存可能留存旧 optimized chunk
// （vite chunk 名按模块集合哈希，内容变了名字不变——曾把打补丁前的
// math-flow 缓存成 ES 模块，制造过"整篇塌块"假回归）。基准必须跑在新代码上。
try {
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
} catch {
  /* Network 域不可用时退化 */
}

/** 应用是否已静置可交互（无切换遮罩 + 树就绪 + 稳定）。 */
const settled = () =>
  cdp.eval(`(() => {
    const switching = document.querySelector('.sidebar.is-switching, .app.is-switching');
    const rows = document.querySelectorAll('.ft-row.ft-file').length;
    const pm = document.querySelectorAll('.ProseMirror').length;
    return { switching: !!switching, rows, pm };
  })()`);

const rowPos = () =>
  cdp.eval(`(() => {
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

const results = [];
for (let i = 0; i < rounds; i++) {
  await cdp.send("Page.enable");
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(2000);
  // 静置等待：树就绪 + 无切换遮罩（上限 25s，1MB 会话恢复也要过）。
  let ok = false;
  for (let k = 0; k < 50; k++) {
    const s = await settled();
    if (s && s.rows >= 1 && !s.switching) {
      // 再等两个 250ms 周期确认块数稳定（恢复中的文档还在长任务里）。
      const b1 = await blocksNow();
      await sleep(250);
      const b2 = await blocksNow();
      await sleep(250);
      const b3 = await blocksNow();
      if (b1 === b2 && b2 === b3) {
        ok = true;
        break;
      }
    } else {
      await sleep(500);
    }
  }
  if (!ok) console.log(`round ${i + 1}: 警告 25s 未完全静置，继续测量`);
  const r = await rowPos();
  if (!r) throw new Error("file row not found: " + DOC_NAME);
  await lt.start();
  const t0 = Date.now();
  await m.click(r.x, r.y);
  let stable = 0;
  let last = -1;
  let stableMs = 0;
  while (stable < 3 && Date.now() - t0 < 120_000) {
    await sleep(250);
    const b = await blocksNow();
    if (b === last && b > 0) stable++;
    else stable = 0;
    last = b;
    stableMs = Date.now() - t0;
  }
  const ms = Date.now() - t0;
  const longtasks = await lt.stop();
  const lts = longtasks ?? [];
  const summary = {
    round: i + 1,
    openMs: ms,
    stableMs,
    blocks: last,
    longtasks: lts.length,
    ltMax: lts.length ? Math.max(...lts.map((e) => e.d)) : 0,
    ltTotal: lts.reduce((a, e) => a + e.d, 0),
    events: lts,
  };
  results.push(summary);
  console.log(
    `round ${i + 1}: open ${ms}ms (稳定于 ${stableMs}ms) blocks ${last} 长任务 ${lts.length}个 max ${summary.ltMax}ms 总 ${summary.ltTotal}ms`
  );
  await sleep(2000);
}

mkdirSync(join(here, "results"), { recursive: true });
const out = join(here, "results", `${label}.json`);
writeFileSync(out, JSON.stringify({ doc: DOC_NAME, rounds: results }, null, 1));
console.log(`已写入 ${out}`);
cdp.close();
