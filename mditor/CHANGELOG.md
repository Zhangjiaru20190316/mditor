# Changelog

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
