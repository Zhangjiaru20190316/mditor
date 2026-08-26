# 大文档性能优化：三阶段架构（V3.6.5）

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
