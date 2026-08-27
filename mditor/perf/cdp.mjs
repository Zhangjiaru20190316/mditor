// 最小 CDP 客户端（Node ≥22 原生 WebSocket + fetch，零依赖）。
// 用途：连接 Tauri dev 实例的 WebView2 远程调试端口（--remote-debugging-port），
// 驱动真实应用做性能测量（长任务采集 / JS CPU Profile / 受信任输入事件）。
//
// 启动方式（Git Bash / cmd）：
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" npm run tauri dev

/** 列出调试端口上的页面目标，返回第一个 page 类型目标。 */
export async function findPageTarget(port = 9223, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`CDP ${port} 上没有可用的 page 目标`);
}

export class Cdp {
  /** @param {string} wsUrl */
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        }
        return;
      }
      for (const h of this.handlers.get(msg.method) ?? []) h(msg.params);
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Runtime.evaluate 快捷方式；awaitPromise 默认开，返回 JSON 值。 */
  async eval(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue,
    });
    if (r.exceptionDetails) {
      throw new Error(
        "eval 异常: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      );
    }
    return r.result?.value;
  }

  close() {
    this.ws.close();
  }
}

// ---- 受信任输入（ProseMirror 只认 isTrusted 的事件）--------------------------

export function mouse(cdp) {
  return {
    async click(x, y, { delay = 80 } = {}) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      if (delay) await sleep(delay);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    },
    async wheel(x, y, deltaX = 0, deltaY = 300) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
    },
  };
}

export async function typeText(cdp, text, { delay = 40 } = {}) {
  for (const ch of text) {
    await cdp.send("Input.insertText", { text: ch });
    if (delay) await sleep(delay);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 页内长任务采集器（注入一次，多次启停）------------------------------------

export const LONGTASK_RECORDER = `(() => {
  if (window.__ltRecorder) return 'already';
  const buf = [];
  window.__ltRecorder = {
    events: buf,
    start() {
      this.zero = performance.now();
      buf.length = 0;
      this.obs?.disconnect();
      this.obs = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          buf.push({
            t: Math.round(e.startTime - this.zero),
            d: Math.round(e.duration),
            name: e.name,
            attribution: (e.attribution ?? []).map(a => a.name + ':' + a.containerType).join(','),
          });
        }
      });
      this.obs.observe({ entryTypes: ['longtask'] });
    },
    stop() { this.obs?.disconnect(); return { events: buf.slice(), spanMs: Math.round(performance.now() - this.zero) }; },
  };
  return 'installed';
})()`;

/** 采集窗口内的帧间隔（rAF 采样，量化掉帧/卡顿分布）。 */
export const FRAME_RECORDER = `(() => {
  if (window.__frameRec) return 'already';
  const gaps = [];
  let last = 0, raf = 0, running = false;
  window.__frameRec = {
    start() { gaps.length = 0; last = performance.now(); running = true;
      const tick = (t) => { if (!running) return; gaps.push(t - last); last = t; raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick); },
    stop() { running = false; cancelAnimationFrame(raf);
      const sorted = gaps.slice().sort((a,b)=>a-b);
      const q = (p) => sorted.length ? Math.round(sorted[Math.floor(sorted.length*p)]) : 0;
      return { frames: gaps.length, p50: q(0.5), p95: q(0.95), max: Math.round(sorted[sorted.length-1]||0), over50: gaps.filter(g=>g>50).length, over100: gaps.filter(g=>g>100).length }; },
  };
  return 'installed';
})()`;
