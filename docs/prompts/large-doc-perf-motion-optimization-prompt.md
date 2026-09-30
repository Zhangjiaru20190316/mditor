# 任务：mditor 大文件性能与动效响应第四轮治理——数学密集中型文档默认路径掉帧为主战场

> 使用方式：新开会话，将本文件全文交给 AI 编码代理执行。前端代码在 `mditor/` 子目录，所有 `perf/` 与 `npm` 命令在 `mditor/` 下运行。动手前必读第 0、1、2、9 节——本任务禁止盲改，禁止重修已修问题，禁止擅自重落地已回退的产品决策。
>
> 前序任务书（体例与本任务连续，背景可查）：`docs/prompts/large-doc-perf-optimization-prompt.md`（第三轮，已结题，报告 `mditor/docs/large-doc-perf-report.md`）、`docs/prompts/scroll-perf-optimization-prompt.md`（公式下标 + 滚动专项，部分被第三轮吸收）。
>
> 【填写】卡顿平台（桌面/鸿蒙真机）：___；可复现卡顿的真实文档路径（若与第 2 节日志画像不同）：___；动效痛点补充（默认已钉死两大痛点：①滚动不跟手/页面自己动，②切换与加载动画在大文档下卡顿）：___。

## 0. 基线状态声明（执行第一步必须核实，禁止假设）

本任务书基于 2026-09-30 仓库状态撰写，关键事实：

- HEAD = `edcb959`（标记 v4.19.0"超大文档自动视口档"），但**工作区有一组未提交改动 = 该功能整体回退**（详见第 4 节回退清单）。有效代码状态 ≈ v4.18.0 + 09-28 保留批（Unreleased）。
- 已知不一致：`package.json` / `Cargo.toml` / `tauri.conf.json` 仍标 4.19.0，CHANGELOG 已把 4.19.0 条目改回 Unreleased——版本号未随回退回退。收尾时顺手对齐（发布事务，非本任务目标）。
- **执行第一步**：`git status` + `git log --oneline -5`，据实记录基线（回退是否已提交、自动档是否仍在/重新落地），报告开头声明。后续一切"默认行为"论述以核实后的代码为准。
- 生产实例（证据来源）仍是 4.18.0——第 2 节全部日志证据**不含任何 4.19 系改动效果**，含保留批（密度旁路/检测器去噪）的效果也没有。

## 1. 角色与主战场

你是资深 Web 文本编辑器性能工程师，熟悉 ProseMirror / CodeMirror / Chromium 渲染管线（布局/合成/光栅化分层、content-visibility、rAF 调度）。本轮不是"再猜一轮优化"，而是沿生产日志已定罪的靶子推进：

1. **P0 主战场：数学密集中型文档默认路径掉帧**——生产日志 MD-9001 ×1,908、MD-1003 ×67，99.4% 集中于同一文档画像（§2）。该画像在当前默认设置下走全量急切渲染，**回退态下没有任何已生效的修复覆盖它**。
2. **动效主线 B1：滚动跟手与"页面自己动"**（ghost 滚动、视口位移、批量替换回落）。
3. **动效主线 B2：切换/加载动画在大文档下的帧节奏**——无现成基准，需先建（这是本任务新增的测量维度）。
4. 承接项 A（第三轮遗留）、长会话 C、证据基建 D、顺带项 P3。

方法论铁律沿用第三轮：**先测后改、一次一项、ABAB 交错、证据不成立不动手、达不到假设就回滚**（§6）。

## 2. 生产日志证据摘要（2026-09-30 聚合，全部真实数字）

来源：`%APPDATA%/com.mditor.app/logs/`（prod 实例，v4.18.0；`dev-anomalies.log` 现卷 09-26~09-30 + `.1` 旧卷 ≈09-22~09-28 含 4.17.1 尾部；`memory.log` 自 08-14；dev 实例 `com.mditor.app.dev/logs/` 停留在 4.15/4.16 **已陈旧不可用**）。写入路径：`src/lib/devMode.ts`（50 行/1s 批、2MB 轮转）→ Rust `append_log`（`src-tauri/src/commands.rs:53`）。异常语义见 `mditor/docs/dev-anomaly-codes.md`。

### 2.1 异常总表（两卷合计）

| 码 | 含义 | 现卷 | 旧卷 | 文档画像与状态 |
|---|---|---|---|---|
| MD-9001 | 持续掉帧（30s 窗 >50ms 帧间隔 ≥10） | 1,154 | 754 | **1,896/1,908 在《无穷级数习题集_CMC备战.md》**（105KB/2,159 行/2,356 行内公式）；按天 09-26 ×838、09-27 ×902、09-28 ×157、09-30 ×2——持续活跃。心跳侧证：katexNodes 峰 2,355、**domNodes 峰 154,557**（105KB 文档 15 万 DOM = 急切渲染代价签名）、每窗 jankFrames 10-99。**活问题（P0）** |
| MD-1003 | 主线程阻塞 >1s | 37 | 30 | 最坏 4,489ms，3s+ 多条；含《解题技巧总汇》（35KB/732 公式）**切标签 1~4.5s 阻塞**——即动效主线 B2 的极端表现。**活问题** |
| MD-4011 | DOM 节点持续增长 | 8 | 72 | 旧卷 72 条 = 09-24/25 同文档同 gain(56,650) 台阶假阳性连报（已被保留批"尾半窗斜率过滤"修，未发布）；现卷 09-30 02:22-02:25 每 30s 连发 ×8 在《无穷级数_习题集.md》（同一文档变体）——**需新检测器复检定性**。部分活问题（C1） |
| MD-1001 | ghost 滚动（页面自己动） | 0 | 47 | 全部 4.17.1（09-22/23）：《多元微分学专题》54KB ×41 + 《多元微分学习题集》×6；样本 ↓73px 连发、lastWrite=file-open@15.7s、big=false。**4.18.0 窗零复发但未刻意复验**——B1 先复现再定罪 |
| MD-1002 | 视口内容大幅位移 | 0 | 4 | 同期 4.17.1，与 MD-1001 同族 |
| MD-1011 | PM 顶层块批量替换→remembered size 丢失→回落 3em 占位 | 2 | 11 | 样本（09-28）：-937/+382，937 个 milkdown-table-block 整批移除（解题技巧总汇，AI 写入/揭示/粘贴/撤销类场景）——视口档高度记忆被结构海啸冲掉，滚动位置跳变。**活问题（B3）** |
| MD-10002 | 云同步删除失败 | 0 | 517 | 已根修（moveFileWithFallback 跨盘 rename→copy 回退），保留批未发布——P3 打包版验证 |
| MD-5012 | 资源加载失败 | 0 | 27 | 空 src 噪声，已过滤（保留批未发布）——P3 验证 |
| MD-4001 / 6004 / 7002 | 堆增长 / 文件监听 / IO 缓慢 | 1 / 1 / 2 | 0 / 2 / 1 | 零星；MD-4001 为重建余波候选，不构成行动依据 |
| panic | tao-0.35.3 退出竞态 | 1 | — | 上游无害，升级 Tauri 时自然带走，留档不改 |

### 2.2 内存侧证（memory.log，13,394 探针）

slope >2MB/min 占 428（3.2%）、>10MB/min 占 243（1.8%）；极端值 27.7MB/min **全部来自 08-13/14 旧版本窗口**，近期信号以 MD-4011 为准。长会话退化（C 轨）证据强度：中。

### 2.3 日志解读陷阱（违反即得出错误结论）

1. **worstGapMs 是会话累计值**：现卷 1,152/1,154 条 MD-9001 的 worstGapMs 是同一个 5,968ms（某次挂机/最小化间隔顶高的会话 max 复读到轮转）——4.18.0 没有去噪补丁，**该字段在此版本完全不可作证据**。窗口口径唯一可信的是 detail 里的 jankFrames（10-99/窗）。
2. **心跳 frame.\* 字段同为会话累计**（如 jankFrames 53,792 @ 45M frames）：分析必须对相邻心跳做差分。
3. **输入延迟探针全零存疑**：所有心跳 worstInputLagMs=0、MD-9003 零触发——要么生产窗内确无 >100ms 打字卡顿（用户在滚动/阅读而非打字），要么按键→帧探针本身没接上。D4 必须先证明探针有效再引用其数据。
4. **跨版本计数不可比**：保留批（去噪 + 窗口口径 + 台阶过滤 + 空 src 过滤）发布后，MD-9001/4011/5012 的计数口径全部变化，与 4.18.0 日志不可直接对比；对照实验必须声明检测器版本。
5. **旧卷混版本**：`.1` 卷含 4.17.1 尾部（ghost 簇全部在此），归因前先看 `env.ver`。

## 3. 可量化目标（门禁表；判分：P 组至少 3/4、M 组全部不回归且 M2/M3 至少一项达成、V 组全部有数据，未达项附归因）

已知基线来自 `mditor/docs/large-doc-perf-report.md`（第三轮终测，1MB 档 = `perf/fixtures/一元微分学习题集_1MB压测副本.md`）与本任务新建设施。执行时一律先按 §6 复测本机基线。

### P 组：实际性能

| # | 指标 | 已知基线 | 目标 | 测量 |
|---|---|---|---|---|
| P1 | 1MB 档打开（默认档 / 视口档） | 12,479ms / 5,466ms | ≤18s / ≤6s（维持，防回归） | `MDITOR_DOC=1MB node perf/open-1mb.mjs` |
| P2 | 打字逐键延迟 p95（baseline 七场景口径，1MB） | 448-536ms（第三轮未达 360，归因 I5 内生 + 装饰 diff 占 65%） | ≤360ms；仍不达则装饰削减原型（A1）数据说话，记「未达成（附证据）」 | `MDITOR_DOC=1MB node perf/baseline.mjs` typing；`node perf/profile-typing.mjs` |
| P3 | 搜索计数 / Ctrl+S | 0 长任务（第三轮 S1 增量序列化后） | 维持 0 长任务 | `node perf/bench-export-search-save.mjs` |
| P4 | **密度档基准（新建，D1）**：打开 / 滚动 p95 / 切标签阻塞 | 无基准（生产定罪：打开余波滚屏 MD-9001 每窗 10-99 jank；切标签 1~4.5s） | 打开 ≤3s；滚动 p95 ≤50ms；切标签无 >1s 长任务 | 新基准脚本（§7 D1），fixture 固化 105KB/≈2,400 公式画像 |

### M 组：动效响应

| # | 指标 | 已知基线 | 目标 | 测量 |
|---|---|---|---|---|
| M1 | 滚动回归（224KB/1MB 两档，on/off） | 第三轮终测 B/A：on 0.82 / off 1.00 | 零回归（劣化 >10% 且多轮方向一致才算） | `node perf/scroll-abab.mjs --doc <名> --viewport on\|off --round N` |
| M2 | ghost 滚动 / 视口位移复发 | 4.17.1 ×47→4.18.0 ×0（未复验） | 压力场景（≥30min：滚读+开合侧栏+告警卡开合+切换+AI 写入）MD-1001/1002/1011 归零，或定罪+修复后归零 | 新建 ghost 压力场景（D3）+ scrollDebug 哨兵（`__scrollDebug`）读数 |
| M3 | **切换/加载动画帧节奏（新建基准，D2）** | 无基准；MD-1003 切标签 1~4.5s 是极端表现 | 大文档往返切换 ≥20 次：动画期帧间隔 p95 ≤32ms、>50ms 帧 = 0；切换总时长不劣化 | 新建 switch-bench（D2）：CDP frame 录制 × useSwitchFlow 全链路 |
| M4 | 输入→上屏延迟 | 生产探针恒 0（存疑）；第三轮 g2 口径 296-312ms | 探针有效性证明 + 密度档打字 p95 ≤360ms | `node perf/g2-typing.mjs` + D4 探针验证 |

### V 组：生产验证（回退态构建 + 保留批检测器）

| # | 指标 | 4.18.0 对照 | 目标 | 测量 |
|---|---|---|---|---|
| V1 | MD-9001 复发（窗口口径 jankFrames） | 10-99 jank/窗 ×1,908 | 打包版 ≥30min 真实使用/回放 0 窗触发；技术侧用尽仍未达 0 → 归因并升级为提案（§6 P0-C）待拍板，**不许为凑指标改默认** | 打包（`perf/prod-formula-smoke.mjs` 冒烟）+ 复放密度档文档 + 日志复析 |
| V2 | MD-4011 假阳性过滤 | 72 连报 | 新检测器下同场景 0 连报；真泄漏仍能报 | 日志复析（对照 09-30 ×8 样本定性） |
| V3 | 心跳差分口径工具化 | 无 | jankFrames/DOM 差分分析脚本落 `perf/`（对 4.18.0 旧日志跑通 = 陷阱 2 的机器化） | 新脚本（D5） |

## 4. 已核事实集（直接采用，不要重查）

### 4.1 回退清单（工作区未提交，相对 edcb959——执行时先核实是否仍如此）

- 删除：`bigDocViewportAuto` 默认开设置（defaults.ts）、`sizeIsHugeDoc` / `BIG_DOC_HUGE_BYTES=1MB` / `BIG_DOC_HUGE_BLOCKS=8000`（memory.ts）、设置面板入口与三处同步点位（App/useSettings/useMilkdown/SettingsModal/settingsNormalize/types）、`memory.test.ts` 体量档 11 例、CHANGELOG 4.19.0 条目（改回 Unreleased）。
- 效果：`isBigDocCv` 恢复"两开关全关 → false"——**超大文档与数学密集中型文档默认都不入视口档**。提案 `mditor/docs/proposal-bigdoc-viewport-auto.md` 回到「待拍板」，含数据 A（1MB 档）与数据 B（密度档生产证据表）。

### 4.2 保留批（fc50e62，Unreleased，随本轮构建生效）

- 视口档公式密度旁路：`BIG_DOC_MATH_DOLLARS=800`（≈400 公式，`src/lib/memory.ts`）——**但受 bigDocViewport/bigDocPerformance 手动开关门控，默认关，因此对生产主灾区默认不生效**。
- 检测器去噪：visibilitychange 清帧基线 + `windowWorstGapMs/windowWorstInputLagMs` 窗口口径（`src/lib/scrollDebug.ts:534-539,962,1017`，MD-9001/9003 改报窗口值）；MD-4011 尾半窗斜率过滤；MD-5012 空 src 过滤。
- 云同步跨盘删除根修：`moveFileWithFallback`（rename 失败回退 copy+delete，copy 失败保源）。
- vitest 926→942。

### 4.3 第三轮资产（保护，无归因证据不得动）

增量序列化 `src/lib/incrementalSerializer.ts`（O(doc)→O(变更块+拼接)，差分测试 362 行）；行内公式懒渲染+渲染泵 `src/lib/lazyInlineMath.ts`（静止门 400ms、帧预算 10ms、双门控）；cvMemory 分片重建 + 预热让路（`src/lib/cvMemory.ts`，881 行，8ms 预算自适应批）；KaTeX HTML LRU `src/lib/katexCache.ts`（8,192 条/8MiB）+ 空闲预热 `src/lib/mathCachePrewarm.ts`；sv 脏标记（`src/lib/svCodeMirror.ts`）；ghost 滚动四层补偿链（viewportAnchor/cvMemory/prewarm-comp/anchor-comp，`overflow-anchor` 刻意禁用于 `src/styles/global.css:1082` 附近）；装饰增量映射；打字监听 200ms 防抖+rIC（patches/@milkdown+plugin-listener）。视口化本体：`global.css:1732` content-visibility + `Editor.tsx:1263` data-big。
已评估关闭（勿重开）：I2 centerCaret（证据不足）、S2 序列化 worker 化（S1 后无剩余收益）、M1 导出分片（依赖 `exporterProbe.ts` 不在仓库——若重启先补齐该依赖）。

### 4.4 待核实一项

公式下标渲染缺陷（scroll-perf 任务书任务一，`F_1'` 下标掉落/分子消失）：f4ef4f0 是 `$$` 收尾探针修复**不是它**；线索指向 09-22 已完成工作流「LaTeX 公式错位修复」与 `src/lib/mathKatexDedupe.test.ts`（含上下标真实文档用例）。执行时用最小公式文档双路径（编辑器块级预览 + 静态管线）目检定案，30 分钟内可完成；已修则在报告留档关闭，未修则按原任务书步骤单独立项（正确性优先于一切性能项）。

## 5. 架构与动效资产速览（定位用，勿改）

- 打开链路：读盘 → parsePipeline/docCache（内容寻址）→ loadMarkdownFull → 全量 nodeview 急切渲染（默认档）。档位判定 `src/lib/memory.ts`：减配档 isBigDoc（500KB/3000 行，砍 KaTeX/CM）、视口档 isBigDocCv（同阈值 + 密度旁路，开 content-visibility+懒公式）。
- 切换链路：useSwitchFlow（`src/hooks/useSwitchFlow.ts`）+ `src/lib/switchTiming.ts`（`MIN_SWITCH_MS=300` 最短可见加载条、`remainingSwitchDelay`、`needsPaintYield`——首帧让路）。动效档位 `src/lib/motion.ts`（none/balanced/lively，html[data-motion] + prefers-reduced-motion）。
- 帧检测：`src/lib/scrollDebug.ts` rAF tick 常驻（窗口/会话双口径、ghost 归因、longtask PerformanceObserver）。诊断总线四条 + 30s 心跳 + MD-XXX 分类器（`src/lib/devAnomaly.ts`）。

## 6. P0 主攻：数学密集中型文档默认路径掉帧

定罪链（已完备，直接用）：105KB/2,159 行文档携带 2,356 个行内公式 → 急切渲染 15.4 万 DOM（心跳实测）→ 500KB/3,000 行双阈值永不触发（big=false）→ 每个交互窗 10-99 帧 >50ms（MD-9001 ×1,896）+ 秒级阻塞（MD-1003 ×67，最坏 4,489ms）。字节/行数是错误度量，公式数才是成本度量（数据 B：170 公式零异常 / 551+ 公式持续阻塞，阈值间隙取 800 `$`）。

三条推进路线（技术侧先行，产品决策隔离）：

- **P0-A 基准固化（先行）**：把生产画像固化为 fixture（105KB/≈2,400 行内公式；从生产文档脱敏复制到 `perf/fixtures/`，或给 `gen-bigdoc.mjs` 加密度参数——只许改生成参数不许改测量口径）。建打开/滚动/切标签三场景基准（P4）。
- **P0-B 默认急切渲染降本（不碰任何默认设置）**：候选按证据选——打开期 KaTeX 渲染分帧化（rAF/idle 切片，把 3.5-4s 纯 JS 摊开，注意 bb2ddbd 教训：默认档无 content-visibility 时块高变化=全文档回流，任何"分批挂载"必须证明布局范围不放大或布局等价）；katexCache 预热时机提前；密度档下装饰/监听器常驻成本削减（profile-typing/profile-callers 归因）。每项独立假设、独立 commit。
- **P0-C 视口档覆盖这批文档（提案级，红线 8/9）**：唯一已被数据证明全面占优的路径（数据 A/B：打开 12.5→5.5s、滚动 p95 251→82ms、点公式 728→88ms），但"默认开启"属产品决策且 **v4.19 自动档刚被用户明确回退**——推进该方向必须：先向用户确认回退缘由 → 以提案形式重提（可引用/更新 proposal-bigdoc-viewport-auto.md）→ 拍板前只做技术铺路（预热提速、滚动中源码占位体验优化、与切换动画的衔接 B2）。**禁止未经拍板改默认值或重新引入 bigDocViewportAuto**。

## 7. 分层工作清单（格式：编号 优先级｜问题与位置｜改法｜验证；凭实测可重排，报告说明理由）

### D 证据基建（先于一切优化）

- **D1 密度档 fixture+基准** P0｜生产画像无基准，P4 无法度量｜见 §6 P0-A｜P4 三场景 ≥3 轮。
- **D2 switch-bench** P1｜切换/加载动画零基准（M3）；CDP frame 录制叠 useSwitchFlow 状态机，大文档间往返切换，量动画期帧间隔分布与 >50ms 帧数｜新建 `perf/switch-bench.mjs`（沿用 cdp.mjs FRAME_RECORDER）｜M3。
- **D3 ghost 压力场景** P1｜MD-1001 ×47 未复验；场景=滚读+侧栏/告警卡开合+切换+AI 写入 ≥30min，读 `__scrollDebug` 与 dev-anomalies｜复用 scrollDebug 哨兵，脚本化进 perf/｜M2。
- **D4 输入延迟探针验证** P1｜生产 worstInputLagMs 恒 0 存疑：单测探针逻辑 + dev 实例人为制造 >100ms 延迟确认能触发 MD-9003｜探针修复或有效性证明｜M4。
- **D5 心跳差分脚本** P2｜frame.*/domNodes 会话累计，人工差分易错｜`perf/heartbeat-diff.mjs`：读 dev-events 两卷输出窗口级 jank/DOM 增速表｜V3（对 4.18.0 旧日志跑通即验收）。

### B 动效主线（与 P0 共享基准）

- **B1 ghost 复现与归因** P0（M2）｜4.17.1 ×47：41-42px 往复 + ↓73px 连发两形态，big=false，lastWrite=file-open@15.7s；历史嫌疑=滚动锚定×告警卡开合（overflow-anchor 已禁用，但 anchor-comp 补偿链在程序化写入路径上）｜D3 复现 → scrollDebug 归因（recentWrite/程序化 scrollTop 写入源枚举）→ 修复；无法复现则产出"为何自愈"结论 + 回归守卫测试｜M2。
- **B2 切换/加载动画帧节奏** P0（M3）｜MD-1003 切标签 1~4.5s：切换期全文序列化快照/编辑器重建/加载条动画被长任务饿死；switchTiming 的 needsPaintYield 是否让路到位未量化｜D2 基准 → CPU 归因（profile-callers）→ 修复（切换链路长任务分片/延迟到加载条动画结束后）｜M3 + P4 切标签场景。
- **B3 MD-1011 结构海啸→占位回落→跳变** P1｜AI 写入/揭示 -937/+382 顶层块整批替换，cvMemory remembered size 随旧元素消亡丢失→3em 占位→视口跳；MD-1002 同族｜cvMemory 高度表按内容哈希恢复（已有 FNV-1a 内容寻址，替换前后内容未变块可复活高度）；批量替换的事务合并/装饰保持策略｜D3 场景含 AI 写入；cv-correctness 等价测试。
- **B4 打字跟手** P2｜与 P2/A1 同源，归因后随 A1 走｜见 A1｜P2/M4。

### A 承接项（第三轮遗留，凭本轮证据启动）

- **A1 装饰数量削减原型** P1｜G2 出路：1MB 档装饰 diff（forChild+valid）占打字每键 65%（profile-typing-ctx-\*.cpuprofile）；cvMemory 高度表 decoration 承载量 ~11.6k 块｜方向：高度表分段/按需携带（视口外用 CSS 变量或粗粒度段表）、decoration 合并；必须按创新算法条款先纯 node 原型｜P2。
- **A2 批注盖章增量** P2｜useAnnotationMarkers 60ms 防抖每轮 querySelectorAll 全树扫描｜只扫 mutation 命中子树｜probe-domchurn + 批注测试。
- **A3 大纲增量索引** P2｜walkHeadings 每事务 O(doc) descendants｜顶层块前缀位置增量索引（cvMemory posOf 表是雏形）｜大纲跳转正确性测试。
- **A4 rIC 600ms 硬超时** P3｜plugin-listener rIC 超时强行落地序列化（S1 后单次成本低，评估调高或 scheduler.yield()）｜G3 口径复测。
- **A5 导出分片** P3｜juice+htmlToDocx ~4s 主线程；依赖 `src/lib/exporterProbe.ts` 缺失——先重建该探针再立项｜bench-export-search-save + 产物抽检。

### C 长会话退化

- **C1 MD-4011 定性** P1｜09-30 ×8 复发（无穷级数变体文档）在新检测器下复检：真泄漏（nodeview teardown 残留/游离 DOM）还是仍漏过的台阶｜D5 差分 + heap 快照对比；真泄漏则修 teardown，假阳性则调过滤｜V2。
- **C2 内存监视口径** P3｜memory.log slope 极端值是 8 月旧版本数据；近期以心跳差分为准｜并入 D5。

### P3 顺带项（主线完成后有余力再做，每项独立 commit）

- MD-10002 云同步跨盘修复的打包版验证（517 条主灾区，修已就绪只欠验证）。
- MD-5012 空 src 过滤的打包版验证。
- MD-6004 ×2 文件监听异常、MD-7002 ×2 IO 缓慢：日志抽样定性，能修则修，不能则留档。
- 版本号对齐（见 §0）。

## 8. 创新算法条款（继承第三轮，全文有效）

欢迎自研算法（先例：cvMemory 高度表 = CodeMirror heightmap 富文本版；候选：块级前缀位置数组/行号↔offset↔PM pos 的 B 树索引服务大纲/搜索/批注二分、增量 AST 失效传播、序列化 piece-table 对偶）。规则（不满足不得合入）：①复杂度分析（前后最坏/摊还）+ ≥3 规模档实测曲线（53KB/224KB/1.5MB + D1 密度档）；②纯 node 脚本原型先行；③运行时开关或自动降级路径 + 触发条件测试；④序列化/索引类 ≥1000 次随机编辑差分等价断言（含撤销/重做/粘贴）；⑤不牺牲第 9 节任何红线。

## 9. 约束与守卫（红线，违反=制造回归）

1. **不得擅自重新落地已回退的 v4.19 自动视口档**（bigDocViewportAuto / sizeIsHugeDoc / 默认开启路径）——该决策已被用户明确回退；重提必须先确认回退缘由、走提案、等拍板（§6 P0-C）。
2. **动效语义红线（新）**：不得以砍动画、降帧率、延长加载条、默认关动效来"换"性能指标；motion 三档语义与 prefers-reduced-motion 行为不变；MIN_SWITCH_MS=300 的"最短可见加载条"产品语义不变；性能优化不得夹带任何视觉行为变化。
3. **日志口径红线（新）**：跨版本异常计数对比必须声明检测器版本；4.18.0 及以前的 worstGapMs/心跳 frame.\* 会话累计字段不得作窗口证据（§2.3）；本轮新增分析结论一律基于差分后的窗口口径。
4. KaTeX 双管线行为不变、单实例（overrides 钉 0.18.4）；块公式不得塌陷（历史 CSP/双实例两次回归）。
5. 全量守卫：每优化 commit 前 `npm test` 全绿（942 基线，以实跑为准）；收尾 `npm run test:coverage`（阈值不下调）+ `npm run lint` + `npm run build`；tableBlockPatch / md1011-regression 等既有守卫不跳。
6. remark 插件集改动三链路同步哨兵 expectedPluginCount（parseWorker/remarkPipeline/编辑器 remarkCtx），失配即静默回退主线程解析。
7. 已有性能资产（§4.3 清单）与 ghost 四层补偿链无归因证据不动。
8. 不做整篇虚拟化/分块渲染（既有决策）；任何使视口外内容不再参与查找/跨视口选区/批注盖章的渲染改动都算触线，走提案级重评。
9. 改 node_modules 必须 via patches/（patch-package）。
10. 涉及默认设置/产品决策的改动单独成提案等用户拍板，不合入默认行为。

## 10. 方法论与环境（先测后改六步，逐项闭环）

1. **基线**：对应 perf 脚本 ≥3 轮 ABAB 交错，落盘 `perf/results/`。
2. **定位**：拿证据不许凭直觉——`profile-typing/scroll/select.mjs` CPU self-time、`profile-callers.mjs` 调用方聚合、`rect-spy/rect-spy2.mjs` 强制布局、`probe-domchurn.mjs` DOM 放大、`first-interaction.mjs` 事件阶梯定罪。
3. **假设**：可证伪句子（"改动 X 应把 Y 的 Z 从 A 降到 B"）。
4. **单项改动**：一次一项、独立 commit、附回归测试。
5. **A/B 对比**：同窗 ABAB 交错（A/B/B/A ≥3 轮，禁止顺序测量；时段漂移实测 2-3 倍，跨时段单轮不可信）。代码版本切臂用 `git stash`/`checkout`，切臂后确认 vite HMR 生效。
6. **保留或回滚**：达假设才保留；达不到且无新证据解释则回滚并记录。

环境前置（坑均已踩过，照做）：CDP 系脚本共同前置 `set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` 后 `npx tauri dev --config src-tauri/tauri.dev.conf.json`（独立 identifier com.mditor.app.dev）。**文档钉定**：`MDITOR_DOC` 环境变量文件名子串匹配（1MB 档一律 `MDITOR_DOC=1MB`；不钉会静默测错档——baseline.mjs 默认串同时命中 224KB 原件与 1MB 副本）；select-bench/verify-search-count/parse-time 硬编码文档名，用于 1MB/密度档前先改脚本钉文档（perf/ 脚本允许改文档选择/生成参数，不许改测量口径与既有结果文件）。dev 实例先开目标文档 `node perf/open-doc.mjs <名>`。守卫命令见红线 5。

## 11. 交付物

报告写入 `mditor/docs/large-doc-perf-motion-report.md`（新建），必须包含：

1. **基线声明**：§0 核实结果（git 状态、有效代码基线、版本对齐处理）。
2. **改动清单**：每项一节——commit hash / file:line / 归因证据摘要 / 技法归类（§7 编号或创新算法）/ 复杂度前后 / 回退开关与触发条件。
3. **门禁全表**：P/M/V 三组本机复测基线 vs 优化后（ABAB 中位数，附 perf/results 文件名与轮次）；未达项归因与后续方案，不许留空。
4. **P0 专项结论**：密度档三场景数据、P0-B 各项实测、P0-C 提案进展（若拍板，落地数据；未拍板，提案文档链接）。
5. **动效专项**：D2/D3 基准设计 + M2/M3 数据；ghost 复现/自愈结论。
6. **遗留与放弃**：没做/放弃的项及原因；§4.4 公式下标定案结论。
7. **文档更新**：`mditor/docs/performance.md` 增补本轮结论与基准口径（含密度档 fixture 规格）；`dev-anomaly-codes.md` 如有口径变更同步。
