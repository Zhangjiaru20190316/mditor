// DX 阶段一活体复现（观测，不修代码）：在真实 WebView2 页面上下文里
// 动态 import @turbodocx/html-to-docx（vite 按 browser 条件解析到
// browser.esm.js——与用户导出走同一份构建），喂分级输入，捕获报错原文
// 与完整堆栈。同时监听 Runtime.exceptionThrown 抓未被 eval try/catch 的崩溃。
//
// 前置：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npm run tauri dev
// 用法：node perf/ex-dx-repro-docx.mjs [输入档：text|img|editor|demo]
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const which = process.argv[2] ?? "all";
const t = await findPageTarget(9223);
const cdp = await Cdp.connect(t.webSocketDebuggerUrl);

// ---- console / 异常监听（ground truth 堆栈来源）----------------------------
const exceptions = [];
await cdp.send("Runtime.enable");
cdp.on("Runtime.exceptionThrown", (p) => {
  const d = p.exceptionDetails;
  exceptions.push({
    text: d.text,
    exception: d.exception?.description ?? "",
    url: d.url,
    line: d.lineNumber,
  });
});

// ---- 页面侧驱动函数 ---------------------------------------------------------
// 输入档案：text=钉子测试同款纯文本；img=dataURL 图；editor=当前编辑器真实
// getHTML 产物（App 导出同源）；demo=demo.md 全语料（若已打开）。
const DRIVER = `(async ([which, opts]) => {
  const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  let html = null;
  if (which === "text") html = '<html><body><p>前</p><p>hello 中文</p><p>后</p></body></html>';
  if (which === "img") html = '<html><body><p>前</p><p><img src="' + TINY_PNG + '" width="320" height="240" /></p><p>后</p></body></html>';
  if (which === "editor") {
    const ed = document.querySelector('.ProseMirror');
    if (!ed) return { skipped: "编辑器不在位（无文档？）" };
    html = '<html><body>' + ed.innerHTML + '</body></html>';
  }
  if (which === "demo") {
    // 已打开 demo.md 时的编辑器全文
    const ed = document.querySelector('.ProseMirror');
    if (!ed) return { skipped: "编辑器不在位" };
    html = '<html><body>' + ed.innerHTML + '</body></html>';
  }
  const t0 = performance.now();
  try {
    const mod = await import("/node_modules/.vite/deps/@turbodocx_html-to-docx.js").catch(() => import("@turbodocx/html-to-docx"));
    const fn = mod.default ?? mod;
    const r = await fn(html, null, opts);
    const bytes = r instanceof Uint8Array ? r : new Uint8Array(r);
    const raw = new TextDecoder("latin1").decode(bytes);
    return { ok: true, ms: Math.round(performance.now() - t0), bytes: bytes.length,
             media: raw.includes("word/media/"), docxml: raw.includes("word/document.xml") };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0),
             name: e?.name, message: String(e?.message ?? e), stack: (e?.stack ?? "").slice(0, 4000) };
  }
})(${JSON.stringify([which, { table: { row: { cantSplit: true } }, footer: true, pageNumber: true }])})`;

console.log(`== 活体：browser 构建 htmlToDocx（档位：${which}）==`);
const r = await cdp.eval(DRIVER, { awaitPromise: true });
console.log(JSON.stringify(r, null, 2));

await sleep(500);
if (exceptions.length) {
  console.log("\n== Runtime.exceptionThrown（未捕获崩溃）==");
  for (const e of exceptions) console.log(JSON.stringify(e).slice(0, 3000));
} else {
  console.log("\n（无未捕获顶层异常）");
}
cdp.close();
