# 第五轮 阶段四：归因定罪书（症状 F 乱闪 / 症状 J 乱动）

日期：2026-10-02。HEAD 基线：ab9582d + 观测补点 2736488。
证据索引：perf/results/ 下 r5-phase1-*（生产日志）、r5-phase2-*（复现探针）、scroll-flash-bench.jsonl（基线）、.workflow/task2-forensics/devlog-r5*（原始日志）。

## J 组（乱动）定罪

### J-1 CONVICTED：切标签恢复链「落点回拽」（生产 J-γ/J-β 同族）
- 证据：r5-phase2-j-alpha-r5j-a2/a3.json（2/2 同签名，a1 保存位 0 不触发）；栈：Editor.tsx writeViewportTop → viewportAnchor.ts:70 → scrollDebug anchor-comp（tick）。
- 机制：切回 → 整批重建（pm:rebuild -383/+938）→ 恢复梯子打标写 8100 + 锚块精落地 → 高度表重学期视口上方内容收缩 217px → anchor-comp 二帧确认后拽回 -217px。终态 7883 ≠ 保存 8100。-217px 三轮完全一致（确定性）。
- 定性：补偿方向正确（保画面内容静止），但①回拽前有 1-2 帧错位窗（可见跳动）；②位移源=下方 Fix F-1 的弹跳波——**修 F-1 后此形态预期大幅消减，复测再定是否需要独立修复**（红线 13：不动协调层除非数据要求）。

### J-2 CONVICTED：块高弹跳波（F/J 同源主犯，J-d 路径坐实）
- 证据：r5-phase2-f-tabback-r5f-tb1.json blockWatch（块 #21 全生命周期：81 → 48（doc2 首开冷表，3em）→ 预热 visible 305（源码文本 wrapping）→ 重预热重测瞬态 32 → 回 81）；三轮 alpha/j-beta layout:block 波（115-358 处/波）；生产心跳 layout:height 17→395 同窗。
- 【R5 修订（ABAB 消隐后）】初版"切回装饰丢失"假说被证伪：切标签载入走 EditorState.create，插件 init 即从高度表重放装饰（单测 r5 证实）；tabback 采样 t=17264 的 style="" 是 **doc2 首开会话内冷表**（该内容从未学过，3em 属设计内预热前状态）。
- 机制链（终版，两个放大器 × 一个根因）：
  1. 根因：行内公式「源码占位文本 ↔ KaTeX 真身」高度二象性（占位可高于真身 57 vs 34，也可低于 81 vs 103——取决于公式长短）。
  2. 放大器一（首开冷表窗）：会话内首次打开某文档，高度表无该内容 → 全部 3em 占位 → 预热分批学习期间块高逐批跳变（生产用户"打开文档就开始滚"正落在此窗）。
  3. 放大器二（每次载入全量重预热）：setValue 载入路径对 cv 文档无条件 scheduleCvPrewarm，已知内容也被强制 visible 重测——重测捕捉过渡瞬态写入高度表（81→32→81 反复），装饰随批弹跳；切回已知文档本可零预热瞬时完成。
  4. 事务路径装饰丢失（真但非切标签路径）：tr.replace 全文（replaceAllStampedDoc 家族：AI 全文写回/批注回退/脚注插入）经 decos.map 全部丢弃（单测证实）——ghost-stress 结构海啸阶段/AI 写入场景的 MD-1011 高度塌陷窗。
- 用户感受：开档/切回后 10-20s 窗口内视口上方内容反复位移（页面「乱动」）+ 视口内块自身视觉跳变（「乱闪」）。
- 修复映射：Fix-B 治根因（已知公式占位保持渲染态高度）；Fix-C 治放大器二（预热只学冷块）；Fix-A 治第 4 条（事务路径内容寻址重放）；放大器一（首开冷窗）由 Fix-B/C 共同收窄（首开学习期间占位高度即接近真值、且只学一次），残余为设计内首次学习成本。

### J-3 INCONCLUSIVE：生产 +32s 未打标整千像素跳变（J-α''）
- dev 两轮 + 静置窗均未复现（切回后全部写入有打标且 1s 内收敛）。环境差异：生产有 heal/handoff 恢复链、异步 AI 插入（Editor.tsx:842 注释自认 insert() 事务带 scrollIntoView 且调用方可为异步回调——PM 内部滚动不经 noteScrollWrite）、跨天会话状态、窗口焦点事件（不入 actions 日志）。
- 处置：观测补点已落地（commit 2736488 写入陷阱，ghost 事件附调用栈）——**下次生产复发即从栈直接定罪**，本轮不预设写入方结论、不盲改。

### J-4 FALSIFIED：大纲跳转 smooth 尾巴出窗误报（原 J-β 假设）
- dev 大纲连击（r5j-b1/b2，跳距至 ~1.5k px、动画 700-900ms）零 ghost：SMOOTH_JUMP_WINDOW_MS 与 smoothJump 1200ms 生命周期覆盖充分；Chromium smooth 时长上限 ~700ms 级。
- 生产 ±103px 事件发生在大纲点击后 15-18s（非动画期）→ 并入 J-1/J-2（导航后漂移族）。smoothjump.expire-moving 计数器已加（2736488），生产侧留观。

### J-5 FALSIFIED（作为独立主犯）：渲染泵积压滞后
- 1MB 档滚动帧 p50 233ms 的主因是布局重排墙（第四轮已封案：原生布局 2,315ms）而非泵队列深度；密度档 on 臂泵 p95 帧 6ms（scroll-flash-bench r5base on r1/r2）。泵本身的调度（视口内优先+带内+预算）工作正常。

## F 组（乱闪）定罪

### F-1 CONVICTED（= J-2 同源）：块高弹跳波/回落（§2.B4/B5/B7 合并）
见 J-2。三个既有候选（MD-1011 结构海啸、fulldoc.setValue 整批重建、cvMemory 预热期）证伪为独立主犯、合并定罪为同一机制链的不同切面：
- MD-1011 的真触发者=普通切标签（生产样本 -937/+938 与 dev 切回完全一致），非 AI 写入；
- 预热期闪变（F-c）= 放大器二的直接表现；
- remembered-size 回落 = 放大器一。

### F-2 CONVICTED（1MB 档）：滚动中源码占位长残留（§2.B2 上滚权衡的量化）
- 密度档 on 臂：阅读节奏下很轻（探针 3 事件/37ms；bench 17 事件 p95 40ms、峰值并发 10）——泵+800px 余量兜住。
- 1MB 档 on 臂：95 事件、源码态可见 p95=4,892ms / max=5,404ms（r5-phase2-f-upscroll-r5f-u1mb.json）——滚动帧 p50 233ms 全程超 50ms，泵预算 5ms/帧杯水车薪，主因=1MB 布局墙（已封案不可治项）+ 占位/真身高度差放大视觉闪变。
- 处置：Fix B（占位高度内容寻址）预期显著缓解视觉高度跳变；源码→公式的渲染滞后本身受布局墙约束，不单独立项。

### F-3 FALSIFIED-AS-UNMEASURABLE：代码块销毁窗回滚闪烁（§2.B3）
- 密度档/解题技巧 fixture 代码块各仅 1 个且位置不定，探针两轮均无法构造「滚离 800px 停 15s 再回」的稳定场景。第四轮已参数化 TEARDOWN_DELAY=15s（patch）。放弃专项数值基准，以 ghost-stress 编辑阶段与 md1011-verify 覆盖；生产证据无此形态记录。

### F-4 katex-error=13（1MB on 臂）待判定
密度档 on 臂 =0。1MB 文档可能本身含非法 LaTeX（压测副本混入）——待 off 臂对照（基线链运行中）；off 臂同 13 则为文档内容问题非管线回归（红线 4 无虞）。

## 与任务书 §2.B/§2.C 候选对照表（逐一证伪记录）

| 候选 | 结论 | 证据 |
|---|---|---|
| §2.B1 占位↔KaTeX 交换 | 部分定罪（并入 F-1/F-2：高度二象性为根因之一） | tabback blockWatch、1MB p95 4.9s |
| §2.B2 上滚带内权衡 | 量化完成：密度档轻、1MB 重 | r5f-u1/u1mb、bench r5base |
| §2.B3 代码块销毁窗 | 不可测（fixture 缺代码块），未定罪 | 探针两轮 before=null |
| §2.B4 MD-1011 结构海啸 | 定罪：触发者=切标签；机制=装饰丢失+表格块学习缺位 | a1/a2/a3 pm:rebuild -937/+938 vs 生产样本 |
| §2.B5 fulldoc.setValue 整批重建 | 并入 F-1（切标签路径即其形态） | 同上 |
| §2.B6 图片首载位移 | 未触发（fixtures images=0） | 生产 doc images:0 |
| §2.B7 cvMemory 预热期 | 定罪：并入 F-1 放大器二 | tabback t=17652/29171 |
| §2.C2 写入方重叠 | 机制定罪：anchor-comp 在 tab-restore 后 149/156ms 插队（现会被计 overlap.restore-intrude）；定性=设计内补偿，位移源在 F-1 | a2/a3 栈时间线 |
| §2.C5 指令积压/恢复阶梯 | 阶梯本身每次写入有打标、无积压形态；重叠即 J-1 | 陷阱统计 set-scrollTop×3/轮 |

## 修复立项（阶段五执行序）

1. **P0 Fix-A（F-1/J-2 放大器一）**：cvIntrinsicPlugin.apply 对整批替换（单 ReplaceStep 覆盖 >50% 文档）立即 buildDecos(doc, null) 重放内容寻址装饰。预期：切回/载入后块高保持学得值（81 而非 48），MD-1011 高度塌陷窗消失；ABAB 口径=scroll-flash-bench openWindow.blockChangeEvents + tabback 探针块高轨迹 + ghost-stress MD-1001/1011 计数。回退：单条件分支，revert 即回旧映射路径。
2. **P0 Fix-B（F-1/F-2 根因缓解）**：lazyInlineMath renderedHeights WeakMap → 内容寻址 Map（源码→高度，容量 8192 与 katexCache 同量级），占位 minHeight 跨重建存活。预期：占位/真身高度差 → ~0（已知公式），弹跳波与首次渲染行高跳变大幅消减，1MB 源码态残留时长下降。等价性清单（红线 11）不变：只加 minHeight 样式，不动文本/选区/查找语义。
3. **P2 已落地**：观测补点 2736488（写入陷阱+J2 计数+smoothJump 计数）。
4. **P3 留档**：表格块高度学习缺位（rmSamples 全 table-block）——Fix-A 后 MD-1011 残余若仍显著再立项；F-2 之 1MB 布局墙不可治项维持第四轮结论；J-3 待生产栈证据。
