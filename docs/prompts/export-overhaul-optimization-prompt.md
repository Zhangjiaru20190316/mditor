# 任务：mditor 导出体系全面翻新——PDF 自研管线重建与全格式完整性专项（EX 轮）

> 使用方式：本任务书配套 `/goal` 命令交付（目标文本见下方代码块，直接粘贴）。前端代码在 `mditor/` 子目录，所有 `perf/` 与 `npm` 命令在 `mditor/` 下运行。核心环节分阶段推进（§6），每阶段证据落盘（`perf/results/` 与报告草稿）并自查后才进下一阶段。动手前必读第 0、1、2、3、5 节——本任务禁止盲改，禁止重修已修问题，禁止预设根因结论之外扩大范围。
>
> ```text
> /goal 翻新 mditor 导出体系（EX 轮，范围：PDF 自研管线重建 + 全格式共享管线完整性修复 + PNG 离屏工厂化 + DOCX 图片可靠性显式化 + 导出设置持久化）。任务书：docs/prompts/export-overhaul-optimization-prompt.md——先通读全文并遵守 §0 基线核实、§2 已查明事实集不重查、§3 禁区与红线，在 mditor/ 子目录下按 §6 阶段顺序执行，禁止盲改。完成判据（全部满足才 pass）：① 完整性主门——PDF 分页导出零截断（产物页数与分页器计算一致、首尾块内容完整），密度档 fixture 2,355 行内公式在默认/cv/减配三档下导出 100% 渲染态、零 $ 源码残留，未内联图片显式列报而非静默裂图；② 自有 UI 门——导出全链路应用内完成，零 OS 打印对话框（win.print 路径退役），自有进度 UI 可视、可取消、可回收；③ 文本层原型门 EX-P——隐形文本层对位偏差 ≤0.25×字号、CJK 字体子集内嵌方案与授权落定，不过门则回退纯光栅化并请用户拍板，不许为救文本层牺牲完整性主门；④ 零回归——npm test ≥997 全绿（以实跑基线为准），编辑器热路径模块（lazyInlineMath/cvMemory/渲染泵）diff 为零，HTML/DOCX/LaTeX 现有输出契约不变；⑤ 交付——报告落盘 mditor/docs/export-overhaul-report.md（根因定罪数据 + 原型比选数据 + 门禁实测表 + 未达项归因），每修复项独立 Fix commit 且附新增测试，CHANGELOG Unreleased 与 memory 日记更新。红线：禁 window.print()/系统打印对话框（唯一允许的系统交互 = pickSaveFile 保存路径选择）；KaTeX 0.18.4 单实例与宏语义不动；S10 消毒门保留在所有新路径；新增依赖一律懒加载；观测与修复分开 commit；每 commit 前 npm test；先测后改、一次一项、原型先行。
> ```
>
> 前序引用链（体例连续，背景可查）：`docs/prompts/large-doc-perf-optimization-prompt.md`（第三轮，已结题，任务书体例蓝本）、`docs/prompts/large-doc-formula-render-optimization-prompt.md`（第六轮，已结题——公式渲染完整性成果为本轮不可回退前提）、`memory/2026-09-18.md`（上轮「PDF 导出内容不对」修复：主题丢失白纸白字 + 图片空白 + 假 pickSaveFile；其遗留的「手动真机验收待用户」正是本轮症状的报障入口）、`mditor/CHANGELOG.md:1369`（wry#707 静默导出限制的历史记载，本轮将其绕开而非等待）。
>
> 【填写】观察环境（用户 2026-10-10 已答部分，其余待补）：症状形态已钉死为 **E-1 图片缺失或裂图 + E-2 边缘内容被裁切**（多选作答；整体截断与公式源码化未报，但 RC-4/RC-5 为代码静态核实确认的潜伏根因，阶段一仍须在 fixture 上复测钉死）。待补：___ 观察版本（dev/main HEAD `7d3acf8` 还是打包 v5.0.1-beta）；___ 主战场文档（是否开着「大文档性能模式」总开关——直接决定 RC-5 减配档公式丢失是否在实机活跃）；___ E-2 具体形态（左右边缘还是页尾被裁、固定复现还是随打印对话框设置变化）。

## 0. 基线状态声明（执行第一步必须核实，禁止假设）

本任务书基于 2026-10-10 仓库状态撰写：

- HEAD = `7d3acf8`（docs(perf): R10 结题报告与文档同步——数据门全过）。**执行第一步**：`git status` + `git log --oneline -5`，据实记录 HEAD 相对 `7d3acf8` 的实际状态，报告开头声明；后续一切论述以核实后的代码为准。
- npm test 基线：R10 收尾 **997 全绿**（以实跑为准，执行第一步实跑 `npm test` 记录确数；导出现有测试仅 `src/lib/exporter.test.ts` 6 例 + `exportMath.test.ts` / `exportSanitize.test.ts` / `exportLatex.test.ts`）。
- fixture 在位性（本地化惯例，整目录 gitignore）：`mditor/perf/fixtures/` 应含 `无穷级数_密度档压测副本.md`（约 105K 字符 / 2,355 行内公式）、`解题技巧_密度档切换副本.md`（约 60KB / 778 公式）、`一元微分学习题集_1MB压测副本.md`。执行时先 `ls perf/fixtures/` 确认，缺失则按第四轮报告 §2 重建规格从 `E:/笔记/cmc` 源复制。导出验收语料另加 `mditor/docs/demo.md`（全语法覆盖的导出验收文档惯例）与至少一份**多图文档**（含本地大图 >10MB、远程 http 图、动图各至少一张——E-1 复现弹药；可由 demo.md 扩充构造，落 `perf/fixtures/` 同目录）。
- 导出计时基建已在位：`mditor/perf/bench-export-search-save.mjs`（renderBlockMath / juice / htmlToDocx / 公式栅格化分段计时），本轮扩展而非另起炉灶。
- 版本核实（先于一切修复）：确认用户观察 E-1/E-2 的实例是 dev/main 还是打包版；两版本导出代码如有差异（2026-09-18 修复是否已进打包版）须先钉死，报告 §1 写明。

## 1. 角色与主战场

你是资深桌面文档应用导出引擎工程师，熟悉 Chromium 打印管线与 print CSS 的不可控面、Canvas 画布预算与光栅化 DPI 语义、PDF 内容流（文本渲染模式 Tr 3 / 字体子集内嵌）、CSS 分页语义（break-inside / orphan / widow）与 Tauri WebView2 环境约束。**本轮性质：不是给旧打印路径打补丁，而是把 PDF 生成从「借道 OS 打印对话框」整体迁到「应用内自研管线」，并顺带清偿全格式共享管线的完整性欠账。**

症状钉死（定义，禁止扩大或偷换）：

- **症状 E-1（图片缺失/裂图）**：导出 PDF 中图片位置空白或显示裂图占位，文字内容正常。区别于 HTML 导出里用户主动选「保留引用」后的正常相对路径行为（那是文档化语义，不是缺陷）。
- **症状 E-2（边缘内容被裁切）**：导出 PDF 页面左右边缘或页尾内容被切掉一部分。根因在「系统打印对话框的边距/缩放/纸张设置应用完全不可控」（RC-1），换自研管线后该症状类应**结构性消失**——这是本轮架构重建的直接收益，也是验收 E-2 的方式（复现文档在新管线下零裁切，而非逐案微调边距）。

用户铁律（本轮立论基础，最高优先级）：**导出的界面与生成逻辑全部自研，不调用系统功能**——即导出全链路（渲染、分页、光栅化、PDF 组装、进度 UI）在应用内完成，`window.print()` / iframe print / OS 打印对话框一律退役。唯一保留的系统交互是最终保存路径选择（`pickSaveFile`，各格式现行惯例，属于「选文件落盘」而非「导出生成」）。

主战场文档三类：① 密度档 fixture（公式完整性靶场）；② 1MB 压测文档（超长文档分块与内存靶场）；③ 多图文档（E-1 靶场）。三战场各钉各的，只测一类的结论无效。

范围界定（全格式全面翻新，用户拍板）：PDF 自研管线重建（核心）+ 共享管线修复（图片内联强化、资源就绪确定性、减配档公式丢失，全格式受益）+ PNG 改走离屏工厂（修懒渲染占位入图）+ DOCX 图片可靠性显式化（P1 遗留至少从「静默丢图」变为「显式报告」，sidecar 方案评估后拍板）+ 导出设置持久化（纸张/边距/DPI）。不在范围：编辑器渲染架构任何改动（§3 红线 4）、LaTeX 导出逻辑（纯前端 md→tex 契约不变，仅防回归）、打印到物理打印机功能（如需保留「打印…」独立菜单项，属待拍板项，见 §3）。

## 2. 已查明事实集（直接采用，不要重查；行号静态核实于 HEAD `7d3acf8`，执行时以仓库实际为准）

### 2.A 现行导出管线全链路

编排层 `src/App.tsx` `doExport`（:1573-1679）：`ed.getHTML()`（:1594）→ 非 PNG 时 `renderBlockMath`（块公式补渲染，:1600-1602）+ DOCX 专用 `rasterizeFormulas`（公式栅格化，:1603-1607）→ 双链/引用/闪卡降级（:1608-1626）→ `collectThemeCss()`（:1628）→ 按格式分发（:1639-1670）。PNG 分支截实时 DOM `ed.previewEl()`（:1657）；PDF 分支文案自认「若未在对话框中另存为 PDF 则未导出」（:1648-1652）。

实现层 `src/lib/exporter.ts`（导出唯一实现模块，头注 :1-21 自述各格式策略）：

- `inlineLocalImages`（:49-109）：本地图片（相对/绝对路径）读盘转 base64。三重静默降级门——单图 >10MB（:86 `INLINE_IMG_MAX_BYTES`）、魔数嗅探失败（:90-91）、总预算 64MB（:92 `INLINE_IMG_TOTAL_BUDGET`）一律**保留原引用**；**远程 http(s) 图永不内联**（:75 直接 continue）。失败无任何用户可见报告（注释自述「失败静默降级」）。
- `wrapHtml`（:126-157）：独立文档包装，回写 `data-theme`、`body { max-width: 820px; margin: 40px auto; }`（:144）、`@media print { print-color-adjust: exact }`（:148-150）。
- `exportPdf`（:210-226）：sanitize → inlineLocalImages → `printHtml(wrapHtml(...))`。
- `printHtml`（:230-319，本轮退役对象）：**0×0 隐藏 iframe**（:233-237）+ `document.write(fullHtml)`（:315-317）→ 等 `doc.fonts.ready` + 全部 `<img>` complete，**总上限 5 秒**（:276-278 `resWaitTimer`）→ 再固定等 50ms（:284）→ `win.print()`（:291）唤起 OS 打印对话框，用户手动选「另存为 PDF」→ `afterprint` 后 resolve（兜底 300s，:292）。头注 :10-12 与 CHANGELOG:1369 记载：真静默导出受 wry#707 限制（历史结论，本轮以自研管线绕开，**不需要也不应该去改 Rust/wry**）。
- `exportPng`（:327-377）：`modern-screenshot` 的 `domToPng` 截**实时 DOM**，画布预算门 `MAX_CANVAS_SIDE=16384` / `MAX_CANVAS_PIXELS=120MP` + scale 步降（:342-365）——预算治理惯例直接复用。
- `exportDocx`（:391-419）：juice 内联 CSS + `@turbodocx/html-to-docx`；头注 :386-389 自认浏览器构建无 sharp、图片可能被转换器静默丢弃，P1 备选是 sidecar/Node 子进程。
- `exportLatexFile`（:429-441）：纯前端 md→tex，铁律「不调 pandoc」，本轮不动。
- 依赖纪律（头注 :27-30）：modern-screenshot / juice / html-to-docx 全部函数内懒加载，防止 2MB+ 导出包进首屏——**本轮新增依赖必须沿此惯例**。

辅助模块：`exportMath.ts`（`PRE_RE` :36 只认 `<pre data-language="LaTeX">` 形态；`renderBlockMath` :56；`rasterizeFormulas` :123；`inlineKatexFonts` :181 KaTeX woff2→base64，HTML 落盘用）；`themeCss.ts` `collectThemeCss`（:8，遍历 `document.styleSheets` 收集整包 CSS——导出产物与编辑器同源样式的单一事实源）；`exportSanitize.ts` `sanitizeExportHtml`（:39，deny-list 消毒，S10 红线载体）。

入口：`MenuBar.tsx`（:84-90 菜单项，PDF 受 `caps.pdfExport` 门控）、`useMenuCommands.ts`（:203-216）、`src-tauri/src/lib.rs`（:260-263 原生菜单）。能力位：`platform/types.ts:214`；Windows/Tauri `true`（tauri/index.ts:15）；**鸿蒙 `false`**（harmony/index.ts:226，注释「待真机 spike：iframe print 能否唤起系统打印」——新管线为纯前端，不依赖打印对话框，该能力位具备翻 true 的条件，阶段五评估）。

### 2.B 根因清单（RC-1/RC-2 已由用户报障定罪为活跃症状的根因；RC-3~RC-6 为静态核实确认、阶段一须复测钉死的潜伏根因。禁止预设「全部同时活跃」，逐项取证）

- **RC-1（E-2 主犯，结构性）系统打印对话框不可控**。`win.print()` 后边距/缩放/纸张全由 OS 对话框与会话记忆决定：`wrapHtml` 的 `body max-width: 820px`（约 8.6in @96dpi）宽于 A4 默认可打印宽度（8.27in − 2×默认边距 ≈ 7.5in），对话框缩放 >100% 或边距较宽时左右内容被裁；页尾同理。应用侧无任何控制点。**修法即架构重建**：自研分页管线自控纸张与边距（内容宽 = 纸宽 − 边距，按构造不可能再裁边）。
- **RC-2（E-1 主犯）图片内联静默降级 + iframe 相对引用必 404**。超预算/嗅探失败/远程图保留原引用（2.A 第一条），而打印 iframe 里相对路径没有文档基准目录（exporter.ts:216-218 注释自认「必然 404，打出来是裂图/空白」）；`asset:` 与远程引用在 iframe 内能加载但受 RC-3 时限约束。用户全程不知哪些图没进来。
- **RC-3（E-1 帮凶）5 秒资源盲等**。`imgsReady`/`fontsReady` 与 5s `deadline` race（:265-279），慢图/慢字体超时**照打不误**——大文档多图或远程图慢时直接产出缺图缺字 PDF，且无任何提示。
- **RC-4（潜伏，待复现）超大 HTML 打印管线截断**。64MB 级 base64 + 数万 KaTeX 节点写进 0×0 iframe 再 print，WebView2 打印管线分页渲染可能截断/超时，现行代码无守卫、无错误上报路径。症状形态为「整体截断/缺尾部」，用户未报，但 1MB 级文档上须阶段一专项复测。
- **RC-5（潜伏，全格式）减配档公式导出为源码**。「大文档性能模式」总开关开 + 超阈值（`memory.ts` `BIG_DOC_LINES=3000` / `BIG_DOC_BYTES=500_000` / `BIG_DOC_MATH_DOLLARS=800`）时 Crepe 以 `[Crepe.Feature.Latex]: !big` 建实例（`useMilkdown.ts:719`）——公式在 ProseMirror 模型里就是普通文本，`getHTML()` 输出 `$...$` 源码，且 `renderBlockMath` 的 `PRE_RE`（只认 `<pre data-language="LaTeX">`）匹配不到，无法补渲染。PDF/HTML/DOCX/复制富文本全格式覆没。用户未报此形态（可能未开总开关或文档未超阈值），但这是静态核实确认的缺陷，属本轮共享管线修复范围。
- **RC-6（PNG 专属）实时 DOM 截图继承懒渲染状态**。`exportPng` 截 `previewEl()` 实时 DOM：cv 档下行内公式懒渲染占位（源码文本）、`loading="lazy"` 未加载图片直接进图（`imageLazy.ts`；该文件 :5-6 红线「deliberately do NOT virtualize the editor body」是编辑器侧定案，与导出侧无关）。长文档 PNG 的公式区今天是坏的。

### 2.C 与编辑器渲染架构的关系（为什么重建管线不碰编辑器）

`getHTML()` 走 ProseMirror `DOMSerializer` 模型序列化（`@milkdown/utils` getHTML），**不读实时 DOM**——cv 档 content-visibility、行内公式懒渲染占位、图片 lazy 属性均不进序列化结果。故 PDF/HTML/DOCX 的 HTML 源不受编辑器虚拟化影响（RC-5 减配档是唯一例外，因为模型本身就没解析公式）。结论：**导出侧问题在导出侧修**——离屏渲染工厂是独立容器/实例，编辑器热路径零触碰（§3 红线 4）。可复用蓝本：sv 模式已有「隐藏全功能 Crepe 实例做序列化」的先例（`useMilkdown.ts:1306-1339`，含单条目签名缓存）；执行者须先核实该隐藏实例的创建是否同样走 big 减配（若是，导出需要独立的全功能渲染路径，而非复用该实例）。

### 2.D 可复用资产清单

| 资产 | 位置 | 本轮用法 |
|---|---|---|
| PM 模型序列化 getHTML | useMilkdown.ts:1306 | 全格式 HTML 源，不动 |
| 块公式补渲染 renderBlockMath | exportMath.ts:56 | 共享预处理保留，RC-5 修复扩展其覆盖面 |
| 整包主题 CSS collectThemeCss | themeCss.ts:8 | 离屏工厂样式源，保证产物与编辑器视觉同源 |
| KaTeX 字体内嵌 inlineKatexFonts | exportMath.ts:181 | 应用内 iframe 无需（字体按应用源解析，exporter.ts:186-188 注释），落盘 HTML 继续 |
| modern-screenshot domToPng | exportPng 现用 | 离屏工厂光栅化引擎，画布预算步降逻辑（:342-365）移植为分块策略 |
| S10 消毒门 sanitizeExportHtml | exportSanitize.ts:39 | 所有新路径输入侧强制保留 |
| saveAs 落盘（pickSaveFile + fs.writeFile） | exporter.ts 各导出函数 | PDF 新管线落盘沿惯例 |
| 导出计时基准 | perf/bench-export-search-save.mjs | 扩展分阶段计时，不另起炉灶 |
| 全语法验收文档 | mditor/docs/demo.md | Q2 视觉保真人工验收语料 |

### 2.E 技术选型已知事实（原型比选的起点，不是结论）

- `package.json` 现无任何 PDF 库（无 jspdf/pdf-lib/fontkit）；`katex` 钉死 `0.18.4`（package.json:8 overrides，红线 2 载体）。
- **文本层的 CJK 字体是硬骨头**：PDF 标准字体不含 CJK；jsPDF 无内建子集化（整 TTF 内嵌，中文字体 +10~20MB/文件）；pdf-lib + @pdf-lib/fontkit 支持 `subset: true` 子集内嵌（常用字子集后数十 KB 级）。字源与授权（打包内置 OFL 开源中文字体 vs 读系统字体——微软雅黑不可再分发）必须在原型阶段调研拍板，**授权不清不许上线**（EX-P 门槛之一）。
- 隐形文本层原理：文本渲染模式 Tr 3（invisible）+ 逐段定位铺字；定位数据用 Range/`getClientRects` 从离屏工厂的已布局 DOM 实测，视觉层是光栅图，两层独立。

## 3. 禁区与红线

1. **禁系统打印**：`window.print()` / iframe print / OS 打印对话框在导出链路退役（用户铁律）。唯一系统交互 = `pickSaveFile`。待拍板：是否保留一个独立「打印…」菜单项走旧 print 路径（物理打印场景），默认**不保留**（彻底移除），用户评审时拍板。
2. **KaTeX 0.18.4 单实例与宏语义不动**（沿承历轮红线）。离屏工厂的公式渲染复用应用内同源 KaTeX CSS/字体解析路径，不得引入第二 KaTeX 版本。
3. **S10 消毒门保留在所有新路径**：离屏工厂输入、PDF 组装输入、PNG 工厂输入一律先 `sanitizeExportHtml`。
4. **编辑器热路径零触碰**：`lazyInlineMath.ts` / `cvMemory.ts` / 渲染泵 / `imageLazy.ts` / global.css cv 档规则等 R1-R10 成果模块 diff 必须为零；导出问题禁止以改编辑器渲染架构来修。离屏渲染工厂必须是独立 iframe/容器（其内部想怎么强制渲染都行，不影响编辑器实例）。
5. **npm test ≥997 零回退**；`exporter.test.ts` 现有 6 例锁定的 wrapHtml 行为（data-theme/print-color-adjust/转义）不破坏；HTML/DOCX/LaTeX 输出契约不变。
6. **未拍板不改用户可见默认值**：内联预算数值、新管线默认纸张/边距/DPI 列表化请用户拍板后方可作为默认；5s/50ms/300s 定时器随 printHtml 退役，替代方案的超时策略须文档化。
7. **新增依赖一律懒加载**（exporter.ts:27-30 惯例），且新增前在报告记录包体积影响。
8. **观测与修复分开 commit；每 commit 前 npm test；先测后改、一次一项、原型先行**（§8）。

## 4. 可量化目标（门禁表；判分：C 组与 U1/Q1 必须有本机数据，Q3/T 组首轮立基线后拍板硬门，R 组全部零回归；未达项附归因，不许留空）

### C 组：完整性（本轮主门，用户症状直接对应）

| # | 指标 | 已知基线 | 目标 | 测量 |
|---|---|---|---|---|
| C1 | PDF 零截断：产物页数 = 分页器计算页数；文档首块与末块内容均在产物中 | 旧路径无此口径（RC-4 潜伏） | **= 0 截断**（密度档 / 1MB / 多图三 fixture 各 ≥3 轮） | 新增导出验证脚本（perf/ 下，解析产物页数 + 文本层首尾块抽检；光栅页抽检首页/中页/末页 PNG） |
| C2 | 图片完整性：预算内本地图片 100% 内联进产物；未内联项（超预算/远程失败/嗅探失败）在导出结果 UI **显式列出清单**，产物内不允许静默裂图（占位标注或中止导出，阶段二拍板二选一） | 静默降级，用户不知情 | 100% / 全量列报 | 多图 fixture：产物中 `<img>` 全部可见；未内联清单与预期清单一致 |
| C3 | 公式完整性：默认 / cv / 减配三档下导出产物中公式 100% 渲染态（KaTeX 标记），`$` 源码残留 = 0 | 减配档全量源码化（RC-5） | **三档 × PDF/HTML 双格式全过**（密度档 2,355 行内公式 + demo.md 全语法） | 产物扫描 `$`/`$$` 残留计数 + KaTeX 节点计数比对 |
| C4 | 全格式回归：HTML / PNG / DOCX / LaTeX 输出契约不变 | exporter.test.ts 等 4 套件 | 全绿 + 新增用例全绿 | `npm test` + demo.md 逐格式人工抽检 |

### U 组：自有 UI（用户铁律的验收形态）

| # | 指标 | 目标 | 测量 |
|---|---|---|---|
| U1 | 导出全程零 OS 打印对话框；自有进度 UI 覆盖各阶段（HTML 构建 → 图片内联 x/y → 渲染 → 分页 → 光栅化 页 x/y → 组装落盘），可取消，取消/失败后无残留（iframe/容器/定时器回收，沿 printHtml 幂等回收注释惯例） | 全程零系统弹窗（pickSaveFile 除外）；取消后可立即重复导出 | 手动验收 + 内存无泄漏抽查（连续导出 3 次观察 devtools 内存） |
| U2 | 导出设置持久化：纸张（A4/Letter/A3）、页边距、DPI/缩放档持久化（settings 管线），默认值经拍板 | 设置生效且重开应用保留 | 手动验收 |

### Q 组：PDF 质量

| # | 指标 | 目标 | 测量 |
|---|---|---|---|
| Q1 | 文本层对位（EX-P 原型门指标）：PDF 阅读器中选中文字与光栅视觉对位偏差 | ≤0.25×字号（中英文混排、上下标、表格内文本各测） | 原型产物在 Edge/Acrobat 中逐字符选区与视觉字形重合度人工判定 + 程序化抽检（生成侧 rect 与铺字坐标差） |
| Q2 | 视觉保真：导出页与编辑器渲染逐块比对（主题/公式/图片/代码高亮/表格） | 无肉眼可见差异 | demo.md 全语法人工验收（明暗双主题） |
| Q3 | 文件大小与时长：整本 PDF 大小、全链路分阶段时长 | 首轮立基线并记录（预研参考：2x 光栅文本页数百 KB/页量级），硬门由基线数据请用户拍板 | bench 扩展 + 产物体积记录，密度档/1MB 双 fixture |

### T 组：性能与资源（首轮立基线，不设拍板前硬门）

| # | 指标 | 目标 | 测量 |
|---|---|---|---|
| T1 | 1MB 文档导出全链路时长（分阶段） | 基线化，报告记录瓶颈归因 | perf/ 导出基准扩展 |
| T2 | 峰值内存受控：单画布 ≤120MP 预算（沿 exportPng 惯例），分块光栅化（渲染-截图-释放），整程无 OOM/白画布 | 1MB fixture 导出全程无画布预算违规 | 画布尺寸断言 + 产物完整性抽检 |

### R 组：防回归（全部零回归）

| # | 指标 | 基线 | 测量 |
|---|---|---|---|
| R1 | 全量测试 | 997（以实跑为准） | `npm test` 每 commit 前；收尾 `npm run test:coverage` + `npm run lint` + `npm run build` |
| R2 | 编辑器热路径 diff 为零 | — | `git diff --stat` 核对 lazyInlineMath/cvMemory/imageLazy/global.css 等模块（§3 红线 4 清单） |
| R3 | CI 全绿 | — | `.github/workflows/ci.yml` |

## 5. 目标架构与技术决策（含原型门 EX-P）

目标管线（共享前段 + 格式分支）：

```
getHTML()（PM 模型序列化；RC-5 修复后减配档导出亦得全功能渲染结果）
  → 共享预处理：sanitize（S10）→ 块公式补渲染 → 双链/引用/闪卡降级
  → 图片内联强化：本地图（预算策略化）+ 远程图 fetch→dataURL（超时可配；CORS 受阻时评估 Rust 侧 http 命令——应用自身能力，不属「系统功能」禁区）
      └─ 未内联清单 → 显式报告给导出 UI（C2）
  → 离屏渲染工厂（新模块，如 lib/exportRenderFactory.ts）：
      wrapHtml + collectThemeCss → 独立 iframe，真实内容宽度 = 纸宽 − 边距（非 0×0，保证真实布局）
      → 资源确定性就绪：逐图/逐字体跟踪 + 进度事件 + 可取消（替代 5s 盲等，超时策略文档化）
      ├─ PDF：自研分页器（纯函数：块级断点，公式/图/代码块 keep-together，表格行级断，孤儿寡妇控制）
      │     → 分块光栅化（画布预算内「渲染一批页 → 截图 → 释放」循环，modern-screenshot）
      │     → PDF 组装：每页位图 + 隐形文本层（Range 实测 rect → Tr 3 铺字，CJK 子集内嵌）
      │     → pickSaveFile 落盘
      ├─ PNG：同一工厂渲染完整文档 → 分块截图 → 纵向拼接或分段导出（修 RC-6，且不再依赖预览模式）
      ├─ HTML：现行写盘路径不动（自然受益于共享修复）
      └─ DOCX：现行转换路径不动 + 图片转换失败显式化（sidecar 方案评估后拍板是否本轮做）
```

技术决策点（原型数据拍板，报告记录理由）：

- **D-1 组装库**：jsPDF vs pdf-lib+fontkit。已知倾向：文本层 CJK 子集内嵌刚需 favors pdf-lib（jsPDF 无子集化，EX-2.C 事实）；最终以原型双跑 demo 页的「文件大小/生成时长/隐形文字 API 可用性」数据拍板。
- **D-2 文本层粒度**：逐字符 vs 逐词 run（CJK 逐字、拉丁逐词分治是候选）；以 Q1 对位数据拍板。性能护栏：1MB 级文档铺字操作数与生成时长必须在原型测出，超护栏则粒度降档。
- **D-3 原型门 EX-P**（阶段三核心）：文本层三指标——①Q1 对位；②文件大小增量（子集字体 + 铺字内容流）；③生成时长（含 1MB 档）。**任一不过 → 回退纯光栅化交付（C 组主门不受影响），文本层降为二期待拍板项**。不许为救文本层牺牲完整性与工期。
- **D-4 减配档公式修复路线**：a) 导出时全功能渲染（独立全功能 Crepe/解析路径，sv 隐藏实例模式蓝本，注意 2.C 的核实项）；b) 导出管线公式补渲染扩展到行内（katex renderToString 纯函数扫描补渲染）。以密度档 fixture 的正确性 + 1MB 档时长数据拍板；宏语义（mathMacros 透传）必须与编辑器渲染一致。
- **D-5 远程图内联**：fetch 超时与并发策略；失败入 C2 显式清单。

## 6. 执行阶段（各自成阶段，顺序推进；凭实测可重排，报告说明理由）

- **阶段一：基线核实 + 症状钉死**（§0 清单全跑）+ E-1/E-2 复现（dev 实例 × 多图文档 × 旧管线，截图/产物落盘 `perf/results/ex-phase1-*`）+ RC-4/RC-5 潜伏根因复测（1MB 档旧管线截断观察；减配档导出公式源码化确认）。产出：根因定罪表（哪些活跃/哪些潜伏/哪些无法本机复现及原因），未复现项不许静默跳过。
- **阶段二：共享管线修复**（全格式先受益）：图片内联强化 + 显式降级报告（C2）→ 资源就绪确定性基建（进度事件/可取消，PDF 管线的前置依赖）→ 减配档公式修复（D-4）。每项独立 Fix commit + 单测；HTML/DOCX 即时回归。
- **阶段三：PDF 管线原型门 EX-P**（feature flag 隔离，不改默认行为）：离屏工厂 + 分页器纯函数 + 单页光栅 + 文本层最小原型 → D-1/D-2/D-3 拍板数据落盘。分页器纯函数单测本阶段就位（断点选择/keep-together/表格行断）。
- **阶段四：PDF 全量落地**：分块光栅化 + 组装 + 进度 UI + 取消 + 错误呈现（含未内联清单）+ 设置持久化（U2）→ **printHtml/win.print 退役**（MenuBar 文案与 `caps.pdfExport` 语义同步）。
- **阶段五：周边收口**：PNG 改走工厂（RC-6，注意深色主题背景参数语义保持）→ DOCX 图片失败显式化（sidecar 评估，做否拍板）→ Harmony `pdfExport` 翻 true 评估（纯前端管线无打印依赖，真机 spike 后定）。
- **阶段六：门禁全跑 + 交付**：§4 门禁表逐项实测评判（未达项归因）+ §7 交付物。

## 7. 交付要求

- 结题报告 `mditor/docs/export-overhaul-report.md`：根因定罪数据（阶段一）、共享修复前后对照、原型比选数据（D-1~D-5 拍板记录）、门禁实测表、未达项归因与后续提案。
- 每修复项独立 Fix-X commit 且附新增测试；观测补点与修复分开 commit；每 commit 前 `npm test`。
- `mditor/CHANGELOG.md` Unreleased 更新（wry#707 相关记载同步改写为「自研管线绕开」）；根目录 `memory/YYYY-MM-DD.md` 日记更新；demo.md 验收惯例记录新管线的操作路径。
- 未拍板清单显式呈报用户：打印菜单项去留（§3-1）、C2 占位标注 vs 中止导出、新默认纸张/边距/DPI、Q3/T 硬门数值、Harmony 能力位。

## 8. 方法论铁律（沿承第三~十轮）

先测后改（复现→基准→归因→修复→数据证明，六步走完才算一项）；一次一项（多根因并存按计数占比排优先级，逐项独立过六步，不许并行改多个）；原型先行（架构级决策必须有原型数据，EX-P/D-1~D-5 全部如此）；证据不成立不动手（复现不了的根因产出「为何在此环境不触发」的归因，不许猜）；达不到假设就回滚；观测与修复分离；禁止把归因与修复混在同一批 commit。
