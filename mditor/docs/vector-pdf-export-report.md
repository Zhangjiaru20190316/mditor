# 矢量文字 PDF 导出改造结题报告（RV 轮）

2026-10-21 · 提交序列 `fix(export): RV 阶段0` → `feat(export): RV 阶段1..5`

## 0. 结论速览

| 验收条款 | 结果 | 证据 |
| --- | --- | --- |
| 矢量文字（可见、可选中/复制/搜索、400% 锐利） | ✅ | 4x 渲染正文边缘宽 1.42px vs 位图 3.29px（2.3× 锐利）；pymupdf 全文抽取含标题/表格/中英文；`0 Tr`×69 + `2 Tr`×33 可见算子 |
| 文本覆盖率 100%（含降级判定与占比） | ✅ 79.4% 矢量 + 20.6% 块级/残留补丁兜底，零丢失 | 1208/1522 字符矢量；影子 314 = mono 11 + raster-scope 275 + katex 28；逐页文本抽取量与位图版一致 |
| 表格边框（PDF + HTML 同根因修复） | ✅ | 工厂计算样式 1px 边框命中；PDF 页图栅格扫描 page1/2/3 横线 9/13/9 条间距均匀；矢量线+断口补线见 §3 |
| 体积不劣化 | ✅ -51% | 同文档 902,906B（raster）→ 443,221B（vector） |
| UX 不回退 | ✅ | 进度对话框/取消/设置项（新增 exportPdfMode）全可用；`__exportDebug.exportPdfTo` 本轮全部回归靠它驱动；PNG 管线零代码触碰 |
| 回归验证 | ✅（程序化全过；视觉留人工终检） | `perf/rv-phase0..rv-final.mjs` + `rv-line-detect.mjs`；本会话模型无图像输入，全部页图/裁片留档 `perf/results/rv-final/` 供人工验收 |

## 1. 方案与架构

**原点**：EX 轮管线是「每页 = modern-screenshot 满铺位图 + Tr 3 隐形文本层」——
视觉是位图（缩放糊、体积大），文字只是选中的代理。RV 轮反转结构：

```
矢量模式（默认）                     位图模式（兼容/回退）
┌ 页底色矢量矩形                     ┌ 满铺页位图（旧行为逐字节不变）
├ 块装饰矢量（引用底/竖条/表格线/hr）  ├ （无矢量装饰）
├ 局部补丁（公式块/代码块/SVG/行内公式 ├
│   /行内代码 chip/残留影子文本）      │
├ 原生嵌入图片（embedPng/Jpg）        │
├ 可见矢量文字（含合成加粗/斜体）      ├ Tr 3 隐形文本层
└ Tr 3 影子层（补丁内文字仍可选中）    ┘
```

关键不变量：**「位图里摘除的墨迹」与「矢量补画的视觉」严格同一批**——文本
判定（exportVectorText.decideTextVectorization）、装饰遮蔽
（applyDecorationTransparency）、补丁计划（collectPatchPlan）共享同一套
采集，错一批就是丢字或重影。分页器零改动（页数按构造与位图版一致，每轮
双模式对照断言）。

## 2. 各阶段实绩（commit 粒度）

### 阶段 0：表格边框速赢（R1）
根因：编辑器表格 CSS 全带 `.mditor-milkdown .ProseMirror` 前缀，导出文档
（body.vditor-reset + 裸 table）无一命中。修复：`exportProseCss.ts`
注入导出专用规则（编辑器同款：separate 折叠 + 外框 + 右/下内线 + 末列/
末行清线），`wrapHtml`（HTML 导出）与 `buildFactoryDocumentHtml`
（PDF/PNG 工厂）同源注入。顺带补齐 R1 同族缺口：引用块竖条/底色、mark
高光、代码块底色/边框、段落标题间距——此前导出文档同样全部丢失。
CSS 命中证据：工厂内 computed border 0.57px（DPR 1.75 物理像素吸附，
与编辑器同表现）、色值取自主题变量。

### 阶段 1：文本主路径矢量绘制
- 逐文本结点采集样式（字重/斜体/装饰线/颜色）→ 纯函数判定 → 矢量 run
  带色可见绘制（显式 `0 Tr` 重推防状态污染）。
- **位图摘除机制**：矢量文本结点包 `<span style="color:transparent">`
  （applyTextTransparency，cssText 快照还原）——只摘字形墨迹，不扰布局
  （页数/坐标零变化）、不误伤列表标记（::marker 继承原父级色）、不误伤
  currentColor 边框与下划线宿主。
- **顺带定罪修复①（预存在）**：多行文本结点整文按行重复铺设——隐形层
  时代即存在（pymupdf 实证标题两基线重复、代码块整文×5）。逐 code point
  取 rect 按垂直重叠分行出段，raster 模式影子层同步受益。
- **顺带定罪修复②（预存在）**：@pdf-lib/fontkit CFFSubset 把 subset 头
  offSize 写成 `cff.length`（=24，合法域 1-4）——FreeType/poppler 拒载。
  Tr 3 从不显示所以两年未暴露。patch-package 一字节补丁
  （`patches/@pdf-lib+fontkit+1.1.1.patch`，→ `cff.offSize`），两渲染器验证通过。

### 阶段 2：矢量装饰绘制
- 表格全量线段（外框 + 单元格内线，computed 实测色/宽）、引用块底色 +
  左竖条、hr → `drawLine`/`drawRectangle`；位图侧同批遮蔽
  （border-color/背景 transparent）。
- **跨页断口补线**：分页刀口切进表格纵向范围 → 两侧页切口各补横线
  （exportVectorDecor.decorationsToPageDecos，纯函数 + 9 例单测）。实测
  page1 底 997.5px / page2 顶 0 + 底 961.7px / page3 顶 0。
- 装饰线按「最近带线祖先」取有效值（传播近似）：underline/line-through
  不再阻断文本矢量化（矢量画线补回）；shadow 片段（如粗体链接）的线也
  补画——位图统一摘线后不丢线。mark 高亮 = inline 背景 provider 检测 +
  alpha 预混合页底色。
- 铁证：raster 页图边框灰阶行 47/8 vs vector 页图 0（位图摘除干净）。

### 阶段 3：复杂块局部光栅 + 图片原生嵌入 + 满铺位图退位
- 补丁 = 「未能矢量绘制的视觉」的位图裁剪矩形（从既有 chunk 位图裁出，
  零额外截图）：块补丁（公式块/代码块/svg 块/嵌套图块）、行内补丁
  （.katex/.katex-display/svg——公式不再拖垮整段位图）、残留补丁（影子
  文本按 extent 元素分组纵向合并，行内代码 chip 的底/边框全覆盖）。
- 顶层独立图（image-block，keepTogether 永不跨页）且 png/jpeg data URL →
  原生 embedPng/embedJpg（visibility:hidden 摘位图墨迹，同图缓存单嵌）。
- 满铺页位图退位；页底色改矢量矩形。**z 序**：底色 → 装饰 → 补丁 →
  原生图 → 文本（阶段 3 曾犯底色后画压住全部补丁的 z 序 bug，页墨量
  0→90% 恢复定罪后修复）。
- 工厂补 `img max-width:100%`（无尺寸属性 SVG 自然宽溢出版心，实测
  1280px > 680 版心）。

### 阶段 4：字体覆盖
- **合成加粗**：Tr 2（FillAndOutline）+ 0.026em 细描边（描边同填色）——
  不引入新字体文件（NotoSansSC 无 Bold 变体成品于 assets，单独 Bold
  ~10MB 不可行），pdftocairo 同款 fake-bold 手法。
- **合成斜体**：drawText xSkew 12°（文本矩阵剪切）。斜体 run 空格照铺
  （xSkew 使抽取器间隙推断失效会把「italic text」粘成「italictext」）。
- **字形覆盖检测**：fontkit 直读全量字体 `hasGlyphForCodePoint`
  （(codePoint) 级缓存，ASCII 直放）；缺字形（emoji 等）→ no-glyph →
  残留补丁兜底，绝不画 notdef 方框。
- 效果：残留补丁 12→1（仅剩行内代码 chip）；bold 105 + italic 16 字符
  转矢量。

### 阶段 5：开关 + 自动回退
- 设置 `exportPdfMode: "vector" | "raster"`（默认 vector），设置弹窗
  「导出」分区下拉；ExportOutcome 增益 meta，App 侧检测 vectorFallback
  → 状态栏告知「已自动回退位图模式完成（原因）」。
- 回退是阶段 1 就内建的整体重跑（矢量任何阶段非 Abort 异常 → 完整 raster
  重跑，工厂重建），阶段 5 失败注入实测：meta.vectorFallback 记因、产物
  与 raster 对照逐字节同体积、页数一致。

## 3. 最终回归数据（perf/results/rv-final/）

fixture：`docs/vector-export-demo.md`（中英文混排 + 24 行跨页表格 + 块/
行内公式 + 代码块 + 位图/SVG 图 + 加粗/斜体/高光/链接/行内代码；回放于
`C:/Users/hh/Documents/rv-fixtures/`——dev 实例 fs scope 只放行用户目录）。

| 指标 | raster | vector | 备注 |
| --- | --- | --- | --- |
| 页数 / 分页统计 | 4 / splits=1 | 4 / splits=1 | 逐字段相同 |
| 体积 | 902,906 B | 443,221 B | **-51%** |
| raster+assemble 耗时 | 1,736 ms | 1,139 ms | **-34%**（PNG 编码面更小） |
| 文本抽取字符数 | 1,723 | 1,726 | 含 3 个照铺空格；词级检索通过（"italic text" 命中） |
| 满铺大图（>500×700pt） | 4 张 | **0 张** | 补丁 4 块 + 3 行内 + 1 残留 + 原生图 1 |
| 4x 正文边缘宽（表格页） | 3.29 px | **1.42 px** | 2.3× 锐利 |
| 4x 正文边缘宽（公式/段落页） | 4.16 px | **1.83 px** | 2.3× 锐利 |
| 内容流算子 | — | 0 Tr×69 / 2 Tr×33 / 3 Tr×185 | 可见+合成粗+影子 |

文本覆盖率：1,208/1,522 = **79.4% 矢量**；影子 314（20.6%）= 等宽行内
代码 11 + 块级降级域 275 + KaTeX 28——全部由块/行内/残留补丁承载视觉，
Tr 3 影子层保选中。合成覆盖：bold 105 + italic 16 字符。

## 4. 遗留问题与取舍（如实）

1. **字形替换差异**：正文以 NotoSansSC 绘制，主题字体栈（Segoe/系统字）
   的字形形状有差（逐字符实测 advance 锚定，位置精确、形状近似）。编辑器
   视觉权重差约 ±20% 墨量（pymupdf 计）。彻底一致需内嵌主题同款字体，
   授权与体积不可行（OFL 外字体不可再分发）。
2. **合成加粗/斜体是近似**：fake-bold 描边 0.026em / oblique 12°，与真
   Bold/Italic 字形有肉眼可辨差异（标题、`**粗体**`、`*斜体*`）。
3. **表头跨页重复（P2 增强项）未做**：分页器纯函数铁律「只允许扩展不改
   行为」+ 页数一致性验收——表头重复会改变后续页内容排布，需分页器级
   特性立项（在断页处把表头行盒克隆为续页首段），本轮不做。
4. **斜体抽取的换行启发**：xSkew 下 pymupdf 的行切分启发与位图版略异
   （多/少 `\n`），词级内容一致；阅读器（PDFium）表现以人工终检为准。
5. **表格圆角**：矢量边框画直角（编辑器 8px 圆角在 0.5px 线宽下不可辨）。
6. **行内图片**（嵌在段落中的图）：走所在块的位图补丁（跨页裁切安全），
   未做原生嵌入；顶层 image-block 原生嵌入。
7. **PNG 导出**：代码零触碰；但阶段 0/3 的工厂 CSS 补齐（表格边框/引用
   竖条/图片钳宽）同样作用于 PNG——是修复不是回归（PNG 此前同样丢表格
   边框）。
8. **人工视觉终检待做**：本会话执行模型与 visual-judge 子代理均无图像
   输入能力，全部验收以程序化证据（结构断言/墨量对照/边缘宽度/抽取比对）
   完成；`perf/results/rv-final/`（双模式 PDF、逐页位图层 PNG、5.33x
   裁片 crop-400p-*、rv-final-export.html）已留档，建议用户浏览器直开
   HTML 查表格边框 + 阅读器开 PDF 抽查选中/搜索/400% 缩放。

## 5. 测试

全量 vitest **1,134 绿**（104 文件；本轮新增 36：exportProseCss 5、
exportVectorText 13、exportVectorDecor 9、exportVectorPatch 7、组装器/
管线扩展若干）+ tsc 干净。perf 脚本：`rv-phase0-table.mjs`、
`rv-phase1-vector.mjs`、`rv-phase3-patch.mjs`、`rv-phase5-switch.mjs`、
`rv-final.mjs`、`rv-line-detect.mjs`（全部 CDP 驱动真机 dev 实例）。

**过程教训（入库）**：dev 实例改码后必须重启再 CDP 回归——动态 import
的模块缓存不随 HMR 刷新，阶段 2 曾因陈旧模块误判「断口补线缺失」绕了
远路；`location.reload()` 会把应用卡在开屏（会话恢复路径），用进程重启。

## 6. Plan B（只记录不实施）

若矢量保真度终验不达标（用户人工终检 §4.1/§4.2 不接受字形/合成差异）：
Rust 侧经 `with_webview` + webview2-com 调 WebView2 原生 `PrintToPdf`
（Chromium 原生排版引擎输出真矢量文本，字体/字重/斜体零近似）。仅
Windows 可用（其他平台维持本管线）；触发条件：用户对 Noto 字形替换或
合成粗斜体提出不可接受的视觉异议，且愿意接受打印语义差异（分页由
Chromium print 决定，现有分页器/断口补线不生效）。
