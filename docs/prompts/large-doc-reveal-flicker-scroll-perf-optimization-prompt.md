# 任务：mditor 大文档滚动第十一轮治理——首现闪刷收尾（块级换装 + 文字块首绘）与滚动性能专项（R11）

> 使用方式：本任务书配套 `/goal` 命令交付（目标文本见下方代码块，直接粘贴）。前端代码在 `mditor/` 子目录，所有 `perf/` 与 `npm` 命令在 `mditor/` 下运行。双目标各自独立定罪、独立修复、独立收口（HX 轮体例），按 §7 阶段顺序推进，每阶段证据落盘（`perf/results/` 与报告草稿）并自查后才进下一阶段。动手前必读第 0、1、2、3、9 节——本任务禁止盲改，禁止重修 R1~R10 已修问题，禁止重走已证伪路线，禁止预设根因结论。
>
> ```text
> /goal 修复 mditor 大文档上下滚动时"第一次"滚到的公式、文字等块出现刷新闪烁（第十一轮），并优化滚动性能。范围钉死：① 症状 E 首现闪刷——R10 已定罪未修的块级换装（S-a：块公式/代码块 nodeview 挂载完成于视口内，12/12 实锤）是头号已决疑犯；行内首过冷区（首开即滚、预热未完成路径——R10 主门全在预热完成后测）与文字块首绘（R10 元素四桶中"其它"未单列）是两个未建口径的新front；revisit/demote 残余复验维持。② 症状 P 滚动性能——1MB cv 档快滚帧 p50 ~205ms（R8 冷区首渲布局墙背景底，R10 收尾复测 209ms 噪声级）为优化对象，密度档/默认档帧率零回归。任务书：docs/prompts/large-doc-reveal-flicker-scroll-perf-optimization-prompt.md——先通读并遵守 §0 基线核实（含用户安装版本含 R10 的身份门核实）、§2 已查明事实集不重查、§3 禁区与红线，在 mditor/ 下按 §7 阶段执行。完成判据（全部满足才 pass）：① E 组——E1 块级换装可见事件（挂载完成时已在视口，分元素类型）较基线 -80% 且解题技巧档 ≤2 次/全程；E2 行内首开即滚序列 S1 ≤5 次/全程（基线阶段三钉死）；E3 文字块首绘口径建门并达标（目标阶段三填死）；E4 revisit/demote 维持 R10 收尾值；E5 盲序录屏过用户观感复核（R10 S5 未兑现项，本轮必须闭环）；② P 组——1MB 快滚帧 p50/p95 较同批 ABAB 基线 -25%（达不到附归因），密度档/默认档 ±10% 内，P3 提案第三次呈报拍板不得静默夹带；③ 零回归——npm test ≥1089 全绿（以实跑为准）、M1/M2/M3、T1/T2、D1、R9 双断言、R1~R5 基准全维持；④ 交付——报告落盘 + 归因书 + CHANGELOG Unreleased + 打包冒烟 + memory 日记。红线：块级预挂载必须限速（每帧预算），不得以整带同步重活或"永不拆卸/全量常驻"换零闪刷；不得拆 cv 档懒渲染架构或砍 G6 让路/预热换任何指标；常量与挂载形态未拍板不动；KaTeX 0.18.4 单实例与 R4~R10 全部 Fix 不得破坏；观测与修复分开 commit；每 commit 前 npm test；先测后改六步。
> ```
>
> 前序任务书引用链（体例连续，背景可查）：`docs/prompts/large-doc-bottom-flicker-optimization-prompt.md`（第十轮，已结题——**本轮直系前案：其 §2.B 症状候选、§5 归因判据表、§9 红线 1~21 全部沿承；S-a 块级定罪与"块级主动预挂载原型（限速预挂）另报拍板材料"立项（其 §2 修复立项节）正是本轮主体兑现项**）、`docs/prompts/large-doc-focus-mode-scroll-smoothness-optimization-prompt.md`（第九轮，已结题——prod 探针加固全套与"dev 复现不可能"教训）、`docs/prompts/large-doc-upscroll-jank-optimization-prompt.md`（第八轮，已结题——**冷区首渲布局墙定罪书是本轮 P 组立论底；P3 提案（预热批渲染态测高）第一次呈报**）、`docs/prompts/large-doc-scroll-drift-optimization-prompt.md`（第七轮）、`docs/prompts/large-doc-formula-render-optimization-prompt.md`（第六轮——**P3 提案首见于 R5 报告，R6 呈报**）、`docs/prompts/large-doc-scroll-stability-optimization-prompt.md`（第五轮）、`docs/prompts/large-doc-perf-motion-optimization-prompt.md`（第四轮——1MB cv 档滚动布局墙封案）、`docs/prompts/large-doc-perf-optimization-prompt.md`（第三轮）。结题报告链：`mditor/docs/large-doc-bottom-flicker-report.md`（R10）、`large-doc-focus-mode-scroll-smoothness-report.md`（R9）、`large-doc-upscroll-jank-report.md`（R8）等；归因定罪书 `mditor/perf/results/r10-phase4-attribution.md`（本轮事实底）。
>
> 【填写】观察环境（用户 2026-10-19 报障，其余待补）：症状原话——**"上下滚动时第一次公式，文字等块刷新闪烁"** + "优化滚动性能"。"第一次"三态未辨（首开即滚冷区 / 预热完成后首过 / 回访重闪，§1 判别）；"文字等块"未指认（段落/图片/代码块/表格未知）。待补：___ 观察版本（关于对话框或安装目录 ProductVersion，预期 ≥5.0.2-beta 才含 R10）；___ 典型文档名与体量；___ 首开即滚还是打开停留后滚；___ 下滚还是上滚更明显；___ 快滚还是慢滚；___ 滚轮还是触摸板；___ 正常还是专注模式；___ 一段症状录屏（E5 观感基线，必采）。

## 0. 基线状态声明（执行第一步必须核实，禁止假设）

本任务书基于 2026-10-19 仓库状态撰写：

- HEAD = `060d677`（chore(release): 5.0.3-beta——HX 导出两症状修复打包版）；工作区有 HX perf 产物未入库（`mditor/perf/hx-*.mjs` 与 `results/ex-hx-repro/density-*`）——记录不动。**执行第一步**：`git status` + `git log --oneline -5`，据实记录 HEAD 相对 `060d677` 的实际状态，报告开头声明。
- **R10 修复已在用户构建内（预期，仍须坐实）**：R10 Fix-A `baebce2`（2026-10-08）/ Fix-A'·Fix-B `91dea9d`（2026-10-09）均为 5.0.2-beta `3660e93`（2026-10-15）与 5.0.3-beta `060d677` 的祖先——**用户安装版只要 ≥5.0.2-beta 即含行内换装修复**。核实手段：安装实例 ProductVersion + CDP 身份门（`window.__mathPumpStats().proactiveSweeps` 字段存在即 Fix-A 在场，dev 与 prod 同验）。若用户版本 <5.0.2-beta，先钉死版本差再定罪（R8 双版本对照流程）——**禁止对着不含 R10 的构建归因本轮症状**。
- npm test 基线：HX 收口 **1089/1089 全绿**（以实跑为准，执行第一步实跑记录确数）。
- fixture 在位性（历轮惯例，整目录 gitignore）：`mditor/perf/fixtures/` 应含 `无穷级数_密度档压测副本.md`（105KB/2,355 行内公式）、`解题技巧_密度档切换副本.md`（60KB/23 个 ```latex 块——**本轮 E1 主战场**）、`一元微分学习题集_1MB压测副本.md`（1,574,112B——P 组主战场）、`无穷级数_唯一公式超限副本.md`（714KB/9,420 唯一）。执行时 `ls perf/fixtures/` 确认。prod 侧主文档 = 用户真实文档（阶段一向用户确认钉死）。
- 生产证据窗口：`%APPDATA%/com.mditor.app/logs/`（打包版）与 dev 卷 `com.mditor.app.dev`；CDP 端口惯例 dev 9223、prod 9224。WebView2 runtime 版本实测登记（R9 教训：自动更新致绝对值漂移）。

## 1. 角色与主战场

你是资深 Web 文本编辑器渲染管线工程师，熟悉 ProseMirror nodeview 生命周期、IntersectionObserver 对 content-visibility 跳过子树的交叉通知滞后（R10 S-g 定罪机制）、rAF 帧预算调度、cv remembered-size 变现语义、CodeMirror/Vue 挂载成本剖面与合成器帧呈现。**本轮性质：双目标——症状 E（观感 bug 收尾，R10 已定罪的块级侧兑现修复 + 两个未建口径的新 front）与症状 P（性能优化，R8 遗留布局墙）。各自独立定罪、独立修复；E 是观感命题，数据门之外必须过用户主观复核（E5）。**

症状钉死（定义，禁止扩大或偷换）：

- **症状 E（首现闪刷）**：cv 档大文档上下滚动时，**第一次**滚到的块——公式（行内/块级）与文字等块——出现可见的刷新/闪烁（渲染/换装/首绘完成时刻元素已与视口相交，R10 S1 口径）。"第一次"三态判别（阶段一必须分清，探针分场景采集）：①**首开即滚冷区**（载入后预热未完成即滚，cvMemory 未学块按 3em 占位 + katexCache 未暖 + 块级未挂）；②**预热完成后首过**（R10 主门口径，行内已修至 1/1/0——若此态仍闪则 R10 有未覆盖形态）；③**回访重闪**（demote/teardown 后重见，R10 已修至 0——复验维持）。区别于：R5 乱闪（残留回弹，已修）、R9 掉帧（帧间隔，内容连续）。
- **症状 P（滚动性能）**：大文档滚动流畅度可优化——1MB cv 档快滚帧 p50 ~205ms（R8 冷区首渲布局墙背景底；R10 收尾复测 209ms 噪声级，帧代价未回归但也未改善）。密度档 p95 ~6ms 与默认档 p50 4.2ms（scroll-abab 基线）无感——**P 组只对 1MB cv 档开优化门，其余档位是防回归门**。

主战场：**解题技巧档**（23 latex 块，E1 块级）、**密度档**（行内首过/泵路径）、**1MB 档**（E2 冷区 + P 组）、**prod 用户真实文档**（复现 prod 优先，R9 教训制度化）。四战场各钉各的，只测一档的结论无效。

范围界定：只管编辑器滚动容器（`div.mditor-editor-host` 及其内容管线）；sv 模式、静态表面、导出路径不在门禁内。正常/专注两模式同测（不对称须记录）。

方法论铁律沿用第三~十轮：先测后改、一次一项、ABAB 交错、证据不成立不动手、达不到假设就回滚（§10）。

## 2. 已查明事实集（直接采用，不要重查；行号经静态核实于 HEAD `060d677`，执行时以仓库实际为准）

### 2.A R10 收尾状态（本轮立论的事实底）

- **行内侧已修（不得重修）**：R10 Fix-A（预测式主动预渲染 `proactiveSweep`，`src/lib/lazyInlineMath.ts:575-620`）+ Fix-A'（wheel/touch 事件内同步微扫 `proactiveSweepSync` :645-710，jump 组同步直绘 `JUMP_SYNC_CAP=48` :643，对称 jumpSpan、插队消费、预测条目跳过几何判定）+ Fix-B（移除 EMA 布局墙 gate）。收尾数字：S1 换装可见 dev 密度档 down-slow/down-fast/revisit 1173/906/103 → **1/1/0**、prod 1795/884/222 → **1/1/0**、1MB 1565→1；S2 已渲染重闪密度档 164→**0**。帧代价 1MB 快滚 p50 205→209ms（噪声级）。
- **S-g 机制（沿承认知，勿重证）**：cv 档 `content-visibility:auto` 跳过视口外块布局 → 块内 nodeview 无布局几何 → IO 交叉计算不报进带（与 rootMargin 无关，io1600 原型 S1 一字不差）→ 块进浏览器预渲染窗（≈视口外 0~400px）被布局后 IO 才派发 → 换装完成落视口内。**块级与行内共用此机制背景；行内的解法是"滚动输入驱动的预测式发现"（不依赖 IO），块级尚无同款路径。**
- **块级 S-a 已定罪未修（本轮 E1 主体）**：块公式（Crepe Latex 特性把 math 改写为 `code_block(language:"LaTeX")`，预览 = KaTeX displayMode）与普通代码块共用 `@milkdown/components` code-block nodeview：占位 = 纯 `<pre><code>` 装源码（`renderPlaceholder`）；共享 IO `rootMargin:"800px 0px 800px 0px"`（`patches/@milkdown+components+7.22.1.patch` 行 10）；进带即 `initializeCodeMirror()`——移除占位 pre → 建 CodeMirror EditorView → 挂 Vue 应用 → KaTeX → DOMPurify → innerHTML，**每块一次同步重活**；离带 `scheduleTeardown()`，`TEARDOWN_DELAY=15e3`（补丁自 5s 调至 15s）。**块级无任何预热**（`src/lib/mathCachePrewarm.ts:26-28` 明确排除——挂载成本大头是 CodeMirror+Vue，KaTeX 是小头）。R10 实锤：dev 解题技巧 down-slow 13 次块挂载（12 latex + 1 code）**全部 vis=true、bucket 8/9、ph→done 单帧跳变**。R10 立项遗留原话："块级主动预挂载原型（限速预挂）另报拍板材料"。
- **demote/revisit 侧已修（复验维持）**：R6 Fix-A/B/C（回带竞态/上滚带安全直绘/IO 校准）+ R7 Fix-A 锁盒占位（渲染态盒宽高双记忆，`renderedBoxes`/`inlineBoxes`）+ R10 Fix-A' 对称 jumpSpan（revisit 反侧遗留带）。修前 1MB 档曾有 demoteVis=19（demote 潮落视口边缘），修后未单列复验——本轮 E4 补。
- **cv 高度侧（S-e 形态）R10 无证据但口径有限**：hdelta>8px 全场景 0——**但那批场景全部预热完成后测**；未学块按 `contain-intrinsic-size: auto 3em` 占位（`src/styles/global.css:1758-1759`）→ 首次变现高度跳的冷区路径（首开即滚）未系统覆盖。R9 F-a 宽度陈旧形态（窗口 resize 后高度表集体陈旧）归档案维持，重开条款见 §6。
- **门禁防回退基线（R9 收尾 + R10 收尾，直接引用）**：R9 F1 对称比 ≤1.25（focus j32=0 ×3 臂 prod）；D1 双臂停滚漂移 0；M1/M2/M3 = 0/0/100%；T1 0/0、T2 peak 10（同批 ABAB 对照）；R1 1MB 打开 4,565ms、R2 打字密度档 112ms/1MB 404ms、R3 切换 2,010ms、R4 vitest（HX 收口 1089）、R5 scroll-abab p95 中位 165/ghost 11/+0/0/R8 上滚对称比 ≤1.25。

### 2.B 症状 E 嫌疑清单（按嫌疑度排序；E-a 已定罪，其余待取证；多候选可并存）

1. **E-a：块级换装可见（S-a，已定罪未修——直接进修复立项+拍板材料，不需再定罪）**。机制与证据见 §2.A。修复方向候选（R10 立项口径，定罪后按证据选，拍板后合入）：①**块级主动预挂载**——复用 Fix-A 的块框几何游标（`proactiveSweep` 的 sweepState/cursor 机制，c-v:auto 块框位置随滚动即时平移、读取不强制子树布局），对预测带内未挂载块提前触发挂载，**限速**（每帧预算/单帧条数上限——CodeMirror+Vue 挂载链是同步重活，R1b 教训：IO 回调里同步渲染整批 = 300-700ms 长任务风暴）；②**两段式挂载**——第一段轻量 KaTeX 预览先行（displayMode renderToString 走 katexCache 直绘 <0.1ms），CodeMirror+Vue 交互编辑器仍按现行 IO 懒挂（挂载形态改动属拍板项，红线 19/22）；③组合（预挂载只做第一段）。上滚侧安全约束沿承 R4-①/R6 Fix-B（视口上方挂载的高度变化会上移视口内容且无 overflow-anchor 补偿——块级占位冻结高度语义见补丁行 39-56，须实测首挂高度差）。
2. **E-b：行内首过冷区（首开即滚，未建口径）**。R10 主门全在预热完成后测；首开即滚时 katexCache 未暖（`mathCachePrewarm` 空闲预热让路滚动，G6 `PREWARM_USER_YIELD_MS=500`）+ cvMemory 未学块 3em 占位 + 块级未挂三态叠加。预测式扫描（Fix-A）只解决"发现时机"，冷算仍受泵 5ms/帧预算与 64 条/帧直绘上限约束——冷区行内可能成片滞留源码态后批量换装。用户"第一次"措辞与此态对齐，阶段二建"首开即滚"场景序列实测。
3. **E-c：文字等块首绘闪烁（未建口径，R10 元素四桶中"其它"未单列报告）**。候选机制（逐一取证，禁止预设）：①未学 cv 块首次变现高度跳（3em→真实高，下方内容位移读作"刷新"——E-b 同环境伴生）；②块内图片懒现（`src/lib/imageLazy.ts`，机制阶段一静态核实）；③首现过渡样式（`global.css:5980-6018` 的 120ms opacity 过渡选择器范围是否波及块级/图片——阶段一核实）；④webfont 首现（冷区滚动进字体未交换区域——录屏判定）；⑤S-a"等元素"外溢（R10 已坐实 1 例普通 code 块同形态——文字段落块是否同闪未知）。**先建"非公式块首绘可见事件"口径（阶段二），再归因。**
4. **E-d：revisit/demote 残余复验**。R10 收尾密度档 S2=0、prod revisit=0；1MB demoteVis 修后未单列——复验不劣化即可，若劣化按 R10 S-d 机制（demote 回退→回访重绘受 S-g 滞后）重查，勿当新发现。
5. **E-e：换装过渡视觉（S-c，R10 暂缓条款）**。仅在 E-a/E-b/E-c 修复后 E1/E2/E3 残余仍高时深挖；任何过渡策略改动须录屏对比 + 用户观感复核（红线 20）。

### 2.C 症状 P 已知事实（性能侧，R8/R10 立论底）

- **P-1 布局墙（R8 定罪，本轮优化对象）**：1MB cv 档快滚帧 p50 ~205ms（R10 收尾 209ms 复测，噪声级未改善）。机制（R8 报告）：冷区（预热未覆盖/被让路中断）块进预渲染窗的首次布局 + 变现高度差连锁。重 fixture 预热 >45s 跑不完（G6 剖面证据，`cvMemory.ts:686-691` 头注：预热批次装饰派发 forChild 8.9-9.2s + takeSpansForNode 7.3-7.7s / 60s 窗）——**滚动用户几乎必然撞冷区**。
- **P-2 P3 提案（预热批渲染态测高，R5 留档、R8/R9 两次呈报待拍板）**：R8 报告 ⑤ 数据——冷区队列膨胀 3,310、每帧 layout 67ms、预期 p95 199→**~130**。**本轮是第三次拍板窗口**：P 组定罪若指向冷区高度表保真度，P3 拍板材料一并呈报（可并案可分案，不得静默夹带，红线）。
- **P-3 已知无效/禁区**：加大泵预算/直绘上限对布局墙无效（那是 KaTeX 侧，布局墙在 cv 变现侧）；默认档急切渲染定案（1MB 无 cv 时滚动 p50 4.2ms 但打开墙不可接受，R1b 教训）；拆 cv 架构/全量急切渲染被红线 21 禁止。

### 2.D 测量设施（现存直接挂靠 + 本轮缺口）

- 现存：`perf/scroll-flash-bench.mjs`（F1 占位残留/十桶 posBuckets/upscroll/roundtrip/longread）、`perf/scroll-abab.mjs`（ABAB 滚动帧）、`perf/profile-scroll.mjs`（长窗剖面）、`perf/tmp-r9/prod-focus-jank.mjs`（prod 全套加固蓝本）、`perf/tmp-r8/probe-jank.mjs`（rAF 逐帧 + 场景控制）、`perf/tmp-r7/probe-drift.mjs`（D1）、`perf/tmp-r6/formula-probe.mjs`（M1 规格）；R10 闪刷探针族（`perf/results/r10-phase2/3/4-*` 产物与口径）。
- 页内观测出口：`window.__mathPumpStats`（含 R10 补点 proactiveSweeps/proactiveActivated/syncNow/syncDefer——**兼作 Fix-A 身份门**）、`window.__scrollDebug`、`cv.relearn` 事件流。
- **缺口一（E-a/E-c）**：code-block nodeview 挂载/拆卸事件流无观测出口——需在 `patches/@milkdown+components+7.22.1.patch` 内只加计数出口（如 `window.__blockMountStats`：挂载开始/完成时刻、占位→完成单帧跳变、拆卸/demote 计数），观测独立 commit（红线 6/9）。R10 的块级定罪数据来自块 DOM 巡视，无事件流——本轮修复验证需要更细粒度。
- **缺口二（E-b/E-c）**："首开即滚"场景（载入后立即驱动滚轮、预热未完成自证：`cvStoreSize()` 覆盖率 + prewarm.yield 计数）与非公式块首绘口径——阶段二新建。
- **缺口三（P）**：1MB 快滚长窗帧序列与冷区变现事件的联合归因（帧 gap × layout:block × 预热游标对齐）——R8 口径复用 + 预热游标观测。
- 单测守卫（不得跳过）：`lazyInlineMath.test.ts`、`cvMemory.test.ts`、`scrollDebug.test.ts`、`viewportAnchor.test.ts`、`md1011-regression.test.ts`、`katexCache.test.ts`、`mathCachePrewarm.test.ts`、`focusKeepwarm.test.ts`、`tableBlockPatch.test.ts`。

## 3. 禁区与待拍板

- **已证伪勿重走**（第三~十轮证伪链 + 各报告负结果留档节）：IO 回调内同步渲染整批（R1b）、加大 IO rootMargin 对 cv-skip 滞后无效（R10 E1 io1600 一字不差）、EMA 帧间隔 gate（R10 Fix-B 定罪纯害）、R9 五条（位置混杂口径禁用、快滚小样本禁判等）、R6 密度档 toDOM 接缓存等三项降本负结果。
- **R4~R10 成果不得破坏**：R5 Fix-A/B/C/D、R6 Fix-A/B/C、R7 Fix-A/B、R9 Fix-A keepwarm、R10 Fix-A/A'/B——改动跑 §2.D 单测守卫全绿且不跳过。
- **拍板项（只出原型数据，用户确认后合入）**：①块级挂载形态（预挂载/两段式/占位样式，红线 19/22）；②P3 提案（§6 第三次呈报窗口）；③换装过渡视觉策略（E-e 条款，红线 20）；④常量默认值（`TEARDOWN_DELAY`/`IO_MARGIN`/`DEMOTE_DELAY`/`SCROLL_*`/`PREWARM_*`/`JUMP_SYNC_CAP` 等一律未拍板不动）。
- 不得以砍观测/砍完整性/关停预热或静止补绘换任何指标归零（M1/M2/M3 硬门，T1/T2 劣化 >10% 即回滚）；不得以"永不拆卸/全量常驻挂载"硬顶内存换零闪刷（R10 红线 19 沿承）；`overflow-anchor` 禁用是定案；四层补偿链与 smoothJump 互斥旗标无归因证据不动。

## 4. 可量化目标（门禁表；判分：E1~E3 与 P1 必须有本机数据，修复类门在证据立项后判定，M/T/D/R 组全部零回归；未达项附归因，不许留空）

### E 组：首现闪刷（症状 E 主门；"换装/首绘可见" = 完成时刻元素已与视口相交，R10 S1 口径沿承）

| # | 指标 | 已知基线 | 目标 | 测量 |
|---|---|---|---|---|
| E1 | 块级换装可见事件（E-a 主门）：块公式/代码块挂载完成时已在视口的计数，分元素类型 × 十桶 | 13/13 全可见（dev 解题技巧 down-slow，R10）；全口径阶段三钉死 | 较基线 **-80% 且解题技巧档 ≤2 次/全程**；M3 挂载率 100% 硬门不得破 | R10 探针复用 + `__blockMountStats` 事件流（§5）；产物 `perf/results/r11-phase3-block-*.json` |
| E2 | 行内首过·首开即滚（E-b）：载入即滚（预热未完成自证）序列的 S1 + 占位可见时长 | 未建口径（阶段三钉死；参照系：预热后 1/1/0） | **≤5 次/全程**（与预热后口径同量级）；未达附归因 | 新建首开即滚场景（§5 缺口二）|
| E3 | 文字等块首绘（E-c）：非公式块（段落/图片/表格/其它）首绘可见/高度跳事件 | 未建口径（阶段二建口径、阶段三填门） | 显著下降（具体目标阶段三填死并写入报告）；S3 hdelta 口径复测预热完成态维持 0 | 新建非公式块首绘口径（§5）|
| E4 | revisit/demote 复验（E-d）：S2 口径 + 1MB demoteVis | R10 收尾密度档 0 / prod 0；demoteVis 未单列 | **维持/不劣化** | R10 revisit 场景复跑 |
| E5 | 观感定性（**用户主观门，R10 S5 未兑现项**）：修复前后分段录屏盲序复核 | 无（R10 留档"待用户执行"） | 用户复核"首过滚动自然度可接受"——未复核不得宣称结题 | 录屏采样 + 用户复核记录入报告 |

### P 组：滚动性能（只对 1MB cv 档开优化门；同批 ABAB 内对照为准）

| # | 指标 | 已知基线 | 目标 | 测量 |
|---|---|---|---|---|
| P1 | 1MB cv 档快滚帧 p50/p95 | p50 ~205-209ms（R8 墙背景底，R10 收尾复测） | 较同批基线 **-25%**（P3 合入路径的预期量级 ~130ms p95）；达不到附归因，不许以 M/T/R 回归换 | `scroll-abab` + 长窗帧序列 × 冷区变现对齐（§5 缺口三）|
| P2 | 密度档 / 默认档滚动帧 | p95 ~6ms / p50 4.2ms | **±10% 内**（同批 ABAB） | `scroll-abab --viewport on/off` |
| P3 | 打开/打字/切换/上滚对称 | R1 4,565ms / R2 112·404ms / R3 2,010ms / R8 ≤1.25 | **零回归**（>10% 且方向一致即回归） | R 组复测口径 |

### M/T/D/R 组：沿承 R10 门禁全表（完整性/及时性/漂移/防回归），全部零回归

M1 滚动遍历+静止 10s 行内源码占位残留 =0；M2 泵队列挂起 =0；M3 块级挂载率 100% / katex-error =0（**E-a 修复的硬门**）；T1 静止补绘拖尾、T2 滚动中占位 peak/durP95 不劣化 >10%（同批对照）；D1 停滚漂移双臂（normal+focus）维持 0；R5 历轮门禁复测（R9 focus 对称比与 j32、ghost、上滚对称比、keepwarm CSS 钉）。测量与阈值沿承 R10 任务书 §4，此处不重列。

## 5. 取证设施与可证伪归因路径

- **取证设施（阶段二新建，只加观测不改行为，独立 commit）**：
  - `__blockMountStats`（patches 内观测出口，§2.D 缺口一）；
  - 首开即滚场景：`--scenario fresh-scroll`（载入 → 预热游标观测自证未完成 → 立即按 down-slow 驱动 → 停滚 2s 窗采集），预热态自证 = `cvStoreSize()` 覆盖率采样 + `__scrollDebug` prewarm.yield/chunk 计数；
  - 非公式块首绘口径（E-c）：每帧 rAF 巡视非公式块首帧"有墨迹"时刻 × 视口相交联合判定 + 块首渲高度差分（沿承 R10 S3 探针机制，选择器排除 `.mditor-math-inline-lazy`/`language-LaTeX`/code_block）；
  - P 组联合归因：1MB 长窗帧序列 × `layout:block` 变现事件 × 预热游标位置三方对齐（R8 口径 + 预热游标补点）。
- **归因判据表**（探针数据直接套用）：
  - E1 修复立项不需要重新定罪（R10 已决）；E-b：首开即滚序列 S1 显著高于预热后序列（数量级差）→ 冷区路径坐实，与预热游标滞留位置对齐；E-c：首绘事件按候选①~⑤分桶——高度差分同帧对齐→①；与 `<img>` 加载完成对齐→②；过渡期内可见→③（transition 原型对照：临时移除，原型不合入跑完恢复）；录屏字体形态→④；与块挂载对齐的"其它"桶→⑤（并 E-a 修复）。
  - P1：帧 gap 峰值与冷区 `layout:block` 变现事件同帧对齐、且预热游标未达该区 → 布局墙坐实（R8 结论复核）→ 修复立项走 P3 拍板或新证路径；若帧 gap 与变现不对齐，按新证据归因（装饰重建/泵/图片解码分桶），不许沿用旧结论。
- **可证伪句子**（每条先写再动手，§10 第 3 步）：
  - E-a-预挂载：若块级换装可见是发现时机问题，则原型把预测式扫描扩展到块级 nodeview（限速 1 块/帧原型开关）后 E1 应显著下降且 T 组帧代价可控；若不降则挂载耗时本身越带（outrun），转向两段式挂载原型。
  - E-a-两段式：若闪源是"占位 pre ↔ 完整挂载"的视觉跳变，则第一段 KaTeX 预览先行原型（不动 CodeMirror 懒挂）下 ph→done 单帧跳变应消除（`__blockMountStats` 口径）；若预览先行仍闪则 S-c 过渡问题升位。
  - E-b：若首过冷区是 katexCache 未暖，则预热完成后同序列复跑 E2 应趋零（对照实验）；若仍高则泵预算/上限是主因（R10 S-b 路径复验）。
  - E-c-①：若文字块闪是未学块变现跳高，则首开即滚（未学）与预热完成（已学）同序列 E3 事件数应差数量级；P3 渲染态测高原型下趋零（P3 只出原型数据请拍板）。
  - P1：见归因判据表（帧 gap × 变现对齐）。
- 复现不了的症状必须产出「为何在此环境不触发」的归因，不许静默跳过；**dev 复现不了时 prod 探针必须跑完才许下结论**（R9 教训制度化）。

## 6. 与历轮遗留案件的交叉声明

- **R10 S5 观感复核未兑现**：本轮 E5 承接——用户 2026-10-19 报障即观感反馈的延续，阶段一必须采到症状录屏（形态学第一手证据 + E5 基线）。
- **R10 立项遗留"块级主动预挂载原型另报拍板材料"**：本轮 E1 主体兑现项——原型数据（限速参数扫描 × 三档实测 × 帧代价）齐后呈报拍板。
- **P3 提案（R5 留档、R8/R9 两次呈报）**：本轮第三次拍板窗口——E-c-① 或 P1 定罪指向高度表保真度时一并呈报（R8 报告 ⑤ 数据），可并案可分案，不得静默夹带。
- **R9 F-a 宽度陈旧归档案**：E-c 含"窗口 resize 后首进视口跳动"形态 → 按 R9 报告 ⑤ 重审条款直接重开，勿当新发现。
- **R8 冷区首渲布局墙 / R6 T1 帧饥饿长尾 / R6 M-f update() 绕泵竞态（未取证）**：P1 归因时按 R10 §6 惯例并案验证；R8 墙是 P1 立论底但**必须本轮数据复核后才可立项修复**。
- **口径声明**：症状 E（首现闪刷）≠ R5 乱闪 ≠ R6 T 及时性 ≠ R9 F 掉帧——机制可同源，交叉数据支持时合并归因，门禁各自记分不得互抵。

## 7. 执行阶段（各自成阶段，顺序推进；凭实测可重排，报告说明理由）

- **阶段一：版本核实 + 形态学定界**。核实用户安装构建（ProductVersion ≥5.0.2-beta + `__mathPumpStats().proactiveSweeps` 身份门）；回填【填写】空位（"第一次"三态判别 / "文字等块"指认 / 方向速度模式设备）；采症状录屏（E5 基线）；生产日志复析定位高发文档与时段（辅助性）。
- **阶段二：复现与探针建设（只加观测不改行为，独立 commit）**。`__blockMountStats` 观测补点 + 首开即滚场景 + 非公式块首绘口径 + P 组联合归因观测；**prod 优先复现**（真实文档 × 场景矩阵：down-slow/down-fast/up-slow/roundtrip/revisit/fresh-scroll × 四战场 × 预热双态），dev 参照；至少一战场捕获非零首现事件才进阶段三。
- **阶段三：基准**。E1~E5 + P1~P3 + M/T/D/R 对照全口径基线（prod/dev 双环境），填死门禁表基线列与 E3 目标值；产物落 `perf/results/r11-phase3-*.json`。
- **阶段四：归因（禁盲改）**。E-b/E-c 按判据表定罪/排除（E-a 已决免定罪）；P1 复核 R8 墙结论并收敛修复路径；产出 `perf/results/r11-phase4-attribution.md`（每条附证据文件与数据）；未定罪不许进修复。
- **阶段五：分批修复（Fix-A/B/C…）**。按定罪排序：E-a 块级（原型参数扫描 → 拍板材料呈报 → 用户确认 → 合入）；E-b/E-c 按定罪；P 组（P3 拍板联动或新证路径）。每项独立 commit（hash+file:line+复杂度+回退开关）、附新增单测、ABAB 交错 ≥3 轮（臂序双向）；拍板项只出原型数据。
- **阶段六：全量门禁 + 打包冒烟 + 用户观感复核 + 报告**。E/P/M/T/D/R 全表复测（prod 为主）+ 重建安装包实机断言（E1 主门 prod 复测 + R9 双断言沿承 + Fix-A 身份门）+ E5 盲序录屏用户复核 + 报告与文档更新（§11）。

## 8. 创新算法条款（若引入新调度/预挂载/预算/补偿机制）

复杂度分析（时间/空间，按视口内条数 n 与全文档 N）+ 三档实测（解题技巧/密度档/1MB/prod 真实文档）+ 原型先行（脚本级/原型开关验证再落地，跑完恢复）+ 降级开关（新策略一键回退旧路径）+ 1,000 次随机编辑差分（新旧行为等价性，渲染结果与最终 scrollTop 逐条比对）+ 挂载形态类改动加录屏帧序列对比（观感等价性证据）+ **限速证明**（块级预挂载：单帧挂载条数上限 × 实测单块挂载耗时的最坏帧预算，不许超 R1b 教训量级）。不满足任一条不合入。

## 9. 红线（编号沿承历轮 1~21 + 本轮增补；1~18 见 R10 任务书 §9 原文，此处列要义与增补）

1. 未经用户拍板不得改常量默认值（含 `TEARDOWN_DELAY`/`IO_MARGIN`/`DEMOTE_DELAY`/`SCROLL_*`/`PREWARM_*`/`JUMP_SYNC_CAP`/`FORWARD_BAND_PX` 等）、不得重引入 bigDocViewportAuto。
2. 已证伪路线勿重走（§3）；默认档急切渲染定案勿改；减配档关公式非本轮靶。
3. KaTeX 0.18.4 单实例钉住不动；不引入新渲染引擎；`mathConfig.ts` 宏语义不动。
4. R4~R10 全部 Fix 不得破坏（§2.D 单测守卫全绿不跳过）。
5. node_modules 改动只走 `patches/`，补丁最小化、可解释、有移除路径（patches/README 红线）。
6. 每优化 commit 前 `npm test`；收尾 `test:coverage` + `lint` + `build`。
7. 先测后改六步（§10）；一次一项；ABAB ≥3 轮；达不到假设就回滚。
8. 观测补点与行为修复分开 commit。
9. perf 硬清理只杀自 spawn 的 PID 树（`taskkill /IM` 误杀教训）；tmp 脚本入 `perf/tmp-r11/` 并头注。
10. 不改测量口径；fixture 只许改生成参数不许改测量逻辑。
11. 四层补偿链与 smoothJump 互斥旗标无归因证据不动；anchor-comp 兜底层不得无证据拆除。
12. 不得以关停预热/静止补绘/砍完整性或及时性换任何指标——M1/M2/M3 硬门，T1/T2 劣化 >10% 即回滚；D1 双臂 0 硬底。
13. 专注模式视觉与 keepwarm 机制不动；不得把正常模式改坏拉平对称性。
14. 高度表宽度失效策略不得引发全量重预热（1MB ~45s 预热主线程墙前案直接否决）。
15. **（沿承 19）块级挂载/拆卸策略属拍板项**：只出原型数据，M3 挂载率 100% 硬门，不得以"永不拆卸/全量常驻"硬顶内存换零闪刷。
16. **（沿承 20/21）换装过渡视觉策略改动须录屏对比 + 用户观感复核；不得拆 cv 档懒渲染架构或全量急切渲染换零闪刷/帧率**——修复方向是把换装/首绘移出可视区，不是取消懒加载。
17. **（本轮增补）块级预挂载必须限速**：单帧条数上限 + 帧预算（同步挂载链是重活），最坏帧预算入 §8 创新条款证明；不得在 IO 回调/wheel 事件里同步挂载整带（R1b 长任务风暴教训）。
18. **（本轮增补）首开即滚优化不得以砍 G6 让路（预热与滚动交错是定案）或砍预热覆盖率换 E2 指标**；预热常量未拍板不动。
19. **（本轮增补）P3 提案不得静默夹带**——只随拍板材料呈报，用户确认后才合入。

## 10. 先测后改六步（每个修复项逐一过）

1. 基线：改动前跑该门禁指标 ≥2 轮取中位；2. 定位：探针/观测数据指到具体代码路径（file:line）；3. 可证伪假设：写成"若改 X 则指标 Y 应变化 Z%"的句子；4. 单项改动：只改这一处，commit 独立；5. ABAB 交错：改动/基线 A/B/B/A ≥3 轮，方向一致才算数；6. 保留或回滚：达标保留并记录，不达标回滚并留档（负结果同样写入报告，防重走）。

## 11. 交付物

- 报告 `mditor/docs/large-doc-reveal-flicker-scroll-perf-report.md`，六节体例：①基线声明（HEAD/环境/用户构建与身份门核实/录屏与【填写】回填/fixture）；②归因结论（E-b/E-c 定罪排除表 + "第一次"三态分布 + 元素类型分布 + P1 布局墙复核结论，附证据与探针产物路径；E-a 引 R10 定罪免重述）；③改动清单（每项 commit hash + file:line + 复杂度 + 回退开关）；④门禁全表（E/P/M/T/D/R 逐行基线→结果，未达项附归因不许留空）；⑤遗留与放弃（含 P3 拍板联动结论、块级拍板结论、负结果留档）；⑥文档更新清单。
- 文档同步：`mditor/docs/performance.md`（第十一轮节）、`mditor/docs/dev-anomaly-codes.md`（若新增观测口径登记）、`mditor/CHANGELOG.md` Unreleased 节、memory 日记更新。
- 测量产物：`perf/results/r11-*.json`（tag 命名 `r11-phase<N>-<block|fresh|text|perf>-<dev|prod>-<场景>-<fixture|other>-<n>`）；`perf/tmp-r11/` 一次性探针（头注"不入库"惯例）；E5 录屏证据归档路径写入报告。
- 发版：本轮不发版；发版节奏由用户另行决定。
