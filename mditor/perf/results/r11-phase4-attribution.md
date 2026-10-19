# R11 阶段四归因定罪书（症状 E 首现闪刷 + 症状 P 1MB 滚动性能）

> 环境：dev（tauri debug, CDP 9223，自管实例串行）；WebView2 runtime **155.0.4283.62**
> （较 R10 期 154.0.4258.62 又自动更新——环境项登记，绝对值以同批 ABAB 为准）。
> HEAD 起 329bc5b（任务书基线 060d677 + 2 个 HX 导出 commit，不触碰滚动管线）。
> 探针：perf/tmp-r11/probe-r11.mjs（E/P 双剖面页内记录器；S1/E1/E3 口径均为
> "完成帧元素与视口相交"的联合判定，R10 S1 口径沿承）；产物 perf/results/r11-phase3-*。
> npm test 基线 1089/1089 全绿（2026-10-19 实跑）。

## 0. 基线（阶段二/三实测；同场景重复一字不差）

| 场景 | 档 | S1 换装可见 | E1 块挂可见 | E3 高度跳可见 | E4 demoteVis | 帧代价 | 证据 |
|---|---|---|---|---|---|---|---|
| dev down-slow warm ×3 | 解题技巧（24 块级） | 0/0/0 | **24/24/24**（23 LaTeX+1 code，bucket 7-9，ph→done） | 4 | - | p50 6ms | r11-phase3-block-dev-down-slow-switch-{1,2,3} |
| dev down-fast warm | 解题技巧 | 0 | 16 | 2 | - | 6ms | …-down-fast-switch-1 |
| dev fresh-scroll（慢滚）×3 | 密度档（2355 行内） | **0/0/0** | 1 | 0 | - | 6ms | …fresh-dev-fresh-scroll-density-{1,2,3}（自证 frac .35/.37/.35 done=0） |
| dev down-slow warm | 密度档 | 0 | 1 | 0 | - | 6ms | …-down-slow-density-1 |
| dev revisit | 密度档 | 0（S2 重闪 0） | 2 | 0 | 0 | - | …-revisit-density-1 |
| dev fresh-down-fast ×2 | 1MB（25k 行内） | **134 / 128** | 7/8 | 18/16 | - | p50 124-135ms | …fresh-dev-fresh-down-fast-1mb-{1,2}（自证 frac .17 done=0） |
| dev down-fast warm | 1MB | **124** | 7 | 13 | - | p50 125ms | …-text-dev-down-fast-1mb-1（warm 等 120s 后 frac .49 done=0） |
| dev revisit（1200px 步进） | 1MB | 144（含 S2 重闪 **7**） | 29（含 13 remount） | 15 | 0 | - | …-block-dev-revisit-1mb-1 |

**M 组**：全场景 M1 unreadyVis=0 / M2 queueDepth=0 / M3 带内占位 0；katex-error
密度/解题技巧/prod=0；**1MB 档 .katex-error=1277~2488 为 fixture 固有**（机器生成
压测文档含非法 LaTeX 源；pump.renderFailed=0——KaTeX 正常渲染出错误标记，非回归；
密度/解题技巧档 0 维持 R10 门）。
**解题技巧档 fresh 不可建**：384 块 cv 预热 ~1s 完成（done=2@1.2s），fresh 自证必
失败——该档 fresh 变体放弃（E1 门在 warm 态已满额复现）。

## 1. E 组定罪

### E-a【已决·直接修复立项】块级换装可见（R10 S-a 沿承，本轮全量复现）

R10 定罪免重述。本轮全档复现：解题技巧 down-slow **24/24 全可见**（×3 一字不差），
1MB 快滚 7-8/8，revisit 上滚路径 13 次可见 remount（拆卸→回访重挂同形态）。
修复走 R10 立项口径：块级主动预挂载原型（限速）→ 拍板材料（§3）。

### E-b【定罪·量级重排】行内首过 = 1MB 冷区穿越（非"首开"专属）

- 密度档 fresh（真·首开即滚，慢滚）：S1=0——R10 Fix-A 预测式发现 + 泵预算在慢滚
  下连冷缓存也覆盖发现-渲染时机，**"首开即滚"本身不构成症状**（可证伪句子
  E-b 前半否证：冷缓存窗口假设不成立——1MB 可见换装全程分布 t=6.3s~219s，
  非冷启动窗口聚集；且 warm（frac .49）124 ≈ fresh（frac .17）134）。
- **1MB 档 S1=124-134 的真因：快滚步进持续快过预热学习**（cov 0.17→0.42 随滚
  动缓涨，prewarm 让路滚动却追不上），jump 组冷条目（未命中 katexCache）按
  R10 Fix-A' 安全语义降级入队（syncDefer 290），泵在视口内补绘 = 可见换装。
  与 P-1 布局墙同源（同一批冷区块）。
- 修复路径：常量/同步直绘语义均红线 1 锁死（JUMP_SYNC_CAP 48、命中才同步）；
  可动域 = P3（盒预留预热）改善冷条目上滚安全直绘 + 归因留档。**本轮以归因
  + P3 并案呈报收口，E2 门按 1MB fresh 快滚口径 134 计基线**。

### E-c【定罪·主载体回指 E-a/E-b】文字等块首绘 = ①伴生 + ⑤外溢，独立成分小

分桶证据（解题技巧 down-slow 96 跳 / 1MB 快滚 2515-3042 跳，可见 4-18）：
- 94/96（解题技巧）与 1MB 全部可见跳 hasMath=true——行内公式渲染行高变化
  （E-b 同源）；
- 24/96 与 24 次块挂载 ±50ms 对齐——嵌套在列表内的 LaTeX 块挂载→容器 OL/P
  跳高（E-a 外溢，修复 E1 即消）；
- ①未学块变现跳高：密度档 fresh 629 跳 vs warm 416 跳（差量=未学变现）但
  **可见均 0**——变现发生在预渲染窗（视口外 0~400px），慢滚不可见；
- ②图片：hasImg 少数伴生（1MB fresh 18 可见跳中 1 例），非主载体；
- ③过渡样式：**静态排除**——120ms opacity 过渡选择器只覆盖
  span.mditor-math-inline-lazy（global.css:6002-6018），不波及块级/图片/段落；
- ④webfont：可见跳全部 math 介导、无纯文字字体交换形态指纹（录屏复核留 E5）。
**E3 独立修复不立项**——随 E1/E-b 修复自然收敛，门禁以修复后差值复核。

### E-d【维持】revisit/demote

密度档 S2=0 / demoteVis=0（R10 收尾维持）；1MB reflash=7（新单列值，量级小）、
demoteVis=0（修前 19→0 维持）。

## 2. P 组定罪（P 归因双跑 + abab 门禁）

**P1 布局墙复核（R8 结论本轮数据再坐实）**：

- P 剖面（轻记录器）1MB down-fast 双跑（…-perf-dev-down-fast-1mb-{1,2}）：帧
  p50 48/53ms、p95 181/330ms、max 444ms、>100ms 帧 610；**layout:block 事件 553
  + layout:height 544 ≈1:1 伴随全程**（块变现即高度链）；cov 采样 .488→.521
  （190s 内预热仅推进 +385 块——滚动让路纪律下预热被快滚持续甩开，冷区
  常驻）→ 帧间隙与冷区首渲变现同源，R8"冷区首渲布局墙"结论**复核成立**。
- 对照：E 剖面（重记录器，每帧带内 DOM 扫）同场景 p50 124-135ms——记录器
  本身在 1MB 上加帧 ~75ms，**P 门一律以轻记录器/scroll-abab 为准**（本轮
  方法学结论，入 performance.md）。
- scroll-abab 同批 ABAB（r11p3-*）：1MB on 臂 p50 58.6/65.6ms、p95 172/186；
  off 臂 p50 5.9/6.0ms（默认档急切渲染定案维持）。on 臂基线均值 p50 ≈62、
  p95 ≈179 为 P1 门对照基准。
- **P1 修复路径**：墙成分=冷区行内首渲高度变化连锁 + 队列积压（R8 ⑤）。
  可动域唯一指向 P3（盒预留预热）——占位端消费接线已在
  （lazyInlineMath paintPlaceholder:796 直读 inlineBoxes 会话表），P3 只需
  把"demote 时才学盒"提前为"滚到前已学盒"。本轮建 P3 原型实测（第三次
  呈报，见 §3 与拍板材料）。

## 3. 修复立项（阶段五）

- **Fix-A（E-a）**：块级主动预挂载原型（src/lib/blockPreMount.ts 原型开关，
  window.__blockPreMountCfg 默认关），限速每帧 1 块（cfg.perFrame），上滚仅限
  曾挂载块（dataset.mnt 冻结高语义，R4-①/R6 Fix-B 安全约束），触发走补丁侧
  __codeBlockPreMount（与 IO 进带完全同路径，幂等）。**修复臂实测（commit
  7d8c980，r11-phase5-block-dev-*）：解题 down-slow 24/24（×6 基线）→ 0/0/1
  （×3，-100%）；down-fast 16→1；revisit 48 块 0 可见（reflash 2=2 维持）；
  1MB fresh 7-8→5（快滚 outrun 残余=行内侧）；单块挂载 3~10ms（1MB 最大
  32.3ms）；帧代价 gapP50 6ms 持平；M1/M2/M3 全绿。**拍板材料
  docs/r11-decision-materials.md。**
- **P3（第三次呈报）**：src/lib/inlineBoxPrewarm.ts 原型开关
  （window.__inlineBoxPrewarmCfg 默认关）——空闲分批把已缓存行内公式离屏
  测盒填 inlineBoxes；与 mathCachePrewarm 同点位同纪律（让路/代际/尽力而为）。
  修臂 ABAB 数据见 r11p5-p3fix-*：**p50/p95 与基线差 <2%（噪声级）——R8
  投影否证**（队列积压已被 R10 Fix-A/A' 消化，现存墙为块级首变现层）。
  呈报结论：**建议按原案不采纳**（原型保留默认关供复验）。
- **E-b**：归因留档 + P3 并案；不破红线 1 常量（JUMP_SYNC_CAP/泵预算不动）。
- **E-c**：不独立立项（主载体回指 E-a/E-b，随 Fix-A 收敛——fix 臂 hjVis
  4→0 实证）。
