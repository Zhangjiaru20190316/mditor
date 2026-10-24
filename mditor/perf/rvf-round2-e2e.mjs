// RVF 追加轮端到端验收：用户文档「AI替代教师-范文与讲解.md」矢量导出。
// 前置：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
//       npm run tauri dev 已起。
// 用法: node perf/rvf-round2-e2e.mjs
import { mkdirSync, rmSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const FIX = "E:/笔记/英语/作文/AI替代教师-范文与讲解.md";
const OUT = "perf/results/rvf-round2";
const DUMP = "C:/Users/hh/Documents/rvf-round2-dump";
rmSync(DUMP, { recursive: true, force: true });
mkdirSync(DUMP, { recursive: true });
mkdirSync(OUT, { recursive: true });

const target = await findPageTarget(9223, 180_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
console.log("connected");
const opened = await cdp.eval(`window.__exportDebug.open(${JSON.stringify(FIX)})`);
if (!opened) throw new Error("open failed");
await sleep(6000);

const runs = [];
for (const mode of ["raster", "vector"]) {
  const pdf = join(DUMP, `${mode}.pdf`);
  const meta = await cdp.eval(
    `window.__exportDebug.exportPdfTo(${JSON.stringify(pdf.replace(/\\/g, "/"))}, { mode: ${JSON.stringify(mode)} })`,
    { awaitPromise: true, returnByValue: true },
  );
  if (meta?.error || !meta?.meta) {
    console.error("exportPdfTo failed:", JSON.stringify(meta).slice(0, 400));
    process.exit(1);
  }
  copyFileSync(pdf, join(OUT, `${mode}.pdf`));
  runs.push({
    mode,
    bytes: statSync(join(OUT, `${mode}.pdf`)).size,
    pages: meta.meta.pages,
    assemble: meta.meta.assemble ?? null,
  });
  console.log(mode, "done", runs[runs.length - 1]);
}
console.log(JSON.stringify(runs, null, 2));
