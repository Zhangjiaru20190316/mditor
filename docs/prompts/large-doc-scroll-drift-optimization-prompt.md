# 任务：mditor 大文档滚动稳定性第七轮治理——滚动停止后页面自我漂移专项

> 使用方式：本任务书配套 `/goal` 命令交付（目标文本见下方代码块，直接粘贴）。前端代码在 `mditor/` 子目录，所有 `perf/` 与 `npm` 命令在 `mditor/` 下运行。核心环节分阶段推进（§7），每阶段证据落盘（`perf/results/` 与报告草稿）并自查后才进下一阶段，禁止把归因与修复混在同一批。动手前必读第 0、1、2、3、9 节——本任务禁止盲改，禁止重修已修问题，禁止预设根因结论。
>
> ```text
> /goal 修复 mditor 大文档滚动停止后页面自我漂移（第七轮专项，范围：静止期行内公式补渲染的高度位移与 anchor-comp/prewarm-comp 补偿时序、cvMemory 预热上探补偿、打字机延迟居中；滚动流畅度已达标，为本轮不可回退前提）。任务书：docs/prompts/large-doc-scroll-drift-optimization-prompt.md——先通读全文并遵守 §0 基线核实、§2 已查明事实集不重查、§3 禁区与红线，在 mditor/ 子目录下按 §7 阶段顺序执行，禁止盲改、禁止重修已修问题、禁止重走已证伪路线。完成判据（全部满足才 pass）：① 漂移归零——大文档滚动停止后 10s 观察窗内（r7 探针 rAF 级采样）视口内容位移 >4px 的帧数为 0、无用户输入下程序化 scrollTop 写入与 MD-1001/1002 触发均为 0（密度档与 1MB 档双测、深滚含上滚场景）；② 完整性及时性不回退——R6 门禁维持：公式漏渲染残留 0、泵队列饥饿 0、块级挂载率 100%、静止补绘 p95 与 scroll-flash-bench F 组（占位残留/闪变/MD-1001/1002/1011）不劣化 >10%；③ 零回归——npm test 全绿（≥978 基线，以实跑为准），1MB 打开/打字/切换基准零回归；④ 交付——报告落盘 mditor/docs/large-doc-scroll-drift-report.md，每个修复项独立 Fix-X commit 且附新增测试，CHANGELOG Unreleased 与 memory 日记更新。红线：KaTeX 0.18.4 单实例与宏语义不动；R5/R6 全部 Fix 不得破坏；不得以关停静止补绘或砍公式完整性换取漂移归零；overflow-anchor 维持禁用，四层补偿链无归因证据不得整体拆除，只可消除其触发必要性或同帧同步化；观测与修复分开 commit；每 commit 前 npm test；先测后改六步。
> ```
>
> 前序任务书引用链（体例连续，背景可查）：`docs/prompts/large-doc-perf-optimization-prompt.md`（第三轮，已结题）、`docs/prompts/large-doc-perf-motion-optimization-prompt.md`（第四轮，已结题）、`docs/prompts/large-doc-scroll-stability-optimization-prompt.md`（第五轮滚动稳定性，已结题——本轮与其 J 症状族同源，§6 交叉声明）、`docs/prompts/large-doc-formula-render-optimization-prompt.md`（第六轮公式渲染，已结题——本轮不得回退其 M/T 门禁）。
>
> 【填写】观察环境（待用户确认）：症状在"最新版本"观察到——注意 main 分支 HEAD 已含第六轮 Fix-A/B/C（**未发版**），而打包版现卷 v5.0.0-beta **不含** R6 修复；阶段一必须先钉死症状来源版本（dev/main 还是打包 beta），两版本漂移形态可能不同。主战场文档（已预填，用户确认）：公式密集中型文档（密度档画像：约 105K 字符/2,355 行内公式）+ 1MB 超长文档。症状钉死：**症状 D——滚动停止后页面自我漂移**（定义见 §1，禁止扩大或偷换）。症状补充（漂移是阶梯式一格一格还是一次性跳变/持续多久/上滚还是下滚更明显/是否伴随公式补绘出现）：___。复现线索（快速长滚还是慢滚/停稳后多久开始/打字机模式是否开启）：___。

## 0. 基线状态声明（执行第一步必须核实，禁止假设）

本任务书基于 2026-10-02 仓库状态撰写：

- HEAD = `9e0e4e9`（chore(perf): 第六轮任务书与 R5/R6 探针脚本入库——R6 已结题未发版）；撰写时工作区有未跟踪杂物（`mditor/nul`、`nul`、`mditor/perf/results/r6-prod-smoke.png`），不影响本任务。
- **执行第一步**：`git status` + `git log --oneline -5`，据实记录 HEAD 相对 `9e0e4e9` 的实际状态（其后是否有新提交/未提交改动），报告开头声明；后续一切论述以核实后的代码为准。
- **症状来源版本核实**（本轮特有，先于一切测量）：确认用户观察漂移的实例是 dev/main（含 R6 Fix-A/B/C）还是打包版 v5.0.0-beta（不含）。若为打包版，须先在 dev/main 复测同样序列——漂移可能已被 R6 Fix-A（demote 顺延链根治）部分收敛，剩余形态才是本轮靶；两版本对照结论写入报告 §1。
- fixture 在位性（撰写日本机核实惯例）：`mditor/perf/fixtures/` 含 `无穷级数_密度档压测副本.md`（约 105K 字符/2,159 行/2,355 行内公式）、`解题技巧_密度档切换副本.md`（约 60KB UTF-8≈35K 字符/778 公式）、`一元微分学习题集_1MB压测副本.md`——整目录 gitignore（本地化惯例）。执行时先 `ls perf/fixtures/` 确认，缺失则按第四轮报告 §2 重建规格从 `E:/笔记/cmc` 源复制。M 组复测若需 >8,192 唯一公式超限档（9,420 唯一 fixture），按 `perf/tmp-r6/gen-unqlimit.mjs` 头注规格重建（tmp 目录一次性，可能已清理）。
- 生产证据窗口：`%APPDATA%/com.mditor.app/logs/` 现卷为 v5.0.0-beta；dev 实例日志卷 `com.mditor.app.dev`（CDP 9223 惯例；打包冒烟避让 9222 用 9224——R6 惯例）。注意 R6 观测补点（`__mathPumpStats` 等）已随 `6e4334f` 在 main，但**未进打包版**。
- npm test 基线：R6 收尾 978 全绿（以实跑为准，执行第一步实跑 `npm test` 记录确数）。

## 1. 角色与主战场

你是资深 Web 文本编辑器滚动与布局稳定性工程师，熟悉滚动锚定（scroll anchoring）语义、content-visibility 高度二象性、rAF 帧预算与布局写入时序（同帧提交 vs 跨帧可见窗）、IntersectionObserver 调度与 ProseMirror/Codemirror nodeview 生命周期。**本轮性质：不是再猜一轮优化，而是「复现 → 建立测得出问题的基准 → 归因 → 修复 → 数据证明」。**

症状钉死（定义，禁止扩大或偷换）：

**症状 D（停滚自漂移）**：用户滚动（滚轮/触摸板）停止且静止门（400ms，与泵/打字机同口径）生效后，**无任何用户输入**的情况下，页面视口内容自行位移或滚动。已知定性形态：持续数秒的阶梯式"一格一格自己动"（每格 ≈ 一批异步渲染 + 一次补偿写入），或静止后一次性可见跳变。区别于：①滚动惯性（紧随松手的减速，400ms 内收敛，不算漂移）；②R5 J-α（开档/切标签 +32s 未打标整千跳变，无滚动前置）；③R5 J-β/J-γ（大纲/链接跳转后的落点漂移）。与 ②③ 同族但触发序列不同，交叉声明见 §6。

用户前提（本轮立论基础）：**大文档滚动流畅度已达标**（R4-R6 成果），本轮一切改动不得以牺牲流畅度换取漂移归零。

主战场双档：**公式密集中型文档**（密度档，cv 档旁路 `BIG_DOC_MATH_DOLLARS=800` 生效，行内懒渲染开——漂移与补绘耦合最深）+ **1MB 超长文档**（isBigDocCv 生效，叠加 cvMemory 预热补偿路径）。两战场各钉各的，只测一档的结论无效。

范围界定：本轮只管**编辑器滚动容器**（`div.mditor-editor-host` 及其内容管线）的静止期位移；跳转落点精度（outline-jump/anno-jump）、多窗口迁移恢复不在门禁内，除非日志证据直接指向（若涉入须在报告说明并经用户确认扩项）。

方法论铁律沿用第三~六轮：**先测后改、一次一项、ABAB 交错、证据不成立不动手、达不到假设就回滚**（§10）。

## 2. 已查明事实集（直接采用，不要重查；行号经静态核实，以仓库实际为准）

### 2.A 补偿与锚定体系速览（四层补偿链，R6 红线 12 保护对象）

- **第 0 层（前置）**：`src/styles/global.css` 滚动容器（`:1303` host）与代码块 scroller（`:1494`）**显式 `overflow-anchor: none`**——历史教训定案（Chromium 滚动锚定曾把局部位移放大成视口来回跳），不得重开。
- **第 1 层**：`src/lib/viewportAnchor.ts` 锚块指纹（文本前 64 字 + 索引 ±32 扫描，:126-128），用于切标签/重建恢复，不参与滚动中。
- **第 2 层**：`src/lib/cvMemory.ts` 预热补偿 `prewarm-comp`——up 阶段视口上方块变现后按高度差 `host.scrollTop += comp`（:949-963，限幅 ±8000px，常量 :583）。
- **第 3 层（兜底）**：`src/lib/scrollDebug.ts` anchor-comp——静止帧哨兵位移两帧确认（阈值 SHIFT_CONFIRM_MIN=4px，常量 :663-666）后 `host.scrollTop += comp`（:1341-1381，限幅 ±8000px，打点 `write:anchor-comp`；仅 data-big；smoothJump 动画中绝不补偿 :1370-1373）。**它本身是一次程序化滚动**，且只在静止帧动作——「滚动停止后」正是它的活跃窗口。
- 归因基建：scrollDebug `stepSession`（:374-454）把每段滚动归因 user / write:<tag> / clamp / ghost；写入陷阱 writeTrap（:571-629）钩住 `scrollTop` setter/`scrollIntoView`/`scrollTo`，ghost 事件附未打标写入调用栈；恢复梯子插队观测 `OVERLAP_INTRUDERS = {anchor-comp, typewriter, prewarm-comp}`（:475）——项目已自认这三个写入方会互相竞争。出口 `window.__scrollDebug()`（recent/counters）。
- CSS 虚拟化：`global.css:1731-1734` `[data-big] .ProseMirror > *` `content-visibility: auto; contain-intrinsic-size: auto 3em`——占位/变现高度差是位移源之一（cvMemory 三层高度回填：空闲预热 `startCvPrewarm`、视口学习 `learnVisibleSizes`、会话表，详见 R5 报告）。

### 2.B 症状 D 候选源（禁止预设主犯，逐一取证）

1. **D-a（证据链最完整）：静止补绘上方冷公式 → 内容位移 → anchor-comp 阶梯补偿 = 可见自滚**。
   - 渲染泵静止路径：wheel/touch/key 停止 `SCROLL_QUIET_MS=400` 后，每帧 10ms 预算 **FIFO 全量补渲染，不分视口上下**（`lazyInlineMath.ts:438-444`）。
   - 上滚冷条目被刻意留队：滚动中上滚 band 只放行「有渲染态高度预留 && 缓存命中」直绘（R6 Fix-B，:403-421）；**无预留冷条目唯一的兑现时机就是静止补绘**——它们位于视口上方，首渲改变行高（占位无 minHeight，`hasReservedHeight()` 为 false，:159, 604-605）。
   - overflow-anchor 已禁用（2.A 第 0 层）→ 无浏览器锚定兜底 → 视口上方内容位移直接体现为视口内容上移。
   - anchor-comp 两帧确认后补偿（2.A 第 3 层）→ 补偿本身是一次 scrollTop 写入，用户看到"松手 → 400ms 后页面一格一格自己动"。
   - **互喂放大**：泵静止门只监听 wheel/touchmove/keydown（:251-256，刻意不监听 scroll——程序化 scrollTop 写入不算用户滚动）→ anchor-comp 的补偿写入**不重置静止门** → 补绘继续 → 补偿继续，形成持续数秒的慢漂移。
   - 高度记忆边界：`renderedHeights` 仅在 demote 时量 rect（:567-569）；会话表 `inlineHeights` cap 8,192（:469-487），唯一公式超限被 LRU 逐出后占位无预留，回带首渲仍有行高差。
2. **D-b：cvMemory 预热 up 阶段恢复推进 + prewarm-comp 跨帧空窗**。预热让路窗仅最后输入后 500ms（`PREWARM_USER_YIELD_MS`，:709-711, 848-851）——用户一停预热立即恢复；up 阶段对视口上方块逐批强制 `content-visibility: visible` 变现（:878-911，每批先记旧高），**dispatch 与补偿之间隔双 rAF**——存在一帧以上可见位移窗口；补偿限幅 ±8000px，超限残差再喂给 anchor-comp（又一次自滚）。仅限打开后预热未完成期间（覆盖率 ≥95% 有快路径跳过，:749-755）；配套链：视口学习→350ms 防抖分片重建装饰→`contain-intrinsic-size` 数值更新→scrollHeight 变化（:256-287, 481-489）。
3. **D-c：打字机模式延迟居中**（仅设置开启时）。`src/components/Editor.tsx:573-621`：唯一门是 host scroll 事件后 400ms 静止（:582）；任何更晚到达的 selectionchange（选区回同步/focus 恢复/AI 写入）都触发 `centerCaret` 写 `host.scrollTop += delta`（:606-607）——头注 :566-572 自认这是"页面自己动"历史主源。sv 模式同构（`svCodeMirror.ts:162-172` selectionSet → 居中）。
4. **D-d：无补偿裸漂移源**（ghost 位移帧无 write 归因时的取证对象）：①代码块首次挂载 placeholder `<pre>` ↔ CodeMirror 高度差（`patches/@milkdown+components+7.22.1.patch` 冻结高度只护拆除侧；IO 带宽 800px 上滚时上方块进带挂载）；②首见图片无 aspect-ratio 一步跳高（`src/lib/imageLazy.ts:14-16` 自述，:60-74 仅已知 src 盖比例）；③webfont `loadingdone` 全文换行重排（scrollDebug `font:loaded` 探针 :949-964）；④批注盖章段落 `display:inline` 行内化（`src/hooks/useAnnotationMarkers.ts:73-77`，R5 已点名 layout:shift 候选）；⑤demote 降级回占位（DEMOTE_DELAY 2500ms 且静止时才执行，:615-630）在高度记忆缺失时的行高差。

### 2.C 版本状态与生产证据

- R6 结题（`mditor/docs/large-doc-formula-render-report.md`）：**MD-1002×3 = 深滚公式补绘高度位移、compensated 全兜住**（文档"题型方法决策树" 122KB）——即"滚动停止后公式补绘引发位移"在生产已被观测到，目前靠补偿链兜住；兜住 = scrollTop 在动 = 用户感知的"自己滚"。本轮症状与该形态直接同族。
- R6 门禁收尾值（本轮防回退基线）：M1 残留 0（三档）、M2 饥饿 0、M3 挂载率 100%（23/23）/katex-error 0、T1 静止补绘 p50 457→340ms（-26%）、T2 上滚尖峰 21→11、R 组：1MB 打开 13,181ms、打字 704/424ms（密度档/1MB g2 口径）、切换 2,254ms、npm test 978 全绿（970→978）、MD-1001/1002/1011 零复发。
- R6 T1 未达项背景（p95 -13% vs 目标 -75%）：帧间隔 p95 3.5-4.4s 支配，归因 1MB cv 档滚动布局墙（第四轮封案）+ REC 采样器测量放大——**该布局墙同样可能是 D-a 位移帧节奏的支配项**，本轮探针数据可与 R6 pump-trace 交叉。
- R5 遗留（`mditor/docs/large-doc-scroll-stability-report.md`）：J-1 已定罪修复（anchor-comp 于 tab-restore 后确定性回拽 -217px）；**J-α''（开档 +32s 未打标整千跳变）dev 六轮未复现、未定罪**——写入陷阱已就位待栈（§6）；**高度二象性残余**（占位 81px vs 渲染 40px，~450ms 瞬态）对应 §5.2 P3 提案（§3）。

### 2.D 测量设施（现存直接挂靠）

- 页内观测出口：`window.__scrollDebug()`（recent 逐段归因 / counters：含 `anchor.comp` 计数）、`window.__mathPumpStats()`（R6 `6e4334f`：队列深度/quietFrames/直绘与冷算等）——两者时间对齐即可判「补绘先行还是补偿先行」。
- 基准：`perf/scroll-flash-bench.mjs`（R6 `144c0c2` 已扩 wheel ≤450ms **scrollPhase/quietPhase 分窗**——quietPhase 窗即本轮漂移观察窗，直接复用）；`perf/scroll-abab.mjs`（ABAB 交错 + DOM 签名自证）；`perf/ghost-stress.mjs`（MD-1001/1002/1011 压测）；`perf/cdp.mjs`（滚轮驱动/rAF 帧间隔/longtask）。
- 探针蓝本：`perf/tmp-r5/probe-j.mjs:291` `watch(25, "open-drift")` 紧密采样模式——本轮改造为停滚漂移探针（§5）；R6 挂靠编排器 `perf/tmp-r6/with-dev.mjs` 模式（tmp 目录一次性，若已清理按头注重建）。
- 单测守卫（不得跳过）：`scrollDebug.test.ts`、`lazyInlineMath.test.ts`（R6 含泵统计用例）、`cvMemory.test.ts`、`viewportAnchor.test.ts`、`md1011-regression.test.ts`、`katexCache.test.ts`、`mathCachePrewarm.test.ts`。
- 生产日志与异常码表：`mditor/docs/dev-anomaly-codes.md`（MD-1001 ghost/1002 视口位移 >24px/1011）。

## 3. 禁区与待拍板

- **已证伪勿重查**（第三~六轮证伪链 + CHANGELOG）：katexCache 挂 toDOM、docCache 阈值下调、分帧挂载、密度档 toDOM 接缓存三项、默认档急切渲染关闭定案（lazyInlineMath 头注 :9-13）。
- **R5/R6 成果不得破坏**：R5 Fix-A/B/C/D（cvMemory 内容寻址重放、会话表、预热只学冷块、webfont 门控）；R6 Fix-A（demote 顺延链根治）/Fix-B（上滚带预留直绘）/Fix-C（demote 后 IO 重挂观察）——任何改动跑 `md1011-regression.test.ts` + `cvMemory.test.ts` + `lazyInlineMath.test.ts` 全绿。
- **overflow-anchor 禁用是定案**（global.css :1303/:1494 历史教训注释）——不得以"重开浏览器锚定"作为漂移修复方案。
- **四层补偿链无归因证据不整体拆除**（R6 红线 12 沿承）；anchor-comp 是兜底层，修复方向限于：消除其触发必要性（高度中性渲染）或同帧同步化（位移与补偿同一帧提交，用户不可见），且必须附探针前后对照数据。
- **待拍板提案（本轮升为立项候选，仍须原型先行）**：R5 §5.2 P3——预热批测量时从 katexCache 渲染公式，使 cvMemory/lazyInlineMath 学得的高度恒为渲染态，根治 81px↔40px 高度二象性 ~450ms 瞬态。它与 D-a 的"无预留冷条目"同源：P3 原型数据即是 D-a 修复方向之一的可行性证明。原型须按 §8 条款出数据，合入前在报告单列请用户确认。
- 未经用户拍板不得改默认值（SCROLL_QUIET_MS/PREWARM_USER_YIELD_MS/DEMOTE_DELAY 等常量）、不得重引入 bigDocViewportAuto、不得改档位开合逻辑。

## 4. 可量化目标（门禁表；判分：D1/D2 与 M 组必须有本机数据，修复类门在证据立项后判定，T/R 组全部零回归；未达项附归因，不许留空）

### D 组：漂移（症状 D，本轮主门）

| # | 指标 | 已知基线 | 目标 | 测量 |
|---|---|---|---|---|
| D1 | 停滚漂移主门：滚动停止（wheel 结束 + 400ms 静止门生效）起 10s 观察窗内：①视口哨兵 rect 位移 >4px 的 rAF 采样帧数；②无用户输入下程序化 scrollTop 写入次数（`__scrollDebug` write:* 归因）；③MD-1001/1002 触发数 | 无独立口径（R6 MD-1002×3 为生产形态，R5 J 组为跳转族）——阶段三以 r7 探针钉死 | 三项全部 **= 0**（密度档与 1MB 档双测；深滚下滚 + 上滚两场景；快速长滚与慢滚各至少一轮） | 新建停滚漂移探针（§5，入 `perf/tmp-r7/` 头注不入库）；产物 `perf/results/r7-phase3-drift-<场景>-<fixture>-<n>.json` |
| D2 | 静止期补偿计数（报告项，非硬门）：10s 窗内 anchor-comp / prewarm-comp 触发次数与补偿总量 | 同上阶段三钉死 | 高度中性路线下应趋 0；若走同帧同步化路线允许非零，但 D1 位移帧必须为 0——两条路线判定写入报告 | 同 D1（counters 差分：`anchor.comp` / `write:prewarm-comp`） |

### M 组：完整性（沿承 R6 硬门——禁止砍完整性换零漂移）

| # | 指标 | 已知基线（R6 收尾） | 目标 | 测量 |
|---|---|---|---|---|
| M1 | 滚动遍历往返 + 静止 10s 后行内公式源码占位残留 | 0（三档） | **维持 0** | R6 探针口径（`perf/tmp-r6/formula-probe.mjs` 规格，可重建） |
| M2 | 会话后 10s 泵队列挂起条目 | 0 | **维持 0** | `window.__mathPumpStats` |
| M3 | 视口内块级公式挂载率 / katex-error | 100% / 0 | **维持 100% / 0** | R6 块公式挂载探针口径 |

### T 组：及时性（不劣化 >10%，阶段三复测钉死本轮基线）

| # | 指标 | 已知基线（R6 收尾） | 目标 | 测量 |
|---|---|---|---|---|
| T1 | 静止补绘拖尾 p95（视口内公式全部 ready） | p50 340ms；p95 较 R5 基线 -13%（R6 口径） | 不劣化 >10%（若漂移修复使补绘更晚/更慢即回滚） | `node perf/scroll-flash-bench.mjs` quietPhase 窗 |
| T2 | 滚动中视口源码占位峰值 | 上滚尖峰 11（21→11） | 不劣化 >10% | 同上 scrollPhase 窗 |

### R 组：防回归（全部零回归；基线为 R6 收尾同机，环境差异须声明）

| # | 指标 | 已知基线 | 测量 |
|---|---|---|---|
| R1 | 1MB 打开 | 13,181ms | `MDITOR_DOC=1MB node perf/open-1mb.mjs 3 <tag>` |
| R2 | 打字 p95 | 密度档 704ms / 1MB g2 424ms | `MDITOR_DOC=无穷级数_密度档 MDITOR_MIN_BLOCKS=500 node perf/g2-typing.mjs <tag>`；1MB 档同法 |
| R3 | 切换中位 | 2,254ms | `node perf/switch-bench.mjs --doc-a 无穷级数_密度档 --doc-b 解题技巧_密度档 --viewport off --switches 20 --tag <t>` |
| R4 | 全量守卫 | vitest 978（以实跑为准） | `npm test`（每优化 commit 前）；收尾 `npm run test:coverage` + `npm run lint` + `npm run build` |
| R5 | 历轮门禁复测：占位残留/DOM 签名/MD-1001/1002/1011 | R6 收尾零复发 | `scroll-flash-bench` + `scroll-abab --viewport on --round 3 --duration 60` + `ghost-stress --minutes 5` + `md1011-verify` |

回归判定阈值沿用历轮：**劣化 >10% 且多轮方向一致才算回归**。

## 5. 症状 D：取证设施与可证伪归因路径

- **取证设施（阶段二新建，只加观测不改行为，独立 commit）**：
  - 停滚漂移探针 `perf/tmp-r7/probe-drift.mjs`：with-dev 挂靠 → 打开 fixture → 等首屏稳定（或按场景等预热完成/未完成两种前置）→ CDP 滚轮驱动深滚（下滚/上滚 × 快速长滚/慢滚）→ **停止输入后 10s rAF 级采样**：每帧 host.scrollTop、视口顶哨兵块 rect、`__scrollDebug().recent()` 差分与 counters、`__mathPumpStats` 差分 → 输出 jsonl（位移帧列表 + 每帧归因 tag + 计数汇总）。tag 命名 `r7-phase<N>-drift-<场景>-<fixture>-<n>`。蓝本：`perf/tmp-r5/probe-j.mjs` watch 紧密采样。
  - 若需 writeTrap 调用栈落盘（D-d 取证），探针同时抓 ghost 事件附带的栈并写入产物。
- **归因判据表**（探针数据直接套用）：
  - 位移帧/写入归因 `write:anchor-comp`，且 `__mathPumpStats` quiet 渲染计数先行、位移量与补绘条目行高差之和吻合 → **D-a 定罪**。
  - `write:prewarm-comp`，且仅出现在打开后预热未完成期间、等预热完成后同序列不复现 → **D-b 定罪**。
  - `write:typewriter`，且仅打字机设置开启时出现、关闭后同序列零漂移 → **D-c 定罪**。
  - 位移帧 ghost 且无任何 write:* 记录（writeTrap 亦无栈）→ **D-d**：按五项裸源二分隔离（禁图重放/等 webfont 后重放/批注关停对照）。
- **可证伪句子**（每条先写再动手，§10 第 3 步；证据不成立换下一候选，不许并行改多个）：
  - D-a：若漂移 = 静止补绘上方冷公式 + anchor-comp 阶梯补偿，则漂移帧全部晚于静止门生效时刻 ≥1 帧、write 归因集中 anchor-comp、且把静止补绘临时限制为「视口下方或带高度预留」（原型开关，不合入）后漂移帧归零——若限制后仍漂移则 D-a 排除。
  - D-b：若漂移 = 预热 up 补偿空窗，则漂移只发生在预热进行中的会话前段，且 dispatch 时刻与 prewarm-comp 写入时刻之间存在 ≥1 帧的哨兵位移（探针时间轴可直接读出）。
  - D-c：若漂移 = 打字机延迟居中，则漂移帧与 selectionchange 事件时间戳对齐（±1 帧），且仅开设置时出现。
  - D-d：若为裸源，则位移帧与对应异步事件（img load / font loadingdone / IO 挂载 / 批注盖章）时间戳对齐，write 归因全空。
  - 多候选可并存（阶梯漂移叠加一次性跳变）：按计数占比排修复优先级，但每项修复独立过六步。
  - 复现不了的症状必须产出「为何在此环境不触发」的归因（dev 与打包版构建/缓存/R6 修复未进 beta 等差异），不许静默跳过。

## 6. 与 R5 遗留案件的交叉声明

- **J-α''（生产 +32s 未打标整千跳变，未定罪）**：与症状 D 的区别是无滚动前置、延迟更长。本轮阶段一生产日志复析若再次捕获，writeTrap 栈可直接定罪——若定罪结果与 D 组同源（如 D-d 裸源），并入本轮修复；若异源，单独留档不改判，报告说明。
- **高度二象性 P3（81px↔40px，~450ms 瞬态）**：D-a 的"无预留冷条目首渲改行高"就是二象性的滚动形态。本轮 D-a 若定罪，P3 原型数据（预热批从 katexCache 渲染测高）即为首选修复方向之一，按 §3/§8 执行。
- **R5 J-β/J-γ（跳转落点漂移）**：已修复（J-1）+ smoothJump 互斥旗标保护；本轮不重开，除非 D 组修复波及其行为（波及须附差分）。

## 7. 执行阶段（各自成阶段，顺序推进；凭实测可重排，报告说明理由）

沿用第五/六轮：直接执行、阶段门禁自查后才进下一阶段。

- **阶段一：版本核实 + 生产日志复析（先于一切）**。按 §0 钉死症状来源版本（dev/main vs 打包 beta，必要时双版本对照复测）；现卷按文档/档位聚合 MD-1001/1002 与 ghost 条目，确认漂移发生的档位、时间分布（相对滚动停止的延迟）、操作上下文；产出「症状-文档-档位-版本对照表」。
- **阶段二：复现与探针建设**。新建停滚漂移探针（只加观测不改行为，独立 commit）；dev 实例复现症状 D 各形态（下滚/上滚 × 快/慢滚 × 密度档/1MB）至少各一例，探针捕获到非零位移帧或补偿计数才进阶段三；复现不了按 §5 归因说明。
- **阶段三：基准**。跑 D1/D2 全口径基线（含 M/T/R 对照臂），填死门禁表基线列；产物落 `perf/results/r7-phase3-*.json`。
- **阶段四：归因（禁盲改）**。按 §5 归因判据表逐候选定罪/排除，产出归因结论（每条附证据文件与数据）；未定罪不许进修复。
- **阶段五：分批修复（Fix-A/B/C…）**。按定罪排序分批，每项独立 commit（hash+file:line+复杂度+回退开关）、附新增单测、ABAB 交错 A/B/B/A ≥3 轮；P3 类拍板项（§3）只出原型数据请用户确认后合入。
- **阶段六：全量门禁 + 报告**。D/M/T/R 全表复测 + 打包冒烟（`prod-smoke` 模式：CDP 端口避让 9222 用 9224、typeText 不可靠教训——用打开+滚动+停滚观察断言）+ 报告与文档更新（§11）。

## 8. 创新算法条款（若引入新调度/补偿/高度记忆机制）

复杂度分析（时间/空间，按视口内条数 n 与全文档 N 表达）+ 三规模档实测（密度档/1MB/超限 fixture）+ 原型先行（脚本级验证再落地）+ 降级开关（新策略可一键回退旧路径）+ 1,000 次随机编辑差分（新旧行为等价性，渲染结果与最终 scrollTop 逐条比对）。不满足任一条不合入。

## 9. 红线（编号沿承历轮 + 本轮增补）

1. 未经用户拍板不得改默认值（含 SCROLL_QUIET_MS/PREWARM_USER_YIELD_MS/DEMOTE_DELAY 等常量）、不得重引入 bigDocViewportAuto。
2. 已证伪路线勿重走（§3 证伪链）。
3. 默认档（非 cv 档）急切渲染定案勿改；减配档关公式是既有决策，非本轮靶。
4. KaTeX 0.18.4 单实例钉住不动（package.json overrides）；不引入新渲染引擎；`src/lib/mathConfig.ts` 宏语义与单一来源不动。
5. R5 Fix-A/B/C/D、R6 Fix-A/B/C 不得破坏：`md1011-regression.test.ts`、`cvMemory.test.ts`、`lazyInlineMath.test.ts`、`scrollDebug.test.ts` 既有用例全绿且不跳过。
6. node_modules 改动只走 `patches/`。
7. 每优化 commit 前 `npm test`；收尾 `test:coverage` + `lint` + `build`。
8. 先测后改六步（§10）；一次一项；ABAB 交错 ≥3 轮；达不到假设就回滚。
9. 观测补点（探针/计数/采样窗）与行为修复分开 commit。
10. perf 硬清理只杀自 spawn 的 dev PID 树（`taskkill /IM` 误杀教训）；tmp 脚本入 `perf/tmp-r7/` 并头注"不入库"。
11. 不改测量口径；fixture 只许改生成参数不许改测量逻辑。
12. 四层补偿链（viewportAnchor/prewarm-comp/anchor-comp/overflow-anchor 禁用）与 smoothJump 互斥旗标无归因证据不动（R6 红线沿承）。
13. **（本轮增补）不得以关停静止补绘、关停预热、砍公式完整性或及时性换取漂移归零**——M1/M2/M3 是硬门，T1/T2 劣化 >10% 即回滚；"把补绘关掉漂移自然没了"不是修复。
14. **（本轮增补）anchor-comp 兜底层不得无证据整体拆除**——修复方向限于消除触发必要性（高度中性渲染/完备高度预留）或同帧同步化（位移与补偿同帧提交），任何补偿语义改动须附 D1 探针前后对照。

## 10. 先测后改六步（每个修复项逐一过）

1. 基线：改动前跑该门禁指标 ≥2 轮取中位；
2. 定位：探针/观测数据指到具体代码路径（file:line）；
3. 可证伪假设：写成"若改 X 则指标 Y 应变化 Z%"的句子；
4. 单项改动：只改这一处，commit 独立；
5. ABAB 交错：改动/基线 A/B/B/A ≥3 轮，方向一致才算数；
6. 保留或回滚：达标保留并记录，不达标回滚并留档（负结果同样写入报告，防重走）。

## 11. 交付物

- 报告 `mditor/docs/large-doc-scroll-drift-report.md`，六节体例：①基线声明（HEAD/环境/症状来源版本核实结论/fixture）；②归因结论（D 候选定罪/排除表，附证据与探针产物路径）；③改动清单（每项 commit hash + file:line + 复杂度 + 回退开关）；④门禁全表（D/M/T/R 逐行基线→结果，未达项附归因不许留空）；⑤遗留与放弃（含 P3 拍板结论、J-α'' 交叉结果）；⑥文档更新清单。
- 文档同步：`mditor/docs/performance.md`（补偿/渲染时序新参数与权衡）、`mditor/docs/dev-anomaly-codes.md`（若新增漂移类异常码按表登记）、`mditor/CHANGELOG.md` Unreleased 节、memory 日记更新。
- 测量产物：`perf/results/r7-*.json`（tag 命名 `r7-phase<N>-<场景>-<n>`）；`perf/tmp-r7/` 一次性探针（不入库）。
- 发版：本轮不发版；发版节奏由用户另行决定。
