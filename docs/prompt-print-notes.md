# 提示词与任务书：mditor 打印笔记（PR 轮）

> 用法：将本文件全文作为任务提示词投喂给编码 agent（如 ZCode / Claude Code），在 `mditor/` 项目根目录下执行。
>
> - **状态**：待执行
> - **日期**：2026-11-02
> - **基线**：main @ 07c5532（行号以该基线核验为准，开发时以符号名重新定位）
> - **范围决策**：已与用户确认（见 §三决策记录），执行中不得单方面扩缩范围
> - **前置阅读**：`docs/export-overhaul-report.md`（EX 轮——旧打印路径退役根因与本轮「不复活」铁律的出处）、`docs/prompt-word-pdf-editing.md`（DE 轮——docx mammoth 链与 readDocNoteBytes 副本纪律的复用出处）

---

## 一、角色与任务

你是 **mditor**（Tauri 2 + React 18 + Milkdown 7 + Vite 5，Windows/WebView2 优先，harmony 为第二平台）**打印功能的负责人**。MF/DE 轮已交付 pdf/docx/html 多格式笔记的只读预览与原位编辑，EX 轮已交付 md → docx/PDF/PNG/LaTeX 导出。本任务在此之上交付**打印笔记**：一个入口覆盖四种标签，把内容交给系统级打印设施（浏览器打印对话框或系统 PDF 阅读器），用户完成物理打印或「另存为 PDF」。

五条设计铁律，先记住再动手：

1. **应用内打印永不复活**：EX 轮已把 `printHtml`/0×0 iframe/`window.print` 整体退役（`be39beb`；根因 wry#707 静默限制 + RC-4 超大 DOM 打印超线性崩溃，见 `docs/export-overhaul-report.md`）。本轮打印**全部经系统级通道**：临时文件 + `openExternal`，应用自身 webview 内**禁止**出现任何 print 调用。唯一例外：生成的打印 HTML 内嵌的自动打印脚本——它运行在**用户的系统浏览器**里，不在本应用 webview 里，属边界外合法（§4.2）。该例外必须写代码注释指回本任务书，并用测试锚死（§六）。
2. **临时文件不污染用户可见目录**：只写 `$APPDATA/mditor/print/`（fs scope 已覆盖 `$APPDATA/**`，零权限改动）。**绝不**写入文档目录或工作区——`SYNCABLE_EXTS = {md, html, pdf, docx}`（`src/lib/sync/ignore.ts:42`）会把工作区里的打印副本当笔记同步，这是红线。启动时 best-effort 清理 48h 前旧件。
3. **原件神圣**：打印链只读。md 走 `getHTML()`、html 走 `readTextFile`、pdf/docx 走 `readDocNoteBytes`（**副本纪律**：缓存本体不可被 detach，消费方传副本——`src/lib/docNote.ts:105` 注释原文）。任何路径都不写回原文件。
4. **零新依赖**：`openExternal`（plugin-shell，适配层现成）、`appDataDir()`（适配层现成）、pdf 管线（EX 轮现成）全部复用。不引入任何 npm 包、不加 Rust 命令（唯一例外见 §七预案 A）。
5. **失败显式**：远程图抓取失败/未内联沿用导出链的显式列报语义（E-1「静默裂图」教训，`formatMissingImages` 现成）。浏览器启动失败、临时文件写入失败必须 toast，不静默吞掉。

## 二、现状与文件地图（已探明，无需重复探查，直接引用）

**导出链（打印的直接复用面）**

- `src/lib/exporter.ts`：
  - `ExportContext {html, css, docPath}`:337——打印上下文同构，直接复用；
  - `prepareExportHtml(ctx)`:452——S10 消毒 + 图片内联（remote:"fetch"，单图 15s 超时、并发 3、显式 missing 列表）——**浏览器通道与 PDF 通道共用的第一步**；
  - `wrapHtml(html, css, title, theme)`:362——standalone HTML 骨架；注意其中两段 print 相关注释（「打印默认丢背景色」说明与 `-webkit-print-color-adjust: exact` 规则，:389-391）——本轮 `wrapPrintHtml` 从此处派生，**共享 CSS 段提取为函数，不复制**；
  - `buildPdf(ctx, o)`:475——纯构建（消毒/内联/管线）返回 `{bytes, meta, missing}`，不落盘不弹框——**PDF 打印通道原样调用**；
  - `formatMissingImages`:308 / `markMissingImages`:277——列报与占位现成；
  - 顶部依赖纪律注释（:34 附近）：重组件一律函数内懒加载，首屏 bundle 零增量——打印模块同款纪律。
- `src/lib/exportPdfPipeline.ts`：`PdfPipelineOptions`:88（paper/marginMm/rasterScale/mode/signal/onProgress）；合法值域单一事实源 `PDF_PAPERS`:46 / `PDF_MARGIN_CHOICES`:53；`:4` 首行注释即「无 OS 打印对话框、无 window.print」铁律原文。

**设置（打印参数与通道的持久化载体）**

- `src/types.ts:245-258`：`exportPdfPaper: "A4"|"Letter"|"A3"` / `exportPdfMarginMm` / `exportPdfRasterScale` / `exportPdfMode`——打印直接复用这四键（纸张/边距与导出同源），**本轮只新增一个键** `printChannel`；
- `src/defaults.ts:211`：`exportPdfPaper: "A4"` 默认值锚点；
- `src/components/SettingsModal.tsx`：「导出」分区（EX 轮 U2）——打印通道单选挂进该分区。

**命令/菜单/快捷键（入口接线面）**

- `src/components/MenuBar.tsx:70-96`：文件菜单；caps 门控惯例见 `:86`（`caps.pdfExport ? [item(...)]`）——打印项同款门控；
- `src/hooks/useMenuCommands.ts`：导出命令分发 `:239-253`；`doExportRef` 转发惯例 `:55-56`（doExport 身份不稳定，调用时取最新实例）——本轮加同款 `doPrintRef`；键位处理 `case "p"` `:512-519`——**注意 `:514` 的注释「浏览器打印无默认快捷键冲突（Ctrl+P 在 WebView2 默认打印…）」已过时，本轮必须更新**；keydown 注册 `:557`；
- `src/App.tsx`：`doExport` `:2325`（md 通道的 HTML 预处理同序样板：减配补渲染 → 块公式 `renderBlockMath` → 双链/引用剥离，`:2352-2363`）；`doExportRef` `:2551`；`ExportProgressDialog` 挂载 `:3810`；多格式打开 `openDocNote` `:1273` / `openNoteAny` `:1311`。

**多格式笔记（四 kind 的内容源）**

- `src/lib/docNote.ts`：`readDocNoteBytes`:105（副本纪律）、`loadMammoth`:450（懒加载单例——docx 打印复用）、pdf/docx Tab 判别 `:49-56`；
- `src/lib/htmlNote.ts`：`isHtmlTab`:22 / `makeHtmlTab`:31（html Tab 的 `path` 即原文件路径）；
- `src/lib/noteKind.ts:18`：`isReadonlyTab`（打印分发只认 `TabItem.kind`，不碰只读语义）；
- `src/lib/imageManager.ts`：`cleanLocalRef` / `normalizeLocalPath`——html 通道相对图绝对化（§4.4）复用。

**平台适配与权限**

- `src/platform/types.ts:203`：`PlatformCapabilities`——新增 `print: boolean`；`:156` `appDataDir()` 现成；
- `src/platform/tauri/app.ts:78`：`appDataDir` 实现；`:95` `openExternal = shellOpen`；
- `src/platform/harmony/index.ts:201`：`openExternal` 桥存在；`:230-245`：MF/DE 轮「保守关」降级惯例（caps 置 false + 不假成功）——harmony `print: false` 沿用此惯例（临时目录虚拟路径语义 + ArkWeb 未真机验证）；
- `src-tauri/capabilities/default.json`：`shell:allow-open` 目前仅 url 白名单（https/http/mailto/tel，:30-37）——**本轮唯一权限改动：allow 列表加 `{ "path": "$APPDATA/**" }`**；fs:scope 已含 `$APPDATA/**`（:53-57），临时文件读写/清理零改动。

**其他事实**

- `src/components/ExportProgressDialog.tsx:22`：`{title, progress, onCancel}`——打印进度对话框复用（title「正在准备打印…」）；
- `src/lib/sync/ignore.ts:42`：`SYNCABLE_EXTS`——铁律 2 的工作区红线依据；
- grep 验证：当前 `src/` 内 `window.print` 零残留（EX 轮退役时已锚定）——本轮结束必须维持「仅打印模板一处」的状态（§六）。

## 三、目标与非目标

### 目标

| # | 目标 | 验收口径 |
|---|------|---------|
| G1 | 打印命令覆盖四种标签：菜单「打印…」+ Ctrl+Shift+P | md/html/docx 弹浏览器打印对话框（自动触发）；pdf 用系统默认阅读器打开原文件 |
| G2 | 双通道可选：`printChannel = browser（默认）/ pdf` | 设置「导出」分区可切换；pdf 通道产物与「导出 PDF」100% 同源（同一 buildPdf） |
| G3 | 打印参数复用导出设置（纸张/边距） | @page size/margin 与 exportPdfPaper/exportPdfMarginMm 联动 |
| G4 | 临时文件生命周期完整 | 只写 $APPDATA/mditor/print/；启动清理 48h 前旧件；工作区零污染 |
| G5 | 零新依赖、首屏零增量、harmony 门控关闭 | npm 依赖零变化；build 产物首屏 chunk 零增量；harmony 不渲染菜单项且键位 no-op |
| G6 | 铁律维持 | 应用 webview 内零 print 调用（测试锚定）；window.print 全仓仅打印模板一处 |

### 非目标（明确不做，防止范围蔓延）

- **不做** 应用内打印预览/打印对话框（wry#707 + RC-4 已判死，永不回头）；
- **不做** Windows print verb（`ShellExecuteW("print")` 静默直打）——依赖文件关联、失败模式不可观测，明确放弃；
- **不做** docx 原版式打印——mammoth 链版式按 mditor 样式（与 DE 轮编辑态同一保真边界），需要原版式时用户自行在 Word 里打印原文件；提示文案明示此边界；
- **不做** html 笔记的图片 base64 内联/主题重排——原样式原样交浏览器（§4.4 注入式方案），保真优先；
- **不做** 打印份数/打印机选择等对话框参数透传（系统打印对话框自己管）；
- **不做** harmony 打印（caps 门控关闭，降级为不渲染；真机验证留待后续轮次）；
- **不做** 批量打印、打印历史、打印水印。

### 范围决策记录（用户已确认，2026-11-02）

| 决策点 | 结论 |
|--------|------|
| 打印通道 | 双通道用户可选（默认浏览器，可切 PDF 通道） |
| 覆盖格式 | 全部四种（md/html/pdf/docx） |
| 快捷键 | 打印 = Ctrl+Shift+P；快速打开保持 Ctrl+P 不动 |

## 四、总体架构

### 4.1 命令入口与 kind 分发（新模块 `src/lib/printNote.ts`）

```
「打印…」菜单 / Ctrl+Shift+P / pdf·docx 视图工具栏按钮
  ↓ useMenuCommands case "file_print" → App.doPrint(activeTab)（doPrintRef 转发）
  ↓ 按 TabItem.kind 分发（printNote.ts 单一事实源）
  ├─ md    → ctx = {html: getHTML()+同序预处理, css: 主题 css, docPath} → §4.2/§4.3
  ├─ docx  → readDocNoteBytes 副本 → loadMammoth().convertToHtml（图片 data URL 内联，
  │          与 DE 轮 M2 同形态）→ 构造 ctx（css 同 md）→ §4.2/§4.3
  ├─ html  → readTextFile(原文件) → §4.4 注入式通道（不走 §4.2，保原样式）
  └─ pdf   → openExternal(原文件 path)——终态格式原样交系统阅读器，两通道同此行为
```

- `doPrint` 的 md 预处理**必须与 `doExport` 同序**（减配补渲染 → 块公式 → 双链/引用剥离，App.tsx:2352-2363）——建议把该预处理段从 doExport 抽成 `buildExportContext()` 复用，导出行为零变化（DE 轮 buildDocx 抽取同款手法）；
- ctrl 分发只认 `kind`，不触碰 `isReadonlyTab` / `docEdit` 语义（打印与只读/编辑态正交，编辑中的 pdf/docx 也照常打印原文件）。

### 4.2 浏览器通道（默认）：打印就绪 HTML

```
ctx ──prepareExportHtml（消毒 + 图片内联 + missing 列表）
    → wrapPrintHtml(html, {paper, marginMm, title})     ← 派生自 wrapHtml:362
    → 写 $APPDATA/mditor/print/<名>-print-<时间戳>.html
    → openExternal(path)  →  默认浏览器打开 → 自动弹打印对话框
```

`wrapPrintHtml` 要点：

- **共享段提取**：wrapHtml:362 的骨架（charset/viewport/title/body 容器/`vditor-reset`）与 EXPORT_PROSE_CSS 注入提取为共享函数，`wrapHtml` 与 `wrapPrintHtml` 同源——禁止复制 60 行后两处分头维护；
- **@page 映射**：`@page { size: <A4|letter|A3>; margin: <mm>mm; }`，值取自 `exportPdfPaper` / `exportPdfMarginMm`（CSS size 关键字大小写不敏感，Letter→letter 无碍）；
- **分页友好规则**（追加在共享 CSS 之后）：`pre, table, figure { break-inside: avoid; }`、`h1,h2,h3 { break-after: avoid; }`——块高超过一页时浏览器自动忽略 avoid，天然安全，无需 JS 测高；
- **恒浅色**：打印 HTML 固定浅色主题（不带 `data-theme` 深色值，CSS 变量退化到 `:root` 浅色兜底——wrapHtml:377-378 注释已写明该机制），物理打印省墨；wrapHtml 既有 `print-color-adjust: exact` 保留不动（浅色下无碍，且用户经浏览器「另存为 PDF」时保 mark 高亮底色）；
- **自动打印脚本**：注入
  ```html
  <script>
    /* mditor 打印模板：运行于用户系统浏览器，非应用 webview（PR 轮铁律例外，
       见 docs/prompt-print-notes.md §4.2）。sessionStorage 守卫防重开重复弹框。 */
    if (!sessionStorage.getItem("mditor-printed")) {
      sessionStorage.setItem("mditor-printed", "1");
      window.addEventListener("load", () => setTimeout(() => window.print(), 400));
    }
  </script>
  ```
  行为口径：同一标签页会话内不重复弹框；新开窗口/会话弹一次。Firefox 对 file:// 的 storage 有限制，退化为每次弹一次——可接受，手测项覆盖（§六）。

### 4.3 PDF 通道：复用 EX 管线

```
ctx ──buildPdf(ctx, { paper, marginMm, rasterScale, mode, signal, onProgress })   ← exporter.ts:475 原样
    → 写 $APPDATA/mditor/print/<名>-print-<时间戳>.pdf
    → openExternal(path) → 系统默认阅读器打开（用户在阅读器内打印）
```

- 产物与「导出 PDF」同源同参（同一 buildPdf、同一设置四键）——矢量模式/字体嵌入/分页全部白得；
- 与导出唯一差异：**无 pickSaveFile**（临时目录直写，命名防冲突），missing 列报同浏览器通道。

### 4.4 html 通道：注入式（保原文档样式）

html 笔记是完整 standalone 文档（自带样式），**不做主题重排、不做图片内联**：

```
原文件 readTextFile
  → 字符串级注入（零 DOM 解析）：
      </head> 前 → <style>@page + 分页友好规则</style>（§4.2 同款，无主题 CSS）
      </body> 前 → 自动打印脚本（§4.2 同款）
      （无 </head>/</body> 的残缺文档 → 追加到文档末尾，不报错）
  → 相对图片引用绝对化：<img src> 相对路径 → file:///<原文件目录>/…
      （字符串级替换，复用 imageManager 的 cleanLocalRef/normalizeLocalPath + docPath 解析；
        data:/asset:/blob:/http(s): 原样跳过）
  → 写临时副本 → openExternal
```

- 为什么绝对化而不是内联：临时副本在 `$APPDATA` 下，相对引用会指向错误目录；file:// 页面加载 file:// 图片在各浏览器均允许（被禁的是 fetch/XHR）；零 base64 开销；
- 注入与绝对化抽成纯函数 `injectPrintAssets(fullHtml, {paper, marginMm, docPath})`——vitest 直测（残缺文档/各类 src 形态）。

### 4.5 临时文件生命周期与进度 UX

- 目录：`appDataDir()/mditor/print/`（`platform types.ts:156` 现成；首用 `mkdir` 递归建）；
- 命名：`<文档基名去扩展名（清洗非法字符，对齐导出 suggestedName 惯例）>-print-<yyyyMMdd-HHmmss>.<html|pdf>`；
- 清理：App 启动时（一次性 useEffect）best-effort 删 48h 前旧件（`fs.readDir` + `stat` + `remove`，$APPDATA scope 内全合法；失败仅 console.warn）；
- 进度对话框：md/docx × 浏览器通道（图片内联可秒级）与 × PDF 通道（逐页）复用 `ExportProgressDialog`，title「正在准备打印…」，onCancel 接 AbortController（取消 = 放弃打开；内联阶段本身不可中断，与 HTML 导出同语义）；html/pdf kind 瞬时完成，不弹进度；
- 列报：`missing` 非空时 toast `formatMissingImages` 结果（与导出同文案），打印照常进行（占位由 `markMissingImages` 保证）。

### 4.6 设置与能力门控

- 新设置键 `printChannel: "browser" | "pdf"`（默认 `"browser"`）：types.ts / defaults.ts / SettingsModal「导出」分区单选三处落地；合法值域常量 `PRINT_CHANNELS` 放 printNote.ts（对齐 PDF_PAPERS 单一事实源惯例）；settingsNormalize 若需值域校验，对齐现有枚举键处理；
- `PlatformCapabilities.print`：tauri = true；harmony = false（保守关惯例，注释写明「临时目录虚拟路径语义 + openExternal(file) 未真机验证」）；
- 菜单项：`...(caps.print ? [item("file_print", "打印…", "Ctrl+Shift+P")] : [])`，放「导出」组之后、`app_exit` 的 sep 前；
- 键位：useMenuCommands `case "p"` 加 shift 分支——`Ctrl+Shift+P → dispatchMenuRef.current("file_print")`，普通 Ctrl+P 保持快速打开；**同步更新 :514 过时注释**；dispatch 处若 `!caps.print` 直接 return；实现前 grep 全仓 `shiftKey` 与 Milkdown/CodeMirror 默认键位确认 Ctrl+Shift+P 无冲突（已知无，核实留痕即可）。

## 五、里程碑

| 阶段 | 内容 | 出口判据 |
|------|------|---------|
| M1 打印底座 | printNote.ts（wrapPrintHtml / injectPrintAssets / 建目录 / 写临时 / openExternal / 清理 / PRINT_CHANNELS）+ capabilities shell scope 加一行 + caps.print 两平台 | vitest 纯函数面全绿；`npm run build` 过；手测：临时 HTML 手动 openExternal 能弹浏览器打印框（通道可行性第一步验证） |
| M2 入口接线 | buildExportContext 抽取（导出零变化回归）+ App.doPrint/doPrintRef + useMenuCommands（file_print / case "p" 分支 / 注释更新）+ MenuBar 菜单项 + 四 kind 分发 + 进度对话框 + missing 列报 | 四种标签各打印一次全通（桌面手测）；md 主线导出回归零失败 |
| M3 设置面 | printChannel 三处落地 + SettingsModal 单选 + normalize 锚点 | 切换通道后两种产物分别手测通过；设置持久化往返 |
| M4 收尾 | CHANGELOG（根因/方案/锚点条目）+ README 功能清单行 + `docs/print-notes-report.md`（手测记录）+ site What's New 条目（对齐下个 release） | 全仓 grep 门禁（§六）+ tsc/eslint/vitest/build 全绿 |

## 六、验收标准

**代码门禁（CI 可跑）**

1. `npx tsc --noEmit` / `npm run lint` / `npm run test` / `npm run build` 全绿；首屏 chunk 零增量（打印模块从 App 动态 import，对齐 exporter 懒加载纪律——打印链里 mammoth 经 loadMammoth、pdf 管线经 buildPdf 内部均已懒加载，printNote.ts 自身保持轻）；
2. **铁律锚点测试**（新 `src/lib/printNote.test.ts` 内或独立 `printIronRule.test.ts`）：扫描 `src/**/*.{ts,tsx}` 源码，断言 `window.print` 字面量**仅**出现在 printNote.ts 的打印模板一处，且该处注释包含「应用 webview 外」指回本任务书的说明——EX 轮「grep 零残留，注释存档」惯例的加强版；
3. 纯函数直测：wrapPrintHtml（@page 映射/浅色化/脚本注入/与 wrapHtml 共享段不漂移）、injectPrintAssets（残缺文档/相对·绝对·data·http src 各形态）、kind→通道分发矩阵、临时文件名清洗与冲突；
4. settingsNormalize 锚点补齐；capabilities/default.json 若有 pinning 测试同步更新。

**桌面手测清单（Windows/WebView2，M4 固化进 report）**

1. md（含图片/公式/代码块/表格/深色主题）→ 默认浏览器（Edge 与 Chrome 各一）打开并自动弹打印框；打印预览分页正确（代码块不拦腰截断、标题不悬空）；
2. 同一浏览器标签页重开临时文件**不**重复弹框（sessionStorage 守卫）；Firefox 退化行为确认（每次弹一次，可接受）；
3. html 笔记（含相对图片的保存网页）→ 原样式完整、相对图显示、打印框弹出；
4. docx 笔记 → mammoth 版式打印可用；文案明示「版式按 mditor 样式」；
5. pdf 笔记 → 系统默认阅读器打开原文件；
6. `printChannel = pdf` → md/docx 产物与「导出 PDF」逐字节同源同观感（同设置下）；
7. 远程图断网 → missing toast 列报 + 占位框，打印不被阻断；
8. Ctrl+P 仍开快速打开、Ctrl+Shift+P 打印、互不干扰；harmony 构建 `npm run build:harmony` 通过且菜单无打印项；
9. 工作区目录全程无新文件（铁律 2）；重启应用后 48h 前旧打印件被清理。

## 七、风险与预案

| 风险 | 判据 | 预案 |
|------|------|------|
| A. shell:allow-open 的 `path` scope 条目在真机上不放行 file 打开 | M1 手测第 1 步即失败 | 预案 A（唯一允许的 Rust 改动）：`src-tauri` 增一条透传命令 `open_print_file(path)` 走 tauri-plugin-opener 或 plugin-shell Rust API 直开；仍是零 npm 依赖，权限面反而更小（不动 capabilities）。失败证据截图入库 report |
| B. 超大文档（1MB+ md，KaTeX 膨胀 ~15×）浏览器打开即卡 | RC-4 同款输入手测 | 浏览器通道文档化为「超大文档建议 PDF 通道」（pdf 管线分块光栅已消化该档位）；不在本轮做页数预估告警 |
| C. 用户默认浏览器是 IE 式怪 associations（.html 关联到编辑器） | openExternal 打开非浏览器 | 不防御——系统级打印契约本就依赖默认浏览器；report 记录已知边界 |
| D. 临时目录被用户手动清理/杀软拦截 | 写入/打开抛错 | try/catch → toast 显式报错（铁律 5），不静默 |
