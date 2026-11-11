// UI 动效状态机程序化断言（v5.3.2 批次）：验证类切换与令牌解析真实发生。
import { Cdp, findPageTarget } from "./cdp.mjs";

const page = await findPageTarget(9223, 30_000);
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");

async function evalJs(expr, awaitPromise = false) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result?.value;
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

// 0. 令牌解析
const tokens = await evalJs(`(() => {
  const cs = getComputedStyle(document.documentElement);
  const pick = (el, prop) => getComputedStyle(el).getPropertyValue(prop).trim();
  return {
    scrim: pick(document.documentElement, "--scrim"),
    easeSpring: pick(document.documentElement, "--ease-spring"),
    durExit: pick(document.documentElement, "--dur-exit"),
    theme: document.documentElement.dataset.theme ?? "(default)",
    motion: document.documentElement.dataset.motion ?? "(unset)",
  };
})()`);
check("--scrim 已定义", tokens.scrim.length > 0, JSON.stringify(tokens));

// 1. 菜单栏下拉：入场动画 + 退场保挂
await evalJs(`document.querySelectorAll(".mb-btn")[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true })), true`);
await new Promise((r) => setTimeout(r, 250));
const ddOpen = await evalJs(`(() => {
  const dd = document.querySelector(".mb-dropdown");
  if (!dd) return { found: false };
  return { found: true, closing: dd.classList.contains("closing"), anim: getComputedStyle(dd).animationName };
})()`);
check("下拉打开且带动画", ddOpen.found && !ddOpen.closing && ddOpen.anim !== "none", JSON.stringify(ddOpen));

// 关闭后 60ms：应仍在 DOM 且 .closing（退场保挂）
await evalJs(`document.querySelector(".mb-backdrop")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), true`);
await new Promise((r) => setTimeout(r, 60));
const ddClosing = await evalJs(`(() => {
  const dd = document.querySelector(".mb-dropdown");
  if (!dd) return { found: false };
  return { found: true, closing: dd.classList.contains("closing"), anim: getComputedStyle(dd).animationName, pointer: getComputedStyle(dd).pointerEvents };
})()`);
check("关闭 60ms 后仍在播退场（.closing + menu-pop-out + 禁指针）",
  ddClosing.found && ddClosing.closing && ddClosing.anim === "menu-pop-out" && ddClosing.pointer === "none",
  JSON.stringify(ddClosing));
await new Promise((r) => setTimeout(r, 300));
const ddGone = await evalJs(`document.querySelector(".mb-dropdown") === null`);
check("退场播完后卸载", ddGone === true);

// 2. 模态：scrim 底 + spring 入场（lively 档）或标准入场
await evalJs(`(() => {
  const mi = [...document.querySelectorAll(".mb-item")].find((b) => b.textContent.includes("设置"));
  mi?.click(); return !!mi;
})()`);
await new Promise((r) => setTimeout(r, 400));
const modal = await evalJs(`(() => {
  const bk = document.querySelector(".modal-backdrop");
  if (!bk) return { found: false };
  const card = bk.querySelector(".modal-card");
  return { found: true, bg: getComputedStyle(bk).backgroundColor, cardAnim: getComputedStyle(card).animationName, blur: getComputedStyle(bk).backdropFilter };
})()`);
check("模态遮罩吃 --scrim", modal.found && modal.bg !== "rgba(0, 0, 0, 0.35)" && modal.bg !== "rgba(0, 0, 0, 0, 0)", JSON.stringify(modal));
await evalJs(`document.querySelector(".modal-x")?.click() ?? document.querySelector("[class*=modal] button")?.click(), true`);
await new Promise((r) => setTimeout(r, 400));

// 3. 文件树：展开组入场动画存在（找任意 group ul 检查 animationName 注册）
const ftGroup = await evalJs(`(() => {
  const ul = document.querySelector(".ft-root ul[role=group]");
  if (!ul) return { found: false };
  return { found: true, anim: getComputedStyle(ul).animationName };
})()`);
check("文件树子树组动画已注册", !ftGroup.found || ftGroup.anim === "ft-group-in", JSON.stringify(ftGroup));

// 4. 闪卡翻面规则编译检查（样式表里有 fc-flip-pop / tab-ind-in / menu-pop-out / sel-out / ft-notice-in）
const keyframes = await evalJs(`(() => {
  const names = ["fc-flip-pop", "tab-ind-in", "tab-dot-in", "menu-pop-out", "sel-out", "ft-notice-in", "ft-group-in", "printdlg-panel-in-lively"];
  const found = [];
  for (const ss of document.styleSheets) {
    let rules; try { rules = ss.cssRules; } catch { continue; }
    for (const r of rules) if (r instanceof CSSKeyframesRule && names.includes(r.name)) found.push(r.name);
  }
  return { found: [...new Set(found)], missing: names.filter((n) => !found.includes(n)) };
})()`);
check("全部新 keyframes 已编译进运行时", keyframes.missing.length === 0, JSON.stringify(keyframes));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length > 0 ? 1 : 0);
