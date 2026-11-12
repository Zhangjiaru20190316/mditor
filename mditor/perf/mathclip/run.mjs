// 公式导出截断复现驱动（Edge headless + CDP）：
//   打开 perf/mathclip/repro.html（vite dev 转译 TS 模块）→ 点击运行 →
//   收集 window.__MATHCLIP__ 诊断 JSON。
// 启动：先 `npx vite --port 5199`，再 `node perf/mathclip/run.mjs [url]`。
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp } from "../cdp.mjs";

const ROOT = "C:/Users/hh/Desktop/Tp/mditor";
const OUT_DIR = join(ROOT, "perf", "mathclip", "results");
mkdirSync(OUT_DIR, { recursive: true });
const URL = process.argv[2] ?? "http://localhost:5199/perf/mathclip/repro.html";
const TAG = process.argv[3] ?? "run";
const MODE = process.argv[4] ?? "diag"; // diag = 诊断 JSON；e2e = 真跑 PDF 管线 dump 页 PNG
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  "--remote-debugging-port=9341",
  `--user-data-dir=${join(OUT_DIR, "edge-profile")}`,
  "--no-first-run", "--no-default-browser-check",
  "--window-size=1280,900",
  URL,
], { stdio: "ignore" });
console.log("edge pid", edge.pid);

try {
  const target = await findPageTarget(9341, 20_000);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const logs = [];
  cdp.on("Runtime.consoleAPICalled", (p) =>
    logs.push(`[console.${p.type}] ${p.args?.map((a) => a.value ?? a.description ?? "").join(" ")}`));
  cdp.on("Runtime.exceptionThrown", (p) =>
    logs.push(`[exception] ${p.exceptionDetails?.text} ${p.exceptionDetails?.exception?.description ?? ""}`));
  await cdp.send("Runtime.enable").catch(() => {});
  // 等模块加载完成（vite 按需转译，首访较慢）
  for (let i = 0; i < 60; i++) {
    if (await cdp.eval("!!window.__runMathClip")) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!(await cdp.eval("!!window.__runMathClip"))) {
    console.error("PAGE FAILED TO BOOT. Console:\n" + logs.join("\n").slice(0, 4000));
    process.exitCode = 1;
  } else if (MODE === "e2e") {
    await cdp.eval("window.__runE2E()");
    let n = 0;
    for (let i = 0; i < 60; i++) {
      const r = await cdp.eval("window.__PAGES__ ? window.__PAGES__.length : -1");
      n = Number(r);
      if (n > 0) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    console.log(`pdf pages: ${n}, bytes: ${await cdp.eval("window.__PDF_BYTES_LEN__")}`);
    for (let i = 0; i < n; i++) {
      const d = await cdp.eval(`window.__PAGES__[${i}]`);
      if (typeof d === "string" && d.startsWith("data:image/png")) {
        writeFileSync(join(OUT_DIR, `page-${String(i).padStart(2, "0")}.png`), Buffer.from(d.slice(d.indexOf(",") + 1), "base64"));
        console.log(`page-${i} saved`);
      }
    }
  } else {
    await cdp.eval("window.__runMathClip()");
    let report = null;
    for (let i = 0; i < 60; i++) {
      const r = await cdp.eval("window.__MATHCLIP__ ? JSON.stringify(window.__MATHCLIP__) : null");
      if (r) { report = JSON.parse(r); break; }
      await new Promise((res) => setTimeout(res, 500));
    }
    if (!report) {
      console.error("no report. Console:\n" + logs.join("\n").slice(0, 4000));
      process.exitCode = 1;
    } else {
      writeFileSync(join(OUT_DIR, `${TAG}.json`), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
    }
  }
} finally {
  edge.kill();
}
