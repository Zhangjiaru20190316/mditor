# DE 轮阶段 0 Spike 报告：Word / 文字 PDF 原位编辑可行性闸门

- **日期**：2026-11-01
- **执行环境**：Windows 11 / Node 24.15（pdf-lib@^1.17.1 + @pdf-lib/fontkit@1.1.1（patch-package 补丁已应用）+ pdfjs-dist 6.4.299 legacy build + mammoth 1.13.0）/ headless Edge（CDP，dev server :1420，Crepe 7.22.1 真浏览器实测）
- **复现**：`node perf/de-spike/gen-fixtures.mjs` → `node perf/de-spike/spike1-roundtrip.mjs` → `node perf/de-spike/spike2-coords.mjs` → `node perf/de-spike/spike4-mammoth.mjs` → `npm run dev` + `node perf/de-spike/spike4-crepe.mjs`；结果 JSON 在 `perf/de-spike/results/`（夹具与产物不进 git，可再生成）
- **视觉验收**：`perf/de-spike/out/render/*.png`，pdf:visual-judge 像素级取证四页全过（覆盖残留/旋转坐标/CropBox 补偿/豆腐块/收缩对齐）

## 结论总表（四闸门全 A，按原方案推进）

| 闸门 | 结论 | 关键证据 |
|------|------|---------|
| ① pdf-lib load→save 保真 | **A（可接受）** | 4 类夹具文本层逐 item（str+transform+width/height，ε=0.01pt）+ 注释 + 表单域全等；视觉渲染 diff 零区域 |
| ② pdfjs→pdf-lib 坐标映射 | **A（用户空间恒等）** | 三页补丁后回读 dx/dy=0.000；/Rotate 与 CropBox 不破坏 patch 层映射 |
| ③ CJK 重绘质量 | **A（带强制前置条件）** | 宽度两引擎 0 误差；收缩公式精确；**缺字形 = 进程级异步崩溃，必须前置拒绝** |
| ④ Crepe 独立挂载往返 | **A（带表格预处理配方）** | 独立实例挂载 14–83ms；幂等收敛（第二轮起逐字稳定）；表格需每次入场均预处理，否则 Crepe 自身序列化的 `<p>` 会让二次水合丢表 |

---

## ① pdf-lib load→save 保真（结论 A）

夹具（`gen-fixtures.mjs` 生成）：`foreign-edge.pdf`（**Chromium print-to-PDF 外部生成器** + pdfcraft 增量更新链 revision 2——含高亮注释）、`lib-form.pdf`（pdf-lib 产物：CJK 文本 + AcroForm 文本域/复选框 + Link/Text 注释）、`big-50mb.pdf`（53.5MB，3 页噪声 PNG）、`rotate-crop.pdf`（/Rotate 90 + CropBox 偏移页）。

| 夹具 | useObjectStreams | 文本层（逐 item 全等） | 注释 | 表单 | 体积 | load/save |
|------|------------------|----------------------|------|------|------|-----------|
| foreign-edge | true / false | ✅ / ✅ | ✅（Link+高亮） | — | 62.2KB→57.0/62.1KB | 4/7 ms |
| lib-form | true / false | ✅ / ✅ | ✅ | ✅（名/类型/值） | 7.50→7.34/7.50MB | 18/14 ms |
| big-50mb | true / false | ✅ / ✅ | — | — | 56.1→56.0/56.1MB | 39/53 ms |
| rotate-crop | true / false | ✅ / ✅ | — | — | 7.49→7.34/7.49MB | 14/9 ms |

- pdfcraft `doc_compare(visual:true)`：foreign-edge / lib-form / big-50mb 全部 `visual: []`（零差异区域）。
- **增量更新链**：重写后 revision 2→1（全量重写，历史折叠，**终态完整保留**）。我们的模型「每次保存从原始字节重放 patch」不受影响；「替换原文件」产物是单次全量重写，语义无损。
- **内存**：Node RSS 增量 0–22MB（50MB 档无额外峰值；预算 ≤500MB 富余）。两档 useObjectStreams 均通过，**M3 取默认 true**。
- 已知边界（M3 拒绝场景，维持任务书规定）：加密 PDF `load` 直接抛错（**禁用 `ignoreEncryption`**——实测该选项会产出损坏文件的风险自证于官方 issue，本 spike 不放开）。

## ② 坐标映射（结论：用户空间恒等；覆盖底色定案）

对 `rotate-crop.pdf` 三页各打一个补丁（白矩形覆盖 + NotoSansSC subset 重绘「已替换 REPLACED」），补丁后 pdfjs 回读：

| 页 | 原行 transform | 补丁绘制点 | 回读新文本 | dx/dy |
|----|---------------|-----------|-----------|-------|
| 1 常规 | e=72 f=720 size=14 | (72,720)@14 | e=72 f=720 | **0 / 0** |
| 2 /Rotate 90 | e=72 f=720（viewport.rotation=90） | (72,720)@14 | e=72 f=720 | **0 / 0** |
| 3 CropBox(40,60,…) | e=72 f=720（view=[40,60,595,841]） | (72,720)@14 | e=72 f=720 | **0 / 0** |

- **pdfjs `getTextContent` 的 transform 就是 PDF 用户空间（y 向上、MediaBox 原点），pdf-lib `drawText`/`drawRectangle` 同一坐标系——恒等映射，无需换算**。docNote.ts 现有 `transform[4]/[5]` 取值可直接复用。
- `/Rotate` 与 CropBox 不破坏 patch 层映射（视觉验收页 2/3 证实坐标系重合、裁剪偏移正确补偿）。**M3 仍维持任务书「/Rotate≠0 整页拒绝编辑」**——理由收敛为：UI 命中层（屏幕↔用户空间）与内容流内旋转文本 run（b/c≠0）是真正的复杂度所在，patch 层安全不构成放行理由。
- bbox 近似（实测 NotoSansSC 度量）：`y0 = f − 0.30·size`，`h = 1.42·size`（desc 0.30 + asc 1.12），`x0 = e − 1`，`w = item.width + 2`。视觉验收证实白矩形完全盖住旧行、无残留。
- **覆盖底色定案**：默认纯白（视觉验收页 1–3 零残留）；非纯白背景（彩底/底纹页）在**点击行进入编辑时**从渲染 canvas 采样行 bbox 周边色存入 patch，保存时用采样色画覆盖矩形（采样时点 = 页面必然已渲染，规避保存时 canvas 已被 LRU 淘汰的竞态）。

## ③ CJK 重绘质量（结论 A；缺字形 = 进程级崩溃，前置拒绝为硬性红线）

- **宽度两引擎零误差**：pdf-lib `widthOfTextAtSize` vs pdfjs 回读 `item.width`——纯中文 / 中英混排 / 全角标点 / 纯 ASCII / Inter 拉丁共 5 样本 **errPt=0.000**（同一嵌入 subset 字体，两套引擎读出相同度量）。宽度可信，无需安全系数。
- **字号收缩一发公式精确成立**：`size* = size₀ · W / w(size₀)`（宽度随 size 线性）。实测 w₀=490@14pt，目标 200pt → size*=5.714 → w*=200.000（**errPt=0.000**）；视觉验收红色小字行右缘与 200pt 标尺右缘对齐 ≤1px（实测版式宽 200.2pt）。M3 按任务书设收缩下限保护，超界 patch 列报拒绝。
- **缺字形（🔴 P0 级发现）**：`fontkit.create(Noto).hasGlyphForCodePoint(0x1F600) === false`（CJK/ASCII/全角标点均 true）。**强行 drawText 缺字形 + subset:true 后，save 阶段 CFFSubset 在 fontkit 流回调里抛 RangeError——`await` 的 try/catch 兜不住，宿主进程直接崩溃**（子进程隔离实测 exit 1；对照 subset:false 不崩、产出豆腐块但内嵌全量 7.5MB 字体）。
  → M3 铁律：**每个 patch 的新文本先过 hasGlyphForCodePoint 逐码点检查（Noto 主 + Inter 拉丁双路，复用 exportPdfPipeline.ts:549-596 模式），未全覆盖的 patch 在保存前拒绝并列入报告；绝不把未检查文本送进 drawText**。这不是质量选项，是 WebView 进程安全边界。
- Inter Medium subset 嵌入 + 拉丁 drawText 正常（与 Noto 同文档双 subset 无冲突）。

## ④ Crepe 独立挂载 + mammoth 承载边界（结论 A；表格预处理配方为 M2 必做项）

### ④-A mammoth 承载清单（手构 OOXML 特征夹具，jszip 拼 zip，Node 实测）

| Word 结构 | mammoth HTML 产物 | 判定 |
|-----------|------------------|------|
| 多级标题（Heading1/2） | `<h1>/<h2>` | ✅ |
| 加粗/斜体 | `<strong>/<em>` | ✅ |
| 超链接（External） | `<a href>` | ✅ |
| 有序/无序列表（numbering.xml） | `<ol>/<ul>` | ✅ |
| 表格 + gridSpan/vMerge | `<table>` 带 **colspan/rowspan** | ✅（HTML 层保留合并） |
| 脚注引用 + 脚注正文 | `<sup><a href="#footnote-1">[1]</a></sup>` + 文末 `<ol>` 脚注区 | ✅（变为文内锚链 + 尾注区） |
| 文本框（w:txbxContent） | 内容提取为普通段落 | ⚠️ 文字保留，框体几何丢失 |
| SmartArt（mc:AlternateContent） | Fallback 文字提取为段落 | ⚠️ 主路径丢弃，兜底文字保留 |
| 分页符（br type=page） | 无输出 | ❌（后续段落正常） |
| 内嵌图片 | `<img src="data:…">` 内联 | ✅ |
| TOC 域 | 域缓存文字作为正文输出 | ⚠️（域代码不重建） |
| messages | `[]` 零告警 | — |

### ④-B Crepe 独立实例往返（真浏览器 headless Edge + CDP，harness：`src/dev/deSpikeEdit.ts`）

- **挂载/序列化成本**：offscreen 独立实例（`new Crepe({root, defaultValue})`，关 TopBar/Toolbar/AI）create 14–83ms，`editor.action(getHTML())` ≤1ms。主编辑器零接触，同页并存无冲突。
- **水合路径定案**：mammoth HTML → `convertHtmlToMarkdown`（turndown）→ Crepe（markdown 入）。无需 HTML 直 hydrate；`crepe.getHTML()` 不存在，统一 `editor.action(getHTML())`（@milkdown/utils）。
- **往返漂移**：首轮有一次良性归一化（列表标记间距 `1.  `→`1. `、行尾空白），**第二轮起逐字幂等收敛（md3Stable=true）**——「切走标签序列化 htmlBuffer、切回重水合」的 buffer 模型成立，不累积漂移。
- **🔴 表格往返死亡链（M2 必做配方）**：mammoth/Crepe 的表格单元格内容都包 `<p>` → turndown-gfm 拒绝转管道表（且要求首行 `th`、各行列数一致）→ 原始 HTML 表滞留 md → Crepe 丢弃。**三步预处理（每次进入编辑面都执行，含切回重水合）**：① 单元格内 `<p>` 解包为 `<span>`；② 各行截齐/补齐到最大列数（**colspan/rowspan 降级为平铺，内容不丢**）；③ 首行 `td` 提升为 `th`。实测该配方下表格全链存活（tableAlive=true 且幂等）。
- 存活性全景（配方后）：h1/h2 ✅、列表 ✅、链接 ✅、图片 data URL ✅（编辑期不落盘、保存链原生接受）、脚注锚链 ✅、表格 ✅（合并单元格平铺降级）。

---

## 对 M2/M3 的路线影响（阶段 0 闸门输出）

1. **M3 按原方案推进**（原始字节重放 + 覆盖矩形 + Noto subset 重绘）；坐标层零换算；覆盖底色「白 + 编辑时采样兜底」；收缩一发公式 + 下限拒绝；**缺字形前置检查升格为进程安全红线**；/Rotate≠0 整页拒绝、加密拒绝、`ignoreEncryption` 禁用。
2. **M2 按原方案推进**；新增两条实现纪律：表格三步预处理在 `convertDocxForEdit` 内**每次入场**执行；「无法承载结构」提示清单 = 分页符（丢失）+ 合并单元格（平铺）+ 文本框/SmartArt（仅文字保留）+ TOC/域（缓存文字）。
3. 未触发任何 B/C 降级条件；Plan B（OOXML 双向）无需启用。
