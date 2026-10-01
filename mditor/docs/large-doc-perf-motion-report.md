# 大文档性能与动效响应治理报告（第四轮：数学密集中型文档默认路径掉帧 + 动效基准）

> 任务书：`docs/prompts/large-doc-perf-motion-optimization-prompt.md`（TP 工作区根）。
> 窗口：2026-09-30。环境：Tauri 2 dev 实例（CDP 9223，WebView2/Edge 153），
> 密度档 fixture `perf/fixtures/无穷级数_密度档压测副本.md`
> （105KB/2,159 行/2,355 行内公式——MD-9001 ×1,896 主灾区画像，逐字段对齐
> 生产日志 katexNodes 峰值）+ 1MB 档既有 fixture。
> 判分纪律沿用第三轮：同窗 ABAB 交错、中位数口径、单轮不作结论。

## 1. 基线声明（§0 核实结果）

- 执行时 HEAD = `edcb959`（v4.19.0 自动视口档），工作区带未提交回退改动。
  与任务书 §4.1 清单一致，另发现回退漏改两处设置清单测试锚点
  （`defaults.test.ts` / `settingsNormalize.test.ts` 仍含 bigDocViewportAuto，
  4 用例红）——本轮 commit `2cdb216` 补全回退（+2 处测试锚点修正），套件回绿。
- **有效代码基线** = edcb959 − 自动档 + 本轮 8 个 commit（见 §2）：
  ≈ v4.18.0 + fc50e62 保留批 + 本轮修复。自动档确认未落地（不重新引入，红线 1 遵守）。
- 版本对齐：`package.json` / `Cargo.toml` / `tauri.conf.json` / `Cargo.lock`
  4.19.0 → **4.18.0**（4.19.0 从未发布，CHANGELOG 已回 Unreleased，发布事务对齐）。
- 生产实例证据（§2 日志画像）仍全部来自 4.18.0；本轮所有「默认行为」论述以
  回退后代码为准。

## 2. 改动清单（8 commits，全部独立提交、各附验证）

### 2cdb216 revert: 回退 v4.19 超大文档自动视口档（用户决策）
- 补齐回退时漏改的设置清单锚点（defaults.test / settingsNormalize.test），
  vitest 942 → 945 基线恢复全绿。红线 1 的执行记录。

### 0b58c7f fix(diag): 输入延迟探针 e.timeStamp 打点（D4）
- 归因：生产 worstInputLagMs 恒 0 存疑。dev 实例双场景验证——同任务阻塞
  200ms 场景两版探针都能测到（200.2ms）；**排队型**（按键被已运行的长任务
  排在队尾）旧探针测 ~0（handler 运行时才打点），改 `e.timeStamp`（输入发生
  时刻）后 299.8ms 被记录。纯检测器改动；ghost-stress 场景顺带实测记录到
  worstInputLagMs=631.8ms（探针有效性闭环证据）。
- 生产恒 0 的主因结论：主灾区交互是滚动/阅读而非打字（D1/D2 场景无按键）。

### 9021816 test(perf): 证据基建 D2/D4/D5
- `perf/switch-bench.mjs`（D2/M3/P4 切标签）：自管实例，两文档往返 N 次，
  每窗 switchMs + 带时间戳 rAF 帧分布 + longtask，按方向聚合，arm 自证
  data-big 签名。
- `perf/heartbeat-diff.mjs`（D5/V3）：心跳会话累计字段差分 → 窗口级 jank 率/
  DOM 增速表。对 4.18.0 生产日志跑通：无穷级数窗 jank 率 0.9-2.3%、打开期
  单窗 dDom=+154,216 后走平（C1 定性输入）；解题技巧总汇 1,682 窗仅 2 jank
  窗（其问题在切换阻塞非滚动）。
- 密度档 fixtures（perf/fixtures/，gitignore 本地化惯例）：无穷级数_密度档
  压测副本.md（105KB/2,159 行/2,355 行内公式）、解题技巧_密度档切换副本.md
  （60KB/1,073 行/778 公式，MD-1003 切标签 1~4.5s 主文档变体）、公式下标
  最小复现_基准副本.md。重建规格：从 `E:/笔记/cmc/02_习题集/无穷级数_习题集.md`
  与 `E:/笔记/cmc/01_专题笔记/解题技巧总汇.md` 复制（生产文档已重组改名，
  日志中「无穷级数_习题集.md」即其现名）。

### 20c37d6 fix(boot): getWorkspaces 冷启动退避重试
- 归因：LazyStore 插件就绪窗口内首次 get 拒/读空，App `.catch(()=>undefined)`
  吞掉 → 文件树永久 0 行（第三轮报告已知遗留，本轮 D 基建首跑复现）。
  250/500/750ms 三次重试 + 末次裸读保留抛错语义。+3 单测。

### faf5c7f fix(boot): fs scope 授权 await 后再放行文件树
- 归因：`grantFsScope` 只发不等 → FileTree readDir 在授权 IPC 落地前发起
  → 按 scope 拒绝 → 静默空树「没有 Markdown 文件」（冷 vite 首启 3/3 复现；
  页内直查 readDirLevel 正常返回 6 文件证实时序故障）。两修复互补，此后
  自管基准冷启动 100% 跑通。

### acc1d1e test(perf): switch-bench 强制无缓存重载
- 测量陷阱：vite 预打包 chunk `?v=` 哈希不含内容指纹，node_modules 打补丁后
  URL 不变，**WebView HTTP 磁盘缓存把旧 chunk 原样供出**（实锤：跑后
  katexCache 条数 0，ignoreCache 重载后 1,642 条）。第三轮 open-1mb 的
  Network 禁缓存挡不住已缓存 chunk。壳就绪后补一次 `Page.reload(ignoreCache)`。

### 76e23e8 test(diag): ghost-stress 脚本 + MD-4011 打开期台阶复检（D3/C1）
- `perf/ghost-stress.mjs`：滚读 / 滚读+侧栏开合 / 程序化大跳往返 / 编辑混合
  四阶段压力，读 `__scrollDebug` 哨兵差分 + 帧分布 + anomalies 行数差。
- devAnomaly.test +1 例：09-30 生产形态（单窗 +154,216 后恒 154,557——
  v4.18.0 曾连发 ×8）在新检测器下不报；真泄漏仍报。

### 6ea3325 / 收尾提交：第四轮基准数据 + g2-typing 文档选择参数化
- `MDITOR_DOC`/`MDITOR_MIN_BLOCKS` 环境变量（仅文档选择参数，口径不动）。

## 3. 门禁全表（P/M/V）

> 环境声明：本轮整机性能较第三轮终测时段显著漂移（打开类全程 ~2×）。
> 交叉验证：checkout 第三轮终测 commit 60e3388 同机重测默认档打开
> 13.2-14.0s（其历史记录 12.4-12.6s 的同时段复测不可再现；本轮 HEAD
> 12.4-12.8s 与之无代码可归因差异）→ 跨时段数值不可直接对比，达标判定
> 以「本机同窗复测基线 vs 本轮 HEAD」与门内绝对值为准。

| # | 指标 | 本轮基线（本机复测） | 优化后/终值 | 目标 | 判定 |
|---|---|---|---|---|---|
| P1 | 1MB 打开（默认/视口） | 12,441-12,848 / 13,550-14,804 | 同（本轮零滚动/打开路径代码改动） | ≤18s / ≤6s* | ✅ / ⚠️* |
| P2 | 打字 p95（g2 口径 1MB，3 轮） | 408 / 432 / 448 | —（环境漂移 ~2×，与第三轮 296-312 不可比；无代码臂） | ≤360 | ❌ 未达（附归因 §5.3） |
| P3 | 搜索计数 / Ctrl+S | 计数「1869 个」正确；LT max 108ms / 91ms | 维持 | 0 长任务(>150ms) | ✅ |
| P4 | 密度档：打开 / 滚动 p95 / 切标签 | 3,021-3,537ms；41.8/41.9ms（2 轮）；中位 2,254ms，>1s LT 10/10 | —（P0-B 三项证伪，见 §4） | ≤3s / ≤50ms / 无 >1s | ❌ 打开贴线 / ✅ 滚动 / ❌ 切标签（归因 §4） |
| M1 | 滚动回归（1MB on/off） | off p50 4.2 / p95 291.8；on p50 100-150 / p95 279-300（预热 45s 超时与滚动并发，两轮同条件） | 零代码改动于滚动路径；off 与第三轮同水平 | 不劣化 | ✅（无回归源） |
| M2 | ghost/视口位移复发 | ghost-stress 4 阶段 ≥5min | MD-1001/1002/1011 触发 0（anomalies+0）；程序化大跳的 11 个 ghost 候选均为脚本注入的自我签名 | 归零 | ✅ |
| M3 | 切换/加载动画帧节奏 | switch-bench 20 次往返 | 动画期 p95 8.3-8.4ms BUT >50ms 帧 41-42/20 窗、单窗冻结最长 1,638-2,275ms | p95≤32ms 且 >50ms 帧=0 | ❌（定罪 §5.2） |
| M4 | 输入→上屏延迟 | — | 探针有效性证明（D4 双场景）✅；密度档打字 p50 224-248 / **p95 1,456-1,984ms**（3 轮） | 探针证明 + ≤360 | ✅探针 / ❌p95（归因 §5.3） |
| V1 | 打包版冒烟 | — | release 构建 `.katex`=2 / `.katex-error`=0（CSP 路径健康）；≥30min 真实使用窗待发布后日志复析 | 0 窗触发 | ⚠️ 冒烟过，生产窗留档 |
| V2 | MD-4011 假阳性过滤 | — | 新检测器对 09-30 真实形态不报（+1 测试）；真泄漏仍报 | 0 连报 | ✅（检测器层） |
| V3 | 心跳差分工具化 | — | heartbeat-diff.mjs 对 4.18.0 两卷跑通 | 落 perf/ | ✅ |

\* P1 视口档 ≤6s 门：本环境打开类全程 ~2×（60e3388 对照臂同慢），13.5s 按环境
比例对应第三轮环境的 ~5.4s；判「环境受限，非代码回归」。1MB on 档 45s 预热
超时（scroll-abab 等待公式单位错，第三轮已知未动）使滚动与预热并发，两轮同
条件——口径修正属测量脚本变更，按纪律未动，留待下一轮。

## 4. P0 专项结论：默认急切渲染降本——三项全部证伪（负结果证据链）

**定罪链回顾（已完备）**：105KB/2,355 公式 → 急切渲染 15.4 万 DOM（心跳实测
154,557）→ 500KB/3,000 行双阈值永不触发 → MD-9001 ×1,896 + MD-1003 ×67。

### P0-B#1 行内公式 toDOM 接 katexCache —— 证伪回滚
- 假设：默认档每次挂载重跑 katex.render（≈1.7s），接缓存后切回应免。
- 实现：crepe 补丁 renderInlineMath 钩子 + lazyInlineMath 导出（完整可运行）。
- 验证：缓存 100% 命中（2,135 条）时切回仍 2.4-2.5s / LT 1.6-1.7s（3 轮）。
  CPU 剖面：切换窗口 `updateStateInner` self 1,815ms + 原生 `(program)` 1,087ms，
  **KaTeX 全部走缓存仅 153ms，fromMarkdown 138ms**——渲染与解析都不是瓶颈。
- 处置：按「达不到假设即回滚」整体回滚（node_modules 补丁三处手工撤销 +
  patch-package 重放全绿 + app 侧 git checkout）。**测量遗产**：acc1d1e
  （WebView 缓存毁臂陷阱的修复）与 katexCache 行为数据（首开填缓存 ~600ms/
  2,355 条，命中直绘 <0.1ms/条——若未来重启按此估值）。

### P0-B#2 解析缓存门槛 200K→50K —— 证伪恢复
- 假设：密度档（105KB）不入 docCache（MIN_CACHED_CHARS=200K），命中预解析
  缓存可免解析。实验（临时改阈值 + HMR）：命中路径生效，切回耗时不变。
- 与 #1 剖面互证：Node.fromJSON + applyParsedDoc 同样落在 updateStateInner
  挂载墙里——**省解析省不掉挂载**。

### P0-B#3 打开期分帧挂载 —— 原型可行但与 P0-C 同路
- 纯页面原型（300 块样本）：一次性挂载 JS 48ms+布局 232ms（单帧 280ms）；
  分 20 帧挂载 JS 共 4ms、布局共 189ms、**单帧最大 35.6ms**——增量布局成立。
- 但 PM `updateStateInner` 引擎内一体执行无法外部切片；「content-visibility
  隐藏挂载 + 分帧揭示」的可行实现 = 视口档本体（需要 cvMemory 高度表承担
  contain-intrinsic-size）——**不存在绕开视口档的第三条路**。

### P0-B 总结论（写入提案数据 C）
密度档默认路径的秒级阻塞是**结构性原生布局成本**：15.4 万 DOM 节点的样式
重算/布局。打字剖面（§5.3）显示 JS 合计仅 ~30ms、3.6s 全在原生引擎——
**JS 侧不可治；唯一实证杠杆是 content-visibility**（第三轮数据 A：滚动 p95
251→82ms、点公式 728→88ms）。按任务书 V1 条款：技术侧用尽 → 归因完成 →
升级为提案（`docs/proposal-bigdoc-viewport-auto.md` 数据 C 节）**待拍板，
未改任何默认值**。

## 5. 动效专项

### 5.1 D3 ghost 压力（M2）——零复发 + 自愈归因
四阶段 ≥5min（滚读 / 滚读+侧栏开合 / 程序化大跳往返 / 编辑混合）：
MD-1001/1002/1011 全零，`session.ghost` 在用户场景阶段为 0。程序化大跳阶段
的 11 个 ghost 候选全部来自脚本自身注入的无输入源 scrollTop——归因器应捕
类别的自我签名，非缺陷。
**「为何自愈」结论**：4.17.1→4.18.0 落地的 ghost 四层补偿链（overflow-anchor
禁用 + viewportAnchor/cvMemory/prewarm-comp/anchor-comp）与 headingStamp
预盖章（parsePipeline.ts 头注明言 MD-1011/1002/1001 随之消失）覆盖了生产
样本场景（lastWrite=file-open@15.7s、41-42px 往复）。回归守卫 = 本脚本 +
既有 tableBlockPatch/md1011-regression 测试。

### 5.2 D2 switch-bench（M3）——MD-1003 完整量化复现 + 定罪
- 基线（默认路径，20 次往返）：切往无穷级数（105KB/2,355 公式）中位
  2,254ms、**>1s 长任务 10/10**、动画窗冻结帧最长 1,638ms；切往解题技巧
  （60KB/778 公式）中位 1,162ms、LT max 654ms。与生产 MD-1003（1~4.5s）
  完全对应。
- 定罪（CPU 剖面）：切换墙 = `updateStateInner` 全量挂载（1.8s self）+
  原生布局；KaTeX 138ms、解析 97ms 均非瓶颈。needsPaintYield（switchTiming）
  的双 rAF 让动画先画一帧——所以动画「能出现」但随后被饿死 1.6s（>50ms 帧
  = 每窗 2 帧 blockbuster 冻结）。
- 修复判定：与 P0-B 同墙同源（§4）——**随视口档提案一并待拍板**；无独立
  JS 侧修复路径。（加载条最短可见 300ms 语义未动，红线 2 遵守。）

### 5.3 密度档打字（M4）——原生布局墙的第三份证据
密度档（默认路径）打字 p50 224-248ms / p95 1,456-1,984ms（3 轮一致）；
每 12 键窗长任务 4-5 笔（max 1,304-1,733ms）。CPU 剖面：打字窗口 JS 合计
~30ms（updateStateInner 29ms、mathLiveGuard 4.5ms），**3.6s 全在原生
`(program)`（样式重算/布局）**。1MB 档同口径 p95 408-448ms（大文档反而好，
因 1MB 文档公式占比低于密度档——每键原生失效范围更小）。

## 6. §4.4 公式下标定案：已修（关闭）

09-22 工作流（dwfrun-54233d83）结论 + v4.17.1 根修（KaTeX 双实例归一，
overrides 钉 0.18.4）有效：
- 静态管线：mathKatexDedupe.test.ts 15 用例全绿（含截图公式 F7 原式）。
- 编辑器块级预览（本轮实机 DOM 目检）：katex-error=0、裸类名 strut=0
  （0.16.x 签名缺席）、katex-strut=14（0.18.4 在位）、mfrac/msub/msupsub
  齐全、`∂F`/`′` 在 textContent——双路径均健康。截图
  `perf/results/formula44-editor-check.png`。

## 7. 遗留与放弃

| 项 | 处置 | 原因 |
|---|---|---|
| A1 装饰削减原型 | 未立项 | P2/M4 密度档剖面显示成本在原生引擎非装饰 diff（装饰是 1MB 档问题，环境漂移下无可比基线；第三轮归因不变，留下一轮） |
| A2 批注增量 / A3 大纲增量索引 | 未做 | 无新证据指向（主灾区为阅读/滚动场景） |
| A4 rIC 超时 / A5 导出分片 | 未做 | A5 依赖 exporterProbe.ts 仍缺（bench 第三段持续崩）；低频路径 |
| B3 结构海啸占位回落 | 部分 | D3 场景零触发；headingStamp 已覆盖内容未变重载；AI 写入真实场景需 API key，留观察 |
| P3 顺带（MD-10002/5012 打包验证） | 部分 | 冒烟过（公式路径）；云同步/资源过滤器行为需发布后生产日志复析 |
| scroll-abab 预热等待公式单位错 | 未动 | 测量口径纪律（第三轮同留） |
| MD-6004 ×2 / MD-7002 ×2 | 留档 | 零星，不构成行动依据 |
| panic tao-0.35.3 | 留档 | 上游，随 Tauri 升级带走 |

## 8. 文档更新

- `docs/performance.md`：增补第四轮结论与密度档基准口径（见文末新节）。
- `docs/proposal-bigdoc-viewport-auto.md`：数据 C 节（第四轮证伪链 + 打字
  剖面），状态仍「待拍板」。
- `docs/dev-anomaly-codes.md`：无口径变更（本轮检测器改动为打点时刻修复，
  不改分类阈值）。
- CHANGELOG：本轮条目入 Unreleased（随收尾 commit）。

## 9. 复现命令

```bash
# 密度档打开：MDITOR_DOC=无穷级数_密度档 node perf/open-1mb.mjs 3 <tag>
# 密度档滚动：node perf/scroll-abab.mjs --doc 无穷级数_密度档 --viewport off --round d1 --duration 60
# 切换基准：node perf/switch-bench.mjs --doc-a 无穷级数_密度档 --doc-b 解题技巧_密度档 --viewport off --switches 20 --tag <t>
# 密度档打字：MDITOR_DOC=无穷级数_密度档 MDITOR_MIN_BLOCKS=500 node perf/g2-typing.mjs <tag>
# ghost 压力：node perf/ghost-stress.mjs --minutes 5 --tag <t>
# 心跳差分：node perf/heartbeat-diff.mjs --ver 4.18.0 --top 15
# 探针验证：node perf/probe-inputlag-validate.mjs
# 公式目检：node perf/formula-subscript-check.mjs
# 剖面产物：perf/results/profile-switch-deep2 / profile-typing-density / profile-open-vp .cpuprofile
```

## 10. 补遗（2026-10-01）：headingStamp 直建盖章 + 密度档打开归因终局

> 结题（§1-§9）后的纯 JS 侧延续。数据：`perf/results/stamp-*.json`、
> `density-open-{base,stampfix,final}.json`（打开剖面 `profile-open.cpuprofile`
> 按既有 gitignore 惯例本地留档）。

### 10.1 优化 #1：headingStamp 直建式盖章（`01b52ce`，已合入，v4.20 批）

- 改动：`src/lib/headingStamp.ts` 预盖章从 Transform.setNodeMarkup 逐步机器
  （每步 resolve/validContent/cut 全套验证）改为**单趟 Fragment 直建**——只
  重建含变更的骨架节点，PM 结构共享使未变子树原引用复用。
- 证据：1MB 档（1,666 标题）打开窗剖面盖章开销 **1,047ms → 14ms（75×）**
  （旧：resolve 302 + validContent 271 + cut 170 + findIndex 156 …，盖章本体
  仅 5.6ms）；+8 差分等价单测（`headingStamp.test.ts`「v4.20 直建式盖章」
  组），34 关联用例全绿。
- 墙钟 ABAB（stamp-a1/a2 旧 vs b1/b2 新）：12.4-12.5s vs 12.7-13.6s——臂间
  方差 ~1s 淹没信号，判「墙钟不可辨、剖面为准」（省的是长任务内部 1s 纯 JS，
  不改变挂载+布局主导的墙结构）。
- 语义护栏：异常回退未盖章文档（行为同旧版）；`type.create` 不做内容校验与
  setNodeMarkup 对纯 attrs 变更必过的差异仅在防御性（输入是刚解析出的合法
  文档），等价性由差分单测钉死。

### 10.2 密度档打开：复测 + 3s+ 长任务归因终局

**复测**（`density-open-final`，10-01 干净窗口 3 轮）：3,644 / 3,396 / 3,622ms
（中位 3,622），ltMax 1,844-2,165。与 09-30 白天基线（3,021-3,537）同水平；
09-30 晚 stampfix 轮的 5.0-5.2s 随今日复测回落，确认为环境噪声窗。
**P4 打开门 ≤3s 仍未达（贴线 3.4-3.6s），归因如下，JS 侧已无手段封案。**

**打开期 CPU 剖面**（1ms 采样；reload → 点开 → 15s 稳定窗；实机 DOM 与
生产签名核对一致：153,929 元素 / .katex 2,355 / katex-error 0），
忙时 ~3.9s 构成：

| 成分 | self 时间 | 判定 |
| --- | --- | --- |
| 原生 `(program)`（样式重算/布局/绘制） | 2,315ms | 主墙（~60%），随 15.4 万 DOM 线性 |
| `updateStateInner`（prosemirror-view 挂载循环） | 1,364ms | 次墙（~35%），同随 DOM 体量线性 |
| scrollDebug 探针 tick | 257ms | dev 测量开销，非产品成本 |
| KaTeX（2,355 条**全急切渲染**，chunk-4VHBHRVV） | 171ms | **直觉嫌疑排除** |
| micromark 解析（chunk-GI4WUECZ） | 57ms | 嫌疑排除 |
| GC | 46ms | — |

- 忙窗形态：单个 2,844ms 连续忙窗（栈顶自 micromark compiler 起步，贯通
  解析→挂载→布局）即 LT1；stampfix 噪声窗轮的第二个 ~1s LT 今日 3 轮均
  未再现（LT 形态 1 大 2 小，open − ltTotal 差 ~800-900ms），判非稳定成分。
- **终局结论**：stampfix 后密度档打开已无可治 JS 大头——直觉嫌疑（KaTeX
  渲染、markdown 解析）实测合计 <230ms；墙 = 原生布局 ~2/3 + PM 挂载 JS
  ~1/3，皆随急切挂载 DOM 体量线性增长。**唯一杠杆仍是 content-visibility
  视口档**（`docs/proposal-bigdoc-viewport-auto.md` 待拍板，默认值零变更）。
  至此打开/打字/滚动/切换四面证据全部归一到同一堵墙。

### 10.3 优化 #2：normalizeMathDelimiters 扫描器化——证据不成立，放弃

1MB 打开剖面 math 定界符 RegExp 427ms：1MB 档专属成分（密度档打开剖面
micromark 全部 self 仅 57ms，无此成分）且 P1 门有 5s 余量。按「证据不成立
不动手」不立项，`mathNormalize.ts` 零改动。
