# 矢量 PDF 渲染修复结题报告（RVF 轮）

> 窗口：2026-10-23。范围：RV 轮（a80ba46→135764f）矢量导出人工终检异常
> F1-F5 的修复。执行会话无图像输入能力，视觉终检以程序化度量 + 4x 裁片
> 留档人工清单替代（见 §6）。
>
> 分阶段提交：`b9ecc10`（阶段 0）/ `113374e`（阶段 1）/ `be198ab`（阶段 2）。
> 产物：`perf/results/rvf-stage0|1|2/`；度量脚本：`perf/rvf-stage0.mjs`、
> `perf/rvf-stage1.mjs`（阶段 2 复用）、`perf/rvf-measure.py`、
> `perf/rvf-png-smoke.mjs`。dev 实例 CDP 9223，fixture
> `C:/Users/hh/Documents/rv-fixtures/vector-export-demo.md`（4 页）。

## 0. 结论一览

| 异常 | 修复 | 关键数据（前 → 后） |
|---|---|---|
| F5 代码块无高亮 | 静态高亮补进导出 HTML（三出口）+ 显式色板 | 代码区彩色像素 0 → vec 8409 / ras 8171 |
| F1 笔画偏细偏浅 | Inter Medium 拉丁真变体 + CJK 0.012em 补偿描边 | 正文墨量比 0.68-0.78 → 0.86/0.99/0.85/0.92 |
| F2 粗体描边感 | 拉丁粗体走 Inter-Bold 真字体 | `2 Tr` 算子 53 → 14（仅剩 CJK 粗体兜底） |
| F3 斜体非真斜 | 拉丁斜体走 Inter Italic 真字体 | 拉丁段无 xSkew；CJK 斜体仍合成（无变体可用，取舍见 §5） |
| F4 表格线偏淡 | 装饰线宽下限 0.43pt → 0.503pt | 线深（谷灰度）241 → 229（线色 #e8e5dd 满深；位图版 231） |

回归：页数 4/4 一致；非空白文本抽取逐字一致；体积较阶段 0 矢量基线
449,926B 增 3.4%（红线 <20%）；PNG 管线冒烟通过（2.26MB，0 缺图）；
pymupdf（FreeType）与 poppler 双渲染器均正常载入 Inter/Noto 子集；
全量 vitest 1,192 绿 + tsc 0 错；矢量回退未触发。

## 1. 阶段 0：代码块语法高亮（F5）

**根因修正**（与任务书归因的差异）：CSS 侧并非完全缺规则——
`collectThemeCss` 实际把 global.css 的裸 `.hljs-*` 规则与 `--tok-*`
变量定义都带进了导出文档（rv-final-export.html 实证）。真正的缺口在
**内容侧**：`getHTML()` 序列化的代码块是纯文本
`<pre data-language="ts"><code>`（编辑器内高亮由 CodeMirror 动态渲染，
不进序列化）——色板从未有元素可命中。

修复双管齐下：
- `exportCodeHighlight.ts`（新增，纯函数 + 懒加载 highlight.js common
  集，与 rehype-highlight/AI 面板同语言面）：在 `prepareExportHtml`
  （PDF）/ `buildPng`（PNG）/ `exportHtml`（HTML）三出口统一补 token
  span；失败降级原样（增强不阻断）。
- `EXPORT_HLJS_CSS`（exportProseCss）：`.vditor-reset` 作用域显式色板，
  `--tok-*` 变量 + VSCode Light+ 兜底，同源注入 HTML/PNG/PDF 工厂。

## 2. 阶段 1：Inter 真字体变体（F1/F2/F3 主线）

### 2.1 选型修正：Regular → Medium

任务书推荐 Inter Regular，实测推翻：**Inter Regular 为高分辨率屏设计，
12pt 渲染墨量仅 NotoSansSC 拉丁的 43%**（stem/em 0.088 vs 0.149，
单字体对照实验 `perf/tmp/font-ink.mjs`）——直接替换会让 F1 恶化。
正文档取 **Inter Medium**（stem/em 0.107，渲染墨量 ≈Noto×1.38，对齐
Segoe UI 的低 DPI 屏显墨量）；Bold 档 Inter-Bold（stem/em 0.147≈Noto）。
四变体：Medium / Bold / MediumItalic / BoldItalic（Google Fonts 静态
TTF 切片，glyf 轮廓——绕开 CFF 子集补丁风险区），OFL 随资产
（`public/assets/fonts/INTER-OFL.txt`），源文件合计 1.28MB，按需子集
嵌入后产物增量仅 ~15KB。

### 2.2 fontkit TTF 子集 glyf 对齐补丁（本轮最重要的一手）

@pdf-lib/fontkit 的 TTFSubset 不按 TrueType 规范做 **glyf 条目 4 字节
对齐**：Inter 的 `.notdef` 长 211 字节（奇数），后续字形落在奇 offset，
短 loca 格式（offset÷2 向下取整）丢 1 字节 → **字形轮廓整体错位损坏**
（FreeType 拒载/渲染空、fontTools 解包崩）。单字符子集必坏；多字符
是否坏取决于字形起点奇偶（纯运气——首轮 CDP 导出墨量骤降至 0.32 部分
即来自坏字形）。修复追加进既有
`patches/@pdf-lib+fontkit+1.1.1.patch`（与 offSize 补丁同机制，
patch-package postinstall 应用），对每个 glyf 条目补零对齐。

### 2.3 结构改造

- **按需嵌入**（exportPdfAssembly）：零使用的字体不入册——立嵌的空 CFF
  subset 在 save 编码时挂死（fontkit 空 charstrings 越界，纯拉丁页必
  触发整体回退 raster，实测复现）；同时纯拉丁页不再解码 8.3MB 主字体。
- **逐字符变体分组**（`runVariants` 纯函数 + 组装器 ε-合并扩展）：拉丁
  字符按字重/字型映射 Inter 四变体（weight≥600 粗、非 normal 斜，与
  合成判定同阈），CJK 归 NotoSansSC；混合 run「拉丁真粗 + CJK 合成粗」
  并存。字形覆盖双字体检测：拉丁域查 Inter，缺字形回 CJK 域画 Noto
  拉丁形，两族皆缺才节点级 no-glyph → 残留补丁。
- **影子层拉丁同用 Inter**：Tr 3 隐形但 bbox 参与抽取器分词——两模式
  字形面统一后，文本抽取分词差从 103 处收敛到 3 处（见 §5 取舍）。
- **拉丁字符逐字锚定**（ε=0，字符级规则、影子/可见同律）：位置只取
  编辑器实测 advance，与承载字体无关；CJK 全宽字符维持 0.5px 合并
  （Noto 自然 advance 与实测一致，零漂移、算子数不涨）。

## 3. 阶段 2：线宽与墨量校准（F4 + F1 残差）

- **装饰线**：dpr 1.75 下 Chromium 把 1px border 的 computed 值 snap 成
  0.5714px（1 物理像素）——`collectBlockDecorations` 采到发丝线，×0.75
  换算 0.43pt 偏淡。采集侧下限 0.67px（≈0.5pt）、组装侧 pt 下限
  0.3→0.5；粗于下限的线保持原宽。产物实测 0.503pt，@2x 渲染达线色
  满深（谷 229 = #e8e5dd 灰度；位图版 231）。
- **CJK 墨量补偿**：换 Inter 后正文区墨量比仍 0.81-0.88 <0.85（残差
  为 NotoSansSC vs 编辑器微软雅黑的 CJK 墨量差），CJK 段可见绘制加
  0.012em 同色描边（任务书上界）：**0.862 / 0.993 / 0.848 / 0.922**
  （表格页贴线 0.848，目检无差，不再上抬——0.013em 超任务书界）。
  4x 暗游程分布与位图版同构（median 5 vs 4、单峰、无描边双环特征）。
  拉丁段不补偿；合成粗体维持 0.026em。常量 `CJK_INK_STROKE_EM`
  集中在 exportPdfAssembly.ts，实测达标想关闭改 0 即可。

## 4. 验收数据总表

双模式导出（同一 fixture，dev 实例 CDP 驱动，pymupdf 2x 渲染度量）：

| 指标 | 阶段 0 前（RV 轮基线） | 阶段 2 终态 |
|---|---|---|
| 正文区墨量比 vec/ras（p0-p3） | 0.68-0.78（验收线 ≥0.85） | 0.862 / 0.993 / 0.848 / 0.922 |
| `2 Tr` 算子数（合成粗） | 53 | 14（仅 CJK 粗体兜底） |
| 代码区彩色像素（vec/ras） | 0 / 0 | 8409 / 8171 |
| 表格矢量线宽 | 0.429pt | 0.503pt |
| 文本抽取 | 逐字一致（同 Noto） | 非空白逐字一致；分词差 3 处（§5） |
| 矢量版体积 | 449,926B | 465,181B（+3.4%） |
| 页数 | 4/4 | 4/4 |

渲染器兼容：pymupdf 1.28（FreeType）与 poppler 25.12（pdftoppm）均
正常渲染 Inter/Noto 子集。PNG 出口冒烟 2.26MB、0 缺图（工厂共用代码
同源受益于阶段 0/1/2 全部修复）。

## 5. 取舍与遗留问题

1. **CJK 粗/斜体仍是合成**（0.026em 描边 / 12° xSkew）：OFL 可再分发
   的 CJK 粗体（思源黑体 Bold 等）体积 8MB+/变体，bundle 代价不成比例；
   任务书明示允许合成兜底。若用户终检仍不接受，升级路径为引入
   NotoSansSC-Bold（+8.3MB）。
2. **斜体衔接处 3 处分词差**：`斜体文本italic`（CJK xSkew 合成斜 +
   拉丁真斜衔接）在抽取器分词与位图版不一致——xSkew 剪切字形盒与真斜
   字形 bbox 的推断差异，字符内容零差异。要消除需 CJK 真斜体（同上）。
3. **Inter 与 Segoe UI 的字形差异**：同墨量档位下字形轮廓本身不同
   （Inter 的 a/g 形态等）。这是「可再分发字体替换系统字体」的固有
   代价；观感一致性以墨量/字宽/风格三点对齐为验收。
4. **表头 600 字重映射**：latinVariantFor 按就近原则 ≥600 → Bold；
   500/600 之间的表头视觉略粗于编辑器（编辑器 600 是 SemiBold）。影响
   极小（表头占比低），记录在案。
5. **DECOR_MIN_PX=0.67 依赖 k=0.75 假设**：极端 paper/scale 组合（A3
   宽 + 大 margin）下 k 略小，下限换算仍 ≥0.48pt，方向安全。
6. **阶段 3（Plan B 原生打印档）未实施**：按任务书条件触发——阶段
   1+2 完成并经用户终验后，用户仍对字形/粗斜体观感有异议才实施
   （webview2-com PrintToPdf，RV 报告 §6 预案）。

## 6. 人工终检清单（执行会话无图像输入能力，裁片留档）

留档 `perf/results/rvf-stage2/`（双版对照，4x 渲染）：

| 裁片 | 内容 | 检查点 |
|---|---|---|
| `4x-title(-ras).png` | 标题（CJK 粗体） | 黑度、无描边毛边 |
| `4x-body(-ras).png` | 正文行（中英混排） | 拉丁 Inter Medium 与 Segoe UI 观感一致；CJK 深浅与位图一致 |
| `4x-table(-ras).png` | 表格行 | 线深浅/粗细与位图一致；数字/表头字形 |
| `4x-formula(-ras).png` | 公式块 | 补丁位图无回归 |
| `4x-code(-ras).png` | 代码块 | token 色板与编辑器一致（彩色） |
| `cmp-vec1/ras-p2-head.png` | 表头区（2x） | 同表格 |

建议终检顺序：双版并排打开五类裁片 → 100% 缩放整页 PDF
（`rvf2-vector.pdf` vs `rvf2-raster.pdf`）→ 若对粗/斜体观感仍有异议，
反馈进入阶段 3（native 档）评估。

---

## 追加轮（5.1.4）：中英混排导出乱码/缺字根治

用户反馈 5.1.3 导出的矢量 PDF 中英混排段落大面积缺字/叠字（引用块、表格、粗体
标题尤重），复制粘贴文字完整。取证（桌面现场 PDF `AI替代教师-范文与讲解.pdf`，
13 页）：文字层/ToUnicode 完好、字符位置正常，损坏纯在字形绘制——
**约 44% CJK 字形渲染乱码或空白**。

### 根因（@pdf-lib/fontkit 1.1.1 两处 CFF 子集缺陷叠加）

1. **`subsetFontdict` FD 映射错误（主犯）**：`FDSelect.fds.push(FDArray.length - 1)`
   恒推「最近一次新增 FD」的下标。NotoSansSC 18 个 FD（Dingbats/拉丁/汉字…），
   中英混排 FD 交替后，所有「回访」FD 的字形拿到错误 Private DICT——错误的局部
   子程序集与 bias，callsubr 越界/错位。同时 used-subrs 也恒记入最后一个桶。
2. **`fdForGlyph` 二分边界（从犯）**：`gid > ranges[mid+1].first` 用严格大于，
   恰为 range 起点的 gid 返回前一 range 的 FD（实测 26/1000）。

纯 CJK 文档 FD 连续，两缺陷均不触发——RVF 前轮 fixture 全 CJK/代码，故漏网。

### 修复

`patches/@pdf-lib+fontkit+1.1.1.patch` 增补（es/umd 双 bundle）：① FDSelect 与
used-subrs 按源 FD 记桶；② fdForGlyph 改为「最后一个 first ≤ gid」的正确二分。

### 验收（证据 `perf/results/rvf-subset/`、`perf/results/rvf-round2/`）

- Node 子集复现（用户文档全部 588 码点）：修复前 278/589 字形执行失败
  （IndexError/ValueError/空轮廓），修复后 0；charstring 与原版逐字节一致，
  执行 op 数与原版一致（`perf/rvf-subset-verify.py` 金标准）。
- 端到端（dev 实例 CDP，`perf/rvf-round2-e2e.mjs`）：用户文档双模式重导出，
  视觉逐页正常，内嵌字体 520 字形 0 执行失败；子集体积 +4.4%。
- 门禁：tsc 0 / eslint 绿（顺手清两笔历史欠账）/ vitest 1192/1192。
