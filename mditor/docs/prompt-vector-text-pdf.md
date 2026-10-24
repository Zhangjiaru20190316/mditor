# 提示词：mditor 文字版 PDF 导出改造（矢量文字 + 表格边框修复）

> 用法：将本文件全文作为任务提示词投喂给编码 agent（如 ZCode / Claude Code），在 `mditor/` 项目根目录下执行。

---

## 一、角色与任务

你是 **mditor**（Tauri 2 + React 18 + Milkdown 7 + Vite 5，Windows/WebView2 优先的跨平台 Markdown 编辑器）**导出模块的负责人**。本任务做两件事：

1. **【主线】把 PDF 导出从"截图拼位图"升级为真·矢量文字版 PDF**——文字必须是可见的矢量文本（可选中、可复制、可搜索、任意缩放锐利），而不是整页位图。
2. **【bug 修复】修复导出中表格边框完全丢失的问题**——PDF 与 HTML 导出同根因，一并修复，表格的线必须正确渲染。

两项都有明确的验收标准（见第四节），完成前不得宣称任务结束。

## 二、现状与文件地图（已探明，无需重复探查，直接引用）

当前导出链路（从用户点击到生成文件）：

```
菜单项 file_export_pdf（src/components/MenuBar.tsx:84，能力位 caps.pdfExport）
  → src/hooks/useMenuCommands.ts:206 分发
  → src/App.tsx:1766 doExport("pdf")：
      ed.getHTML() → 公式补渲染/双链降级等预处理（App.tsx:1787-1836）
      collectThemeCss()（src/lib/themeCss.ts:8，收集打包 CSS 的 cssText）
      弹 ExportProgressDialog（进度 + AbortController 可取消）
  → src/lib/exporter.ts:486 exportPdf：
      pickSaveFile → buildPdf(:466) → prepareExportHtml(:445，消毒 + 图片内联)
      → runPdfPipeline → fs.writeFile 落盘
  → src/lib/exportPdfPipeline.ts:93 runPdfPipeline，8 阶段：
      1. 离屏 iframe 工厂渲染 renderInFactory（src/lib/exportRenderFactory.ts:203，
         document.write 注入，版心宽 A4-15mm ≈ 680×1009 CSS px，字体/图片确定性就绪）
      2. 块测量 measureBlocks（exportPdfPipeline.ts:239，行盒/表格行盒，含墨迹护量 INK_GUARD_MAX_PX=4）
      3. 分页 paginateBlocks（src/lib/exportPaginator.ts:74，纯函数：行级断页/keepTogether/孤寡控制）
      4. 文本层素材 collectTextFragments（exportPdfPipeline.ts:448，
         逐字符 Range.getClientRects 位置 + canvas measureText advance）★ 矢量化的现成地基
      5. 分块光栅 rasterizeAndAssemble（:738，modern-screenshot → chunk PNG → canvas 切页）
      6. 组装 assembler.save()（src/lib/exportPdfAssembly.ts：pdf-lib drawImage 满铺位图
         + TextRenderingMode.Invisible(Tr 3) 隐形文本 + fontkit 子集内嵌 NotoSansSC-Regular.otf，
         字体源 public/assets/fonts/，取不到则纯光栅降级）
```

其他关键事实：

- **表格样式的作用域错配（R1 根因）**：编辑器内表格边框定义在 `src/styles/global.css:1605-1625`，选择器是 `.mditor-milkdown .ProseMirror table/th/td`（AI 面板版在 `:3341`）。而导出文档 body 的 class 是 **`vditor-reset`**（`src/lib/exporter.ts:390` 的 wrapHtml、`src/lib/exportRenderFactory.ts:89` 的工厂 body），内容是**裸 `<table>`**——所有选择器全部不命中。已用产物 `perf/results/ex-hx-repro/demo-export.html` 验证：导出的 HTML/PDF 表格**一条边框线都没有**。主题 `--border` 色值在各主题文件 `src/styles/themes/*.css`（如 light.css:9 `--border:#e5e7eb`）。
- **R2 根因**：`rasterizeAndAssemble` 把每页做成满铺位图；文本层只是 Tr 3 隐形（可选中但视觉是位图），不可缩放、体积大。
- **历史约束**：`window.print` / printToPDF 路径因 wry#707 静默打印限制已于 EX 轮全量退役（commit `be39beb`），全代码库无任何打印调用。**不要复活打印路径。**
- PNG 导出管线 `src/lib/exportPngPipeline.ts` 与 PDF 工厂共用部分代码，改动不得破坏。
- 调试口：CDP 驱动真实 dev 实例（`perf/cdp.mjs`，WebView2 远程调试口 9223）调用 `window.__exportDebug.exportPdfTo(path, opts)`（`src/lib/exportDebug.ts:23`，实现 `src/App.tsx:1083`）。perf 脚本依赖它，保持兼容。
- 依赖里已有：`pdf-lib` + `@pdf-lib/fontkit`、`modern-screenshot`、`juice`、`unified/remark-*/rehype-*`、`katex`、`highlight.js`。**没有** puppeteer/playwright/jspdf。
- 测试：vitest + jsdom。

## 三、根因清单

| 编号 | 问题 | 根因 |
|---|---|---|
| R1 | 导出的 PDF/HTML 表格无边框线 | 表格 CSS 全部带编辑器作用域前缀，导出文档（`vditor-reset` + 裸 table）无一命中 |
| R2 | PDF 文字是位图（不锐利、体积大） | 每页 = modern-screenshot 满铺位图；已有文本层是不可见的 Tr 3 |

## 四、验收标准（逐条自查，全部满足才算完成）

1. **矢量文字**：导出的 PDF 中所有正文文字是可见矢量文本（正常 Tr 模式，非 Tr 3、非位图）——阅读器里可选中/复制/搜索，400% 缩放文字边缘锐利。
2. **文本覆盖率 100%**：每个文本运行都有可见绘制；无法矢量绘制的复杂块（公式等）允许**按块局部光栅**兜底，但必须有明确的降级判定逻辑，且降级块在结题报告中列明比例。
3. **表格边框**：PDF 与 HTML 导出中 GFM 表格渲染出完整边框线（外框 + 内线，视觉与编辑器一致）；**跨页表格在断页处边框闭合**（页底/页首补上下边线）；表头跨页重复为 P2 增强项，做不到需在报告中说明原因。
4. **体积不劣化**：同一文档导出体积较位图版不增大（预期显著下降，位图页移除后）。
5. **UX 不回退**：进度对话框、AbortController 取消、设置项（paper/marginMm/rasterScale 等）、CDP 调试口 `__exportDebug.exportPdfTo` 全部保持可用；PNG 导出不受影响。
6. **回归验证**：用 `perf/ex-hx-pdf-deep.mjs`（或等价 CDP 脚本）导出含 表格+公式+代码块+图片+中英文混排 的 demo 文档：页数与矢量改造前一致（分页器未动则页数必须一致）；onPagePng 页图逐页目检无错位、丢字、重影；导出的 HTML 在浏览器直开检查表格边框。
7. **测试**：新增纯逻辑（样式运行聚合、字形检测、断页补线计算）有 vitest 单测且通过；现有测试全绿。

## 五、技术方案（主线：pdf-lib 自绘矢量，分阶段，每阶段一个 commit）

### 阶段 0：表格边框速赢（独立提交，先行）
- 在导出文档注入一段**导出专用无前缀表格样式**：`vditor-reset table/th/td` 的边框规则（border-collapse、外框 1px、单元格内线），色值取主题 `--border` 变量的实际值（collectThemeCss 已带入变量定义则直接用变量）。
- 注入点建议：`prepareExportHtml`（exporter.ts:445）或工厂 `wrapHtml`（exporter.ts:390 / exportRenderFactory.ts:89），保证 **HTML 导出与 PDF 工厂同源命中**，一次修复两个出口。
- 视觉基准：对齐编辑器内 `global.css:1605-1625` 的表现。

### 阶段 1：文本主路径矢量绘制
- `collectTextFragments`（exportPdfPipeline.ts:448）已产出逐字符位置与 advance。扩展为**按样式运行聚合**：相邻且 font-family/size/weight/style/color 一致的字符合并为一个运行，取 computed style 的实际渲染值（含颜色，暗色主题下注意转换为纸面颜色）。
- 在 `exportPdfAssembly.ts` 中把该运行从 Tr 3 隐形改为**正常可见 drawText**：正确 fill color、字号换算（CSS px → PDF pt，沿用现有换算）、基线定位用现有测量数据。
- 同一页面内**纯文本区域不再参与位图光栅**。

### 阶段 2：矢量装饰绘制
- 表格边框线/单元格背景、引用块竖线、代码块背景、hr 分割线、行内高亮背景 → `pdf-lib` 的 drawLine / drawRectangle（位置来自工厂 DOM 的 getBoundingClientRect，颜色来自 computed style）。
- 跨页表格断口：分页器输出处补充"断页补线"计算（页底画下边线、续页页首画（可选表头后）上边线）。

### 阶段 3：复杂块降级（局部光栅兜底）
- 公式块（KaTeX 嵌套 span + CSS 边框结构，逐 span 矢量化成本过高）、位图图片、SVG 图表、渲染异常块：**按块局部光栅**（复用 ChunkTrim 的小块裁剪思路，exportPdfPipeline.ts:655），以图片形式嵌入该块的占位矩形区域。
- 降级判定要显式、可统计（导出结果里报告降级块数/占比）。
- 图片本身走 pdf-lib embedPng/embedJpg 原生嵌入（不再是位图页的一部分）。

### 阶段 4：字体覆盖
- NotoSansSC-Regular 子集内嵌已通。补 **Bold / Italic 变体**的注册与运行匹配（按 weight/style 就近映射）。
- 用 fontkit 对每个运行的字符做 cmap 字形检测：缺字形（emoji、特殊符号）的运行整体降级局部光栅，或追加内嵌字体——二选一，报告说明取舍。

### 阶段 5：开关与自动回退
- 设置新增导出模式 `vector | raster`（默认 vector，沿用现有设置项风格 defaults.ts / store.ts）。
- vector 管线任何阶段失败 → 自动回退 raster 完成导出 + toast 告知，绝不丢导出。

## 六、硬约束（违反即返工）

1. **不引入** puppeteer / playwright / 无头浏览器 / jspdf；**不复活** window.print / printToPDF（wry#707 已退役）。
2. **不重写** `exportPaginator.ts` 纯函数分页器，只允许扩展（断页补线、表头重复钩子）；页数结果必须与改造前一致。
3. **不破坏** PNG 导出管线（exportPngPipeline.ts）与工厂共用代码。
4. 新逻辑优先写成纯函数并配 vitest 单测；UI/进度/取消链路沿用现有 ExportProgressDialog 机制。
5. 遵循仓库习惯：中文 commit message、分阶段提交（每阶段一个 commit + 一段简报）、CHANGELOG 更新。

## 七、交付物

- 每阶段的 commit + 简报（改了什么、为什么、怎么验的）。
- 结题报告 `docs/vector-pdf-export-report.md`：方案、各阶段实测（体积对比、页数一致性、降级块占比、400% 缩放截图）、遗留问题。
- CHANGELOG Unreleased 条目。
- 附注 Plan B（**只记录，不实施**）：若矢量保真度终验不达标，备选路线是 Rust 侧经 `with_webview` + webview2-com 调 WebView2 原生 PrintToPdf（Chromium 原生排版，仅 Windows，其他平台回退现有管线）——在报告中写明触发条件即可。

---

**执行顺序**：阶段 0 → 1 → 2 → 3 → 4 → 5，每阶段结束跑一遍第四节第 6 条回归再提交。开始前先读第二节列出的全部文件。
