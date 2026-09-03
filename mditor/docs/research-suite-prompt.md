# 提示词：科研与学习功能包（Mditor 一次性开发任务）

> 用法：将本文整体粘贴给 AI 编程助手（ZCode / Claude Code / TRAE 等），或作为独立任务的入口提示词。
> 范围：五个功能模块一次性交付，无阶段排序；但 commit 仍按依赖顺序逐模块提交（见工作流程）。

---

## 角色

你是资深桌面编辑器工程师，在本仓库（Mditor：Tauri 2 + React 18 + Milkdown/Crepe + ProseMirror 富文本 + CodeMirror 源码模式）上实现一组**科研与学习功能**。用户群体：用 Mditor 做日常笔记、文献阅读笔记、论文写作与复习的科研人员/学生。

## 使命

把 Mditor 从「单文件编辑器」升级为「本地优先的知识工具」：全库索引、双向链接、学术引用、间隔重复闪卡、库级 AI 问答。五个模块共享一个索引地基，全部数据留在本地。

## 铁律（违反任何一条即返工）

1. **本地优先红线**：所有新增持久化数据（索引、闪卡进度、嵌入向量）只存 `appDataDir` 或用户显式选择的路径；无遥测、无上传。嵌入请求仍走 Rust 侧 AI 代理，渲染层不得直连外网（CSP 现状不可放宽）。
2. **安全模型不变**：不新增 shell 执行、不引入外部进程（**明确不做 Pandoc**——LaTeX 导出用纯前端 md→tex 转换）。capabilities 只加实际必需的项。
3. **插件计数哨兵**：每个新增 remark 插件必须同步 worker 管线（`remarkPipeline.ts`）并更新 `parsePipeline.bindEditor` 的 `expectedPluginCount`（小文档 / 大文档两档）与锚定测试。漏同步 = 解析缓存全乱。
4. **大文档性能模式兼容**：`bigDocPerformance` 开启时新功能自动降级（索引扫描让路、反链面板可延迟、闪卡/AI 不阻塞输入）；普通文档（<200KB）不得因新功能变慢。索引全库扫描必须分批 + idle 调度，保存时增量更新而非全量重建。
5. **语法降级**：所有自定义语法（`[[双链]]`、`[@引用]`、闪卡容器）在导出 HTML/PDF/PNG/Word/LaTeX 时必须有降级渲染路径（转为标准链接/纯文本），导出产物离开本工具仍可读。
6. **单点提交**：一个模块内的每个可独立回退的变更一个 commit，带 vitest 测试；功能之间互不拖垮——任一模块异常不得影响核心编辑、保存与导出。
7. **设置默认值**：索引/双链/闪卡默认启用（纯本地无风险）；RAG 默认关闭（消耗 API，需用户显式配置 embedding 模型）。

## 已有底座（先读，避免重复造轮子）

| 关注点 | 文件 |
| --- | --- |
| 工作区遍历与搜索模式 | `src/lib/workspaceSearch.ts`、`src/components/WorkspaceSearch.tsx` |
| remark 插件管线与计数哨兵 | `src/lib/remarkPipeline.ts`、`src/workers/parseWorker.ts`、`src/lib/parsePipeline.ts` |
| 编号管线范式（图表编号照抄此模式） | `src/lib/remarkMathNumbering.ts`、`src/lib/mathNumbering.ts` |
| 导出链路（新增 LaTeX 分支挂这里） | `src/lib/exporter.ts`、`src/lib/exportMath.ts` |
| AI 管线与 Rust 代理（RAG 复用） | `src/lib/ai.ts`、`src/lib/aiThread.ts`、`src/components/AiPanel.tsx` |
| 设置持久化（新开关照此模式） | `src/lib/store.ts`、`src/components/SettingsModal.tsx` |
| UI 挂载点 | `src/components/Outline.tsx`（反链/标签同侧）、`src/components/SelectionToolbar.tsx`（做卡/插引用入口）、`src/components/RecentList.tsx` |
| 最近/频次数据（QuickSwitcher 加权） | `src/lib/activity.ts` |
| fs 访问与外部修改监听 | `src/lib/tauriFs.ts` |
| 性能纪律与已知雷区 | `docs/performance.md`、`docs/perf-optimization-prompt.md` |

## 模块 1：全库索引 + 快速切换器（地基，最先提交）

**需求**：扫描 workspace 全部 `.md`，维护轻量索引；Ctrl+P 模糊跳转。

- 索引条目：`{ path, title（首个 H1 或文件名）, headings[], links[], tags[], mtime }`。
- 解析用**轻量行扫描**（正则抽标题/`[[链接]]`/`#tag`），不走完整 remark——全库 remark 解析成本不可接受。放独立 idle 任务或新 worker，分批（每批 ≤50 文件），进度可视。
- 增量更新：外部修改监听（已有）+ 自身保存事件触发单文件重扫。
- **QuickSwitcher**：Ctrl+P 唤起浮层，模糊匹配文件名+标题，按 activity.ts 的频次/最近数据加权排序，回车打开；Esc 关闭；支持 `>` 前缀预留命令面板语义（本期只实现跳转）。
- 新文件：`src/lib/vaultIndex.ts`、`src/components/QuickSwitcher.tsx`。

**验收**：1000+ 文件库首次索引不冻结 UI；改一个文件 3s 内索引更新；Ctrl+P 输入即出结果（<50ms）。

## 模块 2：双向链接 + 反链面板 + 标签

**需求**：`[[目标]]` / `[[目标|显示文本]]` 双链语法，点击跳转、输入补全、反链面板、标签过滤。

- remark 插件 `remarkWikiLink`（新文件）：识别 `[[...]]`，AST 节点 `wikiLink`；序列化回写保留 `[[...]]` 原文（本地闭环）；**导出时降级**为标准相对链接，未解析目标降级为纯文本+样式提示。
- ProseMirror 侧：inline node `wikiLink`，点击跳转（复用现有链接跳转/anchorSearch 逻辑）；输入 `[[` 触发补全弹层（数据来自 vaultIndex，支持 `|` 显示名）。
- 目标解析规则：按文件名（去扩展名）匹配；重名时按路径消歧并提示选择。
- **反链面板**：Outline 同侧新增 tab，列出引用当前文档的所有来源 + 上下文片段（前后各 1 行）；数据来自索引，编辑保存后增量刷新。
- **标签**：行内 `#tag`（仅非行首位置识别，避免与标题冲突，参照 Obsidian 规则）；标签面板列出全库标签+计数，点击过滤出笔记列表。
- 铁律联动：插件计数哨兵同步（见铁律 3）；big 模式下反链面板允许延迟加载。

**验收**：`[[` 补全 <100ms 出列表；反链面板 100 来源文档场景刷新 <200ms；导出 HTML 无 `[[` 残留；`npm test` 全绿含新锚定测试。

## 模块 3：学术引用链 + LaTeX 导出

**需求**：`.bib` 文献库导入、`[@citekey]` 行内引用、文末参考文献表自动生成、图表编号交叉引用、纯前端 LaTeX 导出。

- **bib 解析**：设置中添加 bibliography 文件路径（fs scope 已支持 `**`）；自研轻量 BibTeX 解析器（覆盖常用 entry type 与 field 即可：article/inproceedings/book/misc + author/title/year/journal/booktitle/volume/pages/publisher/doi/url）。可评估引入 citation-js，但注意体积与 CSP——倾向自研。
- **行内引用**：`[@citekey]` 与 `[@citekey, p. 12]`；remark 插件解析；选区工具栏新增「插入引用」打开引用选择器（按 title/author/citekey 搜索 bib 条目）。
- **参考文献表**：文档末尾显式标记处（`# References` / `# 参考文献` 标题下）自动生成；两种样式：numeric `[1]` 与 author-year（APA）。渲染在编辑器内直接可见（复用 renderMarkdown 管线）。
- **图表编号**：图片/表格 caption（`![caption](x.png)`、表格前后 `: caption` 语法或脚注式标注——执行时定一种并写入 docs）+ `@fig:id` / `@tbl:id` 引用渲染为「图 3」「表 2」；编号管线照抄 `remarkMathNumbering` 模式，编号在导出与 AI 面板生效。
- **LaTeX 导出**：exporter 新增分支，md→tex 纯前端转换：公式天然平移（KaTeX 源即 LaTeX）、`[@key]`→`\cite{key}`、文末拼 `thebibliography` 环境、表格→`tabular`（简单表格直转，复杂表格降级为 verbatim 或保留截图式渲染）。**不调 pandoc、不加 shell 权限**。
- 依赖模块 1（引用选择器检索）。

**验收**：导入真实 Zotero Better BibTeX 导出的 .bib（≥200 条目）解析全通过（容错：坏条目跳过并告警，不中断）；引用渲染/编号与导出三处一致；LaTeX 产物在 Overleaf 编译通过（用含公式+表格+引用的样例文档验证）。

## 模块 4：间隔重复闪卡

**需求**：笔记内定义卡片，应用内复习，SM-2 简化调度，AI 一键做卡。

- **卡片语法**：容器式定义，两种候选由执行时评估定一（写入 docs）：remark directive 容器 `:::flash\n问题\n---\答案\n:::`，或自定义 fence ` ```flash `。渲染为编辑器内卡片样式块。
- **做卡入口**：选中文字 → SelectionToolbar「做成闪卡」（问题/答案预填，可调）；AiPanel 选区动作新增「改写为问答卡」（AI 生成 Q/A，人工确认后插入）。
- **复习模式**：命令面板/菜单进入，侧栏或全屏逐卡出题 → 点击翻面 → 自评四档（忘了/困难/良好/轻松）。
- **调度**：SM-2 简化版——间隔表 `[0, 1, 3, 7, 14, 30]` 天 × ease 因子（2.5 起，档位微调 ±0.15，下限 1.3）；到期卡片按「今天应复习数」展示。
- **进度存储**：`appDataDir/review-state.json`（卡片定位用 文件路径+内容哈希，文件改动后哈希失配的卡标记「需重定位」提示）。
- 依赖模块 1（到期扫描遍历索引）。

**验收**：做卡→复习→自评→次日到期完整闭环手测通过；进度文件损坏时静默重建不崩；导出时闪卡块降级为普通引用块。

## 模块 5：库级 AI 问答（RAG）

**需求**：对全库笔记提问，回答附来源笔记列表。默认关闭。

- **嵌入**：走现有 Rust AI 代理，OpenAI 兼容 `/embeddings` 端点；设置新增 embedding 模型配置项（独立于对话模型）。
- **索引**：基于 vaultIndex 全文按标题段落分块（~500 token/块，重叠 1 句），嵌入向量存 `appDataDir/rag-index.json`（带文档指纹增量更新）；索引构建后台分批，可暂停/续跑，进度可见。
- **问答**：AiPanel 新增「全库问答」模式——问题→嵌入→余弦 top-k（k=8）→拼上下文经代理流式回答→回答下方列「来源：文件名 > 标题」可点击跳转。
- **成本提示**：首次启用时明示「将调用嵌入 API 处理 N 个文档」，用户确认后才开始。
- 铁律联动：默认关；不阻塞任何交互；失败静默回退为普通对话模式。

**验收**：含 200+ 笔记的库构建索引可暂停续跑；问答回答的来源可点击直达对应笔记对应标题；全程无渲染层直连外网（复核 CSP）。

## 工作流程

1. 通读「已有底座」全部文件与 `docs/performance.md`，再动手。
2. commit 顺序按依赖：**模块 1 → 模块 2 → 模块 3 / 4（可并行）→ 模块 5**。每个模块：实现 → vitest → 手测清单 → 独立 commit。
3. 每完成一个模块：跑全量 `npm test` + `npm run lint`（注意历史预存 lint 基线，勿混淆新引入错误）；更新 CHANGELOG 与 README 功能列表。
4. 全部完成后：更新 `docs/` 新增 `research-features.md` 记录语法规范（双链/引用/闪卡/图表编号的最终形态）与设置说明；打包一个 beta 版本号。

## 交付物

- 五个模块的完整实现 + 设置开关（SettingsModal 新分组「知识功能」）。
- vitest 测试：索引增量、双链解析/降级导出、bib 解析容错、引用编号一致性、闪卡调度、RAG 分块与检索纯函数（嵌入调用 mock）。
- `docs/research-features.md` 语法与设置文档；CHANGELOG 更新。
- 样例验收文档一份（含双链、引用、公式、表格、闪卡的 demo.md，用于手测与导出验证）。
