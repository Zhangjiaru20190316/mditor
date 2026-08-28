// 冷启动（前端链路）测量：reload → 读 buffered navigation/paint/longtask
// 条目 + 轮询里程碑（首屏闪屏淡出、编辑器 .ProseMirror 出现）。
//
// 口径（dev 实例，含 vite dev server 与 React 开发版开销——绝对值仅供
// 趋势与相对对比，跨时段漂移纪律适用；若发现杠杆需 release 复测）：
//   navStart→FCP / →DOMContentLoaded / →loadEnd  （navigation & paint 条目）
//   首个 .ProseMirror 出现的 performance.now()（100ms 轮询上界）
//   #splash 加 .is-done 的 performance.now()（App 就绪 + min 450ms 补足）
//   boot 期长任务清单（buffered longtask）
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROUNDS = Number(process.env.ROUNDS ?? 3);
const target = await findPageTarget(9223);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected:", target.url);

const POLL_WATCHER = `(() => {
  if (window.__bootWatch) return 'already';
  const t0 = performance.now();
  const state = { pm: 0, splashDone: 0, loadEnd: 0 };
  window.__bootWatch = { state,
    start() {
      const tick = () => {
        if (!state.pm && document.querySelector('.ProseMirror')) state.pm = Math.round(performance.now());
        const sp = document.getElementById('splash');
        if (!state.splashDone && (!sp || sp.classList.contains('is-done'))) state.splashDone = Math.round(performance.now());
        if (!state.loadEnd) { const n = performance.getEntriesByType('navigation')[0]; if (n && n.loadEventEnd > 0) state.loadEnd = Math.round(n.loadEventEnd); }
        if (state.pm && state.splashDone && state.loadEnd) return;
        setTimeout(tick, 100);
      };
      tick();
    },
    read() { return { ...state, now: Math.round(performance.now()) }; },
  };
  return 'installed';
})()`;

const BOOT_METRICS = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const paints = performance.getEntriesByType('paint');
  const fcp = paints.find(p => p.name === 'first-contentful-paint');
  // longtask 不支持 getEntriesByType 直读，需要 observer + buffered
  return new Promise((resolve) => {
    const lts = [];
    let obs;
    try {
      obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) lts.push({ t: Math.round(e.startTime), d: Math.round(e.duration) }); });
      obs.observe({ type: 'longtask', buffered: true });
    } catch { /* longtask 不支持 buffered 时置空 */ }
    setTimeout(() => { obs?.disconnect(); resolve({
      nav: nav ? { dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), ttfb: Math.round(nav.responseStart), respEnd: Math.round(nav.responseEnd), transfer: Math.round(nav.transferSize) } : null,
      fcp: fcp ? Math.round(fcp.startTime) : null,
      longtasks: lts,
    }); }, 250);
  });
})()`;

const results = [];
for (let i = 0; i < ROUNDS; i++) {
  await cdp.eval("location.reload()");
  // reload 会断开 evaluate 上下文，等新文档出现
  await sleep(400);
  let tries = 0;
  while ((await cdp.eval("document.readyState").catch(() => null)) !== "complete") {
    if (++tries > 100) throw new Error("reload 未完成");
    await sleep(100);
  }
  // 装里程碑轮询器（此时可能已过 pm/splash 里程碑——轮询器读到的是当下时刻，作上界）
  await cdp.eval(POLL_WATCHER);
  await cdp.eval("window.__bootWatch.start()");
  // 等里程碑齐（编辑器 + splash + loadEnd）
  let w = null;
  for (let k = 0; k < 120; k++) {
    w = await cdp.eval("window.__bootWatch.read()");
    if (w && w.pm && w.splashDone && w.loadEnd) break;
    await sleep(250);
  }
  const m = await cdp.eval(BOOT_METRICS);
  results.push({ round: i + 1, ...w, ...m });
  console.log(`round ${i + 1}:`, JSON.stringify({ ...w, fcp: m.fcp, nav: m.nav, ltN: m.longtasks.length, ltMax: Math.max(0, ...m.longtasks.map((e) => e.d)) }));
  await sleep(800);
}

const pick = (key) => results.map((r) => r[key]).filter(Boolean).sort((a, b) => a - b);
const med = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null);
console.log("\n=== 汇总（中位） ===");
for (const k of ["fcp", "dcl", "load", "pm", "splashDone"]) {
  const src = k === "dcl" || k === "load" ? results.map((r) => r.nav?.[k]).filter(Boolean) : pick(k === "load" ? "loadEnd" : k);
  console.log(`${k}: ${med(src)}ms  (all: ${src.join(", ")})`);
}
const allLt = results.flatMap((r) => r.longtasks.map((e) => e.d));
console.log(`boot 期长任务: n=${allLt.length} max=${Math.max(0, ...allLt)}ms over200=${allLt.filter((d) => d > 200).length}`);
cdp.close();
