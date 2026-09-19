// trash_file 主线程冻结时长探针（P4）。
//
// 背景：修复前 `trash_file` 是同步 Tauri 命令（非 async），在主线程
// `.output()` 阻塞等待 PowerShell 子进程退出——UI 冻结时长 = 子进程往返
// 耗时。本脚本用与 commands.rs 完全相同的命令行、脚本串与环境变量传参方式，
// 实测该往返耗时分布，作为「每次删除文件 UI 冻结多久」的实测依据。
//
// 用法：node perf/trash-probe.mjs [次数=8]
// 输出：逐次耗时 + 汇总（min/median/max），并存 perf/results/trash-probe-<ts>.json

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const N = Number(process.argv[2] ?? 8);
const dir = mkdtempSync(join(tmpdir(), "mditor-trash-probe-"));
const files = [];
for (let i = 0; i < N; i++) {
  const p = join(dir, `probe-${i}.txt`);
  writeFileSync(p, "trash probe\n");
  files.push(p);
}

const script =
  "Add-Type -AssemblyName Microsoft.VisualBasic; \
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(\
$env:MDITOR_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')";

const rounds = [];
for (const p of files) {
  const t0 = performance.now();
  try {
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, MDITOR_TRASH_PATH: p },
      stdio: "ignore",
    });
    rounds.push({ ok: true, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    rounds.push({ ok: false, ms: Math.round(performance.now() - t0), err: String(e).slice(0, 100) });
  }
}
// 额外一次空 probe 目录删除（目录分支耗时同量级，不单列）
try { rmSync(dir, { recursive: true }); } catch { /* 个别文件进回收站延迟锁定时忽略 */ }

const ok = rounds.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
const summary = {
  label: `trash-probe-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  ts: new Date().toISOString(),
  n: rounds.length,
  rounds,
  okMs: ok,
  min: ok[0],
  median: ok[Math.floor(ok.length / 2)],
  max: ok[ok.length - 1],
  note: "每次 trash_file 的 UI 冻结时长（修复前）≈ PowerShell 子进程往返耗时；目录删除走 DeleteDirectory 同量级。",
};
console.log(JSON.stringify(summary, null, 1));
const { writeFileSync: wf } = await import("node:fs");
wf(new URL(`./results/${summary.label}.json`, import.meta.url), JSON.stringify(summary, null, 1));
