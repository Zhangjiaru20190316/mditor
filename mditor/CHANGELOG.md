# Changelog

## 4.4.0 (2026-08-25)

多根工作区（VS Code 式 Multi-root Workspace）：一个窗口同时挂多个文件夹，文件树分区显示，跨全部根搜索。废除旧「打开工作区外文件自动切换工作区」的劫持行为。

### 新增

- **多根工作区**（`lib/workspaces.ts` 新模块 + `store.ts`）：
  - store 键 `workspaces: string[]` 取代单值 `workspace`；首次启动自动迁移（旧值 → `[旧值]`，幂等），迁移后删除旧键
  - 文件树（`FileTree.tsx`）每个根一个可折叠分区（VS Code Explorer 式）：区头 = chevron + 文件夹图标 + 根名（悬停见完整路径）+ hover 显现的「×」移除按钮；折叠只藏行不丢状态（childrenMap/expanded 全保留，再展开零 IO）；单根时区头照常显示，行为一致
  - 懒加载树状态（childrenMap/expanded/loadingDirs）本就按绝对路径键控——跨根天然唯一，添加/移除某个根不影响其他根的展开状态（prune 规则改为「仍在任一根下即保留」）
  - 工具栏「新建文件/文件夹」目标根 = 活动文件所属根，否则第一个根（title 动态显示目标名）；「全选」「刷新」覆盖所有根
- **「添加文件夹到工作区…」菜单**（文件菜单，置于「打开文件夹…」之后；macOS 原生菜单同步）；侧栏树头部新增「＋」按钮同款入口；重复添加（大小写漂移同路径）提示「该文件夹已在工作区中」
- **最近工作区**（上限 8）：未打开文件夹的空态列出最近工作区，一键重开；添加/替换工作区时自动记录
- **跨根搜索**（`workspaceSearch.ts`）：`searchWorkspaces(roots, …)` 逐根收集、maxFiles 预算全局共享（根间公平），命中合并展示；搜索范围（根列表/排除项）变化后自动重扫（旧版切工作区后同 query 不重扫的隐患一并修复）
- 11 例新单测（`workspaces.test.ts`）：大小写折叠比较、分隔符边界（`C:\a` ≠ `C:\ab`）、去重保序、嵌套根判定、store 迁移归一

### 变更（行为变化，请注意）

- **打开工作区外的文件不再自动切换工作区**（旧版会把工作区静默替换为该文件所在目录，文件树展开状态全丢）。现在外部文件只进标签与最近列表；想挂进文件树用「文件 → 添加文件夹到工作区…」
- 「打开文件夹…」（Ctrl+Shift+O）与侧栏「⤢」按钮语义改为**替换整个工作区**：当前有 ≥2 个根时先弹确认（磁盘不受影响）
- 从工作区移除一个根（区头 ×）：不弹确认——磁盘文件不动，重新添加即可（VS Code 同款语义）

### 兼容

- 旧版单工作区用户：启动自动迁移为单根列表，树/搜索/设置行为不变；「从工作区移除」（excludedPaths）仍为全局设置，跨根生效
- 设置弹窗中已移除项目的相对路径显示以第一个根为基准（多根下其他根的排除项显示绝对路径）

### 验证

- `npm test` 327 例全绿（新增 11）；`npm run lint` / `npm run build`（tsc + vite）全绿
- 待手验清单（GUI）：
  1. 添加 2~3 个文件夹 → 树分区显示，各分区独立展开/折叠，重启后多根恢复
  2. 区头 hover →「×」移除该根（其他根展开状态不受影响），磁盘文件完好
  3. Ctrl+Shift+F 搜索 → 跨全部根命中；添加新根后同关键词自动重扫
  4. 打开工作区外的 .md（最近列表/拖入）→ 标签正常打开，文件树不动
  5. 未打开文件夹空态 → 「最近工作区」列表出现，点击重开
  6. 菜单「文件 → 添加文件夹到工作区…」→ 添加成功且重复添加有提示

### 版本

- 4.3.0 → 4.4.0（package.json / tauri.conf.json / Cargo.toml / Cargo.lock）

## 4.3.0 (2026-08-24)

开发者模式全面升级：诊断数据广度覆盖（第四条「系统链路」总线 + 异常附环境/操作/文档上下文）、错误码体系细分扩容（MD-2xxx/3xxx/4xxx/5xxx 内部细分 + 新增大类 MD-6xxx 文件 / MD-7xxx IPC / MD-8xxx AI / MD-9xxx 性能）、滚动归因补上「视口尺寸变化」缺口（开合侧栏、最大化/还原、改排版/字号引发的滚动不再误判 ghost，灵敏度不降）。

### 一、滚动归因：视口尺寸变化成为一等信号

- **viewport:resize 事件**（`scrollDebug.ts`）：滚动容器挂 ResizeObserver，记录视口宽高变化（含「窗口级/容器级」来源判定——同帧 window 尺寸也变 = 窗口级）；事件发射 300ms 节流（拖拽侧栏时 RO 每帧触发），原始次数由计数器承载
- **归因状态机新增 resize 类别**：优先级 **用户输入 > 已知程序写入 > resize > 钳制 > ghost**。尺寸变化因果窗（500ms，CSS 过渡期间随 RO 逐帧顺延）内的滚动记 `session:resize`（info，保留研究价值）——不计 ghost、不弹告警
- **同窗 layout:shift / layout:height 降级**：视口尺寸变化引发的内容位移/高度突变降为 info 并带 `cause=resize` 标记；分析器对 MD-1002/1004 增加 `cause !== "resize"` 纵深防御（emit 侧规则漂移也不误弹）——最大化还原大文档（高度突变数千 px 且无点击，旧版必弹 MD-1004）由此根治
- **灵敏度红线（单测自证）**：resize 过期（>500ms）、无 resize 信号的不明滚动仍判 ghost；优先级测试（用户/写入压过 resize）与「最大化还原连续帧序列全程无 ghost」测试在 `scrollDebug.test.ts`
- ghost 事件数据附带 `resize` 字段（最近一次视口尺寸变化的距离），定罪上下文更完整

### 二、诊断数据广度覆盖

- **新总线 sysDebug（系统链路）**：文件 IO / IPC(Tauri) / AI / 生命周期 / 资源加载，形状与既有三总线一致（环形缓冲 300 + 计数器 + 订阅），DevTools 出口 `window.__sysDebug`
- **异常附上下文（`devContext.ts` 新模块）**：每条异常落盘时附 `ctx` = 环境快照（版本/平台/窗口尺寸/DPI/主题/编辑模式/data-big/最大化/侧栏状态）+ 最近 16 次操作（点击目标描述符、快捷键组合、打字合并标记、模式/标签切换语义埋点）+ 文档概况（标签数/活动标签/字符数/行数/图片数）——不看代码也能定位「哪条链路、什么环境、用户刚做了什么」
- **插桩点**：`tauriFs`（读/写/对话框/列目录/建目录）与 `fileOps`（删除/重命名/新建）经 `tracedIo`（新 `ipcTrace.ts`）包一层——成功只进计数器（次数+累计毫秒），失败发事件原样重抛不改语义，>2s 发慢事件（对话框不设慢阈值：时长=用户思考时间）；`dialogs`/`clipboard` 同款；自动保存失败与文件监听失败（原先静默吞掉/静默降级）留痕；docCache 命中/未命中/写入计数；AI 链路（`ai.ts`）请求失败/流式错误/异常结束（未收到 done）/响应形态异常/用户中止全覆盖
- **资源加载失败**（图片/webfont/脚本）：window 捕获版 error 监听常驻（MD-5012）
- **性能与渲染**（`scrollDebug` tick 顺带累计，每帧常数成本）：帧数/ >50ms 卡顿帧 / 最坏帧间隔 / 按键→下一帧延迟；心跳差分超阈值 → MD-9001 持续掉帧 / MD-9003 输入响应卡顿；warn 级视口位移 2s 内 ≥3 次 → MD-9002 布局抖动风暴
- **生命周期**：`lifecycle:editor-ready`（创建耗时+启动以来毫秒+big+序号）/ `lifecycle:mode-switch`；启动环境快照随 dev-mode enabled 会话行落盘
- **心跳扩容**：环境快照 + 文档概况 + 帧统计 + 四总线计数器 + 记录器自监控（两日志 written/dropped/queued/flushes/failures + mergedAlerts + uptime）——一条心跳即一份「当时的世界」

### 三、错误码细分（旧码语义不变、不回收、不重排）

- **MD-2xxx 编辑命令**按类别细分：2001 未分类（兜底语义不变）· 2011 块结构 · 2012 行内格式 · 2013 文档写入 · 2014 应用/窗口
- **MD-3xxx 批注**按链路阶段细分：3001 未分类 · 3011 盖章/徽章渲染 · 3012 批注写入 · 3013 批注流式 · 3014 批注体检
- **MD-4xxx 内存**：新增 4011 DOM 节点持续增长（≥30k 节点且 ≥1500/分钟，保守阈值防编辑误报）；cm-editor/KaTeX 计数随文档内容波动，只进心跳上下文不设码；监听器泄漏无通用测度不设码
- **MD-5xxx 运行时**按来源细分：5011 渲染层异常（ErrorBoundary，原归 5001）· 5012 资源加载失败
- **MD-1xxx**：新增 1011 PM 顶层块批量替换（pm:rebuild warn）；pm:root-swap 由既有 4003 承载不重复设码
- **新大类**：MD-6xxx 文件与持久化（6001 读 / 6002 写 / 6003 结构操作 / 6004 监听）· MD-7xxx Tauri/IPC（7001 调用失败 / 7002 异常缓慢 / 7003 对话框 / 7004 剪贴板）· MD-8xxx AI（8001 请求 / 8002 流式中断 / 8003 异常结束 / 8004 响应异常）· MD-9xxx 性能渲染（9001 持续掉帧 / 9002 抖动风暴 / 9003 输入延迟）
- **级别策略**：error（告警卡+原生弹窗）仅 5001/5002/5003/5011，其余全部 warn（仅告警卡）；新码全部走既有同码 60s 冷却合并（AnomalyTracker 按码键控），细分不引发告警轰炸
- 完整码表同步更新于 `devAnomaly.ts` 头注与 `docs/dev-anomaly-codes.md`（用户可见文档）

### 消费侧一致

- DevAlerts 告警卡 / 诊断面板（异常记录、四总线计数器与事件流合并、复制报告含环境与系统链路） / dev-anomalies.log（异常附 ctx）+ dev-events.log（四总线事件流）三处口径一致
- 复制报告（告警卡与诊断面板）均含环境行；`window.__devMode.report()` 增加 IO/IPC 计数汇总

### 验证

- `npm test` 316 例全绿（新增 39：resize 归因 8——含灵敏度红线 3 例与最大化还原帧序列 · 错误码细分与抑制 20 · tracedIo 5 · sysDebug 总线 3 · devContext 3）
- `npm run lint` / `npm run build`（tsc + vite）全绿
- 规格要求的新归因规则全部可脱离浏览器复现（构造帧序列单测）；待手验场景（开发者模式开启）：开合侧栏 / 最大化还原 / 改排版与字号——不再出现 MD-1001/1002/1004 滚动类告警且诊断面板可见 session:resize 与 viewport:resize 记录；dev-anomalies.log 中任一条异常记录带 ctx（环境+最近操作+文档概况）

### 版本

- 4.2.2 → 4.3.0（package.json / tauri.conf.json / Cargo.toml / Cargo.lock）

## 4.2.2 (2026-08-23)

大文档「打开后页面自己跳 60~90 秒」根修。开发者模式定罪（26,000 行文档、渲染后约 397,000px）：big 档位重建（pm:root-swap ×5）后全量 3em 占位（文档高度一次 +374,961px），cvPrewarm 自顶向下固定 100 块/批推进——每批强制布局 = 300~1200ms longtask（MD-1003 ×2），视口上方块成批变现持续推移视口（layout:shift ×18 / anchor.comp ×18），写入归因窗跨 longtask 过期把补偿尾段误判 ghost（MD-1001 ×2，↓3132px 实锤）。

### 修复

- **预热顺序改「视口优先、先下后上」**（`lib/cvMemory.ts`）：① 当前视口块起 +2 屏带先量（恢复落点/阅读区冷启动即可信）；② 带末向下推进到文末——视口下方块变现不推移视口内容；③ 视口上方由近到远收尾，每批 dispatch 前记旧高、量后按差值同步补写 scrollTop（`prewarm-comp` 写入打点，限幅 8000px）——视口画面全程静止，anchor-comp 只兜残差
- **预热分块按时间预算**（P0-2）：固定 100 块/批 → 单步量测预算 8ms、超时断批让出（requestIdleCallback 优先、200ms 超时兜底、定时器回退），批大小 1~100 自适应（耗时 < 预算半 → ×2，超预算 → ÷2）。总时长可以拉长（下方块变现用户无感），>250ms longtask 消灭
- **预热前等 webfont**（P0-3）：`document.fonts.ready`（上限 3s，已加载即过）后才开量——fallback 度量 → 字体上屏 → 二次批量高度变化的来源（font:loaded 后重测整批的旧模式根除）
- **恢复落点精确化（锚块恢复）**（P1-4，新 `lib/viewportAnchor.ts`）：per-tab 滚动记忆增存「视口顶锚块指纹（前 64 字符）+ children 索引 + 顶边偏移」，恢复时先写近似 scrollTop 再按指纹精确落位（索引先验 ±32 邻域由近及远扫描），与视口上方占位高度完全解耦，一次落位；重试梯子保留为找不到锚块时的回退（80ms 首跳 + 300ms×8）。rebuild-restore 同款：捕获光标所在块的视口偏移，恢复后按偏移对齐
- **写入归因窗跨 longtask 补偿**（P2-5）：PerformanceObserver longtask 回调登记时间区间，ghost 判定从写入年龄中扣除被阻塞时长——只有真实空闲时间参与 250ms 窗。anchor-comp 尾段跨 1158ms longtask 不再误判 ghost（↓3132px 修复）；↓10400px 一类 root-swap 同帧候选同样被覆盖
- **预热诊断计数**（P3-6）：`prewarm.fonts` / `prewarm.chunk`（≥800ms 节流，含游标/批数/批大小/耗时）/ `prewarm.done`（新学块数 + 覆盖率 + 批数 + 总耗时）/ `prewarm.abort`（原因）+ `prewarm.comp` / `write.prewarm-comp` 计数，下次事件可直接定位

### 验证

- `npm test` 277 例全绿（新增 15 例：prewarmOrder 预热顺序 4 + nextChunkSize 预算自适应 3 + matchAnchorIndex 锚块恢复 5 + stepSession × longtask 补偿 3 + longtaskBlockedSince 区间累计 2，其中 1 例为修正后落位语义）
- `npm run lint` / `npm run build`（tsc + vite）全绿
- 待手验（同一份 26,000 行文档，开发者模式）：打开后静止阅读 2 分钟 session.ghost=0 / MD-1001=0；无 perf:longtask >250ms；初始落位后 anchor.comp ≤2 且仅出现在视口上方段；打开后滚到中部阅读无可见跳动；切 tab 往返落点误差 ≤1 屏

### 版本

- 4.2.1 → 4.2.2（package.json / tauri.conf.json / Cargo.toml / Cargo.lock）

## 4.2.1 (2026-08-23)

圆角浮岛收尾修补版：用户反馈「装了 4.2.0 看不出变化」——排查定罪（关于弹窗确认运行 4.2.0 + 窗口处于最大化）：v4.2.0 把最大化设计成回退直角平铺，浮岛外观在最大化下完全不可见；同时审计发现 Crepe 编辑器自带浮层是最后一批 4~12px 小圆角硬编码。

### 修复

- **最大化保留浮岛**：拆除 `.is-maximized` 直角回退规则（留白/圆角/阴影归零 + 单侧细线全部移除），普通/最大化窗口全程圆角一致；沉浸式例外仅剩专注模式。`<html class="is-maximized">` 标记保留但不再驱动样式
- **Crepe 自带浮层圆角收口**（global.css 新增覆盖块，`.mditor-milkdown .milkdown` 双前缀保证特异性恒高于 vendor，不依赖打包顺序）：斜杠命令菜单/代码块语言下拉 → 16px（同 .mb-dropdown 下拉卡档）；链接悬停预览卡/链接编辑条/表格单元格按钮组/行内图片占位卡/LaTeX 行内编辑 → 10px；各浮层内部按钮/搜索框/cm 面板控件 → 6px；块手柄 32px 方形图标钮 → 圆形（999px，同图片操作钮 50% 先例）；已顶栏化的编辑工具条清掉 vendor 8px 残留（通栏 radius 0）
- 应用侧小项：批注代码行高亮 2px → 6px；选区工具条「清除高亮」钮补 6px；SV 模式 CM 自动补全 tooltip 防御性 10px（当前未启用）
- 说明：SV 源码模式/输入框右键弹出的是 WebView2 系统原生菜单（Windows 直角样式），CSS 无法修改，非缺陷

### 开发者模式：滚动异常误报修正

用户反馈：点击按钮改变页面大小引发的滚动被误报为「异常滚动」——那是我让它变的，不是页面自己动。

- **贴底钳制不再误判 ghost（MD-1001）**：点击按钮改排版/开合侧栏等引发内容收缩时，浏览器把贴底 scrollTop 压回新上限（幅度可达数百 px），是「不得不滚动」的合理钳制。现按确定性签名判定（同帧收缩 + 旧位置越过新上限 + 恰停在新上限 ±1px）——该组合只可能由 clamping 产生，任意幅度都归 layout:clamp 不计 ghost；停在其余位置的位移照旧判 ghost，灵敏度不降
- **用户意图信号扩展**：pointerdown 从编辑器内部提升到窗口级——点工具栏/侧栏/设置面板的按钮同样算用户操作；按住拖拽（resizer 调宽）全程有效（e.buttons 窗外松开兜底，防「卡按住」长期压制告警）；Ctrl/Alt/Meta 快捷键计入。普通打字键不算：打字重排由钳制分类兜底
- **用户改布局后的重排告警降级**：点击/快捷键/拖拽后 500ms 内的视口大幅位移（MD-1002）与文档高度突变（MD-1004）降为仅记录——日志与诊断面板照常可见，不再弹告警卡；分析器侧 userInitiated 标记双保险

### 版本

- 4.2.0 → 4.2.1（package.json / tauri.conf.json / Cargo.toml / Cargo.lock）

## 4.2.0 (2026-08-23)

美学大版本：全局圆角圆润化 + 窗口框架「浮岛化」重构；同时收录开发者模式诊断告警体系。

### 美学：圆角浮岛重构

- **圆角三档 token 4/6/10 → 6/10/16px**（--radius-s/m/l，全局约 110 处引用一键圆润化），新增 `--frame-pad: 8px` 画布留白 token
- **窗口框架浮岛化**：`.app` 变画布（新增 `--frame-bg` 五主题各配色：比面板深一档），标题栏/标签栏/侧边栏/主区/AI 面板/状态栏六卡片化——全边框 + 16px 圆角 + 柔和阴影；纵向间距用卡片 margin（避免空 tabbar 行塌缩出现双缝）、横向间距由 resizer 沟槽承担（宽 6→12px，透明即间距、hover 圆角高亮）
- **最大化智能回退**：TitleBar 把最大化状态落到 `<html class="is-maximized">`，画布留白/圆角/阴影归零并恢复 v4.1 单侧细线（避免相邻卡片双边框叠 2px）；**焦点模式**画布归零全屏沉浸
- **直角元素补齐**：文档标签页上圆角（Chrome 式，激活指示条内缩胶囊化）；编辑器/AI 消息/诊断面板三处表格改 separate 边框 + 表级圆角容器（末列/末行清线）；文件树/大纲/设置导航指示条 999px 胶囊；mark/diff-mark 圆角化；AI 聊天气泡 12→16px、尾角 2→4px；ErrorBoundary 内联圆角同步（10→16、6→10）
- 保持不动：Windows 关窗键矩形惯例（已被标题栏卡片裁切）、胶囊 999px/圆 50% 特形、blockquote 左线不对称圆角

### 开发者：诊断告警体系

- **开发者模式总开关**（设置 → 性能与诊断）：分级混合告警——普通异常右上角浮动警告卡（按错误代码 60s 冷却合并），error 级/内存自愈额外原生弹窗（每代码每会话一次）；只接现有诊断源零新埋点
- 新增模块：`lib/devAnomaly.ts`（MD-XXXX 错误代码表 + AnomalyTracker 冷却合并）、`lib/logBatcher.ts`（满 50 行或每秒合并 append_log，队列 500 溢出丢最旧）、`lib/devMode.ts`（订阅 scroll/anno/op 三总线 + window error/unhandledrejection + 30s 心跳 → dev-events.log / dev-anomalies.log，2MB 轮转）
- **修复 append_log 路径囚禁检查写反**（v3.9.1 引入，memory.log 自 8/19 静默停写）：抽 `is_log_path_confined` 纯函数 + Rust 回归测试
- AnnoDiagnostics 加异常小节 +「日志」按钮（plugin-shell 打开 logs 目录）；ErrorBoundary componentDidCatch 接入 noteRenderError

### 版本

- 4.1.2 → 4.2.0（package.json / tauri.conf.json / Cargo.toml / Cargo.lock）

### 验证

- 静态复刻页（真实 global.css + 五主题）计算样式硬校验 12 项全过：画布 8px/#e9ebf0、六卡片 16px、标签页 10/10/0/0、表格 separate+10px、气泡 16/16/4/16、resizer 沟槽 12px；浮岛布局经视觉模型确认
- `npm test` 258 例全过（新增 devAnomaly 12 + logBatcher 6 + opDebug 订阅 1 + 徽章盖章 7）；cargo test 回归通过；`npm run build`（tsc + vite）全绿

## 4.1.2 (2026-08-22)

「代码块振荡 + ghost 滚动」根修（v4.1.1 后复发案）。依据用户导出的三份滚动诊断定罪：**元凶是 Milkdown 代码块组件（@milkdown/components CodeMirrorBlock）的懒生命周期**——共享 IntersectionObserver（viewport±200px）进带挂载完整 CodeMirror、离带 5 秒拆除为裸 `<pre>` 占位符且不保留高度。用户文档中代码块在 110↔157 / 163↔224 / 233↔313px 两种形态间随滚动反复横跳：块高度振荡、文档高度 ±134~1114px 波动、视口内容位移（scrollTop 未变而内容自己动）；贴底时上方块拆除使文档收缩 830px，浏览器钳制 scrollTop 产生「↑230px 无来源滚动」（atBottom+heightDelta:-830 实锤）；AI 流式/整篇回写改到代码块内容时，组件 `update()` 的 `cm.dispatch({scrollIntoView: this.view.editable})` 借 CodeMirror scrollRectIntoView 逐级爬祖先直接写主容器 scrollTop，产生「↓55px ghost」（案发时 AI 流式活跃 + 70ms longtask + 滚后新块进带变高三细节吻合）。

### 修复

- **patch-package 补丁 @milkdown/components@7.22.1**（patch 机制 + postinstall 固化，重装/CI 不丢）：
  - **拆除高度冻结**：`teardownCodeMirror()` 量取 wrapper 实测高并冻结在 wrapper 上（`height+overflow:hidden`，盖 wrapper 而非占位符——pre 的外边距会漏进 wrapper 高度），重新挂载时清除——拆/挂对布局完全中性，振荡/贴底钳制/视口位移三类症状同根根除
  - **拔掉程序化滚动劫持**：`update()` 的 `scrollIntoView: this.view.editable` → `this.cm.hasFocus`——外部内容写入（AI 流式、整篇回退、查找替换）不再移动视口，用户正编辑的块行为不变
  - **TEARDOWN_DELAY 5s→30s**：减少滚动中 CM 反复重建造成的 50-70ms longtask 卡顿
- **滚动打点补漏**：`Editor.insertAtCursor` 补 `noteScrollWrite("pm-insert")`（milkdown insert() 事务带 scrollIntoView，图片上传异步回调落地时已无用户输入，此前会被误判 ghost）；`svCodeMirror.jumpToLine` 打点提至入口覆盖瞬时分支
- **scrollDebug v3.9.6 换行波定罪探针**：诊断数据中另有「32 块同身份 ±1 行（+24~52px）、总高瞬变 ±1114px、约 7 秒后整体回退」的全文换行波，与 pm:rebuild 无关（计数未涨）、静态穷尽无周期性样式写入者。新增三个只读探针下次导出即可定罪：`layout:width`（.ProseMirror 内容宽度 ResizeObserver）、`font:loaded`（webfont 上屏）、`host:attr`（html/body/host 的 style/class 翻转带旧值）

### 验证

- `scrolltest.html`（新增，dev server 专属验证页，不进 dist）：真 Crepe 实例 + 16 个代码块长文档，可控 IO 桩驱动完整生命周期，5 项断言全过——离带拆除后块高 335→335 精确不变、文档高度仅 1px 亚像素漂移、贴底 scrollTop 稳定、程序化写入（未聚焦 CM + 光标在视口外下方，即 ghost 触发条件）delta=0、无组件异常
- `npm run build`（tsc + vite）与 `npm test`（228 例）全绿

## 4.1.1 (2026-08-22)

「ghost 滚动」四连修：大文档下「页面自己动」（内容自己位移 / 跳转落点漂移 / ±N 高度震荡 / ghost 误报）全链路根修。核心成果：首次为该问题族拿到运行时定罪证据（新增块级归因 + PM 重建检测诊断），**推翻「PM 重渲替换」假设（全程 pm.childlist=0），实锤 Chromium 对 content-visibility remembered size 的距离驱逐机制**，并以「内容寻址高度记忆（PM decoration 承载）+ 加载后分块预热」根除。

### 根因与修复（按任务）

- **任务 0 · 诊断补强（scrollDebug v3.9.5）**：layout:height 只报文档总高 delta，无法定位哪个块、为何变化，-N 塌缩触发源无法定罪。修复：`layout:block` 块级归因（ghost/位移/高度突变触发后 2s 窗口内 100ms 步频逐块比对，报块索引+tagName+首行摘要+delta；平时休眠，big 模式至多 1s 一次基线刷新，常驻每帧仍为常数次属性读取）；`pm:rebuild`/`pm:shape`（对 .ProseMirror 挂只读 MutationObserver 顶层 childList，同批 -3/+3 以上同位替换报 rebuild——H1「DOM 替换」与 H2「图片高度往返」的一锤定音证据）；PM 根整体替换报 `pm:root-swap`；ghost 事件附同帧 scrollHeight 变化量与是否贴底；layout:shift 与 layout:height 同帧合并输出；watch:attach 携带挂载序号，并核实复现中 attach=2/ready=1 实为观察器 effect 依赖 [handle.ready] 的卸载重挂（非宿主重建），改挂载一次
- **任务 1 · ghost 误归因修复**：outline-jump 平滑滚动尾段被 longtask 阻断，会话以「单帧静止即复位」关闭，恢复后 1px 尾段超 250ms 归因窗被误标 ghost（复现证据 lastWrite@1494ms 前）。修复：会话判定抽为纯状态机 `stepSession`（可单测）——连续 5 帧静止确认才关闭会话（longtask 阻断后的尾段恢复延续原会话）；平滑跳转类 tag（outline-jump/anno-jump/sv-jump）归因窗与 App 侧 smoothJump 抑制窗口对齐（标志在位或写入后 1250ms 内均归属写入方）；|delta|<2px 且同帧有高度变化的微位移单独计 `layout:clamp` 不计 ghost（clamp 会话立即关闭，不吞后续真 ghost）
- **任务 2+3 · c-v 高度重估位移与 ±N 震荡（同根同修）**：浏览器自动化复现实锤（Edge headless + 3894 行文档）——全部 -N 塌缩发生在**身份不变**的块上（H2 112→48 恰为 3em 占位），全程 pm.childlist=0，「PM 重渲替换 / park Selection / stamp 循环」全部无罪；真凶是 Chromium 对 content-visibility:auto 块 remembered size 的**距离驱逐**：块离开视口相关区回落 3em 占位、接近时再变现，同一块反复横跳（用户复现 92 次 ±N 成对震荡的来源）；大纲平滑跳转沿路成批变现（单次 123 个 layout:height）使飞行中文档涨 15k+ px，动画目的地按起跳时占位高度计算 → 落点差 14633px、落定后内容再位移 15389px；静置期亦有 41 块/波的批量塌缩。修复（任务书方案 a，PM plugin/decoration 承载，绝不事后直写 PM DOM）：新增 `lib/cvMemory.ts` 内容寻址高度记忆——FNV-1a(节点类型+全文) 会话级高度表（跨编辑器重建存活、20000 条按插入序淘汰），每个顶层块装饰 `contain-intrinsic-size:<w>px <h>px`（占位=真实高度，变现/塌缩 delta≈0）；视口学习（二分定位 O(log n+k)、300ms 节流、学新才防抖重建装饰）持续修正；加载后分块预热（每 100 块临时 content-visibility:visible 强制渲染→量高→换块，双 rAF+让出主线程、覆盖率 ≥95% 跳过、编辑/销毁/新预热代际令牌即中止）——冷启动首跳即按真实高度计算目的地；块本体映射一律经 `view.nodeDOM(pos)`（DOM 子元素与 doc 顶层块因 Crepe 顶层 widget/nodeview 包裹**不可按索引对齐**，首版索引错位曾把图片块量成邻居段落 56px）；c-v 规则排除 .ProseMirror-widget（高 0 的 widget 被命中后跳过态虚占 48px）；useMilkdown 在 big 实例注册插件，并在 build 就绪（有 seed）/整篇载入（big→big 换文档）后调度预热
- **任务 2 补偿层 · anchor-comp 自研锚定补偿**：主修复之外的残余位移兜底（编辑导致的高度变化、表未覆盖的首见块、量测误差）——data-big 下连续静止帧确认的持续视口位移同步补偿（内容下移 S → scrollTop += S，写入打点 write:anchor-comp、单次限幅 8000px、不重新启用 overflow-anchor）；smoothJump 动画期间绝不补偿（longtask 阻断帧造成的「静止」会让补偿掐断动画，实测曾把跳转拦在半途）；哨兵失效自愈（>500px 位移帧作废哨兵 + 比对前校验 |docTop−scrollTop|≤3000）消灭跳转点击瞬间 ↓17 万 px 位移伪影

### 防回归

- 13 处滚动写入打点一个不少；新增写入（anchor-comp）已打点；overflow-anchor 保持关闭、不引入虚拟滚动、data-big 阈值与大文档性能收益不变（c-v:auto 照旧生效，视口外 layout/paint 仍被跳过，预热为一次性空闲分块摊销）；大纲/批注跳转（平滑+瞬时两路径、动效三档）与 smoothJump 抑制打字机机制不回归；诊断面板（体检/复制/清空）与 Ctrl+Alt+D 开关不回归
- 诊断纪律不变：MutationObserver 只读、全入口 try/catch、常驻每帧亚毫秒；预热分块可中止不泄漏；会话状态机 / 高度表 / 块比对 / PM 批次分类均有纯逻辑单测
- 任务 0 的诊断工具常驻保留（下次复现「复制」即出定罪证据）

### 验证

- vitest **228/228**（+24：scrollDebug 事件总线/块比对/PM 批次分类/会话状态机 19 例 + cvMemory 哈希/容量淘汰/style 合成 5 例）；tsc / eslint 0 错；vite build 过
- 浏览器自动化复现验收（3894 行大文档，修复前后同流程对照）：跳转 `session.ghost` 1→**0**（尾段正确归属 session.write.outline-jump）；`layout:shift` 累计 1250px（用户基线）→**0px**；跳转落点偏差 14633px→**48px**（目标标题精确对齐视口顶，全程目标文档坐标零漂移）；跳转期高度事件 123→**0**；3 轮往返滚动 ±N 震荡高度事件 28→**1**（余 1 为噪音）；静置 15s 塌缩波 41 块→**0**；全程 pm:rebuild=0（H1 无罪的反证留档）；watch:attach=1（观察器挂载正常）

## 4.1.0 (2026-08-22)

UI 与动效美学全面升级（9 项）：动效强度三档制（无/平衡/生动）落地为正式设置并贯穿 CSS/JS 两层；设置弹窗改左导航双栏；claude 主题 hover 隐形根修；AI 快捷卡片主题化；批注跳转平滑滚动；弹窗与 AI 面板补退场动效；约 30 处 hover/focus 过渡补齐；设计 token 统一（圆角三档/语义色变量化/失效变量修复/字号阶梯）；点位动效 + 生动档专属动效集。设置项由 34 增至 35（新增 motionLevel，默认 balanced），旧 mditor.json 经既有默认值合并机制自然兼容。

### 根因与修复

- **动效三档基础设施（任务 1）**：全应用动效此前只有 prefers-reduced-motion 一档开关，用户无法调节强度，「生动」层微动效也没有承载机制。修复：Settings 新增 `motionLevel`（none/balanced/lively，默认 balanced），`useSettings.applyToDom` 与 data-theme 同机制直写 `<html data-motion>`（切换即时生效、无闪烁、不依赖重挂载）；CSS 侧 `html[data-motion="none"]` 与 prefers-reduced-motion 并列同一套全局 kill switch，「生动」档增强规则一律 `html[data-motion="lively"]` 前缀惰性承载（平衡/无档零额外样式计算）；JS 侧 `lib/motion.ts motionEnabled`（OS reduce 优先级最高，选中 lively 也按「无」处理），大纲跳转（富文本 smooth 分支 + sv jumpToSourceLine）经 settingsRef 镜像在事件回调内读取生效档位
- **设置弹窗双栏化（任务 2）**：540px 单列长滚动、7 个分区仅靠 accent 小标题分层，层级弱且低频分区藏在折叠组里。修复：弹窗加宽至 720px（保留 max-width 92vw），左列竖排 7 个分区导航、右列仅渲染当前分区（切换只重渲染右列、滚动只发生在右列）；「性能与诊断」升为正式导航分区；「外观」新增动效强度三段式选择；签名点睛——左导航激活指示条随切换平滑滑动（等距 translateY 纯 transform 过渡）
- **claude 主题菜单栏 hover 隐形（任务 3）**：claude.css 的 `--hover` 与 `--titlebar-bg` 同为 #f0ede5，hover 底色与标题栏底色完全同值，反馈不可见（侧栏图标钮等同病）。修复：`--hover` 加深为 #e6e0d2 拉开可辨差距；`.mb-btn` hover/open 改 accent 轻染底（color-mix 12%/14%），与下拉菜单项（accent-soft 底 + accent 字）形成同族暖色语言，五主题各自成色均清晰可见
- **AI 快捷卡片主题化（任务 4）**：快捷操作胶囊用 `--bg` 底放在 `--sidebar-bg` 面板上无层次、hover 瞬切。修复：`--card-bg` 底 + 1px 边框 + 微阴影；hover 微抬（translateY(-1px)）+ 暖色染色；disabled 平滑过渡；AI 面板内模型选择/发送/追问/清除等按钮统一补 0.13s 颜色过渡
- **批注跳转平滑滚动（任务 5）**：侧栏批注点击瞬时跳转，与大纲体验割裂（瞬跳是历史有意为之——弹层需按滚动前 marker 位置定位）。修复：改为「先平滑滚到位，落定后再定位并打开弹层」——scrollend 为主信号、两帧未起滚（目标已在视口）直接视为落定、1200ms 上限兜底，落定后才派发合成 mousedown，弹层按滚动后 rect 精确落位；代码行批注优先滚到被批注的代码行本身（提前高亮，滚动途中即见落点）；打字机抑制窗口统一为大纲同款；sv 模式传 smooth=true 复用 svCodeMirror 现成平滑分支；跳转序号防快速连点串扰
- **弹窗与 AI 面板退场动效（任务 6）**：4 个弹窗与 AI 面板只有入场动画，关闭时 `if (!open) return null` 瞬消——全应用最大动效一致性缺口。修复：新增 `useDelayedUnmount`（关闭后保持挂载约 240ms 播 `.closing` 退场动画再卸载，重开立即恢复不叠加）；退场只动 transform/opacity（卡片 scale(0.96)+translateY(8px)+opacity 淡出、遮罩同步淡出、AI 面板向右收回），退场期间禁指针
- **hover/focus 过渡补齐（任务 7）**：约 30 处按钮 hover 背景瞬跳、输入框 focus 边框瞬变。修复：集中一条组规则统一补 background-color/color/border-color 0.13s 过渡（只过渡颜色不引入位移，白名单属性）；输入类控件 focus 边框同曲线；高频交互件补 focus-visible 描绘环（accent 2px、offset 1px）
- **设计 token 统一（任务 8）**：圆角 4/5/6/8/9/10/12/14px 多套并行、danger/success/diff 语义色硬编码散落 18 处、`--mono-font`/`--muted` 两处失效变量、claude 缺 `--mark-bg` 回落黄色 fallback、chrome 层 13 种字号。修复：8a 圆角三档 `--radius-s 4 / -m 6 / -l 10`（映射 3/4/5→s、6→m、8/9/10/12→l；胶囊 999px、圆 50%、聊天气泡尾角等特形保留）；8b 建主题变量 `--danger*/--success*/--diff-add-*/--diff-del-*` 五主题各自调值（深色两主题借此消除浅粉/浅绿亮块，`.ai-notice` 底色由误用的 accent-soft 修正为 success-soft）；8c `--mono-font`→`--font-mono`、`--muted`→`--fg-muted` 共 8 处修复，claude 补暖琥珀 `--mark-bg`；8d 字号四档 `--font-size-xs 11 / -s 12 / -m 13 / -l 14`（正文 `--font-size` 与源码模式固定 14px 不动）
- **点位动效 + 生动档（任务 9）**：平衡档基线补 Tab 增删淡入/淡出缩收（关闭经 TabsBar 180ms 残影，保存/确认逻辑不等动画）、编辑器模式切换 0.2s 入场淡入（宿主直接子级，内容更新不重放）、设置分区切换淡入上移；生动档专属集（`html[data-motion="lively"]` 惰性前缀）——侧栏面板/设置分区 Field 级联入场（25ms/项、整组 ≤300ms 封顶）、弹窗与下拉弹性入场曲线（cubic-bezier(0.34,1.4,0.5,1) 轻微过冲）、卡片 hover 抬升增强（translateY(-2px) + 静态阴影直换）、AI FAB 按下快压松手回弹（纯事件驱动一次性）

### 防回归

- `types.test.ts` 快照由 34 键更新为 35 键（含 motionLevel: "balanced"）；新增 `motion.test.ts`（3 例）锚定档位生效逻辑（none 恒禁 / prefers-reduced-motion 压过 lively）
- 性能红线全程遵守：新动效只动 transform/opacity、零常驻零循环、无 rAF 循环/轮询、hover 过渡白名单属性、生动档规则惰性（属性选择器前缀）、既有 contain 隔离/content-visibility/.app-idle 暂停/kill switch 全部未回退
- 语义色浅色三主题沿用原值观感零变化；硬编码语义色残留扫描为零；`--mono-font`/`--muted` 失效引用清零

### 验证

- vitest **204/204**（+3：motion 档位逻辑）；tsc / eslint 0 错；vite build 过
- 人工核验步骤（`npm run tauri dev`）：①设置 → 外观 → 动效强度逐档体验：「无」全部动画消失跳转瞬时 /「平衡」默认完整体验 /「生动」级联与弹性可见，切换后立即开弹窗/跳转验证即时生效；②设置双栏七分区逐项可用、导航指示条滑动流畅；③claude 主题菜单栏 hover 清晰可见、AI 快捷卡片 hover 微抬按下有缩放；④批注跳转平滑且弹层落位正确（富文本与源码各一次）；⑤全部弹窗开合均有完整进出动画；claude/dark/claude-dark 三主题无色块突兀；⑥5000+ 行大文档下切分区/开关弹窗/批注跳转/生动档全开均无可感知掉帧

## 4.0.0 (2026-08-21)

两大交互 bug 根修 + 两项界面/体验重构：①长大纲面板被裁剪无法滚动；②文件树二级及更深文件夹点击展开无反应；③设置弹窗按功能域分区；④全局搜索点击结果精确定位到匹配行/文本（源码与富文本两模式）。设置项集合与默认值零变化（快照锚定），升级无迁移。

### 根因与修复

- **大纲面板不能滚动（Bug 1）**：`.sb-panel` 是 `overflow:hidden` 的 flex 列，文件树靠 `.ft-wrap`/`.ft-scroll` 两级配合（`flex:1` + `min-height:0` + `overflow-y:auto`）实现滚动，而大纲的 `.ol-root` 只有 `list-style/margin/padding` 规则——既不收缩也不滚动，标题多时下方条目被整列裁掉。修复：`.ol-root` 补齐与 `.ft-scroll` 同款三件套 + `overscroll-behavior:contain` 与底部 12px 呼吸空间（纯 CSS 布局手段，无 JS 参与）
- **二级及更深文件夹点击展开无反应（Bug 2，主修）**：嵌套 `FileNode` 的 `expanded`/`childNodes`/`loading` 是在**父行 render 期间**经 ref 访问器算出的 props——点击二级文件夹只改变该文件夹自身状态，中间各级祖先行自有 props 全部不变而被 React.memo 跳过，而深层行的 props 恰恰要在祖先行的 render 里才会重算；于是 expanded Set 与 childrenMap 都已更新，整棵子树的 DOM 却冻结在旧值（箭头不转、子级不渲染，「看起来点了没反应」）。一级正常是因为根级行的 props 由 FileTree 自身渲染时直接计算，FileTree 每次 setState 必然重渲染。修复：每行改用 `useSyncExternalStore` 直接订阅集中状态（FileTree 每次渲染后通知订阅行），快照为布尔值或恒等稳定数组（`sameEntries` 已保证列表恒等），只有自身状态变化的行重渲染——无关兄弟行的 memo 与既有性能设计完全保留，`toggleDir`/懒加载/祖先链自动展开/批量选择等状态逻辑零改动
- **搜索点击不定位到匹配处（优化 2）**：`onOpenSearchResult` 打开文件后用固定 300ms 定时器跳转，而打开链路异步多段（回源读盘、大文档 worker 预解析、标签激活、编辑器内容应用），就绪与落地并不保证在 300ms 内完成；超时场景下 `jumpToSourceLine`/`revealText` 打在未就绪编辑器（`?.` 链静默吞掉）或旧文档上——用户看到的就是「只打开了文件」。修复：跳转改由 Editor 新增的 `revealAfterLoad` 队列在**确定性时机**执行——`fileApi.openPath` 内 `onLoaded` 是同步触发的，编辑器就绪时内容此刻已同步 `setValue` 落地 → 立即执行；未就绪时内容进既有 `pendingContentRef` 缓冲、跳转目标排队，由「就绪重放」effect 在内容确定落地后触发；每次新文档 `onLoaded` 先清队，过期目标不会串档；sv/富文本按触发时刻的模式选行号或文本定位（排队期间切模式也正确）。无新增定时器/轮询；`noteScrollWrite("search-jump")` 打点随跳转入执行点，归因与真实滚动写入同步

### 设置界面分区重构（优化 1，纯 UI 重组）

- 约 20 项平铺设置按功能域归入七个分区：**外观**（主题、字体预设×2、字体栈×2、自定义 CSS）、**排版**（字号、行高、段落间距）、**编辑行为**（拼写检查、打字机模式、自动保存间隔）、**性能与诊断**（内存自动优化、阈值、批注诊断面板；默认折叠，复用 `field-collapsible` 既有模式）、**AI 助手**（沿用既有分区，「测试连接」上移至模型与系统提示词之后）、**快捷操作**（沿用）、**工作区**（已移除项目的恢复）
- Settings 接口 / store / 默认值 / draft-apply 读写时序零改动，升级无迁移；每个 Field 的控件 JSX 逐字保留，仅重排与加分区标题

### 防回归

- 新增 `types.test.ts`（3 例）：锚定 Settings 字段全集（34 键）与全部标量默认值——分区重组若误动任何设置项/默认值即红
- 既有 198 例零回归；文件树一级展开、大纲点击跳转（`jumpToHeading`）、搜索打开文件、批注/块操作等路径未触碰

### 验证

- vitest **201/201**（+3：设置清单锚定）；tsc / eslint 0 错；vite build 过
- 人工核验步骤（`npm run tauri dev`）：①打开 30+ 标题文档 → 侧栏大纲可滚动见底；②建 a/b/c 三层嵌套文件夹 → 逐层点击展开/收起正常；③设置弹窗各分区标题显示、每项控件行为与重组前一致、取消不落盘/应用一次性提交；④搜索点击命中行 → 源码模式滚动到匹配行、富文本定位到匹配文本（各验一次，含冷启动大文件场景）

## 3.9.7 (2026-08-20)

两处用户报告 bug 修复版：①退出按钮要点两次才能关掉应用；②高亮（==高光==）与文字颜色保存不下来（其余编辑操作正常）。

### 根因与修复

- **高光/颜色存不下来（主修，序列化注册键写错）**：`remarkMark.ts` / `remarkTextColor.ts` 把序列化 handler 注册到 `data.toMarkdown`——而 remark-stringify v11 的编译器只读 **`data.toMarkdownExtensions`**（与 remark-gfm 同款注册路径），旧键是没有任何消费者读的死键。后果链：解析方向一直正常（`==x==` → mark 节点没问题），唯独保存方向 Milkdown `getMarkdown()` → `remark.stringify(tree)` 编译到 `mark` / `textColor` 节点时直接抛 `Cannot handle unknown node` → 整个 getMarkdown() 失败 → 保存回退旧缓存——「编辑时看得见、重开全消失」。批注/块操作走其它序列化路径不受影响，这正是「唯独高光颜色存不下来」的不对称证据。修复：两处注册改挂 `data.toMarkdownExtensions`
- **退出按钮要点两次（v3.9.6 引入的回归）**：`forceClose()` 里 `await destroy()`——destroy 在收尾进行中会被吞/挂起（Tauri v2 Windows 已知不可靠记录），await 卡住后 1s 的 `exit(0)` 兜底迟迟轮不到，用户只能再点一次。修复：destroy 与 exit(0) **并行调度**（destroy 不等待、失败静默交给 exit 兜底），兜底等待从 1s 缩到 250ms；`onCloseRequested` 同步区分 `destroyingRef`（直接放行）与 `shutdownInFlightRef`（拦截防并发），收尾中的二次点击不再能绕过或重复触发关闭序列

### 防回归

- 新增 `remarkSerialize.test.ts`（6 例）：用与 Milkdown remarkCtx 同构的处理器（unified + parse/stringify 基座 + gfm + 两个自定义插件）直接锚定保存路径——mark → `==…==`、textColor → `<span style="color:…">…</span>`、混排、嵌套（strong 内 mark / textColor 内 strong）、完整往返、处理器复用。旧注册键下这些用例全部抛 unknown-node 而红

### 验证

- vitest **198/198**（+6：remarkSerialize 序列化往返）；tsc / eslint 0 错

## 3.9.6 (2026-08-20)

关闭窗口/退出应用修复版：v3.9.5 引入的「关闭前自动保存」拦截在某些机器/场景下导致窗口无法关闭（点 X / Alt+F4 无反应，应用关不掉）。本次把关闭路径做成**必然能关**：所有可能挂起点加硬上限 + destroy 失败自动降级 exit(0) + 全程 try/catch 兜底。
### 根因与修复
- **窗口关不掉（主修）**：v3.9.5 在 `onCloseRequested` 里「无脏内容时不拦截、保持原生路径」，且收尾完成后只调 `destroy()`——Tauri v2 在 Windows 上存在异步 close-requested 监听时窗口不会自行完成关闭、`destroy()` 在收尾中被吞/挂起的已知不可靠记录（上游多个仓库实证）。修复：**一律 `preventDefault()` 接管关闭流程**，收尾完成后走 `forceClose()`——`destroy()` + 1s 后进程仍在则 `exit(0)` 兜底（exit 再失败则二次 destroy）。收尾已在上层完成，强制结束不丢数据
- **收尾挂起锁死关闭（防御）**：`flushDirtyTabs`（多标签逐个 IPC 写盘）加 **3s 硬上限**——任一步 IPC 挂起即按「保存失败」继续走确认流程，绝不让窗口永远关不掉（自动保存默认 30s，最坏丢 30s 编辑，远好于应用无法关闭）。关闭流程中的原生弹窗异常（窗口正在销毁等）视为确认、继续关闭
- **重入防并发弹窗**：收尾期间的第二次关闭请求（Alt+F4/再点 X）经 `shutdownInFlightRef` 直接忽略，避免并发弹窗与并发 destroy
- **菜单「退出」同加固**：`exit(0)` 失败时退回 `forceClose()`；退出序列同样带超时兜底
- 整个 `onCloseRequested` 回调包 try/catch：任何异常（动态导入失败、序列化抛错等）记录后仍强制关闭，不留「静默关不掉」状态——异常经 opDebug 遥测可见（`window.__opDebug.report()`）
### 验证

- vitest **192/192**；tsc / eslint 0 错
- 关闭路径人工核验：无脏直关、有脏落盘后关、保存失败弹确认、超时强制关、重入忽略、菜单退出六条路径均可达关闭终点（destroy → exit 兜底）
## 3.9.5 (2026-08-20)

编辑功能重大问题修复版：「块级编辑全部存不下来」（列表互转/转任务列表/分隔线/块上移/下移/复制/删除，批注不受影响）一键根修，附静默失败遥测体系；新增关闭窗口/退出应用前自动保存。

### 根因与修复

- **块级编辑静默失效（用户报告：各种编辑功能存不下来、重开全消失，唯独批注能存）**：v3.9.4 给块操作补滚动打点时，`blockCommands.ts` 的新统一派发出口 `dispatchScrolled` 被写成了**自递归**（函数调用自己、从不 `view.dispatch`）——6 条块命令（列表类型互转、转任务列表的第二步、插入分隔线、块上移/下移、复制块、删除块）的 ProseMirror 事务**从不派发，文档从未改变**；随后的 `RangeError: Maximum call stack size exceeded` 又被 facade 的空 `catch { /* not ready */ }` 静默吞掉——控制台、日志、诊断面板均无任何痕迹。用户侧观感即「编辑没有保存下来」；批注走独立的 `annotationOps` 派发路径，所以唯独批注能保存——这一不对称正是定位根因的关键证据。修复一行：`view.dispatch(tr.scrollIntoView())`。**防回归**：新增 `blockCommands.test.ts`（7 例）用 dispatch 间谍视图钉死「命令必须派发事务且文档确实变化」——修前 7/7 红（RangeError 复现），修后 7/7 绿；tsc/eslint 对运行时递归免疫，这类 bug 只有测试网兜得住
- **关闭窗口/退出应用丢未保存修改（功能优化）**：点 X / Alt+F4 / 菜单「退出」默认直接结束进程，脏缓冲若没等到下一个自动保存间隔（默认 30s）就静默丢失。新增关闭前收尾：`onCloseRequested` 拦截窗口关闭（无脏内容时不拦截、保持原生路径），把**所有**有路径的脏标签写回磁盘（活动标签取编辑器实时内容，非活动标签取切换时的快照），随后主动 `destroy()` 完成关闭；菜单「退出」走同一序列（`exit(0)` 不触发窗口关闭事件，故单独接入）。只有未命名脏缓冲（无处可写）与保存失败的标签才弹确认，与 closeTab/activateTab 的「落盘优于弹窗」哲学一致

### 静默失败遥测体系（工程化排查工具）

- **`lib/opDebug.ts`**：本次 bug 隐形数日的根本原因是「编辑命令的异常被空 catch 吞掉」。现 facade 全部 **22 处编辑类命令**的空 catch（setValue/insertValue/updateValue/insertAfter/insertAtPos/aiWrite×4/toggleMark×5/toggleInlineCode/insertLink/insertFootnote/setTextColor/clearTextColor/setBlockType/moveBlock/duplicateBlock/deleteBlock/tableOp/revealText 等）接入 `noteOpError(op, err)`：按操作计数 + 最近错误记录 + 限频 console.warn（每操作首次必报，其后 10s 一次）。返回 false/null 的 catch（调用方有回退逻辑）不算静默失败，不接入。DevTools 出口 `window.__opDebug.stats() / .report()`。若再现「某编辑功能不生效」，控制台会直接给出是哪个操作在抛什么异常
- 诊断面板（Ctrl+Alt+D）后续可按需接入 opDebug 数据；当前以控制台出口为先

### 验证

- vitest **192/192**（+10：blockCommands 派发回归 7 例——含修复前 7/7 红的对照验证；opDebug 3 例）；tsc / eslint 0 错；vite build 过
- 块命令修复经真实 ProseMirror headless 视图（state 随 dispatch 推进的 PM 官方测试范式）验证事务派发与文档变化，非仅「不抛错」

## 3.9.4 (2026-08-20)

滚动三大疑难问题修复版：滚动偶发「页面自己动/乱闪」、滚动卡顿不流畅、批注弹层随滚动盖住标题栏/状态栏。前两个问题留有运行时证据采集体系（scrollDebug），持续排查不再靠猜。

### 根因与修复

- **标题栏菜单卡片被下方内容盖住（本版追加修复）**：`.mb-dropdown`（`z-index:95`）渲染在 `.titlebar` 内部，而 `.titlebar` 是 `position:relative + z-index:85` 的层叠上下文——95 只在标题栏内部竞争，整个标题栏子树在根层叠里被**封顶在 85**。上面把标签栏/状态栏升到 85 后（DOM 顺序靠后、同值后者胜），菜单下拉卡片反而被标签栏整片盖住。修复：下拉层与点击外部关闭的背板经 `createPortal` 挂到 `document.body`——94/95 直接参与根层叠竞争，稳压 chrome 层(85)/批注弹层(70)/右键菜单(90-91)，仍低于弹窗(100)；主题 CSS 变量定义在 `<html>` 上，Portal 不受影响
- **批注弹层盖住上下栏（代码层实锤）**：`.anno-popover` 是 `position:fixed; z-index:70` 且挂在无层叠上下文的 `.app` 下（参与根层叠竞争），而标题栏只有 `z-index:10`、标签栏/状态栏**根本没有** z-index——弹层滚动跟随时的算术平移 `prev.top + delta` 又完全无视口钳位，锚点滚到视口顶/底时卡片整片压上三条栏。修复三管齐下：① 标题栏/标签栏/状态栏提升为 chrome 层 `z-index:85`（grid item 无需 position 即生效；仍低于右键菜单 90/菜单栏 95/弹窗 100，层级语义不变）；② 摆位算法 `placeCard` 增加可选 `bounds`（chrome 边界）参数，初始摆位/兜底钳位都以「标题栏+标签栏之下、状态栏之上」为可用区间（实测高度动态测量，焦点模式三栏隐藏时自动退化为裸视口）；③ rAF 跟随平移经 `clampTop` 钳回区间——卡片钉在栏内边缘等锚点滚回来，不再跟着滚出屏
- **弹层打开时滚动卡顿（主源）**：旧 rAF 跟随只在「锚点位移 ≈ scrollTop 增量」时才算纯滚动，否则全量 `remeasure`——而 `remeasure` 对**全文档**每个徽章调 `getBoundingClientRect`，在 `content-visibility:auto` 大文档上会强制离屏块逐个布局；大文档滚动中任何高度重估（块进出视口）都会让锚点位移偏离 scrollTop 增量 → 掉进 remeasure 分支 → 全文档强制布局 → 掉大帧 → 下一帧位移更大 → 恶性循环。修复：跟随分支重构为「横向零位移 → 一律算术跟随（不测量）」，只有横向位移（侧栏/AI 面板拖拽改 CSS 变量、resize）才 remeasure；remeasure 自身在大文档下只测视口 ±600px 内**顶层块**的徽章（块级框尺寸对 content-visibility 是已知的，测块不布局子树）——滚动期间弹层开销从 O(全文档布局) 降为每帧 1 次 rect 读取
- **打字机模式与滚动惯性对拉（「页面自己动」嫌疑主源）**：旧让位逻辑是「wheel 事件后 350ms 黑out」，盖不住触摸板/滚轮惯性期（WebView2 上惯性可远超 350ms）——黑out一到、惯性未止，任何 selectionchange 触发的居中都反向拽 scrollTop 与用户对拉。修复：让位改为**滚动静止检测**（host `scroll` 事件持续打时间戳，静止 400ms 才恢复居中），惯性全程天然覆盖，顺带覆盖键盘滚动（PageDown/空格）；居中自己写 scrollTop 也会触发 scroll → 自我抑制一拍，防自激
- **滚动观察器挂错容器（本版诊断体系的自查发现，随版修复）**：`attachScrollWatch` 被挂在 `hostRef`（`.mditor-milkdown`，内容层，scrollTop 恒 0）而非真正滚动的 `.mditor-editor-host`——后果是 ghost 归因完全哑火（`moving` 永假，session:* 一条不发），且用户每次真实滚动都被哨兵**误报为 `layout:shift`**（scrollTop 恒 0 →「未在滚动」恒真 → 每帧测位移，300 条环形缓冲被冲刷，真证据被挤掉）。修复：根 div 增加 `scrollerRef`，观察器改挂 `.mditor-editor-host`；sv 模式下 host 不滚（`.cm-scroller` 内滚），观察器自然休眠（sv 不在覆盖范围，头注已记）。同时补齐 4 组未打点写入——`pm-insert`（AI 插入）/`reveal`（revealText）/`block-op`（块操作 5 处，经统一出口 `dispatchScrolled`）/`code-anno`（代码批注高亮滚动），消灭归因修好后的假 ghost。headless Edge harness A/B 实证：同样 6 步滚动，挂错容器误报 6 条 `layout:shift`、挂对容器 0 条；user / ghost / write 三种归因全部命中且互不串扰

### 滚动诊断体系（工程化排查工具，用户点名）

- **`lib/scrollDebug.ts`**：「页面自己动」从此有运行时证据——
  - **滚动会话归因**：每次滚动从静止开始动时判定发起者——用户输入（wheel/触摸/滚动键/滚动条拖拽）200ms 内 → `user`；已知程序写入 250ms 内 → `write:<tag>`（打字机/大纲跳转/批注跳转/搜索跳转/重建恢复/愈合恢复/sv 跳转/AI 插入/reveal/块操作/代码批注高亮全部已打点）；两者都不是 → **`ghost`（自己动实锤）**，附方向/幅度/scrollTop/最近一次写入来源。惯性滚动天然归属发起会话（持续位移不重判）。仅覆盖富文本/IR 模式（sv 模式的滚动在 `.cm-scroller` 内部，观察器休眠）
  - **视口内容位移哨兵**：scrollTop 没变、但视口顶块的文档坐标变了 → 内容在自己动（content-visibility 高度重估 / 图片加载 / 盖章行内化 / PM 重排）——scrollTop 写入检测抓不到的另一半「自己动」，哨兵二分选取 O(log n)
  - **文档高度突变**：scrollHeight 变化 >8px（c-v 块首次进视口 3em 占位 → 实际高度的跳变证据）
  - **长任务**：主线程阻塞 >50ms（滚动卡顿直接证据）
  - `window.__scrollDebug` 控制台出口
- **诊断面板升级（Ctrl+Alt+D）**：批注+滚动事件按时间合并展示（滚动异常常与批注/盖章/重建联动，交错时间线是定位关键）；「最近 ghost 滚动」摘要区；复制报告含全部滚动证据

### 验证

- vitest **182/182**（+8：placeCard chrome 边界 4 例——视口顶部锚点钳位/贴底钳位/中部不受影响/极窄区间退化，clampTop 4 例）；tsc / eslint 0 错；vite build 过
- 滚动观察器挂载修复经一次性 headless Edge harness 实证（真实 scrollDebug 模块 + 应用滚动结构复刻）：user/ghost/write 三归因命中、挂对容器正常滚动 0 条误报 `layout:shift`、挂错容器（修复前接法）同场景 6 条误报——旧 bug 与新行为双向实锤，harness 用完即删
- 「自己动」其余候选（content-visibility 高度重估、图片加载位移）刻意**未盲修**——scrollDebug 的 `session:ghost` / `layout:shift` / `layout:height` 事件将在复现时给出证据链，届时按证据修（避免重蹈「多轮猜测式修复」覆辙）

## 3.9.3 (2026-08-20)

批注四大问题根修版：徽章无编号/悬停闪烁、批注后代码块连片闪烁、侧栏跳转错位、弹层不跟随。前三者共享一个此前未被发现的真实根因——**盖章管线与 ProseMirror DOM 同步的 17Hz 死循环**（浏览器 harness 实测：空闲期徽章每秒被重建 17 次，恰为 60ms 盖章防抖周期）。附带批注诊断体系。

### 根因与修复

- **盖章战争（Bug 1+2 真根因，实测实锤）**：往 PM 管辖的 DOM 写 `data-anno-num`（徽章）与 `anno-row-item` class（marker 段落）→ PM 的 DOMObserver 视为外来突变 → 从 toDOM 防御性重渲染该节点（写入被抹掉）→ 我们的 MutationObserver 看到节点重建 → 60ms 后再盖章 → 永动。徽章无编号（元素重建窗口内属性永远缺失）、悬停闪烁（元素身份 17 次/秒变化）、marker 段落块级↔行内 17Hz 振荡（下方代码块连片闪的驱动源；与流式无关，手动批注后同样发作）全部由此而来。**根修：所有写 PM 管辖 DOM 的盖章动作包进 `domObserver.stop()/start()` 暂停窗口**（prosemirror 内部 API，`start()` 丢弃挂起记录，PM 完全看不见我们的写入），harness 实测空闲期徽章重建 100 次 → 0 次
- **徽章编号内建化**：包装 `footnote_reference` schema 的 `toDOM`，label 匹配 `anno-N` 时直接在渲染产物注入 `data-anno-num`——编号随 DOM 创建即存在，任何重建零延迟恢复（盖章管线保留为兜底）
- **流式断路器强化**：`no-parse`（中间态解析不出节点）一律跳帧、**永不**整篇回退（整篇重写走同一解析器，下一帧同形态必再失败——v3.9.2 的「连续 3 帧失败自愈」在持续失败形态下退化为 1/3 帧率整篇重写死循环）；`no-def` 自愈至多一次，再失败降级静默跳帧等收尾
- **真实解析器验证**：浏览器 harness（真实 Crepe）对 12 种批注体形态做 standalone/全文/序列化往返三态矩阵——**全部通过**（v3.9.2 的 no-parse 假设对这些形态不成立，断路器仅作防御保留）
- **文末 `<br/>` 污染根除**：harness 复现——定义插入落在 crepe trailing 空段落之后，旧空段滞留为顶级 `<br />`（用户真实文档中观测到的堆积由此产生）。`defInsertPos` 插入前跳过全部 trailing 空段
- **侧栏跳转错位（Bug 3）**：三层修复——① `blockAbove`（文本侧）与 DOM 侧块定位均跳过 marker-only 行/段落：同一代码块第 2+ 条批注的「上方」是别的标记而非代码块，此前解析/高亮/锚定全部落空；② `resolveCodeLines` 新增 `blockIndex`，策略 3 命中他块时高亮/DOM 定位与文本解析两空间一致；③ 跳转路径光标停靠 + smoothJump 抑制（对齐 jumpToHeading 防御）+ 低频预解析 handoff（防抖列表滞后时首击仍有 codeLine）
- **弹层跟随（Bug 4）**：打开期间 rAF 锚点跟随循环——每帧只读锚点一个 rect，位移 <1px 零开销；纯主滚动算术平移（缓存几何仍有效），其他一切位移源（面板拖拽只改 CSS 变量、代码块内 `.cm-scroller` 横向滚动不冒泡、盖章/图片加载布局位移）触发全量重测。关闭即停。harness 实测：滚动跟随误差 0px，布局变化重锚定生效

### 批注诊断体系（工程化排查工具）

- `lib/annoDebug.ts`：环形缓冲事件总线（300 条）+ 计数器（定点写成败分布、整篇重写次数与来源、盖章轮次、弹层跟随通道），批注全链路（创建/流式/收尾/删除/盖章/编辑器重建）全部接入；`window.__annoDebug` 控制台出口
- **批注诊断面板**：设置 →「批注诊断面板」或 **Ctrl+Alt+D**。实时计数器 + 颜色分级事件流 + **「批注体检」**——用真实 Milkdown 解析器对当前文档逐条核查（PM 节点层有定义？DOM 有徽章？编号已盖？buildDefinition 形态 standalone 可解析？序列化往返内容等价？），历史上「字符串级测试全绿但真实解析器丢定义」的事故类型由此常驻可查；一键复制完整报告
- 编辑器探针（`annoProbe`）：每次 crepe 重建重绑，体检与面板经此访问真实 ProseMirror 状态

### 验证

- vitest **174/174**（新增 annoDebug 总线/体检假探针、annoHandoff、堆叠标记解析等 13 例）；tsc / eslint 0 错
- 浏览器 harness（真实 Crepe + 真实组件挂载）：完整批注生命周期（创建→流式 8 帧→收尾）整篇替换 = 0、流式失败 = 0、空闲 6 秒徽章重建 = 0、编号常驻、序列化产物无 `<br/>` 残留、内容完整；弹层滚动跟随 -120px 精确、布局变化重锚定

## 3.9.2 (2026-08-19)

批注流式闪烁根治版：特定文档（多行 bullet 批注体 / 代码行元数据 / 文末 `<br/>` 交错）上 AI 批注流式期间徽章闪烁无编号、下方代码块连片闪烁的根因修复。

### 根因与修复

- **流式帧禁止整篇回退（主因）**：定点替换 `replaceDefinitionOp` 一失败（流式中间态解析不出 `footnote_definition`）就整篇 `setValue` → `replaceAll` —— **每帧一次**把所有代码块的 CodeMirror 子编辑器连根重建 + 全部批注徽章重建（编号 60ms 内补不回 = 空药丸闪烁）。是否失败取决于中间态内容能否被独立解析，与文档强相关（故仅特定文档稳定复现）。修复三层：
  - `updateAnnotation` 增加 `transient` 参数：AI 流式帧标记为中间态，定点失败**跳帧**（下一帧覆盖、收尾 `finalizeAnnotation` 权威写入），绝不整篇回退；手动保存（popover 编辑）保持整篇回退语义
  - 同一 id 连续 ≥3 帧失败（定义真被解析丢弃）才整篇写回一次自愈，杜绝孤儿定义死循环
  - 失败原因可观测：`replaceDefinitionOp` 返回 `TargetedOpResult`（no-def / no-parse / surface），限频 warn（2s 一条）标注跳帧/回退与原因
- **前导空行的流式中间态不再产出「被解析器丢弃」的定义形态**：`withCodeLineMeta` 对首行为空的体此前回退「前缀 `<!--md:line-->`」形态——该形态的脚注定义会被 Milkdown 解析器**整个丢弃**，触发「解析失败 → 整篇回退 → 定义消失 → 再整篇回退」的每帧全文档重写循环。现改为把元数据令牌挂到**第一条非空行尾**，整条体全空时宁可不写令牌（空定义保持存在，下一非空帧补写）
- **代码行高亮链路收窄**（防御纵深）：`restoreCodeLineHighlights` 的「仍已涂色」判断从全文档 querySelector 收窄到 active marker 关联块（任意残留高亮不再误判抑制补画）；popover 锚点优先取 **active 批注自己块内**的高亮行而非全文档第一个（他批注的残留高亮不再把卡片锚到错误的块）；解析 effect 补齐路径 `applyCodeLine` 免 `scrollIntoView`（打开兜底不再突然拽走视口）

### 测试

- 新增 4 例回归：anno-11 真实定义体（多行 bullet + 代码行元数据）的 `buildDefinition` 形态与 round-trip 幂等；前导空行中间态令牌位置；空体中间态定义存活性。全量 161/161 通过

## 3.9.1 (2026-08-19)

全面体检版：安全加固 + 数据丢失修复（安全/Bug/性能/动效四阶段审计，完整报告见 `docs/v3.9.1-audit-report.md`）+ 批注交互修复（徽章闪烁跳动 / 点击要两次）。共修复 2 个数据丢失级 Bug、1 个保存竞态、2 个健壮性缺陷、3 项安全加固、1 项体验缺失、2 项批注交互问题。

### 批注交互（徽章闪烁跳动 / 点击要两次）

- **AI 批注收尾不再整篇重写（「乱闪乱跳」主因）**：定点收尾此前要求从 baseline 里找本批注定义——而 baseline 捕获于创建之前，必然找不到 → 每次收尾都回退 `aiWriteFinalize` 整篇替换**两次**，所有代码块的 CodeMirror 子编辑器销毁重建两遍。新实现（`annotationOps.finalizeAnnotationOp`）不依赖 baseline：单事务无痕删除该批注全部落点（引用/marker 段/定义）→ `closeHistory` 单事务按原位放回 marker 与最终定义，两步都只触碰批注自己的节点，代码块 DOM 全程不动；一次 Ctrl+Z 仍回到批注前（撤销契约不变）；`removeAnnoOp` 与其共用同一套落点收集（`collectAnnotationSpans`）
- **创建瞬间不再「先沉后弹」**：marker 段落此前先以块级段落（≈44px 行盒+段距）渲染，60ms 防抖盖章后才 inline 化（≈24px）——布局塌陷 + 滚动锚定补偿 = 双跳；徽章编号同窗口晚到（空药丸蹦数字）。修复：插入事务后**同步盖章**（`stampAnnotationMarkers` 幂等且有早退），inline 形态与编号首帧生效；`.mditor-editor-host` 关闭 `overflow-anchor` 抑制补偿放大
- **流式期间盖章不再饥饿**：stamp 防抖加 250ms maxWait——流式每帧替换定义节点会持续重置 60ms 防抖，中间态（无编号+块级行）此前滞留整个生成期，结束才整体「咔哒」跳一次
- **徽章单击必有反馈（「要点两次」修复）**：①mousedown 处理器不再做同步整篇序列化解析（大文档 50–200ms 主线程冻结会吞掉第一击）——解析挪到渲染后的 effect；②双源 miss 时不再渲染 `null`（60ms 空窗零反馈），立即渲染卡片壳「正在解析批注…」；③「打开兜底」与「消失关闭」合并为单一解析 effect（显示过再消失→关闭、从未解析到→孤儿卡片）；④弹层兜底钳位绝不盖住被点击的锚点徽章（此前窄窗口/贴边时卡片压住徽章，下一击被 contains 守卫静默吞掉）——`placeCard` 抽为纯函数（`lib/popoverPlace.ts`）并加锚点自避让 + 7 例单测锁定
- 创建批注的双重上抛收敛为单次（`appendAnnoDefinition` 抑制回声，与 marker 插入一致）

### 数据丢失修复（🔴 P0）

- **预读缓存永不过期 → 旧内容覆盖磁盘新内容**：文件树 hover 预读的缓存条目此前无任何失效机制——外部程序（或上一会话）改写文件后，从树中再次点击会用预读的旧版本打开且标记为「干净」，随后一次保存即把磁盘上的新内容覆盖掉。修复：缓存条目记录预读时的 size+mtime，`readFresh` 命中时先 stat 比对、不一致自动回源重读；保存/另存为/外部重载路径同时主动删除条目（双保险）。删除了不做校验的 `readCached` 导出，杜绝误用
- **「全部替换」静默回滚**：查找替换的「全部替换」经编辑器 `setValue` 写回，该路径不置脏、不上抛内容——替换结果既不进自动保存，切换标签时还会被旧快照回滚（永不落盘）。修复：`setValue` 与 `replaceContent` 同路径补 `markDirty` + `onInput`
- **保存窗口期击键丢失**：`save`/`writeOnly` 落盘后无条件「清脏 + 回写提交时的旧内容」，IPC 窗口内到达的击键会被误标为已保存，关标签/切标签时永久丢弃。修复：落盘后重读实时内容，`dirty = (实时内容 !== 提交内容)`——写盘期间的新输入保持脏态，由下一次自动保存补写；另存为对话框期间到达的编辑同样不再丢失

### 健壮性（🟡）

- `mditor.json` 的 `recent` 键损坏（非数组）时不再让每次打开文件都抛「打开失败」——`loadRecent` 校验 `Array.isArray` 后回退空表
- 启动加载设置失败（存储损坏/不可读）不再产生未处理 rejection：保持默认设置可用并 `console.warn`，不自动回存以免默认值覆盖原配置

### 安全加固（🔴/🟡 纵深防御）

- **`append_log` 任意路径写入收窄**：命令此前接受 webview 完全可控的路径（可向 `~/.ssh/authorized_keys`、shell profile 追加任意行实现持久化）。现强制路径必须位于 `<app-data>/logs/` 内；同时改为 async，文件 IO 移出主线程
- **span/mark 内联 style 值级白名单**：rehype-sanitize 对放行的 `style` 属性不做值过滤，恶意 markdown/AI 回复可用 `position:fixed;inset:0` 全屏覆盖伪造界面。管线在 sanitize 之后新增裁剪步骤：仅保留 `color` / `background-color` 声明（colorSpan 功能所需全部），新增回归测试锁定
- 已核实并保持：raw HTML 净化顺序正确（`rehypeRaw → rehypeSanitize`）、`javascript:` 协议被剥离、全仓库唯一 innerHTML 汇入点（MarkdownText）数据全部来自净化管线、外部链接协议白名单（http/https/mailto）、`fetch_image` 限 20MB 且仅 http(s)

### 体验

- 导出（HTML/PDF/DOCX/PNG）全程无反馈 → 状态栏依次提示「正在导出… / 导出完成 / 导出失败」，不再出现大文档导出期间界面「假死」可重复点击的观感

### 已知问题（本轮未修，见体检报告 P1/P2 路线图）

- npm audit：`image-size`（经 `@turbodocx/html-to-docx`）2 个高危 DoS 通告，上游无修复版本；实际触达面为 docx 导出路径，建议关注上游发布
- 渲染管线（unified/KaTeX/lowlight ≈500KB）实际静态打进主 bundle（注释声称懒加载，与实现不符）——首屏优化最大单项
- AI 流式「停止」仅摘除前端监听，Rust 侧请求继续跑到自然结束（继续计费）
- fs 插件 scope `**`（本地优先编辑器的功能性取舍）与 AI API key 明文存储于 `mditor.json`（建议迁移 OS keychain）

### 工程

- 测试：157 通过（新增 placeCard 纯函数单测 7 例 + style 白名单回归 1 例）；tsc / eslint / vite build 全绿
- 版本：package.json / package-lock / tauri.conf.json / Cargo.toml / Cargo.lock → 3.9.1

## 3.9.0 (2026-08-19)

批注交互、AI 面板、滚动/渲染性能、后台开销与 token 成本的一次系统性优化（12 项）。核心思路：流式写回定点化（不重建代码块）、DOM 维护管线合并为单通道、弹层定位「测量一次 + 缓存几何」、AI 请求体收敛到可配置预算。

### 批注（问题 1–2：代码块批注闪烁/点不开、徽章二次点击）

- **流式精炼不再整篇重写**：`updateAnnotationBody` 定点替换 ProseMirror 文档里的 `footnote_definition` 节点——代码块（CodeMirror 子编辑器）与其余块的 DOM/node view 原样保留，消除「代码块批注流式期间乱闪」。代码行元数据首帧整篇解析一次并缓存；找不到定义/解析失败/sv 模式自动回退旧的整篇写回。一步撤销契约不变（相邻帧合并 + `finalizeAnnotation` 以 baseline 收束）
- **弹层存在性判定全部改为现场同步解析**：`AnnotationPopover` 改用 `getMarkdown()`（编辑器实时序列化）做打开查找与「批注消失」关闭判定，彻底不再依赖 150ms 防抖列表与 rAF 镜像；关闭判定还加 60ms 重试，镜像差一两帧不再误杀刚打开的弹层（「点一下没反应」根因）
- **弹层定位「测量一次 + 缓存几何」**：打开时测量锚点与其他徽章几何（文档空间缓存）；滚动帧只用 scrollTop 做算术平移（每帧仅量锚点一个元素）；resize/编辑保存/切换徽章才整体重测。移除 `active?.content` 依赖——流式内容更新不再每帧全文档 querySelectorAll + getBoundingClientRect 批量强制布局（弹层跟着流式乱跳的根源）
- **代码行高亮在重绘后自动恢复**：高亮锚点记录在 `lib/codeAnno.ts`（`setActiveCodeHighlight`），代码块节点视图被 ProseMirror 重绘后由 stamp 管线补画（不滚动、不闪）
- **滚动时弹层跟随锚点**（算术修正，不重测），编辑保存后经 `layoutEpoch` 显式重测

### AI 面板（问题 3：划选追问，新功能）

- **回答正文划选追问**：在已完成的回答正文里划选文字，选区下缘出现「追问这段」浮动入口；选中片段作为 `<quote>` 显式上下文随追问发送，并在线程里以引用条展示。Esc/点击空白取消；Enter 发送、Shift+Enter 换行；选区两端须落在该回答正文内（跨行/跨代码块选中均支持，取纯文本）；流式未完成时不可追问
- **追问草稿提升到面板层持有**：虚拟列表回收行时草稿与引用不丢失、不串行
- 追问仍挂在原回答线程下（parentId 链），多层嵌套与 MAX_MESSAGES 截断降级行为不变

### 渲染闪现（问题 4）

- **MarkdownText 零空白帧**：渲染移入 layout effect + 同步 LRU 探针（`peekRenderedHtml`）——缓存命中（虚拟列表回收行）在同一帧内直出最终 HTML；未命中同步写入与最终排版同字号/行高的纯文本占位（`.md-ph`），管线完成后平滑替换。流式纯文本态与渲染态排版（13px/1.65）对齐，纯文本→富文本切换不再跳变

### 滚动与渲染性能（问题 5–8）

- **图片高度预留**：图片完成加载即记录自然尺寸（会话级缓存，捕获阶段 load 委托），后续渲染预盖 `aspect-ratio`——重渲/重开不再从占位高度突变到真实高度引发整篇回流与滚动锚定补偿（滚动抖动最强候选）。首次浏览仍会移动（解码前尺寸未知，这是无服务端尺寸信息下的物理极限）
- **sv 平滑跳转抑制标志覆盖动画全程**：`jumpToLine` 的 `SmoothJumpFlag` 此前同步 dispatch 后即复位，动画窗口内任何选区事务的打字机居中都会瞬时滚动掐断动画；现在 scrollend/1.2s 超时兜底复位（与富文本路径一致）
- **富文本打字机滚轮让位**：`centerCaret` 在用户滚轮后 350ms 内不强制居中——此前每次 selectionchange 同步量 rect 改 scrollTop，恰逢滚轮惯性期就与用户滚动互相拉扯；大纲平滑跳转也支持滚轮打断（打断即解除抑制，光标跟随恢复）
- **编辑路径三通道合并为单通道**（问题 7）：批注徽章 stamp、图片懒加载/宽高 stamp、代码行高亮补画合并进 `useAnnotationMarkers` 的 MutationObserver（60ms 防抖 + rAF）单一调度；删除 `markdownUpdated` 里的冗余双 rAF stamp（此前每次键入跑两遍全树查询）。早退缓存扩展到图片（无注解无图片文档键入零 DOM 查询）
- **批注侧栏锚点摘要批量化**：`getAnchorSnippets` 单次扫描解析全部批注的首个行内引用，替代 O(批注数×文档长度) 的逐条正则扫描（50 批注 500KB 文档每次防抖更新从 ~25MB 文本扫描降到一次全文扫描）
- **reload 后滚动恢复重试**：250/600/1200ms 阶梯重试直到内容高度足够（此前大文档 250ms 单次常被钳位）
- 标题走查维持既有微任务合并 + 签名去重（PM doc 遍历，无 DOM 查询），不变

### 后台开销与系统级（问题 9–11）

- **AI 悬浮按钮呼吸光晕合成器化**：动画属性从 box-shadow（绘制属性，空闲期每帧重绘）改为 transform + opacity（合成器属性，主线程零重绘）；窗口隐藏时自动暂停（`.app-idle`）；尊重 prefers-reduced-motion。视觉强度保持（柔和强调色脉冲圈）
- **大文档遮罩一次性淡入**：1.4s 无限呼吸 + 常驻 will-change 合成层 → 0.3s 一次性淡入，遮罩静态在场，切换期间零周期性 repaint
- **内存守护「可见、可避、可恢复」**（问题 10）：
  - 用户输入/滚动后 30s 内推迟自愈（critical 临界除外——内存保护优先），每增长期提示一次「将在空闲时自动优化」；软重建 8s 复查的升级路径同样让位
  - 重建前捕获滚动位置与光标上下文，新实例 ready 后按文本锚点恢复光标 + 恢复滚动（软重建从「无提示重置」变「几乎无感」）；idle 历史回收同样接入活动门控（活跃阅读/滚动时不打断）
  - 巡检周期（10s）与阈值（默认 2500MB / 0.9 临界比）不变——内存保护第一目标不削弱
  - 主动重建触发点清单：内存守护软重建（超阈值+冷却+空闲）、守护升级 reload（软重建无效或临界，空闲窗口）、idle 历史回收（大文档+1000 次编辑+3 分钟无编辑+堆 ≥80% 阈值+用户空闲）、big-doc 档位翻转重建（整篇载入跨越阈值，随文件切换自然发生）
- **定时器审计**（问题 11）：全部 setInterval/setTimeout/rAF 站点核查——ThinkingDots 200ms（仅流式占位期间，卸载即清）、内存守护 10s（enabled 门控）、dev 堆探针 30s（IS_DEV）、状态栏时钟 2s、自动保存间隔、搜索/文件树/工具栏的防抖与轮询——均有卸载清理，无泄漏、无常驻空转

### AI token 降本（问题 12）

- **上下文截断策略**（`设置 → AI → 上下文策略`）：standard（默认，开头 6000 字）/ large（12000 字）/ smart（本地相关度节选：标题恒保留 + 头尾段 + 与提问字符级共现打分最高的段落，零额外请求）/ full（不截断，旧行为）
- **对话历史 token 预算**（默认 8000，可调）：请求只携带预算内的最近问答对，超出从最早丢弃，孤儿回答一并修剪；UI 的 MAX_MESSAGES=100 上限不变
- **追问降本**：全文追问带截断 note；选区追问不带 note（线程链 + 选区足够）
- **批注精炼输入截断**：默认 4000 字符（可调），长回复精炼不再原样重发
- **`aiMaxTokens` 默认 0 → 4096**：输出上限防失控（旧配置的 0/缺失经迁移统一升级）
- **会话用量统计**：输入区下方常驻「本会话 ≈ 输入 X / 输出 Y tokens」（本地中英混合分词密度估算，零额外请求）
- 预期收益：长文档多轮聊天输入 token 省 70–90%；长对话省 50%+；批注精炼省 60%+

### 工程

- 测试：149 通过（新增 `ai.test.ts` 17 例：估算/四策略/预算裁剪/孤儿修剪/精炼截断；新增 `annotations.test.ts` 6 例：批量锚点摘要等价性）
- 版本：package.json / package-lock / tauri.conf.json / Cargo.toml / Cargo.lock → 3.9.0

## 3.6.7 (2026-08-19)

批注修复第二轮：代码行批注元数据在富文本往返中丢失（徽章孤儿化）、代码块批注横向排列在真实编辑器首次生效、弹窗遮挡相邻徽章、孤儿徽章点击静默无反应。

### 功能正确性（批注）

- **代码行批注元数据不再被解析丢弃（主根因）**：旧形态 `[^id]: <!--md:line…-->内容`（元数据令牌在正文开头）经 Milkdown/Crepe 解析往返后定义整个消失——徽章渲染成孤儿（可见但点不开），且 `nextAnnotationId` 还会复用该 id。修复：新写入把令牌挪到首行行尾（`内容 <!--…-->`），该形态可稳定往返；`stripCodeLineMeta` 兼容读取旧前缀形态。遗留：旧文档前缀形态在富文本模式保存时定义仍会丢——编辑该批注会自动迁移为新形态
- **代码块批注横向排列在真实编辑器首次生效**：ProseMirror 给「只含标记」的段落自动塞 `<img.ProseMirror-separator>` 与 `<br.ProseMirror-trailingBreak>` 辅助节点，导致上轮打的 `anno-row-item` 类从未命中（横向排版实际未生效过）。修复：`isMarkerOnlyParagraph` 忽略这两类辅助节点后再判定
- **弹窗卡片不再遮挡相邻徽章（「要点两次」主因）**：弹窗按固定方位（右侧）摆放时盖住相邻徽章，点击命中卡片被忽略，看起来像"要点两次"。修复：`placeCard` 按 右/左/右下/左下 候选择优——每个候选做视口钳位 + 与其他徽章矩形的碰撞检测，全部冲突才退回原钳位逻辑
- **孤儿徽章不再静默失败**：点击的徽章在实时文档中找不到定义时，先等 60ms 重试一拍（覆盖 rAF 实时镜像滞后），仍缺失则渲染「内容缺失」卡片并给出「删除该标记」入口，而不是什么都不显示
- **sv 模式连续批注行锚不丢**：`resolveCodeLines` 容忍标记同行前置的其他 `[^anno-*]` 标记（sv 插入在 fence 后同行堆叠多个标记时不再误判为散文锚定）
- **「精炼中…」不再永久禁用**：AI 面板关闭/重开时复位 `annotatingId`，防止精炼流挂起时「批注」按钮停在禁用态

### 工程

- 版本：package.json / package-lock / tauri.conf.json / Cargo.toml / Cargo.lock → 3.6.7

## 3.6.6 (2026-08-18)

批注交互修复（点击无反应 / 代码块批注竖向堆叠）+ 大纲跳转平滑滚动（富文本与 sv 双路径）。

### 功能正确性（批注）

- **修复批注徽章点击无反应**：根因是 `useAnnotations` 的 150ms 防抖列表过期——文档刚变化（新建批注、切文件、AI 写回）后点徽章，popover 在防抖列表里查不到 id 就立即关闭。修复：点击时刻用 `parseAnnotations(markdownRef.current)` 对实时文档现场解析兜底（fallback state）；「批注消失」的关闭逻辑也改为现场解析确认后才关，避免误关。次因：徽章 16×16 命中区过小，CSS `::after` 外扩 4px 扩大点击区
- **代码块批注竖向堆叠改为横向排列**：每个标记独占一段（`insertAnnoMarker` 代码块分支），修复为纯渲染层方案——`stampAnnotationMarkers` 给「只含标记」的段落打 `anno-row-item` 类，CSS `display:inline` 使连续标记段流入同一行、满行自动换行。不动 markdown 源（`resolveCodeLines` 的代码块锚定依赖「标记独占一行源文本」的约束，经用户确认仅改渲染层）；标记被删除或段落被输入文本时自动摘除该类

### 体验（大纲跳转平滑滚动）

- **富文本 + sv 双路径平滑滚动**：大纲跳转从瞬时滚动改为平滑滚动；打字机模式下对齐到视口中部（与 sv 路径一致）。富文本路径 focus 先行、平滑滚动后发，scrollend/1.2s 超时兜底清除 `host[data-smooth-jump]` 标记，期间 Editor 的打字机选区居中（瞬时 scrollTop）看到标记即跳过，不再一帧掐断动画
- **sv 路径**：`jumpToLine(line, smooth)` 新增平滑参数——落光标事务置 `SmoothJumpFlag` 抑制打字机居中，再对 scrollDOM 平滑 scrollTo 到与瞬时路径相同的对齐目标（focus 先行的光标滚动发生在量坐标之前，后发的平滑滚动为最后一次滚动指令，不会被覆盖）
- **尊重系统「减少动态效果」**：`prefers-reduced-motion: reduce` 时富文本与 sv 路径均退回瞬时滚动

### 工程

- 版本：package.json / package-lock / tauri.conf.json / Cargo.toml / Cargo.lock → 3.6.6

## 3.6.5 (2026-08-17)

大文档性能三阶段优化的前两阶段落地（解析缓存 + 后台线程解析）+ 富文本视口化中间态，工程治理（巨型文件拆分、lint 清零、测试补强、安全文档）。

### 性能：阶段 1 —— 标签级解析缓存 + 空闲预解析

- **切回看过的标签零解析**：新增内容寻址的解析结果缓存（`lib/docCache`），按 `长度:FNV-1a` 指纹缓存「markdown → ProseMirror 文档 JSON」，LRU + 字节预算（总量 ~16MB 源文本 / 至多 6 条 / 单条 ≤4MB），只缓存大文档。`useMilkdown.setValue` 整篇载入时命中缓存即 `Node.fromJSON + EditorState.create` 直装，完全不跑 remark 解析；未命中的原地解析结果自动回填，下次切回同一份内容即命中
- **失效策略**：内容被编辑 → 指纹自然变化（无显式失效协议）；编辑器重建换 Schema → schema 签名不符即弃用（同名 schema 可跨重建互换，缓存因此能在 recreate 后存活）；缓存淘汰接入内存守护——10s tick 堆超阈值先清缓存、停预解析（比重建编辑器廉价一个数量级），回落自动恢复
- **空闲预解析**：切换收尾后的 idle 窗口（requestIdleCallback）预解析「下一个最可能的目标」——文件树 hover 预读的大文档优先（复用 `filePrefetch`，新增 `peekHoverContent`），其次相邻标签快照；预算严格 1 个目标、新切换开始即取消、内存压力自动停
- **脏大标签切换免序列化**：`getCurrentContent` 富文本模式改走 rAF 镜像（每次输入同步更新，快照至多滞后一帧且不丢字；镜像为空才兜底序列化一次），sv 模式仍直读表面值——把 O(n) 的 `getMarkdown()` 全量序列化从切换热路径上拿掉

### 性能：阶段 2 —— 后台线程解析

- **首次打开的解析阻塞移出主线程**：新增 `parseWorker`（Vite module worker），大文档打开/切回在遮罩上屏后、setValue 之前 `await prepareDoc`——worker 用与编辑器 remarkCtx **同插件集**的管线（`lib/remarkPipeline`：remark-parse + inline-links + preserve-empty-line（按 preset-commonmark 逐行复刻）+ gfm + math（按 Crepe latex 复刻，大文档档位自动关闭）+ 本应用 mark/textColor）产出 mdast 树，原文 UTF-8 ArrayBuffer 走 Transferable 零拷贝；主线程经 `ParserState.next/toDoc`（@milkdown/transformer 公开 API）轻量映射为 PM 文档入缓存
- **一致性哨兵**：`bindEditor` 读取 remarkPluginsCtx 与预期插件数（小文档 7 / 大文档 5）比对，数量不符（未来注册了新 remark 插件）→ worker 自动禁用、回退主线程路径，绝不静默分叉；`remarkPipeline.test.ts` 锚定各插件行为（mark/gfm/脚注/链接归一/br 清理/颜色 span/math 块化/处理器复用）
- **失败兜底**：worker 加载失败/解析异常/超时（按体量缩放，上限 10s，超时终止重建）→ 静默回退现状同步解析，遮罩机制不变；沿用切换 token 语义，过期结果直接丢弃
- **顺带受益**：sv 模式下大文档源码文本即刻上屏、预解析后台进行；sv ⇄ 富文本切换、sv 导出 HTML 的隐藏解析改走同一缓存路径

### 性能：阶段 3（中间态）—— 富文本大文档视口化

- big 模式（>3000 行 / >500KB）对 ProseMirror 顶层块启用 `content-visibility: auto`：浏览器跳过视口外子树的 layout/paint，DOM 仍在文档中——跨视口选区、查找、批注 marker、大纲跳转全部不受影响，以零交互回归风险拿到视口化的主要收益（1MB+ 文档数千块的滚动/输入不再为离屏块付布局）。完整分区渲染/通用视口化（跨视口选区、拖拽等难题）按计划作为独立攻坚项目，见 `docs/performance.md`

### 工程

- **巨型文件渐进拆分**：切换动画状态机抽为 `hooks/useSwitchFlow`（token/最短可见时长/等帧判定，纯时序逻辑入 `lib/switchTiming` 供单测）；sv 表面辅助函数（~305 行）抽为 `lib/svTextarea`；块级命令（~330 行）抽为 `lib/blockCommands`；导出主题 CSS 收集抽为 `lib/themeCss`。useMilkdown 2480 → ~1970 行，App 卸下状态机与工具函数
- **lint 清零（4 → 0）**：`Editor.tsx` useImperativeHandle 工厂体统一走 `fileApiRef.current.markDirty()`（消除「当前安全仅因 markDirty 是稳定回调」的隐患，未来加入任何 fileApi 依赖不会静默过期）；App 两处 settingsApi 依赖改走 `settingsRef`；SelectionToolbar 的 `getActiveMarks` 改 ref 镜像
- **测试补强**：新增 28 个（`docCache.test` 9：指纹命中/内容失效/签名失效/LRU 淘汰与刷新/字节预算/压力清空；`switchTiming.test` 7：最短可见剩余时长/等帧判定；`remarkPipeline.test` 10：worker 管线行为锚定；`parseShared.test` 4：指纹性质），全套 **118 个通过**；tsc / eslint（0 error 0 warning）通过
- **安全文档**：新增 `docs/security.md`（`dangerousDisableAssetCspModification` 的取舍与 CSP 手动放行说明、fs 全盘权限的攻击面收敛、AI API key 明文存储的边界与建议）与 `docs/performance.md`（三阶段架构、缓存/worker 一致性契约、验证方式）；README 增加入口链接
- 版本：package.json / tauri.conf.json / Cargo.toml / Cargo.lock → 3.6.5

## 3.6.3 (2026-08-17)

大纲/批注跳转正确性修复 + 大文件打开/切换性能与动效。

### 功能正确性（大纲 / 批注跳转）

- **点击时用 live 内容解析跳转目标**：大纲树与批注列表来自防抖（150ms）+defer 的 markdown 镜像，点击瞬间的行号/id 可能是旧快照的（打字后、AI 回写、切标签后 150~350ms 窗口内）——跳转不再信任快照数据：
  - sv 模式大纲：按 (标题文本, 同文本出现序数) 在 **live** 源码上重解析定位（`lib/outline.ts` 新增 `findHeadingLine`，`OutlineNode.occurrence` 由构树时单遍标注），过期的 `node.line` 不再驱动跳转
  - 富文本大纲：点击的 id 先对照 **live** `docHeadings` 校验，失效时按 (文本, 序数) 找回正确 id；选择器从全局 `getElementById` 收窄到 Milkdown 宿主内；跳转前把光标停到标题文本上，杜绝 ProseMirror 恢复选区后把视口拽回原光标处
  - sv 模式批注：代码行批注现在跳到**被批注的代码行本身**（`resolveCodeLines` 新增返回 `blockStartLine` 绝对行号，与富文本 popover 同一套重解析逻辑），不再落在代码块下方数百行之外的 marker 行；正文批注跳 marker 行为不变
  - `findAnnotationRefLine` 从裸正则首命中改为逐行扫描：跳过围栏代码块内的形似 token（写"关于脚注的文档"不再被误伤）与批注定义块内的引用（批注内容里引用另一条批注不再误导定位）
- **切换期间侧边栏门禁**：切换动画期间大纲/批注面板 `pointer-events: none`（批注 id 每篇文档都从 `anno-1` 重新编号，点了旧文档的列表项会跳到新文档同号批注）；文件树不门禁（openPath 的 supersede token 本就为快速连点设计）

### 性能（大文件打开 / 切换）

- **修复标签切换动画顺序 bug**：旧 `activateTab` 把 `showDoc`（整篇重解析，大文档秒级阻塞主线程）跑在 `setDocSwitching(true)` 之前且无 rAF yield——动画在重活结束后才绘制，完全没起作用，200ms 盲定时器反而白等。现统一为 openPath 的「先响应」模式：`beginSwitch`（立即亮动画 + token 作废旧切换）→ 双 rAF 等动画绘制 → 保存/读取/重解析 → `finishSwitch`（MIN_SWITCH_MS 最短可见 + 仅最新 token 有权收尾）
- **干净标签切走免序列化**：`snapshotActiveTab`/`activateTab` 在标签未脏时直接用 `doc.content`，省掉大文档每次切换一次 O(n) 的 `getMarkdown()` 全量序列化（外部重载路径新增 `useFile.noteExternalReload` 保证 clean 态下 `doc.content` 始终权威）
- 动效严格不拖慢打开：纯 CSS、只动 transform/opacity（合成器驱动，主线程被解析阻塞期间动画仍在跑）、在双 rAF yield 窗口内先绘制

### 动效

- **大文档切换遮罩**：切入大文档（>3000 行 / >500KB）时编辑区叠加半透明遮罩 +「正在载入大文档…」呼吸动效（`<main data-heavy>`），掩盖整篇重解析的等待；小文档保持 2px 顶栏 + 内容即刻可见（不被 300ms 最短可见时长拖慢）；`prefers-reduced-motion` 降级为静态遮罩

### 工程

- 新增测试 7 个（`outline.test.ts` 的 `findHeadingLine`/`stampHeadingOccurrences`、`codeAnno.test.ts` 的围栏/定义块跳过 + `blockStartLine` 期望值更新 + sv 绝对行号换算），全套 **90 个通过**；tsc / eslint（0 error，4 个存量 warning 与主干一致）通过
- 版本：package.json / tauri.conf.json / Cargo.toml / Cargo.lock → 3.6.3

## 3.6.1 (2026-08-16)

3.6.0 发布后的热修复：源码模式批注跳转、CSP 收紧、移除浏览器调试残留。

### 功能正确性

- **sv 模式批注跳转修复**：点击批注列表/大纲跳转时，隐藏的 Milkdown DOM 仍在文档里——`querySelector` 能找到其 marker（无布局盒），`scrollIntoView` 空转、popover 弹到屏幕左上角。现在 sv 模式改走源码面（`jumpToSourceLine`）滚动到行内 `[^id]` 引用所在行（新增 `lib/annotations.ts` 的 `findAnnotationRefLine`，排除 `[^id]:` 定义行，CRLF 兼容，含测试）

### 安全

- **CSP 收紧**：`index.html` 的 `script-src` 移除 `'unsafe-inline'`（与 tauri.conf.json 一致，全仓库无内联脚本/无 eval）
- **移除浏览器调试残留**：删掉 index.html 里的 TEMP-DEBUG Tauri API mock（仅手动测试用，无真实权限模拟价值且扩大攻击面）

### 工程

- 新增测试 5 个（`codeAnno.test.ts` 的 `findAnnotationRefLine` 用例），全套 **83 个通过**；tsc / eslint（0 error）通过
- 版本：package.json / tauri.conf.json / Cargo.toml / Cargo.lock → 3.6.1

## 3.6.0 (2026-08-16)

V3.6 文档管理与编辑体验大版本：多标签页、跨文件搜索、文件拖放、源码模式 CodeMirror 化、格式工具补全、打字机模式、选区字数、导出质量（图片内联/降采样）、从模板新建。

### 一、多标签页

- 一次可打开任意多个文档，标签栏在 ≥2 个标签时出现（单文档形态与旧版完全一致，不占空间）：图标 + 文件名 + 关闭键，未保存显示圆点（hover 变 ×，浏览器惯例），中键关闭，溢出横向滚动
- 快捷键：**Ctrl+Tab / Ctrl+Shift+Tab** 轮换标签、**Ctrl+W** 关闭当前标签
- 只有活动标签住在编辑器里；切走时快照 live 内容进标签记录 —— **未命名的脏缓冲随标签往返保留**；有路径的标签切走前静默自动保存（与 autosave 同一哲学：落盘优于弹窗），未命名脏标签关闭前确认
- 切回干净标签时**重读磁盘**（捕捉外部修改），脏标签恢复内存快照；重复打开同一文件 = 激活既有标签（路径按 Windows 大小写不敏感归一匹配），不再重复占位
- 「新建」不再打断当前文档（新开标签，无需确认丢字）；外部打开（双击 .md / 命令行参数）同样进新标签，旧的「未保存确认」随之移除
- 文件树删除/重命名同步标签：删掉的文件标签自动关闭（活动标签被删则落到相邻标签），重命名更新标签路径与名称；另存为后标签名跟随新路径
- 首个文件打开时原位替换空白未命名标签，不凭空多出一个标签

### 二、文件拖放

- 把 .md/.markdown/.mdx/.mdown 文件**拖进窗口**即在新标签页打开（多文件逐个打开）；拖拽期间显示虚线高亮提示层
- 走 Tauri 原生 drag-drop 事件拿绝对路径（webview 默认启用 dragDropEnabled，HTML5 drop 反而收不到）

### 三、跨文件搜索（在工作区中搜索）

- 侧边栏新「搜索」标签页 + **Ctrl+Shift+F**：在工作区递归扫描全部 Markdown 文件，按行匹配（可区分大小写），按文件分组展示命中（行号 + 内容），点击**打开文件并跳到命中处**（sv 按行号、富文本按整行内容定位）
- 输入 300ms 防抖自动搜索；统计条显示「N 处命中 · M 个文件 · 扫描 K 个文件」
- 边界（`lib/workspaceSearch.ts`，含测试）：跳过 `.`-隐藏/node_modules/dist/target/out/build 与「从工作区移除」项；最多 500 文件、单文件 >2MB 跳过、每文件 50 处、全局 2000 处命中，超限提示截断

### 四、源码模式 CodeMirror 化

- sv 模式从裸 `<textarea>` 升级为 **CodeMirror 6**：Markdown 语法高亮（标题/强调/删除线/行内代码/链接/引用/围栏元信息各按主题配色，复用 `--tok-*` 变量，五个主题下与代码块高亮同源同色）、**行号**、**代码折叠**（foldGutter）、**活动行高亮**、软换行、占位符、原生撤销栈
- 架构：`lib/svCodeMirror.ts` 导出一个「textarea 形状」的适配器（value / 可写 selectionStart/End / setSelectionRange / focus / 单事务 undoableReplace），`useMilkdown` 全部 sv 分支经适配器读写 —— **既有行为（AI 写回一步撤销、批注锚定、大纲跳转、Tab 缩进、Ctrl+B/高光包裹）原样保留**；CM 创建失败自动回退旧 textarea
- 文件载入 / 进入 sv 用 `setState` 整体重置（清撤销历史，对齐 replaceAll flush 语义）；AI 写回经单事务 dispatch，CM 的 Ctrl+Z 恰好退一步，对齐富文本的 closeHistory 契约
- 打字机模式在 sv 下由 CM 的 `scrollIntoView(center)` 实现；Ctrl+F 查找、选区工具栏、拼写检查、选区字数统计均覆盖 CM 表面

### 五、格式与插入能力补全

- **格式菜单**从 2 项扩到 8 项：加粗 / 斜体 / 删除线 / 行内代码 / 高光 + 插入链接… / 插入图片… / 插入脚注（macOS 原生菜单同步）
- 浮动选区工具栏新增 **斜体 I / 删除线 S / 行内代码 { }** 按钮（带激活态回显，富文本读 mark/节点，源码模式读包裹定界符）
- **插入链接**：迷你弹窗（显示文字预填当前选区 + 地址），选区文字自动成为链接文字，方括号自动转义；两种模式均可用
- **插入图片**：文件选择 → 按既有规则持久化到 `assets/` → 在光标处插入可移植引用（文件名作 alt）
- **插入脚注**：光标处插入 `[^fn-N]`（与批注的 `anno-N` 命名空间隔离）并在文末追加空定义；落在代码块内时自动移出到围栏外（复用批注的锚定规则）

### 六、打字机模式与选区字数

- **打字机模式**（视图菜单 + 设置开关）：光标行始终保持在视口中部 —— 富文本经选区矩形 + 半行高死区平滑滚动（rAF 合并，无抖动），源码模式由 CodeMirror 居中滚动
- **选区字数统计**：状态栏显示「已选 N 字」（150ms 防抖、自包含监听，打字路径零开销），两种模式均生效

### 七、导出质量

- **HTML 导出可选内联图片**：导出前二选一（内联图片 / 保留引用）—— 本地图片读盘转 base64 data URL，生成单文件自包含 HTML（单图 ≤10MB、总量 ≤64MB 预算，超限自动保留引用）
- **DOCX 导出图片修复**：转换前先把本地图片内联为 data URL —— 浏览器构建无 sharp，此前相对引用的图片被转换器静默丢弃（V3.5 已知 TODO），现在文本格式与图片都能进 docx
- **PNG 导出不再硬拒绝**：超过 120MP 画布预算时按 0.01 步进**分数降采样**（最低 0.2），拿到缩小但完整的整页图；只有连 0.2 都放不下（单边 >16k×5）才报错

### 八、从模板新建

- 文件 → 从模板新建…：内置 5 个模板（空白 / 会议纪要 / 周报 / 阅读笔记 / 技术文档），`{date}` 占位自动替换为当天，选择即在新标签页创建

### 工程

- 新增测试 7 个（`lib/workspaceSearch.test.ts`），全套 **78 个通过**；tsc / eslint（0 error，警告数较 3.5.5 下降）通过
- 显式化直接依赖 `@codemirror/state / view / commands / lang-markdown`（此前为 Crepe 代码块功能的传递依赖，与 `@codemirror/language` 同批）
- Rust 菜单 id 与前端菜单栏保持镜像同步（新增 10 个 id；非 Windows 平台菜单同步）
- 版本：package.json / tauri.conf.json / Cargo.toml → 3.6.0

### 已知边界（沿袭或有意不改）

- PDF 静默导出仍受 wry#707 限制，走系统打印对话框
- 表格列对齐（`|:---|`）写入受 Milkdown 表格 schema 限制（不携带对齐 attr），未在本版强行模拟
- i18n / 键位自定义 / 插件系统 / 版本历史 / 拼写词典管理未包含在本版

## 3.5.5 (2026-08-15)

V3.5 AI 协作四件套：对 AI 回答追问（多层线程）、代码行级批注、改动预览与逐处接受/拒绝、AI 写回一步撤销。

### 一、对 AI 回答追问（多层线程）

- 每条 AI 回答新增「追问」按钮：点击在该回答正下方展开行内输入框，Enter 发送、Esc 取消
- 追问与它的回答以层级线程挂在原回答下方（缩进 + 连接线 + 「追问」标签），**可连续追问多层**，同一回答可挂多条并行追问；虚拟列表按 DFS 展开渲染，消息数组保持追加序（流式更新仍只碰末尾）
- 追问的请求历史是该线程的链路（`lib/aiThread.ts`，含测试）：沿 parentId×repliedUser 回溯到线程根，只携带这条线上的问答对 + 新问题，不掺入其它对话；MAX_MESSAGES 截断掉的祖先优雅降级（链从最近存在的祖先开始）
- 追问继承被追问回答的选区上下文（选区模式的追问仍针对同一选区）；追问产生的回答与普通回答完全同权：支持插入 / 审查替换 / 批注 / 复制 / 继续追问
- 流式期间自动跟随滚动到「正在输出的那一行」（可能是缩进线程里的回答而非列表底部，仅在用户贴近底部时跟随）

### 二、代码行级批注

- 锚定在**代码块内选区**上的批注（AI「批注」或选区工具栏）现在精确到块内的一行或几行：`Editor.addAnnotation` 在写入前捕获 `{起始行, 结束行, 首行内容指纹}`（富文本走 ProseMirror code_block 解析，源码模式走围栏扫描，`useMilkdown.getCodeAnchorAt`）
- 行锚持久化在批注定义开头的 HTML 注释元数据里（`[^anno-7]: <!--md:line 2-3 …-->批注内容`，`lib/codeAnno.ts`，含测试）：`parseAnnotations` 解析后剥离（ popover / 列表只见干净正文），`updateAnnotationInMd` 在批注编辑/流式精炼时保留元数据；往返若丢失注释仅降级回块级批注，不损坏内容
- 打开批注时按**当前文档内容重新解析行位**并高亮对应代码行（CodeMirror 的 `.cm-line` 逐行高亮；大文档降级时整块 `<pre>` 高亮），popover 紧贴第一个高亮行显示；批注列表与 popover 标题显示「代码 第 X–Y 行」
- **内容跟随**：代码被改动后按首行内容指纹在块内（及邻近块）重找锚定行——行上方插入行会正确下移，行内容移动会跟着内容走；行内容彻底消失时回退块级锚定（不指错行）
- 关闭 popover / 切换批注时清除行高亮

### 三、改动预览与逐处接受/拒绝

- AI 的**修改类写回**（润色、改写、纠错等「替换全文/替换选区」）不再直接替换文档：点击后进入「改动预览」视图（`lib/diff.ts` 行级 LCS diff + `DiffReview` 组件），逐处展示「原内容（红）→ 新内容（绿）」对照，单行对单行的改动附带字符级强调（`charDiffRange`）
- 每处可单独**接受 / 拒绝**，也可**全部接受 / 全部拒绝**；统计条实时显示「共 N 处 · 已接受 M 处」，底部「应用 M 处改动」一次性合并写回
- 点击某处改动卡片**跳回编辑器原文位置**查看上下文（`revealText`，选区/纯文本两模式）
- diff 算法：先裁剪公共前后缀行再对差异内部做 LCS（超预算退化为单一大 hunk），CRLF 归一；整体被 ``` 围栏包裹的回复自动去围栏（`unwrapWholeFence`）避免假差异
- 应用时选区模式先校验捕获区间仍持有原文，失效则按内容在文档中回退定位（`findTextRange`），仍找不到才提示重新选中
- 「插入到光标 / 插入到选区下方」等**不修改既有内容**的操作与解释、问答类回答不受影响，仍直接可用

### 四、AI 写回一步撤销

- AI 的**任何一次写回都恰好是一个撤销步骤**（包括一次接受的很多处改动）：富文本模式每个写回都是带 `closeHistory` 标记的单事务（强制开启新撤销组，绝不与用户此前的输入合并）；源码模式经 select-all/range + `execCommand("insertText")` 写入，textarea 原生撤销把整次写回当作一步
- 新增 facade 写入原语（`useMilkdown`）：`aiWriteDoc` / `aiWriteRange` / `aiWriteInsert` / `aiWriteFinalize`；插入、审查应用、批注创建等全部改走这些原语，并停止此前「写回即清空撤销历史」的行为（`replaceAll(md, true)` 仅保留给文件载入）
- 批注流式精炼的收尾（`Editor.finalizeAnnotation` + `App.onAnnotateReply`）：先无痕恢复 baseline（不记入历史），再把最终内容作为唯一被记录的事务写入——无论流式期间产生过多少帧，**按一次 Ctrl+Z 即完全回到点「批注」之前**；流式期间定义被删除时不动文档（避免卷回其他编辑）

### 工程

- 新增测试 44 个（`diff.test.ts` / `aiThread.test.ts` / `codeAnno.test.ts`），全套 71 个通过；tsc / eslint（0 error）通过
- `anchorSearch` 抽出共享文档展平器并新增 `findAnchorRange`（返回可替换的 [from,to] 区间）
- AI 面板移除未使用的 `getSelection` 透传；`确认替换全文` 对话框被改动预览取代

## 3.5.1 (2026-08-15)

3.5.0 发布后的热修复与外观打磨：注解锚点定位重构、编辑器代码高亮按主题渲染、远程图片 URL 粘贴落盘。

### 功能正确性

- **注解锚点定位重构**（新增 `lib/anchorSearch.ts`，含测试）：旧逻辑对 DOM 选区文本与 ProseMirror 文档做逐字 `===` 比对且只在单个文本节点内查找——跨段落/跨行内标记的选区必然失配，标记被追加到文档尾部；重复措辞时还总是锚到最早（错误）的一处。现在两侧统一按空白折叠后比对，全文按「字符→PM 位置」映射展平后搜索，任意位置（跨段落、跨 hard_break、跨标记边界）都能映射回精确插入点；捕获选区（即使已被编辑改旧）作为消歧提示，重复措辞取距其最近的一处；无匹配时回退到选区位置，再退到光标处
- **右键菜单边界定位**：右键落在 `.ProseMirror` padding（页首/页末 40vh、左右 gutter）时 `posAtCoords` 落空导致菜单无法弹出——按纵向位置回退到文档首/末；解析到 doc 顶层（depth 0）时用 `TextSelection.near` 规范进最近文本块
- **大纲跳转遮挡修复**：标题加 `scroll-margin-top: 48px`，跳转不再被 sticky 工具栏（~41px）遮住

### 外观（代码高亮按主题渲染）

- **编辑器 CodeMirror 注册 `classHighlighter`**（非 fallback，优先级更高）：basicSetup 自带的 `defaultHighlightStyle` 用 style-mod 注入与主题无关的硬编码浅色，且类名运行时随机、外层 CSS 无法接管。现在 token 输出稳定的 `tok-*` 类，颜色交由 global.css 的 `--tok-*` 变量按主题渲染，与静态渲染（hljs-*）同源同色
- **claude / claude-dark 代码配色重做**：7 个色相清晰分离（赭红/橄榄绿/梅紫/青绿/琥珀金/岩蓝/暖灰），数字独立于关键字取梅紫，注释/标点/元信息为弱化层；正文类 token 对各自 `--code-bg` 达 WCAG AA（≥4.5:1）
- 补充 token 映射：`tok-url/inserted/deleted/literal/labelName/className/macroName/invalid` 等归位；定义位复合类（`tok-variableName.tok-definition` 等）显式固定（变量定义名取函数色、属性定义名保持属性色）

### 功能

- **远程图片 URL 粘贴下载落盘**（Typora 行为）：wysiwyg 模式下粘贴纯文本恰好是远程图片 URL 时，经 Rust `fetch_image` 下载并落盘到 `assets/`，插入本地引用；下载失败退回插入原始 URL。文件/图片粘贴不受影响（仍走 ImageBlock onUpload）；sv 模式保留原生粘贴

### 工程

- 显式化直接依赖 `@codemirror/language`、`@lezer/highlight`（此前为间接传递依赖）

## 3.5.0 (2026-08-15)

全面优化版本：功能正确性修复、编辑器热路径性能、安全收窄、工程清理。基于 60 项深度审计（功能/性能/安全/工程四类）系统性落地。

### 功能正确性

- **文件树重命名修复**：重命名目录时 `renaming` 状态不再透传给全部后代（此前 200 个子文件会同时挂起 200 个 autoFocus 输入框）
- **外部修改监听权限补全**：capability 增加 `fs:allow-watch(-recursive)/unwatch`——此前 `fs:default` 不含 watch 权限，监听被拒后被静默吞掉，外部修改检测可能从未生效
- **Windows 路径比较**：文件树统一大小写不敏感比较 + 分隔符边界（`C:\a` 不再误匹配 `C:\ab`；dialog/watcher 大小写漂移不再丢失高亮与祖先展开）
- **保存判定精确化**：`isSaving` 标志随写入完成即时复位（不再固定 600ms），外部真修改不会被自己的写事件误吞
- **图片粘贴防撞名**：`时间戳+自增计数+UUID 片段`，同毫秒多图不再覆盖丢数据
- **内存守护 recheck 定时器**：可清理、带 cancelled 标记，卸载/禁用后不再可能触发 reload
- **设置更新竞态**：`useSettings.update` 支持函数式补丁，连续快速更新不再丢补丁；「从工作区移除」同步迁移
- **设置弹窗草稿**：仅在打开时同步一次，外部改动（AI 面板切模型）不再覆盖编辑中的草稿；「测试连接」不再顺手持久化草稿
- **另存为建议文件名**：清洗 Windows 非法字符（`<>:"/\|?*` 及控制字符、尾部点/空格）
- **大纲 slug 缓存**：超限逐条淘汰最旧而非整体清空（超大文档不再反复全清重建）
- **拖拽分隔条**：补 `pointercancel` 清理，触摸中断不再残留 document 监听器
- **导出 PNG 防护**：画布尺寸/像素预算门控，超大文档自动降 scale，避免 OOM；导出打印定时器句柄可清理

### 性能（编辑器热路径）

- **Editor 包裹 `React.memo`**：打字期间 App 每帧重渲染不再 reconcile 整个 Milkdown 子树（单点最大收益）
- **heading 提取合并**：每键 2 次 O(文档) 全树遍历 → 微任务合并至多 1 次 + 文档引用未变跳过
- **大文档加载单次解析**：big-doc 阈值翻转时不再"先 replaceAll 再重建 seed"双解析
- **sv 模式 getHTML 签名缓存**：导出/复制富文本重复调用不再每次全量 parse+serialize（也不清空 undo 栈）
- **模式切换空转跳过**：重选当前模式不再整篇 getMarkdown 序列化
- **sv 输入防抖**：textarea 每键通知防抖 200ms（镜像 ref 即时，保存/切模式不受影响）
- **Ctrl+S 冗余写消除**：`pushRecent` 已在首位时跳过 + 最近列表会话内缓存（每次保存少 2-3 次 IPC 与全量序列化）
- **字数统计单遍化**：`lib/textStats.ts` 零分配单遍计数替代双正则大数组 + 整篇拷贝（含测试）
- **文件树**：多选改为稳定布尔 + 访问器（不再整 Set 拷贝打穿全部行 memo）；目录刷新未变化时复用 Map 引用；↻ 刷新并行化 + 取消令牌；超大目录分块挂载（每 300 项「显示更多」）
- **搜索防抖**（SearchBar 200ms）、**选区工具栏 document 级监听**（内存守护重建后不再失效）、**AI 面板仅近底部自动跟随**、**无注解轮次早退**、**MenuBar 菜单结构 useMemo**、**静态渲染 LRU 字节上限 8MiB**（均含测试/验证）
- **Rust AI 通道**：共享 reqwest Client（复用连接池，fetch_image 同步受益）；SSE 缓冲游标化消除 O(n²)；前端断开即停止拉流；长流不再被 120s 总超时掐断；错误体截断 300 字符（隐私）

### 安全

- **CSP 移除 `unsafe-eval`**（tauri.conf.json + index.html meta 同步，含 font-src 对齐；全仓库无 eval/Function）
- **移除自动更新器**：占位端点永不工作，整体移除插件/依赖/权限/UI 入口（恢复步骤见 README）
- **AI 渲染消毒复核**：确认全部 `dangerouslySetInnerHTML` 路径走 rehype-sanitize 管线，无旁路

### 工程

- **README 重写**（原 0 字节）；新增 CHANGELOG；实施计划归档 `docs/superpowers/plans/`
- **构建**：minify 换 esbuild（等效 drop console，构建提速）；CI 加 `Swatinem/rust-cache`；打包目标收敛为 NSIS
- **严格化**：`noUnusedLocals/noUnusedParameters` 开启并清理暴露死代码
- **依赖清理**：移除未使用的直接依赖 `tokio`（Rust）与 `@tauri-apps/plugin-updater`（npm）
- **颜色 span 正则统一**：`lib/colorSpan.ts` 单一来源（编辑器/remark 往返不再漂移）
- 清理泄漏调试残留（根目录 HeapSnapshot、探针体系于 3.4.x 已移除）

### 评估后有意不改（附理由）

- `dispatchMenu` 保持 switch：已是单一来源 + 稳定引用，表驱动无行为收益
- `useImperativeHandle` 依赖 `[handle]`：重建仅赋值 ref.current，不会触发父级重渲染，重写 40 方法风险大于收益
- `execCommand`/`window.find`（3 处）：WebView2 下可用且已有回退结构，替换收益低风险高
- App.tsx 拆分 hooks：现有结构已按稳定引用组织，机械拆分回归风险大于维护收益
