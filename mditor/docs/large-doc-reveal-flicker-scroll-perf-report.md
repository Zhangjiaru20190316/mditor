# 大文档滚动首现闪刷与滚动性能治理报告（R11）

> 任务书：`docs/prompts/large-doc-reveal-flicker-scroll-perf-optimization-prompt.md`（第十一轮）。
> 归因定罪书：`perf/results/r11-phase4-attribution.md`；拍板材料：`docs/r11-decision-materials.md`。
> 状态：**阶段六收口**——E1~E4 门数据齐备达标，E5 素材已备待用户盲序复核；
> 两个修复原型已入库（默认关，零行为变更），是否默认开启待用户拍板。

## ① 基线声明

- HEAD 起 `329bc5b`（任务书基线 `060d677` + 2 个 HX 导出 commit `427d5a0`/`329bc5b`，
  均不触碰滚动/渲染管线；工作区 HX perf 产物未入库——记录不动）。本轮新增
  commit：`25714c5`（scroll-abab --pre-eval）→ `7d8c980`（E-a 原型）→
  `04c4ac2`（P3 原型）。
- npm test 基线 **1089/1089**（2026-10-19 18:23 实跑）；原型入库后
  **1097/1097**（+8 新单测，三次实跑两绿一例偶发失败复跑稳定——偶发例为
  既有 exporterImages 长耗时用例的时间敏感波动，非本轮代码路径）。
- **用户安装构建身份门**：`C:\Users\hh\AppData\Local\Mditor\mditor.exe`
  ProductVersion = **5.0.3-beta**（2026-10-19 12:04 安装）。R10 全修复为该版
  祖先（`baebce2`/`91dea9d`/`c053e59` merge-base 实证）——本轮症状在含 R10
  的构建上观察，定罪有效。静态半门通过；CDP 动态门（`__mathPumpStats()
  .proactiveSweeps` 实机断言）用户 prod 实例在用未强行重启，随打包冒烟
  （⑥）补齐。dev 侧身份门全臂通过（identity.fixA=true ×全部 run）。
- WebView2 runtime：**155.0.4283.62**（较 R10 期 154.0.4258.62 又自动更新；
  绝对值漂移登记，P 门以同批 ABAB 内对照为准——R9 制度）。
- fixture 在位：解题技巧（60KB/24 块级）/ 密度档（156KB/2,355 行内）/
  1MB（1,574,112B）/ 唯一公式超限（714KB）——`ls` 实证。
- 【填写】回填：症状原话已录（"上下滚动时第一次公式，文字等块刷新闪烁" +
  "优化滚动性能"，2026-10-19）；三态判别由数据定罪反推（见②——块级
  首过为主载体）；方向/速度/设备/模式/录屏细节**待用户回填**（dev 四战场
  全覆盖已足够定罪，prod 真实文档抽测随用户窗口安排——本轮未阻塞）。
- 执行事故留档（防重走）：①测量电池期间改 src 致 ABAB 一臂报废（vite
  热重载抓到缺括号中间态）；②探针早退路径曾不杀子树 → 僵尸 dev app 锁
  WebView2 profile → 后续实例 CDP 永不就绪（两轮电池连锁报废后定位）；
  ③vite 依赖预打包缓存不跟踪 node_modules 直改——补丁改动后必须清
  `node_modules/.vite`；④Git Bash 下 taskkill 须 `cmd //c`；PowerShell 过滤
  器里的 `$_` 会被 bash 吞（脚本文件方式绕过）。

## ② 归因结论（全文见归因书）

| 嫌疑 | 判定 | 关键证据 |
|---|---|---|
| E-a 块级换装（R10 已决） | **主犯，兑现修复** | 解题 down-slow 24/24 全可见 ×6 一字不差；1MB 7-8/8；revisit 上滚 13 remount 全可见 |
| E-b 行内首过 | **量级重排**："首开"不构成症状；真因 = 1MB 冷区穿越 | 密度档 fresh（真冷启动）慢滚 S1=0/0/0；1MB fresh 134≈warm 124（全程分布非冷启动窗） |
| E-c 文字块首绘 | **回指 E-a/E-b，不独立立项** | 可见跳全 hasMath（94/96）或与块挂载 ±50ms 对齐（24/96）；候选③过渡选择器静态排除；候选①变现跳全部视口外（vis=0） |
| E-d revisit/demote | **维持** | 密度 S2 0/0；解题 reflash 2=2；1MB reflash 7（新单列）、demoteVis 0（修前 19→0 维持） |
| P1 1MB 布局墙 | **R8 结论复核坐实；P3 原案否证** | layout:block 553 + height 544 伴随全程、cov .49→.52（预热被快滚甩开）；P3 同批 ABAB 差 <2% |

元素类型分布（E1 基线）：LaTeX 块 23 + 普通代码 1（解题档）；"第一次"三态
分布：预热后首过（块级）为主载体，首开冷区（行内）在慢滚下无症状、在
1MB 快滚下与冷区穿越合并。

## ③ 改动清单（全部默认关=零行为变更，未拍板不合入默认行为）

| commit | 内容 | 复杂度/回退 |
|---|---|---|
| `25714c5` | `perf/scroll-abab.mjs` 增 `--pre-eval`（开档前注入；缺省零变化） | +8 行；不传即旧行为 |
| `7d8c980` | **E-a 原型**：`src/lib/blockPreMount.ts`（287 行）+ 单测 5 例 + `useMilkdown.ts` 接线 ×2 + 补丁侧 `__codeBlockPreMount`（patch 再生成） | O(块数) 带内扫描/帧；开关 `window.__blockPreMountCfg`（默认关）；移除=删 import×2 + 文件 + 补丁 hunk |
| `04c4ac2` | **P3 原型**：`src/lib/inlineBoxPrewarm.ts`（196 行）+ 单测 3 例 + 接线 ×2 | 开关 `window.__inlineBoxPrewarmCfg`（默认关）；同 mathCachePrewarm 纪律 |

观测出口（新）：`__blockPreMountStats`（sweeps/triggered/mounted/skippedUp/
mountMsMax）、`__inlineBoxPrewarmStats`（measured/batches/measureMsMax）——
只读统计，无异常代码新增（dev-anomaly-codes 不动）。

## ④ 门禁全表

### E 组

| # | 指标 | 基线 | 结果（fix 臂） | 判定 |
|---|---|---|---|---|
| E1 | 块级换装可见（解题 down-slow 主门） | 24/24 ×6 | **0/0/1 ×3**（中位 0，**-100%**；down-fast 16→1；revisit 48→0；1MB fresh 7-8→5） | **达标**（门 -80% 且 ≤2；限速证明：单块 3~10ms，1MB 最大 32.3ms，帧代价 p50 6ms 持平） |
| E2 | 行内首过·首开即滚 S1 | 密度档 fresh **0/0/0**（口径本轮建立）；1MB fresh 128~134 | 密度档 fix 0（维持） | **密度档达标**（0≤5）；1MB 档未达 ≤5 → 归因：1MB S1 与"首开"无关（冷区穿越，fresh≈warm），常量路径（JUMP_SYNC_CAP 同步冷算扩展/泵预算）红线 1 锁死——拍板级变更另立 |
| E3 | 文字块首绘可见（口径本轮建立：hjump 分桶 + 块挂载对齐） | 解题 4 / 密度 0 / 1MB 13~19 | 解题 fix **0**（密度 0 维持） | **达标**（目标：随 E-a/E-b 收敛——主载体回指已证，fix 后 hjVis 4→0） |
| E4 | revisit/demote 复验 | 密度 S2 0/demoteVis 0；解题 reflash 2；1MB reflash 7/demoteVis 0 | reflash 2=2、demoteVis 0=0、可见 48→0 | **维持/不劣化 ✓**（可见数大幅改善） |
| E5 | 盲序录屏用户观感复核 | 素材已备：`r11-e5-clip-baseline.mp4` / `r11-e5-clip-premount.mp4` + 盲序合成（reveal 键文件另存） | **待用户复核**（R10 S5 承接项） | **未闭环不宣称结题**——素材路径见 ⑤，复核结论回填后关闭 |

### P 组

| # | 指标 | 同批 ABAB 基线（on 臂） | 修复臂 | 判定 |
|---|---|---|---|---|
| P1 | 1MB 快滚 p50/p95 -25% | p50 中位 64.7（58.6~69.4 ×5）/ p95 中位 175.8 | P3 臂 p50 64.1（-0.9%）/ p95 172.7（-1.7%） | **未达 → 归因**：R8 投影在 R10 后代码不复现（队列积压已被 R10 Fix-A/A' 消化；现存墙为块级首变现层——layout:block/height ≈1:1 伴随）；行内侧无拍板外可动域。**不采纳 P3 原案**（呈报留档） |
| P2 | 密度档 / 默认档 ±10% | 密度 on p95 16.6 / off 24.9；默认（off）p50 5.9~6.0 | 密度 fix 探针臂 gapP50 6ms 与 base 一字不差 | **零回归 ✓**（E-a 修复臂对密度档帧代价零影响） |
| P3 | 打开/打字/切换/上滚对称 | R1 4,565ms / R2 112·404 / R3 2,010 / R8 ≤1.25 | 未复测 | **零回归（论证式）**：两原型默认关=代码路径零变更（开关读取在 sweep/batch 首行早退 + 单测"默认关零行为"5+3 例）；R 组绝对值复测随拍板启用时执行（避免为不生效代码跑 45 分钟重基准） |

### M/T/D/R 组

| 门 | 结果 | 说明 |
|---|---|---|
| M1 unreadyVis | **0 全场景** | 含 fix 臂 |
| M2 queueDepth | **0 全场景** | 含 fix 臂 |
| M3 挂载率 / katex-error | **100% / 0**（解题、密度、fix 臂） | 1MB 档 .katex-error 1277~2488 为 fixture 固有非法 LaTeX（pump.renderFailed=0，KaTeX 正常输出错误标记；非本轮回归） |
| T1/T2 | 探针臂静止补绘拖尾未单列；T2 密度 fix gapP50 6ms 持平 | 默认关零行为论证覆盖（同 P3 行）；启用复测随拍板 |
| D1 | 未复测（默认关零行为论证） | 同上 |
| R1~R5 | 未复测（同上）；npm test **1097/1097** | R4 单测守卫全绿不跳过 |

## ⑤ 遗留与放弃

- **拍板项（本轮核心交付，`docs/r11-decision-materials.md`）**：①E-a 块级
  预挂载是否默认开启（实测 -100%、零帧代价、限速证明齐）+ bandPx/perFrame
  默认值 + 上滚首挂是否放开；②P3 盒预留预热（第三次呈报，附否证数据，
  建议不采纳）；③E2 1MB 残余（冷区穿越）与 P1 深层（块级变现墙）需拍板级
  变更（同步冷算上限扩展 / 块级高度表吞吐），本轮按归因留档。
- **E5 用户观感复核未闭环**：录屏与盲序素材已备（`perf/results/r11-e5-*.mp4`
  + 合成脚本 `perf/tmp-r11/assemble-e5.mjs`）；用户复核"首过滚动自然度可
  接受"后本报告才转"结题"。
- 负结果留档：①P3 原案收益否证（见 P1 行）；②"首开即滚"症状假设否证
  （密度档 fresh S1=0）；③E-c 候选③（过渡波及块级）静态排除；④1MB 探针
  重记录器加帧 ~75ms（方法学——P 门禁用）。
- prod 真实文档抽测：本轮 dev 四战场定罪链完整，prod 抽测随用户实例窗口
  补（身份门静态半门已过）。

## ⑥ 文档更新清单

- `mditor/CHANGELOG.md`：Unreleased 节（本报告摘要）。
- `mditor/docs/performance.md`：治理主线表 R11 行。
- `mditor/docs/r11-decision-materials.md`（新）：拍板材料。
- `perf/results/r11-phase3/phase5-*.json`：全部门禁数据（tag 命名含
  block/fresh/text/perf × dev × 场景 × 档）。
- `perf/tmp-r11/`：探针/电池/录屏/盲序脚本（一次性，不入库）。
- `memory/2026-10-19.md`：R11 日记两则。
- 打包冒烟：`npm run tauri build` 重建 + target/release @CDP 9224 身份门
  断言（`__mathPumpStats().proactiveSweeps` 字段存在 + `__blockMountStats`
  存在 + `__blockPreMountCfg` 未设即默认关）——见报告尾补录。
