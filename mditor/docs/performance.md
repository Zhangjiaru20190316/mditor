# mditor 性能与体验治理总索引

本文是性能治理全史的唯一入口。文档体系分三层，各轮一致：

- **任务书**（要做什么、禁止什么）：仓库根 `docs/prompts/`
- **阶段证据**（测量原始记录的定罪/归因书）：`mditor/perf/results/*.md`
- **结题报告**（最终结论与门禁数据）：本目录 `large-doc-*-report.md`

历史各轮的旧正文与已完成任务书统一归档在 [`archive/`](./archive/)；测量原始数据（trace json、cpuprofile 等）不入库，如需找回见文末说明。

**当前状态**：滚动流畅度治理 R1~R10 已收官；**EX 轮（导出体系全面翻新）进行中**，见 [`export-overhaul-report.md`](./export-overhaul-report.md)。

## 大文档滚动/性能治理主线

| 轮次 | 主题 | 窗口 | 任务书 | 阶段证据 | 结题报告 |
|---|---|---|---|---|---|
| 基线期 | 大文档性能基线测量 | 2026-09 | —（已归档） | — | [`archive/large-doc-perf-baseline.md`](./archive/large-doc-perf-baseline.md) |
| 第一/二轮 | V3.6.5 时代滚动卡顿与公式下标缺陷（三阶段架构：cv 档/虚拟化/骨架） | v3.6.x~v4.x | [`scroll-perf-optimization-prompt.md`](../../docs/prompts/scroll-perf-optimization-prompt.md) | — | [`archive/performance-v3.6.5.md`](./archive/performance-v3.6.5.md) |
| 第三轮 | 1MB 档系统性卡顿 | 2026-09-23~24 | [`large-doc-perf-optimization-prompt.md`](../../docs/prompts/large-doc-perf-optimization-prompt.md) | — | [`large-doc-perf-report.md`](./large-doc-perf-report.md) |
| 第四轮 | 数学密集中型文档默认路径掉帧 + 动效基准 | 2026-09-30 | [`large-doc-perf-motion-optimization-prompt.md`](../../docs/prompts/large-doc-perf-motion-optimization-prompt.md) | — | [`large-doc-perf-motion-report.md`](./large-doc-perf-motion-report.md) |
| R5 | 滚动乱闪（F）与滚动位置乱动（J） | 2026-10 | [`large-doc-scroll-stability-optimization-prompt.md`](../../docs/prompts/large-doc-scroll-stability-optimization-prompt.md) | [prodlog](../perf/results/scroll-stability-r5-phase1-prodlog.md) · [interim](../perf/results/r5-phase2-interim.md) · [定罪书](../perf/results/r5-phase4-indictment.md) | [`large-doc-scroll-stability-report.md`](./large-doc-scroll-stability-report.md) |
| R6 | 公式渲染及时性（T）与完整性（M） | 2026-10 | [`large-doc-formula-render-optimization-prompt.md`](../../docs/prompts/large-doc-formula-render-optimization-prompt.md) | [prodlog](../perf/results/formula-render-r6-phase1-prodlog.md) · [基线定罪书](../perf/results/r6-phase3-4-baseline-indictment.md) | [`large-doc-formula-render-report.md`](./large-doc-formula-render-report.md) |
| R7 | 滚动停滚自漂移（症状 D） | 2026-10 | [`large-doc-scroll-drift-optimization-prompt.md`](../../docs/prompts/large-doc-scroll-drift-optimization-prompt.md) | [归因书](../perf/results/r7-phase4-attribution.md) | [`large-doc-scroll-drift-report.md`](./large-doc-scroll-drift-report.md) |
| R8 | 上滚掉帧/丝滑度不对称 | 2026-10-03 | [`large-doc-upscroll-jank-optimization-prompt.md`](../../docs/prompts/large-doc-upscroll-jank-optimization-prompt.md) | [归因书](../perf/results/r8-phase4-attribution.md) | [`large-doc-upscroll-jank-report.md`](./large-doc-upscroll-jank-report.md) |
| R9 | 专注模式滚动丝滑度 | 2026-10-04~06 | [`large-doc-focus-mode-scroll-smoothness-optimization-prompt.md`](../../docs/prompts/large-doc-focus-mode-scroll-smoothness-optimization-prompt.md) | [归因书](../perf/results/r9-phase4-attribution.md) | [`large-doc-focus-mode-scroll-smoothness-report.md`](./large-doc-focus-mode-scroll-smoothness-report.md) |
| R10 | cv 档滚动视口底部闪刷/换装可见 | 2026-10 | [`large-doc-bottom-flicker-optimization-prompt.md`](../../docs/prompts/large-doc-bottom-flicker-optimization-prompt.md) | [归因书](../perf/results/r10-phase4-attribution.md) | [`large-doc-bottom-flicker-report.md`](./large-doc-bottom-flicker-report.md) |
| **EX** | **导出体系全面翻新（PDF 自研管线重建与全格式完整性）** | 进行中 | [`export-overhaul-optimization-prompt.md`](../../docs/prompts/export-overhaul-optimization-prompt.md) | 落盘于 `perf/results/`（随阶段追加） | [`export-overhaul-report.md`](./export-overhaul-report.md) |

各轮测量的 smoke 截图（`r*-prod-smoke.png`、`prod-*.png` 等）同在 `mditor/perf/results/`。

## 并行的其他治理线

| 线程 | 主题 | 产出 |
|---|---|---|
| 代码质量审计（五批 + 第十轮全量审计，2026-09-18~21，v4.13→v4.17） | keyring、云同步跨盘修复、测试设施等全面审计与实施 | 根 `docs/archive/optimization_report*.md`（[第一批](../../docs/archive/optimization_report.md) · [二](../../docs/archive/optimization_report2.md) · [三](../../docs/archive/optimization_report3.md) · [四](../../docs/archive/optimization_report4.md) · [五](../../docs/archive/optimization_report5.md)） |
| v3.9 时代 overhaul（阶段 0~5） | 基线/性能/安全/bug/MD1011/表格视图 | [`archive/overhaul/`](./archive/overhaul/) |
| 更早期报告 | v3.9 优化、v3.9.1 体检、美学审计、Agent 化 | [`archive/`](./archive/) |
| 已完成的功能任务书 | 云同步（v4.12 实现）、图片公式修复 R2、鸿蒙迁移、多窗口、科研套件等 | [`archive/prompts/`](./archive/prompts/) |

## 当前活跃文档

- [`export-overhaul-report.md`](./export-overhaul-report.md) — EX 轮结题报告（进行中，按阶段追加）
- [`proposal-bigdoc-viewport-auto.md`](./proposal-bigdoc-viewport-auto.md) — 大文档视口自动化提案（待拍板）
- [`harmony-release.md`](./harmony-release.md) — 鸿蒙发版 runbook
- [`dev-anomaly-codes.md`](./dev-anomaly-codes.md) — 开发期异常码速查

## 测量原始数据去哪了

为保证仓库只沉淀结论，`perf/results/` 自 2026-10-11 起只保留 md 报告与 png 截图；trace json、cpuprofile、导出 html/pdf 等原始数据由 `.gitignore` 拦截，不入库。此前入库的历史原始数据已从 git 跟踪中移除，如需找回可 checkout 2026-10-11 之前的提交（`bb79646^`）。
