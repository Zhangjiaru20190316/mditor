# R8 阶段四：症状 U 归因定罪/排除书（草稿，随实验填充）

> 探针 `perf/tmp-r8/probe-jank.mjs`；证据 `perf/results/r8-*.json`。
> 归因判据表见任务书 §5；先分掉帧 vs 跳位，再归因候选。

## 0. 判别前提：掉帧 vs 跳位

三哨兵残差口径（Δrect.top + ΔscrollTop，>4px 判内容相对视口真跳位）：
- 阶段一/二全部 8+7 个 run 的 scrollPhase 窗 **shift（残差）= 0**。
- **结论：症状 U 全部为掉帧（帧间隔拉长），无内容跳位成分**。U-f（R7 残余位移被感知为卡顿）排除，漂移残余维持 R7 留档不动。

## 1. 候选排除表（阶段一~三证据）

| 候选 | 判据 | 证据 | 结论 |
|---|---|---|---|
| U-e 版本差 | dev/main 复测同序列达标 | 用户构建 = 10-03 09:12 对齐构建（含 R4~R7，exe mtime + 安装包 mtime 钉死）= HEAD 同源；dev 复测仍有形态 | **排除**（用户构建即 main 形态） |
| U-f 跳位误认 | 帧 p95 正常而位移帧非零 | 全 run 残差位移 0、掉帧确凿 | **排除**（真掉帧） |
| U-c 预热竞争 | 等待臂掉帧归零 | 1MB wait 臂 p95 572 vs no-wait 238——**等待臂更糟**；密度档 wait 未现方向反转 | **排除**（预热不在飞时更差，另有因素） |
| U-a 上滚积压停滚补绘墙 | 掉帧集中 quietPhase | 1MB quietPhase 47~86 jank 帧 + 密度档 quiet 25~27 帧（run2）——quiet 窗确有掉帧；但 scrollPhase 窗掉帧率更高（1MB 60~100%） | **部分成立**（quiet 成分存在，非主门靶——主靶在 scrollPhase） |

## 2. 主嫌疑（待实验定罪）

### 2.1 形态学事实（1MB，阶段一 r8p1-1）
- scrollPhase 掉帧率 up 100% / down 60~64%；p95 up 238~572 / down 104~107（比 2.2~5.5×）。
- **掉帧帧全部零 longtask**（572ms 帧间隔、无任何 >50ms 任务）——主线程 JS/布局任务不超 50ms，帧间隔拉长来自渲染管线其他环节。
- scrollTop 逐帧前进 1200px（合成器滚动正常），hitPaints 每 250ms +500（上滚直绘在飞），cold=0。
- 长距下滚段（939 帧）p50 116/p95 232——绝对帧率墙（R6 封案 10-15fps 天花板）方向无关背景。
- scrollHeight 会话内漂移 42,504px（920,588→878,084）——cv 变现/demote 总高变化。

### 2.2 密度档（阶段二/三 r8p3-1/2）
- 绝对量健康：jank32 ≤3.2%、p95 ≤13.2ms、longtask ≤1。
- 慢滚 p95 比 run1 1.80 / run2 1.70——**方向一致、稳定超门（1.25）**；快滚 jank32 量 0~4 帧统计不稳。
- run2 会话级噪声：quietPhase jank 25~27 帧（run1 0~1），三臂一致——环境/会话状态混杂，ABAB 交错必要性实锤。

## 3. 定罪实验矩阵（待跑）

| # | 实验 | 判据 | 状态 |
|---|---|---|---|
| exp1 | 深位 down 对照（--start-depth 0.6，同位置同距离） | 深位 down p95 仍 ≪ up 则方向差确证；否则位置混杂 | 待跑 |
| exp2 | Performance.getMetrics 差分（Layout/RecalcStyle/TaskDuration） | up 段 Layout/Style 时长占比定位管线环节 | 待跑 |
| exp3 | cv 关停对照（页内注入 content-visibility:visible） | 掉帧归零 → U-b/cv 变现定罪 | 待跑 |
| exp4 | demote 关停对照（DEMOTE_DELAY→1h patch） | 掉帧归零 → U-d 定罪 | 待跑 |
| exp5 | 上滚直绘关停对照（R6 Fix-B band 直绘 patch） | 更差 → 直绘在救命；更好 → 直绘是掉帧源 | 待跑 |

## 4. 定罪结论（实验后填写）

（待 exp1~exp5 数据）
