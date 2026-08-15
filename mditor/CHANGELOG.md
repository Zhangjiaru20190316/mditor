# Changelog

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
