# 任务：mditor HTML 导出不可滚动 + PDF 分页切字修复专项（HX 轮）

> 使用方式：本任务书配套 `/goal` 命令交付（目标文本见下方代码块，直接粘贴）。前端代码在 `mditor/` 子目录，所有 `perf/` 与 `npm` 命令在 `mditor/` 下运行。按 §5 阶段顺序推进：**先复现定罪，后最小修复**，两症状各自独立定罪、独立修复、独立收口。每阶段证据落盘（`perf/results/` 与报告草稿）并自查后才进下一阶段。动手前必读第 0、1、2、3 节——本任务禁止盲改，禁止重修 EX/DX 轮已修问题，禁止把范围扩大到 DOCX/PNG/LaTeX 管线与编辑器热路径。
>
> ```text
> /goal 修复 mditor 导出两症状（HX 轮：① 导出 HTML 在浏览器打开后无法滚动，视口以下内容不可见；② 导出 PDF 分页边界横切——页尾一行字上半截留在本页、下半截落到下页；均观察于打包版 5.0.2-beta）。任务书：docs/prompts/html-pdf-export-fix-prompt.md——先通读全文并遵守 §0 基线核实、§2 已查明事实集不重查、§3 禁区与红线，前端代码在 mditor/ 子目录，按 §5 阶段顺序执行：两症状各自先复现定罪（证据落 perf/results/，嫌疑收敛唯一、其余逐项排除有据），再各自最小修复，禁止盲改、禁止重修 EX/DX 已修问题、禁止扩大范围。完成判据（全部满足才 pass）：① HTML 定罪修复门——根因唯一钉死（含回归引入 commit），复现文档导出后浏览器可完整滚动到文档末尾，主题保真不回退；② PDF 定罪修复门——切字复现稳定且根因唯一，修复后复现文档 + demo.md + 密度档 fixture 逐页抽检零字形横切，C1 门（产物页数 = 分页器页数）复测不回退；③ 回归门——npm test ≥1080 全绿（以实跑基线为准）+ 两症状各新增根因回归测试；④ 交付——报告落盘 + CHANGELOG Unreleased + memory 日记更新。红线：collectThemeCss 是 PDF/PNG/DOCX/复制富文本共享件，改动波及全格式须先报告请示；global.css 编辑器侧规则不许为导出而改；KaTeX 0.18.4 单实例、S10 消毒门、EX 轮成果（Fix-C2/Fix-D4/自研管线/printHtml 退役）不可回退；观测与修复分开 commit；每 commit 前 npm test；先测后改、一次一项。
> ```
>
> 前序引用链（体例连续，背景可查）：`docs/prompts/export-overhaul-optimization-prompt.md`（EX 轮任务书，体例蓝本；其自研 PDF 管线与 Fix-C2/Fix-D4 为本轮不可回退前提）、`docs/prompts/docx-export-fix-prompt.md`（DX 轮任务书，体例连续）、`mditor/docs/export-overhaul-report.md`（EX 结题报告：§4 门禁实测表 + §5 遗留清单——**Q1 视觉人工验收遗留正是本轮症状 E-P1 的报障入口**）、`mditor/docs/docx-export-fix-report.md`（DX 结题报告）、`memory/2026-09-18.md`（HTML 导出白纸白字修复——整包主题 CSS 收集语义的历史背景，与 §2.C S-H1 直接相关）。
>
> 【填写】观察环境（用户 2026-10-17 已答部分，其余待补）：
>
> - 症状 E-H1 已钉死：**导出的 HTML 文件打开后无法滚动**——只能看到第一屏，视口以下内容不可见（「导出不完整」的实际形态是滚动锁死；是否同时存在文件级截断，须 §1 判别实验实测排除后才许下结论）。区别于：图片缺失/裂图（EX Fix-C2 列报语义）、主题丢失白纸白字（2026-09-18 已修，不许回退）。
> - 症状 E-P1 已钉死：**PDF 分页边界横切**——页尾一行字上半截留在本页、下半截落到下页。区别于：产物页数不对（C1 门域）、边缘整块裁切（RC-1 域，自研管线下已结构性消除）。
> - 观察版本：**打包版 5.0.2-beta**（= HEAD `3660e93`，2026-10-15 打包，含 EX+DX 全部修复；执行第一步仍须核实用户安装实例的实际版本号）。
> - 待补：___ 复现文档（哪份文档触发，两症状是否同一文档）；___ HTML 用什么打开（Edge / Chrome / 其他 / 双击默认）；___ 滚动失效是完全滚不动还是滚一段卡住；___ PDF 切字的内容类型（正文 / 表格 / 公式 / 代码块）与频度（每页都有还是偶发）；___ HTML 导出时「内联图片」选项选了什么。

## 0. 基线状态声明（执行第一步必须核实，禁止假设）

本任务书基于 2026-10-17 仓库状态撰写：

- HEAD = `3660e93`（chore(release): 5.0.2-beta——EX 导出体系翻新 + DX Word 导出修复打包版），与用户观察的打包版同源。**执行第一步**：`git status` + `git log --oneline -5`，据实记录 HEAD 相对 `3660e93` 的实际状态，报告开头声明；同时核实用户安装实例版本号（关于对话框 / 安装目录）确与 5.0.2-beta 一致——若安装版落后，先钉死两版导出代码差异再定罪。
- npm test 基线：DX 收口 **1080 全绿**（以实跑为准，执行第一步实跑 `npm test` 记录确数）。本轮在位相关测试：`src/lib/exporter.test.ts`（wrapHtml 外壳快照 6 例）、`exportPaginator.test.ts`（分页器 15 例，含 2 万块规模不变量）、`exportPdfPipeline.test.ts`（12 例）、`exportRenderFactory.test.ts` / `exportPdfAssembly.test.ts` / `exporterImages.test.ts` / `exportMath.test.ts` 等。
- fixture 在位性（本地化惯例，整目录 gitignore）：`mditor/perf/fixtures/` 应含密度档 / 1MB 压测 / 多图文档（EX 任务书 §0 规格）。执行时先 `ls perf/fixtures/` 确认；本轮另需**复现文档**（用户实际触发症状的文档，最小化后落 `perf/fixtures/hx-repro/`）与 `mditor/docs/demo.md`（全语法验收语料）。
- 代码库无两症状的未决问题档：EX 轮结题报告 §5 明记「Q1 视觉与 Q2 demo.md 人工验收待用户」「1MB 档 C1/T1 基线未跑」——本轮 E-P1 报障即 Q1 开口的兑现，属**新症状定罪 + 修复**，不是重修已修问题。EX 轮已定罪 RC-1~RC-6 与已落地的 Fix-C2/Fix-D4 一律不重查、不重修。

## 1. 角色与主战场

你是资深桌面文档应用导出引擎工程师，熟悉 CSS 层叠与样式表收集语义、Chromium 布局盒模型（行盒 / Range.getClientRects）、Canvas 光栅化与亚像素裁切、PDF 分页刀口语义与 Tauri WebView2 环境约束。**本轮性质：双症状 bug 修复——两个互相独立的缺陷，各自先钉死根因，再做最小修复；禁止捆绑定罪、捆绑修复。**

症状钉死（定义，禁止扩大或偷换）：

- **症状 E-H1（HTML 侧唯一症状）**：菜单「导出 HTML」→ 落盘的 .html 文件在浏览器打开后**页面无法滚动**，只能看到第一屏，视口以下内容不可见——用户感知为「导出不完整」。区别于：文件本身被截断（判别实验排除，见下）、图片缺失（Fix-C2 列报语义）、主题丢失（2026-09-18 已修）。
- **症状 E-P1（PDF 侧唯一症状）**：导出 PDF 的**分页边界处一行字被水平切成两半**——上半截留在本页页尾、下半截落到下页页首。区别于：产物页数不对（C1 门域）、整块内容缺失、边缘裁切（RC-1 域）。

判别实验（定罪的第一杠杆，阶段一必做）：

- E-H1：① 打开导出文件查看网页源码 / 检查文件尾部 `</html>` 与字节大小——全文在则排除「文件截断」，钉死为「打开后滚动锁死」；② 换浏览器（Edge / Chrome）交叉验证；③ devtools 中逐条禁用 `<style>` 里的嫌疑规则（§2.C S-H1），滚动恢复即实锤定位。
- E-P1：① 用 `__exportDebug.exportPdfTo` 免对话框直驱导出复现文档，钉死切字页码与稳定度；② 记录切字行的内容类型指纹（正文 / 表格 / 公式 / 行内代码 / 代码块）；③ `__exportDebug.rasterAb` 三变体 A/B（§2.E），切字表现随变体变化指向光栅/裁切段（S-P3/S-P4），不随变体变化指向测量/分页段（S-P1/S-P2）。

主战场文档三类：① 用户复现文档（最小化裁剪到最小触发片段，落 `perf/fixtures/hx-repro/`）；② `mditor/docs/demo.md`（全语法）；③ 密度档 fixture（EX 轮 C 语料）。只用一类下结论无效。

## 2. 已查明事实集（直接采用，不要重查；行号静态核实于 HEAD `3660e93`，执行时以仓库实际为准）

### 2.A HTML 导出全链路与滚动锁死机制（S-H1 的静态证据在位）

编排层 `src/App.tsx` `doExport`（:1766-1931）：`ed.getHTML()`（:1787，ProseMirror 模型序列化）→ 共享预处理（:1794-1836：减配档公式补渲染 :1803 → 块公式补渲染 :1810 → 双链 :1819 / 引用 :1827 / 闪卡 :1832 降级）→ `collectThemeCss()`（:1837）→ HTML 分支（:1851-1860）：`choiceDialog` 问是否内联图片 → `exportHtml(ctx, \`${name}.html\`, { inlineImages })`。

实现层 `src/lib/exporter.ts` `exportHtml`（:401-433）：`pickSaveFile`（:406）→ `sanitizeExportHtml` S10 消毒（:410）→ 可选 `inlineExportImages`（:414，单图 10MB / 总 64MB 预算 + 魔数门 + 远程 15s 超时并发 3，常量 :42-49；失败项入 `missing` 列报——Fix-C2 语义）→ 文档含 katex 时 `inlineKatexFonts`（:422-429）→ `wrapHtml`（:430）→ `fs.writeTextFile` 落盘（:431）。

外壳 `wrapHtml`（:358-389）：`<style>` 块里**先整段塞入收集来的主题 CSS（:371 `${css}`），后追加 export-friendly defaults**（:375-382：`html { background: var(--bg) }`、`body { max-width: 820px; margin: 40px auto; padding: 0 24px }`、mark 样式、`@media print` 色彩强制）——**defaults 未声明任何 `overflow` 与 `height` 属性**。

主题 CSS 收集 `src/lib/themeCss.ts` `collectThemeCss`（:8-35）：遍历 `document.styleSheets`，href 为空或含 `/assets/` 的样式表**全部 `cssText` 收进，零规则过滤**（注释自述收集 prose/theme/annotation/KaTeX/hljs 规则；按 (主题, 样式表数) 缓存）。

**静态证据（S-H1 机制，HEAD 实测在位）**：`src/styles/global.css:117-123` 是应用外壳规则 `html, body, #root { height: 100%; margin: 0; padding: 0; }`，`:125-134` 的 `body { ...; overflow: hidden; ... }`（:131）为无边框窗口的应用外壳语义。这两条随整包收集**原样进入导出文件**；独立 HTML 的 `<body class="vditor-reset">` 命中 `body` 选择器 → body 高度锁死视口 + `overflow: hidden` → 浏览器打开无法滚动。wrapHtml defaults 因未声明 `overflow`/`height`，层叠上盖不掉（同为 body 选择器单一声明，后者只覆盖同名属性）。

**注意不对称性（执行时核实验证）**：同一份 CSS 进 PDF 离屏工厂（§2.B）却不出等效故障——工厂由 JS 驱动测量与截图，`scrollHeight` 在 `overflow: hidden` 下仍返回完整内容高度；独立 HTML 靠用户滚动，`overflow: hidden` 直接锁死。这解释了为何 PDF 管线 87 页门禁全过而 HTML 落盘文件坏。

**回归引入点未钉死（阶段一 git 考古任务，不预设）**：整包收集语义与 global.css 外壳规则各自在位多久、何时开始合流成缺陷，须 `git log -S` / `git blame` 钉死引入 commit（`memory/2026-09-18.md` 记录的白纸白字修复是整包收集语义的高嫌疑引入点）。若考古证明缺陷存在已久，报告须解释为何现在才报障（如用户此前多用 PDF / 主题切换习惯变化），不许含糊带过。

### 2.B PDF 自研管线与刀口防线（E-P1 的战场地图）

调用链：`App.tsx` pdf 分支（:1861-1885，AbortController + 进度回调 + 设置透传）→ `exporter.ts` `exportPdf`（:481-491）→ `buildPdf`（:461-473）→ `prepareExportHtml`（:440-453，消毒 + 图片内联 + `markMissingImages` 占位框 :275-291）→ `runPdfPipeline`。

管线 `src/lib/exportPdfPipeline.ts` `runPdfPipeline`（:93-207）八阶段：

1. 离屏工厂 `renderInFactory`（`src/lib/exportRenderFactory.ts:203-279`；屏幕外 iframe + `doc.write` + `awaitFactoryResources` :130-176 逐图/字体确定性就绪；图片钳高 `img,video { max-height: contentHeightPx }` :68-70）。
2. 块测量 `measureBlocks`（:217-263；列表展开到 li、表格展开到行盒 :266-274、**行盒 = Range 矩形垂直合并 :280-300——「防止刀口落进视觉行内部」的防线本体**）。
3. 分页 `paginateBlocks`（`src/lib/exportPaginator.ts:74-273` 纯函数：块级断点 / keepTogether（图/HR/公式块整体推下页）/ keepWithNext（标题随文 :127-135, :150-159）/ 表格行断 / 孤儿寡妇 `MIN_SPLIT_LINES = 2`（:14, :222-249）/ resume 状态机（块内断点下页续）/ 页数失控保护 :269）。
4. 文本层素材 `collectTextFragments`（:343-411）→ 5. 字体 `loadFontBytes`（:676-686，NotoSansSC OFL）→ 6. 组装器 `createPdfAssembler`（`src/lib/exportPdfAssembly.ts:67-219`）。
7. 分块光栅 + 逐页入册 `rasterizeAndAssemble`（:555-662）：ChunkTrim（:497-553，窗口外块暂存 DocumentFragment、窗口内块绝对定位钉实测坐标）→ 主循环（:598-651：`domToPng` :613 → **页画布裁切 :623-647** → 即弃回收 :650；画布预算 16384px/120MP、每块 ≤4 页 :44、JPEG 256MB 护栏 :48）。
8. `assembler.save()`。

防线语义与缺口：C1 门（EX 轮完整性主门）只验「产物页数 = 分页器页数 + 首尾块完整」，**不验逐页字形完整性**；Q1（视觉对位/保真）人工验收在 EX 报告 §5-2 明记遗留待用户。本轮 E-P1 报障 = 该开口兑现：行盒防线在某条未被 C1 覆盖的路径上失效，刀口落进了视觉行内部。

### 2.C 嫌疑清单（定罪前一律是嫌疑，禁止预设结论；两症状嫌疑严禁互串）

**HTML 侧（症状 E-H1，按嫌疑度排序）：**

- **S-H1（头号，静态证据在位，§2.A）**：应用外壳规则 `body { overflow: hidden }` + `html, body { height: 100% }` 随 `collectThemeCss` 整包进入导出文件，wrapHtml defaults 未覆盖 → 独立 HTML 滚动锁死。定罪手段：导出文件文本检索该两条规则的 cssText 原文 → 浏览器 devtools 禁用后滚动恢复（对照实验）→ git 考古钉死引入 commit。修复方向候选（定罪后按证据选，不预设）：① wrapHtml defaults 增加导出外壳覆盖（如 `html, body { height: auto; overflow: visible; }`——仅动 HTML 落盘外壳，最小波及）；② `collectThemeCss` 收集侧过滤外壳规则（**共享件，红线 6 请示流程**）。
- **S-H2 整包 CSS 其他外壳副作用**：`.app` 网格、`position: fixed` 浮层、`#root` 等选择器在裸文档多数不命中，但须逐条排查留据（尤其 `body.is-resizing` 类状态类与通配规则），不许一句「应该不影响」带过。
- **S-H3 wrapHtml 模板自身缺陷**：模板极薄（:358-389），静态排除为主。
- **S-H4 真·文件截断**（`writeTextFile` 截断 / 编码问题）：判别实验排除（§1：尾部 `</html>` + 字节大小 + 源码可见全文）。**未过此实验不许把症状下结论为滚动锁死。**

**PDF 侧（症状 E-P1），先做家族二分再收敛唯一：**

家族甲「刀口本身落错位置」（测量/分页段，S-P1/S-P2）vs 家族乙「刀口正确但裁切/精度不足」（光栅/裁切段，S-P3/S-P4/S-P5）。`rasterAb` A/B 与「切字是否随光栅变体变化」是二分的判别杠杆（§1）。

- **S-P1（家族甲方向头号）行盒合并盲区**：`measureBlocks` 行盒 = Range.getClientRects 矩形垂直合并（:280-300）。行内 KaTeX（vertical-align / 上下标 / mfrac 堆叠）、行内代码、嵌套行内元素可能返回**垂直离散的多矩形**，合并策略若按交叠/邻近合并失败 → 一条视觉行被拆成多个行盒，刀口落进视觉行内部。特征指纹：切字行含行内公式 / 行内代码 / 上下标。定罪手段：直驱导出复现文档，dump 切字页相邻行盒坐标与实际刀口 y 比对；构造最小文档（含目标行内元素 × 足量段落推到页界）复现。
- **S-P2（家族乙…甲）分页器刀口未对齐行盒的路径**：keepTogether 块高于一页被迫内部拆分、表格行断点、resume 续排（块内断点下页续）等路径若按块高/行序切而非行盒边界切 → 刀口切行。特征指纹：切字只发生在超高块 / 表格 / 续排块，普通段落页界正常。
- **S-P3（家族乙）ChunkTrim 坐标漂移**：窗口内块绝对定位钉实测坐标（:497-553），钉坐标与原生流式布局坐标存在亚像素 / transform 差 → 光栅窗口边界与分页刀口错位切字形。特征指纹：同文档同设置切字位置不稳定，或 rasterAb 变体间切字表现不同。
- **S-P4（家族乙）页画布裁切换算取整**：刀口 y 由 CSS px 换算设备 px（× rasterScale）取整（:623-647），刀口虽落在行间隙但间隙小于取整误差 → 切到字形边缘。特征指纹：切口极浅（1-3px），高倍放大才可见，且随 rasterScale 档位变化。
- **S-P5（家族乙）行盒外扩不足**：紧凑行高内容（代码块 / 表格）行盒矩形紧贴字形包络，行间隙趋零 → 刀口落在两行盒之间也可能切到字形伸部（CJK 注音 / 英文降部 / KaTeX 上下标）。与 S-P1 合并取证（同用行盒坐标 dump）。

### 2.D 历史与依赖事实（背景，不重查）

- EX 轮门禁数据不可回退：C1 密度档 87/87 页 MATCH、C2 多图 3/3、C3 公式 2355/2355/2354；1MB 档 C1/T1 基线未跑（EX 报告 §5-1）——**本轮 P 组门禁用密度档 / demo.md / 复现文档，不要求补 1MB 档基线**（范围钉死，红线 10）。
- Q1/Q2 人工验收遗留（EX 报告 §5-2）= 本轮 E-P1 报障入口；修复后 Q1 的「逐页视觉」口径由 P2 门承接。
- `memory/2026-09-18.md`：HTML 导出白纸白字修复（主题丢失）——整包主题 CSS 收集语义的历史背景；本轮 E-H1 修复**禁止回退主题保真成果**（H2 门明验）。
- KaTeX 钉死 `0.18.4`（package.json overrides）；全导出路径无重试逻辑（现状事实，非本轮范围）。
- DX 轮成果（DOCX browser 构建垫片、1080 测试基线）不在本轮战场，禁改。

### 2.E 可复用资产清单

| 资产 | 位置 | 本轮用法 |
|---|---|---|
| `window.__exportDebug` 只读诊断口 | `src/lib/exportDebug.ts` | `exportPdfTo` 免对话框直驱 + `rasterAb` 三变体 A/B——E-P1 定罪与修复验证的主力杠杆 |
| CDP 活体驱动 | `perf/cdp.mjs` + 脚本家族（`ex6-gates*.mjs` 模式） | 活体导出与产物断言；本轮新增脚本沿 `ex-hx-*` 命名落 `perf/` |
| C1 门验证基座 | `perf/ex6-gates.mjs` | P3 回归门「产物页数 = 分页器页数」复测直接复用 |
| fixtures + 验收语料 | `perf/fixtures/`（密度档 / 1MB / 多图，gitignore 惯例）+ `mditor/docs/demo.md` | 定罪与门禁语料；复现文档最小化后落 `perf/fixtures/hx-repro/` |
| wrapHtml 快照 | `src/lib/exporter.test.ts`（6 例） | E-H1 修复若动 wrapHtml 须同步快照并在报告说明依据 |
| 分页器测试 | `src/lib/exportPaginator.test.ts`（15 例） | E-P1 修复不得回退；根因回归测试挂同文件或姊妹文件 |

## 3. 禁区与红线

1. **禁盲改**：两症状各自先复现定罪（阶段一证据落盘）后修复；禁止重修 EX/DX 轮已修问题（Fix-C2 图片列报、Fix-D4 减配档公式、DOCX 垫片等）；禁止预设 §2.C 之外的根因；禁止两症状捆绑定罪或捆绑修复。
2. **EX 轮成果不可回退**：自研 PDF 管线四段架构、C1/C2/C3 门禁语义、`printHtml` 退役状态（禁 `window.print()` 回潮）。
3. **KaTeX 0.18.4 单实例与宏语义不动**（沿承历轮红线）。
4. **S10 消毒门保留在所有导出路径输入侧**：若定罪涉及消毒门，修缺陷本体，禁止移除/放宽门。
5. **编辑器热路径零触碰**：`lazyInlineMath.ts` / `cvMemory.ts` / 渲染泵 / `imageLazy.ts` / `global.css` 编辑器侧规则 diff 必须为零。**导出问题在导出侧修**——global.css 的 `body { overflow: hidden }` 是无边框窗口的应用外壳语义，为编辑器窗口服务，**不许为导出而删改它**；修法走导出侧（wrapHtml 外壳覆盖 / 收集侧过滤 / 管线侧修）。
6. **`collectThemeCss` 是共享件**（PDF 工厂 / PNG / DOCX / 复制富文本同源消费）：若定罪要求改它，波及全格式，属范围扩大——先报告请示（附波及面分析与替代方案对比）再动手；优先考虑导出外壳侧最小修复。
7. **npm test ≥1080 零回退**（以实跑基线为准）；`exporter.test.ts` wrapHtml 快照与 `exportPaginator.test.ts` 不许无据回退；快照更新必须随修复 commit 并在报告写明语义变化。
8. **新增依赖一律懒加载**（exporter.ts 函数内 import 惯例），新增前在报告记录包体积影响。
9. **观测与修复分开 commit；每 commit 前 npm test；先测后改、一次一项**。
10. **范围钉死两症状**：DOCX / PNG / LaTeX 管线禁改；1MB 档基线补跑不在本轮范围；所有「顺带发现」记入报告待办区而非顺手改。

## 4. 可量化目标（门禁表；未达项附归因，不许留空）

### H 组：HTML 滚动锁死（症状 E-H1）

| # | 指标 | 目标 | 测量 |
|---|---|---|---|
| H1 定罪门 | 根因唯一钉死 + 回归引入 commit 钉死 | 导出文件中致瘫规则定位（选择器原文 + 层叠链分析）；devtools 禁用规则后滚动恢复的对照实验；git 考古结论；S-H2/S-H3/S-H4 逐项排除有据；证据落 `perf/results/`（`ex-hx-*` 命名） | 复现 ≥2 次稳定；文件完整性判别实验（§1）结果落盘 |
| H2 修复门 | 复现文档导出 HTML 打开后可完整滚动到文档末尾 | 明暗双主题 × 有无公式 × 内联/引用图片组合抽检（≥4 组合）全部可滚动到底；**主题保真不回退**（主题底色 / 字体 / 公式渲染态与编辑器一致，2026-09-18 成果） | 手动验收 + 验收截图落 `perf/results/` |
| H3 回归门 | 全格式不波及 | 修在 wrapHtml：`exporter.test.ts` 快照同步更新有据；若动 `collectThemeCss`（须先过红线 6 请示）：PDF / PNG / DOCX / 复制富文本四路回归抽检；`npm test` 全绿 | 实跑记录入报告 |

### P 组：PDF 分页切字（症状 E-P1）

| # | 指标 | 目标 | 测量 |
|---|---|---|---|
| P1 定罪门 | 切字复现 ≥2 次稳定 + 根因唯一 | 切字页码 / 内容类型 / 切口深度指纹落盘（页界放大截图）；嫌疑家族二分（刀口落错 vs 裁切精度不足）有据 → 收敛唯一根因，S-P1~S-P5 其余逐项排除有据；最小复现文档落 `perf/fixtures/hx-repro/` | 证据落 `perf/results/` |
| P2 修复门 | 零字形横切 | 复现文档 + demo.md + 密度档 fixture 三语料逐页抽检：程序化初筛（产物页转 PNG，页界上下条带与相邻页拼接比对）+ 人工终审（切字原发页及相邻页放大目检）；抽检口径 = 每语料首 / 中 / 末页 + 原发页；行盒对齐语义保持 | 抽检记录与判定截图落 `perf/results/` |
| P3 回归门 | C1 门不回退 + 测试全绿 | `ex6-gates` C1 断言复测（产物页数 = 分页器页数，密度档）；`npm test` 全绿 + **新增根因回归测试**（构造触发输入，断言刀口落在行间隙 / 不再切字） | 实跑记录入报告 |

### R 组：交付

| # | 指标 | 目标 | 测量 |
|---|---|---|---|
| R1 交付门 | 文档收口 | 报告落盘 `mditor/docs/html-pdf-export-fix-report.md`（两症状各自：定罪证据 + 修复 diff 说明 + 门禁实测表 + 未达项归因）+ CHANGELOG Unreleased + memory 日记更新 | 文件在位且引用链完整 |

## 5. 阶段计划

**阶段一：双症状并行定罪（观测，独立 commit，可回退）**

1. §0 基线核实（git 状态 + npm test 实跑确数 + fixtures 在位 + 安装版本核实）。
2. E-H1 取证：导出复现文档（或 demo.md 代打）→ 文件完整性判别实验（排除 S-H4）→ 浏览器复现 + devtools 定位致瘫规则 → 禁用规则对照实验（S-H1 实锤/排除）→ S-H2 逐条排查 → git 考古钉死回归引入 commit。
3. E-P1 取证：`__exportDebug.exportPdfTo` 直驱导出 → 切字页定位与页界放大截图 → `rasterAb` A/B 家族二分 → 必要时扩展 `__exportDebug` dump 行盒/刀口坐标（观测代码独立 commit）→ 嫌疑收敛唯一；复现文档最小化落 `perf/fixtures/hx-repro/`。
4. 双症状定罪结论落 `perf/results/`，其余嫌疑排除逐项写明依据，自查后才进阶段二。

**阶段二：最小修复（每症状独立 Fix commit，一次一项）**

按定罪结果做最小修复，每项：先写失败测试（喂触发输入）→ 修 → 测试转绿 → commit（附测试）。E-H1 若定罪落在 `collectThemeCss`（共享件）→ 走红线 6 请示流程，整理波及面分析与方案对比后停下请示，不擅自动共享件。

**阶段三：回归与收尾**

H2 / P2 人工验收（复现文档 + demo.md + 密度档，产物实开实滚）→ H3 / P3 全量回归（含 C1 复测 + `npm test`）→ R1 报告落盘 + CHANGELOG Unreleased + memory 日记更新。

## 6. 工作纪律

每 commit 前 `npm test`；观测与修复严格分开 commit；一次只修一项；所有「顺带发现」记入报告待办区而非顺手改；报告数字一律实跑实测，禁止引用未复现的推算值充当门禁数据。
