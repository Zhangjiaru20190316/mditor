# 任务：mditor 大文档滚动流畅度第九轮治理——专注模式滚动掉帧/丝滑度不对称专项

> 使用方式：本任务书配套 `/goal` 命令交付（目标文本见下方代码块，直接粘贴）。前端代码在 `mditor/` 子目录，所有 `perf/` 与 `npm` 命令在 `mditor/` 下运行。核心环节分阶段推进（§7），每阶段证据落盘（`perf/results/` 与报告草稿）并自查后才进下一阶段，禁止把归因与修复混在同一批。动手前必读第 0、1、2、3、9 节——本任务禁止盲改，禁止重修已修问题，禁止预设根因结论。
>
> ```text
> /goal 修复 mditor 专注模式（focusMode/.is-focus）大文档滚动掉帧/丝滑度劣于正常模式（第九轮专项，范围：专注模式下编辑器滚动驱动期帧稳定性——宽度突变后 cvMemory 高度表集体陈旧且无重学路径、视口面积/行宽增大的每帧布局绘制成本、切换后 walkBlocks 诊断走查与 big 档常驻税、focus-hover-zone 顶部悬停过渡；正常模式滚动丝滑为用户前提，R5~R8 全部门禁为不可回退基线）。任务书：docs/prompts/large-doc-focus-mode-scroll-smoothness-optimization-prompt.md——先通读全文并遵守 §0 基线核实、§2 已查明事实集不重查、§3 禁区与红线，在 mditor/ 子目录下按 §7 阶段顺序执行，禁止盲改、禁止重修已修问题、禁止重走已证伪路线。完成判据（全部满足才 pass）：① 模式对称主门——F1 两指标（scrollPhase 窗 >32ms 帧数比与帧间隔 p95 比，focus/normal 同位置同序列对照）均 ≤1.25（密度档与 1MB 双测、快慢滚各 ≥2 轮方向一致，慢滚大样本为准），F2 绝对强度分档达标（密度档专注臂较基线 -50% 或 ≤3‰、1MB 专注臂较基线 -30%，未达项附归因不许留空）；② 历轮门禁零回退——D1 双臂（normal+focus）密度档四场景维持 0、1MB ≤9 不劣化且写入全带归因；M1/M2/M3 维持 0/0/100%（M3 须用解题技巧档）；T1/T2 不劣化 >10%（同批 ABAB 内对照）；R8 上滚对称比不劣化；③ 零回归——npm test 全绿（≥986 基线，以实跑为准），1MB 打开/打字/切换基准零回归；④ 交付——报告落盘 mditor/docs/large-doc-focus-mode-scroll-smoothness-report.md，每个修复项独立 Fix-X commit 且附新增测试，重建打包安装包实机冒烟断言专注模式滚动掉帧与停滚漂移双项，CHANGELOG 与 memory 日记更新。红线：专注模式视觉设计与交互形态不动（全屏铺满/隐藏 chrome/hover 工具栏是产品定案）；KaTeX 0.18.4 单实例与宏语义不动；R4~R8 全部 Fix 不得破坏；不得把正常模式改坏拉平对称性；不得复活 R7 停滚漂移；高度表宽度失效策略不得引发全量重预热重蹈 1MB ~45s 主线程墙；诊断税修复只许节流让路不许砍观测能力；overflow-anchor 维持禁用；四层补偿链无归因证据不动；观测与修复分开 commit；每 commit 前 npm test；先测后改六步。
> ```
>
> 前序任务书引用链（体例连续，背景可查）：`docs/prompts/large-doc-perf-optimization-prompt.md`（第三轮，已结题）、`docs/prompts/large-doc-perf-motion-optimization-prompt.md`（第四轮，已结题——1MB cv 档滚动布局墙在该轮封案，本轮 F 组 1MB 门禁的立论基础）、`docs/prompts/large-doc-scroll-stability-optimization-prompt.md`（第五轮，已结题）、`docs/prompts/large-doc-formula-render-optimization-prompt.md`（第六轮，已结题——R6 Fix-B 上滚带约束是本轮 §3 禁区）、`docs/prompts/large-doc-scroll-drift-optimization-prompt.md`（第七轮停滚漂移，已结题——本轮 D 组防回退门的来源）、`docs/prompts/large-doc-upscroll-jank-optimization-prompt.md`（第八轮上滚掉帧，已结题——**R8 证伪"方向不对称"并把对照臂位置混杂定为大忌，本轮 focus/normal 对照口径直接继承此教训**；R8 收尾门禁 = 本轮防回退基线）。
>
> 【填写】观察环境（用户已确认 2026-10-04）：症状在**打包版 v5.0.0 正式版**观察到（= commit `e840d26` 构建，含 R5~R8 全部修复，与 main 同源——阶段一仍须核实安装构建坐实）。靶功能钉死：**专注模式 focusMode**（视图菜单「专注模式」/状态栏按钮/Esc 退出——用户口中的"聚焦模式"即此功能；**非**打字机模式、**非**编辑器 focus/blur 焦点概念，防混淆声明见 §2.B F-e 与 §6）。主战场文档（已确认）：**大文档双档——公式密集中型（密度档）+ 1MB 超长档**。症状钉死：**症状 F——专注模式下滚动驱动期画面一顿一顿（掉帧，帧间隔拉长），正常模式同文档滚动丝滑为对照**（定义见 §1，禁止扩大或偷换）。症状形态（已确认）：掉帧非跳位——探针仍双维度采（历轮教训，防误判）。症状补充（快滚还是慢滚更明显/滚轮还是触摸板/进入专注后多久出现/进出切换瞬间是否也顿挫/特定文档更明显）：___。

## 0. 基线状态声明（执行第一步必须核实，禁止假设）

本任务书基于 2026-10-04 仓库状态撰写：

- HEAD = `6e11983`（docs(perf): V5.0.0 正式版打包冒烟 PASS 补录——报告/memory 收尾）；正式版发版 = `e840d26`（chore(release): v5.0.0 正式版号，四处版本号 5.0.0-beta→5.0.0，安装包 15:17 产出、ProductVersion 实测 5.0.0、打包冒烟 PASS）。**R8 零行为修复合入**（仅观测基建 `f3ee450`）——main 的滚动行为与 R8 测量时一致，无"报告后又有行为改动"的漂移。撰写时工作区有未提交改动（`mditor/docs/performance.md`、`mditor/docs/dev-anomaly-codes.md`，R8 补录文档）与未跟踪杂物（`mditor/nul`、`nul`），不影响本任务。
- **执行第一步**：`git status` + `git log --oneline -5`，据实记录 HEAD 相对 `6e11983` 的实际状态，报告开头声明；后续一切论述以核实后的代码为准。
- **用户构建核实**：`%LOCALAPPDATA%/Mditor/mditor.exe` ProductVersion 应为 5.0.0、mtime 对齐 10-03 15:17 构建或更新——预期与 main 同源（R8 已排除版本差机制，本轮只需坐实，无需 R8 式双版本对照）。
- fixture 在位性（R8 结题核实惯例）：`mditor/perf/fixtures/` 含 `无穷级数_密度档压测副本.md`（156,021B/2,355 行内公式）、`解题技巧_密度档切换副本.md`（60,065B，M3 块公式档）、`一元微分学习题集_1MB压测副本.md`（1,574,112B）、唯一公式超限档（714,088B/9,420 唯一）——整目录 gitignore（本地化惯例）。执行时先 `ls perf/fixtures/` 确认。
- 生产证据窗口：`%APPDATA%/com.mditor.app/logs/`（打包版）与 dev 实例日志卷 `com.mditor.app.dev`；CDP 端口惯例 dev 9223、打包冒烟避让 9222 用 9224。WebView2 runtime 154.0.4258.48（R8 登记口径，测量对照用）。
- npm test 基线：R8 收尾 986 全绿（89 文件，实跑两次确认；以实跑为准，执行第一步实跑 `npm test` 记录确数）。

## 1. 角色与主战场

你是资深 Web 文本编辑器滚动帧稳定性工程师，熟悉 rAF 帧预算与主线程争用（长任务/强制布局/布局抖动）、布局树与级联重排、content-visibility 的 remembered-size 语义（`contain-intrinsic-size` 的 `auto` 前缀行为）、ResizeObserver/IntersectionObserver 调度时序、模式切换引发的批量样式失效与宽度突变连锁。**本轮性质：不是再猜一轮优化，而是「复现 → 建立测得出模式差异的基准 → 归因 → 修复 → 数据证明」，且本质是模式对称性治理——正常模式是对照组不是靶子。**

症状钉死（定义，禁止扩大或偷换）：

**症状 F（专注模式滚动掉帧）**：专注模式（focusMode 开启、布局稳定后）下大文档滚动驱动期（scrollPhase 窗，静止门 400ms 生效前）rAF 帧间隔 >32ms 掉帧/帧间隔 p95 劣于正常模式；用户主观"一顿一顿、不如正常模式丝滑"。对照口径：**同文档、同位置、同序列**，正常模式滚一遍、专注模式滚一遍（ABAB 交错）——R8 已证伪的位置混杂口径（不同几何对照）禁用。用户已确认形态为掉帧（帧间隔拉长，内容连续但断续）而非内容跳位（单帧位移大、帧率正常）——但取证仍须双维度采集（§5），归因前不许混谈。区别于：①**切换瞬间顿挫**（进出专注模式的一次性卡顿，不在主门——记录为观察项 F5）；②**R8 冷区首渲布局墙**（1MB 绝对强度墙，两模式共有的背景底，本轮只管 focus 相对 normal 的增量，§6）；③**R7 症状 D 停滚自漂移**（已归零，D 组双臂看护）。

用户前提（本轮立论基础）：**正常模式滚动丝滑**（R4~R8 成果），本轮一切改动不得把正常模式改坏来"拉平"对称性——只许专注模式向上够，不许正常模式向下坠。

主战场双档：**公式密集中型文档**（密度档，cv 档旁路 `BIG_DOC_MATH_DOLLARS=800` 生效，行内懒渲染开）+ **1MB 超长文档**（isBigDocCv 生效，叠加 cvMemory 预热/视口学习路径——F-a 候选的必要条件在场）。两战场各钉各的，只测一档的结论无效。

范围界定：本轮只管**编辑器滚动容器**（`div.mditor-editor-host` 及其内容管线）在专注模式下的滚动驱动期帧稳定性，及专注模式布局突变（宽度/高度激增）的连锁效应；sv 模式（CodeMirror）、多窗口、专注模式视觉设计本身不在门禁内（后者是红线 16）。

方法论铁律沿用第三~八轮：**先测后改、一次一项、ABAB 交错、证据不成立不动手、达不到假设就回滚**（§10）。

## 2. 已查明事实集（直接采用，不要重查；行号经静态核实，以仓库实际为准）

### 2.A 专注模式机制速览（本轮立论的代码事实）

- **入口链**：`src/types.ts:167-168`（注释原文 "Focus mode: hide sidebars"）、`src/defaults.ts:198`（默认 false）、`src/hooks/useSettings.ts:191-194`（`toggleFocus`）、`:223`（`document.body.classList.toggle("focus-mode", ...)`——**全仓库无 CSS 消费该类，是死类**）、`src/App.tsx:817`（读取）、`:2454`（`className={`app ${focusMode ? "is-focus" : ""}`}`）、`:2646+`（Sidebar/opener/AiPanel 条件卸载）、`:2785-2808`（focus-hover-zone 浮动工具栏挂载）。
- **CSS 改动全在 `src/styles/global.css`**：`:561-568`（`.is-focus` 下 ai-panel/sb-status/resizer/sidebar-opener/ai-fab/titlebar/tabbar → `display:none !important`）、`:571-573`（`.is-focus .app { padding: 0 }`——去掉 `--frame-pad` 画布边距）、`:574-578`（`.is-focus .main` 去边框/圆角/阴影）、`:476-482`（侧栏塌缩 width:0/opacity:0）、`:1913-1968`（focus-hover-zone：fixed 全宽 8px 顶缘悬停区 + focus-toolbar transform/opacity 过渡、hover 0.3s 延迟浮出）。
- **净效果**：编辑器视口**一次性大幅变宽（≈ 侧栏 260px + frame-pad + 边框）且变高（标题栏/标签栏/状态栏隐藏）**，文字重新折行后每行更长。
- **关键否定性事实**：滚动 JS 路径两模式完全相同——`useMilkdown`/`scrollDebug`/`cvMemory`/`lazyInlineMath` 无任何代码读 focusMode；focusMode 不在 editorSettings 窄切片（`App.tsx:819-860` 附近注释明示切片设计）→ 切换不触发编辑器重建。**差异全部来自布局突变的下游效应，这决定了候选源的形态（§2.B）。**
- **滚动容器与优化栈**（两模式共享）：`div.mditor-editor-host`（`src/components/Editor.tsx:1258-1264` 挂 `scrollerRef` 与 `data-big`）；大文档 cv 档 `content-visibility:auto + contain-intrinsic-size`（`global.css:1725-1735`）+ cvMemory 高度记忆装饰 + 空闲预热 + 行内公式懒渲染泵（细节见 R6~R8 任务书 2.A，不赘引）。

### 2.B 症状 F 候选源（禁止预设主犯，逐一取证；多候选可并存）

1. **F-a：宽度突变使 cvMemory 高度表集体陈旧且无重学路径（1MB 主嫌疑，机制证据最完整——代码即事实）**。高度表按内容寻址存 `{w,h}` 双值、2px 容差改写（`cvMemory.ts:65-69`）；装饰写死 `contain-intrinsic-size: <w>px <h>px` **无 `auto` 前缀**（`intrinsicStyleOf` :144-149）——浏览器 remembered-size 不会自纠；视口学习只挂文档更新（plugin `view.update` :481-490——**滚动/resize/模式切换都不触发**）；预热有 95% 覆盖率快路径直接跳过（:763-770——块都"已学过"旧宽度值，不会重量）；`:821-825` 注释自认"宽度漂移（窗口 resize）的陈旧值由视口学习持续修正"——**而视口学习恰恰只在 doc 变化时跑，此为代码自认的缺口**。后果：进专注模式后宽度突变数百 px，滚动时离屏块按**旧宽度的错误占位高**摆放，进视口变现为新宽度的真实高度 → scrollHeight 反复跳动、滚动条失真、内容滚动间隙位移 → scrollDebug anchor-comp 逐帧补写 scrollTop（`scrollDebug.ts:1341-1381`）+ `cv.relearn` 高度改写潮（`cvMemory.ts:72-92` 观测口）→ 掉帧 + 体感"页面自己动"。同类机制（占位尺寸 ≠ 渲染尺寸）已在 `docs/large-doc-scroll-drift-report.md` 定罪为位移主犯——本轮是把该机制换一个触发面（模式切换而非 demote 潮）重新审。
2. **F-b：视口面积/行宽大增 → 每帧 layout/paint 成本上升（全档，架构级现实）**。宽行重排成本 + cv 块进视口变现的 layout 成本随行宽上升；视口高度增大使每帧 paint 像素面积可增 40% 量级。与 R4/R6 封案的布局墙同类，修复空间有限——本轮职责是**用宽度对齐对照臂（§5）把它从模式特有机制里干净分离并量化占比**，不许笼统归罪了事。
3. **F-c：切换后诊断走查风暴 + big 档常驻走查税（观测设施收的税）**。宽度变化 >0.5px 触发 `layout:width` 探针（`scrollDebug.ts:917-947`，ResizeObserver 事件驱动）→ `openBlockWindow()` 开 2s 窗（`BLOCK_WINDOW_MS=2000`，:654）内每 100ms（`BLOCK_WALK_WINDOW_MS=100`，:653）`walkBlocks` 全量读顶层块 `offsetHeight`（:786-843）；且 `data-big` 档（1MB）下 walkBlocks **休眠期恒 1s/次常驻**（`BLOCK_WALK_IDLE_MS=1000`，:655；`walkBlocks` 的 big 分支不因窗口关闭而停）。只读 offsetHeight 但全量块 × 持续 = 强制布局读潮，叠加在滚动帧上。修复方向是节律/让路（拍板项），**不是砍诊断**。
4. **F-d：focus-hover-zone 顶部 8px 全宽悬停区与滚动交叠**（`global.css:1913-1921`）。光标贴顶滚动/拖顶部滚动条时反复触发 `.focus-toolbar` 的 transform+opacity 过渡（:1936-1948，固定定位 + box-shadow 元素在滚动内容上方动画）。次要但真实；修复受红线 16 约束（只许优化动画成本，不许改交互语义）。
5. **F-e：无罪清单（防执行者重查）**：`body.focus-mode` 死类（`useSettings.ts:223` 写入、无 CSS 消费——**不得顺手"激活"它挂样式，未定罪不动**）；`.main` 的 `contain:layout style` 两模式一致；无 backdrop-filter/blur 常驻（`material.css:1-25` 护栏：chrome 不吃 blur、内容面禁玻璃）；focusMode 切换不触发编辑器重建（§2.A）；**R1（V4.6.0 第一轮）已修的「聚焦切换全文档样式重算」是编辑器 focus/blur 的 `.ProseMirror-focused` CSS 变量翻转（blur→focus 762ms→修后 0ms）——与专注模式 focusMode 是两个不同概念，已修勿混淆勿重修**（§6 防混淆声明）。
6. **F-f：打字机模式组合**（typewriterMode 开启时 selectionchange → 居中写 scrollTop，`Editor.tsx:573-621`）——非专注特有但常与其组合使用；若取证见 `write:typewriter` 与掉帧同帧，按 R7 留档路径查，不预改（阶段一先确认用户现场该开关状态）。

### 2.C 版本状态与生产证据（R8 收尾门禁 = 本轮防回退基线）

- **版本差机制本轮不成立**：用户观察版本 = v5.0.0 正式版（`e840d26`）= main 同源，且 R8 零行为修复合入——阶段一只需核实坐实，无需双版本对照（与 R8 的最大差异，简化阶段一）。
- **R8 收尾数字**（详见 `mditor/docs/large-doc-upscroll-jank-report.md` ④，本轮 R 组基线直接引用）：U1 修正口径对称比两档全 ≤1.25（1MB 慢滚两轮 jank32 比 0.97/1.00、p95 比 1.02/1.15；密度档 1.05/1.04、0.98/0.96）；U2 密度档 ≤3‰ 档达标（run1 0.17‰）、1MB 冷区 jank32 ~80%、p95 199~353ms **未达 -30%**（归因冷区首渲布局墙，根治 = P3 待拍板，本轮不重开）；U3 longtask 全 run ≤1/0；D1 密度档四场景全 0、1MB down-fast/up-fast 位移帧 6/6、写入 7/8 全带归因；M1/M2/M3 = 0/0/100%（23/23，解题技巧档）；T1 0/0、T2 peak 10 持平（durP95 124~130 环境漂移归因留档——**T 类门以同批 ABAB 内对照为准，R8 实证跨批绝对值受会话污染**）；R1 1MB 打开 4,565ms、R2 打字密度档 112ms/1MB 404ms、R3 切换 2,010ms、R4 vitest 986、R5 scroll-abab p95 中位 165（+8% 门内）/ghost-stress 11/+0/0。
- **R8 负结果（本轮直接沿承，§3 证伪链）**：①"上滚方向调度不对称"证伪——同位置上下滚对称（1.02~1.05），原口径差异全是位置混杂（预热覆盖区 vs 冷区）——**本轮 focus/normal 对照必须同位置同序列**；②泵全队列活读 rect 微秒级非源；③滚动中预热增量批与掉帧零对齐；④禁 demote 不归零（p95 133 ≈ 布局墙底 + 首渲尾巴）；⑤快滚 16~30 帧样本统计效力不足——对称性判定以慢滚大样本（173~315 帧）为准。
- 生产日志复析角度：MD-9001（持续掉帧，30s 心跳窗）条目与 `view_focus` 切换（ui action）的**时间相邻性**——actions 枚举仅 click|key|ui 不含 wheel（R8 注记，日志无法区分滚动/打字），但 focus 切换本身是可定位的 ui action；若 MD-9001 尖峰紧跟 view_focus 之后出现，专注模式掉帧的生产证据坐实。

### 2.D 测量设施（现存直接挂靠）

- **缺口声明：现有全部 perf 脚本（scroll-abab / scroll-flash-bench / probe-* / open-1mb / ghost-stress 等）均无 focusMode 臂——专注模式滚动从未被基准测过，这是本症状未被历轮门禁捕获的直接原因。**
- 蓝本：`perf/tmp-r8/probe-jank.mjs`（rAF 帧间隔逐帧 + Longtask Observer（>50ms）+ 三哨兵 rect + `__scrollDebug`/`__mathPumpStats` 差分，已支持 `--scenario`/`--start-depth` 深位参数——位置混杂控制的现成设施）；CDP 底座 `perf/cdp.mjs`（滚轮驱动/帧间隔/longtask 既有支持）。
- focus 臂切换路径：dev store 改 `settings.focusMode`（`scroll-abab.mjs` 的 dev store 改开关蓝本）或菜单命令 `view_focus`；切换后以 `document.querySelector(".app").classList.contains("is-focus")` + host 内容宽度采样双重自证。
- 页内观测出口：`window.__scrollDebug()`（recent 逐段归因 / counters 含 `anchor.comp`、prewarm 维度；`layout:width`/`layout:block` 事件流）、`window.__mathPumpStats()`（队列深度/deferred/直绘与冷算）、`cv.relearn` 事件流（`scrollEmit` info 级，1s 限流）。
- 单测守卫（不得跳过）：`lazyInlineMath.test.ts`、`cvMemory.test.ts`、`scrollDebug.test.ts`、`viewportAnchor.test.ts`、`md1011-regression.test.ts`、`katexCache.test.ts`、`mathCachePrewarm.test.ts`。

## 3. 禁区与待拍板

- **已证伪勿重查**（第三~八轮证伪链 + 各报告"负结果留档"节；R8 五条见 §2.C——特别是位置混杂口径禁用与快滚小样本禁判）。
- **R4~R8 成果不得破坏**：R5 Fix-A/B/C/D、R6 Fix-A/B/C、R7 Fix-A/B——任何改动跑 `md1011-regression.test.ts` + `cvMemory.test.ts` + `lazyInlineMath.test.ts` + `scrollDebug.test.ts` 全绿且不跳过。
- **不得改专注模式视觉设计与交互形态（本轮最高产品禁区）**：全屏铺满/隐藏 chrome/顶部悬停工具栏的呼出交互是产品定案，本轮只优化进入专注模式后的滚动管线——不得以"建议缩小铺满宽度""保留部分 chrome"为修复方案；F-d 若定罪只许优化动画/合成层成本，不许改交互语义。
- **P3 提案（预热批渲染态测高，R8 留档待拍板）**：若 F-a 定罪且修复方向涉及高度表语义（宽度感知失效/重学触发），与 P3 同属"高度表保真度"命题、可能同路——**合入前须用户拍板**（§8 条款），不得在本轮静默夹带 P3。
- **F-a 修复的预热交互禁区**：切专注即清表全量重预热会重蹈 1MB ~45s 预热期主线程墙（R6/R7 已证的形态）——修复设计必须增量/分批（红线 18 落锤）。
- 未经用户拍板不得改默认值（`SCROLL_QUIET_MS`/`SCROLL_RENDER_BUDGET_MS`/`FORWARD_BAND_PX`/`SCROLL_HIT_PAINT_CAP`/`PREWARM_USER_YIELD_MS`/`DEMOTE_DELAY`/`IO_MARGIN`/**`BLOCK_WINDOW_MS`/`BLOCK_WALK_WINDOW_MS`/`BLOCK_WALK_IDLE_MS`** 等常量——F-c 定罪时先出节律/让路方案请拍板，不许直接动常量）、不得重引入 bigDocViewportAuto、不得改档位开合逻辑。
- **不得以砍观测/砍公式完整性换指标**：scrollDebug 是历轮定罪基建（walkBlocks 节律调整属拍板项）；M1/M2/M3 是硬门，T1/T2 劣化 >10% 即回滚。
- `overflow-anchor` 禁用是定案；四层补偿链（viewportAnchor/prewarm-comp/anchor-comp/overflow-anchor 禁用）无归因证据不整体拆动。

## 4. 可量化目标（门禁表；判分：F1/F2 与 D 组必须有本机数据，修复类门在证据立项后判定，M/T/R 组全部零回归；未达项附归因，不许留空）

### F 组：专注模式掉帧（症状 F，本轮主门；scrollPhase 窗 = 滚轮驱动期，静止门生效前；对照臂 = 正常模式同文档同位置同序列——R8 位置混杂教训制度化）

| # | 指标 | 已知基线 | 目标 | 测量 |
|---|---|---|---|---|
| F1 | 模式对称性主门：①scrollPhase 窗 rAF 帧间隔 >32ms 帧数的 focus/normal 比值；②帧间隔 p95 的 focus/normal 比值（normal 侧计数为 0 时以 p95 比值为准并注明） | 无独立口径（历轮脚本无 focusMode 臂）——阶段三以 r9 探针钉死 | 两比值均 **≤1.25**（密度档与 1MB 双测、快滚慢滚各 ≥2 轮方向一致；**慢滚大样本为准，快滚只留档**；normal 臂数据同窗采集） | 新建专注模式掉帧探针（§5，入 `perf/tmp-r9/`）；产物 `perf/results/r9-phase3-jank-<模式>-<场景>-<fixture>-<n>.json` |
| F2 | 绝对强度（分档）：focus 臂 scrollPhase 窗 >32ms 帧占比 | 阶段三钉死 | 密度档较基线 **-50% 或 ≤3‰**（取先达者）；1MB 较基线 **-30%**（R8 冷区墙背景底允许残差，未达须归因） | 同 F1 |
| F3 | focus 臂滚动驱动期 >50ms longtask 计数（Longtask Observer） | 阶段三钉死 | 较基线 **-50%**，且 ≤ 同窗 normal 臂 +2 | 同 F1 |
| F4 | 高度震荡观感项（报告项，非硬门）：`cv.relearn` 改写计数 + 每帧 scrollHeight 采样方差，focus/normal 对照 | 无 | 只记录只对比不设门（F-a 归因的核心证据 + 修复效果自证口径） | 探针采 `cv.relearn` 事件流 + scrollHeight 序列 |
| F5 | 切换瞬间顿挫（报告项）：进出专注模式切换后 2s 窗最大帧间隔与 >32ms 帧数 | 无 | 只记录（F-c 归因证据；若用户补充"切换也卡"再升级为门） | 同 F1（探针含切换段分窗） |

### D 组：停滚漂移防回退（R7/R8 硬底——**双臂**：normal 臂与 focus 臂各测，F-a 类修复最容易在专注模式复活它）

| # | 指标 | 已知基线 | 目标 | 测量 |
|---|---|---|---|---|
| D1 | R7/R8 D1 口径：停滚 10s 窗位移 >4px 帧数 / 程序化写入 / MD-1001/1002 | normal 臂：密度档四场景全 0、1MB down-fast/up-fast 6/6（写入全带归因）；focus 臂：无口径（阶段三补钉） | normal 臂**维持 0 / ≤9 不劣化**；focus 臂密度档四场景 **=0**、1MB **≤9** 且写入全带归因；MD 码维持 0 | normal 臂：`perf/tmp-r7/probe-drift.mjs` 直接复跑；focus 臂：r9 探针同口径双采 |

### M 组：完整性（沿承 R6~R8 硬门——禁止砍完整性换流畅度）

| # | 指标 | 已知基线（R8 收尾） | 目标 | 测量 |
|---|---|---|---|---|
| M1 | 滚动遍历往返 + 静止 10s 后行内公式源码占位残留 | 0（三档） | **维持 0**（focus 臂下加测一轮） | R6/R7 探针口径（`perf/tmp-r6/formula-probe.mjs` 规格，可重建） |
| M2 | 会话后 10s 泵队列挂起条目 | 0 | **维持 0** | `window.__mathPumpStats` |
| M3 | 视口内块级公式挂载率 / katex-error | 100%（23/23，解题技巧档）/ 0 | **维持 100% / 0** | R6 块公式挂载探针口径 |

### T 组：及时性（不劣化 >10%；**同批 ABAB 内对照为准**——R8 实证跨批绝对值受会话状态污染）

| # | 指标 | 已知基线（R8 收尾） | 目标 | 测量 |
|---|---|---|---|---|
| T1 | 静止补绘拖尾（quietPhase 占位事件/p95） | events 0 / p95 0 | **不劣化 >10%** | `node perf/scroll-flash-bench.mjs` quietPhase 窗（normal 臂 + focus 臂各一轮） |
| T2 | 滚动中视口源码占位峰值 / 可见时长 p95 | peak 10 / durP95 124~130（环境漂移留档） | **不劣化 >10%**（同批对照） | 同上 scrollPhase 窗 |

### R 组：防回归（全部零回归；基线为 R8 收尾同机，环境差异须声明）

| # | 指标 | 已知基线 | 测量 |
|---|---|---|---|
| R1 | 1MB 打开（3 轮中位） | 4,565ms | `MDITOR_DOC=1MB node perf/open-1mb.mjs 3 <tag>` |
| R2 | 打字 p95 密度档 / 1MB（g2 口径） | 112ms / 404ms | `MDITOR_DOC=无穷级数_密度档 MDITOR_MIN_BLOCKS=500 node perf/g2-typing.mjs <tag>`；1MB 档同法 |
| R3 | 切换中位（20 往返） | 2,010ms | `node perf/switch-bench.mjs --doc-a 无穷级数_密度档 --doc-b 解题技巧_密度档 --viewport off --switches 20 --tag <t>` |
| R4 | 全量守卫 | vitest 986（以实跑为准） | `npm test`（每优化 commit 前）；收尾 `npm run test:coverage` + `npm run lint` + `npm run build` |
| R5 | 历轮门禁复测：ABAB / ghost / **R8 上滚对称比（normal 臂）** | scroll-abab p95 中位 165；ghost 11/+0/0；R8 对称比两档 ≤1.25 | `scroll-abab --doc 1MB压测 --viewport on --round 3 --duration 60` + `ghost-stress --minutes 5` + `tmp-r8/probe-jank.mjs` up/down 修正口径复跑一轮 |

回归判定阈值沿用历轮：**劣化 >10% 且多轮方向一致才算回归**；normal 臂（正常模式）任何指标较 R8 基线劣化 >10% 同样算回归（"拉平对称性"不合法，见 §1 用户前提）。

## 5. 症状 F：取证设施与可证伪归因路径

- **取证设施（阶段二新建，只加观测不改行为，独立 commit）**：
  - 专注模式掉帧探针 `perf/tmp-r9/probe-focus-jank.mjs`（蓝本 `perf/tmp-r8/probe-jank.mjs`，继承 with-dev 挂靠/fixture 打开/滚轮驱动/`--scenario`/`--start-depth` 参数）：打开 fixture → **normal 臂**同位置同序列滚动 → 切专注模式（dev store 或 `view_focus` 命令，等布局稳定 ≥2s）→ **focus 臂**同序列滚动 → 切回；**ABAB 交错 focus/normal ≥3 轮**（跨时段漂移 2-3 倍的历轮教训）。每臂采：驱动期逐帧 rAF 间隔（performance.now() 差分）+ Longtask Observer（>50ms）+ 三哨兵 rect（掉帧 vs 跳位判别）+ `__scrollDebug`/`__mathPumpStats` 每帧快照差分 + **host 内容宽度采样（自证宽度突变已发生与量值）+ `cv.relearn` 事件流计数 + 每帧 scrollHeight（F4 口径）**；切换段（切专注后 2s 窗）单独分窗统计（F5）。输出 jsonl（帧间隔序列 + 掉帧帧列表 + 每帧对齐的 relearn/写入/longtask 归因 + 分窗汇总）；tag 命名 `r9-phase<N>-jank-<focus|normal|width-ctrl>-<场景>-<fixture>-<n>`。
  - **宽度对齐控制臂（F-b 隔离实验——本轮方法论核心）**：正常模式下拖拽窗口宽度/侧栏开合，使 `.ProseMirror` 内容宽度 ≈ 专注模式宽度（探针自证两臂宽度差 <10px），同序列滚动。此臂把"宽度本身"与"模式特有机制"干净分离——R8 位置混杂教训的制度化应用。
- **归因判据表**（探针数据直接套用；先分掉帧 vs 跳位，再归因）：
  - 帧 interval >32ms 帧与 `cv.relearn`/`layout:block` 事件、scrollHeight 变化同帧对齐，且 normal 臂同位置无此形态 → **F-a 定罪**。
  - 宽度对齐臂掉帧 ≈ focus 臂（差 <10%）→ **F-b 定罪**（量化占比：focus-normal 差值中宽度可解释的比例，报告必填）；宽度对齐臂仍显著低于 focus 臂 → F-b 非主因，模式特有机制（F-a/F-c/F-d）继续追。
  - 掉帧集中切换后 2s 窗（F5 窗）或与 big 档常驻 walk 节律（1s 周期）对齐，`__scrollDebug` 的 block.walk 维度同步 → **F-c 定罪**。
  - 掉帧仅在光标贴顶 8px / 拖顶部滚动条时出现，与 toolbar 过渡时刻对齐 → **F-d 定罪**。
  - 帧间隔正常但单帧哨兵位移大 → 不是掉帧是跳位：对齐 anchor-comp 写入 → F-a 的位移面（与掉帧面并案报告，D 组 focus 臂同步看护）；对齐无归因写入 → writeTrap 栈走裸源。
  - 复现不了的症状必须产出「为何在此环境不触发」的归因（构建/缓存/预热状态/文档差异），不许静默跳过。
- **可证伪句子**（每条先写再动手，§10 第 3 步；证据不成立换下一候选，不许并行改多个）：
  - F-a：若专注掉帧 = 高度表宽度陈旧，则掉帧帧与 `cv.relearn`/scrollHeight 变化同帧对齐且 normal 臂同位置无；机制对照——切专注时临时清空高度表强制重预热（原型开关，不合入，跑完恢复），预热完成后 focus 臂该形态应消失（代价是重蹈预热期形态——**此对照只证机制不给方案**）。若掉帧与 relearn 不对齐则 F-a 非主犯。
  - F-b：若 = 宽度本身，则宽度对齐臂掉帧 ≈ focus 臂，且把窗口拉得更窄（窄于正常模式）时掉帧进一步下降——宽度-掉帧剂量关系成立。
  - F-c：若 = 诊断走查税，则掉帧与 walkBlocks 执行时刻对齐（1s 节律或 2s 窗内密频）；原型——临时 `BLOCK_WALK_IDLE_MS`→5000、`BLOCK_WINDOW_MS`→0（原型不合入，跑完恢复并核验）后 focus 臂掉帧 -50% 以上。
  - F-d：若 = 悬停工具栏过渡，则掉帧仅在光标近顶时出现；原型——临时 `display:none` 掉 `.focus-hover-zone`（跑完恢复）后该形态归零。
  - F-f：若与打字机组合相关，则关打字机后 focus 臂掉帧归零（先确认用户现场该开关状态，默认 false）。

## 6. 与历轮遗留案件的交叉声明

- **P3 提案（预热批渲染态测高，R8 留档待拍板）**：F-a 定罪时的修复方向（宽度感知失效/重学触发）与 P3 同属高度表保真度命题——若本轮立项修复 F-a，P3 拍板材料（R8 报告 ⑤：冷区队列膨胀 3,310、每帧 layout 67ms、预期 p95 199→~130）一并呈报用户，可并案可分案，**不得静默夹带**。
- **R8 冷区首渲布局墙（1MB 绝对强度墙）**：两模式共有的背景底——本轮 F2 的 1MB 门只考核 focus 相对 normal 的增量；若 F-a 定罪修复后 1MB 冷区绝对值顺带改善，属红利记录不属门禁，亦不得以此宣称"解决 R8 遗留"。
- **F-a 修复与预热的交互**：全量清表重预热 = 重蹈 1MB ~45s 预热期主线程墙（R6/R7 已证）——修复必须增量/分批（如仅失效视口带邻近条目、按旧宽度分组惰性重学、或 `contain-intrinsic-size` 加 `auto` 前缀让 remembered-size 自纠——后者须先论证与 R7 锁盒语义/补偿链的交互），红线 18 落锤。
- **R7 残余 1MB 位移帧（6+6/写入带归因）**：focus 臂下可能放大（错误占位高变现）——D 组 focus 臂看护；若与掉帧同帧（F-a 的位移面）则一并修并双门验收（F1+D1），否则只报不修。
- **R1（V4.6.0）「聚焦切换全文档样式重算」防混淆声明**：那是编辑器 focus/blur 的 `.ProseMirror-focused` CSS 变量翻转（blur→focus 762ms→修后 0ms），与专注模式 focusMode 是**两个不同概念**——执行者勿混淆、勿重修、勿把它算作本轮前案。
- **R5 J-α''（+32s 未打标整千跳变，未定罪）**：维持不并案，除非 writeTrap 在本轮取证中直接捕获栈。

## 7. 执行阶段（各自成阶段，顺序推进；凭实测可重排，报告说明理由）

沿用第五~八轮：直接执行、阶段门禁自查后才进下一阶段。

- **阶段一：版本核实 + 生产日志复析 + 现场设置确认**。核实用户安装构建（ProductVersion 5.0.0、exe mtime）与 main 同源（预期成立，坐实即可）；生产日志复析 MD-9001 条目与 `view_focus`（ui action）时间相邻性——专注模式掉帧的生产证据；确认用户现场打字机模式等组合设置（F-f 立论依据）。
- **阶段二：复现与探针建设**。新建 probe-focus-jank（只加观测不改行为，独立 commit）；dev 实例复现症状 F（focus vs normal × 快/慢 × 密度档/1MB，同位置同序列，1MB 加预热完成双臂）至少各一例，focus-normal 掉帧差非零才进阶段三；复现不了按 §5 归因说明。
- **阶段三：基准**。F1/F2/F3/F4/F5 + D1 双臂 + M/T/R 对照臂全口径基线（含宽度对齐控制臂），填死门禁表基线列；产物落 `perf/results/r9-phase3-*.json`。
- **阶段四：归因（禁盲改）**。按 §5 归因判据表逐候选定罪/排除（先分掉帧 vs 跳位，F-b 用控制臂剥离），产出归因结论 `perf/results/r9-phase4-attribution.md`（每条附证据文件与数据）；未定罪不许进修复。
- **阶段五：分批修复（Fix-A/B/C…）**。按定罪排序分批，每项独立 commit（hash+file:line+复杂度+回退开关）、附新增单测、ABAB 交错 focus/normal ≥3 轮；F-a 类涉高度表语义与 P3 联动的只出原型数据请用户确认后合入；F-c 类节律调整先出方案请拍板。
- **阶段六：全量门禁 + 打包冒烟 + 报告**。F/D/M/T/R 全表复测（D 组双臂）+ **重建打包安装包实机断言**（用户症状在打包 v5.0.0 正式版：专注模式滚动 scrollPhase 掉帧项 + 停滚 6s 窗漂移 0 项，R8 prod-smoke 口径沿承，避让 9222 用 9224）+ 报告与文档更新（§11）。

## 8. 创新算法条款（若引入新调度/补偿/预算机制）

复杂度分析（时间/空间，按视口内条数 n 与全文档 N 表达）+ 三规模档实测（密度档/1MB/超限 fixture）+ 原型先行（脚本级验证再落地）+ 降级开关（新策略可一键回退旧路径）+ 1,000 次随机编辑差分（新旧行为等价性，渲染结果与最终 scrollTop 逐条比对）。不满足任一条不合入。F-a 的宽度感知失效策略若引入新数据结构（如宽度分组高度表）必过本条款。

## 9. 红线（编号沿承历轮 + 本轮增补）

1. 未经用户拍板不得改默认值（含 `SCROLL_QUIET_MS`/`SCROLL_RENDER_BUDGET_MS`/`FORWARD_BAND_PX`/`SCROLL_HIT_PAINT_CAP`/`PREWARM_USER_YIELD_MS`/`DEMOTE_DELAY`/`IO_MARGIN`/`BLOCK_WINDOW_MS`/`BLOCK_WALK_WINDOW_MS`/`BLOCK_WALK_IDLE_MS` 等常量）、不得重引入 bigDocViewportAuto。
2. 已证伪路线勿重走（§3 证伪链，含 R8 五条负结果——位置混杂口径禁用、快滚小样本禁判）。
3. 默认档（非 cv 档）急切渲染定案勿改；减配档关公式是既有决策，非本轮靶。
4. KaTeX 0.18.4 单实例钉住不动（package.json overrides）；不引入新渲染引擎；`src/lib/mathConfig.ts` 宏语义与单一来源不动。
5. R5 Fix-A/B/C/D、R6 Fix-A/B/C、R7 Fix-A 不得破坏：`md1011-regression.test.ts`、`cvMemory.test.ts`、`lazyInlineMath.test.ts`、`scrollDebug.test.ts` 既有用例全绿且不跳过。
6. node_modules 改动只走 `patches/`。
7. 每优化 commit 前 `npm test`；收尾 `test:coverage` + `lint` + `build`。
8. 先测后改六步（§10）；一次一项；ABAB 交错 ≥3 轮；达不到假设就回滚。
9. 观测补点（探针/计数/采样窗）与行为修复分开 commit。
10. perf 硬清理只杀自 spawn 的 dev PID 树（`taskkill /IM` 误杀教训）；tmp 脚本入 `perf/tmp-r9/` 并头注"不入库"。
11. 不改测量口径；fixture 只许改生成参数不许改测量逻辑。
12. 四层补偿链（viewportAnchor/prewarm-comp/anchor-comp/overflow-anchor 禁用）与 smoothJump 互斥旗标无归因证据不动（R6 红线沿承）。
13. 不得以关停静止补绘、关停预热、砍公式完整性或及时性换取任何指标归零——M1/M2/M3 是硬门，T1/T2 劣化 >10% 即回滚（R7 增补沿承）。
14. anchor-comp 兜底层不得无证据整体拆除（R7 增补沿承）。
15. 不得以复活 R7 停滚漂移换取流畅度——D1 密度档四场景 0 是硬底（R8 红线沿承，本轮 D 组扩为双臂）。
16. **（本轮增补）专注模式视觉设计与交互形态不动**——全屏铺满/隐藏 chrome/hover 工具栏呼出是产品定案；F-d 类修复只许优化动画成本（合成层/时长/过渡属性），不许改交互语义，不许"建议用户别全屏"。
17. **（本轮增补）不得把正常模式改坏拉平对称性**——normal 臂任何门禁指标较 R8 基线劣化 >10% 即回滚；对称性只许 focus 臂向上够。
18. **（本轮增补）高度表宽度失效策略不得引发全量重预热**——切专注清表重学全文档（重蹈 1MB ~45s 预热主线程墙）的方案直接否决，须增量/分批设计并过 §8 三规模档实测；**诊断税修复只许节流让路不许砍观测能力**——walkBlocks 机制与 `BLOCK_WALK_*` 常量未经拍板不动。

## 10. 先测后改六步（每个修复项逐一过）

1. 基线：改动前跑该门禁指标 ≥2 轮取中位；
2. 定位：探针/观测数据指到具体代码路径（file:line）；
3. 可证伪假设：写成"若改 X 则指标 Y 应变化 Z%"的句子；
4. 单项改动：只改这一处，commit 独立；
5. ABAB 交错：改动/基线 A/B/B/A ≥3 轮，方向一致才算数；
6. 保留或回滚：达标保留并记录，不达标回滚并留档（负结果同样写入报告，防重走）。

## 11. 交付物

- 报告 `mditor/docs/large-doc-focus-mode-scroll-smoothness-report.md`，六节体例：①基线声明（HEAD/环境/用户构建核实/生产日志复析结论/fixture）；②归因结论（F 候选定罪/排除表 + 掉帧 vs 跳位判别 + 宽度对齐控制臂结论，附证据与探针产物路径）；③改动清单（每项 commit hash + file:line + 复杂度 + 回退开关）；④门禁全表（F/D/M/T/R 逐行基线→结果，未达项附归因不许留空）；⑤遗留与放弃（含 P3 拍板联动结论、R7 残余并案结果、负结果留档）；⑥文档更新清单。
- 文档同步：`mditor/docs/performance.md`（第九轮节：模式对称口径、宽度失效机制与权衡）、`mditor/docs/dev-anomaly-codes.md`（若复用/新增口径须登记）、`mditor/CHANGELOG.md` Unreleased 节、memory 日记更新。
- 测量产物：`perf/results/r9-*.json`（tag 命名 `r9-phase<N>-jank-<模式>-<场景>-<fixture>-<n>`）；`perf/tmp-r9/` 一次性探针（不入库惯例，实际历轮均随 commit 入库）。
- 发版：本轮不发版；阶段六打包冒烟安装包重建后验完即弃或留用由用户定，发版节奏由用户另行决定。
