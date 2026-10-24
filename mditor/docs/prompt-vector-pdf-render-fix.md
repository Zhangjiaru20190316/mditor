# 提示词：矢量文字 PDF 导出渲染异常修复（RV-F 轮）

> 用法：将本文件全文作为任务提示词投喂给编码 agent（如 ZCode / Claude Code），在 `mditor/` 项目根目录下执行。
> 前置阅读：`docs/vector-pdf-export-report.md`（RV 轮结题报告）、`docs/prompt-vector-text-pdf.md`（RV 轮任务书，其"硬约束"除本文件显式豁免外继续有效）。

---

## 一、角色与任务

你是 **mditor**（Tauri 2 + React 18 + Milkdown 7 + Vite 5，Windows/WebView2 优先）**导出模块的负责人**。RV 轮（commit `a80ba46`→`135764f`）已把 PDF 导出升级为矢量文字模式（默认 `exportPdfMode:"vector"`），程序化验收全过；但用户人工终检判定**矢量导出存在渲染异常**。本会话（2026-10-22）已完成异常定位与归因（见第二节，全部有实测证据），你的任务是修复：

1. **【速赢】代码块语法高亮在导出中全部丢失**——vector 与 raster 两模式共有缺陷，导出 HTML/PDF/PNG 三出口同病。
2. **【主线】矢量模式"整体偏浅偏细"**——正文/标题/链接笔画偏细、合成粗体有描边感、表格矢量线偏淡。修复路径：真字体变体内嵌（替换合成粗/斜体主路径）+ 线宽校准。
3. **【条件触发】Plan B 原生打印档**——仅当任务 2 终验后用户仍对字形观感有异议才实施（见阶段 3 触发条件）。

## 二、异常清单（已实测归因，勿重复排查，直接引用）

证据留档：`perf/results/rv-final/`（RV 轮双模式产物）+ 本轮新增 `perf/results/rv-final/cmp-render/`（pymupdf 2x 渲染页图、对比裁片、抽取的补丁位图）。复现/度量脚本见文末附录。

| 编号 | 异常（用户可见） | 实测证据 | 根因 |
|---|---|---|---|
| F1 | 正文/标题/链接**笔画偏细、整体偏浅发灰** | 双模式渲染墨量比（暗像素占比）：p0 2.92% vs 3.74%、p2 1.34% vs 1.97%、p3 0.94% vs 1.34%（矢量版低 22–30%）；文本填充色实测 `#2c2a26` = 主题正文色（**排除颜色转换 bug**）；字号 12pt 正确 | **字形替换**：编辑器正文 `--font-prose: system-ui`（global.css:126）在 Windows 下 Latin=Segoe UI、CJK=微软雅黑；矢量导出全部画成 NotoSansSC——其拉丁字形显著更细，CJK 墨量也低于雅黑（报告 §4.1 已登记为取舍，用户终检不接受） |
| F2 | **加粗是描边伪造**，黑度不足、有描边感 | 内容流 `2 Tr`×33 算子；exportPdfAssembly.ts:278-284（Tr 2 FillAndStroke + max(sizePt×0.026, 0.24)pt 描边） | 无 Bold 字体文件，合成加粗是近似（报告 §4.2） |
| F3 | **斜体非真斜形** | exportPdfAssembly.ts:349（xSkew 12° 文本矩阵剪切） | 无 Italic 字体文件，合成斜体是近似 |
| F4 | **表格边框矢量线偏淡** | p2/p3 矢量线 152/89 条已画全（**无线缺失**），但线宽 = 0.57px×0.75 ≈ **0.43pt 发丝线**，100% 缩放下观感淡于位图版 | 线宽换算下限过低 |
| F5 | **代码块无语法高亮**（棕灰单色） | 两版 PDF 代码区（页面 75–92% 高度带）彩色像素 **均为 0**；从矢量 PDF 抽出的代码补丁位图（1360×386@192dpi）内 0 彩色像素、5 行深色文字俱全——token `<span>` 在、颜色没了 | **工厂文档缺 hljs 色板**：`exportProseCss.ts` 无任何 hljs 规则；编辑器侧规则在 global.css:4889+ 带作用域；rehype-highlight 已输出 `hljs-*` 类，只缺命中它们的 CSS |

**已排除、勿误修**（避免绕远路）：
- 文字内容零缺失——双模式文本抽取逐字一致（含"下表24 行…"，视觉模型曾误报"2X"为 OCR 误读）；
- 图片原生嵌入正常（p1 双版彩色像素 20052 vs 20088，几乎一致）；
- 补丁位图 192dpi（=rasterScale 2x）无分辨率劣化；"公式/代码偏浅"观感主要来自 F1 的对比效应；
- 无 z 序、错位、重影问题；表头线/内线全量存在；
- 位图层 PNG（`vector-page-*.png`）只是补丁图层，大片空白是正常的，**不要当异常**。

## 三、文件地图（已探明，直接引用）

- `src/lib/exportPdfAssembly.ts:278-390`——文本绘制：合成粗体 trBold / 合成斜体 xSkew / 影子 Tr 3；px→pt 换算（:19 注释，实际用内容盒比）。
- `src/lib/exportPdfPipeline.ts`——:59 字体 URL（`public/assets/fonts/NotoSansSC-Regular.otf`）；:1174 `applyTextTransparency`（color:transparent span 包裹）；:1320 `applyDecorationTransparency`（只动 border/bg/decoration/visibility，**不碰文字色**，已排查非 F5 根因）；:1213 `collectBlockDecorations`（表格/引用/hr 线宽 `max(px, 0.5)` 即 F4 锚点）；:1425+ 分块光栅（modern-screenshot chunk → 补丁裁片）。
- `src/lib/exportVectorText.ts:87`——`decideTextVectorization`（:90 mono 字体不矢量化走补丁）；字形覆盖检测 `hasGlyphForCodePoint`。
- `src/lib/exportProseCss.ts`——导出专用 CSS 注入（RV 阶段 0 表格边框修复落点），**F5 修复点**；`wrapHtml`（exporter.ts:390，HTML 导出）与 `buildFactoryDocumentHtml`（exportRenderFactory.ts，PDF/PNG 工厂）同源注入。
- `public/assets/fonts/`——现只有 NotoSansSC-Regular.otf（8.3MB）+ OFL.txt。
- 设置 `exportPdfMode: "vector" | "raster"`（defaults.ts / store.ts / SettingsModal「导出」分区）；CDP 调试口 `__exportDebug.exportPdfTo`（exportDebug.ts:23）。
- 依赖已有 pdf-lib + @pdf-lib/fontkit（**含 patches/@pdf-lib+fontkit+1.1.1.patch，勿动**）、modern-screenshot；**没有** puppeteer/playwright/jspdf。
- 环境：dev 实例 CDP 口 9223（perf/cdp.mjs）；fs scope 只放行 `$DOCUMENT/$APPDATA`，回归 fixture 放 `C:/Users/hh/Documents/rv-fixtures/`。

## 四、修复方案（分阶段，每阶段一个 commit + 简报）

### 阶段 0：代码块语法高亮修复（速赢，独立提交，三出口同修）
- `exportProseCss.ts` 注入导出专用 hljs 色板：`.vditor-reset pre code .hljs-*` token 颜色 + `.hljs` 底色规则，视觉对齐编辑器 global.css:4889+ 的静态渲染色板（色值用主题变量实际值，暗色主题同步）。
- 同源注入保证 HTML 导出 / PDF 工厂 / PNG 工厂一次修复（与 RV 阶段 0 表格边框修复同手法）。
- 验收断言：导出 PDF 代码区彩色像素 > 0 且 token 色与编辑器截图一致（附录脚本改造）；两模式、三出口全部命中。

### 阶段 1：真字体变体内嵌，合成粗/斜体退位（主线，修 F1/F2/F3 主体）
- **引入 OFL 西文族**（推荐 **Inter**：为 UI 文本设计、与 Segoe UI 观感/墨量最接近、四变体齐全、子集友好；备选 Open Sans）：Regular / Bold / Italic / BoldItalic 四个字体文件入 `public/assets/fonts/`（附 OFL.txt），bundle 增量约 1.5MB 可接受（现安装包 13MB）。
- **运行匹配扩展**（`exportVectorText.ts` / `exportPdfAssembly.ts`）：按 script 拆 run——Latin-only run → Inter 对应变体（weight/style 就近映射）；含 CJK 的 run → 拆 Latin 子 run（Inter）+ CJK 子 run（NotoSansSC）。真 Bold/Italic 命中即走真字体绘制；**合成路径保留为兜底**（CJK 粗体无变体，继续合成；Latin 真粗 + CJK 合成的混合 run 允许并存）。
- 字形覆盖：Inter 覆盖拉丁/常用标点，缺字形（emoji 等）沿用现有 no-glyph → 残留补丁兜底，绝不画 notdef。
- 新逻辑（run 拆分/变体映射）写成纯函数 + vitest 单测。
- 注意 @pdf-lib/fontkit CFF 子集已有一字节补丁（offSize），新字体若为 TTF/OTF-CFF 需验证子集产物在 FreeType/poppler 可载（沿用 RV 轮验证手法）。

### 阶段 2：线宽与墨量校准（收尾 F4 与 F1 残差）
- 装饰线宽下限从 0.43pt 提到 **0.5pt 起**（以实测为准：双模式表格区线条灰度对比，取目检一致值；锚点 `collectBlockDecorations` 的 `max(px, 0.5)` 与 pt 换算处）。
- 换 Inter 后重测墨量比（附录脚本）：若正文区 vec/ras 仍 < 0.85，对 **CJK run** 增加极细同色描边补偿（0.008–0.012em，4x 目检无描边感；默认常量关闭，实测达标就不开）。
- 公式/代码补丁观感随 F1 收敛自然改善，不单独处理。

### 阶段 3：Plan B 原生打印档（**条件触发**：阶段 1+2 完成并请用户终验后，用户仍对字形/粗斜体观感有异议才实施**）
- Rust 侧 `with_webview` + webview2-com 调 WebView2 `PrintToPdf`（Chromium 原生排版 → 真矢量文本、真系统字体、真粗斜体，零近似）。
- **禁令豁免说明**：EX 轮退役的是 `window.print()`/wry 静默打印（wry#707）；本条走 WebView2 COM 异步 PrintToPdf API，是另一机制，RV 报告 §6 已预案，不违反旧约束。
- `exportPdfMode` 增第三档 `"native"`（仅 Windows 设置项展示；失败或非 Windows 自动回退 `"vector"` + 状态栏告知，复用 RV 阶段 5 回退框架）。
- 必须明示的语义差异：分页由 Chromium print 决定，现有分页器/断口补线/表头策略不生效；`@page` 边距映射 paper/marginMm 设置；进度/取消 UX 适配。产物页数允许与 vector/raster 不同（在报告中说明）。

## 五、验收标准（逐条自查，全部满足才算完成）

1. **语法高亮**：导出 PDF/HTML/PNG 中代码块 token 色板与编辑器一致（彩色像素断言 > 0 且色值匹配），vector 与 raster 双模式同过。
2. **真粗斜体**：Latin bold/italic run 走真字体（内容流 `2 Tr` 算子仅剩 CJK 粗体兜底）；标题/`**粗体**`/`*斜体*` 4x 缩放无描边感、与编辑器字形一致。
3. **墨量收敛**：正文区墨量比（vector/raster 同区域暗像素占比）≥ **0.85**（当前 0.68–0.78），文字深浅目检与位图版一致。
4. **表格线**：矢量线深浅/粗细与位图版目检一致（灰度断言），无缺失。
5. **回归不破**：页数与改造前一致（阶段 3 除外）；文本抽取逐字一致；体积较现矢量版增幅 < 20%；PNG 管线零回归；进度/取消/设置/CDP 调试口全可用；全量 vitest 绿 + tsc 干净。
6. **视觉终检**：4x 裁片留档（标题/正文/表格/公式/代码五类）；执行会话若有图像能力（visual-judge 或视觉 MCP）则过视觉门，否则留档 + 人工终检清单，如实注明。
7. **阶段 3 若实施**：native 档与编辑器渲染视觉一致性抽检；回退链路注入失败实测；打印语义差异写入报告。

## 六、硬约束（违反即返工）

1. 不引入 puppeteer / playwright / 无头浏览器 / jspdf；不复活 `window.print` / wry 打印路径（阶段 3 的 webview2-com PrintToPdf 是唯一豁免，且仅限该阶段）。
2. 不改 `exportPaginator.ts` 分页行为（阶段 3 native 档绕过分页器属预期，需报告说明）。
3. 不破坏 raster 档、PNG 管线与工厂共用代码；`exportPdfMode` 设置向后兼容（旧值合法）。
4. 字体资产必须可再分发（OFL/Apache 等），随资产附许可证文本；**禁止读系统字体文件**（exportPdfAssembly.ts 头注既有纪律）。
5. 新逻辑优先纯函数 + vitest 单测；沿用中文 commit、分阶段提交、CHANGELOG Unreleased 条目。
6. **dev 实例改码后必须重启进程再 CDP 回归**（RV 轮教训：动态 import 模块缓存不随 HMR 刷新；`location.reload()` 会卡开屏）。

## 七、交付物

- 每阶段 commit + 简报（改了什么、为什么、怎么验的）。
- 结题报告 `docs/vector-pdf-render-fix-report.md`：异常前后对比数据（墨量比、彩色像素、线宽、4x 裁片）、字体选型与体积取舍、（若做）native 档语义差异、遗留问题。
- CHANGELOG Unreleased 条目。
- 度量脚本沉淀为 `perf/rvf-*.mjs`（或等价 CDP 脚本），供后续回归复用。

**执行顺序**：阶段 0 → 1 → 2 → 用户终验 →（有异议才）3。开始前先读第二节证据与第三节文件地图涉及的源文件。

---

## 附录：本轮复现与度量方法（验收必须复用或等价实现）

```bash
# 双模式渲染 + 墨量/彩色像素/补丁检查（python + pymupdf + PIL，本机已验证可用）
cd mditor/perf/results/rv-final
python - <<'EOF'
import pymupdf
from PIL import Image, ImageChops
for name, tag in [('rv-final-vector.pdf','vec'), ('rv-final-raster.pdf','ras')]:
    doc = pymupdf.open(name)
    for i, page in enumerate(doc):
        page.get_pixmap(matrix=pymupdf.Matrix(2,2)).save(f'cmp-render/{tag}-p{i}.png')
EOF
# 1) 墨量比：暗像素(<128)占比 vec vs ras 同页同区域对比（验收 ≥0.85）
# 2) 语法高亮：代码区（页面 75–92% 高度带）彩色像素数（max-min>30 且 max>70），修复前两版均为 0
# 3) 补丁位图：doc.extract_image(xref) 抽出后同法统计彩色像素
# 4) 文本填充色：page.get_text('rawdict') 的 span color（当前 #2c2a26 = 主题正文色，正常）
# 5) 内容流算子：0 Tr / 2 Tr / 3 Tr 计数（改造后 2 Tr 应仅剩 CJK 粗体兜底）
EOF
```

矢量 PDF 内嵌补丁现状（192dpi 正常，勿再查）：p0 = 公式块×2（1360×92/56）+ 代码块（1360×386，**无色**）+ 行内 chip×4；p1 = SVG/图块补丁（1360×765）+ 原生嵌入 PNG（320×160@96dpi 源图原分辨率，正常）。
