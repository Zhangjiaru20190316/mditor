// digest-j.mjs —— probe-j 证据摘要：scrollTop 变迁 × 写入方归因表
// 用法：node perf/tmp-r5/digest-j.mjs <json...>
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
for (const f of files) {
  const row = JSON.parse(readFileSync(f, "utf8"));
  console.log(`\n===== ${f} =====`);
  console.log(`scenario=${row.scenario} doc=${row.doc} viewport=${row.viewport} notes=${JSON.stringify(row.notes)}`);
  const byWin = {};
  for (const t of row.ticks) (byWin[t.w] ??= []).push(t);
  for (const [w, ticks] of Object.entries(byWin)) {
    console.log(`\n-- 窗口 ${w}: ${ticks.length} ticks, top ${ticks[0].top}→${ticks[ticks.length - 1].top}`);
    // 变迁检测（tick 间 top 变化 >4px）
    for (let i = 1; i < ticks.length; i++) {
      const a = ticks[i - 1], b = ticks[i];
      const d = b.top - a.top;
      if (Math.abs(d) <= 4) continue;
      const near = row.trapAll.filter((e) => e.w === w && e.t >= a.t - 250 && e.t <= b.t + 250);
      const setOps = near.filter((e) => e.kind === "set-scrollTop" || e.kind === "scrollTo");
      const sif = near.filter((e) => e.kind === "scrollIntoView");
      let writer = "原生滚动(无JS写入)";
      if (setOps.length) {
        const op = setOps[setOps.length - 1];
        writer = `JS写 to=${op.to} 栈: ${String(op.stack).slice(0, 180)}`;
      } else if (sif.length) {
        writer = `scrollIntoView ${sif[sif.length - 1].el} ${sif[sif.length - 1].arg} 栈: ${String(sif[sif.length - 1].stack).slice(0, 120)}`;
      }
      const recent = b.recent ? `${b.recent.tag}@${Math.round(b.t - b.recent.at)}ms前` : "无";
      console.log(`  t=${b.t} ${a.top}→${b.top} (${d > 0 ? "+" : ""}${d}) recent[${recent}] ${writer}`);
    }
  }
  const trapKinds = {};
  for (const e of row.trapAll) trapKinds[e.kind] = (trapKinds[e.kind] ?? 0) + 1;
  console.log(`\n陷阱统计: ${JSON.stringify(trapKinds)}`);
  const stacks = {};
  for (const e of row.trapAll) if (e.kind === "set-scrollTop") {
    const s = String(e.stack).split(" <= ").filter((x) => !x.includes("r5trap") && !x.startsWith("Object.defineProperty") && !x.includes("prototype")).slice(0, 2).join(" <= ");
    stacks[s] = (stacks[s] ?? 0) + 1;
  }
  console.log(`set-scrollTop 调用方聚合:`);
  for (const [s, n] of Object.entries(stacks).sort((a, b) => b[1] - a[1])) console.log(`  ×${n} ${s.slice(0, 200)}`);
  if (row.scrollDebugWarn?.length) {
    const seen = new Set();
    const uniq = row.scrollDebugWarn.filter((e) => { const k = e.ts + "|" + e.kind + "|" + String(e.msg).slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true; });
    console.log(`\nscrollDebug warn 事件(去重后 ${uniq.length}/${row.scrollDebugWarn.length}):`);
    for (const e of uniq.slice(-30)) console.log(`  [${e.w}] ${new Date(e.ts).toISOString().slice(11, 19)} ${e.kind}: ${String(e.msg).slice(0, 140)}`);
  } else console.log(`\nscrollDebug warn 事件: 0`);
}
