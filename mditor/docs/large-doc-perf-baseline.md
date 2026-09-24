# 本轮基线汇总（2026-09-23，修复 math 塌块回归后的有效基线）

> **结题**：见 `docs/large-doc-perf-report.md`——本轮最终判定 G1/G3/G4/G5 达标、
> G2 未达（附归因）、G6/G7 零回归。本文件是基线期工作记录。

> 环境：dev 实例（CDP 9223），本机 WebView2/Edge 153，窗口 1280×821@dpr1.75。
> fixtures 已修复污染（打字注入 + 往返损坏）并重新生成；1MB = 11629 顶层块。
> **教训**：WebView 的 HTTP 缓存会留存旧 optimized chunk（vite chunk 名不含内容
> 哈希），node_modules 打补丁后必须清 .vite + 无缓存 reload，否则测的是旧代码
> （本轮曾因此把"整篇塌块"误判为 cv 档回归，实为缓存旧模块）。

| 指标 | 档位 | 本机基线 | 已知基线 | 目标 |
|---|---|---|---|---|
| G1 打开 | 默认 | 12447-12627ms（3 轮）；open 场景 12201ms，6 LT 总 11.5s max 8186 | 35.1s | ≤18s |
| G1 打开 | +viewport | 6718-7099ms（3 轮）；open 场景 6762ms，9 LT 总 6.3s | 7.8~9.7s | ≤6s |
| G2 打字 p95 | +viewport | 584ms（事件延迟，40 事件） | ~480ms | ≤360ms |
| G3 停顿窗长任务 | +viewport | 剖面：decoration diff valid+forChild+takeSpans ≈4.4s / 8.5s 窗；getClientRects 708ms；restartAnimation 712ms；序列化 LT 694ms（save 场景同源）；cv 停顿重建未单独触发（profile 窗口 800ms < 1.2s 重建防抖） | 重建 300-500ms / 序列化 662ms | 单片 ≤8ms 分片 |
| G4 搜索计数 | +viewport | 防抖后单次 LT 652ms，wall 895ms；**计数显示 0 个（正确性疑点，待 verify-search-count 复查）** | ~600ms | ≤100ms 且计数正确 |
| G5 Ctrl+S | +viewport | LT 694ms | 662ms | ≤150ms 或移出主线程 |
| G6 滚动 p50 | +viewport | 24ms（143 帧，p95 56ms，>50ms 帧 16） | 24ms | 不劣化 |
| G7 选中 | +viewport | 拖选 576ms / 三击 144ms / 点公式 616ms（事件延迟 max） | 见 performance.md:151-155 | 不回归，力争 -30% |

默认档交互补充（base-full.json）：clicks p95 2056ms（62 LT 总 20.2s）、typing p95
2440ms、scroll p50 189ms——无 cv 的全量布局成本，G2/G6/G7 的已知口径都在 cv 档。

导出各阶段（M1）：bench-export-search-save.mjs 依赖的 src/lib/exporterProbe.ts
不在仓库中，export-stages 场景暂无法测（需先补探针文件）。

## 基线产物

- perf/results/base-open-default.json（3 轮，默认档）
- perf/results/base-open-viewport.json（3 轮，cv 档，缓存旁路后）
- perf/results/base-full.json（默认档七场景）
- perf/results/base-full-cv.json（cv 档七场景）
- perf/results/profile-typing.cpuprofile（cv 档打字剖面）
