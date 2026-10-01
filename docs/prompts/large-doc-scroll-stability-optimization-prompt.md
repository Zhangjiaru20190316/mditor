# 任务：mditor 大文档滚动稳定性第五轮治理——滚动乱闪与滚动位置乱动专项

> 使用方式：新会话，将本文件全文交给 AI 编码代理执行。前端代码在 `mditor/` 子目录，所有 `perf/` 与 `npm` 命令在 `mditor/` 下运行。核心环节强制用 `/workflow` 动态工作流编排——复现取证、基准建设、归因、修复分批各自成阶段（§7），每阶段证据落盘（`perf/results/` 与报告草稿）并自查后才进下一阶段，禁止把归因与修复混在同一批。动手前必读第 0、1、2、3、9 节——本任务禁止盲改，禁止重修已修问题，禁止预设根因结论。
>
> 前序任务书引用链（体例连续，背景可查）：`docs/prompts/large-doc-perf-optimization-prompt.md`（第三轮，已结题，报告 `mditor/docs/large-doc-perf-report.md`）、`docs/prompts/large-doc-perf-motion-optimization-prompt.md`（第四轮，已结题，报告 `mditor/docs/large-doc-perf-motion-report.md`）、`docs/prompts/scroll-perf-optimization-prompt.md`（公式下标 + 滚动专项，部分被第三轮吸收）。
>
> 【填写】观察环境（已预填，用户确认）：桌面打包版 v4.20.0 真实使用。主战场文档（已预填）：公式密集中型文档（密度档画像：约 105K 字符/2,355 行内公式/15.4 万 DOM）+ 1MB 超长文档，双战场缺一不可。症状补充（默认已钉死两大症状：①滚动页面时页面乱闪；②滚动指令积压/多写入方叠加导致页面乱动）：___。复现线索（时间点/操作序列/是否伴随切标签、AI 写入、撤销、侧栏开合）：___。

## 0. 基线状态声明（执行第一步必须核实，禁止假设）

本任务书基于 2026-10-01 仓库状态撰写：

- HEAD = `ab9582d`（v4.20.0 打包版冒烟证据），发版提交 `c84a59b`（v4.20.0，第四轮两批合并）；撰写时工作区 clean。
- **执行第一步**：`git status` + `git log --oneline -5`，据实记录 HEAD 相对 v4.20.0 的实际状态（其后是否有新提交/未提交改动），报告开头声明；后续一切论述以核实后的代码为准。
- fixture 在位性（撰写日本机核实）：`mditor/perf/fixtures/` 含 `无穷级数_密度档压测副本.md`（约 105K 字符/2,159 行/2,355 行内公式）、`解题技巧_密度档切换副本.md`（约 60KB UTF-8 字节≈35K 字符/778 公式——两者口径不同，文档画像一律以公式数为准，勿用 KB 比大小）、`一元微分学习题集_1MB压测副本.md`——整目录 gitignore（`.gitignore:31` 本地化惯例）。执行时先 `ls perf/fixtures/` 确认，缺失则按第四轮报告 §2 重建规格从 `E:/笔记/cmc` 源复制，或给 `gen-bigdoc.mjs` 加密度参数（只许改文档选择/生成参数，不许改测量口径）。
- 生产证据窗口：`%APPDATA%/com.mditor.app/logs/` 现卷为 v4.20.0，已含第四轮检测器去噪批（窗口口径/尾半窗斜率过滤/空 src 过滤）——本轮日志复析直接用窗口口径。

## 1. 角色与主战场

你是资深 Web 文本编辑器渲染稳定性工程师，熟悉 Chromium 滚动管线（滚动锚定、content-visibility remembered size、程序化 scrollTop 写入与用户滚动的竞争、rAF 调度）与 ProseMirror 滚动写入路径。**本轮性质：不是再猜一轮优化，而是「复现 → 建立测得出问题的基准 → 归因 → 修复 → 数据证明」。**

两大症状（用户在桌面打包版 v4.20.0 真实使用中确认，定义钉死）：

1. **症状 F（乱闪）**：滚动页面时页面乱闪——滚动期视觉闪变（源码占位↔公式交换、高度回落、重渲跳动等；候选源 §2.B）。
2. **症状 J（乱动）**：滚动指令积压/多写入方叠加导致页面乱动——滚动位置非预期变化（视口顶偏、补偿往复、恢复写入插队等；候选源 §2.C）。

主战场双档：**公式密集中型文档**（密度档画像：约 105K 字符/2,355 行内公式/15.4 万 DOM——默认设置下该画像走全量急切渲染，视口档特性需手动开 bigDocViewport 后才生效，**症状发生在哪个档位本身就是待取证事实**，§7 阶段一）+ **1MB 超长文档**。两档都要测，只测一档的结论无效。

方法论铁律沿用第三/四轮：**先测后改、一次一项、ABAB 交错、证据不成立不动手、达不到假设就回滚**（§10）。

## 2. 已查明事实集（直接采用，不要重查；行号经静态核实，以仓库实际为准）

### 2.A 项目与架构速览

- Mditor：本地优先 Typora 风格 WYSIWYG Markdown 编辑器；Tauri 2（Windows WebView2，另有鸿蒙 ArkWeb 壳）+ React 18 + Milkdown/Crepe（ProseMirror）+ KaTeX 0.18.4 + CodeMirror 6；前端源码与 perf 脚本都在 `mditor/` 子目录。
- 编辑器整篇一次性渲染、刻意不虚拟化（零风险中间态决策，见 `mditor/docs/performance.md`；跨视口选区/window.find/批注盖章/大纲跳转依赖全量 DOM）。
- 档位判定 `src/lib/memory.ts`：减配档 isBigDoc（>500KB 或 3000 行，砍 CodeMirror/KaTeX）；视口档 isBigDocCv（同阈值或公式密度旁路 `BIG_DOC_MATH_DOLLARS=800` 个 `$` 定界符，开 content-visibility+懒公式）；两档均受 bigDocPerformance/bigDocViewport 手动开关门控，**默认全关**。
- 视口档 CSS：`src/styles/global.css:1732` content-visibility:auto + contain-intrinsic-size auto 3em；宿主标记 data-big `src/components/Editor.tsx:1263`；滚动容器 `div.mditor-editor-host`（Editor.tsx:1258-1263）；容器 `contain:layout style` + `overflow-anchor:none` 刻意禁用（global.css:1296-1303——防 Chromium 滚动锚定把局部布局位移放大成视口来回跳）。

### 2.B 症状 F 候选源（滚动期视觉闪变；禁止预设主犯，逐一取证）

1. **行内公式占位↔KaTeX 交换**：`src/lib/lazyInlineMath.ts`（math_inline nodeview，仅视口档启用）。占位=LaTeX 源码文本，入视口后 innerHTML 替换并加 `.mditor-math-inline-ready`。已有护栏：WeakMap 记忆渲染高度给占位设 minHeight；katexCache（`src/lib/katexCache.ts`，LRU 8,192 条/8MiB）命中可在滚动中直绘（每帧上限 64 次）；空闲全文档预热（`src/lib/mathCachePrewarm.ts`，用户输入 500ms 内让路）；120ms opacity 过渡（global.css:5946 起）。
2. **上滚带内权衡（记录在案，本轮要么数据化要么修复）**：前向 800px 带内渲染只对向下滚动启用；向上滚动的带内条目留队列等静止补渲——**上滚首见公式会先闪源码占位**。原因：overflow-anchor 刻意禁用后，上方内容首次渲染的高度变化会顶偏视口（lazyInlineMath.ts 头注 R4①）。
3. **代码块销毁窗口**：CodeMirror 代码块 nodeview 离开视口 800px 且超销毁延时 15s（`patches/@milkdown+components+7.22.1.patch` 将 `_CodeMirrorBlock.TEARDOWN_DELAY` 从 5s 提升）后回落源码占位，回滚再见时闪烁。
4. **MD-1011 结构海啸**：ProseMirror 顶层块整批替换（AI 写入/揭示/粘贴/撤销，样本 -937/+382）使 Chromium 的 content-visibility remembered size 随旧元素消亡丢失，回落 3em 占位，高度塌陷+滚动跳变。护栏：headingStamp 预盖章（`src/lib/headingStamp.ts`，直建式改造后 1,047ms→14ms）+ cvMemory 内容寻址高度表（`src/lib/cvMemory.ts`，FNV-1a 哈希键）。第四轮 B3 遗留：按内容哈希复活高度未做完（AI 写入真实场景留观察）。
5. **整批重建**：fulldoc.setValue 重建全部代码块子编辑器（`src/hooks/useMilkdown.ts` 内 fulldoc.setValue 计数）；流式批注已改 per-node ops 规避。
6. **图片首载位移**：`src/lib/imageLazy.ts` 学习 aspect-ratio 预留，首次可见仍会位移（文件头记录的已知残留）。
7. **cvMemory 预热期**：临时强制 content-visibility:visible 分批预热（8ms 预算+视口带优先+prewarm-comp 滚动补偿保持画面不动，cvMemory.ts:782 起）。

### 2.C 症状 J 候选源（滚动位置非预期变化/指令叠加；禁止预设主犯）

1. **程序化滚动写入方全集**（每个都经 noteScrollWrite 打标，scrollDebug 归因窗口 WRITE_WINDOW_MS=250ms，`src/lib/scrollDebug.ts:257`）：打字机居中 Editor.tsx:606；anchor-comp 补偿 scrollDebug.ts:1199（钳位 ±8000px，仅静止帧）；prewarm-comp cvMemory.ts:863；标签恢复阶梯 Editor.tsx:367-402（首次 80ms+每 300ms 重试至 8 次，带 untouched 检查）；重建恢复 useMilkdown.ts:2680/2699（双 rAF+粗/锚两次写入）；handoff/heal 恢复 App.tsx:1057-1135（重试循环）；大纲跳转 App.tsx:1845/1865（scrollIntoView auto/smooth）；批注跳转 App.tsx:1961/2023；源码视图跳转 `src/lib/svCodeMirror.ts`:258；搜索 reveal（PM tr.scrollIntoView + Editor.tsx:308）；viewportAnchor 精确落位 `src/lib/viewportAnchor.ts`:107-132。
2. **叠加风险（本轮乱动主嫌疑=协调薄弱）**：上述写入方时间窗可重叠（例：恢复阶梯 8 次×300ms 期间 anchor-comp/打字机可插队）；跨写入方互斥唯一旗标 host.dataset.smoothJump（scrollend 单次/wheel 单次/1200ms 超时清除）。
3. **渲染泵与静止门**：渲染泵 rAF 单飞（lazyInlineMath.ts 的 schedulePump）；静止判定 SCROLL_QUIET_MS=400 由用户输入（wheel/touchmove/keydown capture+passive）驱动而非 scroll 事件——**程序化滚动不触发静止门**，泵持续按滚动帧小预算工作（视口内冷渲染 5ms/帧+缓存命中直绘上限 64/帧）；未完成条目重排队（视口内未完成 > 带内剩余 > 其余）。
4. **取证设施现成**：scrollDebug 常驻 rAF tick+会话归因状态机（用户输入 200ms 内/已知写入/resize 500ms/浏览器钳制/ghost 五类）+哨兵块视口位移检测+`window.__scrollDebug` 面板；MD-1001 ghost 在 4.18.0+ 生产零复发（4.17.1 曾 47 次），`perf/ghost-stress.mjs` 4 阶段压测零触发；MD-1002 视口大幅位移同族。
5. **「指令积压」候选机制（留给执行代理取证定罪，本任务书不预设结论）**：恢复阶梯重试与补偿器并发；smoothJump 清除时序（1200ms 超时可能早于滚动结束）；渲染泵积压重排在长滚动条带中的滞后渲染；上滚带内不渲染导致的高度跳变被误归因为滚动位移。

### 2.D 版本状态与生产证据

- 密度档生产证据（第四轮任务书 §2）：MD-9001 共 1,896 次（约 105K 字符/2,356 行内公式文档，domNodes 峰 154,557，每窗 jankFrames 10-99）；MD-1003 共 67 次（切标签 1-4.5s，最坏 4,489ms）。
- 第四轮遗留（`mditor/docs/large-doc-perf-motion-report.md` §7）：MD-1011 部分覆盖（AI 写入真实场景留观察）；密度档打开 3.4-3.6s 已归因封案（原生布局 2,315ms+PM 挂载 1,364ms，JS 侧无法解决，唯一杠杆 content-visibility）——**不再立项打开提速**；worstGapMs 与心跳 frame.\* 字段为会话累计须差分（`perf/heartbeat-diff.mjs`）；scroll-abab 预热等待公式单位已知缺陷（`perf/scroll-abab.mjs:443`：上限 45s 基线+bytes/15_000 折算封顶，1MB 档上限≈115s，预热完成计数出现即早停——第四轮实测 1MB on 档约 45s 早停；两臂同条件，不阻塞测量）。
- 打包版冒烟先例：`perf/prod-formula-smoke.mjs`（v4.18.0 CSP 打包验证：CDP 键入单公式断言 `.katex`）；v4.20.0 冒烟（`ab9582d`，未脚本化）开真实文档+滚动 8000px，断言公式 2 到 24 渐进绘制+katex-error=0。坑：9222 被占换 9224；typeText 不可靠（字符 ￼ 化），用打开+滚动断言。

### 2.E 测量设施（全部现存，直接挂靠）

- `mditor/perf/`：scroll-abab.mjs（`--doc <名> --viewport on|off --round N --duration 秒 --tag`，视口档 on/off ABAB 交错滚动）、ghost-stress.mjs（`--minutes N --tag`，滚读/滚读+侧栏开合/程序化大跳/编辑混合四阶段）、switch-bench.mjs（切换动画帧节奏）、heartbeat-diff.mjs（心跳差分）、gen-bigdoc.mjs（fixture 生成）、open-1mb.mjs、profile-typing/profile-select/profile-scroll.mjs、profile-callers.mjs、rect-spy2.mjs（强制布局）、probe-domchurn.mjs、first-interaction.mjs、open-doc.mjs、md1011-verify.mjs、prod-formula-smoke.mjs——全量清单 `ls perf/`。
- 生产日志：`%APPDATA%/com.mditor.app/logs/`；异常码表 `mditor/docs/dev-anomaly-codes.md`。
- 守卫：`npm test` 全绿（945+ 基线，以实跑为准）；tableBlockPatch.test.ts、md1011-regression.test.ts 等既有守卫不得跳过。

## 3. 禁区与待拍板

- **已证伪勿重查**（第四轮 P0-B 证伪链）：katexCache 挂 toDOM（100% 命中仍 2.4s，瓶颈=PM updateStateInner 1.8s+原生布局）；docCache 阈值 200K 降到 50K 无效；分帧挂载原型可行但等价于视口档本身。
- **待拍板提案**：`mditor/docs/proposal-bigdoc-viewport-auto.md`（数学密集中型文档自动入视口档；数据 A/B 全面占优——打开 12.5→5.5s、滚动 p95 251→82ms、点公式 728→88ms；但 v4.19 自动档曾被用户明确回退）。**未经用户拍板不得改默认值、不得重新引入 bigDocViewportAuto**（红线 1）。
- 第四轮未立项项（A1 装饰削减、A2/A3 增量索引、A5 导出分片——exporterProbe.ts 仍缺）维持不动，除非本轮滚动证据直接指向。

## 4. 可量化目标（门禁表；判分：F1/F4 与 J1/J3 必须有本机数据，修复类门在证据立项后判定，R 组全部零回归；未达项附归因，不许留空）

### F 组：闪变类（症状 F）

| # | 指标 | 已知基线 | 目标 | 测量 |
|---|---|---|---|---|
| F1 | 上滚源码占位残留（视口档）：上滚 3000px 窗内可见未渲染占位条数峰值、源码态可见时长 p95 | 无基准（§2.B2 权衡未量化） | 基准建成+有数；若立项修复：峰值与 p95 显著下降且不引入视口顶偏（J3 同步复测不回归） | 新建 `perf/scroll-flash-bench.mjs`（§7 阶段三）上滚场景，fixture 密度档+1MB，on 臂为主（off 臂对照） |
| F2 | 代码块销毁窗口回滚闪烁：滚离视口 800px 停留 >15s 后回滚，重见时高度跳变量与重渲间隔 | 无基准 | 基准建成+有数；若定罪修复：闪烁计数显著下降 | 同上脚本回滚场景 |
| F3 | remembered-size 回落（MD-1011 类）：压力会话 MD-1001/1002/1011 触发数 | 第四轮 D3 场景 0 | 维持 0；AI 写入/揭示场景若触发则定罪+修复后归零 | `node perf/ghost-stress.mjs --minutes 5 --tag <t>` + `node perf/md1011-verify.mjs` + 打包版真实使用窗日志复析 |
| F4 | 滚动帧通过率（两档 on/off）：滚动帧 p95 与 >50ms 帧数 | 密度档 off p95 41.8/41.9ms（第四轮 2 轮）；1MB 见第四轮 M1 | 零回归（劣化 >10% 且多轮方向一致才算） | `node perf/scroll-abab.mjs --doc 无穷级数_密度档 --viewport on\|off --round <r> --duration 60 --tag <t>`；1MB 档 `--doc 一元微分学习题集_1MB` 同法双臂 |

### J 组：乱动类（症状 J）

| # | 指标 | 已知基线 | 目标 | 测量 |
|---|---|---|---|---|
| J1 | 未归因滚动写入计数：压力会话中非用户输入、非已知写入、非 resize/钳制的 scrollTop 变化次数 | 无窗口级数据 | =0，或全部可归因到具名写入方（盲区则补打点，检测器独立 commit） | `node perf/ghost-stress.mjs --minutes 5 --tag <t>` + `window.__scrollDebug` 会话归因明细读数 |
| J2 | 写入方重叠窗口：恢复阶梯 8×300ms 期间他方（anchor-comp/typewriter/prewarm-comp）插队次数；smoothJump 1200ms 超时早于滚动结束次数 | 无数据 | 基准建成+有数并归因；若定罪为乱动主犯：修复后插队计数显著下降 | scrollDebug 补窗口级重叠计数（只加观测不改行为，独立 commit）+ 新建叠加场景（切标签恢复期间插滚轮/大纲跳转） |
| J3 | 视口位移异常：哨兵块位移超阈事件、MD-1001/1002 复发 | 4.18.0+ 生产零复发（未在 v4.20.0 打包版复验） | 维持 0；打包版 ≥30min 真实使用窗日志复析 0 | `node perf/ghost-stress.mjs --minutes 5 --tag <t>` + 生产日志复析 |
| J4 | 长会话滚读帧率：≥30min 滚读滚动帧 p95 与 >50ms 帧数（差分口径） | 无长会话基准 | 有数且较会话首段不劣化 | `node perf/ghost-stress.mjs --minutes 30 --tag <t>` + `node perf/heartbeat-diff.mjs --top 15` |

### R 组：防回归（全部零回归）

| # | 指标 | 已知基线（第四轮同机，环境 ~2× 声明） | 测量 |
|---|---|---|---|
| R1 | 1MB 打开（默认/视口档） | 12,441-12,848 / 13,550-14,804ms | `MDITOR_DOC=1MB node perf/open-1mb.mjs 3 <tag>` |
| R2 | 打字 p95 | 密度档 1,456-1,984ms（原生墙，JS 侧不可治）；1MB g2 口径 408-448ms | `MDITOR_DOC=无穷级数_密度档 MDITOR_MIN_BLOCKS=500 node perf/g2-typing.mjs <tag>`；1MB 档 `MDITOR_DOC=1MB` 同法 |
| R3 | 切换 | 密度档中位 2,254ms（提案待拍板项，非本轮靶） | `node perf/switch-bench.mjs --doc-a 无穷级数_密度档 --doc-b 解题技巧_密度档 --viewport off --switches 20 --tag <t>` |
| R4 | 全量守卫 | vitest 945 基线（以实跑为准） | `npm test`（每优化 commit 前）；收尾 `npm run test:coverage` + `npm run lint` + `npm run build` |

## 5. 症状 F：取证设施与可证伪归因路径

- **取证设施**：`window.__scrollDebug`（哨兵位移+归因状态机）；`perf/prod-formula-smoke.mjs`（打包版冒烟先例）；`perf/scroll-abab.mjs`；`perf/rect-spy2.mjs`（强制布局读写抖动）；`perf/profile-scroll.mjs`；新建 `perf/scroll-flash-bench.mjs`（DOM 计数断言：`.mditor-math-inline-lazy` 未 ready 条数+rAF 时间戳、`.katex-error` 恒 0）。
- **可证伪归因路径**（每条先写成可证伪句子再动手，§10 第 3 步；证据不成立换下一候选，不许并行改多个）：
  - F-a：若闪=源码占位↔公式交换，则闪现时刻与占位→ready 类名翻转时间戳一一对应（对应 §2.B1/B2/B3）——量化残留时长/条数（F1/F2）后按证据立项修复。
  - F-b：若闪=高度回落，则闪现帧伴随哨兵块位移或 rect-spy2 捕获的布局跳变（对应 §2.B4/B5/B6）。
  - F-c：若闪集中在载入后预热窗，则闪现时间与 prewarm 分批/预热让路窗口对齐（对应 §2.B7）。
  - 复现不了的症状必须产出「为何在此环境不触发」的归因（与打包版的构建/缓存/真实文档差异），不许静默跳过。

## 6. 症状 J：取证设施与可证伪归因路径

- **取证设施**：scrollDebug 归因状态机与 `window.__scrollDebug` 面板（写入时间线：tag/时刻/幅度）；`perf/ghost-stress.mjs` 四阶段（含程序化大跳——其 scrollTop 为脚本自我签名，归因器应排除，第四轮已验）；`perf/heartbeat-diff.mjs`；`perf/md1011-verify.mjs`；`perf/profile-scroll.mjs`。
- **可证伪归因路径**（不预设结论；§2.C5 候选逐一证伪）：
  - J-a：复现乱动瞬间读归因输出——unknown 写入=检测盲区（补打点后重跑）；具名写入=做时间窗重叠分析（J2 计数）。
  - J-b：构造叠加场景（切标签恢复阶梯 8×300ms 期间插滚轮/大纲跳转/打字）在 dev 实例重现；归因到写入方后逐方二分（注释单方仅限 dev 实验，不合入）。
  - J-c：若为渲染泵积压滞后，profile-scroll 应捕获渲染帧与滚动帧错峰、泵队列深度随滚动条带增长。
  - J-d：若为上滚带内高度跳变被误归因，F1 占位残留数据与哨兵位移应同窗对齐——F/J 可能同源，合并归因。
- **四层补偿链（viewportAnchor/cvMemory prewarm-comp/anchor-comp/overflow-anchor 禁用）与 smoothJump 互斥旗标无归因证据不动**（红线 7/13）。

## 7. 执行阶段（/workflow 各自成阶段，顺序推进；凭实测可重排，报告说明理由）

### 阶段一：生产日志复析（先于一切）

- 现卷（v4.20.0）按文档/档位聚合 MD-9001/1001/1002/1003/1011：确认症状发生时用户实际档位（big 字段/bigDocViewport 设置）、时间分布与操作上下文；heartbeat-diff 差分滚动窗帧率。产出「症状-文档-档位对照表」，钉死双战场优先级。

### 阶段二：复现（双路径）

- 路径 1 打包版：参照 `perf/prod-formula-smoke.mjs` 先例（端口与 typeText 坑见 §2.D），把乱闪/乱动转成 DOM 与滚动断言（占位计数、哨兵位移、katex-error=0）。
- 路径 2 dev CDP：scroll-abab/ghost-stress + `__scrollDebug` 读数（环境前置见 §10）。判定标准：≥3 轮可重复的稳定触发，或给出「为何不触发」的环境差异归因并声明。

### 阶段三：基准扩展

- 新建 `perf/scroll-flash-bench.mjs`：三场景（上滚 3000px / 快速往返 / 长会话滚读）× 双 fixture × on/off 双臂；输出 F1/F2/J4 全量指标（占位残留、闪烁计数、滚动帧分布、写入方时间线）；沿用 cdp.mjs 帧录制，壳就绪后 ignoreCache 重载（WebView 磁盘缓存毁臂陷阱，第四轮 acc1d1e）。
- scrollDebug 补写入方重叠窗口级计数（J2，只加观测不改行为，独立 commit）。
- 可选测量修复：scroll-abab 预热等待公式单位（bytes/15000→按公式条数）——属测量正确性修复，须两臂同条件重测并在报告声明，不与行为改动同 commit。

### 阶段四：归因（禁盲改）

- 对 F/J 各候选按 §5/§6 路径逐一证伪，每条结论附 perf/results 文件名与轮次；机器开销与墙钟分离——ABAB 臂间方差淹没信号时以 CPU profile self-time 归因为准。

### 阶段五：分批修复（P0-P3 按证据排序；每项独立 commit+回归测试+ABAB 数据，达不到假设即回滚）

- **P0**：双路径复现+定罪的症状主犯（F/J 各至多 2 项，防止撒网）。
- **P1**：上滚带内权衡（§2.B2）数据化后视证据修复；代码块销毁窗口参数（若 F2 定罪）。
- **P2**：检测盲区补打点收尾；MD-1011 内容哈希复活高度（第四轮 B3 遗留，凭本轮 AI 写入场景证据重启）。
- **P3**：留档项与顺带修复（图片首载位移、零星异常码）。

## 8. 创新算法条款（继承第三/四轮，全文有效）

欢迎自研算法（先例：cvMemory 高度表 = CodeMirror heightmap 富文本版）。规则（不满足不得合入）：①复杂度分析（前后最坏/摊还）+ ≥3 规模档实测曲线（53KB/224KB/1.5MB + 密度档）；②纯 node 脚本原型先行；③运行时开关或自动降级路径+触发条件测试；④序列化/索引类 ≥1000 次随机编辑差分等价断言（含撤销/重做/粘贴）；⑤不牺牲第 9 节任何红线。

## 9. 约束与守卫（红线，违反=制造回归；1-10 继承第四轮全文，11-13 本轮增补）

1. 不得擅自重新落地已回退的 v4.19 自动视口档（bigDocViewportAuto / sizeIsHugeDoc / 默认开启路径）——该决策已被用户明确回退；重提必须先确认回退缘由、走提案、等拍板（§3）。
2. 动效语义：不得以砍动画、降帧率、延长加载条、默认关动效换性能指标；motion 三档语义与 prefers-reduced-motion 行为不变；MIN_SWITCH_MS=300 最短可见加载条语义不变；性能优化不得夹带任何视觉行为变化。
3. 日志口径：跨版本异常计数对比必须声明检测器版本；4.18.0 及以前的 worstGapMs/心跳 frame.\* 会话累计字段不得作窗口证据；本轮结论一律基于差分后的窗口口径。
4. KaTeX 双管线行为不变、单实例（overrides 钉 0.18.4）；块公式不得塌陷（历史 CSP/双实例两次回归）。
5. 全量守卫：每优化 commit 前 `npm test` 全绿（945 基线，以实跑为准）；收尾 `npm run test:coverage`（阈值不下调）+ `npm run lint` + `npm run build`；tableBlockPatch/md1011-regression 等既有守卫不跳。
6. remark 插件集改动三链路同步哨兵 expectedPluginCount（parseWorker/remarkPipeline/编辑器 remarkCtx），失配即静默回退主线程解析。
7. 已有性能资产与 ghost 四层补偿链无归因证据不动。
8. 不做整篇虚拟化/分块渲染（既有决策）；任何使视口外内容不再参与查找/跨视口选区/批注盖章的渲染改动都算触线，走提案级重评。
9. 改 node_modules 必须 via patches/（patch-package）。
10. 涉及默认设置/产品决策的改动单独成提案等用户拍板，不合入默认行为。
11. **不得为消除闪烁牺牲公式保真**：不许以砍 KaTeX 渲染、降输出质量、永久停留言源占位等方式"换不闪"；lazyInlineMath.ts 头注等价性清单（查找/选区/复制/批注/单实例）同样约束本轮一切改动。
12. **上滚带内权衡的改动必须数据化**：改前先量化现状（F1 占位残留），改后 ABAB 证明不引入新的视口顶偏（J3 同步复测）。
13. **乱动协调层无证据不动**：smoothJump 互斥旗标生命周期、恢复阶梯重试语义、静止门"用户输入驱动"语义——动它们必须先有 J1/J2 计数数据（红线 7 的本轮具体化）。

## 10. 方法论与环境（先测后改六步，逐项闭环）

1. **基线**：对应 perf 脚本 ≥3 轮 ABAB 交错，落盘 `perf/results/`。
2. **定位**：拿证据不许凭直觉——profile-typing/scroll/select.mjs CPU self-time、profile-callers.mjs 调用方聚合、rect-spy2.mjs 强制布局、probe-domchurn.mjs DOM 放大、first-interaction.mjs 事件阶梯定罪。
3. **假设**：可证伪句子（"改动 X 应把 Y 的 Z 从 A 降到 B"）。
4. **单项改动**：一次一项、独立 commit、附回归测试。
5. **A/B 对比**：同窗 ABAB 交错（A/B/B/A ≥3 轮，禁止顺序测量；时段漂移实测 2-3 倍，跨时段单轮不可信）。代码版本切臂用 `git stash`/`checkout`，切臂后确认 vite HMR 生效；机器开销与墙钟分离——臂间方差淹没信号时以 CPU profile self-time 归因为准。
6. **保留或回滚**：达假设才保留；达不到且无新证据解释则回滚并记录。

环境前置（坑均已踩过，照做）：CDP 系脚本共同前置 `set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` 后 `npx tauri dev --config src-tauri/tauri.dev.conf.json`（独立 identifier com.mditor.app.dev）。**文档钉定**：`MDITOR_DOC` 环境变量文件名子串匹配（1MB 档一律 `MDITOR_DOC=1MB`，不钉会静默测错档）；dev 实例先开目标文档 `node perf/open-doc.mjs <名>`。自管脚本改 store 须 app 关闭时改（运行中 LazyStore 内存镜像遮蔽盘上改动）。守卫命令见红线 5。

## 11. 交付物

报告写入 `mditor/docs/large-doc-scroll-stability-report.md`（新建），必须包含：

1. **基线声明**：§0 核实结果（git 状态、HEAD 相对 v4.20.0、fixture 在位性）。
2. **两症状归因结论**：候选源逐一证伪记录（证据文件名/轮次/结论）、定罪链或不定罪归因；生产日志「症状-文档-档位对照表」。
3. **改动清单**：每项一节——commit hash / file:line / 归因证据摘要 / 技法归类（§7 阶段五编号或创新算法）/ 复杂度前后 / 回退开关与触发条件。
4. **门禁全表**：F/J/R 三组本机复测基线 vs 优化后（ABAB 中位数，附 perf/results 文件名与轮次）；未达项归因与后续方案，不许留空。
5. **遗留与放弃**：没做/放弃的项及原因。
6. **文档更新**：`mditor/docs/performance.md` 增补本轮结论与基准口径（含 scroll-flash-bench 规格）；`mditor/docs/dev-anomaly-codes.md` 如有口径变更同步；CHANGELOG 本轮条目入 Unreleased；工作区根 `memory/YYYY-MM-DD.md` 记执行日志。
