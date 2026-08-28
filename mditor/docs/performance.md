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
