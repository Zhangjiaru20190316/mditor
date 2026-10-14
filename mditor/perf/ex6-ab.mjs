// EX 阶段六决定性 A/B：同一工厂内 trim1（现行为裁剪）/ stream（修复前流
// 式，含全量克隆成本）/ trim2（裁剪对照二跑）三变体光栅同一批页。回答：
// ①裁剪是否引入超出已知 8px 常量的像素差异（行剖面滞后/相关）；②trim
// 自噪声基线（trim1 vs trim2）；③块顶对原位基准（measure/文本层坐标系）
// 的差——流式的 8px margin 逃逸是否被裁剪消除。
// 产物：ex-phase6-raster-ab.json + ex6-ab-{variant}-page{i}.png。
import { writeFileSync, copyFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { findPageTarget, Cdp, sleep } from "./cdp.mjs";

const FIX = "C:/Users/hh/Desktop/Tp/mditor/perf/fixtures";
const OUT = "C:/Users/hh/Desktop/Tp/mditor/perf/results";
const DOC_DIR = "C:/Users/hh/Documents";
// 密度档 87 页文档上 stream 变体（全量克隆）实测冻死渲染器（2026-10-14，
// 首次尝试 480s 无返回 + eval 双静默）——A/B 用小文档，裁剪语义的像素问题
// （恒定偏移/相位）与文档规模无关。
const FIXTURE = process.argv[2] ?? "微分方程专题_CMC备战_基准副本.md";
const PROGRESS = join(OUT, "ex6-ab-progress.logl");

const target = await findPageTarget(9223, 10_000);
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
await cdp.send("Page.enable").catch(() => {});
await cdp.send("Runtime.enable").catch(() => {});
await cdp.send("Page.bringToFront").catch(() => {});
// 阶段遥测：app console → 时间戳落盘（挂点定位）
cdp.on("Runtime.consoleAPICalled", (p) => {
  const text = (p.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
  if (!text.includes("rasterAb")) return;
  const line = `${new Date().toISOString()} ${text}`;
  console.log(line);
  appendFileSync(PROGRESS, line + "\n");
});

const step = async (label, expr, cap = 120_000) => {
  const t0 = Date.now();
  const r = await Promise.race([
    cdp.eval(expr, { awaitPromise: true, returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${cap}ms`)), cap)),
  ]);
  console.log(`[${label}] ${Date.now() - t0}ms`);
  return r;
};

// fixtures 授权（工作区根语义）+ 打开密度档文档
console.log(await step("grant", `(async () => {
  const { getAdapter } = await import('/src/platform/index.ts');
  await getAdapter().app.grantFsScope([${JSON.stringify(FIX)}], true);
  return 'granted';
})()`));
const opened = await step("open", `window.__exportDebug.open(${JSON.stringify(join(FIX, FIXTURE))})`, 30_000);
if (!opened) throw new Error("open failed");
await sleep(6000);

// stream 变体含全量克隆成本（小文档可控）；三变体合计给 7 分钟。
const ab = await step(
  "rasterAb",
  `window.__exportDebug.rasterAb({ pageCount: 3, rasterScale: 2, dumpDir: ${JSON.stringify(DOC_DIR)} })`,
  420_000
);
console.log(JSON.stringify(ab, null, 2));

if (!ab || ab.error) throw new Error("rasterAb failed: " + JSON.stringify(ab));
for (const v of ["trim1", "stream", "trim2"]) {
  for (let i = 0; i < ab.pages; i++) {
    const src = join(DOC_DIR, `ex6-ab-${v}-page${i}.png`);
    if (existsSync(src)) copyFileSync(src, join(OUT, `ex6-ab-${v}-page${i}.png`));
  }
}
writeFileSync(join(OUT, "ex-phase6-raster-ab.json"), JSON.stringify(ab, null, 2));
console.log("saved → perf/results/ex-phase6-raster-ab.json (+ page PNGs)");
cdp.close();
