// 阶段1摸底：导出管线 / 文档内搜索 / Ctrl+S 保存 的主线程阻塞测量。
// 前置：dev 实例已打开 1MB 压测副本（cv 开）。
// 口径：
//   search-in-doc : Ctrl+F 聚焦 → 输入 2 字 → 防抖 200ms 后的计数任务时长
//                   （getMarkdown 全文序列化 + regex 全文扫描）+ 窗口长任务
//   save-ctrls    : Ctrl+S → 序列化 + 写盘的长任务与 io 计时（sysDebug）
//   export-stages : 直接计时 App 导出管线的各重活（对真实编辑器 HTML）：
//                   renderBlockMath / juice / htmlToDocx / rasterize(子集×外推)
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const t = await findPageTarget(9223);
const cdp = await Cdp.connect(t.webSocketDebuggerUrl);

async function withLongtasks(name, fn) {
  await cdp.eval(`(window.__lt = { list: [], t0: performance.now(), obs: new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.list.push({ t: Math.round(e.startTime - window.__lt.t0), d: Math.round(e.duration) }); }) }).obs.observe({ entryTypes: ['longtask'] })`);
  const r = await fn();
  const lts = await cdp.eval(`(window.__lt.obs.disconnect(), window.__lt.list)`);
  console.log(`${name}:`, JSON.stringify(r), "| 长任务:", lts.length + "个 max " + Math.max(0, ...lts.map((e) => e.d)) + "ms");
  return r;
}

// ---- 1) 文档内搜索 -----------------------------------------------------------
{
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "f", code: "KeyF", windowsVirtualKeyCode: 70 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "f", code: "KeyF", windowsVirtualKeyCode: 70 });
  await sleep(300);
  const open = await cdp.eval(`!!document.querySelector('.sb-root input')`);
  if (open) {
    await withLongtasks("search-in-doc(2字+防抖计数)", async () => {
      const t0 = Date.now();
      await cdp.eval(`(() => {
        const inp = document.querySelector('.sb-root input');
        inp.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(inp, '极限');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return 'typed';
      })()`);
      await sleep(800); // 200ms 防抖 + 计数任务
      const count = await cdp.eval(`document.querySelector('.sb-count')?.textContent ?? ''`);
      return { wallMs: Date.now() - t0, count };
    });
    await cdp.eval(`document.querySelector('.sb-close')?.click()`);
  } else {
    console.log("search-in-doc: SearchBar 未打开（快捷键未生效），跳过");
  }
}

// ---- 2) Ctrl+S 保存 ----------------------------------------------------------
{
  await withLongtasks("save-ctrls(序列化+写盘)", async () => {
    const before = await cdp.eval(`window.__sysDebug.counters()['io.ms.file:write'] ?? 0`);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "s", code: "KeyS", windowsVirtualKeyCode: 83 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "s", code: "KeyS", windowsVirtualKeyCode: 83 });
    await sleep(2500);
    const after = await cdp.eval(`window.__sysDebug.counters()['io.ms.file:write'] ?? 0`);
    return { writeMsDelta: after - before };
  });
}

// ---- 3) 导出管线各阶段（临时探针 src/lib/exporterProbe.ts）---------------------
{
  const r = await withLongtasks("export-stages(1MB 全文)", async () => {
    return await cdp.eval(
      "(async () => {" +
      "  const html0 = document.querySelector('.ProseMirror').innerHTML;" +
      "  const out = { liveHtmlKB: Math.round(html0.length / 1024) };" +
      "  const { probeExportStages } = await import('/src/lib/exporterProbe.ts');" +
      "  const r = await probeExportStages(html0);" +
      "  return Object.assign(out, r);" +
      "})()",
      { awaitPromise: true }
    );
  });
  console.log("export-stages:", JSON.stringify(r, null, 2));
}

cdp.close();
