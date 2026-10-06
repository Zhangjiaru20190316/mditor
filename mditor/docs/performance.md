# 大文档性能优化：三阶段架构（V3.6.5）

> **第三轮（全面治理·阶段 1，2026-08-28）**：八路径摸底 + 两项修复，详见
> `docs/overhaul/1-performance.md`——cvMemory 装饰增量映射（1MB 档打字
> 每键 ~500ms 装饰对账归零）、工作区搜索并发池（200 文件 4750→625ms）、
> 冷启动结案（0 长任务）、1MB 档全路径基准入库（`perf/results/big1mb-*`）。

目标：把"打开 / 切换大文档（1MB+）"的主线程长任务拆掉。三个阶段共享同一
底座——**内容寻址的解析缓存**——且每一步都保留既有遮罩/最短可见时长机制作
为兜底，任何一环失败都静默回退到上一层的现状路径。

> **用户开关**：整套大文档档位由设置「性能与诊断 → 大文档性能模式」总控
> （`Settings.bigDocPerformance`，默认关——大文档保持完整渲染，需要省内存
> 时手动开启）。`useSettings` 在设置加载/更新时同步写入 `memory.ts` 的模块
> 开关，`isBigDoc` 据此恒 false（恒不降级）；开关切换导致当前文档档位翻转
> 时，`useMilkdown` 自动重建编辑器以恢复/移除 CodeMirror 与 KaTeX 特性
> （它们是 create-time 特性位）。

```
打开大文档（富文本）
  ├─ beginSwitch：loading bar / 遮罩立即上屏（动效先行，不变）
  ├─ 读取内容（hover 预读缓存 → readTextFile）
  ├─ prepareDoc ──→ ①docCache 命中？→ 是：瞬时返回
  │                ②worker 后台 remark 解析（阶段 2）→ mdast
  │                   → 主线程 ParserState 轻量映射 → 文档 JSON 入 docCache
  │                ③worker 不可用/超时/过期 → false（走 ④兜底）
  ├─ showDoc → setValue
  │    ├─ docCache 命中 → Node.fromJSON + EditorState.create（零解析，阶段 1）
  │    └─ 未命中 → 原地 parserCtx 解析（现状路径）→ 结果回填 docCache
  └─ finishSwitch → idle 窗口预解析"下一个最可能目标"（阶段 1）
```

## 交互路径卡顿治理（V4.6.0，2026-08-27 实测驱动）

三阶段架构解决的是「打开/切换」；本轮治理的是**交互路径**（点击/选区/失焦
回焦），证据全部来自 dev-anomalies.log 的真实用户数据（152KB/3447 行 KaTeX
习题集，`big:false`，MD-1003 1.2~1.5s × 24 次 + MD-9001 单窗 77~103 掉帧）
与 CDP 驱动的复现测量（`perf/` 目录，221KB/3447 行同型文档副本）。

### 根因（两项，均已修复）

1. **聚焦切换的全文档样式重算（主犯）**：crepe 的 cursor.css 仅在
   `.ProseMirror-focused` 上定义 `--prosemirror-virtual-cursor-color`。聚焦/
   失焦使该自定义属性在「无→有」间翻转，Blink 必须作废 .ProseMirror **全部
   后代**的样式（十万级节点级联重算）。实测 blur→focus() 单次 **762ms**；
   用户侧「点选区工具栏/侧栏按钮 → 编辑器失焦 → 点回正文 → 重付」正是日志
   里反复出现的 1.2~1.5s MD-1003。修复：global.css 让该变量在非聚焦态以同
   值恒定存在（`.ProseMirror.editor`，特异性压过 crepe），聚焦切换成为值不
   变的 no-op → 实测 **0ms**。视觉零变化（该变量仅虚拟光标使用）。
2. **虚拟光标插件的每事务强制布局读（从犯）**：prosemirror-virtual-cursor
   在每个 PM 事务 / selectionchange / ResizeObserver 回调同步跑
   `getCursorRect`（读 DOM 选区 rect）；布局脏时每次读取都是一次全文档同步
   布局（点击场景实测 773ms self time，10 次点击中 3 次中档长任务
   152/132/120ms）。修复（patch-package，`patches/prosemirror-virtual-cursor
   +0.4.2.patch`）：三触发源合并到单一 rAF + `(doc, head, clientWidth)` 缓存
   同位跳过 → 中档长任务 152→86ms。

### 量化（perf/baseline.mjs，同法复测，221KB/3447 行 KaTeX 文档）

| 场景（默认设置，big 关） | 修复前 | 修复后 |
| --- | --- | --- |
| 点击段落 ×10：最长任务 | 945ms | **167ms** |
| 点击段落 ×10：>200ms 长任务数 | 1 | **0** |
| 点击事件延迟 p95 | 976ms | **192ms**（p50 24ms 不变） |
| 双击选词 + 选区工具栏加粗 | （日志侧 1.2~1.5s MD-1003） | **0 长任务** |
| blur→focus 单次 | 762ms | **0 长任务** |

### 已定位但未动的项（数据不支持或超出默认行为约束）

- **打开/切换的 ~2.0~2.2s 长任务**：实测**与解析无关**（worker 管线解析同型
  221KB 文档 <5ms，主线程 profile 中 remark 函数合计 <10ms）——成本 100% 是
  1658 个顶层块 × KaTeX 子树的**首次全量布局**，由 PM updateStateInner 的
  选区同步读（Chrome kludge 读 focusNode）同步触发。遮罩期内发生，属必要
  成本；content-visibility 是唯一杠杆（见下）。
- **floating-ui TooltipProvider 的 observeMove 轮询**（表格/列表拖拽句柄，
  profile 中 getBoundingClientRect 归因 ~750ms）：实验证明它只是**替同帧
  绘制预付布局款**（打「位置未变不写样式」补丁后长任务总量 1268→1262ms，
  噪声内）——已按纪律回退，勿再追。
- **打字事件延迟 ~140ms**：dev 构建 + CDP 合成输入的固定开销（分布平坦
  120~144ms，无长任务）；用户生产日志 worstInputLagMs=6ms，非真问题。

### 阈值体系评估（「夹缝区间」结论）

真实用户文档（152KB/3447 行）落在 200KB docCache 阈值之下、又被默认关闭的
总控压住 big 档位——「夹缝区间」文档默认既无解析缓存也无 content-visibility。
实测数据说明：

- 对 ≤221KB 的文档，**解析成本可忽略**（<5ms），一切卡顿都是布局/样式成
  本——所以「把 docCache 阈值降到 100KB / 解耦 worker 预解析与总控」对这
  一档文档**没有可测收益**（打开长任务由布局决定），本轮不做；
- big 档位（c-v + 特性降级）在同型文档上的实测收益：打开 3411→**1291ms**、
  打字延迟 p95 144→**32ms**、滚动 p95 65→**6ms**、点击长任务 17→**0**。
  修复后即便不开 big 档，交互停顿也已消除（上表）；**big 档的剩余价值主要
  在打开/切换/滚动与内存**，对 3000 行以上且频繁切换大文档的用户值得推荐
  开启（保持默认关不动，见铁律）。

### 复现与测量基建（`perf/`，随仓库交付）

- `perf/cdp.mjs`：零依赖 CDP 客户端（Node 原生 WebSocket）。
- `perf/baseline.mjs`：七场景基准（打开/点击/选区/打字/滚动/全选/撤销），
  `node perf/baseline.mjs <标签>` → `perf/results/<标签>.json`。
- `perf/profile.mjs` / `profile-typing.mjs` / `oneclick.mjs`：CPU Profile 采
  样与 self-time 聚合；`profile-callers.mjs`：热点函数调用方链分析。
- `perf/first-interaction.mjs`：首交互阶梯实验（定位 focus 问题的那把刀）。
- `perf/rect-spy.mjs`：页内 rect 读取打桩（谁在强制布局）。
- 运行方式：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`
  启动 dev 实例（`npx tauri dev --config src-tauri/tauri.dev.conf.json`，独立
  identifier `com.mditor.app.dev` 不与生产实例冲突；workspace 预置
  `perf/fixtures/` 文档副本，**绝不碰真实笔记**）。
- 基准数据：`perf/results/`（baseline-1 修复前 / after-fix1-fix2 / final-bigmode）。

## 第二轮：选中与编辑路径（V4.6.1，2026-08-27 实测驱动）

第一轮修掉聚焦重算与虚拟光标读之后，同一份习题集（已涨到 154KB/3609 行，
`big:false`）仍报 MD-1003（最长 3822ms，触发序列＝点行内公式→点正文→点
选区工具栏）与 MD-4011「DOM 持续增长 14.5 分钟 +213,857 节点」。本轮先归
因、后动手。

### 归因（先证伪再实锤）

- **MD-4011 是检测器假阳性，不是泄漏**：心跳计数复核（`perf/a0-verify.mjs`
  读 dev-events.log）显示期间 domNodes 恒定 ~214,120±200、cmEditors 0-1、
  katexNodes 3611——**无增长**。真因＝用户 15:15:32 切到空文档（267 节点）
  → 15:16:02 切回习题集（214,278 节点），15 分钟趋势窗口把跨文档基线差当
  成了持续增长。已修：`HeartbeatPoint.docKey` + `sameDocTail` 尾段切割
  （devAnomaly），同文档真实累积仍报、旧格式点行为不变。
- **选中链路的真凶是「全量渲染 DOM 的原生强制布局」，不是 JS**：CPU 剖面
  （`perf/profile-select.mjs`，224KB 副本）——三击 self-time 前 two =
  `getBoundingClientRect` 724ms + `(program)` 744ms；点公式 ×3 =
  1470ms + 3832ms；拖选 = 749ms + `caretPositionFromPoint` 890ms（浏览器
  命中测试）。rect 抓现行（`rect-spy2.mjs`）显示读取大头是 scrollDebug
  哨兵（每帧 2 次，**预付布局款**，同帧绘制反正要付，第一轮 observeMove
  教训适用）与 floating-ui 测量——**杀读者无用，要让布局本身变便宜**。
- **公式点击的第三付款人**：crepe `LatexInlineTooltip`（debounce:0）每次
  shouldShow 都 `new Schema + new EditorView` 且不销毁旧视图（泄漏 detached
  view）。已 patch（Schema 单例 + destroy 旧 + 同公式复用）。

### 修复清单（各自独立提交）

| # | 改动 | 量化 |
| --- | --- | --- |
| 1 | 停用 crepe Toolbar（链接/行内公式先并入选区工具栏再禁） | 消每事务 shouldShow 序列化 + Vue 重渲染 + floating-ui 定位 |
| 2 | SelectionToolbar 拆 frame/commit + StatusBar 尾随防抖 | 拖选期间 O(选区 DOM)/帧 的序列化归零；提交时走 PM textBetween |
| 3 | crepe 行内公式提示 patch | Schema 单例 + 旧视图销毁 + 同公式复用（泄漏根修） |
| 4 | code-block teardown 重排 patch | 聚焦/选中时离视口的块不再永久挂载（卫生修复，非主因） |
| 5 | 停键序列化挪 idle 窗口 patch | 225KB 实测单次 80ms 的 eq+serialize 不再占用停键后的交互帧 |
| 6 | **bigDocViewport 子开关（本轮主杠杆）** | 见下表 |

### 量化（`perf/select-bench.mjs`，224KB/3609 行 KaTeX 副本）

| 场景（事件延迟 max，ms） | 默认路径（修复后） | + bigDocViewport | + bigDocPerformance |
| --- | --- | --- | --- |
| 拖选（按住拖半行） | 432 / 656 | **40 / 456** | 16 / 168 |
| 三击选段 | 616 / 352 | **96 / 64** | 0 / 16 |
| 点公式→点正文 ×3 | 584 / 576 | **24 / 32** | （公式渲染已关，场景跳过） |

> 基准口径：同一台开发机不同时段的整机负载漂移实测可达 2-3 倍
> （sel-*.json 保留了 b1/head/stack 各窗口原始轮次），**跨时段单轮对比
> 不可信**——同窗口 ABAB 交错对比 + CPU 剖面归因才是本轮的出数方式。

### bigDocViewport：content-visibility 与减配解耦

big 总开关实测能把选中交互压到 ≤16ms，但同时关闭 KaTeX/CodeMirror 渲染
——对公式密集文档等于砍掉内容价值。新设置 `bigDocViewport`（默认关）只
启用视口化（data-big CSS + cvIntrinsicPlugin 高度记忆 + 预热），保留全部
渲染特性；实现上把「体量够大」「减配档」「视口档」拆成
`sizeIsBigDoc / isBigDoc / isBigDocCv` 三层（`lib/memory.ts`），档位翻转
重建判定覆盖两档（顺带修复了 `maybeRecreateForBigDoc` 单档翻转时不重建
也不落地内容的缺陷）。正确性：Ctrl+A 跨视口全选实测 PASS；查找/批注/
大纲跳转与 big 模式共用同一套已验证的 c-v 机制。

### 视口档公式密度旁路（v4.18.1，2026-09-28 生产日志驱动）

第三轮优化后生产日志（2026-09-26~28）显示新形态痛点：**35KB~110KB、
行数 1000~2400 的习题集文档**——三路阈值（500KB/3000 行）全不达标、
视口档永不触发，而 KaTeX 行内公式密度极高（实测 E:\笔记\cmc：104,964
字符 / 2,159 行 / **2,356 个行内公式**；35KB 文档 732 个公式照样切标签
1~4.5s 阻塞）。三日异常：MD-9001 持续掉帧 1,700+ 次、MD-1003 秒级阻塞
65 次。DOM 成本由公式数主导（每公式数十节点），字节/行数是错误度量。

修复：`isBigDocCv` 增加密度旁路——`$` 定界符 ≥800（≈400 公式）即入视口
档（`BIG_DOC_MATH_DOLLARS`，阈值取两类样本间隙中段：6KB/170 公式文档
零异常，35KB/551+ 公式文档持续阻塞）。减配档 `isBigDoc` **不**按密度
触发——那会关掉 KaTeX，对公式密集文档不可接受。设置默认值不变（仍关），
启用后这批文档即进入「视口化 + 行内公式懒渲染」路径。

### 评估后不做的项（数据不支持，勿再走）

- **C2（syncListOrder/syncHeadingId 每键全文档遍历）**：打字剖面里 PM
  模型遍历帧合计 <10% 活动时间，每键估计 2-4ms——非付款人，收益撑不起
  patch 维护成本。
- **C3（公式块预览无防抖重渲）**：仅影响公式块内编辑时体验，用户日志
  无此形态卡顿记录。
- **B4（虚拟光标 restartAnimation 写后读回流）**：打字剖面 74ms/11 键
  （c-v 档下更便宜）；重排写读顺序会破坏动画重启语义，WAAPI 改写侵入
  已验证补丁——低收益高风险，挂起。
- **拖选剩余的 ~400ms 离群**：`caretPositionFromPoint` 命中测试是浏览器
  内部成本，应用层无杠杆；c-v 档下已缩到视口规模。

### 第二轮基建增补（`perf/`）

- `select-bench.mjs`：三场景精简基准（~2 分钟/轮，多次运行累积轮次，
  供同窗口 ABAB）。
- `profile-select.mjs`：三场景 CPU 剖面。
- `rect-spy2.mjs` + `spy-selftest.mjs`：rect/offsetWidth 抓现行（坑：
  `getBoundingClientRect` 是**数据属性**要包方法而非 getter；
  `offsetWidth` 在 `HTMLElement.prototype` 不在 `Element.prototype`）。
- `cv-correctness.mjs` / `boot-errors.mjs` / `open-errors.mjs` /
  `a0-verify.mjs`：c-v 正确性快检、静默失败抓取、心跳归因。

## 阶段 1：标签级解析缓存 + 空闲预解析（`src/lib/docCache.ts`）

- **内容寻址**：键 = `长度:FNV-1a32` 指纹（`lib/parseShared.ts`），不经
  路径索引——路径会过期、未命名缓冲没有路径；标签被编辑后指纹自然变化，
  无显式失效协议。查询成本 O(n) 快扫（1MB ≈ 1~3ms）。
- **预算**：只缓存 ≥200KB 的大文档（小文档解析本就瞬时）；总量 ~16MB 源
  文本、至多 6 条、单条 ≤4MB，超限按 LRU 淘汰。
- **schema 失效**：编辑器重建（内存守护 recreate / big-doc 档位翻转）会换
  Schema；条目携带 schema 签名（节点/mark 类型名集合），不匹配即弃用。
  PM 文档 JSON 按类型名解析，同名 schema 的不同实例可互换——缓存因此能
  跨编辑器重建存活。
- **内存守护接入**：`useMemoryGuard` 10s tick 发现堆超阈值时先
  `clearDocCache()` + 停预解析（比重建编辑器廉价一个数量级的回收手段），
  回到阈值下自动恢复。
- **空闲预解析**：切换收尾后的 idle 窗口（requestIdleCallback）预解析
  "下一个最可能的目标"——文件树 hover 预读的大文档优先（复用
  `lib/filePrefetch`），其次相邻标签快照。预算严格 1 个目标，内存压力中
  自动停，新切换开始即取消。

## 阶段 2：后台线程解析（`src/workers/parseWorker.ts` + `src/lib/remarkPipeline.ts` + `src/lib/parsePipeline.ts`）

采用计划中的降级实现：**worker 做 remark 结构化，主线程做轻量映射**——
无需在 worker 复刻 Milkdown/Crepe 的 Schema 组装（该风险点被绕开）。

- **worker 侧**（remarkPipeline）：与编辑器 remarkCtx 处理器同插件集的
  复刻——remark-parse + remark-inline-links + preserve-empty-line（按
  preset-commonmark 源码逐行复刻）+ remark-gfm + remark-math/math 块化
  （按 Crepe latex feature 复刻，仅小文档档位启用）+ 本应用的
  remarkMark/remarkTextColor。产物是纯 JSON 的 mdast 树。
- **一致性哨兵**：`parsePipeline.bindEditor` 读取 Milkdown 的
  remarkPluginsCtx，与 `expectedPluginCount`（小文档 7 / 大文档 5）比对；
  数量对不上（将来有人注册了新 remark 插件）→ worker 自动禁用、回退主线程
  解析，**绝不静默分叉**。`remarkPipeline.test.ts` 锚定各插件的具体行为。
- **传输**：原文 UTF-8 编码为 ArrayBuffer 走 Transferable（零拷贝）；mdast
  树经结构化克隆传回，主线程 `ParserState.next/toDoc`（@milkdown/transformer
  公开 API）映射为 ProseMirror 文档——映射远廉价于 remark 词法分析。
- **并发与失效**：沿用切换 token 语义（过期结果直接丢弃）；worker 失败/
  超时（按体量缩放，上限 10s）终止重建，本次回退主线程路径。
- **顺带受益**：sv 模式下大文档的整篇载入不再等待——源码文本即刻上屏，
  预解析在后台进行；之后 sv ⇄ 富文本切换 / 切回标签命中缓存零解析。

## 阶段 3：富文本视口化（中间态已落地，通用视口化远期）

sv 模式（CodeMirror）天然只渲染可见行。富文本侧 V3.6.5 落地了**零风险
中间态**：big 模式下对 ProseMirror 顶层块启用 `content-visibility: auto`
（`global.css`）——浏览器跳过视口外子树的 layout/paint，DOM 仍在文档中，
跨视口选区、查找、批注 marker、大纲跳转全部保持可用。

完整方案（分区渲染 / 占位节点 + 视口物化）需逐项攻克跨视口选区、查找、
拖拽、批注 marker 可见性等难题，按计划作为独立攻坚项目，不阻塞前两阶段。

## 验证方式

对比切换大文档（1MB+）的"点击到内容可见"耗时与主线程长任务：

1. **缓存命中 vs 未命中**：DevTools Performance 录制标签 A → B → A 切换。
   第二次切回 A 应无 remark 解析长任务（`parserCtx` 路径完全不跑），
   仅剩 `Node.fromJSON` + DOM 构建；可用
   `performance.mark` 或直接观察长任务数量。
2. **首次打开（阶段 2）**：遮罩动画期间主线程应保持响应（动画不卡顿），
   worker 线程（Performance 面板 Workers 轨道）出现解析任务。
3. **内存守护联动**：人为压低 `memoryGuardThresholdMb` 后大文档来回切换，
   超阈值 tick 应清空解析缓存（日志 `heal:cache-clear`）而非直接重建编辑器。

## 相关文件

| 关注点 | 文件 |
| --- | --- |
| 指纹 + worker 协议 | `src/lib/parseShared.ts` |
| 解析缓存（LRU/预算/签名失效） | `src/lib/docCache.ts` |
| worker 侧 remark 管线（一致性契约） | `src/lib/remarkPipeline.ts` |
| worker 入口 | `src/workers/parseWorker.ts` |
| 主线程编排（worker 生命周期/预解析/压力模式） | `src/lib/parsePipeline.ts` |
| 切换动画状态机（token/最短可见时长） | `src/hooks/useSwitchFlow.ts`、`src/lib/switchTiming.ts` |
| setValue 缓存快路径 | `src/hooks/useMilkdown.ts`（loadMarkdownFull） |
| 内存守护接入 | `src/hooks/useMemoryGuard.ts` |

## 第三轮：1MB 档系统性卡顿（2026-09-23 ~ 09-24）

结题报告：`docs/large-doc-perf-report.md`（改动清单 / G1-G7 数据 / 归因 / 风险）。
本节只沉淀**结论与基准口径**，供后续轮次直接引用。

### 合入的改动（10 commits）

| 技法 | commit | 一句话 |
| --- | --- | --- |
| S1 增量序列化 | 1dcc518 | 保存/搜索 O(doc)→O(变更块+拼接)；G4/G5 归零长任务 |
| R1 行内公式懒渲染 | 7c88898 | 打开墙行内侧：视口+800px 才渲染 KaTeX |
| R1b 渲染泵×3 | 876a18d/5624316/bb2ddbd/60e3388 | 滚动静止门控+帧预算+双门控（体量+viewport）+输入源门控——修 G6 滚动回归 |
| R2 重建分片 | 9407f44/7625db8 | cvMemory 停顿重建 300-500ms 单笔 → 8ms idle 切片 |
| R2b 预热让路 | dc733c1 | 滚动窗口内预热不派发批次；滚动 p95 760→82ms |
| I1 sv 脏标记 | 4721404 | 每键全文摊平 O(doc) → 停顿一次取串 |

### 基准口径沉淀

- **fixture**：1MB 档 = `perf/fixtures/一元微分学习题集_1MB压测副本.md`（f4ef4f0 后
  重新生成，行内公式 ≈1.58 万，是旧副本的 7.1 倍——**旧滚动数据不可与今比**）。
- **回归判定**：代码 ABAB 交错（A=f4ef4f0 优化前），中位数，劣化 >10% 且方向一致
  才算回归；A 臂 node_modules 的 plugin-listener 保持 HEAD 补丁态（行为等价）。
- **打字两口径**：g2-typing（新开即打，~300ms/键）≠ baseline（六场景后，~480ms/键）。
  差异 = cvMemory 装饰随预热覆盖增长后的每键 DecorationSet diff（forChild+valid
  占 65%，profile-typing-ctx-*.cpuprofile）。G2 判定用 baseline 口径。
- **懒渲染门控语义**（R1b 最终形态）：仅 cv 档大文档启用；滚动（wheel/touch/键）
  400ms 静止后按 10ms/帧补渲染；降级同样走静止门；选中/编辑恒即时渲染；程序化
  scrollTop 写入（prewarm-comp/ghost）不算滚动。
- **冷启动偶发文件树 0 行**：getWorkspaces 读空被吞，reload 即恢复（非本轮引入）。
  基准轮撞上按「单轮超标不作数」丢弃。
- **scroll-abab 预热等待上限单位错**（bytes/15000≈105ms）：1MB 档只等 45s；重
  fixture 预热超时不阻塞滚动测量（两臂同条件）。

## 第四轮（2026-09-30）：数学密集中型文档默认路径 + 动效基准

结题报告：`docs/large-doc-perf-motion-report.md`（门禁 P/M/V 全表 / P0-B 证伪
链 / 动效专项 / 剖面产物）。本节只沉淀**结论与基准口径**。

### 合入的改动（8 commits）

| 技法 | commit | 一句话 |
| --- | --- | --- |
| v4.19 回退补全 | 2cdb216 | 自动视口档回退 + 漏改的两处设置清单锚点（套件回绿） |
| D4 探针修复 | 0b58c7f | 输入延迟探针 e.timeStamp 打点——排队型按键延迟（被长任务排队）从测不到变可测 |
| D2/D5 基建 | 9021816 | switch-bench（切换/加载动画帧节奏）+ heartbeat-diff（心跳累计字段差分） |
| 启动竞态 ×2 | 20c37d6 / faf5c7f | getWorkspaces 冷启动退避重试 + fs scope 授权 await——文件树 0 行根治（第三轮遗留立项） |
| 测量修复 | acc1d1e | switch-bench 壳就绪后 ignoreCache 重载——WebView 磁盘缓存供旧 chunk 毁臂 |
| D3/C1 | 76e23e8 | ghost-stress 压力脚本 + MD-4011 打开期台阶复检用例 |

### 核心结论（负结果证据链，后续勿重走）

1. **密度档默认路径的秒级阻塞是原生布局墙，JS 侧不可治**：105KB/2,355 公式
   = 15.4 万 DOM。三项默认档降本尝试全部证伪——toDOM 接 katexCache（缓存
   100% 命中切回仍 2.4s：墙是 updateStateInner 挂载 1.8s + 原生布局）、解析
   缓存门槛 200K→50K（命中无效）、分帧挂载（原型可行但实现=视口档本体）。
   打字剖面：JS ~30ms vs 原生 3.6s（p95 1,456-1,984ms）。**唯一实证杠杆
   content-visibility** → 提案 `proposal-bigdoc-viewport-auto.md` 数据 C 待拍板。
2. **MD-1001 ghost 零复发且不可复现**：四阶段压力 anomalies+0；自愈归因 =
   四层补偿链 + headingStamp 预盖章。守卫 = ghost-stress.mjs。
3. **MD-1003 切换阻塞完整量化**：switch-bench 20 往返，切往密度档中位
   2,254ms / >1s LT 10/10 / 动画冻结帧 1,638ms——同墙同源，随提案走。
4. **MD-4011 打开期台阶假阳性**：09-30 形态（单窗 +154,216 后走平）新检测器
   不报（sameDocTail + 尾半窗斜率双保险），真泄漏仍报（+1 测试）。

### 基准口径沉淀（新增）

- **密度档 fixture**：`perf/fixtures/无穷级数_密度档压测副本.md`
  （105KB/2,159 行/2,355 行内公式 = MD-9001 主灾区画像，从
  `E:/笔记/cmc/02_习题集/无穷级数_习题集.md` 复制；gitignore 本地化）。
  切换对档 `解题技巧_密度档切换副本.md`（60KB/778 公式）。
- **切换基准**：`switch-bench.mjs` 两文档往返 N 次，每窗 switchMs + 带时间戳
  rAF 帧分布 + longtask；arm 自证 data-big 签名；壳就绪后必 ignoreCache 重载
  （WebView 缓存陷阱）。
- **打字口径**：g2-typing 支持 `MDITOR_DOC` / `MDITOR_MIN_BLOCKS`（文档选择
  参数）；密度档打 p95 与 1MB 档不可直接比（DOM 画像不同：公式占比主导）。
- **跨时段漂移**：本轮整机较第三轮 ~2×（60e3388 对照臂验证）；打开类绝对值
  达标判定 + 环境声明，禁止跨时段数值直比。
- **dev 实例 store 手改不生效**：运行中 LazyStore 内存镜像遮蔽盘上改动——
  自管脚本（scroll-abab 族）必须 app 关闭时改 store；手动实例经页内
  saveSettings API 改（open-1mb 的 reload 挡不住）。

## 第四轮补遗（2026-10-01）：headingStamp 直建 + 密度档打开归因终局——v4.20.0

- **headingStamp 直建式盖章（01b52ce，高）**：整篇载入前的 heading id 预盖章
  从 Transform.setNodeMarkup 逐步机器（每步 resolve/validContent/cut 全套
  验证）改单趟 Fragment 直建——只重建含变更骨架节点，PM 结构共享原引用
  复用。1MB 档（1,666 标题）打开窗盖章开销剖面 **1,047ms → 14ms（75×）**；
  +8 差分等价单测；墙钟 ABAB 被臂间方差淹没（剖面为准）。
- **密度档打开归因终局（负结果封案）**：stampfix 后打开忙时 ~3.9s =
  原生布局 2,315ms + PM 挂载 JS（updateStateInner）1,364ms + 探针 257ms +
  KaTeX 171ms + micromark 57ms——**2,355 条公式急切渲染与解析双双排除嫌疑，
  JS 侧无可治大头**，唯一杠杆 content-visibility（提案待拍板）。复测
  （10-01，3 轮）3,396-3,644ms 与 09-30 白天基线同水平（09-30 晚 5.0-5.2s
  判环境噪声）；P4 ≤3s 门未达、已归因封案。
- **normalizeMathDelimiters 扫描器化放弃**：427ms 为 1MB 档专属且 P1 门 5s
  余量，证据不成立不动手。

## 第五轮（2026-10-02）：滚动稳定性——乱闪（F）与乱动（J）专项——v5.0.0-beta

结题报告 `docs/large-doc-scroll-stability-report.md`；定罪书 `perf/results/r5-phase4-indictment.md`。

核心结论：
- **症状 J（乱动）**：MD-1001 在 v4.20.0 生产复发 9 次全部发生在视口档；主犯=块高弹跳波（切标签/开档后高度表学习期内容反复位移，恢复梯子落点被 anchor-comp 确定性回拽 -217px，3/3 复现）。修复后回拽残余 +15px（0.2%）。
- **症状 F（乱闪）**：与 J 同源（行内公式「源码占位 ↔ KaTeX 真身」高度二象性 + 三个放大器：首开冷表窗 / 每次载入全量重预热 / 事务路径装饰丢失）。
- 修复四件套（均独立 commit + 单测 + ABAB）：Fix-A 整批替换装饰内容寻址重放；Fix-B 占位高度记忆内容寻址（跨重建存活）；Fix-C 预热只学冷块（切回已知文档瞬时完成，**切换中位 2,254ms → 874-949ms**）；Fix-D 视口学习 webfont 门控。
- 观测补点：写入陷阱（未打标 scrollTop 写入的调用栈捕获，ghost 事件附带）+ J2 恢复梯子插队计数 + smoothJump 生命周期计数 + cv.relearn 高度表改写观测。
- 基准口径新增：`perf/scroll-flash-bench.mjs`（upscroll/roundtrip/longread × 双 fixture × on/off，臂自证）；F1=占位残留事件数/p95/峰值并发，F4=滚动帧 p95/over50，开档窗=blockChangeEvents。
- 新发现：1MB 档「开档即滚」窗口预热争用（on 臂帧 p50 154ms vs off 6ms）；katex-error 双臂对照法判文档内容 vs 管线回归。
- perf 基建安全：ghost-stress/scroll-abab 硬清理从按映像名 taskkill 改按端口 PID 树（曾误杀用户打包版实例）。

## 第六轮（2026-10-02）：公式渲染及时性（T）与完整性（M）专项

结题报告 `docs/large-doc-formula-render-report.md`；基线+定罪书 `perf/results/r6-phase3-4-baseline-indictment.md`。

核心结论：
- **症状 M（漏渲染）根治**：M-d' demote 回带竞态——快速长滚中 demote 顺延链挂起、元素回带时 visible=true 回调不撤销 timer 且 rendered=true 挡住入队、停稳后 timer 到期把带内/视口内元素降回占位、IO 因状态无变化永不再回调 → 永久源码占位。微滚 ±900px 验证归零定罪。Fix-A（回带撤 timer + demote 带内跳过）后超限/密度档残留清零；Fix-C（demote 后 IO unobserve+observe 校准）兜底 1MB 档残余（IO 状态失同步姊妹形态）。遍历往返 M1 三档全 0。
- **症状 T（不及时）可修部分定罪**：T-c 上滚方向带全禁（R4-① 无锚定补偿约束）把安全的命中直绘也禁了——有渲染态高度预留（占位 minHeight 已撑行高）且缓存命中的条目直绘零高度变化。Fix-B 放开后上滚瞬间积压尖峰 21→11 条（-48%）、p50 457→340ms（-26%）；p95 5,615→4,896ms（-13%）——剩余长尾由帧间隔 p95 3.5-4.4s 支配（布局墙第四轮封案 + 学习窗 + bench REC 采样器 30-50ms/帧测量放大），泵侧已无积压（__mathPumpStats 轨迹 q 恒 0/cold=0/静止 1-3 帧清空）。
- 观测出口：`window.__mathPumpStats()`（队列深度/最老条目等待/命中直绘与冷算/回插/丢弃/失败计数）——「公式不渲染/补绘拖尾」DevTools 直读；main.tsx 挂载（__scrollDebug 同款惯例）。
- 基准口径增补：scroll-flash-bench f1 拆 scrollPhase/quietPhase（wheel ≤450ms 分窗）+ row.t2（滚动中视口未 ready 峰值/源码态时长占比）；>8,192 唯一公式超限 fixture（9,420 唯一）钉死 katexCache LRU 截断档（1MB 副本唯一公式仅 2,368，预热全覆盖不触发截断）。
- 排除项（勿重查）：M-a 截断不致漏渲染（残留位置均匀非尾部）；M-b 队列零饥饿（oldestWaitPeakMs=0）；M-c 零 render 失败；M-e 块级挂载率 100%（23/23）；1MB 档 T1 剩余长尾=帧饥饿非泵缺陷。
- 教训：perf 清理必须按 PID 树杀——`taskkill /IM msedgewebview2.exe`（按映像名）在打包版存活时会误杀其 webview（本轮重犯第五轮教训，见报告 §5 事故披露）。

## 第七轮（2026-10-03）：停滚自漂移（D）专项

结题报告 `docs/large-doc-scroll-drift-report.md`；归因定罪书 `perf/results/r7-phase4-attribution.md`。

核心结论：
- **症状 D（停滚自漂移）双源定罪**：①D-e demote 潮宽度折行——占位源码文本宽 ≠
  KaTeX 渲染宽，demote 批量降级时段落重折行推移视口（minHeight 只锁垂直锁不住
  水平），停滚后 ~2.5s 阶梯位移即生产「一格一格自己动」（密度档 down-slow 21
  位移帧/4 补偿；禁 demote 对照 0/1708）；②D-b 预热分段陈旧——三段分界按启动
  时视口一次性计算，1MB 预热 >45s 期间深滚后「带下」批实际全在视口上方、变现
  无补偿（prewarm.comp 零增长），anchor-comp 逐格兜底（12 格 +424~+1301px；
  等预热完成对照 0/367）。D-c 打字机（用户环境 typewriterMode=false）与 D-d
  裸源排除（11+ 轮 MD1001=0、writeTrap 无未打标写入）。
- **Fix-A demote 锁盒占位**：{w,h} 双记忆（元素 WeakMap + 会话表 8192 LRU）+
  inline-block 锁宽高 + overflow:hidden + vertical-align:bottom +
  max-width:none——占位复刻渲染态行内布局（原型 32/32 段落块高零差；无 bottom
  校正 +2px/条）。源码文本保留 DOM（查找/选区/复制语义不变），锁盒态仅存在于
  IO 带外 800px+。密度档四场景（下滚/上滚×快/慢）位移帧/程序化写入/补偿全零。
- **Fix-B 预热哨兵差值同帧补偿**：视口顶块 docTop 前后差值取代静态 upPhase 分
  段（覆盖断批/混合批一切位移源）+ dispatch 后同任务强制布局量测、补偿与变现
  同帧提交（浏览器只 paint 最终态）+ 哨兵同块复测 + prewarm-end 清场补偿。
  prewarmAnchorComp 纯函数：死区 1px/瞬移防护 3000px（pickSentinel 同量级）/
  限幅 ±8000。1MB 位移帧 72→3~9（-87~96%）；预热完成后 10s 窗全零。
- **补偿时序新参数**（R7 引入）：`prewarmAnchorComp(anchor0, anchor1, max)`
  纯函数（cvMemory.ts）——亚像素死区 1px（10px 死区负结果：中小批真实位移
  10-40px 被放过反而劣化 15 帧）；哨兵瞬移防护 3000px（半屏级阈值会拒补真实
  大批位移 +580px，负结果留档）；量测断批预算 8ms 只影响 learned 学习、不再
  影响补偿完整性（哨兵差值天然覆盖）。
- 探针口径沉淀：r7 停滚漂移探针（rAF 三哨兵 + 250ms 公式 ready/unready 轨迹
  + counters/pump 差分）；**探针 rAF 注册序陷阱**——采样循环先注册先跑，会在
  补偿前采样到位移，补偿必须同步（dispatch 后同任务）才能对探针与用户同时
  零可见。
- M3 口径勘误：块级公式挂载率探查须用「解题技巧_密度档」（23 个 ```latex 块）
  ——「无穷级数_密度档」为纯行内公式文档（```latex 块 0 个）。
- 遗留（R8 候选）：1MB 预热推进期残余 3~9 位移帧（8px 级浏览器 scroll/layout
  亚帧差，每 run 预热进度不同导致波动）；P3（预热批学渲染态盒尺寸）待拍板。

## R8：上滚掉帧/丝滑度不对称（第八轮，2026-10-03）

结题报告 `docs/large-doc-upscroll-jank-report.md`、归因定罪书 `perf/results/r8-phase4-attribution.md`。

- **症状 U 判别口径**：掉帧（rAF 帧间隔 >32ms，scrollPhase 窗=滚轮驱动期+静止
  门 400ms 生效前）vs 内容跳位（三哨兵残差 |Δrect.top+ΔscrollTop|>4px）必须
  分采分判——R8 全部 run 残差为 0，症状 U 全部为真掉帧。
- **位置效应主导（本轮核心发现）**：滚动帧稳定性的第一变量是**文档位置**
  （预热覆盖区 vs 冷区），不是滚动方向。1MB 头部（预热补绘完成区）滚动
  p95 104~119ms，冷区（未渲染公式密集区）无论上下滚 p95 199~353ms、掉帧
  帧占比 ~80%；同位置上下对照完全对称（1MB 1.02、密度档 1.05）。**测量
  陷阱**：以「头部下滚」为对照臂测「中部上滚」会得出伪不对称（比 1.67~5.5），
  对照臂必须同位置（`--start-depth` 深位下滚）。
- **冷区首渲布局墙机制**：视口内条目 5ms 预算（SCROLL_RENDER_BUDGET_MS）首渲
  ——预算时钟只测 KaTeX render 的同步 JS（1-2ms/条），**布局成本不计入**；
  首渲改行框/块高 → 全树强制 layout ~67ms/帧（1MB 实测 getMetrics
  LayoutDuration 差分）。冷区滚动队列膨胀至 3,000+（直绘受 SCROLL_HIT_PAINT_CAP
  限流+冷条目留队），布局循环持续整个滚动期。密度档全树 layout 便宜 ~8 倍，
  绝对量健康（p95 ≤13ms）。
- **demote 回带成本**：回带重挂（取消挂起 demote+重新入队+nodeview 重挂）占
  冷区滚动掉帧强度 ~1/3（禁 demote 对照 p95 -34%）；R7 Fix-A 锁盒使回带直绘
  零位移，但重挂 DOM 重建本身不可省（DEMOTE_DELAY 红线锁死）。
- **观测出口**：`window.__mathPumpStats().queueDepth`（队列深度——冷区滚动
  积压的直接信号，健康值 0~数百、劣化 >1500）；`window.__scrollDebug()`
  counters 的 `prewarm.chunk/prewarm.comp/anchor.comp`（预热尾巴与补偿轨迹）。
- **P3 拍板材料**（待用户确认后立项）：预热批从 katexCache 渲染态测高 →
  hasReservedBox 全覆盖 → 冷区条目滚动中安全直绘（R6 Fix-B 条件全通）→
  队列清空+首渲零位移，预期 1MB 冷区 p95 199→~130（布局墙底 104~119）、
  密度档 11→~7，同步改善停滚补绘墙。原型：R7 锁盒 32/32 零差。
- 探针口径沉淀：probe-jank（r8）——驱动期逐帧 rAF 间隔+Longtask Observer+
  三哨兵残差+250ms 四路快照+marks 分窗；**快滚 5000px 窗内仅 16~30 帧，
  对称比判定以慢滚大样本为准**；PerformanceObserver longtask 在「布局/渲染
  管线掉帧」形态下恒 0（无 >50ms JS 任务），不能作为帧稳定性的充分判据。

## R9：专注模式滚动掉帧/丝滑度不对称（第九轮，2026-10-04）

结题报告 `docs/large-doc-focus-mode-scroll-smoothness-report.md`、归因定罪书 `perf/results/r9-phase4-attribution.md`。

- **症状 F 只在打包版复现（本轮最大方法论事件）**：dev 环境 8 run 全部
  复现失败（focus 不劣于 normal，p95 比 0.51~1.05 方向不一致）。环境归因：
  dev 构建预热 1 块/26ms 爬行死锁（prewarm meta 走全量 buildDecos，9639 块
  需 ~36min；release 瞬时完成）、密度档布局便宜（p95 6~9ms）、dev 无
  Present 停摆形态。**打包版 + 用户症状文档「题型方法决策树」（224KB cv
  档）+ release 预热完成态 = 复现三要素**：focus 臂 j32=8~12 / normal 恒 0
  （ABAB ×多 run）。
- **任务书五候选（F-a 高度表宽度陈旧 / F-b 宽度面积 / F-c 诊断走查税 /
  F-d hover-zone / F-f 打字机）全部实验排除**——几何三要素控制臂
  （width/vh/wh 对齐，normal 模式窗口拉至 focus 几何 1256×884 仍 0 掉帧）、
  .main 样式恢复、app padding 恢复、hover-zone 隐藏、layout 事件对齐率
  （normal 事件更多却零掉帧）逐项定罪排除。F-a 机制代码事实成立（宽度
  突变 985→1249 坐实、cv.relearn=0 无重学路径）但未转化为本症状——留档
  潜在风险。
- **真凶 F-g（清单外新源）：ai-fab 呼吸动画的合成器保温效应丢失**。
  机制：normal 模式 `.ai-fab:not(.active)::after` 的 fab-pulse 无限合成器
  动画逐 vsync 驱动产帧（trace：12s 内 2008 次 Present ≈ 每 vsync），
  DXGISwapChain 常热；专注模式 `display:none` 掉 fab 连带消灭动画 →
  滚轮间隙（450ms）零产帧 → swapchain/DWM 冷却 → 下一滚动帧
  `DXGISwapChainImageBacking::Present` 阻塞 40~124ms（gpu trace：每个
  掉帧 gap 与一次 Present 停摆严格同长；同期主线程空闲、光栅 max 5.2ms）。
  单元素二分矩阵定罪：仅藏 fab 复现（j32=7）、仅藏 resizer/titlebar/
  status/tabbar/sidebar 塌缩全 0；fab 可见+动画停也复现（8/8）→ 保护
  因子是动画；fab opacity:0+动画续跑无效 → 需有效可见帧输出。
- **Fix-A（零视觉修复）**：`.is-focus .main` 挂 `focus-keepwarm 2.4s
  linear infinite`（keyframes 只动 translateZ 0↔0.001px——无 2D 位移，
  层纹理复用零光栅）保温呈现管线；`.app-idle`（窗口隐藏）暂停与
  fab-pulse 同纪律；动效「无」档 B12 kill switch 连带停用（两模式对称
  承受，用户显式偏好不豁免）。原型矩阵：main-jitter 与 fab-ghost（5%
  幽灵）双治愈（j32→0），取零视觉版。守卫测试 focusKeepwarm.test.ts ×4。
- **测量口径沉淀**：①「模式对称」实验必须**同位置同序列**且防**重复滚
  同区间加热曲线**（1MB 冷区同区间 6 滚 8fps→82fps）——每臂独立相邻
  区间 + 双 run 臂序互换；②文档位置效应在本轮再现（晚段 run 末臂文末区
  恒 0 掉帧）——对照臂必须同区间序；③CDP 大对象导出会挂死（无超时），
  收尾 eval 全带超时 + 页内分析优先；④CDP 坐标点击对打包版 .ft-row 无效
  （dpr 1.75），DOM el.click() 直触 React onClick 是可靠替代。
