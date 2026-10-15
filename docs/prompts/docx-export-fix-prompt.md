# 任务：mditor Word(DOCX) 导出失败修复专项（DX 轮）

> 使用方式：本任务书配套 `/goal` 命令交付（目标文本见下方代码块，直接粘贴）。前端代码在 `mditor/` 子目录，所有 `perf/` 与 `npm` 命令在 `mditor/` 下运行。按 §5 阶段顺序推进：**先复现定罪，后最小修复**，每阶段证据落盘（`perf/results/` 与报告草稿）并自查后才进下一阶段。动手前必读第 0、1、2、3 节——本任务禁止盲改，禁止重修 EX 轮已修问题，禁止把范围扩大到 PDF/PNG/HTML/LaTeX 管线。
>
> ```text
> /goal 修复 mditor Word(docx) 导出失败（DX 轮，症状：导出时报「导出失败：…」错误弹窗）。任务书：docs/prompts/docx-export-fix-prompt.md——先通读全文并遵守 §0 基线核实、§2 已查明事实集不重查、§3 禁区与红线，前端代码在 mditor/ 子目录，按 §5 阶段顺序执行：先复现定罪（报错原文 + devtools 完整堆栈 + 最小复现文档，根因钉死到唯一 throw 点，证据落 perf/results/），再最小修复，禁止盲改、禁止重修 EX 轮已修问题、禁止扩大范围到 PDF/PNG/HTML/LaTeX 管线。完成判据（全部满足才 pass）：① 定罪门——根因唯一且证据落盘，其余嫌疑逐项排除有据；② 修复门——原复现文档导出成功且产物 Word/WPS 可打开，图片内联契约保持（exporterDocx.test.ts 钉子全绿）；③ 回归门——npm test ≥1077 全绿（以实跑基线为准）+ 新增根因回归测试；④ 交付——报告落盘 + CHANGELOG Unreleased + memory 日记更新。红线：sidecar/Node 子进程预案未经用户拍板不动；KaTeX 0.18.4 单实例、S10 消毒门、编辑器热路径、DOCX 输出契约不动；观测与修复分开 commit；每 commit 前 npm test；先测后改、一次一项。
> ```
>
> 前序引用链（体例连续，背景可查）：`docs/prompts/export-overhaul-optimization-prompt.md`（EX 轮任务书，体例蓝本；其共享管线成果 Fix-C2/Fix-D4 为本轮不可回退前提）、`mditor/docs/export-overhaul-report.md`（EX 轮结题报告：门禁实测表 + 遗留清单）、`memory/2026-08-28.md`（html-to-docx 历史 bug 记录与 DOCX worker 化挂起项）、`memory/2026-10-12.md` 与 `memory/2026-10-14.md`（EX 阶段二~六推进记录）。
>
> 【填写】观察环境（用户 2026-10-15 已答部分，其余待补）：症状形态已钉死为 **导出 Word 时弹「导出失败：…」错误框**（非静默失败、非产物损坏、非内容缺失）。待补：___ 报错弹窗全文（「导出失败：」后面的完整文字——本轮**最强定罪证据**，`String(e)` 携带原始 Error message，多数嫌疑可直接由原文锁定或排除）；___ 观察版本（dev/main HEAD 还是打包 v5.0.1-beta——打包版可能落后 EX 轮修复，两版导出代码差异须先钉死）；___ 复现文档特征（含块公式/行内公式？本地大图/远程图？表格？文档量级？是否开「大文档性能模式」总开关）；___ 所有文档必现还是特定文档触发；___ 同一文档导出 HTML/PDF 是否正常（判别实验，见 §1）；___ 每次必现还是偶发。

## 0. 基线状态声明（执行第一步必须核实，禁止假设）

本任务书基于 2026-10-15 仓库状态撰写：

- HEAD = `8068283`（fix(export): EX 阶段六收口——ChunkTrim 裁剪语义 A/B 判定 + 门禁表收口）。**执行第一步**：`git status` + `git log --oneline -5`，据实记录 HEAD 相对 `8068283` 的实际状态，报告开头声明；后续一切论述以核实后的代码为准。
- npm test 基线：EX 收口 **1077 全绿**（以实跑为准，执行第一步实跑 `npm test` 记录确数）。DOCX 相关在位测试：`src/lib/exporterDocx.test.ts`（真实转换钉子：产物含 `word/media/` + `word/document.xml`，60s 超时）、`src/lib/exporterImages.test.ts`（内联分类全矩阵约 20 例）、`src/lib/exporter.test.ts` / `exportMath.test.ts` / `exportDegradeMath.test.ts` / `exportSanitize.test.ts`。
- 代码库**无活跃 DOCX 导出失败记录**：EX 轮阶段五已实证 data URL 图片真实嵌入 `word/media/`（commit `3f91375`），阶段六收口后无新报障落档。故本轮性质是**新症状定罪 + 修复**，不是重修已修问题——EX 轮已定罪的 RC-1~RC-6 与已落地的 Fix-C2/Fix-D4 一律不重查、不重修。
- fixture 在位性（本地化惯例，整目录 gitignore）：`mditor/perf/fixtures/` 应含密度档/1MB 压测/多图文档（EX 任务书 §0 规格）。执行时先 `ls perf/fixtures/` 确认；本轮另需**复现文档**（用户实际触发报障的文档，最小化后落 `perf/fixtures/docx-repro/`）与 `mditor/docs/demo.md`（全语法验收语料）。

## 1. 角色与主战场

你是资深桌面文档应用导出引擎工程师，熟悉 OOXML 产物结构、html-to-docx 类转换器的 Node/浏览器双构建差异、Tauri WebView2 环境约束与最小复现定罪方法论。**本轮性质：单症状 bug 修复——DOCX 导出链路上某个未被 try/catch 包住的步骤抛了异常，弹到用户脸上。先钉死是谁抛的，再做最小修复。**

症状钉死（定义，禁止扩大或偷换）：

- **症状 E-D1（本轮唯一症状）**：菜单「导出 Word (docx)」→ 选保存路径后（或之前）弹「导出失败：xxx」错误框（`App.tsx` doExport 的统一 catch，见 §2.B）。区别于：用户取消保存对话框（返回 null，非失败）、导出成功但图片缺失（EX Fix-C2 已修的列报语义）、导出成功但公式源码化（Fix-D4 已修）、UI 冻结但最终成功（已知挂起项，见 §2.D，不是本轮症状）。

**判别实验（定罪的第一杠杆，阶段一必做）**：同一复现文档分别导出 HTML / PDF / DOCX——

- HTML、PDF 成功而 DOCX 报错 → 根因锁定在 DOCX 专属段（`juice.inlineContent` / `htmlToDocx` / `toArrayBuffer` / 公式栅格化的产物消费侧，§2.C S1-S4）；
- HTML 也报错 → 根因在共享段（`getHTML` / 预处理 / `sanitizeExportHtml` / `inlineExportImages` 外围，§2.C S5-S7），此时修复波及全格式，属范围扩大，先报告再动手（§3 红线 10）。

主战场文档两类：① 用户复现文档（最小化裁剪到最小触发片段）；② demo.md + 多图文档 + 公式文档（回归验证语料）。只用一类下结论无效。

## 2. 已查明事实集（直接采用，不要重查；行号静态核实于 HEAD `8068283`，执行时以仓库实际为准）

### 2.A DOCX 导出全链路

编排层 `src/App.tsx` `doExport`（:1766-1931）：`ed.getHTML()`（:1787，ProseMirror 模型序列化，非实时 DOM）→ 预处理块（:1794-1836）：减配档公式补渲染 `renderDegradedMath`（:1803-1809，try/catch）→ 块公式补渲染 `renderBlockMath`（:1810-1811）→ **DOCX 专属：`rasterizeFormulas` 公式栅格化为 PNG**（:1812-1816，仅 `kind==="docx" && r.hasMath`，带进度 flashStatus）→ 双链/引用/闪卡三步降级（:1818-1835，均 try/catch）→ `collectThemeCss()`（:1837）→ 格式分发 try 块（:1844）：DOCX 分支 `flashStatus("正在导出…")` + `exportDocx(ctx, name)`（:1886-1889）。

实现层 `src/lib/exporter.ts` `exportDocx`（:614-646）：`pickSaveFile`（:618，用户取消返回 null → `return { path: null, missing: [] }`）→ `sanitizeExportHtml` S10 消毒（:624）→ `inlineExportImages(remote:"fetch")`（:627，**整体 try/catch :626-632，失败按旧路径继续**；单图 10MB / 总 64MB 预算 + 魔数门 + 远程 15s 超时并发 3，常量 :42-49）→ `juice.inlineContent` CSS 内联（:634-635）→ `htmlToDocx(inlined, null, {table:{row:{cantSplit:true}}, footer:true, pageNumber:true})`（:636-642，`@turbodocx/html-to-docx`）→ `toArrayBuffer`（:643，实现 :671-682）→ `getAdapter().fs.writeFile` 落盘（:644）。

入口：`MenuBar.tsx`（:89 菜单项，DOCX 无能力位门控）→ `useMenuCommands.ts`（:212-213 `file_export_docx` → `doExportRef.current("docx")`）。依赖纪律：juice / html-to-docx 函数内懒加载（exporter.ts :30-33 注释），新增依赖必须沿此惯例。

### 2.B 报错的产生与呈现路径（本轮定罪的地基，先读透再动手）

- 弹窗唯一来源：doExport 格式分发 try 块（:1844-1917）的 catch（:1918-1924）——`AbortError` 走「已取消导出」静默收场（:1919-1920），**其余异常一律 `flashStatus("导出失败")` + `showAlert("导出失败：" + String(e))`（:1921-1923）**。`String(e)` 对 Error 输出 `Error: <message>`，原始 message 完整可见——所以**报错弹窗全文是最强定罪证据**。
- 由此可反推 throw 点位置：**能触发该弹窗的异常只能发生在 :1844-1917 之间**——对 DOCX 分支即 `exportDocx` 内部（含其未包 try/catch 的步骤）。**:1844 之前的步骤（`getHTML` :1787、`renderBlockMath` :1810、`rasterizeFormulas` :1812、`collectThemeCss` :1837）抛错不会触发本弹窗**（未处理 rejection，仅 devtools console 可见）。执行者第一步先核实 `useMenuCommands.ts` 调用侧（:212-213）确无外层错误包装，再依赖此排除；无论何种情况 console 堆栈都是 ground truth。
- `exportDocx` 内部**已被 try/catch 包住、不可能触发弹窗**的步骤：`inlineExportImages`（:626-632，失败静默按旧路径继续——注意其副作用：此时 `missing` 为空，用户拿不到列报，这是 EX 报告已记录的静默语义，不是本轮症状，不修）。
- `exportDocx` 内部**未包 try/catch、是候选 throw 点**的步骤：`pickSaveFile`（:618，适配器异常；用户取消返回 null 不抛）、`sanitizeExportHtml`（:624）、`juice.inlineContent`（:635）、`htmlToDocx`（:642）、`toArrayBuffer`（:643）、`fs.writeFile`（:644）。

### 2.C 嫌疑清单（按 DOCX 专属度排序；定罪前一律是嫌疑，禁止预设结论）

- **S1 `htmlToDocx`（exporter.ts :636-642）——头号嫌疑**。该库 Node 血统（Buffer/sharp），exporter.ts :609-612 注释自认「浏览器构建若运行时抛错，P1 修复是 Tauri sidecar / Node 子进程，TODO(P1)」。历史前科：`memory/2026-08-28.md:30` 记录对 live innerHTML 崩 `startsWith`（当时定性 getHTML 路径不可达——**新输入形态可能重新触达，不可依赖旧结论排除**）。定罪手段：devtools 堆栈含库内部帧即锁定；或单测直接喂复现 HTML 调 `htmlToDocx` 复现。注意：若定罪为库的浏览器构建缺陷，修复走 §3 红线 7 拍板流程，不是直接上 sidecar。
- **S2 `juice.inlineContent`（:634-635）**。CSS 内联，大文档 916ms 已知（挂起项，§2.D）；抛错形态无记录。定罪手段：堆栈；或绕过实验（临时喂未内联 CSS 的 html）。
- **S3 `toArrayBuffer`（:643，实现 :671-682）**。防御性 throw（:681「html-to-docx returned a Blob」），报错原文特征唯一——**弹窗文字可直接定罪或排除**。
- **S4 `rasterizeFormulas` 的下游消费（App.tsx :1812-1816 + 转换器对栅格化 PNG 的处理）**。栅格化本身在 try 块外（§2.B），单独抛错不触发本弹窗；但其产物（data URL 图）进入 S1 转换器后可能触发 S1——有公式文档报错、无公式文档正常是本嫌疑的特征指纹。
- **S5 `fs.writeFile`（:644）**。平台层落盘失败（权限/路径/磁盘/杀软拦截）。特征指纹：报错与文档内容无关、任何文档都失败、堆栈无转换库帧。
- **S6 `sanitizeExportHtml`（:624）**。S10 消毒门。若定罪为消毒门自身缺陷：修复消毒门，**禁止以报错为由移除或放宽门**（§3 红线 3）。
- **S7 共享段（`getHTML` / `renderBlockMath` / `collectThemeCss` / import 链）**。按 §2.B 的位置分析，这些在 :1844 之前抛错不触发本弹窗——除非调用侧核实推翻该分析。判别实验（§1）HTML 也失败时才升级为本组嫌疑。

### 2.D 历史与依赖事实（背景，不重查）

- image-size（经 @turbodocx/html-to-docx）有 2 个高危 DoS CVE（GHSA-w3rx-r6r6-pgpr / GHSA-5p2g-fcmc-qvqq，上游无修复）——已由 `lib/imageSniff.ts` 魔数门在输入侧防御。若本轮定罪涉及，走依赖升级评估（懒加载红线适用），不裸升。
- DOCX 转换在主线程同步执行（juice 916ms + htmlToDocx ~3s），大文档 UI 冻结是**已知挂起项**（`memory/2026-08-28.md:28`，worker 化待用户拍板）——那是性能问题，不是本轮报错症状，禁止顺手修。
- 全导出路径无任何重试逻辑（grep `retry|重试` 为零）——现状事实，非本轮范围。
- EX 轮 PDF 自研管线（exportPdfPipeline 等 4 模块）与 DOCX 仅共享预处理；PDF 门禁全过——PDF 管线是本轮禁改区。

### 2.E 可复用资产清单

| 资产 | 位置 | 本轮用法 |
|---|---|---|
| `window.__exportDebug` 只读诊断口 | `src/lib/exportDebug.ts` | 现为 PDF 向（exportPdfTo / rasterAb）；阶段一可扩展 docx 直驱口（观测代码独立 commit） |
| 导出分段计时基准 | `perf/bench-export-search-save.mjs` | juice / htmlToDocx 分段计时已在位，定罪时直接用 |
| DOCX 转换钉子测试 | `src/lib/exporterDocx.test.ts` | 修复后必须保持绿；新增根因回归测试挂同文件或姊妹文件 |
| CDP 活体驱动 | `perf/` 下 CDP 脚本（WebView2 remote-debugging 9223） | 活体复现与堆栈采集 |
| 全语法验收文档 | `mditor/docs/demo.md` | 修复后回归语料 |

## 3. 禁区与红线

1. **禁盲改**：先复现定罪（阶段一证据落盘）后修复；禁止重修 EX 轮已修问题（Fix-C2 图片显式列报、Fix-D4 减配档公式补渲染成果不可回退）；禁止预设 §2.C 之外的根因。
2. **KaTeX 0.18.4 单实例与宏语义不动**（沿承历轮红线）。
3. **S10 消毒门保留在 DOCX 路径输入侧**：若定罪为消毒门缺陷，修缺陷本体，禁止移除/放宽门。
4. **编辑器热路径零触碰**：`lazyInlineMath.ts` / `cvMemory.ts` / 渲染泵 / `imageLazy.ts` / global.css cv 档规则 diff 必须为零。
5. **npm test ≥1077 零回退**（以实跑基线为准）；`exporterDocx.test.ts` 钉子（data URL 图真实嵌入 `word/media/` + 产物含 `word/document.xml`）必须保持绿。
6. **DOCX 输出契约不变**：documentOptions（表格 cantSplit / footer / pageNumber）、消毒→内联→juice→转换的链路语义、产物可被 Word/WPS 打开。
7. **sidecar / Node 子进程是 TODO(P1) 预案，不是默认修法**：仅在定罪为 html-to-docx 浏览器构建不可修复缺陷时，整理证据提请用户拍板（方案对比：输入侧规避 / 依赖替换 / sidecar），未拍板不动。
8. **新增依赖一律懒加载**（exporter.ts :30-33 惯例），新增前在报告记录包体积影响。
9. **观测与修复分开 commit；每 commit 前 npm test；先测后改、一次一项**。
10. **范围钉死 DOCX 导出失败**：PDF/PNG/HTML/LaTeX 管线禁改；共享预处理若被定罪为根因（§1 判别实验 HTML 也失败），修复波及全格式，先报告请示再动手。

## 4. 可量化目标（门禁表；未达项附归因，不许留空）

| # | 指标 | 目标 | 测量 |
|---|---|---|---|
| D1 复现定罪门 | 根因唯一钉死：报错原文 + devtools 完整堆栈 + 最小复现文档（裁剪到最小触发片段，落 `perf/fixtures/docx-repro/`） | 根因落到唯一 throw 点，§2.C 其余嫌疑逐项排除有据；证据落 `perf/results/`（ex-dx-* 命名） | 复现 ≥2 次稳定触发；判别实验矩阵（同文档 × html/pdf/docx）结果落盘 |
| D2 修复门 | 原复现文档导出成功且产物合格 | docx 生成、Word/WPS 可打开；多图文档图片嵌入（`word/media/` 非空）；公式文档栅格化正常 | 人工打开验收 + `exporterDocx.test.ts` 钉子绿 |
| D3 回归门 | 测试零回退 + 根因钉死 | npm test 全绿（≥基线确数）+ **新增根因回归测试**（喂触发输入断言不再抛/产物正确） | `npm test` + 新用例清单入报告 |
| D4 交付门 | 文档收口 | 报告落盘（建议 `mditor/docs/docx-export-fix-report.md`，或并入 export-overhaul-report 附录——执行者拍板并在开头声明）+ CHANGELOG Unreleased + memory 日记 | 文件在位且引用链完整 |

## 5. 阶段计划

**阶段一：复现与定罪（观测，独立 commit，可回退）**

1. §0 基线核实（git 状态 + npm test 实跑确数 + fixtures 在位）。
2. 证据采集：报错弹窗全文（用户供给或复现捕获）、devtools console 完整堆栈（弹窗只有 `String(e)`，堆栈在 console）、复现文档最小化（二分裁剪，落 `perf/fixtures/docx-repro/`）。
3. 判别实验矩阵：复现文档 × {html, pdf, docx}；有公式 vs 无公式；必要时 dev vs 打包版（若用户观察自打包版，先钉死两版代码差异）。
4. 依据 §2.B 位置分析 + 堆栈，把 §2.C 嫌疑收敛到唯一；必要时扩展 `__exportDebug` 增加 docx 直驱口（观测代码独立 commit）。
5. 定罪结论落 `perf/results/`，其余嫌疑的排除逐项写明依据，自查后才进阶段二。

**阶段二：最小修复（一次一项，独立 Fix commit）**

按定罪结果做最小修复，每项：先写失败测试（喂触发输入）→ 修 → 测试转绿 → commit（附测试）。S1 定罪为库缺陷时走 §3 红线 7 拍板流程，整理方案对比数据后停下请示，不擅自上 sidecar。

**阶段三：回归与收尾**

D2 人工验收（复现文档 + demo.md + 多图文档 + 公式文档，产物 Word/WPS 实开）→ D3 全量 `npm test` → D4 报告落盘（定罪证据 + 修复 diff 说明 + 门禁实测表）+ CHANGELOG Unreleased + memory 日记更新。

## 6. 工作纪律

每 commit 前 `npm test`；观测与修复严格分开 commit；一次只修一项；所有「顺带发现」记入报告待办区而非顺手改；报告数字一律实跑实测，禁止引用未复现的推算值充当门禁数据。
