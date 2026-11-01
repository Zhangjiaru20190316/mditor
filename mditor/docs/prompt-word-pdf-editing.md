# 提示词与任务书：mditor Word / 文字 PDF 原位编辑（DE 轮）

> 用法：将本文件全文作为任务提示词投喂给编码 agent（如 ZCode / Claude Code），在 `mditor/` 项目根目录下执行。
>
> - **状态**：开发完成（阶段 0 + M1–M4 代码全量落地，2026-11-01）——四闸门
>   全 A（`docs/doc-note-edit-spike-report.md`）；vitest 1302+ / tsc / eslint /
>   build 全绿。**待执行**：桌面手测清单（§五）与 harmony 包冒烟。
> - **日期**：2026-11-01
> - **基线**：main @ 82a420c（行号以该基线核验为准，开发时以符号名重新定位）
> - **范围决策**：已与用户确认（见 §三决策记录），执行中不得单方面扩缩范围
> - **前置阅读**：`docs/multiformat-note-support-task.md`（MF 轮任务书——本轮直接前置）、`docs/vector-pdf-export-report.md`（EX 轮导出管线——字体/fontkit 复用出处）

---

## 一、角色与任务

你是 **mditor**（Tauri 2 + React 18 + Milkdown 7 + Vite 5，Windows/WebView2 优先，harmony 为第二平台）**多格式笔记模块的负责人**。MF 轮已交付 PDF/Word 的只读预览与转 Markdown，EX 轮已交付 Markdown → docx/PDF 导出。本任务在此之上实现**原位编辑**：

1. **Word（.docx）**：只读标签内一键进入**结构化编辑模式**——mammoth 语义 HTML 水合进独立编辑面（Milkdown Crepe 独立实例），编辑后经现有 docx 导出链保存回 `.docx` 文件；
2. **文字 PDF**：只读标签内一键进入**微编辑模式**——pdfjs 文本层的行级文本可点击替换，保存时从原始字节经 pdf-lib 应用 patch（覆盖矩形 + 重绘文本）写回 `.pdf`，未编辑内容原样保留；
3. 两条路径共享同一套保存语义：**默认另存「原名 (编辑版)」**，可选**替换原文件**（二次确认 + 原件进回收站）；
4. PDF → MD 转换质量增强（标题层级 / 列表语法），「转为 Markdown」保留为深度编辑路径。

三条设计铁律，先记住再动手：

1. **原件神圣**：任何保存路径默认另存新文件（`conflictFreeName` 绝不覆盖）；「替换原文件」必须二次确认，且原件走 `trash_file` 进系统回收站（`src-tauri/src/commands.rs:361` 现成命令）——可恢复是底线。
2. **条件只读**：HN/MF 轮的「只读语义铁律」扩展而非推翻——pdf/docx/html 标签对 **md 管线**（编辑器/useFile/docCache/自动保存/批注/双链/闪卡/RAG）恒隔离；只有**显式进入编辑态**的 pdf/docx 标签才获得 dirty、关闭确认、Ctrl+S 三件事，显式退出即回到恒只读。
3. **零新依赖、全前端**：pdf-lib + @pdf-lib/fontkit、mammoth、turndown、pdfjs-dist、Milkdown Crepe **全部已在依赖内**（EX/MF 轮引入），不引入任何新 npm 包、不引入 Node 原生模块、不复活 window.print。格式处理一律纯浏览器 JS，平台差异经 `src/platform` 适配层收口。

分阶段交付（阶段 0 是闸门，结论决定 M3 细节），验收标准见 §五。

## 二、现状与文件地图（已探明，无需重复探查，直接引用）

**MF 轮只读基座（本轮的直接地基）**

- `src/lib/docNote.ts`：扩展名集合（`PDF_EXTS`:18 / `DOCX_EXTS`:23 / `DOC_NOTE_EXTS`:26 / `DOC_NOTE_RE`:47）、Tab 构造（`makePdfTab`/`makeDocxTab`:73-94，dirty 恒 false、content 恒空）、**单条字节缓存** `readDocNoteBytes`:105（含「消费方必须传副本，缓存本体不可被 detach」纪律——pdfjs 与本轮 pdf-lib 都要遵守）、`PdfTextPiece`:120（str/x/y/width/height，transform[4]/[5] 用户空间坐标）、行聚类 `piecesToLines`:155、段落重建 `rebuildPdfParagraphs`:209、扫描件错误 `PdfNoTextLayerError`:277、`convertPdfToMarkdownText`:286（loadingTask.destroy 收尾纪律 :322）、mammoth 懒加载单例 `loadMammoth`:334、`convertDocxToMarkdown`:353（**图片拆 data URL 落 assets/**——本轮编辑态要的是内联变体，见 §六 M2）、一键转 MD `convertDocNoteToMd`:398；
- `src/lib/noteKind.ts:18`：`isReadonlyTab = isHtmlTab || isDocTab`，全仓唯一只读判别（App.tsx 9 处 + TabsBar 2 处消费）。**本轮要在此拆分语义**（§4.3）；
- `src/types.ts:556-568`：`TabItem { key, path, name, dirty, content, kind? }`，`kind?: "md" | "html" | "pdf" | "docx"`（:567）；
- `src/components/PdfNoteView.tsx`：pdfjs 分页 canvas（可视窗口渲染、5 页 LRU、RenderTask.cancel 纪律、dpr 上限 2）；`src/components/DocxNoteView.tsx`：docx-preview 过 `exportSanitize.ts` 消毒 → `sandbox=""` iframe srcdoc，失败回退 mammoth 结构预览；
- `src/lib/pdfjsLazy.ts`：pdfjs + module worker 懒加载单例（CSP `worker-src 'self' blob:` 已由 `tauriCspConfig.test.ts` 钉死）；
- 能力门控：`src/platform/types.ts:203`（`PlatformCapabilities`）+ `src/platform/tauri/index.ts:22-23`（pdfNoteView/docxNoteView = true）+ `src/platform/harmony/index.ts:236-241`（均 false + 降级卡片）；
- App.tsx：`openDocNote`/`openNoteAny`（~1236-1280）、只读判定位（~467/545/617/722/776/942/1211/1526/1610）、渲染分发（~3150-3153）、三视图条件挂载（~3397-3420，PdfNoteView:3410 / DocxNoteView:3417）、导出分发 `doExport`（~2128-2260）。

**EX 轮导出链（Word 保存链的复用面）**

- `src/lib/exporter.ts`：`exportDocx`:705 的内部顺序 = `prepareExportHtml`（消毒 + 图片内联，:445）→ `juice.inlineContent` CSS 内联 → `ensureBrowserNodeGlobals`（Buffer/global 垫片，:699）→ `@turbodocx/html-to-docx`（:621）→ 写盘。**本轮要把中间段抽成 `buildDocx(html)` 可复用纯函数**，`exportDocx` 的 pickSaveFile/进度 UX 行为零变化；
- `src/lib/exportPdfPipeline.ts:524-531`：CJK 字体源 `public/assets/fonts/NotoSansSC-Regular.otf`（OFL），拉丁 Inter Medium/Bold/Italic/BoldItalic；`:549-596` fontkit 逐码点字形覆盖检测——**PDF 重绘直接复用这两样**；
- `src/lib/exportSanitize.ts`：S10 红线消毒闸门（mammoth 产物进主 DOM 必过）；
- `src/lib/renderMarkdown.ts:146-189`：unified 管线（rehype-sanitize 白名单）——转 MD 质量增强的渲染出口；
- `src/lib/htmlToMarkdown.ts`（turndown）、`src/lib/htmlNote.ts:70`（`conflictFreeName`）。

**其他事实**

- `src/lib/sync/ignore.ts:39`：`SYNCABLE_EXTS = {md, html, pdf, docx}`（MF 轮已扩）——**本轮不新增扩展名，同步零改动**；
- `src/hooks/useMenuCommands.ts`：保存/导出命令分发（本轮给 doc 编辑态加分流）；`ExportProgressDialog` + AbortController 取消机制现成；
- 依赖：`pdf-lib ^1.17.1`、`@pdf-lib/fontkit ^1.1.1`（有 patch-package 补丁）、`mammoth 1.13.0`、`pdfjs-dist 6.4.299`、`@milkdown/crepe|kit|prose|react ^7.22.1`；
- 测试：vitest + jsdom（jsdom 跑不了真 canvas/pdfjs 渲染——纯逻辑写 vitest，渲染行为靠阶段 0 spike + 手测清单固化）。

## 三、目标与非目标

### 目标

| # | 目标 | 验收口径 |
|---|------|---------|
| G1 | `.docx` 标签「编辑」模式：结构化编辑面（独立 Crepe 实例），可保存回 `.docx` | 保存产物可被 Word/WPS 打开且标题/段落/列表/表格/图片结构一致 |
| G2 | 文字 PDF「编辑」模式：行级文本替换微编辑（patch 模型），可保存回 `.pdf` | 未编辑页与原件视觉一致；被替换行 CJK 正确渲染、无豆腐块 |
| G3 | 保存语义：默认另存「原名 (编辑版)」落源目录，可选替换原件 | 替换必须二次确认，原件进系统回收站可恢复 |
| G4 | 只读铁律条件化：仅编辑态具备 dirty/关闭确认/Ctrl+S | 未编辑态行为与 MF 轮逐项一致；md 主线全量回归零失败 |
| G5 | PDF → MD 转换质量增强（标题层级/列表语法） | 三类典型样张（论文多级标题/办公报告含表格/带图文档）人工抽检通过 |
| G6 | 零新依赖、桌面先行、harmony 门控关闭 | 首屏 bundle 增量 0；`npm run build:harmony` 通过 |

### 非目标（明确不做，防止范围蔓延）

- **不做** docx 版式级保真回写（OOXML 双向编辑）：保存即「按 mditor 样式重新生成」，原字体/页眉页脚/分节/文本框不保留——编辑入口与覆盖确认文案必须明示；
- **不做** PDF 整段重排/富编辑（增删段落后重新分页、图片增删）：patch 只做「同位替换」，大改引导走「转为 Markdown」深度编辑路径；
- **不做** 扫描版 PDF 编辑（无文本层，`PdfNoTextLayerError` 同源拒绝）；
- **不做** `.doc`（97-2003 老格式，MF 轮结论沿用）；
- **不做** harmony 编辑态（随 pdfNoteView/docxNoteView 门控一并关闭）；
- **不做** 批注/双链/闪卡/RAG 接入编辑态、编辑历史/版本快照、多人协同。

### 范围决策记录（用户已确认，2026-11-01）

| 决策点 | 结论 |
|--------|------|
| 编辑形态 | 预览原位编辑（非 Markdown 中转闭环） |
| 原件关系 | 默认另存 + 可选替换原件（确认 + trash） |
| 转换质量 | 纳入核心交付（G5） |
| 交付形式 | 提示词与任务书合并一份（本文档） |

## 四、总体架构

### 4.1 Word 编辑模式 = 结构化编辑面（内存托管，不落 .md）

```
.docx 字节（readDocNoteBytes 复用）
  → mammoth convertToHtml（loadMammoth:334 复用；图片保持 data URL 内联，不落 assets/）
  → HTML 水合进独立 Milkdown Crepe 实例（挂载在 DocxNoteView 内部，懒加载）
  → 用户编辑（ProseMirror 文档即 buffer）
  → 保存：crepe.getHTML() → prepareExportHtml（exporter.ts:445，消毒+图片内联）
        → buildDocx（自 exporter.ts:705 抽出）→ 写盘
```

- **保真边界（必须写进 UI 文案）**：保存产物是重新生成的 docx（mditor 导出样式），不是原样式回写。进入编辑模式时提示一次「结构化编辑：版式将按 mditor 样式重新生成」， mammoth 无法承载的结构（文本框/SmartArt 等，spike ④ 清单化）在保存前提示「以下内容未被编辑面承载」；
- **buffer 生命周期**：进入编辑 = 转换 + 水合；切走标签 = `getHTML()` 序列化进状态机（标签保留编辑态与 dirty）；切回 = 再水合；退出编辑/关闭标签 = 释放。编辑面是 DocxNoteView 内的**独立实例**，主编辑器（`Editor.tsx`/`useMilkdown`/`svCodeMirror.ts`）零接触；
- **图片**：编辑期间 data URL 内联展示与保存，全程不落盘；保存链 `prepareExportHtml` 原生接受 data URL。

### 4.2 PDF 微编辑 = 行级 patch 模型（真原位）

```
patch = { page, lineKey(page+y+x0), origText, bbox(x0,yTop,x1,yBottom 用户空间),
          baseline(x, y), fontSize, newText }
```

- **命中层**：复用 `getTextContent` pieces + `piecesToLines`（docNote.ts:155）聚类为**行**；在 canvas 上方建轻量透明命中层（viewport transform 映射屏幕坐标），点击行 → 行内编辑框预填原文本；
- **应用（保存时）**：**始终从原始字节** `PDFDocument.load` → 每个 patch：`drawRectangle` 覆盖行 bbox（白色；背景非纯白的取渲染 canvas 采样色，spike ② 定案）→ `registerFontkit(fontkit)` + `embedFont(NotoSansSC, {subset:true})` → `drawText(newText, {x: baseline.x, y: baseline.y, size})`；宽度超 bbox 时字号自适应收缩（下限保护），仍超则拒绝该 patch 并列报；→ `save()` 写盘；
- **幂等**：patch 列表是唯一事实源，每次保存都从原始字节重放——绝不基于已 patch 的产物二次叠加；
- **拒绝场景**（patch 级或文档级，明确提示不崩溃）：加密 PDF（load 抛错即拒，**禁用** `ignoreEncryption`——会产出损坏文件）、无文本层页/扫描件、页面 `/Rotate` 非 0（整页拒绝，预览照常）、旋转文本 run、字形缺失（复用 exportPdfPipeline.ts:549-596 的 fontkit 覆盖检测）、拉丁 run 走 Inter（Medium 优先）；
- 侧栏 patch 列表：逐条查看/撤销/点击跳转；未保存关闭走 G4 关闭确认。

### 4.3 只读语义铁律的条件化（本轮最高风险架构点，先设计后动手）

现语义（`noteKind.ts:18`）：isReadonlyTab = 恒只读（dirty 恒 false、不进一切）。拆成两个正交判别：

| 判别 | 语义 | 消费点 |
|------|------|--------|
| `isReadonlyTab`（**语义更新为「md 管线隔离」**） | html/pdf/docx 恒真，**含编辑态**——编辑态也不进 useFile/docCache/自动保存/批注/双链/闪卡/RAG | 现有 9+2 处调用位中「管线隔离」性质的判定，**一行不改** |
| `isViewOnlyTab = isReadonlyTab && !isDocEditActive(tab)`（**新增**） | 仅「未编辑的视图对象」为真—— dirty 圆点、关闭无确认、Ctrl+S 无效 | App.tsx 中的 dirty 门/关闭确认/保存分流（~467/545/617/722/776/942/1526/1610）改为本判别 |
| `isDocEditActive(tab)`（**新增**） | kind 为 pdf/docx 且编辑态激活 | 保存命令分流、关闭确认、TabsBar dirty 圆点 |

- 编辑态的 dirty **复用 `TabItem.dirty` 字段**（由 docNote 状态机写入，替代 useFile 的写入者）；`TabItem` 增加可选 `docEdit?: boolean`（:568 处扩展，缺省 undefined 兼容既有构造点）；
- **放行前提**：拆分后必须全量回归 MF 轮手测清单（树/打开/切换/关闭/拖拽/转 MD/降级卡片）——「未编辑态与 MF 轮逐项一致」是 G4 验收口径，不是口头承诺。

### 4.4 编辑态状态机与保存编排（新模块 `src/lib/docNoteEdit.ts` + `docNoteSave.ts`）

```ts
// docNoteEdit.ts —— 状态机（模块级，键 = docTabKey(path)，对齐 docBytesCache 惯例）
interface DocEditState {
  phase: "idle" | "converting" | "editing" | "saving";
  htmlBuffer?: string;              // Word：切走标签时的序列化文档
  patches?: PdfPatch[];             // PDF：patch 列表（唯一事实源）
  baseMtime: number; baseSize: number;  // 进入编辑时捕获，保存前校验
}
// 语义：进入/退出/切走/切回/放弃（放弃需确认）；外部修改（mtime/size 变化）
// → buffer 作废提示，防覆盖他人改动。

// docNoteSave.ts —— 保存编排（副作用面）
saveDocNote(path, opts: { mode: "save-as" | "replace" }): Promise<SaveResult>;
// save-as：目标 = 同目录「原名 (编辑版).docx|pdf」，冲突 conflictFreeName（htmlNote.ts:70）；
// replace：二次确认（调用方 UI）→ trash_file 原件 → 新文件写入原路径 → 字节缓存/状态机重置。
```

### 4.5 能力门控

`PlatformCapabilities`（platform/types.ts:203）新增一项，注释格式照抄 `pdfNoteView`：

```ts
/** 多格式笔记编辑（DE 轮）：docx 结构化编辑 + 文字 PDF 微编辑。桌面已验证；
 *  harmony 未真机验证（编辑面内存 + ArkWeb 长任务）——保守关，仅保留 MF 轮只读。 */
docNoteEdit: boolean;
```

tauri → true；harmony → false。harmony 行为：MF 轮只读体验原样（预览本就门控关闭），编辑入口随视图门控不可见。门控判断放 `openDocNote` 入口与两个视图组件的编辑入口两处。

## 五、验收标准（逐条自查，全部满足才算完成）

1. **Word 编辑闭环**：打开典型 docx（多级标题/列表/表格/图片）→ 进入编辑 → 改标题/正文/列表/表格 → Ctrl+S 另存 → 产物可被 Word/WPS 打开且结构一致；关闭后重开可再次编辑。
2. **Word 替换原件**：导出对话框勾选替换 → 二次确认（文案明示「版式将按 mditor 样式重新生成」）→ 原件出现在系统回收站 → 新文件占原名；取消则原文件毫发无损。
3. **PDF 微编辑**：点击行 → 行内编辑 → 保存另存 → Acrobat/Edge 打开：未编辑页与原件像素级抽查一致，被替换行文本正确、CJK 无豆腐块；patch 可逐条撤销；宽度超界 patch 被拒绝并明确列报。
4. **PDF 替换原件**：同第 2 条，确认文案注明「未编辑内容保留原样」。
5. **拒绝场景优雅**：加密 PDF、扫描页、旋转页/旋转文本、字形缺失、（Word）mammoth 无法承载的结构——全部明确提示，不产出损坏文件、不静默丢内容。
6. **只读铁律不破**：未进编辑态的 pdf/docx/html 标签行为与 MF 轮逐项一致（不进编辑器/不 dirty/无关闭确认/不自动保存）；进入编辑态后 dirty 圆点 + 关闭确认 + Ctrl+S 生效；md 主线（编辑/保存/导出四格式/AI 面板/批注/双链/闪卡）全量回归零失败。
7. **外部修改防护**：编辑期间原文件被外部程序修改 → 保存时检测并提示冲突，不覆盖。
8. **平台与测试**：`npm run test` 全绿（含新增纯函数单测）；`npm run build` / `npm run build:harmony` 通过；harmony 包冒烟（门控关闭、编辑入口不可见）。

## 六、技术方案（分阶段，每阶段一个 commit）

### 阶段 0：Spike 验证（闸门，先行独立提交，不写产品代码）

产出报告 `docs/doc-note-edit-spike-report.md`，四项实测：

1. **pdf-lib load→save 保真**：典型 PDF（含表单域/注释/链接/大文件 50MB）`load → 不动 → save`，产物与原件渲染 diff + 字节结构对比；`useObjectStreams` 两档对比；内存峰值实测。**结论 C（保真不可接受）→ M3 降级为「patch 导出副本」路线，主线不变**；
2. **坐标映射**：pdfjs textContent transform（用户空间）→ pdf-lib drawText/drawRectangle 的映射实测，重点 `/Rotate`、CropBox 偏移、y 向上约定；覆盖矩形底色取白色 vs 渲染 canvas 采样，二选一定案；
3. **CJK 重绘质量**：NotoSansSC subset embed + drawText，中文/混排/标点渲染与宽度测量精度（决定字号收缩算法）；缺字形拒绝路径验证；
4. **Crepe 独立挂载 + 往返稳定**：mammoth HTML → Crepe 水合 → getHTML → 再水合，往返漂移评估；mammoth 保真清单（文本框/SmartArt/脚注/合并单元格表格的承载情况）。备选：Crepe 水合不可行则降级 contenteditable + renderMarkdown HTML（报告说明取舍）。

### M1 编辑态底座（预计 1.5 天）

types.ts 扩展 + noteKind 拆分 + `docNoteEdit.ts` 状态机 + 能力位 `docNoteEdit` + App.tsx 判定位切换（isViewOnlyTab）+ Ctrl+S/关闭确认接线 + 两视图空壳编辑入口（门控内可见、点击进入占位态）。

**验收**：进出编辑态、切标签保态、放弃确认、关闭确认全链路可用；未编辑态与 MF 轮行为逐项一致；`npm run test` 全绿。

### M2 Word 编辑模式（预计 2.5 天）

`convertDocxForEdit`（docNote.ts 新增：mammoth HTML 图片内联变体）+ Crepe 独立挂载（懒加载）+ `buildDocx` 从 exporter.ts:705 抽出（`exportDocx` 调用方行为零变化）+ `docNoteSave.ts` Word 支路 + 另存/替换 UI + 保真边界文案 + 无法承载结构保存前提示。

**验收**：§五第 1/2/5 条（Word 侧）。

### M3 PDF 微编辑（预计 3 天）

行级命中层（复用 piecesToLines）+ 行内编辑框 + patch 状态与侧栏 + `applyPdfPatches`（原始字节重放 + 覆盖矩形 + 字体嵌入 + 宽度收缩）+ 拒绝场景全套 + 保存/另存/替换。

**验收**：§五第 3/4/5 条（PDF 侧）。

### M4 转换质量 + 收尾（预计 1.5 天）

`rebuildPdfParagraphs` 增强：字号聚类（相对页中位字号，docNote.ts:214 已有 medianH 基建）映射标题层级 `#/##/###`、bulletish 行转 MD 列表语法（现为纯段落）；docx 转 MD 保真清单按 spike ④ 结论补降级提示；CHANGELOG「Word / 文字 PDF 原位编辑（DE 轮）」条目 + 本文状态更新。

**验收**：G5 三类样张抽检；全部自动化绿。

## 七、代码改动检查点清单（核心交付）

> 行号基于 main @ 82a420c；开发时以符号名为准。

### A 类：必须修改

| # | 位置 | 现状 → 改法 |
|---|------|------------|
| 1 | `src/types.ts:566-568` | TabItem 增加可选 `docEdit?: boolean`；dirty 写入者注释更新（useFile 之外新增 docNote 状态机） |
| 2 | `src/lib/noteKind.ts:18` | 语义拆分：isReadonlyTab 注释改为「md 管线隔离」；新增 `isViewOnlyTab` / `isDocEditActive`（§4.3） |
| 3 | `src/lib/docNote.ts` | 新增 `convertDocxForEdit`（图片 data URL 内联，复用 loadMammoth:334）；导出 `PdfEditLine` 聚类（复用 piecesToLines:155）与 patch 纯函数（bbox 合并、字号收缩计算） |
| 4 | `src/lib/docNoteEdit.ts` | **新建**：编辑态状态机（§4.4；键 = docTabKey；mtime/size 捕获与校验） |
| 5 | `src/lib/docNoteSave.ts` | **新建**：保存编排（buildDocx 支路 / applyPdfPatches 支路 / conflictFreeName 另存 / trash 替换） |
| 6 | `src/lib/exporter.ts:705` | 从 exportDocx 抽出 `buildDocx(html)` 纯函数；exportDocx 对外行为零变化 |
| 7 | `src/components/DocxNoteView.tsx` | 编辑模式：入口按钮 + Crepe 独立挂载（懒加载）+ 保存/退出/放弃 UI + 保真文案 |
| 8 | `src/components/PdfNoteView.tsx` | 行级命中层 + 行内编辑框 + patch 侧栏（列表/撤销/跳转）+ 保存 UI + 拒绝场景提示 |
| 9 | `src/App.tsx` 只读判定位（~467/545/617/722/776/942/1526/1610） | dirty 门/关闭确认/保存分流改 isViewOnlyTab 语义；编辑态标签接线 |
| 10 | `src/hooks/useMenuCommands.ts` | 保存命令：isDocEditActive → docNoteSave 分流；导出命令在编辑态先提示退出编辑 |
| 11 | `src/platform/types.ts:203` + `tauri/index.ts:22` + `harmony/index.ts:236` | 能力位 `docNoteEdit`（§4.5） |

### B 类：明确不动（防误改清单）

| 位置 | 理由 |
|------|------|
| `src/lib/sync/ignore.ts:39` | 编辑不新增扩展名；pdf/docx 已在白名单——**同步零改动** |
| `Editor.tsx` / `useMilkdown.ts` / `svCodeMirror.ts` | 主编辑器不承载 doc 编辑面（Crepe 独立实例） |
| `useFile` / `docCache` / `useAutosave` / `parsePipeline` | 编辑 buffer 走 docNoteEdit 状态机，md 管线隔离铁律含编辑态恒成立 |
| exporter.ts 导出 UX 主线 / `exportPdfPipeline.ts` / `exportPngPipeline.ts` / `exportRenderFactory.ts` | 只抽函数不改行为；EX 轮四格式导出零回归 |
| `vaultIndex` / `workspaceSearch` / `htmlNoteSearch` / `filePrefetch` | MF 轮 B 类结论沿用 |
| 批注 / 闪卡 / 双链 / RAG | 编辑态也不接入 |
| `src-tauri/**` 全部 Rust 代码 | `trash_file`（commands.rs:361）/`fetch_image` 现成可用，无 Rust 改动 |
| `FileTree.tsx` / `TabsBar.tsx` 图标分发 | kind 判别不变；TabsBar dirty 圆点随 TabItem.dirty 自动生效 |

### C 类：产品决策随行项

- 编辑态下批注/AI 面板：暂禁用（跟随只读语义），后续单独评审；
- `fileAssociations`：沿用 MF 轮「暂缓」结论；
- agent 文件工具：不改（编辑产物是普通 pdf/docx，与 agent 无关）；
- 「编辑历史/快照」：二期评估。

## 八、性能预算

| 指标 | 预算 |
|------|------|
| 50MB PDF 进编辑态 | 内存峰值 ≤ 500MB（原始字节 + pdf-lib 文档模型 + 5 页 canvas LRU 沿用） |
| PDF 保存（50MB，≤20 patch） | ≤ 5s |
| 10MB docx 进编辑态（mammoth 转换 + 水合） | ≤ 3s；编辑面打字无可感知延迟 |
| docx 保存（renderMarkdown 级链路） | ≤ 5s |
| 首屏 bundle 增量 | **0**（Crepe 已在首屏依赖内；mammoth/pdfjs/pdf-lib 懒加载沿用） |
| 关闭编辑标签 | buffer/patch/字体资源全部释放，内存回落 |

## 九、风险与对策

| 风险 | 等级 | 对策 |
|------|------|------|
| pdf-lib load→save 保真（表单/注释/增量更新链） | 高 | 阶段 0 闸门①；结论 C → 降级「patch 导出副本」，主线不变 |
| 坐标映射（/Rotate、CropBox、y 向上） | 高 | 阶段 0 闸门②实测；旋转页整页拒绝编辑（预览照常） |
| CJK 重绘宽度失配/缺字形 | 中 | fontkit 覆盖检测复用（exportPdfPipeline.ts:549-596）；宽度自适应收缩 + 超界拒绝列报 |
| 用户预期「Word 样式不丢」 | 高 | 编辑入口与覆盖确认分级文案明示「结构化编辑，重新生成」；不静默 |
| mammoth 承载边界（文本框/SmartArt/脚注） | 中 | spike ④ 清单化；保存前「未被承载内容」提示，不静默丢内容 |
| 编辑态状态机泄漏（切标签/关标签/外部修改） | 中 | 状态机 vitest 全覆盖；mtime/size 保存前校验；外部修改 → buffer 作废提示 |
| 覆盖原件误操作 | 中 | 默认另存 + 二次确认 + trash_file 兜底（可恢复） |
| 只读判别拆分误伤 md 主线 | 高 | §4.3 放行前提：MF 轮手测全量回归；noteKind 单测锚定三判别语义 |

## 十、硬约束（违反即返工）

1. **不引入**任何新 npm 依赖 / Node 原生模块 / 无头浏览器；**不复活** window.print / printToPDF。
2. **主编辑器与 md 管线零改动**：Editor.tsx、useMilkdown、svCodeMirror、useFile、docCache、parsePipeline、useAutosave 一行不改；编辑面是独立实例。
3. **EX 轮导出主线零回归**：buildDocx 抽取后四格式导出（html/pdf/docx/png）行为逐项一致。
4. **原件保护**：默认另存、conflictFreeName 绝不覆盖；替换原件必经二次确认 + trash_file；禁用 pdf-lib `ignoreEncryption`。
5. **消毒红线（S10 延伸）**：mammoth 产物进编辑面/主 DOM 的路径必须过现有消毒闸门；编辑面内容不直注主文档 DOM。
6. **平台差异经 `src/platform` 收口**；新能力位 tauri=true / harmony=false；harmony 端 MF 轮只读体验原样，不得崩溃、不得假成功。
7. 新逻辑优先纯函数 + vitest（patch 模型、坐标换算、字号收缩、状态机可全测）；渲染/坐标行为以 spike 报告 + 手测清单为验收载体，不伪造 jsdom 覆盖。
8. 遵循仓库习惯：中文 commit、每阶段一个 commit + 简报、CHANGELOG 更新、`trash > rm`。

## 十一、交付物

1. 阶段 0：`docs/doc-note-edit-spike-report.md`（四项实测 + 路线结论 A/B/C）；
2. §七 A 类 11 项全部落地、B 类零改动证明（diff 自查清单贴 PR）；
3. 新模块：`docNoteEdit.ts` / `docNoteSave.ts`（含测试）、noteKind 拆分测试、rebuildPdfParagraphs 增强测试（标题/列表用例）；
4. CHANGELOG「Word / 文字 PDF 原位编辑（DE 轮）」条目 + 本文状态更新；
5. `npm run test` / `npm run build` / `npm run build:harmony` / tsc / eslint 全绿；首屏 bundle 体积对比贴 PR。

### Plan B（只记录，不实施）

- **真 OOXML 双向编辑**（docx 原样式回写）：需评估 SuperDoc 类库成熟度或自建 ProseMirror↔OOXML 桥，工程量数倍于本轮——若用户反馈强需求再立项；
- **PDF 整段重排/富编辑**：patch 模型扩展为重排引擎，需自研分页——大改场景引导走「转为 Markdown」；
- **harmony 编辑态**：编辑面内存与 ArkWeb 长任务真机验证后随 pdfNoteView/docxNoteView 一并解禁。

---

**执行顺序**：阶段 0 →（闸门通过，结论写入 spike 报告）→ M1 → M2 → M3 → M4。每阶段结束跑 §五对应条目再提交。开始前先读第二节列出的全部文件；阶段 0 的四项实测没做完，禁止开始 M2/M3。
