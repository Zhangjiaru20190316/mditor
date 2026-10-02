# 任务：mditor 大文档公式渲染第六轮治理——公式渲染及时性与完整性专项

> 使用方式：本任务书配套 `/goal` 命令交付（目标文本见下方代码块，直接粘贴）。前端代码在 `mditor/` 子目录，所有 `perf/` 与 `npm` 命令在 `mditor/` 下运行。核心环节分阶段推进（§7），每阶段证据落盘（`perf/results/` 与报告草稿）并自查后才进下一阶段，禁止把归因与修复混在同一批。动手前必读第 0、1、2、3、9 节——本任务禁止盲改，禁止重修已修问题，禁止预设根因结论。
>
> ```text
> /goal 修复 mditor 大文档公式渲染不及时与漏渲染（第六轮专项，范围：cv 档行内公式懒渲染泵 + 块级公式）。任务书：docs/prompts/large-doc-formula-render-optimization-prompt.md——先通读全文并遵守 §0 基线核实、§2 已查明事实集不重查、§3 禁区与红线，在 mditor/ 子目录下按 §7 阶段顺序执行，禁止盲改、禁止重修已修问题、禁止重走已证伪路线。完成判据（全部满足才 pass）：① 完整性——唯一公式 >8192 的大文档滚动遍历往返后行内公式源码占位残留=0、渲染泵队列清空、块级公式视口内挂载率 100%；② 及时性——滚动静止后视口内公式补绘完成 p95 较基线（第五轮实测 3,955-4,892ms @1MB on 臂，以本轮阶段三同口径复测为准）降至 ≤1/4，且第五轮闪变门禁（scroll-flash-bench 占位残留、MD-1001/1002/1011 零复发）不劣化 >10%；③ 零回归——npm test 全绿（≥970 基线，以实跑为准），1MB 打开/打字/切换基准零回归；④ 交付——报告落盘 mditor/docs/large-doc-formula-render-report.md，每个修复项独立 Fix-X commit 且附新增测试，CHANGELOG Unreleased 与 memory 日记更新。红线：KaTeX 0.18.4 单实例与 mathConfig 宏语义不动；第五轮 Fix-A/B 占位高度记忆不得破坏；观测与修复分开 commit；每 commit 前 npm test；先测后改六步。
> ```
>
> 前序任务书引用链（体例连续，背景可查）：`docs/prompts/large-doc-perf-optimization-prompt.md`（第三轮，已结题，报告 `mditor/docs/large-doc-perf-report.md`）、`docs/prompts/large-doc-perf-motion-optimization-prompt.md`（第四轮，已结题，报告 `mditor/docs/large-doc-perf-motion-report.md`）、`docs/prompts/large-doc-scroll-stability-optimization-prompt.md`（第五轮，已结题，报告 `mditor/docs/large-doc-scroll-stability-report.md`）、`mditor/PROMPT-fix-image-math-r2.md`（公式红字/`\(\)` 不渲染取证线，勿与 R 系列轮次混淆）。
>
> 【填写】观察环境（待用户确认）：桌面打包版 v5.0.0-beta 真实使用（现卷）。主战场文档（已预填，用户确认）：公式密集中型文档（密度档画像：约 105K 字符/2,355 行内公式）+ 1MB 超长文档，另需准备唯一公式 >8,192 的超限 fixture（§0）。症状钉死两大类：①症状 T（不及时）——滚动到公式区域，公式长时间停留在 LaTeX 源码占位态，滚动停止后补绘拖尾秒级；②症状 M（漏渲染）——部分公式滚动往返后仍维持源码占位未渲染（"漏掉"）。症状补充（哪个更严重/典型文档名）：___。复现线索（时间点/操作序列/快速长滚还是慢滚/是否首开即滚）：___。

## 0. 基线状态声明（执行第一步必须核实，禁止假设）

本任务书基于 2026-10-02 仓库状态撰写：

- HEAD = `35ed260`（chore(release): v5.0.0-beta——第五轮滚动稳定性专项发版）；撰写时工作区有未跟踪杂物（`mditor/perf/tmp-r5/`、`nul` 文件），不影响本任务。
- **执行第一步**：`git status` + `git log --oneline -5`，据实记录 HEAD 相对 v5.0.0-beta 的实际状态（其后是否有新提交/未提交改动），报告开头声明；后续一切论述以核实后的代码为准。
- fixture 在位性（撰写日本机核实惯例）：`mditor/perf/fixtures/` 含 `无穷级数_密度档压测副本.md`（约 105K 字符/2,159 行/2,355 行内公式）、`解题技巧_密度档切换副本.md`（约 60KB UTF-8≈35K 字符/778 公式——文档画像一律以公式数为准，勿用 KB 比大小）、`一元微分学习题集_1MB压测副本.md`——整目录 gitignore（本地化惯例）。执行时先 `ls perf/fixtures/` 确认，缺失则按第四轮报告 §2 重建规格从 `E:/笔记/cmc` 源复制，或给 `gen-bigdoc.mjs` 加密度参数（只许改文档选择/生成参数，不许改测量口径）。
- **本轮新增 fixture 要求**：唯一公式数 >8,192（超出 katexCache LRU 与预热余量截断阈值）的超限文档，用于钉死候选 M-a（§2.C）。可用 `gen-bigdoc.mjs` 扩密度参数生成或复制拼接既有密度档 fixture，生成规格写入报告。
- 生产证据窗口：`%APPDATA%/com.mditor.app/logs/` 现卷为 v5.0.0-beta，含第五轮全部观测补点（scrollDebug 归因窗口等）——本轮日志复析直接用现卷口径。
- npm test 基线：第五轮收尾 970+（以实跑为准，执行第一步实跑 `npm test` 记录确数）。

## 1. 角色与主战场

你是资深 Web 文本编辑器渲染性能工程师，熟悉 KaTeX 渲染成本模型（`renderToString` 冷/热代价）、IntersectionObserver 调度、rAF 帧预算分配、LRU 缓存驱逐策略与 ProseMirror nodeview 生命周期。**本轮性质：不是再猜一轮优化，而是「复现 → 建立测得出问题的基准 → 归因 → 修复 → 数据证明」。**

两大症状（定义钉死，禁止扩大或偷换）：

1. **症状 T（不及时）**：滚动到公式区域，公式长时间停留在 LaTeX 源码占位态；滚动停止后补绘完成拖尾达秒级。已知定量背景：滚动中冷渲染预算仅 5ms/帧 + 静止门 `SCROLL_QUIET_MS=400` 起步 + 静止后 10ms/帧补绘（§2.B）；第五轮实测 1MB on 臂占位残留 p95 3,955-4,892ms。
2. **症状 M（漏渲染）**：滚动往返后部分公式仍维持源码占位，长时间不渲染（区别于"慢"：是"漏"——无推进）。候选源为预热 LRU 文档序截断、泵队列无饥饿报警、render 失败无重试调度、demote 无限顺延（§2.C）。

主战场双档：**公式密集中型文档**（密度档画像，cv 档旁路 `BIG_DOC_MATH_DOLLARS=800` 生效，行内懒渲染开）+ **1MB 超长文档**（isBigDocCv 行数/体积阈值生效）+ **>8,192 唯一公式超限 fixture**（钉死 M-a）。三战场各钉各的症状，只测一档的结论无效。

范围界定：本轮只管**编辑器内**行内公式懒渲染管线与块级公式（LaTeX code_block）挂载调度；静态表面（AI 面板/批注预览，`src/lib/renderMarkdown.ts`）与导出路径（`src/lib/exportMath.ts`）**不在本轮门禁内**，除非日志证据直接指向（若涉入须在报告说明并经用户确认扩项）。

方法论铁律沿用第三/四/五轮：**先测后改、一次一项、ABAB 交错、证据不成立不动手、达不到假设就回滚**（§10）。

## 2. 已查明事实集（直接采用，不要重查；行号经静态核实，以仓库实际为准）

### 2.A 公式管线速览（三条路径）

- 引擎：KaTeX 0.18.4 **单实例**，`package.json` overrides 钉死（防 rehype-katex 嵌套 0.16 双实例，事故见 `mditor/CHANGELOG.md:112`）；mhchem 在 `src/main.tsx` 一次性注册。
- 编辑器行内公式（math_inline）：默认档 Crepe toDOM `katex.render`（宏透传修于 `patches/@milkdown+crepe+7.22.1.patch`）；**cv 档大文档走懒渲染 nodeview** `src/lib/lazyInlineMath.ts`（插件在 `src/hooks/useMilkdown.ts:894` 无条件注册，`setLazyMathBySize` 在 :698/:1218 按体量开合）。
- 编辑器块级公式：`code_block(language=LaTeX)`，Crepe Latex 特性（`useMilkdown.ts:719/731-733`）+ `@milkdown/components` code-block 组件（CodeMirror 编辑 + KaTeX 预览，Vue）；懒挂载/拆除由组件内共享 IntersectionObserver 负责，`patches/@milkdown+components+7.22.1.patch` 把 `TEARDOWN_DELAY` 5s→15s 并修"聚焦块永不拆除"。**块级无任何预热**（预热明确不覆盖，`src/lib/mathCachePrewarm.ts:26-28`），无重试机制（一次性挂载）。
- 缓存层：`src/lib/katexCache.ts` LRU 8,192 条/8MiB（`renderToStringCached` :80，宏复制防御 :84-88）。
- 预热：`src/lib/mathCachePrewarm.ts` `startMathCachePrewarm`（`useMilkdown.ts:570,993-994,1227-1228` 调度）——**仅行内**，`requestIdleCallback` 8ms/批、用户输入 500ms 让路、代际令牌中止、**LRU 余量截断按文档序**（:34-43, 100-103——文档序靠后的公式在余量不足时永远不被预热）。
- 减配档 isBigDoc（>500KB 或 3000 行）整体关闭 KaTeX（公式降级为源码），是既有决策非本轮靶；本轮全部工作在 cv 档 isBigDocCv（`src/lib/memory.ts:89/:140/:159`，阈值或 `BIG_DOC_MATH_DOLLARS=800` 密度旁路）。

### 2.B 症状 T 候选源（不及时；禁止预设主犯，逐一取证）

1. **滚动中小预算**（T-a）：渲染泵滚动中冷渲染预算 5ms/帧（`lazyInlineMath.ts:83`）+ 缓存命中直绘软上限 64 条/帧（:96）——冷缓存区域滚动中几乎不推进，公式全程源码占位。
2. **静止门起步+补绘速率**（T-b）：静止判定 `SCROLL_QUIET_MS=400`（监听 wheel/touchmove/keydown 而非 scroll，程序化滚动不触发，:181-222）+ 静止后 10ms/帧全量补绘（:79）——大量待补公式时拖尾秒级。第三轮风险表已定案"滚动中公式保持占位至静止 ~400ms"（`mditor/docs/large-doc-perf-report.md:133`）。
3. **前向带只对下滚**（T-c）：方向前方 800px 带内渲染仅向下滚动启用（R4-① 定案，:295-319）——上滚首见公式留队列等静止，与第五轮 F1 上滚占位残留同族。
4. **预热冷启动**（T-d）：首开即滚时预热未完成（idle 8ms/批 + 用户输入让路），缓存全冷，滚动中直绘通道（64/帧）无缓存可用。
5. **1MB 首开争用窗**（T-e）：预热量测 + cvMemory 学习 + 泵叠加，帧 p50 154ms（第五轮报告 §2.4 曾定性"封案不可治"——本轮仅当 T/M 修复波及预热/学习窗时才重开案，须附差分数据）。

### 2.C 症状 M 候选源（漏渲染；禁止预设主犯，逐一取证）

1. **预热 LRU 截断按文档序**（M-a）：唯一公式 >8,192 时余量截断使文档尾部区域永远冷缓存（`mathCachePrewarm.ts:100-103`）——冷缓存本身不漏渲染，但叠加泵重排优先级（视口内 > 带内 > 其余）与预算耗尽回插，尾部公式可能长期得不到渲染机会。
2. **泵队列无饥饿报警**（M-b）：预算耗尽条目回插队首无限等待下一帧（`lazyInlineMath.ts:264,471` 附近，销毁元素靠 `isConnected` 丢弃）——无超时、无最低推进保障；若条目持续排视口外优先级，可能饿死。
3. **render 失败无重试调度**（M-c）：`render()` try/catch 回退源码占位且 `rendered=false` 标记可重试（:439-447），但无人调度重试；nodeview 工厂异常回退 Crepe toDOM（:543-547）。瞬时异常（字体未就绪/宏竞态）可能造成永久占位。
4. **demote 嵌套顺延 + 会话表超限**（M-d）：demote 定时器嵌套重排链——滚动不静止则无限顺延（:479-489）；第五轮 Fix-B 内容寻址会话表 cap 8,192（:354-391），超限逐出后高度/渲染态记忆丢失，回视口的重建路径行为待取证（与第五轮 F-2 上滚占位残留同族）。
5. **块级公式无预热无调度**（M-e）：LaTeX code_block 完全无预热，CodeMirror+Vue 组件挂载成本重；块公式密集文档滚动回视重挂载延迟明显，TEARDOWN_DELAY 15s 销毁后重见需完整重建。
6. **update() 绕泵竞态**（M-f）：值变更路径 `void r` 强制 rect 读 + 直接 rAF 渲染，绕过泵与静止门（:508-513）——编辑路径与滚动并发的行为无测试覆盖。

### 2.D 版本状态与生产证据

- 第五轮基线（`mditor/docs/large-doc-scroll-stability-report.md`）：1MB on 臂占位残留 p95 3,955-4,892ms（F-2，上滚场景）；1MB 首开争用帧 p50 154ms（§2.4）；F-4 katex-error 计数为 fixture 非法 LaTeX 所致，非回归；状态依赖高度残余 ~450ms 瞬态遗留（§5.2 P3 提案未立项，见 §3 待拍板）。
- 密度档生产证据（第四轮任务书 §2 沿用）：MD-9001 曾三日 1,700+ 次（密度旁路立项缘起）；1MB 打开 12,441-12,848/13,550-14,804ms（默认/视口档）；打字 p95 密度档 1,456-1,984ms（原生墙，JS 侧不可治）、1MB g2 口径 408-448ms；切换中位 2,254ms。
- 已证伪链（CHANGELOG :45-46，勿重走）：密度档 toDOM 接缓存等三项降本尝试为负结果。

### 2.E 测量设施（现存直接挂靠；本轮需新建探针见测量列）

- `mditor/perf/`：`scroll-flash-bench.mjs`（占位残留事件/p95 + katex-error 计数，upscroll/roundtrip/longread 三场景——本轮主基准）、`scroll-abab.mjs`（`--doc <名> --viewport on|off --round N --duration 秒 --tag`，ABAB 交错+DOM 签名自证）、`ghost-stress.mjs`（四阶段压测，MD-1001/1002/1011 计数）、`open-1mb.mjs`、`g2-typing.mjs`、`switch-bench.mjs`、`md1011-verify.mjs`、`prod-formula-smoke.mjs`（打包 CSP 冒烟：CDP 键入 `$$…$$` 断言 `.katex`）、`formula-subscript-check.mjs`（下标 DOM 目检）、`gen-bigdoc.mjs`、`cdp.mjs`（rAF 帧间隔 + longtask recorder）——全量清单 `ls perf/`。
- 复现探针参考：`perf/tmp-r5/probe-f.mjs`（rAF 级占位残留计数，一次性脚本头注"不入库"——本轮同类探针入 `perf/tmp-r6/`，**只杀自 spawn 的 dev PID 树**，第五轮 taskkill /IM 误杀教训）。
- 单测守卫：`lazyInlineMath.test.ts`（24 例：泵门控/预算/方向带/软上限/demote 静止门/Fix-B 高度表）、`katexCache.test.ts`、`mathCachePrewarm.test.ts`、`mathKatexDedupe.test.ts`、`md1011-regression.test.ts`、`cvMemory.test.ts`——全部不得跳过。
- 生产日志：`%APPDATA%/com.mditor.app/logs/`；异常码表 `mditor/docs/dev-anomaly-codes.md`（MD-9001/1001/1002/1003/1011/9003）。

## 3. 禁区与待拍板

- **已证伪勿重查**（第三/四轮证伪链 + CHANGELOG :45-46）：katexCache 挂 toDOM（100% 命中仍 2.4s，瓶颈=PM updateStateInner+原生布局）；docCache 阈值下调无效；分帧挂载等价于视口档本身；密度档 toDOM 接缓存等三项降本尝试为负结果。
- **默认档急切渲染是教训定案**（lazyInlineMath.ts 头注 ：9-13：无 cv 时懒渲染高度变化是全文档回流）——勿在默认档开懒渲染。
- **第五轮成果不得破坏**：Fix-A/B（cvMemory 装饰内容寻址重放、lazyInlineMath Fix-B 会话表）、Fix-C（cvMemory 预热只学冷块）、Fix-D（视口学习 webfont 门控）——任何改动跑 `md1011-regression.test.ts` + `cvMemory.test.ts` + `lazyInlineMath.test.ts` 全绿。
- **待拍板提案**：R5 §5.2 P3（预热批测量时从 katexCache 渲染公式，使 cvMemory 学得值恒为渲染态，根治高度二象性 81px↔40px 残余 ~450ms 瞬态）——涉及 cvMemory 语义，**先出原型数据再请用户拍板，不得直接合入**。
- 未经用户拍板不得改默认值、不得重引入 bigDocViewportAuto（v4.19 自动档曾被明确回退）。
- 第四轮未立项项（A1/A2/A3/A5）维持不动，除非本轮公式证据直接指向。

## 4. 可量化目标（门禁表；判分：T1/T2 与 M1/M2/M3 必须有本机数据，修复类门在证据立项后判定，R 组全部零回归；未达项附归因，不许留空）

### T 组：及时性（症状 T）

| # | 指标 | 已知基线 | 目标 | 测量 |
|---|---|---|---|---|
| T1 | 静止补绘拖尾：滚动静止后视口内行内公式从源码占位到全部 ready 的完成时长 p95 | 1MB on 臂占位残留 p95 3,955-4,892ms（第五轮，含滚动期+静止期合计口径；阶段三以同口径复测钉死本轮基线） | ≤ 本轮复测基线的 1/4（目标值在阶段三填死并写入报告） | `node perf/scroll-flash-bench.mjs`（upscroll/roundtrip/longread 三场景，1MB on 臂为主，密度档 on 臂同测） |
| T2 | 滚动中视口内源码占位：滚动进行中视口内未 ready 行内公式条数峰值与源码态可见时长占比 | 无独立口径（第三轮定性"滚动中保持占位至静止 ~400ms"） | 基准建成+有数；立项修复后显著下降，且第五轮 F 组门禁（闪变）不回归 | scroll-flash-bench 扩滚动中采样窗（只加观测不改行为，独立 commit） |
| T3 | 1MB 首开即滚争用窗：首开后立即滚动的帧 p50/p95 | 帧 p50 154ms（第五轮 §2.4，曾"封案不可治"） | 仅当 T/M 修复波及预热/学习窗才重开案；不劣化即算过，波及必须附差分 | `open-1mb` + `scroll-abab` 组合，阶段五按需 |

### M 组：完整性（症状 M）

| # | 指标 | 已知基线 | 目标 | 测量 |
|---|---|---|---|---|
| M1 | 漏渲染残留：滚动遍历全文档往返后静止 10s，行内公式源码占位/rendered=false 残留条数 | 无基准（候选 M-a/M-b/M-c） | **= 0**（>8,192 唯一公式超限 fixture 与 1MB 档双测） | 新建公式残留探针（口径参考 `perf/tmp-r5/probe-f.mjs`：rAF 级计数未 ready 条数；脚本入 `perf/tmp-r6/` 头注不入库，只杀自 spawn PID 树） |
| M2 | 泵队列饥饿：会话结束后 10s 泵队列仍挂起条目数 | 无基准 | **= 0** | 探针暴露 `window.__mathPumpStats`（或等效观测点：队列深度/最老条目等待时长；只加观测，独立 commit） |
| M3 | 块级公式挂载：视口内 LaTeX code_block KaTeX 预览挂载完成率；katex-error 计数 | katex-error 恒 0（第五轮 F-4 为 fixture 非法 LaTeX，非回归——fixture 修法或口径排除须写明） | 挂载率 **100%**；katex-error 维持 0 | scroll-flash-bench / `prod-formula-smoke.mjs` 断言 + 块公式挂载探针（视口内 `.cm-editor`+KaTeX 预览配对计数） |

### R 组：防回归（全部零回归；基线为第四/五轮同机，环境差异须声明）

| # | 指标 | 已知基线 | 测量 |
|---|---|---|---|
| R1 | 1MB 打开（默认/视口档） | 12,441-12,848 / 13,550-14,804ms | `MDITOR_DOC=1MB node perf/open-1mb.mjs 3 <tag>` |
| R2 | 打字 p95 | 密度档 1,456-1,984ms（原生墙）；1MB g2 口径 408-448ms | `MDITOR_DOC=无穷级数_密度档 MDITOR_MIN_BLOCKS=500 node perf/g2-typing.mjs <tag>`；1MB 档 `MDITOR_DOC=1MB` 同法 |
| R3 | 切换 | 密度档中位 2,254ms | `node perf/switch-bench.mjs --doc-a 无穷级数_密度档 --doc-b 解题技巧_密度档 --viewport off --switches 20 --tag <t>` |
| R4 | 全量守卫 | vitest 970 基线（以实跑为准） | `npm test`（每优化 commit 前）；收尾 `npm run test:coverage` + `npm run lint` + `npm run build` |
| R5 | 第五轮门禁复测：scroll-flash-bench 占位残留 p95、scroll-abab DOM 签名自证、MD-1001/1002/1011 触发数 | 第五轮收尾值（报告 §门禁表） | `node perf/scroll-flash-bench.mjs` + `node perf/scroll-abab.mjs --viewport on --round 3 --duration 60 --tag <t>` + `node perf/ghost-stress.mjs --minutes 5 --tag <t>` + `node perf/md1011-verify.mjs` |

回归判定阈值沿用历轮：**劣化 >10% 且多轮方向一致才算回归**。

## 5. 症状 T：取证设施与可证伪归因路径

- **取证设施**：scroll-flash-bench 三场景 + 滚动中采样窗扩展；`window.__mathPumpStats` 观测点（队列深度/预算消耗/直绘通道命中）；`perf/profile-scroll.mjs`；`perf/rect-spy2.mjs`（泵每帧 ≤256 次 getBoundingClientRect 的布局读热点，lazyInlineMath.ts:91,265）。
- **可证伪归因路径**（每条先写成可证伪句子再动手，§10 第 3 步；证据不成立换下一候选，不许并行改多个）：
  - T-a：若拖尾=滚动中小预算不推进，则滚动中采样窗内 ready 增量 ≈ 0 而缓存命中直绘通道有量（冷条目 vs 预算的关系曲线）——量化后按证据立项修复。
  - T-b：若拖尾=静止门+补绘速率，则拖尾时长与待补条数线性、与静止门 400ms 常数项可分离（静止触发时刻与最后一帧 ready 时间戳差）。
  - T-c：若拖尾集中在上滚，则上滚场景 T1 显著劣于下滚（与第五轮 F-2 数据交叉验证，合并归因）。
  - T-d：若拖尾集中在首开即滚，则拖尾时长随预热完成率上升而收敛（prewarm 进度对齐分析）；首开 60s 后重滚对照组应显著好——则修复方向是预热调度而非泵。
  - T-e：若波及预热/学习窗导致 T3 劣化，则差分数据必须先于合入（否则回滚）。
  - 复现不了的症状必须产出「为何在此环境不触发」的归因（dev 与打包版构建/缓存/真实文档差异），不许静默跳过。

## 6. 症状 M：取证设施与可证伪归因路径

- **取证设施**：公式残留探针（M1 口径）；`window.__mathPumpStats`（M2：最老条目等待时长分布）；>8,192 唯一公式超限 fixture（钉死 M-a 的文档序截断——残留应集中在文档尾部区域，这是 M-a 的指纹）；`lazyInlineMath.test.ts` 补竞态用例（M-f）。
- **可证伪归因路径**：
  - M-a：若漏渲染=预热文档序截断，则超限 fixture 残留条目位置分布显著偏文档尾部且冷缓存（预热统计佐证）；改截断策略（如余量按区域采样/视口优先）后尾部残留消失。
  - M-b：若漏渲染=队列饥饿，则 `__mathPumpStats` 出现等待 >10s 的活条目（isConnected=true）；重排优先级或加最低推进保障后清零。
  - M-c：若漏渲染=失败无重试，则残留条目 `rendered=false` 且控制台/内部计数有 render 异常记录；加重试调度后清零（注意与第五轮 F-4 非法 LaTeX 区分：非法源码的 katex-error 是合理红字，不算漏渲染，口径写明）。
  - M-d：若漏渲染=demote 顺延/会话表超限，则快速长滚动场景后残留集中于曾离开视口的条目，且顺延计数超阈；调整顺延上限或表淘汰策略后消失。
  - M-e：若块级挂载率 <100%，则探针捕获视口内 `.cm-editor` 无 KaTeX 预览的样本及等待时长；修复方向（预热块级缓存/挂载调度）须先出原型数据。
  - M-f：若 update() 绕泵与滚动并发产生竞态残留，则补单测复现（模拟滚动中连续值变更），竞态修复后用例转绿且残留清零。
  - F/M 可能同源（上滚占位残留既闪又漏）：交叉数据支持时合并归因，一次修复双方门禁复测。

## 7. 执行阶段（各自成阶段，顺序推进；凭实测可重排，报告说明理由）

第五轮实际执行未走 /workflow 直接分阶段推进，本轮沿用：直接执行、阶段门禁自查后才进下一阶段。

- **阶段一：生产日志复析（先于一切）**。现卷（v5.0.0-beta）按文档/档位聚合 MD-9001/1001/1002/1003/1011 与公式相关条目：确认症状发生档位、时间分布与操作上下文；产出「症状-文档-档位对照表」，钉死三战场优先级。
- **阶段二：复现与探针建设**。新建公式残留探针 + 滚动中采样窗 + `window.__mathPumpStats`（全部"只加观测不改行为"，独立 commit）；准备 >8,192 唯一公式超限 fixture；dev 实例复现症状 T/M 各至少一例，探针捕获到非零计数才进阶段三。
- **阶段三：基准**。跑 T1/T2/M1/M2/M3 全口径基线（含 R 组对照臂），填死门禁表基线列与目标值；测量产物落 `perf/results/r6-*.json`，tag 命名 `r6-phase3-<场景>-<fixture>-<n>`。
- **阶段四：归因（禁盲改）**。按 §5/§6 可证伪路径逐候选取证定罪/排除，产出归因结论（每条附证据文件与数据）；未定罪不许进修复。
- **阶段五：分批修复（Fix-A/B/C…）**。按定罪排序 P0-P3 分批，每项独立 commit（hash+file:line+复杂度+回退开关）、附新增单测、ABAB 交错 A/B/B/A ≥3 轮；P3 类拍板项（§3）只出原型数据。
- **阶段六：全量门禁 + 报告**。T/M/R 全表复测 + `prod-formula-smoke.mjs` 打包冒烟（端口避让 9222 惯例、typeText 不可靠教训——用打开+滚动断言）+ 报告与文档更新（§11）。

## 8. 创新算法条款（若引入新调度/缓存算法）

复杂度分析（时间/空间，按视口内条数 n 与全文档 N 表达）+ 三规模档实测（密度档/1MB/超限 fixture）+ 原型先行（脚本级验证再落地）+ 降级开关（新策略可一键回退旧路径）+ 1,000 次随机编辑差分（新旧行为等价性，公式渲染结果逐条比对）。不满足任一条不合入。

## 9. 红线（编号沿承历轮 + 本轮增补）

1. 未经用户拍板不得改默认值、不得重引入 bigDocViewportAuto（v4.19 自动档曾被用户明确回退）。
2. 已证伪路线勿重走（§3 证伪链：katexCache 挂 toDOM / docCache 阈值下调 / 分帧挂载 / 密度档 toDOM 接缓存三项）。
3. 默认档（非 cv 档）急切渲染定案勿改；减配档关公式是既有决策，非本轮靶。
4. KaTeX 0.18.4 单实例钉住不动（package.json overrides）；不引入新渲染引擎；`src/lib/mathConfig.ts` 宏语义与单一来源不动。
5. 第五轮 Fix-A/B/C/D 不得破坏：`md1011-regression.test.ts`、`cvMemory.test.ts`、`lazyInlineMath.test.ts` 既有用例全绿且不跳过。
6. node_modules 改动只走 `patches/`（@milkdown+components / @milkdown+crepe / micromark-extension-math 补丁惯例）。
7. 每优化 commit 前 `npm test`；收尾 `test:coverage` + `lint` + `build`。
8. 先测后改六步（§10）；一次一项；ABAB 交错 ≥3 轮；达不到假设就回滚。
9. 观测补点（探针/计数/采样窗）与行为修复分开 commit。
10. perf 硬清理只杀自 spawn 的 dev PID 树（第五轮 `taskkill /IM` 误杀用户打包版教训）；tmp 脚本入 `perf/tmp-r6/` 并头注"不入库"。
11. 不改测量口径；fixture 只许改生成参数不许改测量逻辑。
12. 四层补偿链（viewportAnchor/cvMemory prewarm-comp/anchor-comp/overflow-anchor 禁用）与 smoothJump 互斥旗标无归因证据不动（第五轮红线沿承）。

## 10. 先测后改六步（每个修复项逐一过）

1. 基线：改动前跑该门禁指标 ≥2 轮取中位；
2. 定位：探针/观测数据指到具体代码路径（file:line）；
3. 可证伪假设：写成"若改 X 则指标 Y 应变化 Z%"的句子；
4. 单项改动：只改这一处，commit 独立；
5. ABAB 交错：改动/基线 A/B/B/A ≥3 轮，方向一致才算数；
6. 保留或回滚：达标保留并记录，不达标回滚并留档（负结果同样写入报告，防重走）。

## 11. 交付物

- 报告 `mditor/docs/large-doc-formula-render-report.md`，六节体例：①基线声明（HEAD/环境/fixture）；②归因结论（T/M 候选定罪/排除表，附证据）；③改动清单（每项 commit hash + file:line + 复杂度 + 回退开关）；④门禁全表（T/M/R 逐行基线→结果，未达项附归因不许留空）；⑤遗留与放弃（含 P3 拍板项原型数据）；⑥文档更新清单。
- 文档同步：`mditor/docs/performance.md`（公式调度新参数与权衡）、`mditor/docs/dev-anomaly-codes.md`（若新增公式类异常码按表登记并定义）、`mditor/CHANGELOG.md` Unreleased 节、memory 日记更新。
- 测量产物：`perf/results/r6-*.json`（tag 命名 `r6-phase<N>-<场景>-<n>`）；`perf/tmp-r6/` 一次性探针（不入库）。
- 发版：本轮不发版；发版节奏由用户另行决定（v5.0.0-beta 已含第五轮成果）。
