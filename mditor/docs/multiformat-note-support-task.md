# 多格式笔记支持（PDF / Word）开发任务书

- **状态**：开发完成（M1–M4 代码全量落地，2026-10-31）——自动化验证全绿
  （vitest 1257 用例零回归 / `npm run build` / `npm run build:harmony` /
  `cargo check` / tsc / eslint；三库均为懒 chunk，首屏库增量零）；**待执行**：
  桌面手测清单（§七）与 minio 双假桶同步往返（§六 M4）。执行细节见
  `CHANGELOG.md`「多格式笔记支持（MF 轮）」条目。
- **日期**：2026-10-31
- **基线**：main @ 82a420c（行号以该基线为准，开发时以符号名重新定位）
- **范围决策**：已与用户确认（见 §3），执行中不得单方面扩缩范围
- **前置阅读**：`docs/html-note-spike-report.md`（HN 轮设计铁律——本文的架构母版）

---

## 一、背景与动机

mditor 定位是「本地优先的 Markdown 编辑器（Typora 替代）」，当前笔记类型仅 `.md` / `.html` 两种。真实工作区里大量学习/办公资料以 PDF 与 Word 形态存在，当前有三个具体痛点：

1. **割裂**：打开 PDF/Word 必须离开 mditor 去系统应用，与笔记体系（标签页、文件树、最近列表）完全脱节；
2. **换机丢文件**：v5.1.2 同步白名单收死为 `{md, html}`（`src/lib/sync/ignore.ts:39`），PDF/Word 永不进云端——生产 bucket 里已有孤儿 PDF 实证（`作文/六级押题合集_2026年6月.pdf`，353KB，`mditor-cloud-objects.json`），换机即丢失；
3. **进不了编辑体系**：PDF/Word 内容无法转为 Markdown 笔记，双链/搜索/RAG 全套能力够不着。

本任务为 PDF 与 `.docx` 建立**只读预览 + 转 Markdown** 的第一期能力，并把两种格式纳入云同步。

## 二、目标与非目标

### 目标（第一期，全部为桌面 Tauri 端）

| # | 目标 | 验收口径 |
|---|------|---------|
| G1 | 文件树可见并可打开 `.pdf` / `.docx`，以只读标签页呈现 | 树内出现、图标区分、点击打开预览 |
| G2 | PDF 预览：分页渲染、缩放、大纲（书签）导航 | pdfjs-dist，50MB 内流畅 |
| G3 | Word 预览：版式近似渲染 | docx-preview，样式隔离在沙箱 iframe |
| G4 | 一键「转为 Markdown 笔记」：PDF 走文本层提取，docx 走 mammoth→turndown | 产出可编辑 `.md`，图片落 `assets/` |
| G5 | `.pdf` / `.docx` 纳入云同步白名单 | 双端锁步发版，混跑语义安全 |
| G6 | 鸿蒙端能力门控关闭、UI 优雅降级（系统应用打开） | 跟随 `htmlNoteView` 先例 |

### 非目标（明确不做，防止范围蔓延）

- **不做** `.doc`（97-2003 老格式）：前端解析不可行，UI 需明确提示；
- **不做** `.docx` 可编辑/回写：OOXML 双向编辑器工程量不可接受；
- **不做** PDF 批注/签名/表单填写：后续专项；
- **不做** xlsx / pptx：二期评估；
- **不做** 鸿蒙端预览：`mditor-asset://` iframe 行为未真机验证 + 大文件 base64 桥内存成本，二期另立项；
- **不做** 二进制内容直接进 RAG/vault 索引/全文搜索：转 MD 后自然获得。

## 三、范围决策记录（用户已确认，2026-10-31）

| 决策点 | 结论 |
|--------|------|
| 交互形态 | 只读预览 + 转 Markdown（不做可编辑 Word） |
| 格式范围 | PDF + `.docx`（`.doc`/xlsx/pptx 不做） |
| 云同步 | 纳入白名单（触碰 v5.1.2 冻结规则，双端锁步） |
| 平台 | 桌面先行；鸿蒙门控关闭，二期真机验证后另立项 |

## 四、总体架构

### 4.1 复用模板：HTML 笔记（HN 轮）

本任务**不发明新架构**，完全复制 HN 轮已验证的模式（`src/lib/htmlNote.ts` + `src/components/HtmlNoteView.tsx`）：

- 纯函数模块管理扩展名集合 / 类型判别 / TabItem 构造（`htmlNote.ts:13-40`）；
- `TabItem.kind` 判别字段（`src/types.ts:565`），只读标签 **dirty 恒 false、content 恒空**，绕开编辑器/useFile/docCache/批注/RAG 全套；
- 能力门控 `caps.htmlNoteView`（`platform/types.ts:224`；Tauri=true `platform/tauri/index.ts:20`，harmony=false `platform/harmony/index.ts:236`）+ 降级 UI「用系统应用打开」（`HtmlNoteView.tsx:52-63` 附近）；
- 冲突免覆盖命名 `conflictFreeName`（`htmlNote.ts:70`，转 MD 落盘直接复用）；
- 二进制拷贝惯例 `copyFileBinary`（`htmlNote.ts:111`，`fs.readFile`→`fs.writeFile`）。

**与 HN 轮的两大差异**（任务书的关键设计判断）：

1. **渲染位置不同**：HTML 笔记用 asset 协议 iframe 隔离不可信内容；PDF/Word 是**受控解析**——pdfjs/docx-preview 在主文档渲染到受控容器，不执行文档内脚本（pdfjs 默认禁用 PDF JavaScript；docx 输出 HTML 需过 `exportSanitize.ts` 消毒闸门——S10 红线：所有新渲染路径必过）。docx-preview 的样式泄露风险用 **sandbox iframe**（同 `HTML_NOTE_SANDBOX` 配置）兜底。
2. **新增三方依赖**：`pdfjs-dist`、`docx-preview`、`mammoth`（版本以执行时最新稳定 minor 为准，锁版本号）。**全部懒加载**（动态 `import()` 收在视图组件内部），对齐 `exporter.ts:32-35` 的首屏零依赖惯例。

### 4.2 新模块 `src/lib/docNote.ts`

镜像 `htmlNote.ts` 的纯函数面（可全量 vitest）：

```ts
export const PDF_EXTS = new Set([".pdf"]);
export const DOCX_EXTS = new Set([".docx"]);        // 不含 .doc，注释写明原因
export const DOC_NOTE_EXTS = /* 并集 */;

export function isPdfNote(name: string): boolean;
export function isDocxNote(name: string): boolean;
export function isDocNote(name: string): boolean;   // pdf 或 docx
export function isPdfTab(tab: TabItem | null | undefined): boolean;
export function isDocxTab(tab: TabItem | null | undefined): boolean;
export function isDocTab(tab: TabItem | null | undefined): boolean;
export function docTabKey(path: string): string;    // "pdf-"/"docx-" 前缀 + toPosix 小写
export function makePdfTab(path: string): TabItem;  // dirty 恒 false、content 恒空
export function makeDocxTab(path: string): TabItem;
```

副作用函数（`fs.readFile` 读字节 + 转 MD 落盘）只放本模块的 `convert*` 函数，保持其余纯函数可测——同 `htmlNote.ts` 头注释的纪律。

### 4.3 TabItem.kind 扩展与只读语义铁律

`src/types.ts:565`：`kind?: "md" | "html" | "pdf" | "docx"`。

**只读语义铁律**（照抄 HN 轮，违反即事故）：pdf/docx 标签不进编辑器、不进 useFile/docCache、不进自动保存、不进批注/闪卡/双链/RAG、不参与「未保存关闭」确认。实现上**不是**在每个消费点各写一份 `isPdfTab||isDocxTab`，而是**把判别收敛**：

- 在 `App.tsx` 与 `TabsBar.tsx` 等处，凡出现 `isHtmlTab(...)` 的**只读判定位**，改为 `isReadonlyTab = isHtmlTab || isDocTab`（建议在本轮顺手把该判别抽成 `lib/noteKind.ts` 单一函数，全仓替换——`isHtmlTab` 在 App.tsx 有 12 处调用：453/456/531/603/618/708/735/762/928/1197/1466/1550，另有 `TabsBar.tsx:119,142`）；
- 渲染分发 `htmlActive`（`App.tsx:3050`）扩为 `htmlActive || pdfActive || docxActive`，dirty 门（3059、3433-3434）、`data-html-note` 编辑器隐藏（3271）、视图挂载（3293-3302）同步扩展；
- `openNoteAny`（`App.tsx:1218-1224`）新增 `isPdfNote/isDocxNote → openDocNote(path)` 分支；`openDocNote` 复制 `openHtmlNote`（1181-1215）的结构：grantFsScope、tabPathKey 去重、空未命名标签原位替换。

### 4.4 视图组件 `PdfNoteView.tsx` / `DocxNoteView.tsx`

**`PdfNoteView.tsx`**（组件目录，与 HtmlNoteView 同级）：

- 数据通道：`getAdapter().fs.readFile(path)`（`platform/types.ts:63` 二进制通道）→ `Uint8Array` → `pdfjs.getDocument({ data })`。桌面直读零拷贝；**不**走 asset URL（避免 webview 插件差异，且需保留字节供转 MD 复用——首次读取后模块级缓存 `{path, bytes}`）；
- 渲染：逐页 canvas（devicePixelRatio 感知），滚动容器 + 页码吸底；缩放档位（适配宽度/50%–300%）；左侧大纲树（`getOutline()`，目标页跳转）；
- 顶栏：页码 x/y、缩放、重载、「转为 Markdown 笔记」、能力门控失败时「用系统应用打开」（照抄 HtmlNoteView 降级 UI）；
- worker：`pdfjs-dist/build/pdf.worker.min.mjs` 经 Vite `new Worker(new URL(...), {type:"module"})` 注入 `GlobalWorkerOptions.workerPort`；**构建验证项**：Tauri CSP（`tauri.conf.json` 的 `app.security.csp`）需放行 `worker-src 'self' blob:`，M2 第一天先跑通最小加载再铺功能；
- 销毁：组件卸载必须 `pdfDocument.destroy()` + 取消进行中渲染任务（页面切换竞态防护），对齐导出管线的 AbortSignal 纪律。

**`DocxNoteView.tsx`**：

- 预览通道：`docx-preview.renderAsync(buffer, container)` 渲染进**沙箱 iframe**（`HTML_NOTE_SANDBOX` 同配置 + srcdoc 注入，docx-preview 输出的 HTML/CSS 过 `exportSanitize.ts` 后再注入），杜绝其样式污染主文档；
- 结构预览降级：docx-preview 渲染失败时回退 `mammoth` 语义 HTML（同样过消毒闸门），并在顶栏提示「版式预览不可用，已切换结构预览」；
- 顶栏同 PdfNoteView（无页码/缩放，加重载/转 MD/降级打开）。

### 4.5 能力门控

`PlatformCapabilities`（`platform/types.ts:203`）新增两项，注释格式照抄 `htmlNoteView`（221-224）：

```ts
/** 多格式笔记（MF 轮）：应用内 PDF 预览（pdfjs）。桌面已验证；harmony
 *  未真机验证（大文件 base64 桥内存 + worker 性能）——保守关，降级为
 *  「系统应用打开」。 */
pdfNoteView: boolean;
/** 多格式笔记（MF 轮）：应用内 Word 预览（docx-preview/mammoth）。同上。 */
docxNoteView: boolean;
```

`platform/tauri/index.ts` → 均 true；`platform/harmony/index.ts` → 均 false。**harmony 端行为**：文件树仍显示这两种文件（文件树是展示面，不是预览面），点击打开 → 只读标签内展示降级卡片「该格式暂不支持应用内预览」+「用系统应用打开」按钮（`shell.open`）。门控判断放 `openDocNote` 入口与视图组件两处。

### 4.6 转 Markdown 管线

- **docx**：`mammoth.convertToHtml({arrayBuffer})` → HTML → 复用 `src/lib/htmlToMarkdown.ts`（turndown）→ MD。图片：mammoth 默认 data URL 内联，落盘阶段解析 data URL 写入 `<同名>/assets/`（对齐 `imageManager.ts` 的 `assets/` 惯例），MD 内引用相对路径；
- **pdf**：pdfjs 逐页 `getTextContent()` → 启发式段落重建（按 `transform[5]` Y 坐标分行、行距/缩进聚类分段，页间 `---` 分隔）。**质量预期写进 UI 文案**：「提取纯文本，排版/图片/公式丢失」。扫描件无文本层 → 明确提示「扫描版 PDF 无文本层，建议 OCR（暂未支持）」并中止；
- **落盘**：目标 `.md` 放源文件同目录，命名 `原名.md`，冲突用 `conflictFreeName`（`htmlNote.ts:70`）；转换成功 → `openPath` 打开新笔记；
- **入口**：两个视图组件顶栏按钮 + `FileTree` 右键菜单「转为 Markdown 笔记」（对齐现有右键菜单结构）；
- **消毒**：mammoth HTML 是转换中间态不直接渲染，但 docx-preview 预览路径必须过 `exportSanitize.ts`（S10 红线）。

### 4.7 云同步改造（触碰冻结规则，本任务最高风险项）

`src/lib/sync/ignore.ts:39`：`SYNCABLE_EXTS` 扩为 `{"md", "html", "pdf", "docx"}`，注释更新为「v5.1.2 决策 → MF 轮修订，仍然收死不可配」。其余同步代码**零改动**（传输字节透明：`engine.ts` 只碰路径与 mtime/etag，`SyncIO` 走 Rust/ArkTS 原生文件通道）。

**双端锁步纪律**：桌面与鸿蒙必须同版本发布。混跑矩阵（写进 PR 描述）：

| 老端 | 新端 | 行为 |
|------|------|------|
| 老桌面 | 新鸿蒙 | 老端把 pdf/docx 当不存在：不上传、不删除远端副本（List 过滤侧不会产生删除动作）→ 安全，仅老端本地文件不同步 |
| 新桌面 | 老鸿蒙 | 同上，方向互换 → 安全 |

结论：混跑只会「少同步」，**不会误删**——安全侧倾斜成立，锁步要求为「同一 release 窗口」，非硬阻塞。

**50MB 上限评审**：维持 `MAX_SYNC_FILE_BYTES = 50MB`（`ignore.ts:5`，Rust `s3.rs:31`、ArkTS `S3Bridge.ets:50` 同值镜像）。理由：无分片上传，单 PUT 全量缓冲；pdfjs 也是全量入内存渲染，50MB ≈ 内存预算护栏。超限文件仅本地 + 警告日志（现状行为，沿用）。

## 五、代码改动检查点清单（核心交付）

> 行号基于 main @ 82a420c 已逐一核验；开发时以符号名为准。

### A 类：必须修改

| # | 位置 | 现状 → 改法 |
|---|------|------------|
| 1 | `src/types.ts:565` | `kind?: "md" \| "html"` → 加 `"pdf" \| "docx"`，注释更新为「MF 轮」 |
| 2 | `src/lib/docNote.ts` | **新建**（§4.2 全部 API） |
| 3 | `src/lib/tauriFs.ts:130` | 树过滤 `isMarkdown(e.name) \|\| isHtmlNote(e.name)` → 尾加 `\|\| isDocNote(e.name)` |
| 4 | `src/lib/tauriFs.ts:200` | `collectMdPathsFromDisk`（:152）删除影响集同上——pdf/docx 标签删除后也要关闭 |
| 5 | `src/lib/tauriFs.ts:19-26` | `MD_FILTERS`/`HTML_FILTERS` 旁加 `DOC_FILTERS`（`[{name:"PDF",extensions:["pdf"]},{name:"Word",extensions:["docx"]}]`），供打开对话框 |
| 6 | `src/components/FileTree.tsx:1230` | 图标二态 → 四态：新增 `PdfFileIcon`/`DocxFileIcon`（lucide 既有 `FileText`/`FileType2` 可选，保持 15px 与现图标一致） |
| 7 | `src/App.tsx:1218-1224` | `openNoteAny` 加 pdf/docx → `openDocNote` 分支 |
| 8 | `src/App.tsx:1181 附近` | **新增** `openDocNote`（复制 `openHtmlNote` 结构） |
| 9 | `src/App.tsx:3050, 3059, 3271, 3293-3302, 3433-3434` | 渲染分发/隐藏/挂载/dirty 门：`htmlActive` 扩为三类只读标签（§4.3） |
| 10 | `src/App.tsx:453…1550` + `TabsBar.tsx:119,142` | 12+2 处 `isHtmlTab` 只读判别收敛为统一 `isReadonlyTab`（§4.3，建议抽 `lib/noteKind.ts`） |
| 11 | `src/App.tsx:1802, 1814` | 拖拽硬编码正则 `/\.(md\|markdown\|mdx\|mdown)$/i` → 加 pdf/docx 分支（pdf/docx 拖入 = 打开预览，非导入） |
| 12 | `src/platform/types.ts:203` + `tauri/index.ts:20` + `harmony/index.ts:236` | 能力门控两项（§4.5） |
| 13 | `src/components/PdfNoteView.tsx` / `DocxNoteView.tsx` | **新建**（§4.4） |
| 14 | `src/lib/sync/ignore.ts:39` | 白名单扩容（§4.7） |
| 15 | `src/lib/sync/engine.test.ts:781` | 白名单测试改锚：标题与断言从「仅 md/html」改为「md/html/pdf/docx」，原孤儿 PDF 语义断言改为「老规则遗留副本保留」 |
| 16 | `src-tauri/src/lib.rs:105,116` | Rust 侧 `MD_EXTS` 镜像加 `pdf/docx`（CLI/启动参数打开），注释「三处同步」→「五处同步」（+docNote.ts+ignore.ts） |
| 17 | `package.json` | 新增 `pdfjs-dist` / `docx-preview` / `mammoth`（锁版本） |

### B 类：明确不动（防误改清单）

| 位置 | 理由 |
|------|------|
| `src/lib/filePrefetch.ts:31` | 不预取二进制（大文件预读 = 内存事故），保持 MD-only |
| `src/lib/workspaceSearch.ts:62,139` | 全文搜索不索引二进制 |
| `src/lib/vaultIndex.ts:285,456,563-564,614,644` | vault/RAG 索引不收二进制；**需验证** watcher 对新扩展文件是否静默忽略（M1 验收项） |
| `src/lib/htmlNoteSearch.ts:105` | HTML 搜索通道与本题无关 |
| `src/components/FileTree.tsx:~775` `createFile` | 新建文件仍强制 `.md`，不改 |
| `src/hooks/useAutosave.ts` | 只读标签天然不进（经 #10 收敛保证），无独立改动 |
| `src/hooks/useFileWatcher.ts` | 一期不改；外部修改 pdf/docx → 标签重载提示列为 M2 可选项 |

### C 类：产品决策随行项

- `src-tauri/tauri.conf.json` `bundle.fileAssociations`（~55-65）：是否注册 `.pdf/.docx`？**建议暂缓**——注册会改变系统默认打开方式，与「Typora 替代」定位的冲突需单独评审；CLI/拖拽入口已够用。
- AI agent 文件工具（`src/lib/agent/tools.ts:414`「仅支持创建 Markdown 文件」）：一期不改（agent 不创建二进制），转 MD 后的 `.md` 天然可被 agent 读写。

## 六、里程碑与验收

### M1 架构底座（预计 1.5 天）

docNote.ts + kind 扩展 + 树/图标/路由/分发打通 + 空壳视图组件（「MF 轮脚手架」占位）+ 能力门控 + `lib/noteKind.ts` 收敛。

**验收**：文件树显示 pdf/docx（含图标）；点击打开只读标签（空壳）；切换/关闭/重开标签行为与 html 标签完全一致；`npm run test` 全绿 + 现有 html 笔记测试零回归。

### M2 PDF 查看器（预计 2.5 天）

pdfjs 集成（worker/CSP 验证先行）、分页/缩放/大纲、大文件预算、拖拽/CLI/对话框入口、外部修改重载（可选）。

**验收**：50MB 图文 PDF 打开首屏 ≤ 2s、翻页流畅；大纲跳转准确；卸载无泄漏（反复开关 20 次内存平稳）；加密 PDF/损坏 PDF 走错误态 UI 不崩溃。

### M3 Word 查看器 + 转 MD（预计 3 天）

docx-preview 沙箱预览、mammoth 降级链、转 MD 管线（docx + pdf 两路）、图片落 assets/、右键菜单入口、扫描件提示。

**验收**：典型 docx（多级标题/表格/图片/公式占位）版式预览可用；转出的 MD 在编辑器中打开即用（标题层级/列表/表格/图片引用正确）；PDF 转文本段落切分合理；全部落盘走 conflictFreeName。

### M4 同步 + 收尾（预计 1.5 天）

白名单扩容 + 测试改锚、混跑矩阵落 PR 描述、CHANGELOG、设置页无新增项（白名单不可配，无需 UI）。

**验收**：双假桶（minio）实测 pdf/docx 上传/下载/冲突副本扩展名保留；`engine.test.ts` 全绿；文档齐（本文状态改「已完成」+ `CHANGELOG.md` 条目）。

## 七、测试计划

- **单测（vitest，对齐现有锚点风格）**：`docNote.test.ts`（扩展名判别/tab 构造/key 稳定性/大小写）；`sync/ignore` 白名单新用例（`.PDF` 大写、无扩展名、`legacy.pdf` 孤儿保留语义迁移）；转 MD 纯函数（段落重建启发式、conflictFreeName 落盘名）；`noteKind.ts` 收敛后全仓只读判别一致性；
- **回归锚点**：`engine.test.ts:781`（改锚后语义必须完整迁移，不得删除原断言意图）；html 笔记全套测试零回归；
- **手测清单（桌面 Windows）**：树显示/图标；双击打开；拖拽打开；CLI 打开；加密/损坏文件错误态；50MB 大文件；转 MD 全流程（含图片落盘）；同步往返（minio）；鸿蒙包冒烟（门控关闭 + 降级卡片）。

## 八、性能预算

| 指标 | 预算 |
|------|------|
| 50MB PDF 首屏 | ≤ 2s（worker 加载 + 首页渲染） |
| 渲染内存峰值 | ≤ 300MB（pdfjs canvas 页缓存上限 5 页，LRU 淘汰） |
| 10MB docx 预览 | ≤ 3s（docx-preview 单次 renderAsync） |
| 首屏 bundle 增量 | **0**（三个库全部懒加载，动态 import 收在视图组件） |
| 同步单文件 | 维持 50MB 上限，无分片 |

## 九、风险与对策

| 风险 | 等级 | 对策 |
|------|------|------|
| pdfjs worker 被 Tauri CSP 拦截 | 高 | M2 第一天专项验证；`worker-src` 放行 `self blob:`；备选：禁 worker 走主线程（性能劣化但可发布） |
| CJK/内嵌字体渲染偏差 | 中 | pdfjs 标准字体 fallback；接受与 Acrobat 的轻微差异，UI 不承诺像素级一致 |
| 大文件内存（base64 通道鸿蒙） | 中 | 桌面直读不受影响；鸿蒙门控关闭 + 50MB 护栏双保险 |
| docx-preview 样式污染主文档 | 中 | 强制沙箱 iframe + 消毒闸门，禁止直渲染进主 DOM |
| `.doc` 用户预期落差 | 低 | `.doc` 不进树（`DOC_NOTE_EXTS` 不含它）、不进打开 filter，自然引导用户先转存 docx；文档明示 |
| 混跑版本同步语义漂移 | 中 | §4.7 混跑矩阵写进双端 PR；仅「少同步」不误删已论证 |
| vaultIndex/watcher 对未知扩展崩溃 | 低 | M1 验收项：放入 pdf/docx 后 watch/index 全链路无异常日志 |

## 十、交付物清单

1. `src/lib/docNote.ts` + `docNote.test.ts`、`src/lib/noteKind.ts`、`src/components/PdfNoteView.tsx`、`src/components/DocxNoteView.tsx`、FileTree 图标组件；
2. §五 A 类 17 项改动全部落地、B 类零改动；
3. 三个依赖锁版本进入 `package.json`，首屏 bundle 体积零增量（`npm run build` 前后对比截图贴 PR）；
4. `CHANGELOG.md` 条目 + 本文状态更新 + 混跑矩阵 PR 描述；
5. `npm run test` / `npm run build` / `npm run build:harmony`（harmony 端编译通过即可，行为门控关闭）全绿。
