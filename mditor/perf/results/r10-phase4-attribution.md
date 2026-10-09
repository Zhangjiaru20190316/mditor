# R10 阶段四归因定罪书（症状 S：滚动底部闪刷/换装可见）

> 环境：dev（tauri debug, CDP 9223）/ prod（用户安装版 5.0.1-beta, CDP 9224, ProductVersion 实证）；
> WebView2 runtime 154.0.4258.62（较 R9 期 .48/.53 又自动更新——环境项登记，T 类绝对值以同批 ABAB 为准）。
> HEAD 起 a7ad946（任务书）→ c053e59（观测设施）→ fc32959（观测二批+证据）。
> 探针：perf/tmp-r10/{probe-flicker,prod-flicker,flicker-watcher}.mjs；口径：换装可见事件 = 换装完成时刻元素与视口相交的联合判定（帧粒度）。

## 0. 基线（阶段二/三实测，同口径可复现性：同场景同文档三轮一字不差）

| 场景 | 档 | S1 换装可见 | S2 重闪 | 证据文件（perf/results/） |
|---|---|---|---|---|
| prod down-slow ×3 | 无穷级数_习题集（真实 156KB=密度档同源） | **1234 / 1234 / 1234**（inline 1233 + code 1） | 0 | r10-phase2-flicker-prod-down-slow-other-r10p2-{1,2}-*.json + r10p3-1 |
| prod down-fast | 同上 | 884 | 0 | r10-phase2-flicker-prod-down-fast-other-r10p2-1.json |
| prod revisit ×2 | 同上 | 222 | **164 / 164** reflash | r10-phase2-flicker-prod-revisit-other-r10p2-1 / r10p3-1 |
| prod down-slow focus | 同上 | 1262 | 0 | …-down-slow-other-focus-r10p2-1.json（模式对称 1262 vs 1234） |
| prod down-slow | 一元微分_习题集（真实 222KB/3631 公式） | 1795 | 0 | r10-phase2-flicker-prod-down-slow-other-r10p2-1.json（doc 字段区分） |
| dev down-slow ×3 | 密度档 fixture | 1176/1176/1176 | 0 | …-dev-down-slow-density-r10p{2,3,4}… |
| dev down-slow ×2 | 解题技巧（23 latex 块） | 407（inline 394 + **blockMath 12** + code 1） | 0 | …-dev-down-slow-switch-r10p{2,3} |
| dev revisit | 解题技巧 | 165 | **115** reflash | …-dev-revisit-switch-r10p2-1 |
| dev down-fast | 1MB fixture（897,821px） | 232 | 0 | …-dev-down-fast-1mb-r10p2-1（帧 p50 165ms=R8 布局墙背景底） |
| dev revisit | 1MB | 118 | **40** reflash + **19 demoteVis** | …-dev-revisit-1mb-r10p2-1 |

**S3 高度瞬态**：块首渲高度差（hdelta>8px）全部场景 = 0（R7 锁盒/冻结高生效）——S-Ⅲ 形态在本轮全部场景无证据；scrollHeight 停滚漂移帧 1MB 档 11~15（非零，与 cv 变现一致，D1 停滚位移口径另测）。
**S-Ⅳ 底部聚集**：prod down-slow 换装事件十桶 [0,0,0,0,0,0,2,289,431,512]——底部三桶 99.8%，**坐实**（非感知偏差）。
**M1/M2/M3**：全程 unreadyVis=0 / queue=0 / katexErr=0，块挂载率收尾 100%——完整性硬门基线全绿。
**S5 录屏基线**：未采（用户未回填症状录屏请求；阶段六以修复前后分段录屏呈现复核）。

## 1. 定罪结论（先分形态，再归因机制）

### S-g【定罪·主犯】IO 交叉通知对 cv-skip 子树系统性滞后（S-Ⅰ 主形态的机制根因；任务书 §2.B 未列候选，本轮新增；非 S-a~S-e 任一）

**机制链**：cv 档 `content-visibility:auto` 跳过视口外块渲染（含布局）→ 块内行内公式/代码块 nodeview 无布局几何 → IntersectionObserver 交叉计算对无几何（或陈旧几何）目标不报告进带（**与 rootMargin 无关**）→ 块进入浏览器预渲染窗（实测几何反推 ≈ 视口外 0~400px）被布局 → IO 下一帧才派发回调 → 泵直绘（katexCache 命中 <0.1ms/条，帧率无感知）→ **换装完成时刻元素已在视口内（bucket 7/8/9）**，120ms opacity 过渡放大为可见淡入闪刷。

**证据链**（全部独立可复验）：
1. **E-mech slow**（…-density-r10p4-3.json `row.mech`）：6 步慢滚（220px/450ms），关注集 unready=3/3/3/3/0/0、`ioEnter`（IO 进带回调计数）=2/2/2/2/5/5、queue 恒 0——**IO 回调在元素真实进带后 ~1.4s（≈3-4 步/700-900px）才阵发到达**；到达后泵同帧消费（queue 恒 0）。
2. **E1 原型 io1600**（…-density-r10p4-1.json）：应用 IO 带扩至 1600px，S1=1176 与基线 1176 **一字不差**——换装触发与 rootMargin 完全无关（交叉判定本身依赖几何，无几何时 margin 无意义）。跑完已恢复（IO_MARGIN="800px" 自证）。
3. **lag 几何反推**（…-density-r10p3-1.json）：换装 lag p50=2807ms（进探针 1600px 带→完成）×0.465px/ms≈1305px 位移，完成点 bucket 8/9（视口内 60~200px）→ 探针 IO 触发时元素距视口 ~1400-1600px（探针带工作正常）→ 应用 IO 若在 800px 带正常触发应早 1.7s 完成（vis=false）——实际没有。
4. **瞬跳对照**（E-mech fast 版，…-r10p4-2.json）：单次 wheel 1200px 后 180ms 视口下 100~700px 带内 unready=0——瞬跳把块直接甩进预渲染窗（布局已发生）→ IO 立即报告 → 渲染完成。同机制反证：滞后只在"渐进接近"路径出现。
5. **S-b 排除佐证**：deferred=0（无预算耗尽回插）、queueDepth=0（无积压）、oldestWaitPeak=4.3ms（无饥饿）、hitPaints 1319/1321（98%+ 命中直绘）——泵无任何瓶颈，S-b（预算/帧饥饿）**排除**；R6 T1 帧饥饿长尾与本症状不同源（帧率 p95=6ms 全程正常）。
6. **批相位**（…-r10p4-2.json 事件序列）：事件批间隔 463ms 与 wheel 步距严格同相、每批 ~6 个（=220px 步进的行内密度）、批首 bucket 7/8——换装严格发生在"块变现帧"上。

### S-d【定罪·行内侧 S-Ⅱ】demote 回退 → 回访重绘可见

**证据**：E-d 原型 no-demote（…-revisit-density-r10p4-4.json）：revisit reflash **164→0**（fresh 66 残余=回访段首次渲染，同受 S-g 滞后）。DEMOTE_DELAY 跑完已恢复 2500。机制：离带 2.5s+静止 → demote 回源码占位（锁盒保形）→ 回访时重绘受 S-g 滞后 → 重绘完成于视口内 = "已渲染的又闪一遍"。1MB 档另有 demoteVis=19（demote 潮部分落视口边缘内可见）。
**注**：demote 语义本身是 R1 以来内存权衡的既定架构（红线 1 常量不动）——修复方向是重绘提前出视口（Fix-A 同路径），不是取消降级。

### S-a【定罪·块级 S-Ⅰ】块公式/代码块 nodeview 挂载换装可见（S-g 的块级表现）

**证据**：dev 解题技巧 down-slow：13 次块挂载（12 latex + 1 code）**全部 vis=true、bucket 8/9**，且 ph→done 单帧跳变（源码 pre 一闪即变 KaTeX）。块级 nodeview 与行内共用共享 IO 800px 频带——S-g 滞后同样吃掉提前量；块挂载链（CodeMirror+Vue+KaTeX+DOMPurify 同步重活）在变现帧后一帧内完成。"等元素"（普通代码块同闪）坐实（1 例 code 块同形态）。outrun 指纹（快滚>>慢滚）不成立（down-fast 884 < down-slow 1234）——非"穿越快于挂载"类竞态，统一归 S-g。

### S-c【暂缓·观感层】120ms 过渡与占位样式

未单独定罪：S1 口径（换装完成时刻）不受过渡影响，trans-off 原型预期 S1 不变（观感项）。**暂缓理由**：S-g/S-a 修复后换装移出视口，过渡在视口外发生即不可见；若修复后 S1 残余仍高再深挖（红线 20：过渡视觉策略改动须录屏对比+用户观感复核）。

### S-e【排除（本形态集）】cvMemory 占位高变现跳动（S-Ⅲ）

hdelta>8px 全场景 0；R9 F-a 宽度陈旧形态（宽度变化后首进视口跳动）在固定宽度探针场景不触发。S-Ⅲ 在本轮症状集内无证据——**用户感知的"渲染不自然"由 S-Ⅰ/Ⅱ 承载**。R9 F-a 归档案维持（未重开）。

### S-f 核对
①posBuckets 旧口径（残留）未用于本轮判定 ✓（新口径独立建立）；②katexCache 命中直绘非闪源 ✓（直绘本身 <0.1ms，问题在时机）；③锚定补偿链未触碰 ✓；④keepwarm/掉帧正交 ✓（帧率全程 p95 6ms）。

## 2. 修复立项（阶段五）

- **Fix-A（主修复）**：S-g 的根治——行内公式新增**预测式主动预渲染发现路径**：滚动帧用块高记忆/块框高（cv 估算高度读取不强制布局）从视口位置累加定位带内块（视口下 0~FORWARD_BAND_PX），对含未渲染行内的块主动入队（走既有 enqueueRender/泵预算/上限路径，IO 回调保留为兜底）。换装预期移至视口外 600~800px。§8 创新条款全流程（原型先行/复杂度/三档实测/降级开关/千次随机编辑差分）。
- **S2/S-d**：Fix-A 同路径覆盖（重绘提前出视口）。
- **S-a 块级**：挂载策略属拍板项（红线 19）——先出 Fix-A 行内数据，块级主动预挂载原型（限速预挂）另报拍板材料。
- **不动项**：IO_MARGIN/DEMOTE_DELAY/TEARDOWN_DELAY/泵常量、120ms 过渡、cv 档架构、补偿链、KaTeX 单实例（红线 1/4/19/20/21）。

## 3. 复现性与环境声明

- prod 真实文档（用户库 E:\笔记\cmc\02_习题集）为主战场；fixtures 不在 prod 库（未污染用户库），prod 1MB 档以真实 222KB 为最大档、1MB 档 dev fixture 承载——报告写明。
- dev/prod 同源复现（1176 vs 1234，差 5% 为环境底）——本症状非 dev-only/非 prod-only。
- 执行事故留档：①prod 探针 taskkill /IM 误杀并行 dev 实例（红线 10 亲踩，1MB run1 报废重跑；此后全部串行）；②focus run 曾因文件名缺 mode 覆盖 normal run 文件（已修文件名并重跑）。
