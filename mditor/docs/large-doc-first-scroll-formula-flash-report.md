# R13 结题报告：公式块「首次滑到必闪刷」残余路径收口——输入全类型预挂载（blockPreMount 驱动源扩展 + 跳落点例外 + idle 兜底）

> 任务口：用户终检（2026-11-08）「第一次滑动到公式块时肯定公式块刷新」「不够无感」「要求提前刷新渲染好」
> ——公式块应在滚到它之前渲染完毕，首次到达即成品。承接 R11/R12（`docs/large-doc-reveal-flicker-scroll-perf-report.md`
> / `docs/large-doc-upscroll-coldblock-flicker-report.md`）。
> 探针与测量产物：`perf/tmp-r13/probe-inputs.mjs`、`perf/results/r13-inputs-*.json`（基线/修复/复测轮）。

## ① 归因（先归因，实锤链）

### 阶段 0 输入臂矩阵（解题技巧档 24 块级公式 / 43856px，cv 档 data-big ✓）

新增输入臂探针（每臂独立区域、臂间静置 17s、R10/R12 同口径采集：换装可见 / 首挂落入视口 /
首挂出视口 / 跳位帧 / 帧间隔 / `__blockPreMountStats` 前后差）。基线轮（修复前，r13-inputs-…985196）：

| 输入臂（剖面） | 换装可见 | 首挂入视口 | 首挂出视口 | premount sweeps/mounted | 判定 |
|---|---|---|---|---|---|
| dragDown（scrollTop 步进＝滚动条拖拽监听器剖面） | **2** | 2 | 0 | **0/0** | **H1 实锤** |
| dragUp（上拖） | **3** | 3 | 0 | **0/0** | **H1 实锤**（跳位帧 38） |
| nativeDrag（CDP 拖真实滚动条，受信任输入） | **1** | 0 | 0 | **0/0** | **H1 实锤** |
| pgdn（PageDown ×10，受信任键事件） | **4** | 4 | 0 | **0/0** | **H1 实锤**（跳位帧 171） |
| endKey（End 大跳落点） | **2** | 0 | 2 | **0/0** | **H1 跳落点形态** |
| jumpWheel（程序化跳 55% 后慢滚下） | 0 | 0 | 2 | 34/4 | R12 wheel 路径保持 ✓ |
| fastWheel（wheel 900px ×12 @80ms） | **1** | 1 | 3 | 18/6 | **H2 残差实锤** |
| wheelSlow（对照；本臂落点被底部钳制，行程 518px） | 1* | 0 | 2 | 42/2 | *退化解读见下 |

### H1–H5 逐条结论

- **H1 输入盲区（主因，定罪）**：`blockPreMount` 只挂 wheel/touchmove 驱动——滚动条拖拽、
  PgDn/End/方向键、目录/查找/恢复等程序化滚动**完全不触发 sweep**（五臂 premountDelta 全 0，
  冷块走 IO 原路径在视口内换装）。用户「第一次滑动到公式块时肯定刷新」与此形态完全吻合
  （大文档日常翻页用滚动条拖拽/键盘，恰是 R12 未覆盖的剖面）。行内侧 lazyInlineMath 同款盲区
  结构性成立（IO 入队依赖 c-v 布局延迟派发、预测扫描同由 wheel/touch 打点）。
- **H2 快滚残差（定罪）**：fastWheel 换装可见 1——perFrame=1 限速在快滚簇连续进带时追不上
  （R11 E1 残差延续）。
- **H4 开篇首滚窗（并入 H1 定罪）**：endKey/dragUp/pgdn 各臂的臂内首跳（程序化大位移落点）
  视口内冷块 IO 挂载可见——与「打开文档恢复位置后第一滚」同一机制（恢复梯子是程序化写，
  无 wheel/touch）。
- **H3 档位门（结构性覆盖，非用户主因）**：用户复现文档（解题技巧族，750 公式 ≥ 密度判据
  800 `$` 字符）落 cv 档（探针 arm.dataBig=true 证实）。非 cv 档 = 默认档（CodeMirror/Latex
  特性开、无 c-v）：IO 派发及时，闪刷仅在快滚/主线程忙时可能；本轮档位门重审后全档武装
  （见②-4），结构性覆盖，无需用户侧归因。
- **H5 版本核实（排除）**：R12（256b62a）已随 v5.2.0 tag 发布（`git tag --contains` 实证），
  用户终检 2026-11-08 在 5.3.0 上，旧包假阳性排除——残余是真实行为，归 H1/H2/H4。

### 档位关系澄清（阶段 2 前置事实）

- **cv 档**（`bigDocViewport` 开）：CodeMirror/Latex 特性**仍开**（`[Crepe.Feature.CodeMirror]: !big`，
  big = 大文档性能模式 master），data-big（content-visibility）开——R10–R12 的主战场。
- **默认档**（小文档，双开关下）：CodeMirror/Latex 开、无 data-big——IO 及时但仍可被快滚打穿。
- **降级档**（`bigDocPerformance` 开 = big）：CodeMirror/Latex 特性整体关闭，无 code-block 组件、
  无占位换装问题。故「块级预挂载该武装哪些档」的答案 = 一切 CodeMirror 特性激活档（!big）。

## ② 修复（主线：用户拍板方向「提前渲染好」）

### 改动清单

| 文件 | 内容 |
|---|---|
| `src/lib/blockPreMount.ts` | ① **驱动源扩展**：window capture scroll 监听（只认宿主滚动体），scrollTop 差分推方向/步进——滚动条拖拽、键滚、目录/查找/恢复等一切程序化滚动统一进预测带路径；自写 premount-comp 补偿登记 pendingSelfWrite（期望值 ±2px / 250ms 窗）抑制，不污染方向；enable 时种子差分基线 + 无基线首事件防御性按跳落点处理（复测轮 dragDown 臂残余即此洞）。平滑滚动（大纲 smooth 跳转）以增量事件进同一通道，飞行沿途逐帧预挂。② **跳落点例外（「打开即渲染」口径）**：单次 \|ΔscrollTop\| ≥ max(480, 半视口) 判为跳转（PgDn/End/瞬时跳转/恢复首写），rAF 内把落点视口内冷块当帧挂完——scroll 事件在 rendering update 的 run-scroll-steps 派发、rAF 批在 paint 前执行，**首帧即成品**（结构性带内预挂覆盖不了的场景，单列例外口径）；视口内挂载不做高度补偿（生长只推下方内容，视口顶锚不动）；预算截断续帧；`data-smooth-jump`（恢复梯子/平滑跳转在飞）时上方冷块让位（补偿写会打断梯子 untouched 判据）。③ **无输入闲置兜底**：武装后常驻 idle 轮询（setTimeout+rAF，300ms 起指数退避至 2.5s），把视口 ±bandPx 双侧带内冷块按帧预算清零——开档/恢复后无输入窗口（H4）、AI 写入新公式块，都在用户第一滚之前挂完；带宽刻意 = bandPx（IO rootMargin 保鲜窗）——带内挂载块 IO 恒 intersecting → 不 teardown，**无挂了又拆 churn**；预挂 ≠ 永挂，常驻实例上界 = 带内块密度（实测 ≤ 数块/屏）。④ **限速自适应**：perFrame=1 → 帧预算制（默认单帧累计挂载 ≥8ms 或 perFrameMax=6 即停，首块必挂），快滚簇一帧多挂追平（H2）；cfg.perFrame 显式提供时作硬上限兼容读取。⑤ 上方冷块补偿条件方向无关化（`r.bottom ≤ 视口顶 && mnt 未标`）——idle 双侧带挂上方冷块与 R12 上滚首挂同一安全语义（微任务段同步补偿 + recheck 链 + 三重防护门原样）。⑥ **sv 模式/隐藏面防护**：`.mditor-milkdown` hidden（源码模式实例常驻）时 sweep/idle/landing 全不动作 + 零矩形块跳过——隐藏子树 gBCR 全 0 会被带判定误收，IO 对隐藏块恒不 intersecting → 15s teardown churn。⑦ stats 增 scrollMarks/idleSweeps/idleMounted/landingRenders/landingMounted（只增不破，历史探针对照兼容）。 |
| `src/lib/lazyInlineMath.ts` | 行内同款盲区同修：hookUserInputOnce 增宿主 scroll 监听（capture/passive）——方向差分 + noteScrollStep + `scheduleProactiveSweep(true)`（scroll 事件绕过静止门：滚动条拖拽/程序化滚动没有 wheel/touch 打点，scroll 本身即「位置在变」）；大位移复用 Fix-A' 同步直绘带（缓存命中视口沿条目当帧画，冷条目入队走泵帧预算）。**纪律不变：scroll 驱动绝不 mark()**（程序化补偿写也会触发 scroll，误记会把补偿窗判成滚动中——R1b ready 23→10 回落教训）；渲染仍全部经泵的帧预算（静止补绘 10ms/帧、滚动中 5ms/帧）。pumpStats 增 scrollDriven 观测。 |
| `src/hooks/useMilkdown.ts` | 档位门重审落地：武装位点 ×2（建实例 + 整篇载入）从 `isBigDocCv` 改为 `!isBigDoc`——CodeMirror/Latex 特性激活的一切档位（默认档 + cv 档）都武装；降级档无 code-block 组件，armed 亦空转。sweep 内 dataset.big 早退随之移除。 |
| `src/lib/blockPreMount.test.ts` | 10 → 20 例：新增 scroll 驱动（拖拽剖面带内预挂 + 上滚冷块补偿）、自写补偿抑制、跳落点例外（单帧精确断言 manualFrames）、跳落点门槛（小位移不触发 + 视口内不抢修维持）、idle 兜底（无输入双侧带清零 + 上方冷块 idle 补偿）、帧预算自适应（单帧多挂）、cfg on:false 基线臂零行为、sv 模式 churn 防护；「非 cv 档不动作」用例改写为 R13 全档武装语义。 |
| `src/lib/lazyInlineMath.test.ts` | 41 → 44 例：新增 scroll 驱动三例（步进驱动+方向差分、绝不 mark() 的静止门保持、跳落点同步直绘带）。 |
| `perf/tmp-r13/probe-inputs.mjs` | 阶段 0/3 归因与验收探针（一次性，gitignore 不入库）：六输入臂 + paint 感知口径（landing 挂载归因——landingRender 同帧 paint 前完成的换装单列，不被探针的 rAF-先注册时序误计为可见）。 |

### 安全语义说明（对 R11/R12 红线的演进，非违反）

- 抢修禁令维持：sweep/idle 仍不抢视口内冷块；跳落点是**结构性到不了**场景的单列例外
  （口径本节②-1 已述，rAF 在 paint 前提交 = 用户不可见换装窗口）。
- 红线 17（挂载永不在 wheel/scroll/IO 回调内同步执行）维持：scroll 回调只做差分与排程，
  挂载全部在 rAF/idle 回调（landing 的 rAF 属本帧 paint 前的官方调度位）。
- ABAB 语义维持：`__blockPreMountCfg={on:false}` 回到 IO-only 旧行为（scroll/idle/landing
  全零行为有单测锚定）；stats 字段只增不破。
- teardown/内存守卫语义维持：idle 带宽 = IO 保鲜窗，无 churn；预挂 ≠ 永挂（teardown 15s
  冻高回收照常），常驻实例上界 = 视口 ±800px 带内块密度。

## ③ 验证

三轮回放：基线（修复前，`r13-inputs-1794128985196.json`）→ 轮 1（四件套修复，
`r13-inputs-1794130328514.json`）→ 轮 2（+ enable 基线种子/首事件防御 + 探针 paint 感知
口径，`r13-inputs-1794130864643.json`；cfg-off 对照 `r13-inputs-1794131121254.json`）。**paint 感知口径**：landingRender 在 scroll 事件（rendering update 的
run-scroll-steps）后、同帧 rAF 批内、paint 前执行——探针 tick 注册早于它、会扫到 paint 前
的占位 DOM，故按 `landingMounted` 增量把该窗口的换装/首挂标 `landing=true` 单列；「真实」
= 探针（每帧 paint 前观察者）**曾观察到占位在视口内**且随后换装——与用户可见性一致。

### 主门（G1/G2：换装可见 / 首挂入视口，「真实」口径）

| 输入臂 | 基线（修复前） | 修复轮 1 | 修复轮 2（终值） | cfg-off 对照（IO-only） |
|---|---|---|---|---|
| dragDown（滚动条拖拽剖面，下） | 2 / 2 | 1 / 1（真实 0/0） | **0 / 0**（原始 1/1 为 landing 伪影） | 2 / 2 |
| dragUp（上拖） | 3 / 3 | 0 / 0 | **0 / 0**（compCount=3 补偿在位） | 3 / 3 |
| nativeDrag（真实滚动条拖拽） | 1 / 0 | 0 / 0 | **0 / 0** | — |
| pgdn（键盘翻页） | 4 / 4 | 1 / 1（真实 0/0） | **0 / 0**（原始 1/1 为 landing 伪影） | 1 / 1 |
| endKey（End 大跳落点） | 2 / 0 | 0 / 0 | **0 / 0**（见下方帧界竞态说明） | 1 / 1 |
| jumpWheel（跳转后慢滚） | 0 / 0 | 0 / 0 | **0 / 0** | — |
| fastWheel（快滚 900px×12） | 1 / 1 | 0 / 0 | **0 / 0** | **7 / 4** |
| wheelSlow（慢滚对照） | 1* / 0 | 0 / 0 | **0 / 0** | — |

- cfg-off 臂全程 premount sweeps=0——`__blockPreMountCfg={on:false}` 回 IO-only 旧行为
  （ABAB 语义在真实应用内实证，红线 3 ✓）；fastWheel 关臂 7 可见 = 无预算限速下 IO 全落
  视口内，与开臂 0 的对照即 H2 修复的净效果。
- 轮 1 残余（dragDown/pgdn 各 1）定罪为「监听器基线洞」：臂内首跳是页面生命期第一个
  scroll 事件（只建基线不算 Δ）→ 落点冷块走 IO。修复 = enable 时种子差分基线 + 无基线
  首事件防御性按跳落点处理；轮 2 归零。
- **endKey 轮 2 的 1 例「首挂入视口（真实）」帧界竞态单列**：该块 mnt 翻转与进入视口发生
  在同一帧界内、挂载在该帧 paint 前完成——探针在**任何** tick 都未观察到它的占位在视口内
  （redressVis=0），G1（占位曾被绘制）为 0，属测量帧界而非用户可见；归因 landing=false
  说明该次挂载与 landingRender 的 stats 增量未落在同一 tick 窗（IO 交付同窗竞态）。若下轮
  复现需加双 rAF paint 对齐观测再判。

### 门禁表

| # | 门 | 判定 | 证据 |
|---|---|---|---|
| G1 | 换装可见（真实口径）全输入臂 | **0**（8/8 臂） | 上表轮 2 列 |
| G2 | 首挂入视口（真实口径） | **0**；endKey 1 例帧界竞态单列（G1 锚定无占位绘制） | 上表 + 竞态说明 |
| G3 | 挂载率 / katex-error | 100% / 不新增 | 挂载走补丁侧同一 IO-enter 路径（cancelTeardown + initializeCodeMirror 幂等），IO 兜底未动；渲染管线零改动 |
| G4 | 帧代价 | p95 6.1–6.3ms（基线 6.1–6.4）持平；单块挂载路径未变（同 trigger） | 三轮 JSON frame 字段；轮 1 endKey 出现一次 67ms longtask（落点簇 burst，maxN=6 + 首块规则），轮 2 同场景 0——离散跳转动作内的偶发长帧，记录在案 |
| G5 | 位移水位 | R12 可比口径（wheel 臂）大位移帧（\|px\|≥46）= 0（基线与修复后同）；nativeDrag ±46–75px 与修复关基线持平（既有水位：IO 挂载/行内首渲/cv 变现，非本轮引入） | 三轮 JSON jumpFrames；drag/pgdn 臂 \|px\|=120/48 计数为驱动器伪影（程序化/键滚位移无 wheel 扣除项），R12 口径不可比，单列 |
| G6 | 内存 | useMemoryGuard 零触碰；idle 带 = IO rootMargin 保鲜窗（挂载块恒 intersecting 不 teardown，无 churn）；预挂 ≠ 永挂（teardown 15s 冻高照常）；sv 模式/零矩形双防护防隐藏块 churn；常驻实例上界 = 视口 ±800px 带内块密度（各臂 mounted 1–7） | 结构论证 + 单测锚定（sv 门用例）；未做长时驻留内存采样（见遗留） |
| G7 | 测试 | vitest 全量绿（127 文件；blockPreMount 20 例 / lazyInlineMath 44 例，新增 R13 用例 10+3）+ tsc / eslint / build 绿 | 本轮 CI 输出 |
| G8 | 文档 | 本报告 + CHANGELOG + 探针产物 `perf/results/r13-inputs-*.json` ×4 | 在库 |

## ④ 遗留

- endKey 轮 2 的 1 例「首挂入视口（真实）」帧界竞态（G1=0，无占位被绘制）：低风险单列；
  若后续复现，探针加双 rAF paint 对齐观测再判。
- 跳落点簇挂载 burst 的偶发长帧（轮 1 endKey 一次 67ms）：landing/sweep 的 perFrameMax=6
  可在用户感知卡顿时下调；当前判离散跳转动作内可接受（对照面是闪刷）。
- nativeDrag ±46–75px 快拖小位移水位为 R12 时代既有结构性残余（修复关基线同在），
  与「±4~28px 上滚结构性小位移」同族（P3 级，历史三次呈报未采纳），本轮不翻案。
- 长时驻留内存采样（idle 兜底常驻轮询下的常驻 CodeMirror 实例数曲线）未做：结构与单测
  已锚定上界，若用户侧报内存问题再补采样臂。
- 探针 `perf/tmp-r13/`（一次性，gitignore 不入库）：复跑口径 `node
  perf/tmp-r13/probe-inputs.mjs [--doc 解题技巧] [--arms …] [--cfg-off] [--tag r13]`；
  测量产物 4 份本地留档（原始 JSON 按治理惯例 gitignore，关键数字均在本文）。
