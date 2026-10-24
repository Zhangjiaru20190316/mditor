# 提示词与任务书：mditor 可交互 HTML 笔记（导入 / 隔离渲染 / 文件库整合）

> 用法：将本文件全文作为任务提示词投喂给编码 agent（如 ZCode / Claude Code），在 `mditor/` 项目根目录下执行。

---

## 一、角色与任务

你是 **mditor**（Tauri 2 + React 18 + Milkdown 7 + Vite 5，Windows/WebView2 优先，harmony 为第二平台）**文件库与内容接入模块的负责人**。本任务实现"**可交互 HTML 笔记**"：用户把 HTML 文件（单文件或带资源文件夹）导入文件库，点击即在应用内打开，**笔记自带的 CSS/JS 交互完整生效**（折叠、选项卡、脚本驱动的组件、交互图表），同时笔记内容与主应用完全隔离。

三条设计铁律，先记住再动手：

1. **交互优先**：HTML 笔记**不做任何内容转换或消毒**（转 Markdown 会杀死交互，消毒会杀死脚本）。隔离即防御——脚本可以跑，但跑在碰不到主窗 DOM、storage、IPC、文件系统的独立 origin 里。
2. **独立文档渲染**：`srcdoc:` / `blob:` / `data:` 形式的 iframe 会**继承主窗口 CSP**（`tauri.conf.json:28` 的 `script-src 'self'`），笔记内联脚本必死。唯一可行路径是 iframe 加载**自定义协议 URL**（`convertFileSrc`，即 `asset:` / harmony 的 `mditor-asset:`）——独立 origin、不继承 CSP。
3. **md 是 md，html 是 html**：HTML 笔记是只读视图对象，不进 Milkdown/ProseMirror、不进双链/闪卡/批注/RAG、不进 md 导出链路。两套体系在文件库层面汇合，之下互不渗透。

分阶段交付（阶段 0 是闸门，结论决定后续路线），验收标准见第四节。

## 二、现状与文件地图（已探明，无需重复探查，直接引用）

**asset 协议与路径授权（现成，直接复用）**

- 前端入口：`getAdapter().app.convertFileSrc(path)` —— 接口 `src/platform/types.ts:178`；Tauri 实现 `src/platform/tauri/app.ts:64`（包装 `@tauri-apps/api/core` 的 convertFileSrc，Windows 上产出 `http://asset.localhost/<path>`）；harmony 实现 `src/platform/harmony/index.ts:200`（`mditor-asset://<path>`）。
- 路径授权：`src-tauri/src/commands.rs:240-263` 已有命令同时授权 fs scope 与 **asset_protocol_scope**（`allow_file` / `allow_directory(recursive)`，注释明言"笔记图片走 asset:// 显示"）。打开 workspace 时已对 vault 根目录授权——**vault 内的 HTML 笔记文件天然可经 asset 协议访问**，相对资源（同目录子文件）大概率随目录授权一并覆盖，阶段 0 实测确认。
- 关键机制（本方案的地基）：iframe 文档自身的 URL 是 asset 协议 URL，浏览器按标准 URL 解析规则解析文档内的**相对引用**——`<img src="img/x.png">` 自动解析为同级路径的 asset URL。**无需重写用户 HTML**。Windows 盘符编码（`%3A`）等细节需 spike 实测。

**CSP（必须改一处）**

- `src-tauri/tauri.conf.json:28`：现值 `default-src 'self'; img-src …; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src …; font-src …`。**没有 frame-src** → 回退 `default-src 'self'`，iframe 加载 asset 协议会被拦。需新增 `frame-src asset: http://asset.localhost mditor-asset:`。
- 同步更新断言：`src/lib/tauriCspConfig.test.ts`。

**文件库与标签页（接入点）**

- 索引扫描：`src/lib/vaultIndex.ts` —— 目录遍历走平台适配层 `readDir`（:250 接口 / :261 实现），扩展名过滤 `MD_EXTS`（:275，`.md/.markdown/.mdx/.mdown`）在 :428 与 :514 两处收集 md 文件。HTML 笔记需新增 `HTML_EXTS`（`.html/.htm`）平行收集，**不进 md 的标题/双链/标签解析**。
- 文件树 UI：`src/components/FileTree.tsx`。
- 标签页模型：`src/types.ts:519` `TabItem { key, path, name, dirty, content }`。扩展点：给 TabItem 加 `kind: "md" | "html"`（或等价判别），html 标签 `dirty` 恒 false、`content` 恒空。App.tsx 的编辑区分发按 kind 渲染 Editor 或新的 HtmlNoteView。
- 打开/保存流程：`src/lib/fileOps.ts` 与 `src/hooks/useFile` 是 **md 专用**（dirty 追踪/增量序列化），HTML 笔记必须整条绕开——不得触发保存、不得进 docCache/parsePipeline。
- 菜单/命令分发：`src/hooks/useMenuCommands.ts`（`persistImage` 导入图片是现成的"导入外部文件入 vault"先例，:22 引用处起）。

**多窗口基建（阶段 2 复用）**

- `src/lib/multiWindow.ts`：与 Rust 侧 `create_doc_window` 对齐的契约（URL 只带 `path`/`handoff` 短参数，载荷走 Rust stash；label `doc-{n}`）。**harmony MVP `capabilities.multiWindow=false`** → 调用抛 UnsupportedError，调用点必须能力守卫（既有模式照抄）。

**搜索与快照（阶段 2/3 相关）**

- 搜索：`src/lib/workspaceSearch.ts`（md 全文）；HTML 笔记索引用 `DOMParser` 抽 `textContent` + `<h1>-<h6>` 抽大纲，纯主线程、jsdom 可测。
- 快照导出（阶段 3，注意已知约束）：`modern-screenshot`（已在依赖）走 SVG foreignObject，**跨 origin iframe 内容不可捕获**——asset 协议 iframe 与主窗不同源。见第七节 Plan B。

**对照先例（勿混用的两套 HTML 策略）**

- `src/lib/renderMarkdown.ts:145-188`：静态表面（AI 面板/批注）的 raw HTML 是 **rehype-raw + rehype-sanitize 白名单** + style 只留 color/background-color（:85）。这是"内容要进主 DOM"的策略。**HTML 笔记 iframe 路线不消毒**；但任何 HTML 笔记内容一旦要进主 DOM（搜索摘要、转 md 预览），必须走这套现有白名单。
- `src/lib/exportSanitize.ts`：导出兜底 deny-list，同为"进主 DOM/导出文档"策略。

**测试环境**：vitest + jsdom。**jsdom 跑不了真 iframe 脚本执行**——纯逻辑（扩展名/URL/TabItem 分支/索引抽取）写 vitest，渲染与脚本行为靠阶段 0 spike 实测 + 手动回归清单固化。

## 三、需求分级（按 L3 设计，L1/L2 自然覆盖）

| 级别 | 形态 | 本方案覆盖方式 |
|---|---|---|
| L1 | 纯 CSS 交互（details/hover/复选框） | iframe 内天然生效 |
| L2 | 笔记自带 JS（选项卡/折叠/目录跳转） | iframe 独立 origin，脚本可运行 |
| L3 | 完整单文件应用（交互图表/CDN 依赖） | 同上；外链 https 资源默认放行（iframe 文档无 CSP，不做拦截；"离线模式"留作后续设置项，本期不做） |

## 四、验收标准（逐条自查，全部满足才算完成）

1. **导入**：菜单 + 拖拽两种入口；支持单文件 HTML 与「.html + 伴随资源文件夹」两种形态；导入 = **拷贝**进 vault（原文件不动）；导入后文件树可见，图标与 md 笔记明确区分。
2. **交互完整**：打开官方测试页 `public/html-note-demo/`（阶段 0 产出，含：内联 script 计数按钮、`<details>` 折叠、JS 选项卡、相对路径图片、外链 CDN 组件）——全部功能在应用内 iframe 中生效，相对路径资源正常加载。
3. **隔离反证**：测试页内置断言脚本：`window.__TAURI__` 为 undefined、无法访问父窗（`window.parent` 跨源异常）、`fetch ipc:` 不可达。断言结果在 spike 报告中固化，并在测试页 UI 上可见（全绿才验收）。
4. **md 主线零回归**：md 笔记的打开/编辑/保存/导出（HTML/PDF/DOCX/PNG）、AI 面板、批注、双链、闪卡全量回归通过；现有 vitest 全绿。
5. **稳定性**：连续打开/关闭 10 个 HTML 笔记标签（含 L3 重型页）无内存泄漏迹象（iframe 随标签卸载，DevTools heap 快照对比）；vault 索引扫描耗时不因 HTML 收集回退（对比改造前）。
6. **CSP 与平台**：frame-src 变更有 `tauriCspConfig.test.ts` 断言；Windows 全功能；harmony 按 spike 结论降级且用能力位明示（不得崩溃、不得假成功）。
7. **文档**：spike 报告、`docs/security.md` 增补"HTML 笔记隔离模型"一节、CHANGELOG Unreleased 条目。

## 五、技术方案（分阶段，每阶段一个 commit）

### 阶段 0：Spike 验证（闸门，先行独立提交，不写产品代码）

产出两样东西：测试页 + 报告。

1. 建官方测试页 `public/html-note-demo/index.html`（+ 一张相对路径图片），覆盖第四节第 2/3 条列的全部要素，内置隔离自检面板。
2. 临时验证通道（不进主干 UI）：dev 模式下任选入口把 `convertFileSrc(测试页路径)` 塞进一个 iframe，实测：
   - ① 内联 `<script>` 是否执行（`http://asset.localhost` 下预期：执行）；
   - ② 相对路径子资源是否随文档 URL 解析到 asset URL（含 Windows 盘符编码、`../` 上跳）；
   - ③ 隔离三断言（第四节第 3 条）是否全部成立；
   - ④ harmony：`mditor-asset://` 下重复 ①②③（真机或模拟器；无条件则明确标注"未验证"并在能力位上保守处理）。
3. 结论三选一写入 `docs/html-note-spike-report.md`：**A. iframe 路线成立**（Windows 必须，harmony 尽力）→ 按阶段 1 继续；**B. Windows 成立、harmony 不成立** → harmony 降级（见阶段 1 第 6 步），主线不变；**C. Windows 也不成立** → 停止，产出 Plan B 评估（Rust 侧自定义协议 `mditor-note://` 或独立 WebviewWindow 主路线），报告里给证据。

### 阶段 1：MVP——导入 + 文件库 + 应用内交互预览

1. **导入**：`useMenuCommands` 增"导入 HTML 笔记"（菜单 + 拖拽 .html 到窗口）；对话框选单文件或文件夹；拷贝进 vault（目录布局建议 `vault 根/<原结构>`，避免发明新目录）；完成后刷新 vaultIndex 并在文件树定位。
2. **vaultIndex**：新增 `HTML_EXTS` 与平行收集（:428/:514 两处同改）；HTML 条目只记 path/name/mtime，不做 md 解析。
3. **FileTree**：HTML 条目专属图标（MIME 区分于 md），点击 → 打开 html 标签。
4. **TabItem/编辑区**：`kind` 判别扩展；App.tsx 按 kind 分发渲染；html 标签绕开 useFile/dirty/docCache 全套；关闭即卸载。
5. **HtmlNoteView 组件**（新文件，建议 `src/components/HtmlNoteView.tsx`）：`iframe src = convertFileSrc(notePath)`，sandbox 属性不加 `allow-same-origin`（保留默认同源限制即可，独立 origin 已由协议保证）；加载态/失败态（文件被移动、scope 未授权）；顶栏动作：「独立窗口查看」（阶段 2，先占位隐藏）、「用系统浏览器打开」（`plugin-shell` 现有能力）、「转为 Markdown」（阶段 2，先占位隐藏）。
6. **harmony 降级**（依 spike 结论 B 时）：html 标签打开为"仅外部浏览器打开"的提示页 + 能力位 `capabilities.htmlNoteView` 控制，沿用 multiWindow 的守卫模式。
7. **CSP**：加 `frame-src`；更新 `tauriCspConfig.test.ts`；若发现 vault 根授权不覆盖笔记目录的场景（如笔记在授权根之外），扩展 commands.rs:240 的授权命令调用点。
8. 纯逻辑单测：HTML_EXTS 判定、TabItem kind 分支、vaultIndex HTML 收集（jsdom）、CSP 断言。

### 阶段 2：配套能力

1. **独立窗口查看**：复用 multiWindow 契约新增 `create_html_note_window`（或复用 create_doc_window 加 kind 参数，评估后择一）；harmony 能力守卫。
2. **搜索索引**：DOMParser 抽 textContent（超长阈值跳过，防卡顿）+ `<h1>-<h6>` 大纲；接入 workspaceSearch 结果，摘要经现有 sanitize 白名单再进主 DOM。
3. **转 Markdown 工具**：引入 `turndown`（+ GFM 插件）；对话框预览转换结果（预览经 renderMarkdown 现有管线渲染，天然消毒）；确认后另存为 .md，**原 HTML 笔记不动**。定位为可选工具，不是导入路径。

### 阶段 3（可选增强，本期只做设计占位，不实施）

- 快照导出 PNG/PDF（受跨 origin 限制，见 Plan B）；md 内嵌 html-block（shadow DOM，L1 级）；离线模式设置项。

## 六、硬约束（违反即返工）

1. **不消毒 iframe 内容**，也**绝不**把 HTML 笔记原文注入主文档 DOM/innerHTML——任何进主 DOM 的派生物（搜索摘要、转换预览）必须过 renderMarkdown 的 rehype-sanitize 白名单。
2. **不给笔记 iframe 任何 Tauri capability/IPC 通道**；不引入允许 iframe 调 IPC 的配置；阶段 0 隔离反证必须固化进测试页与报告。
3. **不动 md 主线**：Milkdown 管线、parsePipeline worker 哨兵计数、增量序列化、导出管线一行不改（vaultIndex 只做平行收集）；md 笔记回归全绿是放行前提。
4. **不发明新存储**：HTML 笔记就是 vault 里的普通文件，无数据库、无缓存层、无格式转换（导入拷贝除外）。
5. 遵循仓库习惯：平台差异一律经 `src/platform` 适配层收口；能力位守卫照 multiWindow 模式；中文 commit、每阶段一个 commit + 简报、CHANGELOG 更新、`trash > rm`（导入拷贝不得覆盖同名文件，冲突时提示改名）。
6. 新逻辑优先纯函数 + vitest；渲染/脚本行为以 spike 报告 + 手动回归清单为验收载体，不伪造 jsdom 覆盖。

## 七、交付物

- 每阶段 commit + 简报（改了什么、为什么、怎么验的）。
- `public/html-note-demo/` 官方测试页（含隔离自检面板，长期保留作回归工具）。
- `docs/html-note-spike-report.md`：四项实测结果 + 路线结论。
- `docs/security.md` 增补：HTML 笔记隔离模型（威胁面、防御层次、外链策略决策）。
- CHANGELOG Unreleased 条目。
- 附注 Plan B（**只记录，不实施**）：
  - 若 iframe+asset 路线在 Windows 失败（spike 结论 C）：Rust 侧 `register_uri_scheme_protocol` 注册 `mditor-note://` 专用协议（路径映射到笔记目录，天然相对解析），或独立 WebviewWindow 主路线。
  - 快照导出若要做（阶段 3）：跨 origin iframe 无法用 modern-screenshot 捕获；备选为 Rust 侧 webview2-com `CaptureScreenshot`（仅 Windows）或"JS 渲染型笔记不支持快照"的产品级取舍——触发条件与取舍写进报告即可。

---

**执行顺序**：阶段 0 →（闸门通过）→ 阶段 1 → 阶段 2 →（可选）阶段 3。每阶段结束跑第四节对应条目再提交。开始前先读第二节列出的全部文件；阶段 0 的四项实测没做完，禁止开始阶段 1。
