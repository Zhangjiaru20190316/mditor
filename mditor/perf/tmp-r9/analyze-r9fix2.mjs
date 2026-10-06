// analyze-r9fix2.mjs —— R9 修复验证 run 聚合：F1/F2/F3/F5 + D1 双臂门禁行
// 用法：node perf/tmp-r9/analyze-r9fix2.mjs [tag=r9fix2]
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(here, "..", "results");
const tag = process.argv[2] ?? "r9fix2";

const med = (arr) => { const a = arr.filter((x) => x != null).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

const files = readdirSync(RESULTS).filter((f) => f.startsWith("r9-phase2-prod-jank-") && f.includes(`-${tag}-`) && f.endsWith(".json")).sort();
const rows = [];
for (const f of files) {
  let r; try { r = JSON.parse(readFileSync(join(RESULTS, f), "utf8")); } catch { continue; }
  const arms = r.analysis?.arms ?? [];
  const focusArms = arms.filter((a) => a.mode === "focus");
  const normalArms = arms.filter((a) => a.mode === "normal");
  const kw = arms.filter((a) => a.mode === "focus").map((a) => a.meta?.kw?.name).filter(Boolean);
  const kwRunning = arms.filter((a) => a.mode === "focus" && a.meta?.kw?.name === "focus-keepwarm" && a.meta?.kw?.ps === "running").length;
  const j32Share = (list) => med(list.map((a) => a.scroll.frames ? a.scroll.jank32 / a.scroll.frames : null));
  const drift = (list) => list.map((a) => (a.quiet?.stStart != null && a.quiet?.stEnd != null ? Math.abs(a.quiet.stEnd - a.quiet.stStart) : null));
  rows.push({
    run: f.match(/-(\d+)\.json$/)[1], scenario: r.scenario, ok: r.ok, hasKw: r.hasKeepwarmCSS,
    f_j32: med(focusArms.map((a) => a.scroll.jank32)), n_j32: med(normalArms.map((a) => a.scroll.jank32)),
    f_p95: med(focusArms.map((a) => a.scroll.gapP95)), n_p95: med(normalArms.map((a) => a.scroll.gapP95)),
    f_lt50: focusArms.reduce((s, a) => s + (a.scroll.longtask50 ?? 0), 0), n_lt50: normalArms.reduce((s, a) => s + (a.scroll.longtask50 ?? 0), 0),
    f_share: j32Share(focusArms), n_share: j32Share(normalArms),
    f_swMaxGap: med(focusArms.map((a) => a.switch?.gapMax)), n_swMaxGap: med(normalArms.map((a) => a.switch?.gapMax)),
    f_swJ32: focusArms.reduce((s, a) => s + (a.switch?.jank32 ?? 0), 0), n_swJ32: normalArms.reduce((s, a) => s + (a.switch?.jank32 ?? 0), 0),
    f_driftShift: focusArms.reduce((s, a) => s + (a.quiet?.driftShift ?? 0), 0), n_driftShift: normalArms.reduce((s, a) => s + (a.quiet?.driftShift ?? 0), 0),
    f_stDelta: med(drift(focusArms)), n_stDelta: med(drift(normalArms)),
    kwArms: `${kwRunning}/${focusArms.length}`,
  });
}

console.log(`tag=${tag} runs=${rows.length}`);
for (const x of rows) console.log([`run${x.run}`, x.scenario, `ok=${x.ok}`, `kwCSS=${x.hasKw}`, `kwLive=${x.kwArms}`,
  `F:j32=${x.f_j32}/p95=${x.f_p95}/lt50=${x.f_lt50}/share=${x.f_share != null ? (x.f_share * 100).toFixed(1) + "‰" : "-"}`,
  `N:j32=${x.n_j32}/p95=${x.n_p95}/lt50=${x.n_lt50}`,
  `sw: F ${x.f_swMaxGap}ms/${x.f_swJ32} N ${x.n_swMaxGap}ms/${x.n_swJ32}`,
  `D1: F shift=${x.f_driftShift}/Δst=${x.f_stDelta} N shift=${x.n_driftShift}/Δst=${x.n_stDelta}`].join(" | "));

const ok = rows.filter((x) => x.ok);
const byScen = {};
for (const x of ok) (byScen[x.scenario] ??= []).push(x);
console.log("\n== 场景中位汇总 ==");
for (const [sc, list] of Object.entries(byScen)) {
  console.log(`${sc} (n=${list.length}): F j32 中位=${med(list.map((x) => x.f_j32))} N j32 中位=${med(list.map((x) => x.n_j32))} | F p95=${med(list.map((x) => x.f_p95))} N p95=${med(list.map((x) => x.n_p95))} | kwLive ${list.every((x) => x.kwArms.split("/")[0] === x.kwArms.split("/")[1]) ? "全臂" : "部分"} | D1 shift F=${list.reduce((s, x) => s + x.f_driftShift, 0)} N=${list.reduce((s, x) => s + x.n_driftShift, 0)}`);
}
