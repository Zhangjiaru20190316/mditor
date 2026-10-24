/* global WebSocket */
// 阶段 0 Spike CDP 探针（dev 工具）。用法：
//   node scripts/spike-cdp.mjs [输出png]
// 前置：应用以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动。
// 动作：附加主页面 + 所有 asset.localhost 子 frame，读取测试页自检面板的实际
// 状态（verdict 文本 / 检查行 / 计数器 / CSP meta 注入情况），并对主窗口截图。

// 注意：WebView2 的调试端口绑定在 IPv6 环回 [::1]；127.0.0.1 可能被其它
// 浏览器进程占用（实测本机被 Edge 占走），优先 [::1] 再回退 127.0.0.1。
const pick = async () => {
  for (const host of ["[::1]", "127.0.0.1"]) {
    try {
      const v = await (await fetch(`http://${host}:9222/json/version`)).json();
      if (/WebView|Edg\//.test(v.Browser ?? "")) return host;
    } catch { /* 下一个 */ }
  }
  throw new Error("找不到 WebView2 的 CDP 端点（9222 未监听？）");
};
const HOST = await pick();
const CDP = `http://${HOST}:9222`;
const out = process.argv[2] ?? "spike-cdp.png";

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1:1420"));
if (!page) {
  console.error("no page target", list.map((t) => `${t.type}:${t.url}`).join("\n"));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
const sessions = new Map(); // sessionId -> {kind}
const contexts = new Map(); // frameId -> contextId
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  } else if (m.method === "Runtime.executionContextCreated") {
    const ctx = m.params.context;
    if (ctx.auxData?.frameId) contexts.set(ctx.auxData.frameId, ctx.id);
  } else if (m.method === "Target.attachedToTarget") {
    const ti = m.params.targetInfo;
    sessions.set(m.params.sessionId, { url: ti.url, type: ti.type, title: ti.title });
    send("Runtime.enable", {}, m.params.sessionId).catch(() => {});
  }
};
function send(method, params = {}, sessionId) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

await send("Runtime.enable");
await send("Page.enable");
await send("Target.setAutoAttach", {
  autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
});

// 同进程 iframe 不产生子 target：用 FrameTree + executionContext 定位。
// 等一拍让 executionContextCreated 事件到齐。
await new Promise((r) => setTimeout(r, 1200));

const frameCtx = []; // {url, contextId}
try {
  const tree = await send("Page.getFrameTree");
  const walk = (n) => {
    const f = n.frame;
    if (/asset\.localhost/.test(f.url ?? "")) {
      frameCtx.push({ url: f.url, frameId: f.id, name: f.name ?? "" });
    }
    for (const c of n.childFrames ?? []) walk(c);
  };
  walk(tree.frameTree);
} catch (e) {
  console.log("getFrameTree failed:", e.message);
}
console.log("asset frames in tree:", frameCtx.length);
const EVAL = `(() => {
  const q = (s) => document.querySelector(s);
  const rows = [...document.querySelectorAll('#checks tr')].map(tr => tr.innerText.replace(/\\s+/g,' ').trim());
  return JSON.stringify({
    href: location.href,
    readyState: document.readyState,
    cspMeta: q('meta[http-equiv="Content-Security-Policy"]')?.content ?? null,
    verdict: q('#verdict')?.textContent ?? null,
    verdictClass: q('#verdict')?.className ?? null,
    rows,
    counter: q('#counter-val')?.textContent ?? null,
    cdn: q('#cdn-state')?.textContent ?? null,
    img1: q('#img-subdir-state')?.textContent ?? null,
    img2: q('#img-dotdot-state')?.textContent ?? null,
    cssState: q('#css-state')?.textContent ?? null,
    bodySnippet: (document.body?.innerText ?? '').slice(0, 200),
  });
})()`;

for (const f of frameCtx) {
  const ctxId = contexts.get(f.frameId);
  console.log("frame:", decodeURIComponent(f.url).slice(0, 110), "context:", ctxId ?? "（未见 context）");
  if (ctxId == null) continue;
  try {
    const r = await send("Runtime.evaluate", {
      expression: EVAL, returnByValue: true, contextId: ctxId,
    });
    console.log(r.result?.value ?? JSON.stringify(r).slice(0, 400));
  } catch (e) {
    console.log("evaluate 失败:", e.message);
  }
}

// 主窗自证：主页面 window 里是否有 __TAURI_INTERNALS__（对照）
try {
  const r = await send("Runtime.evaluate", {
    expression: `({t: typeof window.__TAURI__, i: typeof window.__TAURI_INTERNALS__, u: location.href})`,
    returnByValue: true,
  });
  console.log("--- main window:", JSON.stringify(r.result?.value));
} catch { /* ignore */ }

// 截图（含 iframe 像素）
try {
  const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`screenshot → ${out}`);
} catch (e) {
  console.log("screenshot failed:", e.message);
}
ws.close();
process.exit(0);
