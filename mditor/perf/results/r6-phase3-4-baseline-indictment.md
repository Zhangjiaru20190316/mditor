# R6 阶段三：全口径基线 + 阶段四：归因结论

## 阶段三：门禁基线表（修复前，r6base，2026-10-02 本机 dev 实例）

| 门禁 | 战场 | 基线值 | 证据 |
|---|---|---|---|
| T1 占位残留 p95（含滚动期合计口径） | 1MB on upscroll ×2 | **5,833 / 5,396ms（中位 5,615）** | scroll-flash-bench.jsonl r6base r1/r2 |
| T1 同上 | 密度档 on ×2 | 37 / 37ms（健康） | 同上 |
| T2 滚动中峰值/占比 | 1MB on | 峰值 17-22 条；源码态时长占比 32-48%（scrollPeakVisible / scrollRatio） | 同上（row.t2） |
| T2 同上 | 密度档 on | 峰值 10-13 条；占比 100%（绝对值仅 0.68s，total 小） | 同上 |
| T2 滚动中/静止分窗 | 1MB on | scrollPhase 88 事件（96%）p95 5,833ms；quietPhase 5-7 事件 p95 ≤1,083ms | f1.scrollPhase/quietPhase |
| M1 遍历后视口残留 | 超限 fixture（9,420 唯一公式） | **6 / 9 条**（两轮），pump.queue=0 | r6-phase2-traverse-r6p-m-unqlimit.json / confirm |
| M1 同上 | 1MB | **3 条**，pump.queue=0 | r6-phase2-traverse-r6p-m-1mb.json |
| M1 同上 | 密度档 | 0（竞态窗口未命中——停点与节奏因素） | r6-phase2-traverse-r6p-m-density.json |
| M2 泵队列饥饿 | 三档 | queue=0、oldestWaitMs=0、oldestWaitPeakMs=0（观测史无活条目滞留） | __mathPumpStats 快照 |
| M3 块级挂载率 | 解题技巧（23 块） | **100%（23/23）** | r6-phase2-blocks-r6p-blocks5.json |

**T1 目标值（门禁钉死）**：≤ 5,615 / 4 ≈ **1,404ms**；密度档不回归（≤41ms）。

### 测量口径声明

- f4 帧间隔读数（1MB on 臂 p50 162-187ms）存在**采样器污染疑点**：bench REC 每帧 querySelectorAll 全文档 lazy 元素（1MB=25K）+逐条 rect；off 臂 lazy 元素不存在（采样器零成本）→ on/off 臂 f4 差异部分来自采样器自身。T1/T2 主判据（占位停留时长/视口未 ready 数）为元素级状态值不受此影响。1MB 采样器成本定量（recost 探针）因一次 dev 卡死未取得，密度档外推 ~10-40ms/帧；结论：f4 只作趋势参考，不作门禁。
- pump-trace 采样（每 300ms O(unready) rect）同样影响其帧计数读数；计数器（hit/cold/queue）与 vpUnready 状态值不受影响。

## 阶段四：归因结论（定罪/排除表）

### 症状 T（不及时）

| 候选 | 判定 | 关键证据 |
|---|---|---|
| T-a 滚动中小预算（5ms 冷算） | 1MB/密度档排除；超限档成立（与 M-a 同源） | pump-trace 1MB 全程 cold=0、hit 持续增长（唯一公式 2,368 预热全覆盖全命中）；超限 traverse coldRenders=9,532（LRU 截断区冷算） |
| T-b 静止门+补绘速率 | 非主因 | quietPhase 仅 5-7 事件 p95 ≤1,083ms；主体 96% 在滚动中 |
| **T-c 上滚 band 禁渲染** | **CONVICTED（T1 主因）** | pump-trace A-up 尖峰 vpUnready=21、q=9（上滚瞬间积压，等视口内 64 直绘/帧 × 450ms 长帧清队）；bench p95 5.4-5.8s 长尾事件集中于上滚/往返段；上滚 band 条目留队等静止 |
| T-d 预热冷启动 | 1MB/密度排除 | A 段（开档即滚）hit 立即增长、cold=0——33s bench 窗预热已完成（1MB 唯一 2,368 预热 ~2.4s 纯算） |
| T-e 1MB 首开争用 | 不重开案 | B 段（静置 25s 预热完成后）长帧比例仍 58%——帧饥饿主体为滚动布局墙（第四轮封案）+采样器疑点（见口径声明）；本轮修复不波及预热/学习窗 |
| T1 根因综合 | 上滚段直绘吞吐不足：上滚 band 全禁（含安全的命中直绘）+ 长帧（450ms/帧）× 64 条/帧软上限 | —— |

### 症状 M（漏渲染）

| 候选 | 判定 | 关键证据 |
|---|---|---|
| M-a 预热 LRU 文档序截断 | 非漏渲染主因（超限档冷算供给侧成立） | 残留 posBuckets 十桶均匀（非尾部聚集指纹）；漏渲染位置=遍历停留处视口 |
| M-b 泵队列饥饿 | 排除 | 残留时 queue=0 / oldestWaitMs=0 / deferred 最终全清 |
| M-c render 失败无重试 | 排除 | 两轮 traverse renderFailed=0、dropped=0、enqueued=rendered |
| **M-d demote 顺延竞态** | **CONVICTED（M1 唯一根因，M-d'）** | 见下方定罪书；微滚验证：残留条目 ±900px 扰动后全部归零（IO 入队路径存活） |
| M-e 块级无预热无调度 | 完整性排除 | blocks 23/23 挂载率 100%（遍历往返后） |
| M-f update 绕泵竞态 | 未取证（本轮场景无编辑路径） | 范围外留档 |

### M-d' 定罪书（demote 回带竞态漏渲染）

机制四步（lazyInlineMath.ts callbacks/demote）：
1. 元素离带：IO visible=false 回调 → demoteTimer 排程（DEMOTE_DELAY 2.5s）；滚动不静止则嵌套顺延——快速长滚期间 timer 挂起可达数十秒。
2. 元素回带：IO visible=true 回调 → **不撤销挂起的 demoteTimer**；且 rendered=true（demote 未执行）→ 入队被 `if (rendered || queued) return` 挡住。
3. 停稳后 timer 到期：scrollQuiet=true → **demote() 无条件执行**——元素明明在带内/视口内，被降级回源码占位（rendered=false）。
4. IO 状态此后无变化（一直在带内）→ 永无 true 回调 → 无人再入队 → **永久源码占位**。

复现指纹：残留源码连续（{1}{848}-{1}{857}）、位置=遍历停留处、queue=0、renderFailed=0；微滚（离带→回带）后残留 100% 归零。

## 修复立项（阶段五）

| # | 内容 | 靶门禁 | 假设（可证伪） |
|---|---|---|---|
| Fix-A | 回带撤销 demoteTimer + demote 执行前带内跳过（双保险） | M1 3-9 → 0（超限+1MB 两轮） | 若 M-d' 定罪正确，则修复后 traverse 残留=0 |
| Fix-B | 上滚 band 放开「有渲染态高度预留 && 缓存命中」条目的直绘（冷算仍禁，高度安全） | T1 5,615 → ≤2,800（-50%）；t2 峰值 17-22 → ≤10 | 若 T-c 定罪正确，则上滚段积压尖峰消失、长尾收缩 |
| Fix-C（备选） | 静止补绘预算/超限档预热采样 | 视 A/B 后数据 | —— |
