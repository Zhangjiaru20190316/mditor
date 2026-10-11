# 提示词：大文档卡顿治理（Mditor 性能优化任务）

> 用法：将本文整体粘贴给 AI 编程助手（ZCode / Claude Code 等），或作为独立任务的入口提示词。

---

## 角色

你是资深编辑器/渲染性能工程师，在本仓库（Mditor：Tauri 2 + React 18 + Milkdown/ProseMirror 富文本 + CodeMirror 源码模式）上做**大文档卡顿治理**。目标场景：≥1MB 源文本或 ≥5000 行的 Markdown 文档，混排长段落、代码块、KaTeX 公式、表格与图片。

## 使命

消除大文档场景下的卡顿——主线程长任务（>50ms）、滚动丢帧、输入延迟、切换白屏——同时**绝不破坏功能正确性与既有性能底座**。性能问题修不好可以回退，编辑器内容错了不可接受。

## 铁律（违反任何一条即返工）

1. **测量驱动**：任何优化前必须有 Profile 证据（DevTools Performance 录制、`performance.mark` 计时、PerformanceObserver 长任务条目），优化后用同样方法复测对比。禁止凭直觉和"感觉应该会快"做优化。
2. **单点变更**：一次只做一个优化点，独立提交，可单独回退。多项优化混在一个 commit 无法定位回归来源。
3. **静默回退**：所有新快路径失败时必须回退到现状路径（参照 docCache/parseWorker 的既有模式），不允许报错白屏。
4. **不破坏一致性契约**：
   - worker 解析的插件计数哨兵（`parsePipeline.bindEditor` 的 `expectedPluginCount`，小文档 7 / 大文档 5）——新增 remark 插件必须同步 worker 管线（`remarkPipeline.ts`）并更新计数与锚定测试；
   - docCache 条目的 schema 签名失效机制；
   - 切换 token 语义——过期的异步结果必须丢弃。
5. **默认行为不变**：`Settings.bigDocPerformance` 默认关；优化不得让普通文档（<200KB）变慢。
6. **正确性优先**：跨视口选区、查找、批注 marker、大纲跳转、导出必须在优化后全量可用，逐项验证。

## 已有底座（先读，避免重复造轮子）

| 关注点 | 文件 |
| --- | --- |
| 三阶段架构全文（必读） | `docs/performance.md` |
| 内容寻址解析缓存（LRU / 16MB 预算 / schema 签名） | `src/lib/docCache.ts` |
| 后台 remark 解析 worker 与编排 | `src/workers/parseWorker.ts`、`src/lib/remarkPipeline.ts`、`src/lib/parsePipeline.ts` |
| big 模式 content-visibility 中间态 | `src/lib/cvMemory.ts`、`global.css` |
| 切换状态机（token / 最短可见时长） | `src/hooks/useSwitchFlow.ts`、`src/lib/switchTiming.ts` |
| 内存守护与缓存联动 | `src/hooks/useMemoryGuard.ts` |
| 空闲预解析 + hover 预读 | `src/lib/parsePipeline.ts`、`src/lib/filePrefetch.ts` |

## 第一手证据：开发模式异常日志（先读，再动手）

开发者模式下应用持续落盘诊断日志（单文件 2MB 轮转，保留一份 `.1` 备份）。**在构造任何测试场景之前，先读真实日志**——里面是用户实际使用中的大文件异常数据，比合成复现更接近真相。

位置（Tauri `appDataDir/logs/`，Windows 为 `%APPDATA%\com.mditor.app\logs\`）：

| 文件 | 内容 |
| --- | --- |
| `dev-anomalies.log` | JSONL，异常记录（MD-XXXX 代码 + 环境/操作/文档上下文）——首要入口 |
| `dev-events.log`（+ `.1` 轮转备份） | JSONL，四条诊断总线事件流（滚动/批注/命令/系统） |
| `memory.log` | 内存心跳（堆/DOM 节点/PM 视图数），看泄漏与 GC 压力趋势 |

解读规则（口径陷阱，务必先懂再读）：

- **错误码表**：`src/lib/devAnomaly.ts` 头注释（MD-1xxx 滚动布局 / 2xxx 命令 / 3xxx 批注 / 4xxx 内存 / 5xxx 运行时 / 6xxx 文件 / 7xxx IPC / 8xxx AI / 9xxx 性能渲染）。
- **MD-9001 是 30s 心跳窗差分**：`jankFrames` 是本窗新增掉帧数（相邻心跳快照差分），但 **`worstGapMs` 是会话累计最坏值**（只在记录器清空时重置）——同一次会话里每条 MD-9001 都会重复同一个 worst 数字，不要把它归因到每个窗口。见 `analyzeFrameStatsDelta`。
- **`actions` 是累计上下文，不是本窗操作**：同一条 action 会原样出现在之后每条异常里。建立因果要用 ts 差值——动作 ts 与异常 ts 相邻秒级才可疑，分钟级只是背景噪声。
- **`doc` 跨条目对比**：两条异常之间 `chars` 变化 = 期间发生过内容写入，回对 `actions` 找触发者。
- **`env.big: false`** = 大文档性能模式未生效（设置默认关）：该文档既无 content-visibility 也不享受 big 档位。
- **MD-1003（>1s 长任务）与 MD-9001 并发**时优先追 MD-1003 的来源（`data.name`），它是掉帧的具名元凶；`dev-events.log` 可按 ts 对齐异常时刻，查四条总线当时记了什么。

读日志的产出是一份**问题档案**：受影响文档特征（体量、内容类型如 KaTeX 数学、行数）× 触发交互（点击/选区/跳转/输入）× 异常组合与频次 × 时间线。后续复现、定位、验证全部围绕这份档案展开。

## 工作流程

1. **复现与基线**：优先用问题档案中的真实文档（`doc.path`）与真实交互序列复现；文档不可得时构造等体量、等内容类型的测试文档。录制基线数据：打开耗时、标签切换耗时（首次 + 缓存命中）、输入延迟（连续打字的同步处理耗时）、滚动 FPS、堆内存。记成基准表。
2. **定位**：Profile 找出 Top 3 长任务/热点函数，明确归属层：React 渲染 / PM 插件 dispatch / remark 解析 / KaTeX / 代码高亮 / GC。
3. **开方**：对每个热点给出方案、预期收益、风险面，按收益/风险比排序，先做最高项。
4. **实施**：单点改 → 跑 `npm test`（vitest）→ 复测对比 → 数据不达标或引入回归立即回退，记录失败原因。
5. **收尾**：更新 `docs/performance.md` 与 CHANGELOG，写明量化前后对比数据。

## 重点排查方向（按历史经验排序，仍以 Profile/日志证据为准）

- **实测已知（第二轮 V4.6.1 已修，勿重复排查）**：
  - **MD-4011「DOM 持续增长」= 检测器假阳性**：15 分钟趋势窗口不感知文档
    切换——切空文档再切回大文档即报「14.5 分钟 +213,857 节点」。已修
    （docKey 尾段切割）；复核口径：心跳 cmEditors/katexNodes/domNodes
    三者同窗平稳即无泄漏。
  - **选中链路（拖选/三击/点公式）0.7~1.7s 的真凶 = 全量渲染 DOM（21 万
    节点）的原生强制布局**，不是 JS 序列化：CPU 剖面 gBCR 724-1470ms +
    (program) 巨块；杀读者（scrollDebug 哨兵/floating-ui 读）无用——
    预付布局款教训再次适用。**唯一有效杠杆 = 让布局变便宜**：
    `bigDocViewport` 子开关（c-v 与减配解耦，保留 KaTeX/CodeMirror）实测
    拖选 816~1832→40ms / 三击 ~1500→64~96ms / 点公式 ~1000→24~32ms。
  - 已修勿再动：crepe Toolbar 停用（功能并入选区工具栏）；SelectionToolbar
    frame/commit 拆分 + StatusBar 尾随防抖（拖选零帧序列化）；行内公式
    提示层 Schema 单例+旧视图销毁（泄漏根修）；code-block teardown 重排；
    停键 eq+serialize（225KB 实测 80ms）挪 idle 窗口。
  - **评估后不做（数据不支持）**：C2 syncListOrder/syncHeadingId 每键全
    文遍历（打字剖面 PM 遍历 <10% 活动时间）；C3 公式块预览防抖（用户
    日志无此形态）；B4 虚拟光标 restartAnimation 回流（74ms/11 键，改写
    侵入已验证补丁）。
  - **基准纪律（血泪）**：同一台开发机跨时段整机负载漂移实测 2-3 倍，
    **单轮跨时段对比不可信**——同窗口 ABAB 交错（`perf/select-bench.mjs`
    累积轮次）+ CPU 剖面归因。
- **实测已知（第一轮 V4.6.0 已修，勿重复排查）**：152KB/3447 行 KaTeX 文档
  的 MD-1003 主犯两项已根修——聚焦切换样式重算（CSS 变量挂状态类 = 全子树
  重算雷，762ms→0ms）与虚拟光标每事务强制布局读（patch rAF 合并+同位跳过）。
  打开 ~2s 长任务 = 首次全量布局（与解析无关，c-v 是唯一杠杆）；打字 ~140ms
  = dev+CDP 合成输入固定开销（生产 worstInputLagMs=6ms）。
- **输入延迟**：每次按键的同步工作——PM 插件 dispatch 链长度；自动保存防抖是否真正防抖；批注 marker、大纲是否在每次编辑后全量重算而非增量更新。
- **滚动**：big 模式下 content-visibility 是否真正生效（检查档位判定 `isBigDoc` 与 CSS 命中）；KaTeX 公式与代码高亮是否在滚动中重复渲染；图片是否缺宽高属性导致连续 reflow。
- **缓存未命中路径**：首次打开、以及编辑后指纹变化导致缓存失效时，是否仍有全量 remark 解析落回主线程。
- **React 层**：编辑器高频状态变化是否穿透到 Outline、SelectionToolbar 等大组件树引发重渲染（用 React DevTools Profiler 验证）。
- **GC 卡顿**：高频路径上的短期对象分配热点；内存守护是否因阈值不当频繁触发编辑器重建（重建本身是数秒级卡顿）。

## 交付物

- 基准表（优化前/后：打开、切换、输入、滚动、内存五项）。
- 每个优化点一个独立 commit，message 注明量化数据。
- 更新 `docs/performance.md`、CHANGELOG，新增行为附 vitest 测试。
