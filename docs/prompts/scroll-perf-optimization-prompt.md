# 任务：公式下标渲染缺陷修复 + 数学密集大文档滚动卡顿治理

> 使用方式：开一个新会话，把本文件全文粘贴给 AI 编程代理（ZCode）执行，并要求其调用 /workflow 动态工作流编排（见"工作方式"节，强制）。执行前先填写下方【填写】区。

## 角色与仓库

你是资深 Web 渲染性能工程师，在 Mditor 仓库工作（前端代码在 `mditor/` 子目录，桌面 Tauri / 鸿蒙 ArkWeb 双平台，React 18 + @milkdown/crepe 7.22.1 + ProseMirror + KaTeX 0.18.4，ArkTS 壳只加载 Web 层，全部渲染发生在 Web 侧）。

本任务含两个独立目标，分开提交：

- **任务一（正确性，最高优先）**：块级公式下标渲染缺陷——最新版本出现，属功能回归。
- **任务二（性能）**：数学公式密集大文档滚动卡顿，历轮优化后主观感受反而变差。

【填写】卡顿平台（鸿蒙真机/桌面）：___；示例文档：___；下标问题出现的文档/公式（若与下文症状不同）：___；其他线索：___

## 工作方式（强制）

1. **必须调用 /workflow（动态工作流，CreateWorkflow）编排核心环节**，不允许单代理串行盲查：
   - 任务一至少拆四路子代理：链路取证（逐阶段抓到达 KaTeX 的源串）、KaTeX 语义验证（node 实验）、修复实现、独立复核。取证先行，复核者不得是实现者。
   - 任务二至少把"基准建立 + ABAB 对比 + CPU 归因"做成带数据门禁的工作流（`world.run` 跑基准脚本，归因数据不成立不得进入修复阶段）；修复项按 P0-P4 分批推进。
2. **先复用遗留取证**：上一个会话已启动过公式下标问题的取证工作流（run: `dwfrun-7e3f2768-8aec-43dd-8644-076597179fa2`，脚本 `.zcode/workflow-drafts/公式下标渲染异常根因取证.dwf.ts`），其结论未知——先用 GetWorkflowRun / ListWorkflowRuns 查结果，有现成结论直接复用，无果再自建工作流。
3. **两任务分开提交**：正确性修复先行、独立成 commit；性能优化不得夹带任何渲染行为变化。

---

## 任务一：块级公式下标渲染缺陷（正确性，最高优先）

### 症状（已取证，来自用户截图）

块级公式 `$$\frac{\partial F}{\partial x} = F_1' \cdot 1 + F_2' \cdot y + F_3' \cdot 1$$` 渲染异常：

- 分子 `\partial F` 消失（只剩带下划线的 ∂x）；
- `F_1'/F_2'/F_3'` 的下标 1/2/3 掉到基线下方；
- 撇号几乎不可见。

**关键线索**：同屏正文行内公式 `F₁'` 渲染正常 → 排除 CSS/字体/宏配置，指向块级公式独有路径或源串被污染（疑似 `\_` 转义污染——KaTeX 收到的可能是 `F\_1'` 而非 `F_1'`）。

### 已排除（不要重查）

- 最近 5 个提交（HEAD=4ecafa7 v4.17.0）对公式渲染链路零功能改动；katex/milkdown/remark-math 版本均未变。
- 米色背景框来自 `@milkdown/crepe/lib/theme/common/latex.css`，与本缺陷无关。

### 渲染路径定位（已查明）

- 编辑器块级预览：`@milkdown/crepe/lib/esm/index.js:3438-3443` 的 `renderLatex`（`previewOnlyByDefault: true`，配置在 `mditor/src/hooks/useMilkdown.ts:665-691` 附近）。
- 静态管线（AI 面板/批注预览）：`mditor/src/lib/renderMarkdown.ts:182`（rehype-katex + macros）。
- 本地补丁 `mditor/patches/@milkdown+crepe+7.22.1.patch` 只给行内公式 toDOM 注入了 inlineKatexOptions 宏（v4.12.1），**未触及块级渲染**。
- 行内正常/块级异常 → 先确认缺陷只在编辑器块级路径，还是在静态管线同样复现（决定修复层级）。

### 待验证主假设与嫌疑清单

主假设：公式源串在到达 KaTeX 前被预处理污染（`_` 被强调解析或 `\_` 转义还原破坏），仅影响块级 `$$` 路径。

嫌疑文件（均在 `mditor/src/lib/`）：`mathNormalize.ts`（定界符归一化 + `unescapeDollar` + 误伤防护）、`remarkMathGuard.ts`、`remarkMathFence(Alias).ts`、`remarkMathNumbering.ts`、`mathLiveGuard.ts`、`mathConfig.ts`、`pluginCast.ts`。

特别嫌疑：v4.12.1（commit `1a6f367` 新增 remarkMathGuard/mathLiveGuard、`b57651f` Typora 双行 `$$` 块解析根修）是块级公式路径最近的语义改动，且在"最近 5 个提交"排除窗口之外——优先做版本二分。

### 执行步骤

1. **最小复现**：新建只含上述公式的文档，编辑器块级预览确认异常；同一公式走静态管线（AI 面板粘贴预览）对比。
2. **KaTeX 语义验证（node 实验）**：`katex.renderToString` 分别渲染 `F_1'` 与 `F\_1'`（及 `\frac{\partial F}{\partial x}` 的污染变体），确认污染源串能复现"分子消失 + 下标掉落 + 撇号不可见"的视觉签名。上个会话该实验被 plan mode 拦截未跑，必须补上。
3. **链路取证**：在块级路径的每个预处理阶段后（mathNormalize → 各 remark 插件 → crepe renderLatex 入口）打印/断言实际到达 `katex.render` 的字符串，找到第一个被改写的环节。
4. **版本二分**：用最小复现文档在 v4.12.0 / v4.12.1 / v4.13 / HEAD 对比，锁定引入版本，与第 3 步交叉验证。
5. **修复在污染源头**，禁止在渲染层 band-aid（不许靠 KaTeX 选项或 CSS 掩盖）。
6. **回归测试**：用原始公式做单测（源串逐阶段断言 + 渲染快照），并确认修复不破坏 mathLiveGuard 对打字产生的假公式（`$1-$10`）的降级保护。
7. 改 remark 插件集须同步 worker 哨兵 `expectedPluginCount` 三链路（parseWorker / remarkPipeline / 编辑器 remarkCtx），失配即静默回退主线程解析。

### 任务一交付物

1. 根因结论：哪个环节、哪行代码污染了源串（附逐阶段取证数据）。
2. 修复 commit + 回归测试。
3. 双路径验证结果：编辑器块级预览与静态管线均正确渲染原公式。

---

## 任务二：数学密集大文档滚动卡顿——根因定位与修复

### 问题

数学公式密集的大文档滚动/滑动明显卡顿，且此前 7 轮专项治理 + 5 批综合优化（至 v4.17.0）后主观感受**反而变差**。历轮报告在自家基准内都显示"滚动零回归"——说明要么基准测不出真实回归，要么卡顿来自基准外路径（设置开关、常驻插桩、长会话滚动特有行为）。你的任务不是再猜一轮优化，而是：**复现 → 建立测得出问题的基准 → 归因 → 修复 → 用数据证明**。

### 已查明事实（直接采用，不要重查）

1. 编辑器整篇一次性渲染，无虚拟化——刻意决策（`mditor/docs/performance.md` 阶段 3）。
2. 行内公式 `math_inline.toDOM` 每次节点重建都重跑 `katex.render`，编辑器路径**无公式级缓存**（静态管线 `mditor/src/lib/renderMarkdown.ts` 反而有 HTML LRU，可参照）。
3. content-visibility 是唯一被实证的滚动杠杆，但 `bigDocPerformance`/`bigDocViewport` **默认 false**（`mditor/src/defaults.ts`）；未开启时数学密集大文档付全量布局款（1MB 文档约 21 万 DOM 节点）。
4. `mditor/src/lib/scrollDebug.ts` 常驻生产：每帧 rAF tick + 哨兵 rect 读取；big 模式休眠期每 1s 遍历全部顶层块读 offsetHeight，触发窗口内加密到 100ms/次。
5. 若开发者模式/诊断录制开启：`mditor/src/lib/diagnostics.ts` 每 30s 一次 `querySelectorAll("*")` 全节点计数——21 万节点文档上是可感知的周期性卡顿。
6. v4.12.1 起 `mathLiveGuard` 在每个 ProseMirror 事务上跑；`remarkMathGuard` 使 worker 插件哨兵 +1，失配会**静默回退主线程解析**。
7. katex 双实例：app 侧 ^0.18.4 与 rehype-katex 嵌套 0.16.47，约 545KB 双份进 eager；mhchem 注册在 0.18.4 而静态管线用 0.16.47，`\ce{}` 疑似失效（顺带验证）。
8. 现有滚动基准（`mditor/perf/baseline.mjs`）= 30 次合成滚轮 ×400px 一次性、dev 实例——覆盖不了代码块懒挂载/30s 拆除、KaTeX 进出视口、批注盖章、cvMemory 高度重估等真实滚动行为。
9. 前科：装饰/cvMemory 改动曾触发 Milkdown 表格块 nodeview 整批重建（commit 8469bff），级联 ghost 滚动——已有回归守卫 `tableBlockPatch.test.ts`、`md1011-regression.test.ts`。
10. 基准漂移可达 2-3 倍（历轮报告自证），单轮对比不可信，必须 ABAB 交错。

### 执行阶段

#### 阶段 0：环境核实（先排除"优化根本没生效"）

1. 在与用户感知一致的环境复现。
2. 核实运行时设置实际开关状态：`bigDocViewport` / `bigDocPerformance` / 开发者模式 / 诊断录制。若视口化未开启——第一嫌疑即此，先量化开启前后的滚动差异。
3. 开发者模式若开启，先关掉再测（排除 30s 全节点扫描干扰）。

#### 阶段 1：建立"测得出问题"的滚动基准

- 扩展 `mditor/perf/baseline.mjs` 滚动场景：连续滚动 ≥60s、穿越公式密集区/代码块区/批注区、含快速往返。
- 采集：丢帧统计（rAF 间隔）、long tasks、Layout/Paint 耗时（CDP tracing）。
- fixture：`mditor/perf/fixtures/一元微分学习题集_1MB压测副本.md` + 用户真实中等文档（约 152KB/3400 行）。
- ABAB 交错对比：当前 HEAD vs 第 5 批优化前（v4.13）vs 公式链路增强前（v4.5）。
- 若确认回归：用该基准 git bisect 定位引入提交。

#### 阶段 2：归因（禁止先动手改代码）

- CPU 剖面（`mditor/perf/select-bench.mjs` / `profile-select.mjs`）+ `mditor/perf/rect-spy2.mjs` 抓强制布局。
- 判定卡顿构成：原生布局/绘制 vs JS。历史结论"JS 占比 <10%、全量 DOM 布局为主"——若仍如此，修复方向是减节点/缩布局范围，JS 微优化无效。
- 滚动期逐项排查：KaTeX 节点重挂载/重渲染、cvMemory 高度重估频率、装饰变化引发 nodeview 重建、scrollDebug 扫描命中、代码块懒挂载/拆除与滚动共振。

#### 阶段 3：修复（凭阶段 2 证据排序，每项独立提交 + 回归测试 + ABAB 数据）

- **P0 视口化生效路径**：公式密集大文档自动启用 `bigDocViewport`（三层判定已在 `mditor/src/lib/memory.ts`；改默认值属产品决策——先出提案+数据，用户拍板后再改）。
- **P1 编辑器公式渲染缓存**：参照静态管线 HTML LRU，给 `math_inline`/块公式预览加"latex 源 + katexOptions 签名"键控缓存，消除 DOM 重建时的重复 KaTeX 渲染。
- **P2 常驻插桩成本**：scrollDebug 每帧 tick/哨兵 rect/周期性全块扫描的降频或门控。注意 `recentWrite` 归因是 ghost 滚动修复的生产依赖，不得破坏 ghost 归因。
- **P3 katex 双实例去重**（顺带修 `\ce{}` 失效疑点）。
- **P4** mathLiveGuard / remarkMathGuard 常驻成本采样确认后再决定是否优化。

### 红线（违反 = 制造新回归）

1. 不做整篇虚拟化/分块渲染（performance.md 明确不做）。
2. `bigDocViewport` 档必须保留公式渲染（砍公式是减配档行为，对公式密集文档不可接受）。
3. ghost 滚动四层补偿链（viewportAnchor / cvMemory / prewarm-comp / anchor-comp）不得无证据改动——这是三轮滚动疑难的修复成果。
4. 任何装饰/缓存策略改动必须评估对 Milkdown nodeview 的连锁反应，改后跑 `tableBlockPatch.test.ts` 与 `md1011-regression.test.ts`。
5. 遵守基准纪律：ABAB 交错、单轮不作结论、区分环境漂移。
6. 改 remark 插件集须同步 worker 哨兵 `expectedPluginCount` 三链路，失配即静默回退主线程解析。

### 任务二交付物

1. 诊断报告（复现环境、基准设计、归因数据），写入 `docs/optimization_report6.md`。
2. 修复提交：每项独立、带回归测试。
3. before/after ABAB 数据。
4. 更新 `mditor/docs/performance.md` 本轮结论。
5. 涉及默认设置变更的，单独提案等用户确认。
