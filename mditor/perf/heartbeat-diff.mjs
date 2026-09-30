// heartbeat-diff.mjs —— 心跳 frame.*/mem 会话累计字段差分分析（D5 / V3）。
//
// 背景（任务书 §2.3 陷阱 2）：心跳 frame.frames / jankFrames 是会话累计值，
// 直接读数会得出「45M 帧里 5.3 万 jank」这类无法定位窗口的结论。本脚本对
// 相邻心跳做差分，输出窗口级（默认 30s 一拍）：
//   * jank 率 = ΔjankFrames / Δframes（窗口口径掉帧强度——MD-9001 的机器等价物）
//   * domNodes / katexNodes 绝对值与窗口增速（MD-4011 的机器等价物）
//   * 按文档（activeTab）与环境（env.ver）分段
//
// 用法：
//   node perf/heartbeat-diff.mjs [--log <dev-events.log 路径>] [--ver 4.18.0]
//        [--min-jank-rate 0.001] [--json] [--top 30]
// 不带 --log 时默认读 %APPDATA%/com.mditor.app/logs/dev-events.log（再拼 .1 旧卷）。
//
// 判读：jankRate 高 + 同文档连续 = MD-9001 主灾区窗口；domNodes 窗口间
//   单调增长（斜率恒定）= 真泄漏候选；一次性台阶后走平 = 重建余波/假阳性。

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// ---------- 参数 ----------

function parseArgs(argv) {
  const a = { log: null, ver: null, minJankRate: 0.001, json: false, top: 30 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);
    if (k === "--log") a.log = next();
    else if (k === "--ver") a.ver = next();
    else if (k === "--min-jank-rate") a.minJankRate = Number(next());
    else if (k === "--json") a.json = true;
    else if (k === "--top") a.top = Number(next());
    else throw new Error("未知参数: " + k);
  }
  return a;
}

// ---------- 读取与解析 ----------

function* readLines(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { yield JSON.parse(s); } catch { /* 轮转截断行 */ }
  }
}

/** 会话边界：uptimeMs 回退（重启）或心跳间隔 >5min（挂机/轮转缺口）。 */
function newSession(prev, cur) {
  if (!prev) return true;
  if ((cur.self?.uptimeMs ?? 0) < (prev.self?.uptimeMs ?? 0)) return true;
  return Date.parse(cur.ts) - Date.parse(prev.ts) > 5 * 60_000;
}

// ---------- 主流程 ----------

const args = parseArgs(process.argv.slice(2));
const logDir = join(process.env.APPDATA ?? ".", "com.mditor.app", "logs");
const logs = args.log
  ? [args.log]
  : [join(logDir, "dev-events.log.1"), join(logDir, "dev-events.log")]; // 旧卷在前，时间正序

const windows = [];
let prev = null;
let session = 0;
let parsed = 0, hearts = 0;

for (const log of logs) {
  for (const ev of readLines(log)) {
    parsed++;
    if (ev.src !== "heartbeat" || !ev.frame || !ev.ts) continue;
    hearts++;
    if (args.ver && ev.env?.ver && ev.env.ver !== args.ver) { prev = null; continue; }

    if (newSession(prev, ev)) { session++; prev = null; }
    if (prev) {
      const dFrames = ev.frame.frames - prev.frame.frames;
      const dJank = ev.frame.jankFrames - prev.frame.jankFrames;
      const dtMs = Date.parse(ev.ts) - Date.parse(prev.ts);
      const domPrev = prev.mem?.domNodes ?? null;
      const domCur = ev.mem?.domNodes ?? null;
      // 会话重启后累计值回退会出现负 delta，跳过（已由 newSession 兜住，双保险）
      if (dFrames < 0 || dJank < 0) { prev = ev; continue; }
      windows.push({
        ts: ev.ts, session,
        dtS: Math.round(dtMs / 100) / 10,
        doc: ev.doc?.activeTab ?? null,
        ver: ev.env?.ver ?? null,
        big: ev.env?.big ?? null,
        dFrames, dJank,
        jankRate: dFrames > 0 ? dJank / dFrames : 0,
        domNodes: domCur,
        dDom: domPrev != null && domCur != null ? domCur - domPrev : null,
        katexNodes: ev.mem?.katexNodes ?? null,
        longtask: ev.counters?.["perf:longtask"] ?? null,
      });
    }
    prev = ev;
  }
}

// ---------- 聚合输出 ----------

// 1) 按文档聚合：总窗数、jank 窗（jankRate ≥ minJankRate 且 dFrames>100）数、峰值 jankRate、DOM 增长窗
const byDoc = new Map();
for (const w of windows) {
  const key = `${w.doc ?? "(unknown)"}|${w.ver ?? "?"}`;
  let d = byDoc.get(key);
  if (!d) { d = { doc: w.doc, ver: w.ver, n: 0, jankWindows: 0, peakRate: 0, domGrowWindows: 0, domPeak: 0, katexPeak: 0, frames: 0, jank: 0 }; byDoc.set(key, d); }
  d.n++;
  d.frames += w.dFrames; d.jank += w.dJank;
  if (w.dFrames > 100 && w.jankRate >= args.minJankRate) d.jankWindows++;
  if (w.jankRate > d.peakRate) d.peakRate = Math.round(w.jankRate * 1000) / 1000;
  if (w.dDom != null && w.dDom > 0) d.domGrowWindows++;
  if ((w.domNodes ?? 0) > d.domPeak) d.domPeak = w.domNodes;
  if ((w.katexNodes ?? 0) > d.katexPeak) d.katexPeak = w.katexNodes;
}

if (args.json) {
  console.log(JSON.stringify({ parsed, hearts, windows: windows.length, byDoc: [...byDoc.values()], top: topWindows() }, null, 1));
} else {
  console.log(`解析 ${parsed} 行 / 心跳 ${hearts} / 差分窗 ${windows.length}（ver 过滤: ${args.ver ?? "全部"}）\n`);
  console.log("== 按文档聚合（jankRate≥" + args.minJankRate + " 且 dFrames>100 计为 jank 窗）==");
  console.log("文档 | 版本 | 窗数 | jank窗 | 峰值jank率 | 总帧 | 总jank | DOM增长窗 | DOM峰 | katex峰");
  for (const d of [...byDoc.values()].sort((a, b) => b.jankWindows - a.jankWindows || b.peakRate - a.peakRate)) {
    console.log(`${d.doc} | ${d.ver} | ${d.n} | ${d.jankWindows} | ${(d.peakRate * 100).toFixed(2)}% | ${d.frames} | ${d.jank} | ${d.domGrowWindows} | ${d.domPeak} | ${d.katexPeak}`);
  }
  console.log("\n== jank 率最高的 " + args.top + " 窗 ==");
  for (const w of topWindows()) {
    console.log(`${w.ts} [s${w.session}] ${w.dtS}s ${w.doc} dFrames=${w.dFrames} dJank=${w.dJank} rate=${(w.jankRate * 100).toFixed(1)}% dom=${w.domNodes} dDom=${w.dDom} katex=${w.katexNodes}`);
  }
}

function topWindows() {
  return [...windows].sort((a, b) => b.jankRate - a.jankRate).slice(0, args.top);
}
