# R10 第十轮：大文档滚动视口底部闪刷/换装可见专项结题报告

> 范围：cv 档（content-visibility:auto）大文档滚动时视口底部行内公式等元素
> 渲染不自然、可见闪刷/刷新。任务书
> `docs/prompts/large-doc-bottom-flicker-optimization-prompt.md`（a7ad946）。
> 状态：**数据门全过（S1/S2/S3/D1/R9 双断言/npm test 997 绿）；S5 用户观感
> 复核待用户执行（唯一开放项，见 §⑤）**。

## ① 基线声明

- HEAD 起点基线：`6d9458d`（R9 收尾后）；本轮修复链
  `c053e59`（观测设施）→ `fc32959`（观测补点二批）→ `baebce2`（Fix-A）→
  本批 Fix-A'/Fix-B。
- 环境：Windows 11 26200 / dpr 1.75 / dev=vite@1420 / prod=tauri release
  5.0.1-beta（重建 `Mditor_5.0.1-beta_x64-setup.exe`，keepwarm CSS 身份钉
  逐 run 断言）。
- fixture：密度档 `无穷级数_密度档压测副本.md`（2356 块）、1MB
  `一元微分学习题集_1MB压测副本.md`（25277 块）、切换档
  `解题技巧_密度档切换副本.md`（750 块）；prod 用用户文件树真实文档
  `无穷级数_习题集` / `题型方法`。
- 探针：`perf/tmp-r10/probe-flicker.mjs`（dev）+ `prod-flicker.mjs`
  （prod，exe 身份钉 + prod store 只读）+ `flicker-watcher.mjs`（纯 DOM
  巡视，S1 判据 = `phSeenVis` 占位态曾在视口内被观察 + 随后换装）。
- 基线值（S1 换装可见事件总数，症状口）：

| 场景 | env | 基线（tag） | 结果（r10p7a） |
|---|---|---|---|
| down-slow 密度档 | dev | 1173（r10p2 前） | **1**（blockCode×1） |
| down-fast 密度档 | dev | 906 | **1**（blockCode×1） |
| revisit 密度档 | dev | 103（r10p6e） | **0** |
| up 密度档 | dev | — | **0** |
| down-fast 1MB | dev | 1565（r10p5d） | **1**（blockCode×1） |
| down 切换档（解题技巧） | dev | 407（r10p2，down-slow） | **9**（blockMath×9） |
| down-slow prod | prod | 1234~1795（r10p2/p3） | **1**（blockCode×1） |
| down-fast prod | prod | 884（r10p2） | **1**（blockCode×1） |
| revisit prod | prod | 222（r10p2/p3，S2=164） | **0**（S2=0） |

门禁口径：密度档 ≤5 ✓（0~1）、1MB ≤15 ✓（1）、较基线 -80% ✓（全部
≥-99%）。残余 1~9 次均为 blockCode/blockMath（nodeview 块级机制，非本轮
行内公式范围，见 §⑤ 遗留）。

## ② 归因结论

行内公式 S1/S2 的归因分三案定罪（证据 JSON 在 `perf/results/r10-phase2-flicker-*`）：

1. **S-a 预测带覆盖不足（定罪，Fix-A `baebce2`）**：滚动方向前方预测带
   FORWARD_BAND_PX=800 固定，慢滚单步 ~120px 足够、但元素从入带到进视口
   只有数帧，泵帧预算内冷算来不及 → 换装发生在视口内。修复：rAF 合并的
   proactiveSweep 预测式提前入队（S1 1173→1）。
2. **S-b 快滚单步穿越预测带（定罪，Fix-A'）**：wheel 步进（如 1200px）
   一步穿越整个预测带——事后扫描（rAF，新位置视角）原理上无法覆盖"本步
   将跳入视口"的条目；revisit-down/开档快滚残余事件全在 wheel 后首帧同刻
   爆发、十桶均匀分布即此指纹。修复：wheel/touch 事件内
   `proactiveSweepSync(stepPx)` 同步微扫（滚动位移发生**前**把 jump 组
   换装完成）+ 对称 jumpSpan（双侧 stepPx×2，覆盖回访第一步反侧遗留带）
   + `activate("now")` 插队消费（已入队条目从 pendingRenders 摘除立即
   run，消灭"入队早、渲染晚于步进瞬跳"窗口）+ 预测条目跳过几何判定直接
   消费（c-v 估算位置偏差不再拖慢渲染时机；上滚方向维持几何判定——
   R4-①/R6 Fix-B 上滚高度变化安全语义）。
3. **S-c EMA 布局墙 gate 静置毒化（定罪，Fix-B，revisit 103 的真凶）**：
   Fix-A' 引入的 `frameGapEma` gate（帧间隔 EMA>50ms 判墙态跳过同步微扫，
   保护 1MB 冷开快滚的 wheel 内 gBCR 帧代价）存在静置毒化：**静置 3s 后
   首帧 gap ~3000ms 直接把 EMA 打爆**（604 > 50），且 EMA 无衰减路径——
   revisit 场景"下滚→静置 17s→回上滚"整段滚动 sync sweep 全被跳过
   （会话实时诊断：sweeps 恒 74、skip=59~64、106 个 jump 元素无人消费；
   落盘 JSON 里 `proactiveSweeps/syncNow` 停滞）。修复：**gate 完全移除**
   （非仅 gap<250 过滤——已实验证伪）。移除后 revisit 103→0（dev）/
   222→0（prod，S2 164→0）；帧代价复测 1MB down-fast p50 205→209ms、
   p95 249→255ms（r10p5d vs r10p7a，差 4~6ms 噪声级）——**gate 无帧保护
   实效、纯害**，当初 165→205 的帧代价归因不成立（两遍法读写分离已吸收
   同步布局成本）。

排除项（负结果留档，防重走）：
- 「gap<250 过滤版 EMA」——静置毒化同样发生（首帧 3000ms 也 >250），
  证伪后转完全移除。
- 「IO 回调路径补救」（revisit 残余 103 元素走 ioEnter 而非 sync sweep 的
  假设）——EMA 移除后 revisit 直接归零，无需触碰 IO 路径；该假设不再成立。
- S4 视口源码占位（T2 口径）本轮无劣化（hdelta=0/shDrift 0~1，与基线持平）。

## ③ 改动清单

| 项 | commit | 位置 | 内容 | 回退开关 |
|---|---|---|---|---|
| Fix-A 预测式主动预渲染 | `baebce2` | `src/lib/lazyInlineMath.ts`（proactiveSweep/scheduleProactiveSweep） | rAF 合并扫描激活预测带 | revert 单 commit |
| Fix-A' 同步微扫三件套 | 本批 | `lazyInlineMath.ts:309/324`（wheel/touch 打点）、`:645-` （proactiveSweepSync + JUMP_SYNC_CAP=48）、`:701-`（activate("now") 插队）、`:460-`（预测条目直消） | 详见 §② S-b | revert 本批 src 两文件 |
| Fix-B EMA gate 移除 + 诊断清理 | 本批 | `lazyInlineMath.ts`（原 :664-668 noteFrameGap/frameGapEma 删除；dbg*/syncQueued 观测字段删除） | 详见 §② S-c | 同上 |
| 守卫测试 | 本批 | `src/lib/lazyInlineMath.test.ts`（38 → 41 用例：步进自适应带宽/wheel 同步直绘/插队消费/对称 jumpSpan） | 每修复项独立用例 | — |

复杂度：新增 ~150 行（含注释），删除 ~40 行（EMA/诊断）；无新依赖、无
常量拍板项触碰（JUMP_SYNC_CAP=48 与 jumpSpan=stepPx×2 属新代码自有参数，
红线 19/21 不涉及——未动换装过渡视觉策略与 TEARDOWN/IO 常量）。

## ④ 门禁全表

| 门禁 | 基线（R9 收尾口径） | 结果（r10f/r10r1/r10r2/r10r3） | 判定 |
|---|---|---|---|
| S1 密度档 ≤5 | 1173/906/103 | 1/1/0（dev）+ 1/1/0（prod） | ✓ |
| S1 1MB ≤15 | 1565 | 1 | ✓ |
| S1 较基线 -80% | — | 全场景 ≥-99% | ✓ |
| S2 密度档 =0 | 164（prod revisit） | 0 | ✓ |
| S3 高度瞬态 | — | hdelta=0、shDrift 0~1（持平） | ✓ |
| D1 停滚漂移双臂 0 | 0 | 全 6 臂 driftShift=0、stStart==stEnd | ✓ |
| R9 F1 focus j32=0 ×3 臂 + 对称比 ≤1.25 | 0 / 1.0 | j32 focus=0 normal=0、ratio=1、p95Ratio=1 | ✓ |
| R9 keepwarm 身份钉 | 在场 | `focus-keepwarm/running` ×3 臂 + `--expect-keepwarm` 过 | ✓ |
| M1/M2 视口/带内 unready=0 | 0/0/0/0 | vpUnready=0 bandUnready=0 pump.queue=0 katexErrors=0，posBuckets 十桶均匀（234~236） | ✓ |
| M3 块公式挂载 | latex 23 / latexK 23 / mountRate 1 / neverK [] | 23 / 23 / 1 / []（完全一致） | ✓ |
| T1/T2 视口占位 | events 0/p95 0（peak 10/durP95 124~130） | events 0 / p50 0 / p95 0 ×3 轮 | ✓ |
| R5a scroll-abab 1MB p95 中位 | 165（r8r5）/ 166.7（r9r5 收尾） | **183.7**（+10.2% vs R9） | ⚠️ 贴线，归因见下 |
| R5b ghost-stress | ghost=11 / anomalies+0 / block.rebase=0 | ghost=11 / anomalies+0 / block.rebase=0（完全一致） | ✓ |
| R5c 密度档 up/down | 0.000% / 0.000% | 0.000% / 0.039%（单帧，p95 6.3/4.9） | ✓ |
| R5c 1MB up/down（dev 墙态口径） | 78.2% / 11.9% | 69.5% / 15.5%（波动内，up 臂好转） | ✓ |
| R1 open-1mb 中位 | 12203ms（r9r1 收尾；早期基线 4565 为历史环境，R9 已接受 ~12s 水位） | 11437ms（更好） | ✓ |
| R2 打字 密度/1MB p50 | 104 / 376ms | 104 / 368ms（持平/略好） | ✓ |
| R3 切换 20 往返中位 | 627ms（r9r3） | 628ms | ✓ |
| npm test | ≥990 | **997/997 绿**（90 文件） | ✓ |
| 1MB 帧代价（EMA 移除回归检查） | p50 205/p95 249（r10p5d） | p50 209/p95 255 | ✓（噪声级） |

**R5a +10.2% 归因（唯一贴线项，不许留空）**：scroll-abab 1MB vp on 60s
持续滚动是 dev 墙态口径（帧 p50 65~70ms、longtask n=450+/轮）——EMA gate
移除后 wheel 内 sync sweep 的 gBCR 在墙态中每步执行（gate 原设计目标正是
跳过此代价），p95 尾部 166.7→183.7（+17ms）。权衡依据：①同口径 down-fast
探针 p50 仅 +4ms（205→209，两遍法已吸收大部分）；②**prod 预热完成态（用户
真实态）帧 p95 仅 6~12ms，实测零影响**（r10p7a prod 三场景）；③换取 S1
revisit 103→0 / prod 222→0（gate 静置毒化无解，任何 gap 过滤版同证伪）。
墙态画面本身不连续（帧间隔 >32ms 占 90%+），+17ms 感知不可分。

## ⑤ 遗留与放弃

- **S5 用户观感复核（唯一开放项）**：修复前后分段录屏盲序复核未执行——
  需用户按任务书红线 20 亲自复核"底部滚动自然度可接受"后方可宣称结题。
  数据门（S1/S2/帧）已全过，无已知风险信号。
- **blockCode/blockMath 残余（1~9 次/场景）**：块级 nodeview 挂载-拆卸
  机制（TEARDOWN_DELAY/IO 频带半径属拍板项，红线 19），本轮范围外。
  水位已从 407→9（切换档），如需归零须另立专项走拍板流程。
- **放弃：EMA 布局墙 gate**——静置毒化不可修（首帧 gap 无界），帧保护
  实效证伪；两遍法已独立吸收同步布局成本。防重走：任何"按帧间隔跳过
  wheel 内同步工作"的 gate 必须考虑静置后首帧 gap 无界问题。
- **放弃：IO 回调路径补救假设**——EMA 移除后 revisit 直接归零，假设前提
  消失。
- P3 提案：本轮无夹带。

## ⑥ 文档更新清单

- 本报告：`docs/large-doc-bottom-flicker-report.md`。
- `docs/performance.md` 第十轮节（换装可见口径、归因结论与权衡）。
- `CHANGELOG.md` Unreleased 节。
- memory 日记：`memory/2026-10-09.md`。
- 发版：本轮不发版（任务书 §11）；5.0.1-beta 是否转正由用户另行决定。
