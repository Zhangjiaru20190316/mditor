# 任务：mditor 大文档滚动流畅度第八轮治理——上滚掉帧/丝滑度不对称专项

> 使用方式：本任务书配套 `/goal` 命令交付（目标文本见下方代码块，直接粘贴）。前端代码在 `mditor/` 子目录，所有 `perf/` 与 `npm` 命令在 `mditor/` 下运行。核心环节分阶段推进（§7），每阶段证据落盘（`perf/results/` 与报告草稿）并自查后才进下一阶段，禁止把归因与修复混在同一批。动手前必读第 0、1、2、3、9 节——本任务禁止盲改，禁止重修已修问题，禁止预设根因结论。
>
> ```text
> /goal 修复 mditor 大文档上滚掉帧/丝滑度不对称（第八轮专项，范围：上滚滚动中帧稳定性——渲染泵方向调度的上滚不对称积压、cvMemory 预热与视口学习的主线程争用、demote/IO 回带开销、打包 beta 与 main 的版本差核实；R7 停滚漂移已归零、R6 完整性门禁已达标，均为本轮不可回退前提）。任务书：docs/prompts/large-doc-upscroll-jank-optimization-prompt.md——先通读全文并遵守 §0 基线核实（含症状来源版本双对照，本轮第一要务）、§2 已查明事实集不重查、§3 禁区与红线，在 mditor/ 子目录下按 §7 阶段顺序执行，禁止盲改、禁止重修已修问题、禁止重走已证伪路线。完成判据（全部满足才 pass）：① 上滚掉帧主门——U1 对称比两指标（>32ms 帧数比与帧间隔 p95 比，up/down）均 ≤1.25（密度档与 1MB 双测、快慢滚各 ≥2 轮方向一致），U2 绝对强度分档达标（密度档较基线 -50% 或 ≤3‰、1MB 较基线 -30%，未达项附归因不许留空）；② 漂移/完整性/及时性零回退——R7 D1 口径密度档四场景位移帧维持 0、1MB ≤9 不劣化；M1/M2/M3 维持 0/0/100%（M3 须用解题技巧档）；T1/T2 不劣化 >10%；③ 零回归——npm test 全绿（≥986 基线，以实跑为准），1MB 打开/打字/切换基准零回归；④ 交付——报告落盘 mditor/docs/large-doc-upscroll-jank-report.md，每个修复项独立 Fix-X commit 且附新增测试，重建打包安装包实机冒烟断言上滚掉帧与停滚漂移双项，CHANGELOG 与 memory 日记更新。红线：KaTeX 0.18.4 单实例与宏语义不动；R4~R7 全部 Fix 不得破坏；不得以"放开上滚冷算"（撤销 R6 Fix-B 上滚带约束）、复活漂移或砍公式完整性/及时性换取上滚流畅度；overflow-anchor 维持禁用；四层补偿链无归因证据不动；观测与修复分开 commit；每 commit 前 npm test；先测后改六步。
> ```
>
> 前序任务书引用链（体例连续，背景可查）：`docs/prompts/large-doc-perf-optimization-prompt.md`（第三轮，已结题）、`docs/prompts/large-doc-perf-motion-optimization-prompt.md`（第四轮，已结题——1MB cv 档滚动布局墙在该轮封案，本轮 U 组 1MB 门禁的立论基础）、`docs/prompts/large-doc-scroll-stability-optimization-prompt.md`（第五轮，已结题）、`docs/prompts/large-doc-formula-render-optimization-prompt.md`（第六轮，已结题——R6 Fix-B 上滚带约束是本轮 §3 禁区）、`docs/prompts/large-doc-scroll-drift-optimization-prompt.md`（第七轮停滚漂移，已结题——本轮 D 组防回退门与 §6 交叉声明的来源）。
>
> 【填写】观察环境（用户已确认 2026-10-03）：症状在**打包版 v5.0.0-beta** 观察到——**注意安装构建时间待钉死**：v5.0.0-beta 版本号在 10-01（不含 R6/R7 修复）与 10-03 发版对齐（含 R5~R7，commit `5004551`）两个构建间复用，阶段一必须先钉死用户实际安装的是哪个构建（安装包 mtime / `%APPDATA%/com.mditor.app/logs/` 现卷首条时间 / 关于页构建信息），两构建的上滚形态可能完全不同。主战场文档（已确认）：**公式密集中型文档（密度档）+ 1MB 超长文档两档都有**。症状钉死：**症状 U——上滚滚动中画面一顿一顿（掉帧/丝滑度不对称，定义见 §1，禁止扩大或偷换）**。症状补充（快滚还是慢滚更明显/偶发频率/滚轮还是触摸板/是否伴随公式补绘或页面微跳出现）：___。复现线索（特定文档更明显/打开后多久出现/预热等待期还是完成后）：___。

## 0. 基线状态声明（执行第一步必须核实，禁止假设）

本任务书基于 2026-10-03 仓库状态撰写：

- HEAD = `5004551`（chore(release): v5.0.0-beta 发版对齐——CHANGELOG 第五~七轮三专项折叠为一个发版条目）；其后另有 `2e6552b`（site 官网性能专区）。撰写时工作区有未跟踪杂物（`mditor/nul`、`nul`）与 `memory/2026-10-03.md` 未提交改动，不影响本任务。
- **执行第一步**：`git status` + `git log --oneline -5`，据实记录 HEAD 相对 `5004551` 的实际状态（其后是否有新提交/未提交改动），报告开头声明；后续一切论述以核实后的代码为准。
- **症状来源版本核实（本轮第一要务，先于一切测量）**：按【填写】节钉死用户安装构建——若为 10-01 时代构建（不含 R6 Fix-B"上滚尖峰 21→11"、不含 R7 Fix-A/B 锁盒与同帧补偿），须先在 dev/main（含全部修复）复测同序列：卡顿大半消失则本轮靶重新钉死为 dev/main 残余形态；若用户已装 10-03 对齐构建，症状直接对应 main 现状。双版本对照结论（dev/main vs 用户构建）写入报告 §1，并据此修正 §2.B 候选优先级（U-e）。
- fixture 在位性（R7 结题时本机核实惯例）：`mditor/perf/fixtures/` 含 `无穷级数_密度档压测副本.md`（156,021B/2,355 行内公式）、`解题技巧_密度档切换副本.md`（60,065B，M3 块公式档——无穷级数档本无 ```latex 块，R7 口径勘误）、`一元微分学习题集_1MB压测副本.md`（1,574,112B）、唯一公式超限档（714,088B/9,420 唯一）——整目录 gitignore（本地化惯例）。执行时先 `ls perf/fixtures/` 确认，缺失按第四轮报告 §2 重建规格复制。
- 生产证据窗口：`%APPDATA%/com.mditor.app/logs/`（打包版）与 dev 实例日志卷 `com.mditor.app.dev`；CDP 端口惯例 dev 9223、打包冒烟避让 9222 用 9224。R6 观测出口（`__mathPumpStats`）在 10-01 构建不可用（`6e4334f` 未进该构建），双版本对照时旧构建只有 rAF 采样维度。
- npm test 基线：R7 收尾 986 全绿（以实跑为准，执行第一步实跑 `npm test` 记录确数）。

## 1. 角色与主战场

你是资深 Web 文本编辑器滚动帧稳定性工程师，熟悉 rAF 帧预算与主线程争用（长任务/强制布局/布局抖动）、合成线程与滚动管线的分工（scroll 由合成线程驱动、DOM 变现回主线程）、requestIdleCallback 让路语义、content-visibility 变现成本与 IntersectionObserver 调度时序。**本轮性质：不是再猜一轮优化，而是「复现 → 建立测得出问题的基准 → 归因 → 修复 → 数据证明」，且本质是上下滚对称性治理——下滚是对照组不是靶子。**

症状钉死（定义，禁止扩大或偷换）：

**症状 U（上滚掉帧）**：用户向上滚动（滚轮/触摸板）过程中，画面偶发一顿一顿——rAF 帧间隔不稳定/掉帧，主观体验"不如下滚丝滑"。测量口径：滚动驱动期（scrollPhase 窗，静止门 400ms 生效前）rAF 帧间隔 >32ms 的帧计数与帧间隔 p95，同强度下滚为对照臂。区别于：①**呈现不对称**（上滚公式长时间停留源码占位、停滚后才批量渲染——R6 Fix-B 的刻意设计，列为本轮观察项 U4 与 P3 拍板项的靶，不是掉帧）；②**R7 症状 D 停滚自漂移**（已归零，本轮 D 组防回退门看护）；③滚动惯性收敛（松手后减速，正常物理）。注意：用户感知的"一顿一顿"在取证时须区分**掉帧**（帧间隔拉长，内容连续但断续）与**内容跳位**（单帧位移大，帧率正常）——探针两维度都采（§5），归因前不许混谈。

用户前提（本轮立论基础）：**下滚体验丝滑**（R4~R6 成果），本轮一切改动不得把下滚改坏来"拉平"对称性——只许上滚向上够，不许下滚向下坠。

主战场双档：**公式密集中型文档**（密度档，cv 档旁路 `BIG_DOC_MATH_DOLLARS=800` 生效，行内懒渲染开）+ **1MB 超长文档**（isBigDocCv 生效，叠加 cvMemory 预热/视口学习路径与第四轮封案的布局墙现实）。两战场各钉各的，只测一档的结论无效。

范围界定：本轮只管**编辑器滚动容器**（`div.mditor-editor-host` 及其内容管线）滚动驱动期的帧稳定性；停滚后补绘拖尾归 T 组看护、跳转落点精度与多窗口不在门禁内。

方法论铁律沿用第三~七轮：**先测后改、一次一项、ABAB 交错、证据不成立不动手、达不到假设就回滚**（§10）。

## 2. 已查明事实集（直接采用，不要重查；行号经静态核实，以仓库实际为准）

### 2.A 上下滚不对称机制速览（本轮立论的代码事实）

- **渲染泵方向调度**（`src/lib/lazyInlineMath.ts`）：滚动中每帧 `pumpScrollFrame`（:334-430）把 IO 余量带内条目分三类——视口内 / 方向前方带（`FORWARD_BAND_PX=800`）/ 其余（`classifyEntry` :316-327，方向来自 wheel `deltaY` 符号，:257-298）。**向下滚**：视口内条目按 `SCROLL_RENDER_BUDGET_MS=5` 时钟渲染后，剩余预算继续冷算 band 内条目（R4-①——band 在视口下方，首渲高度变化只向下生长）。**向上滚**（:403-421，R6 Fix-B）：band 在视口上方，首渲高度变化会上移视口内容且无锚定可依赖（overflow-anchor 刻意关闭），**冷条目滚动中一律留队**；仅"缓存命中 && 有渲染态盒预留（`hasReservedBox`，R7 Fix-A 锁盒 {w,h} 双记忆）"直绘（命中直绘 <0.1ms）。上滚与下滚的代码路径天然不对称——这是设计，不是 bug。
- **静止补绘**：wheel/touch/key 停止 `SCROLL_QUIET_MS=400` 后（:300-302，静止门刻意不监听 scroll 事件），每帧 `PUMP_FRAME_BUDGET_MS=10` 预算 **FIFO 全量补渲染不分视口上下**（:438-444）——上滚积压的冷条目唯一兑现时机，一次停滚可能触发大批量补绘。
- **cvMemory 预热**（`src/lib/cvMemory.ts`）：空闲预热顺序 = ①视口带 → ②向下到文末 → ③视口上方由近到远；让路窗仅最后输入后 `PREWARM_USER_YIELD_MS=500`（:709-711, 848-851）——用户停顿 >500ms 预热即恢复推进。R7 Fix-B 把 up 批补偿同步化（`prewarmAnchorComp` :696-714，dispatch 后同任务强制布局量测+同帧补偿 :875-1000）——漂移归零的代价是**预热批的主线程占用变整块**（强制布局压进同任务）。
- **CSS 虚拟化**：`global.css:1731-1734` `[data-big] .ProseMirror > *` `content-visibility: auto`——块首次进 IO 带（800px 余量）变现即 forced layout；**1MB 档滚动布局墙是第四轮封案的架构级现实**（R6 T1 归因：帧间隔 p95 3.5-4.4s 级支配项），本轮 U 组 1MB 门禁以此为界，不追求消灭布局墙。
- **观测与补偿基建**：`scrollDebug` writeTrap（:571-629）/stepSession（:374-454）/anchor-comp（:1341-1381），出口 `window.__scrollDebug()`；`window.__mathPumpStats()`（队列深度/deferred/直绘与冷算计数）；异常码 MD-9001 掉帧 / MD-9002 视口位移 / MD-9003 输入延迟（`src/lib/devAnomaly.ts`，`docs/dev-anomaly-codes.md`）。

### 2.B 症状 U 候选源（禁止预设主犯，逐一取证；多候选可并存）

1. **U-a：上滚冷条目积压 → 静止补绘主线程墙（机制证据最完整——代码即事实）**。上滚滚动中冷条目全部留队（2.A 第一条），队列随上滚持续膨胀（每帧 `pumpScrollFrame` 全队列遍历+rect 探测本身有成本，`pumpStats.deferred` 持续累积）；停滚 400ms 后 10ms/帧 FIFO 补绘集中兑现——若用户"偶有卡顿"落在停滚瞬间或慢滚间歇（每次间歇都触发一小批），即此源。与 U4 呈现不对称同根（同一批积压条目），修复方向可能同路（P3）。
2. **U-b：上滚进带块 content-visibility 变现 forced layout 潮（1MB 主嫌疑）**。上滚时上方块首次进 IO 800px 带即变现+挂载，一批块的 forced layout 与 ProseMirror nodeview 挂载集中在一帧；叠加 `learnVisibleSizes` 视口学习（二分+量高）与 demote 取消后重渲染。下滚同样有变现潮但方向带调度让渲染分摊得更平滑（R4-①）——不对称的另一半。
3. **U-c：预热让路窗 500ms 的恢复时机与滚动重启竞争（1MB）**。慢滚/阅读停顿 >500ms 预热恢复推进，用户再滚时预热批仍在跑（R7 Fix-B 后是整块同步布局），与滚动帧争用主线程；1MB 预热 >45s 未完成期间窗口尤长。取证要点：掉帧时刻与预热批 dispatch 时刻对齐性（`__scrollDebug` counters 的 prewarm 维度）。
4. **U-d：demote 潮与 IO 重挂开销（密度档嫌疑）**。离开 IO 带 + 静止 + `DEMOTE_DELAY=2500ms` 批量降级（量 rect 记盒 + 替换占位 DOM）；上滚回带时取消挂起 demote + 重新入队 + R6 Fix-C 的 unobserve/observe 校准。上滚-下滚往返（浏览对照式阅读）会反复触发两方向的开销潮。
5. **U-e：打包 beta 版本差（阶段一双版本对照定生死）**。用户在打包 v5.0.0-beta 观察，若为 10-01 构建：**不含 R6 Fix-B**（上滚尖峰 vpUnready 21→11 就是他体感的"上滚卡"）与 **R7 Fix-A/B**（锁盒/同帧补偿）——症状可能大半在 main 已修。本轮真靶以 dev/main 复测残余为准，此候选不排除"本轮无事可做、结论=发版"的可能（这也是合法产出，报告写明即可）。
6. **U-f：R7 残余位移帧被感知为"一顿一顿"（1MB）**。R7 留档：1MB 预热推进期残余 3~9 位移帧/10s 窗（8px 级 + 偶发 20-40px 格）+ 1-3 次同帧补偿写入——若用户感知实为内容跳位而非掉帧，归因落此并并案 R7 遗留（§6）。探针必须同时输出帧间隔与哨兵位移两维度，区分掉帧 vs 跳位。

### 2.C 版本状态与生产证据（R7 收尾门禁 = 本轮防回退基线）

- R7 结题报告（`mditor/docs/large-doc-scroll-drift-report.md`）：D1 密度档四场景（下/上 × 快/慢）位移帧/程序写入/补偿计数**全部归零**；1MB down-fast 3~9 / up-fast 3 位移帧、写入 1-3（同帧同步化路线，D2 允许）；M1 三档残留 0、M2 队列 0、M3 挂载率 100%（23/23，解题技巧档）；T1 静止补绘 events 0/p95 0、T2 滚动中占位峰值 10/可见时长 p95 40ms（密度档 upscroll 口径——**本轮 T2 基线**）；R1 1MB 打开 11,466ms、R2 打字 600ms（密度档）/400ms（1MB g2）、R3 切换 2,089ms、R4 vitest 986、R5 scroll-abab 1MB on ×3 p95 147.6~158ms、ghost-stress 与基线一致。
- R7 遗留（写入报告 §⑤ 的本轮相关项）：1MB 预热期残余 3~9 位移帧（浏览器级 scroll/layout 亚帧差，**显式留档 R8 候选**）；P3 提案（预热批从 katexCache 渲染态测高，根治首渲方向宽度跳变）**未合入待拍板**，原型数据已具备（锁盒原型 32/32 零差证明 {w,h} 记忆占位可行）。
- 生产日志：R7 复析已证明 layout:shift 条目在卷可查（10-02 beta 会话 20 条）；本轮复析加查 MD-9001/9002 条目（若在卷）按文档/档位/上下文聚合，找上滚前置的掉帧记录。
- 惯例勘误（R7 报告注，直接沿承）：scroll-abab on 臂只用 1MB 档且 `--doc 1MB压测`（`--doc 1MB` 撞 `.pristine-1mb.md` 备份）；M3 块公式探查须用解题技巧档；md1011-verify 若环境挂死按两层证据覆盖条款留档（npm test 用例 + ghost-stress block.rebase=0）。

### 2.D 测量设施（现存直接挂靠）

- 页内观测出口：`window.__scrollDebug()`（recent 逐段归因/counters 含 `anchor.comp`、prewarm 维度）、`window.__mathPumpStats()`（队列深度/deferred/quietFrames/直绘与冷算）——掉帧帧与泵活动/写入的时间对齐靠这两个差分。
- 探针蓝本：`perf/tmp-r7/probe-drift.mjs` **已支持 `--scenario up-fast|up-slow|down-fast|down-slow`、`--up-px`、`--prewarm-wait`**（rAF 级三哨兵采样 + 双出口差分 + writeTrap 栈）——本轮改造为掉帧探针只需加帧间隔逐帧记录与 Longtask Observer（§5）。CDP 底座 `perf/cdp.mjs`（滚轮驱动/rAF 帧间隔/longtask 既有支持）。
- 基准：`perf/scroll-flash-bench.mjs`（scrollPhase/quietPhase 分窗——本轮主窗 scrollPhase）、`perf/scroll-abab.mjs`（ABAB 交错 + arm 自证）、`perf/ghost-stress.mjs`、`perf/open-1mb.mjs`、`perf/g2-typing.mjs`、`perf/switch-bench.mjs`。
- 单测守卫（不得跳过）：`lazyInlineMath.test.ts`（含泵统计/锁盒用例）、`cvMemory.test.ts`、`scrollDebug.test.ts`、`viewportAnchor.test.ts`、`md1011-regression.test.ts`、`katexCache.test.ts`、`mathCachePrewarm.test.ts`。

## 3. 禁区与待拍板

- **已证伪勿重查**（第三~七轮证伪链 + 各报告"负结果留档"节）：katexCache 挂 toDOM、docCache 阈值下调、分帧挂载、密度档 toDOM 接缓存三项、默认档急切渲染关闭定案（lazyInlineMath 头注 :9-13）；R7 负结果：死区 10px 补偿、单 rAF 补偿、逐块 oldH 差值法、锁盒无 bottom 校正（变体 A）。
- **R4~R7 成果不得破坏**：R5 Fix-A/B/C/D、R6 Fix-A/B/C、R7 Fix-A/B——任何改动跑 `md1011-regression.test.ts` + `cvMemory.test.ts` + `lazyInlineMath.test.ts` + `scrollDebug.test.ts` 全绿。
- **不得以"放开上滚冷算"为方案**（本轮最高危禁区）：撤销 R6 Fix-B 的上滚带约束（让滚动中冷算上方条目）= 把 R7 刚归零的停滚漂移请回来（首渲高度变化上移视口、无锚定可依赖）。任何让上滚滚动中渲染更多冷条目的方案，必须先证明"渲染前后块高零变化"（锁盒预留完备）或自带同帧补偿，并过 D 组防回退门——否则不许动手。
- **overflow-anchor 禁用是定案**；四层补偿链无归因证据不整体拆动（R6 红线 12 沿承）。
- **待拍板提案（P3，R7 遗留）**：预热批测量时从 katexCache 渲染公式，使 cvMemory/lazyInlineMath 学得的高度恒为渲染态——若 U-a 定罪且修复方向需要"上滚动中安全直绘更多条目"，P3（让首渲中性化、盒预留覆盖率打开后全量提升）是首选路径之一，原型数据已具备，**合入前须用户拍板**（§8 条款）。
- 未经用户拍板不得改默认值（`SCROLL_QUIET_MS`/`SCROLL_RENDER_BUDGET_MS`/`FORWARD_BAND_PX`/`SCROLL_HIT_PAINT_CAP`/`PREWARM_USER_YIELD_MS`/`DEMOTE_DELAY`/`IO_MARGIN` 等常量）、不得重引入 bigDocViewportAuto、不得改档位开合逻辑。

## 4. 可量化目标（门禁表；判分：U1/U2 与 D 组必须有本机数据，修复类门在证据立项后判定，T/R 组全部零回归；未达项附归因，不许留空）

### U 组：上滚掉帧（症状 U，本轮主门；scrollPhase 窗 = 滚轮驱动期，静止门生效前）

| # | 指标 | 已知基线 | 目标 | 测量 |
|---|---|---|---|---|
| U1 | 掉帧对称性主门：①scrollPhase 窗 rAF 帧间隔 >32ms 帧数的 up/down 比值；②帧间隔 p95 的 up/down 比值（down 侧计数为 0 时以 p95 比值为准并注明） | 无独立口径（R7 T2 只测占位可见性非帧稳定性）——阶段三以 r8 探针钉死 | 两比值均 **≤1.25**（密度档与 1MB 双测、快滚慢滚各 ≥2 轮方向一致；对照臂 down 数据同窗采集） | 新建上滚掉帧探针（§5，入 `perf/tmp-r8/`）；产物 `perf/results/r8-phase3-jank-<场景>-<fixture>-<n>.json` |
| U2 | 上滚掉帧绝对强度（分档）：scrollPhase 窗 >32ms 帧占比 | 同上阶段三钉死 | 密度档较基线 **-50% 或 ≤3‰**（取先达者）；1MB 较基线 **-30%**（布局墙封案现实允许残差，未达须归因） | 同 U1 |
| U3 | 上滚期间 >50ms longtask 计数（探针 Longtask Observer，滚动驱动期窗内） | 阶段三钉死 | 较基线 **-50%**，且 ≤ 同窗 down 臂 +2 | 同 U1 |
| U4 | 呈现不对称（报告项，非硬门）：停滚补绘拖尾——quietPhase 窗视口占位事件数与可见时长 p95，up/down 对照 | R7 T2：peak 10 / durP95 40ms（密度档 upscroll） | 只记录只对比不设门（消除它 = P3 拍板项的靶，见 §3/§6）；数据供拍板决策 | `node perf/scroll-flash-bench.mjs`（上滚/下滚两臂各跑） |

### D 组：停滚漂移防回退（R7 硬底——上滚流畅度修复最容易复活它，本轮全程看护）

| # | 指标 | 已知基线（R7 收尾） | 目标 | 测量 |
|---|---|---|---|---|
| D1 | R7 D1 口径复测：停滚 10s 窗位移 >4px 帧数 / 程序化写入 / MD-1001/1002 | 密度档四场景全 0；1MB down-fast 3~9 / up-fast 3、写入 1-3 | 密度档四场景**维持 0**；1MB **≤9 不劣化**；MD 码维持 0 | `perf/tmp-r7/probe-drift.mjs` 直接复跑（已支持全场景）或 r8 探针同口径双采 |

### M 组：完整性（沿承 R6/R7 硬门——禁止砍完整性换流畅度）

| # | 指标 | 已知基线（R7 收尾） | 目标 | 测量 |
|---|---|---|---|---|
| M1 | 滚动遍历往返 + 静止 10s 后行内公式源码占位残留 | 0（三档） | **维持 0** | R6/R7 探针口径（`perf/tmp-r6/formula-probe.mjs` 规格，可重建） |
| M2 | 会话后 10s 泵队列挂起条目 | 0 | **维持 0** | `window.__mathPumpStats` |
| M3 | 视口内块级公式挂载率 / katex-error | 100%（23/23，解题技巧档）/ 0 | **维持 100% / 0** | R6 块公式挂载探针口径 |

### T 组：及时性（不劣化 >10%）

| # | 指标 | 已知基线（R7 收尾） | 目标 | 测量 |
|---|---|---|---|---|
| T1 | 静止补绘拖尾（quietPhase 占位事件/p95） | events 0 / p95 0（密度档 upscroll） | **不劣化 >10%** | `node perf/scroll-flash-bench.mjs` quietPhase 窗 |
| T2 | 滚动中视口源码占位峰值 / 可见时长 p95 | peak 10 / durP95 40ms | **不劣化 >10%** | 同上 scrollPhase 窗 |

### R 组：防回归（全部零回归；基线为 R7 收尾同机，环境差异须声明）

| # | 指标 | 已知基线 | 测量 |
|---|---|---|---|
| R1 | 1MB 打开（3 轮中位） | 11,466ms | `MDITOR_DOC=1MB node perf/open-1mb.mjs 3 <tag>` |
| R2 | 打字 p95 密度档 / 1MB（g2 口径） | 600ms / 400ms | `MDITOR_DOC=无穷级数_密度档 MDITOR_MIN_BLOCKS=500 node perf/g2-typing.mjs <tag>`；1MB 档同法 |
| R3 | 切换中位（20 往返） | 2,089ms | `node perf/switch-bench.mjs --doc-a 无穷级数_密度档 --doc-b 解题技巧_密度档 --viewport off --switches 20 --tag <t>` |
| R4 | 全量守卫 | vitest 986（以实跑为准） | `npm test`（每优化 commit 前）；收尾 `npm run test:coverage` + `npm run lint` + `npm run build` |
| R5 | 历轮门禁复测：ABAB / ghost / md1011 / 下滚对照臂 | scroll-abab p95 147.6~158ms（1MB on ×3）；ghost-stress 与基线一致 | `scroll-abab --doc 1MB压测 --viewport on --round 3 --duration 60` + `ghost-stress --minutes 5` + md1011 两层证据覆盖惯例（§2.C 勘误） |

回归判定阈值沿用历轮：**劣化 >10% 且多轮方向一致才算回归**；下滚对照臂数据若较 R7 基线劣化 >10% 同样算回归（"拉平对称性"不合法，见 §1 用户前提）。

## 5. 症状 U：取证设施与可证伪归因路径

- **取证设施（阶段二新建，只加观测不改行为，独立 commit）**：
  - 上滚掉帧探针 `perf/tmp-r8/probe-jank.mjs`（蓝本 `perf/tmp-r7/probe-drift.mjs`，继承 with-dev 挂靠/fixture 打开/滚轮驱动/场景参数）：打开 fixture →（1MB 档 `--prewarm-wait` 双臂）→ CDP 滚轮驱动 up-fast/up-slow/down-fast/down-slow → **驱动期逐帧 rAF 间隔记录（performance.now() 差分）+ 页内 Longtask Observer（>50ms，attestation 尽量取）+ 三哨兵 rect（区分掉帧 vs 内容跳位）+ `__scrollDebug`/`__mathPumpStats` 每帧快照差分 + writeTrap 栈** → 停滚后 quietPhase 窗继续采 10s（U-a 补绘墙形态）→ 输出 jsonl（帧间隔序列 + 掉帧帧列表 + 每帧对齐的泵/写入/longtask 归因 + 分窗汇总）。tag 命名 `r8-phase<N>-jank-<场景>-<fixture>-<n>`。
  - 双版本对照臂（阶段一）：用户实际安装构建（CDP 9224 挂靠打包实例）跑 up 场景矩阵——旧构建无 `__mathPumpStats` 出口，只有帧间隔+哨兵两维度，报告中声明口径差。
- **归因判据表**（探针数据直接套用；先分掉帧 vs 跳位，再归因）：
  - 帧间隔 >32ms 帧与 longtask 对齐，longtask 期间泵 coldRenders 增长 → 补绘/冷算争用：若掉帧集中在 quietPhase（停滚后）→ **U-a 定罪**；若集中在 scrollPhase 且与 prewarm 维度对齐 → **U-c 定罪**；与 IO 回带/demote 计数对齐 → **U-d 定罪**；与 content-visibility 变现批/learnVisibleSizes 对齐（1MB）→ **U-b 定罪**。
  - 帧间隔正常但单帧哨兵位移大 → 不是掉帧是跳位：对齐 R7 残余补偿写入 → **U-f 定罪并案**（§6）；对齐无归因写入 → 按裸源走 writeTrap 栈。
  - dev/main 全矩阵无掉帧而用户构建有 → **U-e 定罪**（版本差），本轮靶按残余重新钉死或结论=发版。
- **可证伪句子**（每条先写再动手，§10 第 3 步；证据不成立换下一候选，不许并行改多个）：
  - U-a：若卡顿 = 上滚积压停滚补绘墙，则掉帧/longtask 全部落在静止门生效后，且滚动中无 >32ms 帧；把上滚场景临时改为"下滚同款带预算冷算"（原型开关，不合入，须锁盒预留完备才许试）后 quietPhase 补绘量与掉帧同步归零——若滚动中就有掉帧则 U-a 非主犯。
  - U-b：若卡顿 = 上滚进带变现潮，则掉帧帧的 longtask/布局时间与该帧进带块数正相关，且密度档（无 cv 虚拟化）同场景掉帧显著更少。
  - U-c：若卡顿 = 预热恢复竞争，则掉帧仅出现在预热未完成会话（1MB 打开后 ~45s 窗），`--prewarm-wait` 等待臂同序列掉帧归零；临时禁预热对照（patch `startCvPrewarm` 直返，跑完恢复）掉帧归零。
  - U-d：若卡顿 = demote/IO 潮，则掉帧时刻与 demote 执行/IO 重挂计数对齐，禁 demote 对照（`DEMOTE_DELAY→1h`，R7 `exp-demdete.mjs` 蓝本）归零。
  - U-e：若卡顿 = 版本差，则 dev/main 复测同序列 up/down 对称比 ≤1.25 且绝对掉帧 ≤3‰，无需任何代码改动即达标。
  - U-f：若"一顿一顿"实为跳位，则帧间隔 p95 正常（≤ 下滚对照 +10%）而位移帧非零，归因走 R7 残余路径并案。
  - 复现不了的症状必须产出「为何在此环境不触发」的归因（构建/缓存/预热状态差异），不许静默跳过。

## 6. 与历轮遗留案件的交叉声明

- **R7 遗留 1MB 预热期残余 3~9 位移帧**（显式留档 R8 候选）：若 U 探针在相同帧窗捕获"位移与掉帧同帧"（U-f），修复一并处理并双门验收（U1+D1）；若两现象独立，漂移残余留档不动，本轮只报不修（浏览器级亚帧差攻关投入产出比低的 R7 结论沿用）。
- **P3 提案（预热批渲染态测高，待拍板）**：U-a 定罪时的首选修复方向之一——盒预留覆盖率提升后，R6 Fix-B 的上滚直绘条件（命中 && hasReservedBox）可覆盖更多条目，上滚动中直绘比例上升、积压下降，对称性自然改善且不破上滚安全约束（锁盒保证渲染前后零位移）。原型数据已具备，合入前请用户拍板（§3/§8）。
- **D-c 打字机延迟居中**（R7 排除留档）：用户环境 typewriterMode=false 不触发；若本轮生产日志复析出现 `write:typewriter` 与掉帧同帧，按 R7 留档路径查 `Editor.tsx:573-621`，不预改。
- **R5 J-α''（+32s 未打标整千跳变，未定罪）**：维持不并案，除非 writeTrap 在本轮取证中直接捕获栈。

## 7. 执行阶段（各自成阶段，顺序推进；凭实测可重排，报告说明理由）

沿用第五~七轮：直接执行、阶段门禁自查后才进下一阶段。

- **阶段一：版本核实 + 生产日志复析 + 双版本对照（先于一切）**。按 §0 钉死用户安装构建（10-01 旧构建 vs 10-03 对齐构建）；生产日志复析 MD-9001/9002 与 layout:shift 条目（若在卷）按文档/档位/上下文聚合，找上滚前置记录；dev/main 起实例复测 up/down 同序列（探针最小臂：帧间隔+哨兵），产出「症状-构建-档位-对照表」并修正 U-e 优先级——**若 dev/main 已达标且用户构建为旧版，本轮结论可提前收敛为"发版验证"，仍须走完打包冒烟后收尾**。
- **阶段二：复现与探针建设**。新建 probe-jank（只加观测不改行为，独立 commit）；dev 实例复现症状 U（up/down × 快/慢 × 密度档/1MB，1MB 加预热双臂）至少各一例，up/down 掉帧差非零（或位移帧非零）才进阶段三；复现不了按 §5 归因说明。
- **阶段三：基准**。跑 U1/U2/U3/U4 + D1 全口径基线（含 M/T/R 对照臂），填死门禁表基线列；产物落 `perf/results/r8-phase3-*.json`。
- **阶段四：归因（禁盲改）**。按 §5 归因判据表逐候选定罪/排除（先分掉帧 vs 跳位），产出归因结论 `perf/results/r8-phase4-attribution.md`（每条附证据文件与数据）；未定罪不许进修复。
- **阶段五：分批修复（Fix-A/B/C…）**。按定罪排序分批，每项独立 commit（hash+file:line+复杂度+回退开关）、附新增单测、ABAB 交错 A/B/B/A ≥3 轮；P3 类拍板项只出原型数据请用户确认后合入。
- **阶段六：全量门禁 + 打包冒烟 + 报告**。U/D/M/T/R 全表复测 + **重建打包安装包实机断言**（用户症状在打包版，修复必须过打包关：上滚连续滚动 scrollPhase 掉帧项 + 停滚 6s 窗漂移 0 项，R7 prod-smoke 口径沿承）+ 报告与文档更新（§11）。

## 8. 创新算法条款（若引入新调度/补偿/预算机制）

复杂度分析（时间/空间，按视口内条数 n 与全文档 N 表达）+ 三规模档实测（密度档/1MB/超限 fixture）+ 原型先行（脚本级验证再落地）+ 降级开关（新策略可一键回退旧路径）+ 1,000 次随机编辑差分（新旧行为等价性，渲染结果与最终 scrollTop 逐条比对）。不满足任一条不合入。

## 9. 红线（编号沿承历轮 + 本轮增补）

1. 未经用户拍板不得改默认值（含 `SCROLL_QUIET_MS`/`SCROLL_RENDER_BUDGET_MS`/`FORWARD_BAND_PX`/`SCROLL_HIT_PAINT_CAP`/`PREWARM_USER_YIELD_MS`/`DEMOTE_DELAY`/`IO_MARGIN` 等常量）、不得重引入 bigDocViewportAuto。
2. 已证伪路线勿重走（§3 证伪链，含 R7 负结果四项）。
3. 默认档（非 cv 档）急切渲染定案勿改；减配档关公式是既有决策，非本轮靶。
4. KaTeX 0.18.4 单实例钉住不动（package.json overrides）；不引入新渲染引擎；`src/lib/mathConfig.ts` 宏语义与单一来源不动。
5. R5 Fix-A/B/C/D、R6 Fix-A/B/C、R7 Fix-A/B 不得破坏：`md1011-regression.test.ts`、`cvMemory.test.ts`、`lazyInlineMath.test.ts`、`scrollDebug.test.ts` 既有用例全绿且不跳过。
6. node_modules 改动只走 `patches/`。
7. 每优化 commit 前 `npm test`；收尾 `test:coverage` + `lint` + `build`。
8. 先测后改六步（§10）；一次一项；ABAB 交错 ≥3 轮；达不到假设就回滚。
9. 观测补点（探针/计数/采样窗）与行为修复分开 commit。
10. perf 硬清理只杀自 spawn 的 dev PID 树（`taskkill /IM` 误杀教训）；tmp 脚本入 `perf/tmp-r8/` 并头注"不入库"。
11. 不改测量口径；fixture 只许改生成参数不许改测量逻辑。
12. 四层补偿链（viewportAnchor/prewarm-comp/anchor-comp/overflow-anchor 禁用）与 smoothJump 互斥旗标无归因证据不动（R6 红线沿承）。
13. （R7 增补沿承）不得以关停静止补绘、关停预热、砍公式完整性或及时性换取任何指标归零——M1/M2/M3 是硬门，T1/T2 劣化 >10% 即回滚。
14. （R7 增补沿承）anchor-comp 兜底层不得无证据整体拆除。
15. **（本轮增补）不得以复活 R7 停滚漂移换取上滚流畅度**——D1 密度档四场景 0 是硬底；"放开上滚冷算"（撤销 R6 Fix-B 上滚带约束）未经定罪+零位移证明+同帧补偿论证不得尝试（§3 最高危禁区）。对称性只许上滚向上够，不许把下滚改坏拉平（下滚对照臂劣化 >10% 即回滚）。

## 10. 先测后改六步（每个修复项逐一过）

1. 基线：改动前跑该门禁指标 ≥2 轮取中位；
2. 定位：探针/观测数据指到具体代码路径（file:line）；
3. 可证伪假设：写成"若改 X 则指标 Y 应变化 Z%"的句子；
4. 单项改动：只改这一处，commit 独立；
5. ABAB 交错：改动/基线 A/B/B/A ≥3 轮，方向一致才算数；
6. 保留或回滚：达标保留并记录，不达标回滚并留档（负结果同样写入报告，防重走）。

## 11. 交付物

- 报告 `mditor/docs/large-doc-upscroll-jank-report.md`，六节体例：①基线声明（HEAD/环境/用户构建核实结论/dev-main 双版本对照表/fixture）；②归因结论（U 候选定罪/排除表 + 掉帧 vs 跳位判别结论，附证据与探针产物路径）；③改动清单（每项 commit hash + file:line + 复杂度 + 回退开关）；④门禁全表（U/D/M/T/R 逐行基线→结果，未达项附归因不许留空）；⑤遗留与放弃（含 P3 拍板结论、R7 残余并案结果、负结果留档）；⑥文档更新清单。
- 文档同步：`mditor/docs/performance.md`（帧稳定性新参数与权衡）、`mditor/docs/dev-anomaly-codes.md`（若复用/新增 MD-9001 口径须登记）、`mditor/CHANGELOG.md` Unreleased 节、memory 日记更新。
- 测量产物：`perf/results/r8-*.json`（tag 命名 `r8-phase<N>-jank-<场景>-<fixture>-<n>`）；`perf/tmp-r8/` 一次性探针（不入库惯例，实际历轮均随 commit 入库）。
- 发版：本轮不发版；阶段六打包冒烟安装包重建后验完即弃或留用由用户定，发版节奏由用户另行决定。
