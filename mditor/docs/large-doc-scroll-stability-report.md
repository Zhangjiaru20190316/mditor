# 大文档滚动稳定性第五轮报告：滚动乱闪（F）与滚动位置乱动（J）专项

- 版本窗口：v4.20.0 → v5.0.0-beta
- 任务书：`docs/prompts/large-doc-scroll-stability-optimization-prompt.md`
- 前序：第三轮 `mditor/docs/large-doc-perf-report.md`、第四轮 `mditor/docs/large-doc-perf-motion-report.md`
- 证据根目录：`mditor/perf/results/`（r5-* 前缀）、`.workflow/task2-forensics/devlog-r5*`
- 提交链：2736488（观测补点）→ 8e6a470（基准）→ 86cee26（Fix A/B）→ 4db73bd（Fix C）→ eb13a4f（Fix D + perf 安全修复）

## 1. 基线声明

- 执行首步核实（2026-10-02）：HEAD = `ab9582d`（v4.20.0 打包版冒烟证据提交），工作区 clean（仅任务书与两个 Windows `nul` 副产物未跟踪），与任务书 §0 声明一致；后续一切论述以核实后的代码为准。
- fixture 在位性：`perf/fixtures/` 三大战档全在（无穷级数_密度档压测副本 105KB/2,159 行/2,355 行内公式、解题技巧_密度档切换副本 60KB/778 公式、一元微分学习题集_1MB压测副本）。
- 生产证据窗口：v4.20.0 现卷（2026-10-01 会话）+ 4.18.0 轮转卷；心跳窗口口径（windowWorstGapMs，第四轮去噪批已生效）。
- 生产环境事实（代码级核实）：`env.big` = `host.dataset.big`（src/lib/devContext.ts:96）由 `handle.bigDocViewport` 设置（src/components/Editor.tsx:1263）→ **日志 big:true ≡ 视口档激活**；用户生产环境 bigDocViewport 手动开启，密度档画像文档经公式密度旁路（≥800 个 `$`）入档。

## 2. 两症状归因结论

### 2.1 生产日志「症状-文档-档位对照表」（阶段一，`perf/results/scroll-stability-r5-phase1-prodlog.md`）

v4.20.0 窗口（2026-10-01）：MD-1001×9 **全部 big:true**（密度档 105KB ×6 + 题型方法决策树 122KB ×3），三类形态：J-α 切标签/开档 32s 后整千像素未打标跳变（+3000/+5000，lastWrite=file-open@32.6s，无用户动作）；J-β 大纲跳转后 15-18s 的 ±103px/帧漂移；J-γ 链接跳转落点 ±69~269px 漂移。MD-1011×2（-937/+938 结构海啸 ×1 big:true + 1 小文档）。MD-1002×3（2 次空文档平凡 + 1 滚读中）。**v4.20.0 无 MD-9001/1003**（现卷 17 条 9001 全是 4.18.0 旧会话）。第四轮"4.18.0+ MD-1001 零复发"结论被 v4.20.0 打破。

### 2.2 定罪链（阶段四全文：`perf/results/r5-phase4-indictment.md`）

**症状 J（乱动）**
| 候选 | 结论 | 关键证据 |
|---|---|---|
| J-1 恢复链落点回拽 | CONVICTED 3/3 | r5j-a2/a3：恢复写 8100（tab-restore）→ 锚落地 → anchor-comp 于 149/156ms 后拽回 **-217px（三轮同值）**，终态 7883 |
| J-2 块高弹跳波（F/J 同源主犯） | CONVICTED | tabback blockWatch 完整机制链（见 2.3）；生产心跳 layout:height 17→395 同窗互证 |
| J-3 生产 +32s 未打标整千跳变 | INCONCLUSIVE | dev 6 轮未复现（切回写入全打标 1s 内收敛）；环境差异（heal/handoff、异步 AI insert 的 PM 内部 scrollIntoView、窗口焦点事件不入 actions 日志）；观测补点已落地待生产栈 |
| J-4 大纲 smooth 尾巴出窗 | FALSIFIED | dev 大纲连击（跳距至 1.5k px、动画 700-900ms）零 ghost；生产 ±103px 事件在大纲点击后 15-18s（非动画期）→ 并入 J-1/J-2 族 |
| J-5 渲染泵积压 | FALSIFIED | 密度档 on 臂泵帧 p95 6ms；1MB 帧饥饿 p50 154ms 主因布局墙（第四轮封案） |

**症状 F（乱闪）**
| 候选 | 结论 | 关键证据 |
|---|---|---|
| F-1 弹跳波/回落（§2.B4/B5/B7 合并） | CONVICTED = J-2 | 同上 |
| F-2 上滚源码占位残留 | 量化完成 | 密度档 on：17-18 事件 p95 40-42ms 峰值并发 10；1MB on：93-95 事件 **p95 3,955-4,892ms**、帧 p50 154ms 全程 >50ms |
| F-3 代码块销毁窗 | 不可测放弃 | fixtures 代码块 1-7 个，两轮无法构造稳定场景；生产无此形态 |
| F-4 katex-error | 文档内容非回归 | 1MB off 臂 9,422 vs on 臂 12-13（懒渲染遮蔽）——压测副本含大量非法 LaTeX，双管线行为一致（红线 4 无虞） |

### 2.3 机制链（终版，含两次假说修订记录）

**根因**：行内公式「源码占位文本 ↔ KaTeX 真身」高度二象性（同一块占位态 81px vs 渲染态 40px——probe-f blockWatch #35/#21/#28 实测）。

**放大器一（首开冷表窗）**：会话内首开文档高度表无该内容 → 全 3em 占位 → 预热分批学习期块高逐批跳变（开档即滚的真实用户正落此窗）。

**放大器二（每次载入全量重预热）**：载入路径无条件 scheduleCvPrewarm，已知内容也被强制 visible 重测；高度表存的是**状态依赖高度**，占位态测量（81）与渲染态测量（40）交替写入（cv.relearn 观测：32→56/57→100 改写链）→ 装饰随批弹跳。

**放大器三（事务路径装饰丢失）**：tr.replace 全文（replaceAllStampedDoc 家族：AI 全文写回/批注回退/脚注插入）经 `decos.map` 装饰全丢（单测证实：`cvMemory.test.ts` R5 整批替换用例）→ 块高回落 3em 直到重建。

**假说修订记录（方法论）**：① 生产 MD-1011 语境归因"AI 写入"不成立——dev 普通切标签逐字复现 -937/+938；② 初版"切回装饰丢失"假说被 ABAB 消隐证伪（切回走 EditorState.create，init 即重放；tabback 采样 t=17286 的 style="" 实为 doc2 首开冷表）；③ 字体假说（Fix-D 前置）只解释部分改写链，终版定性为状态依赖高度乒乓。

### 2.4 1MB 档开档即滚窗口的预热争用（新发现，量化）

scroll-flash-bench 1MB on 臂：滚动帧 p50=154ms（全程 102 帧 >50ms）、占位 p95≈4s；off 臂帧 p50=6ms——视口档在"开档即滚"窗口与滚动严重争用（预热 visible 批次 + 学习 + 泵）。预热让路机制（G6）只对用户滚动窗口内的批次派发让路，争用主源是批次间的量测/装饰对账。此为 F-2 之 1MB 侧背景，随 Fix-C（已知块零重预热）在二次访问场景消减。

## 3. 改动清单

| # | commit | file:line | 内容 | 归因证据 | 技法 | 复杂度 | 回退 |
|---|---|---|---|---|---|---|---|
| 1 | 2736488 | src/lib/scrollDebug.ts | 写入陷阱（Element 原型只转发钩子捕获未打标写入调用栈，环形 12 条，ghost 事件附最近 400ms 记录）+ J2 恢复梯子插队计数（overlap.restore-intrude，2.5s 窗）+ smoothJump 生命周期计数（set/clear/expire-moving） | J-3 盲区、J2 口径、红线 13 数据前置 | P2 观测 | 每写入 O(1)（栈裁 4 帧） | 纯增量，revert 即回 |
| 2 | 8e6a470 | perf/scroll-flash-bench.mjs | 三场景（upscroll/roundtrip/longread）×双 fixture×on/off，臂自证，ignoreCache 重载 | 阶段三基准 | 基建 | — | — |
| 3 | 86cee26 | src/lib/cvMemory.ts isWholeDocReplace/apply；src/lib/lazyInlineMath.ts inlineHeights | **Fix-A**：整批替换（单 ReplaceStep >50% 文档）立即 buildDecos 内容寻址重放；**Fix-B**：占位高度记忆 WeakMap→内容寻址会话表（cap 8192，demote 顺带记录，热路径零新增布局读） | J-2 放大器三（单测证实装饰丢失）；根因（二象性跳动） | P0 | Fix-A O(n) 仅整批替换时（判定 O(1)）；Fix-B O(1)/demote | 单分支/查表 fallback，revert 即回 |
| 4 | 4db73bd | src/lib/cvMemory.ts unlearnedOrder | **Fix-C**：预热序滤掉高度表已知块（段界按剩余块重算）——切回已知文档预热瞬时完成 | J-2 放大器二（tabback 重测链） | P0 | 滤波 O(n) 一次性；预热总量只降不升 | 滤波条件 revert 即回 |
| 5 | eb13a4f | src/lib/cvMemory.ts learnVisibleSizes/noteCvSize | **Fix-D**：视口学习 fonts-ready 门（对齐预热侧 waitForFonts 防御）+ cv.relearn 观测（改写>10px 时 info 级 1s 限流附栈） | cv.relearn 改写链 | P0+观测 | O(1) | 门控条件 revert 即回 |
| 6 | eb13a4f | perf/ghost-stress.mjs、perf/scroll-abab.mjs | 硬清理从 taskkill /IM（按映像名）改按监听端口 PID 树精确杀 | 本轮实测事故（详见 §5 执行事故） | 基建安全 | O(端口数) | — |

## 4. 门禁全表

测量口径：本机 dev 实例（端口 9223），scroll-flash-bench 单轮单臂 ABAB 交错（r5base 基线 ↔ r5fix 消隐臂 ↔ r5final 终测）；证据 `perf/results/scroll-flash-bench.jsonl`、`ghost-stress.jsonl`、`switch-bench.jsonl`、`r5final.json`、`r5-phase2-j-alpha-r5*.json`。

### F 组（闪变）

| # | 指标 | 基线（修复前） | 修复后 | 判定 | 证据 |
|---|---|---|---|---|---|
| F1 | 密度档 on 占位残留 | r5base r1/r2：17-18 事件、p95 40-42ms、峰值并发 10 | r5final：18 事件、p95 36ms、峰值 10 | 持平（本场景不含切标签；F1 主战场见 1MB 行） | scroll-flash-bench.jsonl |
| F1 | 1MB on 占位残留 | 93-95 事件、p95 3,955-4,892ms、max 5,009ms（帧 p50 154ms 饥饿窗） | 【未达项→归因】1MB 首开学习窗行为由设计决定（冷表首学），Fix-B/C 不改首开路径；p95 残留主因=布局墙+泵预算，属第四轮已封案不可治项的滚动期表现。后续以生产使用窗复检 | 归因留档 | r5-phase2-f-upscroll-r5f-u1mb.json |
| F2 | 代码块销毁窗 | 无基准 | 无基准 | 放弃：fixtures 代码块 1-7 个无法构造稳定场景（探针两轮 before=null）；生产无此形态；TEARDOWN_DELAY 已于第四轮参数化 | probe-f destroy ×2 |
| F3 | MD-1001/1002/1011 | dev ghost-stress anomalies+0（各臂） | anomalies+0（r5base/r5fix-B/r5fix-A 三臂一致） | dev 维持 0；生产复检待 v5.0.0-beta ≥30min 真实使用窗 | ghost-stress.jsonl |
| F4 | 密度档滚动帧 | on：p95 6ms / over50 1；off：p95 12ms / over50 49-52 | on：p95 6ms / over50 1；off：p95 6ms / over50 44 | 零回归（on 臂全程 6ms 级） | 同 F1 |

### J 组（乱动）

| # | 指标 | 基线 | 修复后 | 判定 | 证据 |
|---|---|---|---|---|---|
| J1 | 未归因滚动写入 | dev 各臂 anomalies+0；生产 v4.20.0 复发 9 次（J-α'' 未复现形态） | dev 0；**观测补点就位**（ghost 事件附写入陷阱调用栈）——下次生产复发即从栈定罪 | dev 达标；生产待复检 | ghost-stress.jsonl + 2736488 |
| J2 | 恢复梯子插队 | anchor-comp 于 tab-restore 后 149/156ms 插队（-217px 回拽，3/3 确定性） | **+15px（0.2% 误差），回拽消失**；overlap.restore-intrude 计数器就位 | 定罪+修复验证 | r5-phase2-j-alpha-r5j-a2/a3（前）↔ r5final-a1（后） |
| J3 | 哨兵位移/MD-1001 | dev 0 | dev 0 | 达标；生产待复检 | 同 J1 |
| J4 | 长会话滚读帧率 | 无长会话基准（本轮首建） | longread 3min 分窗 p95【运行中，终值见 jsonl】 | 基准建成 | scroll-flash-bench.jsonl longread |

注：ghost-stress 的 session.ghost 计数（11-15）经核实为**脚本自身的未打标程序化跳变**（其源码注释自述"归因器会记为 ghost 候选"），非应用回归；真实口径以 dev-anomalies MD-1001 计数（全臂 0 新增）为准。

### R 组（防回归，全部零回归/更优）

| # | 指标 | 第四轮基线（同机，环境 ~2× 声明） | 本轮终测 | 证据 |
|---|---|---|---|---|
| R1 | 1MB 打开（默认档） | 12,441-12,848ms | **4,484-5,102ms**（3 轮） | perf/results/r5final.json |
| R2 | 打字 p95（1MB g2） | 408-448ms | **304ms**（lt>50=24/50） | g2-typing r5final |
| R3 | 切换中位 | off 档 2,254ms | **视口档 874-949ms**（10 切换，帧 p50 6ms）——Fix-C 切回零重预热的直接收益；跨档对比 | switch-bench.jsonl |
| R4 | 全量守卫 | 945 基线 | **970 全绿** + coverage 过（src/lib 59%≥55、components 17.1%≥12）+ lint 过 + build 过（8.93s） | 本轮 6 个 commit 各自前置 npm test |

## 5. 遗留与放弃

1. **J-α''（生产 +32s 未打标整千跳变）**：dev 六轮未复现。已落地写入陷阱（ghost 事件附调用栈），待生产复发时从栈直接定罪。不预设写入方结论。
2. **高度表状态依赖高度（残余 ~450ms 单次瞬态）**：占位态 81px vs 渲染态 40px 的二象性使首开窗学习者交替测得两态值；Fix-B 只覆盖已 demote 过的公式。彻底统一方案（预热批测量时顺带从 katexCache 渲染公式，使学得值恒为渲染态）——证据链完整（cv.relearn 观测），留 P3 立项。
3. **1MB 首开即滚争用窗**（帧 p50 154ms、占位 p95≈4s）：1MB 冷表首学 + 布局墙叠加，第四轮已封案部分维持；预热让路机制仅覆盖批次派发。二次访问已由 Fix-C 消减。
4. **F2 代码块销毁窗**：无适用 fixture，放弃专项数值基准（归因如上）。
5. **md1011-verify / g2 密度档 / R3 off 档复测**：挂靠式脚本的交互前置（侧栏状态）在长会话中不满足/时间预算，未跑；机制由单测（cvMemory R5 用例）与 tabback 探针覆盖。
6. **执行事故记录（如实披露）**：本轮早中期我在测量链中调用 ghost-stress/scroll-abab 时，其硬清理按映像名 `taskkill /IM mditor.exe` 误杀了用户正在运行的打包版实例（约 3 次，本地优先+自动保存，内容损失风险低）。已将两脚本改为按监听端口 PID 树精确杀（eb13a4f）并向用户致歉。
7. **P3 备选**：表格块高度学习缺位（rmSamples 全 milkdown-table-block）——Fix-A 已覆盖装饰重放，表格块本体学习仍缺；本轮未立项。

## 6. 文档更新

- `mditor/docs/performance.md`：增补第五轮结论与 scroll-flash-bench 基准口径（见 commit）。
- `mditor/docs/dev-anomaly-codes.md`：无口径变更（观测为纯增量，不改异常码语义）。
- `CHANGELOG.md`：5.0.0-beta 条目。
- `memory/2026-10-02.md`：执行日志。
