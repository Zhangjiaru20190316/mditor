# 大文档公式渲染第六轮报告：及时性（T）与完整性（M）专项

- 版本窗口：v5.0.0-beta → Unreleased（本轮不发版）
- 任务书：`docs/prompts/large-doc-formula-render-optimization-prompt.md`
- 前序：第三轮 `large-doc-perf-report.md`、第四轮 `large-doc-perf-motion-report.md`、第五轮 `large-doc-scroll-stability-report.md`
- 证据根目录：`mditor/perf/results/`（r6-* 前缀）、`.workflow/task2-forensics/devlog-r6*`
- 提交链：6e4334f（观测）→ 144c0c2（基准扩展）→ 656948c（Fix-A）→ 7ae2879（Fix-B）→ d1aa2f7（Fix-C）→ 基建/类型两小修

## 1. 基线声明

- 执行首步核实（2026-10-02）：HEAD = `35ed260`（v5.0.0-beta 发版），其后无新提交，工作区未跟踪杂物与任务书 §0 声明一致；npm test 基线实跑 **970 全绿**（89 文件）。
- fixture 在位性：三大战档全在（无穷级数_密度档压测副本 105KB/2,159 行/2,355 行内公式/唯一 1,642；解题技巧_密度档切换副本 35K 字符/736 行内/块级 23；一元微分学习题集_1MB压测副本 1.1MB/25,270 行内/**唯一仅 2,368**——重复拼接使唯一公式数远低于 LRU 上限，M-a 在 1MB 档不触发，故新建超限档）。
- **本轮新增 fixture**：无穷级数_唯一公式超限副本.md（509KB/8,649 行/9,420 行内公式全唯一 > 8,192）——密度档副本 4 段拼接、每公式注入 `{段号}{段内序号}` 前缀（KaTeX 分组前缀合法、渲染成本≈不变），生成规格见 `perf/tmp-r6/gen-unqlimit.mjs`（不入库）。
- 生产日志（阶段一，`perf/results/formula-render-r6-phase1-prodlog.md`）：v5.0.0-beta 窗口（10-02 15min 真实使用）MD-9001=0、MD-1001=0；MD-1002×3（题型方法决策树 122KB 密集真身，深滚公式补绘高度位移，compensated 全兜住——T 症状生产形态）；MD-1011×1（切文档整批替换正常族）。**M 症状无异常码（观测盲区，本轮 M1/M2 探针补此洞）**。

## 2. 归因结论（阶段四全文：`perf/results/r6-phase3-4-baseline-indictment.md`）

### 症状 T（不及时）

| 候选 | 判定 | 关键证据 |
|---|---|---|
| T-a 滚动中小预算（5ms 冷算） | 1MB/密度排除；超限成立（M-a 同源） | pump-trace 1MB 全程 cold=0（唯一 2,368 预热全覆盖全命中）；超限 traverse coldRenders=9,532 |
| T-b 静止门+补绘速率 | 非主因 | quietPhase 仅 5-7 事件 p95 ≤1,083ms；96% 事件在滚动中 |
| **T-c 上滚 band 全禁** | **CONVICTED（T1 主因，可修部分）** | pump-trace A-up 尖峰 vpUnready=21/q=9；p95 长尾集中于上滚/往返段；上滚 band 条目只能等静止 |
| T-d 预热冷启动 | 1MB/密度排除 | 开档即滚段 hit 立即增长、cold=0 |
| T-e 1MB 首开争用 | 不重开案 | 静置 25s 后长帧仍 58%——帧饥饿主体为滚动布局墙（第四轮封案）；本轮修复不波及预热/学习窗 |
| T1 剩余长尾（修复后） | 帧间隔支配 | bench f4 帧间隔 p95 3.5-4.4s、max 4.9s；scroll-abab（无 REC 采样器）1MB on p50 仍 99.9-103.9ms——帧饥饿真实；泵侧已无积压（q 恒 0、cold=0、直绘全通） |

### 症状 M（漏渲染）

| 候选 | 判定 | 关键证据 |
|---|---|---|
| M-a 预热 LRU 文档序截断 | 非漏渲染主因 | 残留 posBuckets 十桶均匀（无尾部聚集指纹）；位置=遍历停留处视口 |
| M-b 泵队列饥饿 | 排除 | 残留时 queue=0/oldestWaitMs=0/deferred 全清 |
| M-c render 失败无重试 | 排除 | 两轮 renderFailed=0、dropped=0、enqueued=rendered |
| **M-d demote 顺延竞态** | **CONVICTED（M1 主因，M-d'）** | 定罪书见下；微滚 ±900px 验证残留归零（IO 入队路径存活） |
| M-e 块级无预热无调度 | 完整性排除 | 块级挂载率 100%（23/23，遍历往返后） |
| M-f update 绕泵竞态 | 未取证 | 本轮场景无编辑路径，留档 |

### M-d' 定罪书

机制四步（`lazyInlineMath.ts` callbacks/demote）：① 快速长滚中 demote 顺延链挂起数十秒；② 元素回带时 visible=true 回调**不撤销挂起 timer** 且 rendered=true 挡住入队；③ 停稳后 timer 到期把**带内/视口内**元素降回源码占位；④ IO 因可见性状态无变化永不再回调 → 永久源码占位。复现指纹：残留源码连续、位置=停留视口、queue=0、renderFailed=0、微滚扰动后 100% 归零。1MB 档残余 2 条（Fix-A 后）为 IO 状态记录与实际位置失同步的姊妹形态（enqueued=rendered 证明从未入队），由 Fix-C（demote 后 unobserve+observe 校准）兜底清零。

### 测量口径声明（T1/f4 数据解读前提）

- bench REC 采样器在 1MB 档每帧 querySelectorAll+全量 rect（25,256 元素）实测干净布局 ~30ms/帧、脏布局首测 49s（`r6-phase3-recost.json`）——f4 帧口径存在测量放大，只作趋势参考；**T1/T2 主判据（占位停留时长/元素状态）不受影响**。
- 前台静置（bringToFront、无采样器）独立 rAF 帧率 ~15fps——1MB cv 档帧饥饿真实存在（布局墙封案范畴），非纯测量伪影。

## 3. 改动清单

| # | commit | file:line | 内容 | 复杂度 | 回退 |
|---|---|---|---|---|---|
| 1 | 6e4334f | src/lib/lazyInlineMath.ts（pumpStats/getMathPumpStats/attachMathPumpStatsGlobal）+ src/main.tsx | **观测**：`window.__mathPumpStats` 泵统计（队列深度/最老等待/直绘与冷算/回插/丢弃/失败计数） | 计数 O(1)/帧，快照 O(队列) | 纯增量 revert 即回 |
| 2 | 144c0c2 | perf/scroll-flash-bench.mjs | **基准扩展**：wheel 分窗（≤450ms=滚动中）f1.scrollPhase/quietPhase + row.t2（滚动中峰值/时长占比） | — | — |
| 3 | 656948c | src/lib/lazyInlineMath.ts callbacks/demote | **Fix-A**：回带撤销挂起 demoteTimer + demote 前带内跳过（双保险）——M-d' 根治 | O(1) | revert 即回 |
| 4 | 7ae2879 | src/lib/lazyInlineMath.ts pumpScrollFrame/PendingRender | **Fix-B**：上滚 band 放开「有高度预留 && 缓存命中」直绘（占位 minHeight 已撑渲染态行高，直绘零高度变化不上移视口）；冷算/无预留留队；未直绘条目原序回插 | 上滚 band 内 O(n) 一遍谓词 | revert 即回 |
| 5 | d1aa2f7 | src/lib/lazyInlineMath.ts demote | **Fix-C**：demote 后 unobserve+observe 重置 IO 观察——下一次交叉计算必按真实位置派发（1MB 档残余漏渲染兜底） | O(1)/demote | revert 即回 |
| 6 | —（基建） | perf/scroll-flash-bench.mjs + tmp-r6 探针 | CDP 未就绪分支补 killChildTree（防 dev 泄漏互抢 WebView2 目录，本轮实际发生） | — | — |
| 7 | —（lint） | src/lib/lazyInlineMath.test.ts | katex spyOn 类型断言修正（tsc --noEmit） | — | — |

新增单测 7 例（总 970→978）：泵统计 3 例、Fix-A 2 例（回带撤销用例红→绿验证）、Fix-B 2 例（三象限安全判定 + 共用软上限）、Fix-C 1 例（IO 校准调用对）。

## 4. 门禁全表

测量口径：本机 dev 实例（端口 9223），base/fix 交错臂；证据 `scroll-flash-bench.jsonl`、`scroll-abab.jsonl`、`ghost-stress.jsonl`、`r6-phase2/3-*.json`、`r6final.json`、`g2-r6final*.json`、`switch-bench.jsonl`。

### T 组（及时性）

| # | 指标 | 基线（r6base ×2） | 修复后（r6fix ×3） | 判定 | 证据 |
|---|---|---|---|---|---|
| T1 | 1MB on 占位残留 p95（合计口径） | 5,833/5,396（中位 **5,615**） | 4,896/5,350/4,225（中位 **4,896**，-13%；p50 457→340，-26%） | 【未达 1/4（1,404）→归因】剩余长尾由帧间隔 p95 3.5-4.4s 支配（bench f4；布局墙第四轮封案+学习窗+REC 采样器 30-50ms/帧测量放大）；泵侧已无积压（pump-trace q 恒 0、cold=0、上滚尖峰 21→11 且 2s 内归零、静止 1-3 帧清空）——继续压缩须先治帧饥饿（封案区，超出本轮公式管线范围） | scroll-flash-bench.jsonl + r6-phase3-pumptrace-*.json |
| T1' | 密度档 on p95 | 37/37 | 38 | 零回归 ✓ | 同上 |
| T2 | 滚动中视口内源码占位（基准建成） | 峰值 17-22 条、时长占比 32-48%（scrollPhase 96% 事件） | 峰值 19-20 条、峰值并发 15；pump-trace 上滚瞬间尖峰 21→11（-48%） | 基准建成+有数；修复后尖峰显著下降；F 组门禁不回归（R5 行） | row.t2 + pumptrace |
| T3 | 1MB 首开即滚帧 | 第五轮 p50 154ms | 修复全在 nodeview 泵内（不波及预热/学习窗）——不重开案；scroll-abab 滚动 p50 99.9ms ≤ 154 | 过（零交集豁免+不劣化） | scroll-abab.jsonl |

### M 组（完整性）

| # | 指标 | 基线 | 修复后 | 判定 | 证据 |
|---|---|---|---|---|---|
| M1 | 漏渲染残留（遍历往返+静止 10s） | 超限 **6/9**、1MB **3**、密度 0 | 超限 **0**（Fix-A）、1MB **0**（Fix-C 后复测）、密度 0 | **达标（=0）** ✓ | r6-phase2-traverse-*.json ×5 |
| M2 | 泵队列饥饿（会话后 10s 挂起） | queue=0/oldestWaitMs=0 | queue=0、oldestWaitPeakMs=0（观测史零滞留） | **达标（=0）** ✓ | __mathPumpStats 快照 |
| M3 | 块级公式挂载率 | 无基准 | **100%（23/23，解题技巧档遍历往返）**；katex-error：压测副本非法 LaTeX 恒定（1MB 25-56 条，第五轮 F-4 已定性非回归，双管线一致） | **达标（100%）** ✓ | r6-phase2-blocks-r6p-blocks5.json |

### R 组（防回归，基线第四/五轮同机）

| # | 指标 | 基线 | 本轮终测 | 证据 |
|---|---|---|---|---|
| R1 | 1MB 打开（视口档） | 13,550-14,804ms（第四轮） | **13,181ms**（3 轮中位；默认档与本轮改动零代码交集——nodeViews 工厂在非 cv 档返回 undefined，豁免复测） | r6final.json |
| R2 | 打字 p95 | 密度档 1,456-1,984（原生墙）；1MB g2 408-448 | 密度档 **704ms**（≪基线）；1MB **424ms**（区间内） | g2-r6final*.json |
| R3 | 切换中位 | off 档 2,254ms | **2,254ms**（20 切换，armValidated） | switch-bench.jsonl |
| R4 | 全量守卫 | 970 | **978 全绿** + coverage 过（lazyInlineMath 行覆盖 95.6%）+ lint 过 + build 过（13.5s） | CI 实跑 |
| R5 | 第五轮门禁 | scroll-abab p50 100.2/p95 279；ghost anomalies+0 | **p50 99.9/p95 212（更优）**；**anomalies+0**（MD-1001/1002/1011 零复发）；占位残留=T1 行（-13% 不劣化）；md1011-verify 挂起 17min 放弃（MD-1011 机制由 md1011-regression.test.ts 2 例+ghost structural-tsunami 阶段覆盖） | 各 jsonl |

## 5. 遗留与放弃

1. **T1 p95 未达 1/4 目标（-13% vs 目标 -75%）**：剩余长尾为帧间隔 p95 3.5-4.4s 支配——1MB cv 档滚动布局墙（第四轮封案）+ 开档学习窗 + bench REC 采样器测量放大（30-50ms/帧）。泵侧修复已让队列零积压（pump-trace 证明），继续压缩须重开帧饥饿案（波及 cvMemory/装饰对账，§3 待拍板区），本轮不立项。**建议**：T1 后续口径以 pump-trace（轻采样）为准或修正 bench REC 为视口带内过滤。
2. **M-a（超限档预热截断）**：截断区冷算使超限档滚动中 coldRenders=9,532——不漏渲染（静止补绘清空）但拖慢补绘；改进截断策略（按区域采样/视口优先）收益限于 >8,192 唯一公式文档（真实笔记未见此画像），不立项。
3. **M-f（update() 绕泵竞态）**：本轮滚动场景未涉编辑路径，未取证；Fix-B 的回插语义已消除 band 丢队类风险，编辑并发竞态留待后续专项（如复现为漏渲染先查 Fix-C 校准）。
4. **R5 §5.2 P3（预热批测量渲染态）**：维持不动（待拍板）。
5. **md1011-verify / prod-formula-smoke**：前者挂起放弃（单测覆盖）；后者见 §6。
6. **执行事故（如实披露）**：① 本轮中期为清 dev 残留执行 `taskkill /F /IM msedgewebview2.exe`（按映像名，19 个进程）——**用户打包版 mditor.exe（AppData 安装）当时存活，其 webview 进程大概率被误杀**（窗口可能白屏，重开即恢复；本地优先+自动保存，内容损失风险低）。此为第五轮同类教训（taskkill /IM）的重犯：正确做法是按 PID 树杀（后续全部改按 PID）。② bench 开档步骤连续 3 次失败（文件树找不到目标，dev 实例反复重启后的状态问题）致 base r3 未取得——base×2 已满足 §10「基线 ≥2 轮」下限，fix×3 补交错；bench 开档脆弱性（重试后仍失败）留档。③ bench CDP 未就绪分支泄漏 dev 实例（互相争抢 WebView2 目录）已修复（§3 #6）。
7. **fixture 命名**：超限副本 `_唯一公式超限副本` 已入 perf/fixtures（整目录 gitignore 惯例）。

## 6. 文档更新

- `mditor/docs/performance.md`：R6 公式调度结论与 __mathPumpStats 口径（见 commit）。
- `mditor/docs/dev-anomaly-codes.md`：无新增异常码（观测为纯增量）。
- `mditor/CHANGELOG.md`：Unreleased 节。
- `memory/2026-10-02.md`：执行日志。
- 打包冒烟：tauri release 已重建（含本轮修复，bundle 产出 `Mditor_5.0.0-beta_x64-setup.exe`）；**冒烟执行受阻**——用户打包版实例存活（AppData 安装版），release exe 单实例机制将启动转发给旧实例后退出，CDP 9222 无从挂载；不未经确认杀用户进程（本轮已发生一次误伤，见 §5 事故①），记档豁免。风险分析：本轮全部改动为纯 JS 运行时逻辑（nodeview 泵内），CSP nonce/打包路径零接触；行为已由 dev 实例全量门禁覆盖。待用户侧打包版正常重启后可复跑 `perf/tmp-r6/prod-smoke-r6.mjs`（打开+滚动断言口径，非 typeText）。
