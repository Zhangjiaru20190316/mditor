# R9 阶段四：症状 F（专注模式滚动掉帧）归因定罪/排除书

> 探针 `perf/tmp-r9/probe-focus-jank.mjs`（dev）/ `perf/tmp-r9/prod-focus-jank.mjs`（prod）/
> `perf/tmp-r9/trace-focus-jank.mjs` + `trace-gpu-jank.mjs`（CDP Tracing）；
> 证据 `perf/results/r9-phase2-*` / `r9-phase3-*` / trace JSON；工作备忘 `.workflow/task2-forensics/r9-phase2-notes.md`。

## 0. 复现前提（先说清环境边界——本轮最大方法论事件）

- **dev 环境（vite dev + tauri dev，8 run：密度档/1MB × 快/慢/深位/settle0）复现失败**：
  focus 臂不劣于 normal（p95 比 0.51~1.05，方向不一致）。环境归因：
  ① dev 构建预热 1 块/26ms 爬行死锁（prewarm meta 走全量 buildDecos，1MB 档
  9639 块需 ~36min；R6 时代 45s 完成的差异 = release/dev JS 快慢），F-a 必要
  条件「表满载」在 1MB 不可达；② 密度档布局便宜（p95 6~9ms 绝对健康）；
  ③ dev 侧无 DXGISwapChain Present 停摆形态（trace 未见）。
- **prod 环境（用户安装 v5.0.0 + 用户症状文档「题型方法决策树」224KB cv 档
  + release 预热瞬时完成）复现成功且方向稳定**：focus 臂 j32=4~12 / normal
  臂恒 0（6 臂 ABAB × 多 run）。**症状 F 主战场钉死在 prod。**

## 1. 判别前提：掉帧 vs 跳位

全部 prod run 三哨兵残差（scrollPhase 窗）= 0、无 st 跳变、零 longtask——
**症状 F 为真掉帧（呈现断流），非内容跳位**。

## 2. 候选定罪/排除表

| 候选 | 判据 | 证据 | 结论 |
|---|---|---|---|
| F-a 高度表宽度陈旧 | 掉帧帧与 cv.relearn/scrollHeight 变化同帧对齐 | prod 掉帧帧 dsh=0（scrollHeight 无同帧变化）、cv.relearn=0 全臂；dev 1MB 表冷（预热死锁）不可达 | **排除**（机制在场证据：宽度突变坐实 985→1249，但未转化为滚动期掉帧） |
| F-b 宽度/面积成本 | 宽度对齐臂掉帧 ≈ focus | wctrl（pw 1250=focus）j32=0；vh-align（vh 805=focus）j32=0；wh-align（1256×884 双维）j32=0；GPU trace normal @1256×899（更大）Present max 0.4ms | **彻底排除**（几何三要素+面积全与掉帧无关） |
| F-c 诊断走查税 | 掉帧与 walkBlocks 节律对齐 | normal 臂 layout 事件 33~42 个仍 0 掉帧；focus 掉帧帧与 layout 事件对齐率 0/12、1/9、4/8 | **排除**（方向不符：事件多者不掉帧） |
| F-d hover-zone/toolbar 过渡 | 贴顶时掉帧/隐藏归零 | no-hover-zone 注入后 focus j32=8 依旧 | **排除** |
| F-f 打字机组合 | 关闭后归零 | 用户现场 typewriterMode=false（生产设置核实） | **排除**（不在场） |
| **F-g（新源，清单外）：ai-fab 呼吸动画的合成器保温效应丢失** | 见 §3 | run18/23/24/20-22 原型矩阵 | **定罪** |

## 3. F-g 定罪链（run5~26 逐环）

1. **单元素二分矩阵**（normal 模式 + is-focus 等效 CSS 分组注入，vhctrl 臂同
   位置对照）：仅藏 `.ai-fab`（run18 j32=7）与藏 resizer+opener+fab（run16
   j32=8）复现；仅藏 titlebar/status/tabbar/sidebar 塌缩/resizer（run13/14/15/
   17/19）全 0。真 focus ×5 run 全掉帧。**触发面 = ai-fab 隐藏。**
2. **CDP Tracing 定位管线环节**（gpu categories）：focus 每个掉帧 gap 的时长
   与 GPU 进程 `DXGISwapChainImageBacking::Present` 单次阻塞严格一致
   （40~124ms × 7 gap）；同期 renderer 全线程无 >2ms 任务、RasterCHROMIUM
   max 5.2ms（光栅便宜）。normal 同文档更大几何（1256×899）：Present max
   **0.4ms**、12s 内 2008 次呈现（≈每 vsync）；focus 仅 340 次/11s。
   **病灶 = 滚动帧的 Present 阻塞（等待 DWM），非主线程/光栅。**
3. **保护因子解剖**（原型矩阵）：
   - fab 可见 + 动画在（normal）→ 干净（连续呈现保温 swapchain/DWM）；
   - fab 可见 + `animation:none`（run23）→ **掉帧 8/8** → 保护因子是动画非元素；
   - fab `opacity:0` + 动画在（run24）→ 掉帧 → 合成器剔除有效不可见层；
   - 隐形 1px ::after opacity 0→0.02 动画（run22，验证确实在跑）→ 掉帧 →
     无有效可见输出的帧不驱动呈现管线。
   - fab 动画 = `fab-pulse 2.4s infinite`（transform+opacity 合成器动画，
     44px 光晕逐帧可见变化）→ 唯一已证保温源。
4. **机制结论**：`.ai-fab:not(.active)::after` 的无限呼吸动画在 normal 模式
   驱动合成器逐 vsync 产帧呈现，使 DXGISwapChain 常热；`.is-focus .ai-fab
   {display:none}`（focus 产品设计）同时消灭了该动画 → 滚轮间隙（450ms）
   零产帧 → swapchain/DWM 冷却 → 下一滚动帧 Present 阻塞 40~124ms = 用户
   所见"一顿一顿"。**focus 模式与 normal 模式的全部差异中，唯一被数据
   支持的掉帧源。**
5. 位置效应注记（R8 教训延续）：晚段 run（20~26）末臂（文末区）恒 0 掉帧
   而中段臂掉帧——文档位置混杂存在；定罪与修复判定均取**同位置对照**
   （naf 系实验 vhctrl 臂与 focus 臂同区间序）。

## 4. 与任务书预设立场的出入（如实声明）

- 任务书 §2.B 五候选（F-a~F-f）全部排除；真凶是清单外的 F-g（任务书允许
  "多候选可并存"，未禁止新源）。
- 任务书 §2.A「差异全部来自布局突变的下游效应」的预判**不成立**——几何
  突变（宽度/高度/圆角/阴影/padding）全部实验排除；真凶是 chrome 隐藏的
  **伴生效应**（常驻动画消失 → 呈现管线冷却）。
- F-a 机制（高度表宽度陈旧、无重学路径）**代码事实全部成立**（本轮静态
  复核 + cv.relearn=0 行为验证），但未在本症状中转化为掉帧——留档为
  潜在风险（连同 1MB dev 预热死锁），非本轮修复对象。

## 5. 修复定案（阶段五 Fix-A，e38aaa9）

原型矩阵收口（真 focus 臂注入，同 run 内对照）：

| 原型 | 内容 | focus j32 中位 | 结论 |
|---|---|---|---|
| —（基线） | 真 focus | 8~12（早期 run5/7/8）· 4~5（晚段 run20~24） | 症状在 |
| keepwarm | 1px ::after transform 抖动（opacity 恒 0） | 8 | 无效（合成器跳过无可见输出帧） |
| keepwarm2 | 1px ::after opacity 0→0.02 动画（验证在跑） | 4 | 无效（有效不可见，仍不驱动呈现） |
| fab-invisible | fab opacity:0 + 动画续跑 | 5 | 无效（合成器剔除有效不可见层） |
| **fab-ghost** | **fab opacity:0.05 + 动画续跑** | **0** | **治愈**（可见阈值内最低档） |
| **main-jitter** | **.main 层 translateZ(0↔0.001px) infinite** | **0** | **治愈（零视觉变化，选为 Fix-A）** |

- **Fix-A = main-jitter**：`.is-focus .main` 挂 `focus-keepwarm 2.4s linear
  infinite`（keyframes 只动 translateZ——无 2D 位移、无 perspective 祖先 →
  渲染零位移；transform 逐帧更新驱动合成器连续重组呈现）。层纹理复用，
  光栅零成本。`.app-idle` 暂停（窗口隐藏不空烧，与 fab-pulse 同纪律）。
- B12 动效 kill switch（「无」档/reduced-motion）连带停掉保温动画 → 该
  档位下 fab-pulse 同停、两模式对称承受呈现间歇，属用户显式偏好，不豁免
  （留档）。
- fab-ghost（5% 幽灵）作为备选留档未采用（有可感知风险，违反红线 16 零
  视觉变化偏好）。
- 守卫测试 `src/lib/focusKeepwarm.test.ts` ×4（动画在位 infinite / keyframes
  只动 translateZ / .app-idle 暂停 / fab 隐藏产品定案未被带动）；npm test
  990 全绿（986 基线 + 4）。
