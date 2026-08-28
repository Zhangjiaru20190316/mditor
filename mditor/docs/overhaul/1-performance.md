# 项目全面治理 · 阶段 1：性能优化报告

> 日期：2026-08-28 ｜ 前置：[0-baseline.md](0-baseline.md)（main@9421ded 基线）
> 产出提交：`c35fc7b`（cvMemory 增量映射）、`6252b21`（工作区搜索并发）、`5a76473`（测量基建）
> 纪律沿用：同窗口测量、先归因后动手、证伪优先、跨时段单轮对比不作数。

## 1. 八条关键路径摸底结论（全数据）

| 路径 | 结论 | 关键数据 |
| --- | --- | --- |
| 冷启动 | **无瓶颈，结案** | dev：FCP 140ms / DCL 105ms / 编辑器就绪 408ms / 闪屏 510ms / **0 长任务**；生产 bundle（vite preview + WebView 新标签）：冷盘 DCL 755ms（1.27MB JS 拉取+求值）、热缓存 167~191ms，全程 **0 长任务**。主 chunk 2715kB 是磁盘/内存话题，不构成启动时间问题 |
| 大文档打开（1MB/25341 行） | 布局墙（既有结论的放大版） | 默认设置：**35.1s**（25 个长任务共 31.5s，max 14.8s）；剖面归因：`(program)` 原生布局 12.9s + `get focusNode` 强制布局 3.7s + DOM 增删 ~0.9s + GC 0.4s——**58.6 万 DOM 节点的布局成本，JS 小头**。开 bigDocViewport：**7.8~9.7s** |
| 打字输入 | **已修一项 + 摸到 PM 内生墙** | 1MB+cv：修复前 p95 672ms → 修复后 480~528ms（装饰对账 ~200ms/键 移除）。剩余 ~300ms/键 = prosemirror-view `updateChildren` 的 **O(顶层块数)** 内生成本（证伪实验：零装饰仍 2990ms `child()` + 641ms takeSpans）。224KB 档不受影响（v4.6.1 已修，本轮未回归） |
| 选区/拖选 | v4.6.1 修复在 1MB 档依然成立 | 1MB+cv：拖选 56~992ms、三击 48~200ms、点公式 80~688ms（轮间方差大，与 224KB 档同型；0 长任务——渲染器受限而非 JS） |
| 滚动 | cv 是有效杠杆 | 1MB 默认 p50 **75ms**（13fps）→ cv 开 p50 **24~30ms**；224KB 档 6/24ms 不变 |
| 导出 | **主线程阻塞 ~4s（1MB 档），挂起待决策** | DOCX 管线（对真实编辑器 HTML，27.7MB）：juice 916ms + html-to-docx ~3s（计时后对探针输入崩溃，见观察项），全部主线程；公式栅格化反而便宜（0.02ms/式 × 1.58 万 = 264ms）；renderBlockMath 8ms |
| 搜索替换 | **已修一项** | 工作区搜索 200 文件热缓存 **4750→625ms（7.2x）**，串行 IPC 读是根因；500 文件外推 ~12s→~1.6s。文档内搜索：防抖后单次计数 ~600ms（1MB 全文序列化+regex），已有 200ms 防抖保护，可接受 |
| 文件保存 | 可接受，已缓解 | Ctrl+S@1MB：序列化长任务 662ms + 写盘 959ms 壁钟；自动保存路径已由 v4.6.1「停键序列化挪 idle」缓解。`io.ms.file:write` 高计数是主线程拥堵的下游症状（tracedIo 计壁钟），非磁盘问题 |

## 2. 已修复项（前后数据 + 提交）

### 2.1 cvMemory 装饰增量映射（`c35fc7b`）

- **现象**：1MB 文档（bigDocViewport 开）打字 p95 672ms，CPU 剖面显示 prosemirror-view 装饰对账占 50%（takeSpansForNode 2109 + forChild 2144 + valid 1585ms / 11.5s 窗）。
- **根因**：`cvIntrinsic` 插件 `apply` 在每个 docChanged 事务整树 `buildDecos`（1.16 万节点装饰）→ prosemirror-view 对全新 DecorationSet 全树对账。注释「亚毫秒级」仅在 3.6k 块（224KB）成立，11.6k 块下每键 ~500ms。
- **修复**：docChanged 改 `DecorationSet.map`（O(变更)）+ 编辑停顿 1.2s 尾随防抖补一次整树重建（复活撤销/粘贴经删除映射丢掉的装饰）；移除 `prewarmRange` 死状态。
- **验证**：剖面 takeSpans 2109→160ms、valid 1585→0；打字 p95 672→480~528ms；`cv-correctness` Ctrl+A PASS；新增 5 例单测锚定 map/重建双语义；全套 372 例全绿。
- **回滚**：单 commit revert。

### 2.2 工作区搜索并发读取（`6252b21`）

- **现象**：200 文件工作区搜索热缓存 4.75s（冷缓存首跑 24.2s，含杀软首扫）。
- **根因**：`searchWorkspaces` 串行 `for await readTextFile`；实测 plugin-fs 读为 IPC 延迟主导（~21ms/次；50 文件串行 1046ms / 全并发 66ms = 16x）。
- **修复**：16 路滑动窗口并发池，结果按文件序写回（保序），预算截断语义保持（并发下允许 ≤ 窗口×单文件上限 超出），单文件失败照旧跳过。
- **验证**：同条件复测 4750→625ms；新增 4 例 mock 测试（乱序完成仍保序/失败跳过/截断/空 query 短路）。
- **回滚**：单 commit revert。

## 3. 评估后不修的项（数据与理由）

| 项 | 数据 | 不修理由 |
| --- | --- | --- |
| prosemirror-view O(顶层块数) updateChildren | 1MB 档 ~300ms/键（零装饰证伪实测） | PM 内生行为，修补 `updateChildren`/`iterDeco` 属 PM 核心手术，正确性风险远超收益；1MB 档推荐 bigDocViewport（交互延迟已到可用区间）；真要做是上游 PR 或深度 patch 的独立攻坚 |
| 打开 35s（默认设置）/ 7.8~9.7s（cv） | 既有两轮结论放大版 | 唯一杠杆仍是 content-visibility（已产品化为开关，默认关是既定决策——是否对 ≥1MB 自动开启属产品决策，见第 5 节） |
| DOCX 导出主线程 ~4s | juice 916ms + htmlToDocx ~3s | 用户触发的低频操作且导出前有对话框；worker 化需搬运 juice/html-to-docx（含 DOM 依赖评估），收益/风险比中等，挂起待用户决策 |
| 文档内搜索计数 600ms | 1MB 全文序列化+regex，已有 200ms 防抖 | 防抖后每 query 变更一次，非每键；序列化成本与 Ctrl+S 同源，若做「序列化下放 worker」应一并考虑（见第 5 节） |
| 虚拟光标 restartAnimation 577ms@1MB | B4 既有评估 | 224KB 档 74ms 已评估「低收益高风险挂起」；1MB 档占比 ~5%，不改变结论 |
| scrollDebug tick 475ms（打开期） | ~1% 占比 | 预付布局款（第一轮 observeMove 同款结论），不动 |
| 2 个 chunk >2500kB 警告 | vendor-milkdown 2715kB / html-to-docx 1649kB（懒加载） | 冷启动实测 0 长任务，不构成启动问题；手动分包收益仅磁盘观感，动构建配置需提案（红线） |

## 4. 观察项（转阶段 2/3 跟踪）

- **html-to-docx 对探针输入崩溃**（`startsWith of undefined`）：以 live DOM innerHTML 为输入时触发；App 真实路径（`getHTML()` 输出）是否受影响未验证——转阶段 3 待复现（用真实导出路径测 DOCX@1MB）。
- **dev 模式 `global is not defined`**：html-to-docx 在 dev 直接 import 报错（App 懒加载路径未复现此错，疑 vite 预打包差异），生产 bundle 正常。不影响用户，记录备查。
- **HMR 旧模块测量坑**：页面动态 `import('/src/lib/xxx.ts')` 在 HMR 后可能命中模块注册表旧版本，测量必须加 `?t=Date.now()` cache-buster（本轮搜索修复验证时踩过：旧模块跑出「无改善」假结果）。
- **TaskStop 杀 tauri dev 后 mditor.exe 幸存**持有单实例锁，下次启动秒退——必须 `taskkill /IM mditor.exe /T` 补刀（记忆坑 +1 实例）。

## 5. 提请用户决策的事项（P2/P3）

1. **≥1MB 文档是否自动启用 bigDocViewport**（或把默认开启阈值做成「体量 ≥ X 自动开」）：数据支持（默认档 1MB 不可用：打开 35s/打字 2.7s vs cv 档 7.8~9.7s/480ms），但改变默认行为，按纪律不擅动。
2. **DOCX 导出 worker 化**：~4s 主线程阻塞移出 UI 线程；工作量中等（库的 DOM 依赖需评估）。
3. **序列化下放 worker**（搜索计数/Ctrl+S/导出共用同一成本源）：1MB 档单次 ~600ms。

## 6. 回归结论

- `npm run test` **372/372 全绿**（基线 363 + 新增 9：cvMemory 5 + workspaceSearch 4）。
- `npm run build`（tsc + vite）全绿 11.05s；改动文件 ESLint 0 问题。
- `cv-correctness.mjs`（Ctrl+A 跨视口全选）PASS；boot-errors 无新增静默失败。
- 224KB 档基线路径（两个大文档开关默认关）代码路径未触碰（cvIntrinsicPlugin 仅在 cv/big 档注册），无回归面。
