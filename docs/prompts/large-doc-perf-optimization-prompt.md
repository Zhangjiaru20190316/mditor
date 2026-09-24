# 任务：mditor 大文档场景系统性卡顿优化——先测后改，鼓励创新算法

> 使用方式：新开会话，将本文件全文交给 AI 编码代理执行。前端代码在 `mditor/` 子目录，所有 `perf/` 与 `npm` 命令在 `mditor/` 下运行。动手前先读第 3 节——本任务禁止盲改。

## 1. 角色与可量化目标

你是资深 Web 文本编辑器性能工程师，熟悉 ProseMirror / CodeMirror / B 树文本缓冲内核。任务：系统性消除 mditor 大文档（≥500KB 或 ≥3000 行，判定见 `src/lib/memory.ts:75-76`）的卡顿，覆盖打开、打字、滚动、选中、搜索、保存六条链路。

验收目标（"已知基线"来自 `docs/performance.md` 与 perf/results 历史轮次，1MB 指压测文档；执行时必须先按第 3 节复测本机基线，以本机复测值为准）：

| # | 指标 | 已知基线（1MB 档） | 目标 | 测量命令 |
|---|------|------|------|------|
| G1 | 打开时长 | 默认档 35.1s（25 个长任务共 31.5s）；+bigDocViewport 7.8~9.7s | 默认档 ≤18s；视口档 ≤6s | `MDITOR_DOC=1MB node perf/md1011-open-ab.mjs`；`MDITOR_DOC=1MB node perf/baseline.mjs <标签>` open 场景 |
| G2 | 打字逐键延迟 p95 | ~480ms（装饰增量映射后；PM updateChildren 内生 ~300ms） | ≤360ms；唯一例外：归因证明剩余全部是 I5 内生成本时，记「未达成（附证据）」、不计入达标数，出路只有按第 5 节把 I5 做成已合入并复测达标的原型 | `MDITOR_DOC=1MB node perf/baseline.mjs` typing 场景；`node perf/profile-typing.mjs`（前置见 §3） |
| G3 | 停键后交互窗长任务 | cvMemory 停顿重建 300-500ms；序列化 662ms（rIC 600ms 超时强行落地） | 单片 ≤8ms 分片推进；本轮打字/停顿序列内 >50ms 长任务计数与 max 显著下降 | `node perf/profile-typing.mjs`；日志核对直读 dev 实例 `%APPDATA%/com.mditor.app.dev/logs/dev-anomalies.log` 按本轮时间窗过滤——`perf/a0-verify.mjs` 钉死 prod 实例目录与 2026-08-27 历史窗口，只能重放历史，不得作本轮验收 |
| G4 | 搜索计数（防抖后单次） | ~600ms（全文序列化+regex） | ≤100ms 且计数正确 | `node perf/bench-export-search-save.mjs`（前置见 §3）；`node perf/verify-search-count.mjs`（硬编码 224KB 文档，测 1MB 档前先改脚本钉文档，见 §3） |
| G5 | Ctrl+S 序列化阻塞 | 662ms | ≤150ms 或完全移出主线程 | `node perf/bench-export-search-save.mjs`（前置见 §3） |
| G6 | 滚动 p50（+bigDocViewport） | 24ms | 按下方回归口径：视口档与默认档均不劣化 | `node perf/scroll-abab.mjs --doc <名> --viewport on\|off --round N` |
| G7 | 选中三场景（拖选/三击/点公式） | 见 `docs/performance.md:151-155` 表 | 按下方回归口径不回归，且力争 -30% | `node perf/select-bench.mjs <标签> 3`（:14 硬编码文档名且无 env 覆盖，用前先改脚本钉文档，见 §3） |

判分：G1-G5 至少达成 4 项且 G6/G7 零回归才算完成；未达项必须给出归因证据与后续方案。禁止降档凑指标（如靠默认关闭公式渲染达成 G1 无效）。

回归判定口径（适用于 G6/G7 及一切"不回归/不劣化"表述，用以消除 2-3 倍时段漂移带来的争议）：同窗口 ABAB 交错 ≥3 轮、按中位数比较，劣化 >10% 且多轮方向一致才判回归，单轮超标不作数。长任务阈值统一 >50ms；G3 统计口径 = 单轮打字/停顿序列内 >50ms 任务的个数与 max。

## 2. 项目背景最小事实集（已核实，直接采用，不要重查）

- 栈：Tauri 2（WebView2）+ React 18 + Vite 5 + vitest。`src/App.tsx` 是壳（标签页/侧栏/状态栏）。
- 双管线：富文本 = Milkdown Crepe（ProseMirror），生命周期/命令门面在 `src/hooks/useMilkdown.ts`，React 壳 `src/components/Editor.tsx`（memo 隔离每键重渲染）；源码 sv = CodeMirror 6，适配器 `src/lib/svCodeMirror.ts`，CM 创建失败回退 textarea（useMilkdown.ts:573-574,1021-1026）。
- remark 三管线：编辑器内 remarkPluginsCtx（useMilkdown.ts:825-850）；worker 复刻 `src/lib/remarkPipeline.ts` + `src/workers/parseWorker.ts`（插件数哨兵校验）；静态渲染 `src/lib/renderMarkdown.ts`（单例懒加载）。改插件集必须三链路同步哨兵，失配会静默回退主线程解析。
- KaTeX：编辑器走 Crepe Latex feature，静态管线走 rehype-katex；版本被 package.json overrides 钉 0.18.4（双实例错位根修，git 6bc1517/ce7100a），不得引入第二实例。
- 打开链路：读盘 → parsePipeline.prepareDoc（docCache 内容寻址缓存，≥200KB 才缓存）→ loadMarkdownFull（缓存命中 Node.fromJSON 零解析直装，useMilkdown.ts:511-545）→ 视口落位盖章。架构图 `docs/performance.md:19-31`。
- 编辑链路：PM 事务+nodeviews 热路径；markdownUpdated 已被 patch 成 200ms 防抖+rIC（`node_modules/@milkdown/plugin-listener/lib/index.js:89-97` 做 prevDoc.eq+serializer，patch 文件 patches/@milkdown+plugin-listener+7.22.1.patch）→ App rAF 合并镜像（src/App.tsx:1320-1332）→ 150ms 防抖+useDeferredValue 重算字数/批注/大纲（src/App.tsx:2411-2420）。
- 滚动：真正滚动容器是根 div `.mditor-editor-host`（Editor.tsx:1254-1260）；视口化 = content-visibility:auto + `src/lib/cvMemory.ts` 高度记忆（FNV-1a 高度表+decoration 承载 contain-intrinsic-size+视口优先分批预热，预热单步 8ms 预算，cvMemory.ts:322-363）；`src/lib/scrollDebug.ts` 常驻滚动归因哨兵。
- 档位：`bigDocPerformance` / `bigDocViewport` 默认均为 false（defaults.ts:203-204）；3000 行/500KB 双阈值+总/子开关。
- 保存：30s 自动保存（defaults.ts:197）+ Ctrl+S 都付 O(doc) getMarkdown 全文序列化（Editor.tsx:670-704）。
- 压测材料：`node perf/gen-bigdoc.mjs` 由 fixtures/一元微分学习题集_CMC备战.md 拼接生成 ~1MB 副本，写 perf/fixtures/，不碰真实笔记。
- 已有资产（保护，不得重造/绕过）：docCache、parseWorker、cvMemory、装饰增量映射 decos.map（c35fc7b 后打字 p95 672→480ms）、预热分片、rAF/防抖/deferred 级联、code-block teardown 重排 patch、ghost 滚动四层补偿链。

## 3. 方法论：先测后改（强制，违反即返工）

每个优化项独立走完六步闭环：

1. **基线**：对应 perf 脚本 ≥3 轮 ABAB 交错，落盘 perf/results/，记录本机基线。
2. **定位**：拿证据，不许凭直觉——`perf/rect-spy.mjs`/`rect-spy2.mjs` 抓强制布局；`perf/profile-typing.mjs`/`profile-select.mjs` CPU self-time 聚合；`node perf/profile-callers.mjs <cpuprofile> <函数名>` 聚合调用方链；`perf/probe-domchurn.mjs` 验证局部编辑是否被放大成全文档替换；`perf/first-interaction.mjs` 做事件阶梯定罪。
3. **假设**：写下可证伪句子——"改动 X 应把函数 Y 的 self-time / 场景 Z 的延迟从 A 降到 B"。
4. **单项改动**：一次一项、独立 commit、附回归测试。
5. **A/B 对比**：同窗口 ABAB 交错复测。纪律：同机不同时段负载漂移实测可达 2-3 倍，**跨时段单轮对比不可信**（docs/performance.md:157-159 教训）。代码版本对比的机械编排：改动独立 commit 后，A 臂 = `git stash`（未提交改动）或 `git checkout` 改动前提交，B 臂 = 恢复改动；每次切臂后确认改动已生效（vite HMR 完成，必要时重启 dev 实例）再跑同一脚本；A/B 必须轮内交错（如 A,B,B,A）≥3 轮，禁止先跑完全部 A 再跑全部 B 的顺序测量。scroll-abab.mjs 自带的 ABAB 编排切的是设置档位（bigDocViewport on/off）而非代码版本，不可照搬。
6. **保留或回滚**：达到假设才保留；达不到且无新证据解释则回滚并记录，不许留"理论上有用"的改动。

环境准备：

- 纯 node 可跑（无需 dev server）：gen-bigdoc / profile-callers / a0-verify；countwords-bench 需 `npx tsx perf/countwords-bench.mjs`（node 直跑 ERR_MODULE_NOT_FOUND；tsx 不在 package.json 与 node_modules/.bin，首次 npx 会联网临时拉取，离线/受限环境先 `npm i -D tsx` 或改写脚本绕过 TS import）。
- CDP 系脚本共同前置：`set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` 后 `npx tauri dev --config src-tauri/tauri.dev.conf.json`（独立 identifier com.mditor.app.dev，workspace 预置 perf/fixtures），脚本连 9223。
- **文档钉定（防静默测错档）**：fixtures 三档 = 53KB（微分方程专题_基准副本）/ 224KB（CMC 备战原件）/ 1.5MB（1MB 压测副本）。baseline.mjs / md1011-open-ab.mjs / profile.mjs 支持 `MDITOR_DOC` 环境变量（文件名子串匹配；cmd 下先 `set MDITOR_DOC=...` 再跑）；不钉会静默测错档——baseline.mjs:26 默认"一元微分学习题集"同时命中 224KB 原件与 1MB 副本（rows.find 取文件树首个命中），md1011-open-ab.mjs:6 默认"CMC备战"命中 224KB/53KB 且匹配不到 1MB 副本。1MB 档一律 `MDITOR_DOC=1MB`（唯一子串）。select-bench.mjs:14 / verify-search-count.mjs / parse-time.mjs 硬编码文档名、无 env 覆盖，用于 1MB 档前先改脚本钉文档（perf/ 脚本允许改，但只许改文档选择/生成参数，不许改测量口径与既有结果文件）。历史证据：results/final-default.json（1658 块 / openMs 3411 = 224KB 档）与 big1mb-r1.json（11629 块 / openMs 35120 = 1MB 档）并存，两档正是靠 env 区分的。
- **dev 实例状态前置**：多数 CDP 脚本要求"dev 实例已打开目标文档"——用 `node perf/open-doc.mjs <文档名>` 打开（profile-typing.mjs:18 硬取 pm.children[700]，打开文档顶层块 <701 会直接抛错，1MB 副本 ~11.6k 块满足）；"cv 开" = bigDocViewport true（默认 false，defaults.ts:204），手段：设置面板手开，或参照 scroll-abab.mjs:41,151 在 app 关闭时直改 `%APPDATA%/com.mditor.app.dev/mditor.json` 的 settings.bigDocViewport。
- 守卫：`npm test`（vitest run；当前 82 个测试文件，用例数与通过状况以本轮实跑为准——调研时点曾 888 用例全绿，可能已漂移；首轮先跑一遍记录起点，既有失败先归因，不把旧账算进本轮改动）；`npm run test:coverage`（src/lib/** 行覆盖 ≥55%、src/components/** ≥12%，vitest.config.ts:19-22，阈值不得下调）；`npm run lint`；`npm run build`。每个优化 commit 前至少跑 npm test，收尾全跑。

## 4. 分层优化清单（按证据执行；可依实测重排，须在报告说明理由）

格式：**编号 技法** 优先级｜问题与位置｜改法与适用条件｜验证。

### 4.1 解析与序列化层

- **S1 增量序列化（顶层块级缓存）** P0｜保存/搜索/脏标签切换都付 O(doc) 全文序列化，1MB 档 662ms（Editor.tsx:670-704；src/App.tsx:328-371 脏标签快照同源；SearchBar.tsx:45-55）｜利用 PM 节点不可变+结构共享，WeakMap 缓存顶层块序列化产物，序列化=变更块重算+缓存串拼接，O(doc)→O(变更块+拼接)；Ctrl+S/自动保存/搜索三处共用｜G4/G5 + 逐字节等价差分测试（见第 5 节规则 4）。
- **S2 序列化/搜索 worker 卸载** P1｜S1 之后的残余长任务｜主线程 doc.toJSON() 传输（克隆成本远低于序列化），worker 持 schema 复刻做 serializer 与搜索 regex；沿用 parseWorker 的哨兵校验防分叉，失败回退主线程（既有模式 useMilkdown.ts:1021-1026）｜G4/G5 + 回退路径测试。
- **S3 docCache 块粒度指纹** P2｜当前缓存是整篇指纹，编辑一块后重开/切回即整篇重解析｜tree-sitter 式失效传播：指纹细化到顶层块内容哈希，失配只重解析变更块｜`node perf/parse-time.mjs`（:8 硬编码 224KB 原件绝对路径，测大档前先改脚本钉文档，见 §3）+ 缓存命中/未命中两路正确性测试。
- **S4 打开路径 O(doc) 正则归一化** P3｜normalizeMathDelimiters+isBigDoc 行循环每次打开/整篇写回各付 1-3ms（useMilkdown.ts:521-524,1171-1177）｜量级小，仅在其他项触碰同函数时顺手合并，不单独立项。

### 4.2 渲染与布局层（打开/滚动）

- **R1 打开布局墙** P0｜默认档 1MB/2.5 万行 35.1s：58.6 万 DOM 节点、原生布局 12.9s+get focusNode 强制布局 3.7s；两大文档开关默认全关（defaults.ts:203-204）｜代码侧：KaTeX 公式块进视口才渲染（当前只有 CM 代码块 teardown patch 与 big 档整体关闭两档，见 performance.md:145）、重 nodeview 懒挂载（只作用于自带重型子编辑器的 nodeview——KaTeX 公式块/CM 代码块，滚出视口降级为占位）。懒挂载与红线 5 的边界：占位后 Ctrl+F 计数、跨视口选区/全选、批注 marker 盖章三类行为必须与现状逐值等价（verify-search-count / cv-correctness 场景验证），不卸载普通文本块、不改 PM 文档树结构——做不到等价即属红线 5 禁止的分块渲染，转 R4 流程。产品侧：≥1MB 自动开启 bigDocViewport 属产品决策，只出提案+数据等用户拍板，不改默认值｜G1 双档数据 + `MDITOR_DOC=1MB node perf/md1011-open-ab.mjs`。
- **R2 cvMemory 停顿后整树重建分片** P1｜打字停顿 1.2s 后的 cvIntrinsic 整树重建在 1MB 档是一次 300-500ms 长任务（cvMemory.ts:158-162,264-284，buildDecos 遍历全部顶层块）｜套用预热同款"单步 8ms 预算+自适应批大小+idle 让出"（cvMemory.ts:322-363 已有模式）把重建分片；进一步可只对编辑影响区间附近的块重算｜G3 + 撤销/粘贴后装饰复活仍正确（cv-correctness 场景思路）。
- **R3 批注盖章轮全树扫描** P2｜含批注文档打字连击期，60ms 防抖 MutationObserver 每轮 querySelectorAll(sup)+querySelectorAll(p)+逐 marker closest('p')（useAnnotationMarkers.ts:79-89,127-135）｜改增量：仅扫 mutation 记录命中的子树，维护已盖章段落集合｜`perf/probe-domchurn.mjs` + 批注相关测试全绿。
- **R4 真窗口化/卸载视口外块** P3·提案级｜content-visibility 仍不够的 ≥1MB 档才值得；DOM 58.6 万→千级，布局墙直接消失｜须先逐项攻克跨视口选区/查找/批注 marker 可见性三关（performance.md:237-245 已列为独立攻坚）；按第 5 节创新算法流程立项，默认不破"不做整篇虚拟化"的既有决策（第 6 节红线 5）。
- **R5 大纲提取 O(doc) 遍历** P2｜walkHeadings 对每次事务排微任务做全文档 descendants+签名串拼接（useMilkdown.ts:785-818，已限频但每次仍 O(doc)）｜维护顶层块前缀位置/标题增量索引（cvMemory.ts:521-528 的 posOf 表是雏形），编辑只更新受影响条目｜大纲跳转正确性测试 + 打字场景归因对比。

### 4.3 输入交互层（打字/搜索/保存）

- **I1 sv 模式每键全文摊平** P0｜`svCodeMirror.ts:161` 每键 `update.state.doc.toString()` 整篇字符串摊平（1MB 每键一次全文分配+拷贝），下游 contentRef/sourceTextRef 再各存一份｜CM 内部 Text 是 B 树（结构共享、O(log n) 增量）：docChanged 时只置脏标记，值消费者（保存/搜索/切换快照）按需或防抖取串；能传结构就 sliceJSON 不摊平｜typing 场景 A/B + sv 模式编辑/保存/切换全链路测试。
- **I2 打字机模式每键布局读取** P1｜centerCaret 在每键 selectionchange 的 rAF 后读 getClientRects+getBoundingClientRect+clientHeight（Editor.tsx:576-604），大文档布局脏时=强制同步回流｜改：打字期间布局脏标记门控（有pending输入时延迟到空闲/合并读）、或以光标 nodeview 已知几何替代整篇 rect 读取｜`perf/rect-spy2.mjs` 抓现行前后对比 + G2。
- **I3 搜索计数长任务** P0｜与 S1/S2 联动：防抖后仍"全文序列化+全文 regex"（SearchBar.tsx:45-55，1MB 实测 ~600ms）｜优先消费 S1 的镜像串（rAF 合并镜像已在 src/App.tsx:1320-1332）；regex 按第 5 节评估流式/分块匹配｜G4 + `verify-search-count.mjs` 计数正确。
- **I4 监听器 rIC 600ms 硬超时** P2｜200ms 防抖+rIC 的 prevDoc.eq+serializer 会在持续轻交互间隙被 600ms 超时强行落地（plugin-listener/lib/index.js:89-96）｜S1 落地后单次成本自然骤降；若仍可感，评估调高超时或改 scheduler.yield() 保续延优先级（改 node_modules 须走 patch，第 6 节红线 7）｜G3；打点口径：先在 CDP 会话置 `window.__MDITOR_PROFILE_SERIALIZE = true`（plugin-listener/lib/index.js:87 门控，src/ 与 perf/ 无任何脚本置位，不置则读到的恒为空数组）再触发序列化、读 `performance.getEntriesByName("mditor:serialize")`。
- **I5 PM updateChildren 内生墙** P3·研究级｜1MB 档每键 ~300ms 的 O(顶层块数) 成本（11.6k 顶层块，零装饰证伪实验已排除装饰因素），历史列为"不修"（PM 核心手术风险）｜只允许经第 5 节完整流程（原型+数据）立项，例如按 R4/R5 的块索引做视口内子树对账加速；无原型数据不得直接动 prosemirror-view。

### 4.4 内存与常驻成本层

- **M1 导出管线 worker 化/分片** P1｜1MB 档 juice 916ms + htmlToDocx ~3s ≈ 4s 全在主线程（renderMarkdown.ts:21-43 管线单例在主线程 import）｜按导出各阶段（renderBlockMath/juice/htmlToDocx/rasterize）逐段分片或下放 worker，低频但用户可感｜`node perf/bench-export-search-save.mjs`（前置见 §3）前后对比 + 导出产物抽检等价。
- **M2 级联去频纪律** P2｜任何本次新增的状态上抛先问"能否 150ms 防抖+useDeferredValue"（src/App.tsx:1320-1332,2411-2420 是范式）｜review 自查项，写入报告 checklist｜代码 review + profile-typing 无新增每键任务。
- **M3 全文扫描类预算确认** P3｜countWords p50 5.04ms @1MB（150ms 防抖后每秒预算 33ms，降幅已 89%）｜已达标非瓶颈，勿过度优化；同类新增扫描先跑 `npx tsx perf/countwords-bench.mjs` 口径确认预算｜基准数据留档。

## 5. 创新算法条款

明确欢迎自研算法——本项目已有先例（cvMemory 高度表 = CodeMirror heightmap 的富文本版）。候选方向：块级/行级索引（行号↔offset↔文档位置的前缀和或 B 树，VS Code piece-tree 思想，服务大纲跳转/锚点搜索/批注定位的二分查找）、增量 AST 失效传播、序列化输出端的 piece-table 对偶、PM 顶层块前缀位置数组。规则（不满足不得合入）：

1. **复杂度分析**：提交信息与报告写明改动前后最坏/摊还复杂度（如 O(doc)→O(变更块+拼接)），并用 ≥3 个规模档实测曲线佐证——可直接用 fixtures 现存 53KB/224KB/1.5MB 三档；gen-bigdoc.mjs 钉死 1MB 输出、无规模参数，需中间档时允许给它加参数（perf/ 脚本可改，但只许改生成参数，不许改测量口径与既有结果文件）。
2. **原型先行**：算法先用纯 node 脚本原型验证（参照 perf/countwords-bench.mjs 形态，npx tsx 直跑），数据成立再进产品代码。
3. **回退方案**：每项创新算法留运行时开关或自动降级路径（参照 worker 失败回退主线程的既有模式），并附回退触发条件的测试。
4. **正确性等价断言**：序列化/索引类算法必须有"与朴素实现逐字节/逐位置等价"的随机化差分测试（≥1000 次随机编辑序列，含撤销/重做/粘贴）。
5. 不得为算法优雅牺牲第 6 节任何红线。

## 6. 约束与守卫（红线，违反=制造回归）

1. **公式渲染不破坏**：KaTeX 双管线（Crepe Latex + rehype-katex）行为不变；katex 钉 0.18.4 不得引入第二实例；触碰 mathNormalize/remark 数学插件时，须跑公式相关测试并用含 `$$...$$` 块公式的压测文档目检——块级公式不得塌陷（历史上 CSP/双实例都出过块公式回归）。
2. **全量守卫**：每个优化 commit 前 `npm test` 全绿；收尾 `npm run test:coverage`（阈值不下调）+ `npm run lint` + `npm run build`；既有回归守卫（tableBlockPatch.test.ts、md1011-regression.test.ts）一律不跳过。
3. **remark 插件集改动**必须三链路同步哨兵 expectedPluginCount（parseWorker/remarkPipeline/编辑器 remarkCtx），失配即静默回退主线程解析。
4. **已有性能资产**（第 2 节末条清单，含 ghost 滚动四层补偿链 viewportAnchor/cvMemory/prewarm-comp/anchor-comp）无归因证据不得改动。
5. **不做整篇虚拟化/分块渲染**的既有决策（performance.md 阶段 3）仅在 R4 三关全过时按提案级重新评估。判定标准：任何使视口外内容不再参与查找、跨视口选区或批注盖章的渲染改动都算分块渲染——R1 懒挂载的"三类行为逐值等价"就是反向判据，等价则属 R1、不等价则触本条。
6. **性能优化不夹带行为变化**：序列化产物、导出 HTML、搜索计数结果必须与优化前逐字节/逐值等价。
7. **改 node_modules 必须 via patches/**（patch-package），不得只改 lib 产物而无 patch 文件。
8. 涉及默认设置/产品决策的改动（≥1MB 自动开 bigDocViewport、真窗口化、改 autosave 间隔）单独成提案文档等用户拍板，不合入默认行为。

## 7. 交付物格式

报告写入 `mditor/docs/large-doc-perf-report.md`（新建；docs/ 现无 optimization_report 编号体系——全仓唯一先例是 docs/archive/v3.9-optimization-report.md，仅作体例参考），必须包含：

1. **改动清单**：每项一节——commit hash / 涉及文件（file:line）/ 归因证据摘要（profile 数据）/ 技法归类（对应第 4 节编号或"创新算法"）/ 复杂度前后。
2. **基线 vs 优化数据**：G1-G7 全表（本机复测基线 vs 优化后，同窗口 ABAB 交错，附 perf/results 文件名与轮次）；未达标项给出归因与后续方案，不许留空。
3. **遗留风险**：每项改动的已知风险、回退开关位置与触发条件；明确列出"没做/放弃"的项及原因（如 I5 只到原型阶段）。
4. **文档更新**：`docs/performance.md` 增补本轮结论与基准口径。
5. **提案附件**：所有走第 6 节红线 8 的产品决策项，单独成文待拍板。
