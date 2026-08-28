// 生产 bundle 冷启动测量：在 dev 实例的 WebView 里 Target.createTarget
// 打开 vite preview（4319）上的生产构建。应用 JS 会因无 Tauri IPC 而早退
// （ErrorBoundary 接管），但 bundle 的拉取/解析/求值时序（FCP/DCL/load/
// longtask）在报错前即已完成——量化「生产 chunk 求值成本」这一 dev 测不到
// 的部分。测完即关标签页。
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const PORT = Number(process.env.PREVIEW_PORT ?? 4319);
const ROUNDS = Number(process.env.ROUNDS ?? 3);

// 浏览器级 CDP（Target.createTarget 需要 browser endpoint，不是 page 的）
const version = await (await fetch(`http://127.0.0.1:9223/json/version`)).json();
const bcdp = await Cdp.connect(version.webSocketDebuggerUrl);

const results = [];
for (let i = 0; i < ROUNDS; i++) {
  const { targetId } = await bcdp.send("Target.createTarget", { url: `http://127.0.0.1:${PORT}/` });
  const list = await (await fetch(`http://127.0.0.1:9223/json`)).json();
  const page = list.find((t) => t.id === targetId);
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  // 等 load 完成 + 稍等求值余波
  let tries = 0;
  while ((await cdp.eval("document.readyState").catch(() => null)) !== "complete") {
    if (++tries > 200) throw new Error("preview 页未完成加载");
    await sleep(100);
  }
  await sleep(1200);
  const m = await cdp.eval(`(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByType('paint').find(p => p.name === 'first-contentful-paint');
    // 资源时序：脚本总传输与最大脚本
    const res = performance.getEntriesByType('resource').filter(r => r.initiatorType === 'script' || r.name.endsWith('.js'));
    const jsBytes = res.reduce((s, r) => s + (r.transferSize || 0), 0);
    const jsDur = res.reduce((s, r) => s + r.duration, 0);
    const top = res.slice().sort((a,b) => b.duration - a.duration).slice(0,4).map(r => ({ n: r.name.split('/').pop(), ms: Math.round(r.duration), kb: Math.round((r.transferSize||0)/1024) }));
    return new Promise((resolve) => {
      const lts = [];
      let obs;
      try { obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) lts.push({ t: Math.round(e.startTime), d: Math.round(e.duration) }); }); obs.observe({ type: 'longtask', buffered: true }); } catch {}
      setTimeout(() => { obs?.disconnect(); resolve({
        dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd),
        fcp: fcp ? Math.round(fcp.startTime) : null, jsFiles: res.length, jsKb: Math.round(jsBytes/1024), jsFetchMs: Math.round(jsDur),
        longtasks: lts, top,
      }); }, 250);
    });
  })()`);
  // 页面是否已报错（预期：Tauri API 不可用）
  const errored = await cdp.eval(`!!document.querySelector('.error-boundary, [class*="error"]') || document.body.innerText.length < 50`).catch(() => null);
  results.push(m);
  console.log(`round ${i+1}:`, JSON.stringify({ ...m, longtasks: m.longtasks.length + "个/max" + Math.max(0, ...m.longtasks.map(e=>e.d)), errored }));
  await bcdp.send("Target.closeTarget", { targetId });
  await sleep(600);
}

const med = (arr) => [...arr].sort((a,b)=>a-b)[Math.floor(arr.length/2)];
console.log("\n=== 生产 bundle 冷启动汇总 ===");
console.log(`FCP: ${med(results.map(r=>r.fcp))}ms  DCL: ${med(results.map(r=>r.dcl))}ms  load: ${med(results.map(r=>r.load))}ms  JS拉取合计: ${med(results.map(r=>r.jsFetchMs))}ms (${med(results.map(r=>r.jsKb))}KB, ${results[0].jsFiles}个文件)`);
const allLt = results.flatMap(r=>r.longtasks);
console.log(`boot 期长任务: n=${allLt.length} max=${Math.max(0,...allLt.map(e=>e.d))}ms over200=${allLt.filter(e=>e.d>200).length}`);
console.log("最大脚本:", JSON.stringify(results[0].top));
bcdp.close();
