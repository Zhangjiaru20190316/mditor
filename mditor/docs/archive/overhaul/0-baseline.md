# 项目全面治理 · 阶段 0：基线报告

> 日期：2026-08-28 ｜ 基线锚点：`main@9421ded`（v4.6.1）｜ 采集人：ZCode
> 本报告是后续四个阶段（性能 / 安全 / Bug / 工程化）的对照原点；
> 所有「优化前/修复前」数字以本报告为准。

## 1. 四项检查结果

| 检查 | 结果 | 明细 |
| --- | --- | --- |
| `npm run build`（tsc --noEmit + vite build） | ✅ 全绿 | 12.35s。体积提示：2 个 chunk 超 2500kB——`vendor-milkdown` 2715kB（gzip 907kB，主包）、`html-to-docx.browser.esm` 1649kB（gzip 493kB，**懒加载块**，仅导出 DOCX 时载入） |
| `npm run test`（Vitest） | ✅ 全绿 | **34 文件 / 363 例全部通过**，0 失败 0 跳过，15.9s。1 处 stderr 噪声：`blockCommands.test.ts` 列表互转用例打印 `TextSelection endpoint not pointing into a node with inline content (list_item)`——用例本身通过，属 PM 内部告警，列入阶段 3 观察项 |
| `npm run lint`（ESLint） | ❌ **79 error / 0 warning** | 分布：`perf/*.mjs` 18 个脚本共 78 个（`no-undef` 的 `console`/`process` 为主——ESLint 配置未给 .mjs Node 脚本配全局；少量 unused vars）；业务源码仅 1 个：`src/lib/devAnomaly.test.ts:309` `_drop` 未使用 |
| `cargo clippy --all-targets` | ⚠️ 编译通过，**6 warnings** | `lib.rs:8` doc 缩进；`ai.rs:36` 无效果运算；`ai.rs:86` 参数过多（9/7）；`ai.rs:121` 多余借用；`ai.rs:176` 参数过多（11/7，`ai_chat_stream`）；`ai.rs:218` 多余借用。cargo check 随 clippy 隐含通过 |

**判定**：构建与测试可作可信基线；lint 与 clippy 未达「全绿/零警告」，恰是阶段 4 的入场清单（改动量小、无风险）。

## 2. 性能基线（CDP 驱动真实 dev 实例，3 轮取样取中位）

- 样本：`perf/fixtures/一元微分学习题集_CMC备战.md`（224KB / 3609 行 / KaTeX 密集，副本）
- 实例：`npx tauri dev --config src-tauri/tauri.dev.conf.json`（com.mditor.app.dev，CDP :9223），**默认设置（bigDocPerformance / bigDocViewport 均关）**
- 工具：`node perf/baseline.mjs overhaul-base-{1,2,3}`（七场景脚本化交互），数据存 `perf/results/overhaul-base-*.json`

| 场景 | R1 | R2 | R3 | 中位/代表值 |
| --- | --- | --- | --- | --- |
| 打开文档（点击→内容稳定） | 2505ms | 2081ms | 2080ms | **2081ms**；期内最长长任务 1072~1500ms |
| 点击段落 ×10：事件延迟 p95 | 88ms | 80ms | 80ms | **80ms**（长任务 max 67~69ms，>200ms 计 0） |
| 双击选词 + 选区工具栏 | 0 长任务 | 0 | 0 | **0 长任务** |
| 拖选半行：事件延迟 max | 336ms | 336ms | 320ms | **336ms**（0 长任务） |
| 三击选段：事件延迟 max | 56ms | 56ms | 64ms | **56~64ms** |
| 点公式→点正文 ×3：p95 | 360ms | 376ms | 368ms | **368ms** |
| 打字 12 键：事件延迟 p95 | 72ms | 72ms | 72ms | **72ms**（dev+CDP 合成输入固定开销，生产日志 6ms） |
| 滚动 30×400px：帧间隔 p50/p95 | 6/23ms | 6/24ms | 6/24ms | **6/24ms** |
| Ctrl+A 全选 / Ctrl+Z 撤销 | 0 长任务 | 0 | 0 | **0 长任务** |

三轮数据高度一致（R1 的 open 略高属首轮冷缓存预热）。与 `docs/performance.md` 记载的 v4.6.1 修复后状态吻合，两个「已知且归因完毕」的残留：

1. **打开 ~2.1s**：与解析无关（<5ms），成本 100% 是 1662 顶层块 × KaTeX 的首次全量布局；唯一杠杆是 content-visibility（已做成 `bigDocViewport` 开关，默认关）。
2. **拖选 ~330ms / 点公式 ~370ms 离群**：`caretPositionFromPoint` 浏览器命中测试内部成本，应用层无杠杆；开 c-v 档后缩到视口规模（40ms/24ms，见 performance.md 第二轮表）。

**健康检查**：`perf/boot-errors.mjs` / `open-errors.mjs` 无静默失败；仅已知 dev 良性警告（Vue 特性 flag、KaTeX strict warn、reload 时 TAURI callback id）。

## 3. 环境说明

| 项 | 值 |
| --- | --- |
| OS | Windows 11 家庭中文版 10.0.26200 |
| CPU / 内存 | Intel i9-14900HX / 15.7GB |
| Node / npm | v24.15.0 / 11.12.1 |
| Rust / cargo | 1.97.1（clippy 随附，rust-clippy 1.97.0 规则集） |
| 基准纪律 | 沿用既有结论：**同机跨时段负载漂移实测 2~3 倍，跨时段单轮对比不可信**——后续每项优化验证必须同窗口 ABAB 交错对比 + CPU 剖面归因 |
| 采样注意 | 打字场景会触发 autosave 写盘——永远用文档副本（fixtures 已是）；生产实例可能单实例转发，dev 必须 `.dev` identifier；TaskStop 杀 tauri dev 后 vite/cargo 子进程残留需 netstat 补刀（1420/9223，本次已清理） |

## 4. 阶段 0 结论与后续入场清单

基线可信、环境可控，可进入阶段 1。入场时已知的候选线索（阶段 1 摸底时逐项核实，不做预设结论）：

- 冷启动/首帧：`index` 主包 1024kB + `vendor-milkdown` 2715kB 同步载入对启动的影响（构建期 chunk 布局，非运行时数据，待测）
- 打开路径：~2.1s 长任务已被归因为首次全量布局，杠杆已知（c-v），属「已定位未默认启用」项——阶段 1 评估是否值得动默认值（铁律：默认关不动，除非用户确认）
- 拖选/点公式离群：已归因为浏览器内部成本，**勿再追**（两轮纪律）
- lint 79 error / clippy 6 warnings：阶段 4 素材，改动零风险
- `blockCommands` 测试的 PM TextSelection 告警：阶段 3 观察项
