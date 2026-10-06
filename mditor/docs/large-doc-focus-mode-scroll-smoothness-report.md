# 大文档专注模式滚动丝滑度专项报告（R9，2026-10-04 ~ 10-06）

任务书：`docs/prompts/large-doc-focus-mode-scroll-smoothness-optimization-prompt.md`（工作区根 `Tp/docs/prompts/`）。
归因定罪书：`perf/results/r9-phase4-attribution.md`。过程备忘：`.workflow/task2-forensics/r9-phase2-notes.md`。

## ① 基线声明

- **环境**：Windows 10.0.26200 x64，dpr 1.75，窗口 1463×867；Tauri WebView2。dev 实例 CDP 9223（探针自管）、打包版 CDP 9224。
- **HEAD**：立项时 `e840d26`（v5.0.0 正式版 = main 同源）；修复落地 `e38aaa9`；探针加固与收尾 commits 见 ③。
- **用户构建核实**：`%LOCALAPPDATA%\Mditor\mditor.exe` ProductVersion 5.0.0（10-03 15:17，R8 收尾正式版安装包），与 main 同源无版本差。
- **fixture**：症状文档「题型方法决策树」（224KB，cv 档过线文档，prod 文件树 01_专题笔记 下）；dev 侧密度档（无穷级数_密度档）/1MB（1MB压测）沿承历轮。
- **生产证据复析（阶段一）**：MD-9001 告警条目与 `view_focus`（ui action）时间相邻性成立（任务书 §2.C 沿承）；用户现场组合设置核实完毕（打字机未开——F-f 无组合前提）。
- **复现三要素（阶段二最大事件）**：症状 F **只在打包版复现**——dev 8 run 全部失败（focus 不劣于 normal，p95 比 0.51~1.05 方向不一致）。三要素 = 打包版 + 用户症状文档（题型方法 224KB cv 档）+ release 预热完成态。dev 不复现的归因（留档防重走）：dev 构建预热 1 块/26ms 爬行死锁（prewarm 走全量 buildDecos，9639 块需 ~36min；release 瞬时完成）→ dev 侧 1MB 高度表冷；密度档布局便宜（p95 6~9ms）；dev 呈现路径无 Present 停摆形态（trace 证实）。
- **prod 复现基线（阶段二，题型方法 down-slow）**：focus 臂 j32=8~10 / normal 臂恒 0（run5~20，ABAB 6 臂交错 ×多 run，方向稳定）。run21~26 出现基线自发衰减（8~10 → 0~5，位置/会话状态效应，留档）；run27/28（r9fix tag）**作废**——事后查明探针 spawn 的 release exe 被 tauri-plugin-single-instance 转发给泄漏旧实例（其 WebView2 占着 9224，CSSOM 只有原型注入样式、无主样式表），测的是旧代码；该事件催生探针加固（③ 第 4 项）。
- **修复验证（阶段六，r9fix2 批，2026-10-06）**：加固后探针（预杀残留 + 转发检测 + exe 身份钉 + 逐臂 keepwarm 活性）重测 8 run——down-slow ×4（臂序双向）、down-fast ×2、up-slow ×2，**focus j32 = 0 / normal j32 = 0 全绿**，p95 比 0.98~1.08，D1 双臂漂移全零，全部 focus 臂 `focus-keepwarm/running` 实证（产物 `perf/results/r9-phase2-prod-jank-*-r9fix2-29~36.json`，聚合 `perf/tmp-r9/analyze-r9fix2.mjs`）。

## ② 归因结论

**定罪：F-g（任务书候选 F-a~F-f 全部实验排除，清单外新源）——ai-fab 呼吸动画的合成器保温效应丢失。**

- 机制链：normal 模式 `.ai-fab:not(.active)::after` 的 fab-pulse 无限合成器动画（transform+opacity，2.4s 循环）逐 vsync 驱动合成器产帧（trace：normal 12s 内 2008 次 Present ≈ 每 vsync 呈现，DXGISwapChain 常热）；focus 模式 `.is-focus .ai-fab{display:none}` 一并消灭该动画 → 滚轮间隙（450ms）合成器零产帧 → swapchain/DWM 冷却 → 下一滚动帧 `DXGISwapChainImageBacking::Present` 阻塞 40~124ms = 用户所见「一顿一顿」。（focus 12s 仅 340 次 Present；每个 >32ms 掉帧 gap 与一次 Present 停摆严格同长。）
- 病灶层定量：GPU 进程 Present max **123.9ms**×7 gap（focus）vs **0.4ms**（normal，同文档更大几何 1256×899）；光栅便宜（RasterCHROMIUM max 5.2ms）、主线程空闲（掉帧 gap 无 >2ms 任务）——排除 JS/布局/光栅侧。
- 排除表（prod 题型方法档，j32 口径）：F-a 高度表宽度陈旧（代码事实成立：宽度突变 985→1249 坐实、cv.relearn=0 无重学路径；但未转化——掉帧帧 dsh=0）｜F-b 宽度面积（wctrl 臂 pw=1250=focus 仍 0）｜F-c 诊断税（normal 事件更多却零掉帧）｜F-d hover-zone（display:none 仍 8）｜F-e 死类无罪沿承｜F-f 打字机无组合前提。CSS 触发面二分 7 组定罪到「藏 ai-fab」单组（naf-fab 单独复现 7；resizer/titlebar/tabbar/sb-status/sidebar 塌缩各组全 0）。
- 判别实验（同型对照）：fab-noanim（normal 停 fab 动画）→ 掉帧不出现于 normal 但保护因子消失方向确认；fab-invisible（opacity:0）无效、fab-ghost（opacity:0.05）治愈 j32→0；**main-jitter（.main 挂 translateZ 亚像素动画）治愈 j32→0** → 保温因子是「合成器动画存在」本身，且可移栽到任意常驻层。
- 掉帧 vs 跳位判别：掉帧帧三哨兵 |Δtop| 无 >4px 跳变（rAF gap 拉长型），非内容跳位。

## ③ 改动清单

| # | commit | 内容 | file:line | 复杂度 | 回退开关 |
|---|---|---|---|---|---|
| 1 | `e38aaa9` | **Fix-A 保温动画**：`.is-focus .main` 挂 `focus-keepwarm`（translateZ 0↔0.001px，2.4s linear infinite）恢复连续呈现；`.app-idle` 暂停（窗口隐藏不烧电，纪律与 fab-pulse 一致） | `src/styles/global.css:586-600` | O(1) 纯 CSS，无 JS 改动；无 2D 位移→视觉零变化，层纹理复用→光栅零成本 | 删除该规则即回退；动效「无」档（prefers-reduced-motion / data-motion=none）kill switch 连带停用（B12 既有链路，用户显式偏好不豁免） |
| 2 | `7f3edf9`/`9a533d5`/`2003dc8`/`76e50e6` | 探针族（观测补点，与行为修复分开 commit）：`perf/tmp-r9/probe-focus-jank.mjs`（dev）、`prod-focus-jank.mjs`（打包版）、`trace-focus-jank.mjs`/`trace-gpu-jank.mjs`（CDP Tracing 渲染管线/GPU 定位） | `perf/tmp-r9/` | — | 不入运行时 |
| 3 | `e38aaa9` | 守卫测试 ×4（样式钉，防无感删改）：① `.is-focus .main` infinite 动画在位；② keyframes 只动 translateZ（零 2D 位移，可感抖动即违约定罪）；③ `.app-idle` 暂停纪律在位；④ focus 的 fab 隐藏规则未被顺手动回（保温是管线补偿，非复活 fab） | `src/lib/focusKeepwarm.test.ts` | — | — |
| 4 | `2404fa9` | prod 探针加固：spawn 前预杀残留实例（taskkill /IM mditor.exe）、spawn 转发劫持检测（child.exitCode）、exe 身份钉（样式表 focus-keepwarm 存在性 + `--expect-keepwarm` 硬门）、focus 臂 keepwarm 活性逐臂记录（computed animationName/playState）、**证据先落盘 + 归位收尾 8s 超时**（r9fix2-run29 事故：归位 eval 在 CDP 慢死链上无超时挂起，吞掉整 run 数据）——run27/28 假阴性事故的制度化防再犯。同 commit：8 基准脚本开档点击 el.click() 化（runtime .53 坐标点击失效）、挂靠型包装器 store 钉（MDITOR_SET_BIGDOC） | `perf/tmp-r9/prod-focus-jank.mjs` + `perf/{scroll-abab,scroll-flash-bench,open-1mb,g2-typing,switch-bench,ghost-stress}.mjs` + `perf/tmp-r8/probe-jank.mjs` + `perf/tmp-r6/formula-probe.mjs` + `perf/tmp-r9/r9-run-with-dev.mjs` | — | — |

## ④ 门禁全表（阶段三+六）

F 组口径适配说明（报告留档）：症状 F 仅在「打包版 × 题型方法 cv 档 × 预热完成态」复现（①），故 F1/F2/F3 的判分数据取 prod 题型方法档；密度档/1MB 在 dev 无不对称（focus/normal 比 ≤1.25 天然成立，数据留档 r9-phase2-jank-*）。快滚只留档、慢滚大样本为准（R8 制度沿承）。

| # | 指标 | 基线 | 结果 | 判定 |
|---|---|---|---|---|
| F1 | 对称性主门：j32 比 focus/normal + p95 比（prod 题型方法 down-slow ×4，臂序双向） | j32 比 ∞（focus 8~10 / normal 0，run5~20） | **j32 比 = 1（0/0）×4；p95 比 1.00/1.00/0.98/1.02**（4.8~4.9ms 双臂同量级） | **达标 ≤1.25 ✓（4/4 方向一致）** |
| F1 | down-fast ×2 / up-slow ×2（prod，臂序双向） | —（旧代码未测快滚/上行） | **j32 比 = 1（0/0）×4**；p95 比 down-fast 1.08/1.08、up-slow 0.99/1.02 | 留档 ✓ |
| F1 | 密度档 / 1MB（dev） | focus≈normal（91/111 等，8 run 方向不一致） | 沿承（修复不改 JS，dev 无需重测；prod 侧见上行） | 比值 ≤1.25 ✓ |
| F2 | 绝对强度：focus 臂 j32 占比（prod down-slow） | ~3.4‰（8~10 帧 / ~2600 帧窗，run5~20） | **0.0‰**（8 run × 3 focus 臂全 0） | **-100%（≥-50% 门）✓** |
| F3 | focus 臂 >50ms longtask（滚动驱动期） | 0 | **0**（= normal +0） | ✓ |
| F4 | 高度震荡观感项：cv.relearn + scrollHeight 方差 focus/normal | relearn=0 双臂；shVar 同量级 | 沿承归因数据（run29~36 ctrDelta 同形态） | 记录项 |
| F5 | 切换瞬间顿挫（2s 窗 max gap / j32） | 无（新口径） | focus 5~18.7ms / j32=0；normal 5~19ms / j32=0（8 run 双臂对称） | 记录项（无异常） |
| D1 | 停滚 10s 窗位移 >4px 帧（prod 双臂 ×8 run ×6 臂） | normal：密度档四场景 0（R8）；focus：无口径 | **双臂 driftShift=0 / Δst=0（48 臂全零）**；dev r9p2 密度档双臂 0 沿承；1MB dev 双臂同劣为 dev 预热死锁已知混杂（非修复回归，修复纯 CSS） | **达标 ✓（focus 密度档场景=0 口径以 prod 症状档交付）** |
| M1 | 滚动遍历+静止 10s 行内源码残留 | 0 | **vpUnready=0 / bandUnready=0**（traverse 2355 块档，`r6-phase2-traverse-r9m.json`） | **维持 0 ✓** |
| M2 | 会话后泵队列挂起 | 0 | **queue=0 / live=0 / oldestMs=0**（traverse 全程泵尾采样） | **维持 0 ✓** |
| M3 | 视口内块公式挂载率/katex-error | 100%（23/23）/ 0 | **latex 23 / latexK 23 / mountRate 1 / neverK []**（解题技巧档） | **维持 ✓** |
| T1 | quietPhase 占位事件/p95（normal 臂） | events 0 / p95 0 | events 9~19、peak 15、dur 33ms（f1 窗，stillOpen=0） | 字面未达 → 归因环境漂移（见下注） |
| T2 | 滚动中占位峰值/可见 p95（同批对照） | peak 10 / durP95 124~130 | peak 22 / dur 200~229（三轮稳定） | 字面未达 → 归因环境漂移（见下注） |
| R1 | 1MB 打开 3 轮中位 | 4,565ms | **4,665ms**（4787/4524/4665，cv=on 口径） | **+2.2% ✓**（首测 12.2s 为 cv=false 口径混杂，作废留档） |
| R2 | 打字 p95 密度档/1MB | 112ms / 404ms | 密度档 **40ms**（p50 24 持平）；1MB **432ms**（p50 184 vs 基线 192/200，+7% 门内）——均 cv=on 口径 | **双档 ✓**（首测 624/400 为 cv=false 口径混杂，作废留档） |
| R3 | 切换中位 20 往返 | 2,010ms | **629/623ms**（双方向各 10 次，armValidated） | **-69% 方向为优 ✓** |
| R4 | 全量守卫 | 990 绿 | **test:coverage 990/990（90 文件，含 focusKeepwarm ×4）；lint 0 错；build ✓ 13.0s** | ✓ |
| R5 | scroll-abab 1MB on ×3 / ghost 5min / R8 对称比 | p95 中位 165 / ghost 11+0+0 / 两档 ≤1.25 | abab **166.5/166.7/170.8（中位 166.7，+1.0%）**；ghost **11/+0/rebase=0 完全一致**；对称比：**up 绝对值持平**（1MB up-slow 204.4/161.2 vs R8 199.1/202.7——R8 修复目标无回归）；比值 1MB 3.53 / 密度 1.38 为 down 对照臂环境性变优（R8 down 115~119 → 本轮 54.8/57.9，runtime .53）与亚阈（密度 j32 双零、p95 4.7~6.6ms）伪象 | abab ✓ / ghost ✓ / 对称比：**up 无回归 ✓，比值劣化归因分母变优（留档）** |
| 阶六 | 打包冒烟双断言（重建安装包实机）：focus scrollPhase j32=0 + 停滚 6s 窗漂移 0 | — | 安装包 `Mditor_5.0.1-beta_x64-setup.exe`（14:52 重建，exe ProductVersion 实测 **5.0.1-beta**）；冒烟探针 r9smoke-1：**focus j32=0（3/3 臂）+ 停滚 10s quiet 窗 driftShift=0/Δst=0（双臂 6/6 臂，≥6s 口径）**；`--expect-keepwarm` 身份钉过 + kw=focus-keepwarm/running 3/3 | **双断言 PASS ✓** |

**T1/T2 环境漂移归因注（R8 T2 同款方法论）**：①本轮测量环境已变——WebView2 runtime **154.0.4258.48 → 154.0.4258.53**（注册表实证，10-04 后自动更新；同一变更并致 CDP 坐标点击失效，见 ⑤）；②修复为零可达性——`focus-keepwarm` 规则作用域 `.is-focus`，normal 臂（T1/T2 场景）该选择器不匹配任何元素，src 该链路零改动；③R8 自己已记录 T2/durP50 受会话状态强污染（跨轮方差 3.4×）。结论：字面偏差不构成修复回归，按 R8 T2 先例留档。

## ⑤ 遗留与放弃

- **挂靠型基准的 ambient store 口径混杂（阶段六实测，测量基建事件）**：open-1mb/g2-typing 挂靠外部 dev 实例、不自管 store——批间被其它脚本（或应用自身持久化）把 `bigDocViewport` 翻成 false 后，R1 首测 12.2s（非 cv 档 1MB 全量急切渲染）/ R2d 624ms（密度档全量公式重排），与 R8 基线口径（cv=on：4.6s / 112ms）不可比。修正：dev 包装器 `r9-run-with-dev.mjs` 加 `MDITOR_SET_BIGDOC=on|off` 显式钉 store，复测即回基线（R1 4,665ms / R2d 40ms）。教训制度化：挂靠型脚本的门禁跑法必须显式钉 store。
- **CDP 坐标点击对 .ft-row 失效面扩大到 dev（阶段六实测，测量基建事件）**：10-03 尚工作的 `Input.dispatchMouseEvent` 坐标点击在 dev 窗口同样不再触发 React onClick（diag 对照：坐标点击后 active=null/pmc=2；el.click() 后 active=目标、11629 块、5s 稳定）——dpr 1.75 坐标换算疑点（prod 侧 run2~4 先发现）。已把 8 个基准/探针脚本的开档点击统一改为 DOM `el.click()`（scroll-abab / scroll-flash-bench / open-1mb / g2-typing / switch-bench / ghost-stress / tmp-r8 probe-jank / tmp-r6 formula-probe）；编辑器内落焦点击（原生命中测试）与键盘事件不受影响未动。
- **run27/28 假阴性事故**（探针测量工程教训，制度化）：tauri-plugin-single-instance 把探针新 spawn 转发给泄漏旧实例（旧实例 WebView2 监听 9224）→ CDP 连上旧代码。防再犯三件套已入探针（③-4）：spawn 前预杀、转发检测、exe 身份钉。
- **基线自发衰减现象留档**：run21~26 旧代码基线从 8~10 衰减到 0~5（位置/会话状态效应）。修复验证 run29+ 采用臂序双向 + 逐臂 kw 活性记录对冲。
- **F-a 高度表宽度陈旧风险留档（未转化但代码事实成立）**：cvMemory 视口学习只挂 doc 变化、contain-intrinsic-size 无 auto 前缀、宽度突变 985→1249 后表内 {w,h} 集体失配。本轮未转化（cv.relearn=0、dsh=0），若未来出现「切宽后首次进视口跳变」类症状应优先复查此机制。修复预研（若立项）：宽度感知失效 + 已渲染守卫 + 增量分批（红线 18：禁全量重预热）。**与 P3（预热批渲染态测高）同属高度表保真度命题，呈报用户可并案可分案，未静默夹带。**
- **负结果留档（防重走）**：dev 复现不可行（三要素缺失）；fab-invisible（opacity:0）不能保温——合成器对全透明层不产帧，须 opacity ≥0.05 或改用 translateZ 扰动；几何三要素（宽/高/双维）与 .main 样式、app padding、hover-zone、各 chrome 组塌缩全部与本症状无关。
- **放弃项**：无（Fix-A 一次达标，无需 Fix-B/C）。

## ⑥ 文档更新清单

- `mditor/docs/performance.md`：R9 节（模式对称口径 + F-g 机制 + 保温动画权衡）。
- `mditor/CHANGELOG.md`：Unreleased（R9 批）。
- `mditor/docs/dev-anomaly-codes.md`：【待登记：无新码；run27/28 工程事故不属产品异常码范畴，报告留档即可——待复核】。
- memory/日记：2026-10-04/06。
- 版本：5.0.0 → **5.0.1-beta**（tauri.conf.json / Cargo.toml / Cargo.lock / package.json 四处），CHANGELOG Unreleased 转 5.0.1-beta 节；安装包重建 + 冒烟（④ 阶六行）。发版节奏按任务书 §11 由用户另行决定（5.0.1-beta 为修复交付序列，是否转正 5.0.1 留待用户拍板）。
