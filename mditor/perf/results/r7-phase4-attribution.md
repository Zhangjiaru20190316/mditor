# R7 阶段四归因定罪书（症状 D：停滚自漂移）

> 证据基线：dev/main HEAD=9e0e4e9（含 R6 Fix-A/B/C）。全部产物在 `perf/results/r7-phase2-*` 与 `r7-phase3-*`。
> 探针：`perf/tmp-r7/probe-drift.mjs`（rAF 级采样，视口顶/中/底三哨兵 + scrollTop/scrollHeight 逐帧 + 250ms 粒度全文档公式 ready/unready 轨迹 + `__scrollDebug` counters/events 差分 + `__mathPumpStats` 差分 + writeTrap 栈）。

## 复现总表（10s 观察窗，t≥400ms 静止门后，位移阈值 4px）

| 场景 | fixture | 位移帧 | scrollTop 程序写入 | anchor.compΔ | MD1001/1002 | mathTrack 信号 | 产物 |
|---|---|---|---|---|---|---|---|
| down-fast r2 | 密度档 | 6 | 1 | 1 | 0/1 | 静止 | r7-phase2-drift-down-fast-density-r7p2-2.json |
| down-fast r3 | 密度档 | 6 | 1 | 1 | 0/1 | 静止 | r7-phase2-drift-down-fast-density-r7p2-3.json |
| up-fast | 密度档 | 6 | 1 | 1 | 0/1 | 静止 | r7-phase2-drift-up-fast-density-r7p2-1.json |
| down-slow | 密度档 | **21** | **4** | **4** | 0/0 | **ready 68→12 持续降（demote 潮）** | r7-phase2-drift-down-slow-density-r7p2-1.json |
| up-slow | 密度档 | 6 | 1 | 1 | 0/1 | 静止 | r7-phase2-drift-up-slow-density-r7p2-1.json |
| down-fast | 1MB | **72** | **11** | **14** | 0/0 | 死水（公式不动） | r7-phase2-drift-down-fast-1mb-r7p2-1.json |
| up-fast | 1MB | **69** | **10** | **14** | 0/0 | 微动（renderedΔ=54） | r7-phase2-drift-up-fast-1mb-r7p2-1.json |

可证伪对照组：

| 实验 | 场景 | 结果 | 产物 |
|---|---|---|---|
| EXP1 等预热完成后复测 | 1MB down-fast | **位移帧 0/367、写入 0、补偿 0**（对照组 72/11/14） | r7-phase2-drift-down-fast-1mb-r7p2b-1.json |
| EXP2 typewriter 开关对照 | 密度档 down-slow | 21/4/4 与关闭时完全一致，无 write:typewriter | r7-phase2-drift-down-slow-density-r7p2c-1.json |
| EXP3 禁 demote（DEMOTE_DELAY→1h，跑完已恢复） | 密度档 down-slow | **位移帧 0/1708、写入 0、补偿 0**（对照组 21/4/4） | r7-phase2-drift-down-slow-density-r7p2d-1.json |

## 定罪结论

### D-e（主犯·密度档全场景）：demote 潮的宽度折行位移 —— 定罪

- **机制链**（证据逐环闭合）：
  1. 占位态公式 span 显示源码文本（宽 W_src），渲染态显示 KaTeX HTML（宽 W_katex）。典型公式（如 `\frac{a}{b}` 12 字符源码 → 紧凑分数）W_src > W_katex。
  2. 滚出 IO 800px 带的公式在 `DEMOTE_DELAY=2500ms` 后且静止时 demote 回占位（`lazyInlineMath.ts:615-630`）。minHeight 高度记忆（:567-569 + 会话表）只锁**该 span 自身高度**，**锁不住水平宽度**——demote 后段落内该公式占位变宽 → 段落重新折行 → 段落块高度改变（实测 layout:block：`#546 P「检验：数值 x=0.1…」47→77（+30px）`）。
  3. demote 的公式在视口上方 → 上方段落高度变化累积 → 视口内容位移（scrollTop 不变，scrollHeight 同步变化），采样帧 t=2411 三哨兵同时 +37px、scrollHeight +1634px。
  4. anchor-comp 两帧确认（SHIFT_CONFIRM_MIN=4px）后补偿写 scrollTop（下一帧 +41.7px，write:anchor-comp）——用户看到「页面跳一格再被拉回」。
  5. demote 潮持续时间 = 滚出带的分散时刻 + 2500ms 的散布（快滚：集中在停滚后 ~2.5s 一格；慢滚：每格间隔 >400ms 静止门，到期者连续执行 → down-slow 四格阶梯 +56.7/+30.8/+28.5/+30px——**生产「一格一格自己动」形态**）。
- **定罪判据**：EXP3 禁 demote → 位移帧归零（0/1708）；mathTrack ready 计数持续下降（68→12）与位移格时刻对齐（down-slow r1：unready 2287→2343，格 t=1128/1589/2048/3640 各处均有上升沿）；write 归因全部 `write:anchor-comp`；泵统计 renderedΔ=0（位移不经渲染泵）。
- 与 §2.B 候选的对应：D-d-⑤「demote 降级回占位在高度记忆缺失时的行高差」的**宽度折行变体**——高度记忆在位也挡不住（宽度维度裸露）。单列 D-e。

### D-b（主犯·1MB 档预热未完成期）：预热分段陈旧 + up 补偿缺席 —— 定罪

- **机制链**：
  1. 预热三段序（band 内 → 带下 → 带上）在 `startCvPrewarm` 启动时按**当时视口**（打开文档，scrollTop≈0）一次性计算（`cvMemory.ts:804-811` `findViewportBand` + `unlearnedOrder` 的 seg1/seg2 分界）。
  2. 1MB 档预热 >45s 跑不完（模块头注剖面证据）；用户深滚到 521k 后停滚，预热让路窗（500ms）结束即恢复推进——**但分段界还是顶部视口的**：以为在量「视口下方」（seg2，不补偿），实际批内块全在用户当前视口**上方**。
  3. 每批 dispatch 强制 `content-visibility: visible` 变现 + `contain-intrinsic-size` 更新（3em 占位 → 实际高度）→ 上方内容持续膨胀（10s 窗 scrollHeight 876104→922891，**+46,787px**）→ 12 格位移（+424/+155/+558/+539/+564/+644/+787/+939/+1301/+638/+1119px…）。
  4. `prewarm.comp` 计数 **零增长**——up 阶段补偿（oldH 量测 + prewarm-comp 写入，:949-963）因 upPhase=false 从未执行；残差全由 anchor-comp 兜底（14 次，每格 85-150ms 可见窗口）。
- **定罪判据**：EXP1 等预热完成后同序列 → 位移帧 0/367、写入 0（§5 D-b 判据「仅出现在打开后预热未完成期间、等预热完成后同序列不复现」逐字命中）；counters 差分 `prewarm.chunk 16→41`（窗内 25 批推进）与位移格节奏一致；`prewarm.comp` 无增长。
- 次要形态（未单独触发观测，代码在案）：up 阶段 dispatch → `nextFrame()` 双 rAF → 补偿，跨 ≥1 帧可见空窗（`cvMemory.ts:673-676, 896`）——分段正确时的残余窗口。随 Fix-B 一并同帧化。

### D-a（次要·1MB up 场景）：泵静止补绘上方冷条目首渲位移 —— 部分定罪

- 1MB up-fast：`pumpQuietΔ=7、renderedΔ=54` 与位移格并存（t=1249 +35px 落在补绘窗内）——上滚 band 留队的无预留冷条目（R6 Fix-B 只放行「有预留+命中」，其余留队）静止后 FIFO 全量补渲染，首渲改变行高/折行（与 D-e 同理：占位宽→渲染窄，或渲染高>占位行高）。
- 密度档未采到（quiet 补绘帧在停滚后 420ms 基线前已清完队列且无位移——队列余量小且多在下方）。定罪级证据不足，随 Fix-A 锁盒机制顺带覆盖（首渲前同样可锁盒），不单列修复项。

### D-c（打字机延迟居中）—— 排除（条件不满足）

- EXP2 开关对照完全一致；write:typewriter 零出现。用户环境 typewriterMode=false（dev store 与生产 store 均确认）。迟发 selectionchange 在本轮全部序列中未出现。留档：若未来开启打字机且报告「松手后页面反向拽」，查 `Editor.tsx:573-621` 的 400ms 静止门。

### D-d（其余裸源）—— 未发现活跃证据

- 全部 11 轮采样 MD1001=0；writeTrap 除 anchor-comp（tick :838 自身写入）外仅 2 条 0→0 无害写（Editor 挂载期）。代码块挂载/图片/webfont/批注四项在本轮序列无时间对齐位移。

## 修复排序（阶段五依据）

1. **Fix-A**：demote 占位锁盒——宽度+高度双记忆，渲染态盒尺寸锁定（高度中性 demote，D-e 根治）。原型先行（§8）：真实环境验证锁盒 CSS 行高中性性。
2. **Fix-B**：预热批方位动态判定——每批 dispatch 前按批内块当前 DOM 位置决定是否记 oldH+补偿（up 补偿不再依赖启动时 band）；up 补偿单 rAF 同帧化（D-b 根治）。
3. **Fix-C**（视 Fix-A 原型结果并入或独立）：静止补绘上方冷条目首渲锁盒（D-a 残余）。
