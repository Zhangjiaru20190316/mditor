// UI 视觉冒烟（v5.3.2 动效批次）：连 dev 实例 CDP，截取关键界面状态。
// 用法：node perf/tmp-ui-smoke.mjs [outdir]
import { mkdirSync, writeFileSync } from "node:fs";
import { Cdp, findPageTarget } from "./cdp.mjs";

const outDir = process.argv[2] ?? "perf/results/ui-smoke";
mkdirSync(outDir, { recursive: true });

const page = await findPageTarget(9223, 60_000);
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");

async function shot(name) {
  const res = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(res.data, "base64"));
  console.log("shot:", name);
}

async function evalJs(expr, awaitPromise = false) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise,
  });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result?.value;
}

// 0. 冷启动主界面（等 React 就绪）
await evalJs(
  `new Promise((res) => {
     const t0 = Date.now();
     const iv = setInterval(() => {
       if (document.querySelector(".tabbar, .sidebar, .mditor-editor-host") || Date.now() - t0 > 20000) { clearInterval(iv); res(true); }
     }, 200);
   })`,
  true
);
await new Promise((r) => setTimeout(r, 800));
await shot("00-main");

// 1. 菜单栏下拉（打开「文件」菜单）
await evalJs(`(() => {
  const btn = document.querySelector(".mb-btn");
  if (!btn) return "no-mb-btn";
  btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return "ok";
})`);
await new Promise((r) => setTimeout(r, 350));
await shot("01-menubar-dropdown");
// 关闭（看退场）
await evalJs(`document.querySelector(".mb-backdrop")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);
await new Promise((r) => setTimeout(r, 60));
await shot("02-menubar-closing-60ms");
await new Promise((r) => setTimeout(r, 400));

// 2. 设置模态（玻璃 + scrim + spring 入场）
await evalJs(`(() => {
  const mi = [...document.querySelectorAll(".mb-item")].find((b) => b.textContent.includes("设置"));
  if (!mi) return "no-settings-item";
  mi.click();
  return "ok";
})`);
await new Promise((r) => setTimeout(r, 500));
await shot("03-settings-modal");
await evalJs(`document.querySelector(".modal-x, .modal-card .close, [class*=modal] button[title*=关闭]")?.click(); true`);
await new Promise((r) => setTimeout(r, 400));

// 3. 主题变量抽查：scrim 与动效令牌在暗色主题下的解析值
const themeInfo = await evalJs(`(() => {
  const cs = getComputedStyle(document.documentElement);
  return {
    scrim: cs.getPropertyValue("--scrim").trim(),
    motion: document.documentElement.dataset.motion ?? "(none)",
    theme: document.documentElement.dataset.theme ?? "(default)",
  };
})`);
console.log("theme-tokens:", JSON.stringify(themeInfo));

console.log("DONE");
await cdp.close?.() ?? null;
process.exit(0);
