// HX H2 修复门验收：对矩阵导出文件逐个实测——用户滚动可达文档末尾 +
// 主题保真（body 背景与主题 --bg 一致）+ 顶部截图存档。
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT = join(ROOT, "perf", "results", "ex-hx-repro");
const DOC_DIR = "C:/Users/hh/Documents";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PROFILE = join(OUT, "edge-profile-h2");

const files = [
  { id: "light+公式+引用", f: "hx-matrix-light_公式_引用.html", theme: "light" },
  { id: "dark+公式+引用", f: "hx-matrix-dark_公式_引用.html", theme: "dark" },
  { id: "dark+公式+内联", f: "hx-matrix-dark_公式_内联.html", theme: "dark" },
  { id: "dark+无公式", f: "hx-matrix-dark_无公式.html", theme: "dark" },
  { id: "light+无公式", f: "hx-matrix-light_无公式.html", theme: "light" },
];

const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  "--remote-debugging-port=9334", `--user-data-dir=${PROFILE}`,
  "--no-first-run", "--window-size=1280,900", "about:blank",
], { stdio: "ignore" });
const target = await findPageTarget(9334, 20_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
await cdp.send("Page.enable").catch(() => {});

const results = [];
for (const { id, f, theme } of files) {
  const url = "file:///" + encodeURI(join(DOC_DIR, f).replace(/\\/g, "/")).replace(/#/g, "%23");
  await cdp.send("Page.navigate", { url });
  await sleep(1800);
  // 用户滚动到底
  for (let i = 0; i < 12; i++) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 450, deltaX: 0, deltaY: 600 });
    await sleep(60);
  }
  const m = await cdp.eval(`(() => {
    const de = document.documentElement, b = document.body;
    const cs = getComputedStyle(b);
    const themeBg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    const blocks = b.children;
    const last = blocks[blocks.length - 1];
    const lastBottom = last ? last.getBoundingClientRect().bottom + scrollY : 0;
    return {
      docTheme: document.documentElement.getAttribute('data-theme'),
      themeBg,
      bodyBg: cs.backgroundColor, bodyFg: cs.color,
      scrollH: de.scrollHeight, clientH: de.clientHeight,
      userScrollY: scrollY,
      maxScroll: de.scrollHeight - de.clientHeight,
      lastBlockBottom: Math.round(lastBottom),
      reachedEnd: scrollY >= de.scrollHeight - de.clientHeight - 2 && scrollY > 0,
      overflowY: cs.overflowY, height: cs.height,
      katexCount: document.querySelectorAll('.katex').length,
    };
  })()`);
  // 顶部截图存档（回到顶部再截）
  await cdp.eval("window.scrollTo(0,0)");
  await sleep(300);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, `ex-hx-h2-${id.replace(/[+]/g, "-")}.png`), Buffer.from(shot.data, "base64"));
  const verdict = { id, theme, ...m, pass: m.reachedEnd && m.overflowY === "visible" && m.docTheme === theme };
  results.push(verdict);
  console.log(id, "→", JSON.stringify({ pass: verdict.pass, userScrollY: m.userScrollY, maxScroll: m.maxScroll, overflowY: m.overflowY, bodyBg: m.bodyBg, themeBg: m.themeBg, katex: m.katexCount }));
}
writeFileSync(join(OUT, "ex-hx-h2-matrix.json"), JSON.stringify({ verifiedAt: new Date().toISOString(), results }, null, 2));
console.log("saved → ex-hx-h2-matrix.json");
cdp.close();
edge.kill();
