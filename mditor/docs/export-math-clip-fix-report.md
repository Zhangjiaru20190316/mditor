# 导出公式截断根治 + 导出链全面正确性修复结题报告（MC 轮）

> 窗口：2026-11-12。范围：用户报障「PDF 导出的公式截取不全」为引子的
> 导出链全面审查与修复（PDF/PNG/DOCX/LaTeX/HTML 五出口）。复现与验收
> 工具：`perf/mathclip/`（Edge headless + CDP 驱动 vite dev 页面，真实
> 布局），证据入 `perf/mathclip/results/`（baseline/fixed/final/post-sweep
> 四轮 JSON；E2E 页图与既往 perf 证据同为本地留档未入库）。

## 0. 结论一览

| 根因 | 症状 | 修复 | 关键数据（前 → 后） |
|---|---|---|---|
| 超宽 display 公式（nowrap 块）溢出版心 | PDF/PNG 长公式右侧整段消失 | 工厂布局后缩放归一（transform + 高度补偿） | content 宽 1083→680（版心），溢出 403px→0 |
| 补丁矩形用布局盒，KaTeX 墨迹越盒 | ∑ 上下限/行内高公式上下沿被削 | 墨迹盒并集 + 3px 护量 + 版心钳制 | 墨迹越盒 5~24px → 补丁全覆盖（anyClipped false） |
| aligned/cases 行盒 2px 缝 | 分页刀口落进公式内部（跨页两半） | md-math-block 原子分页（≤1 页高时） | keepTogether 0/4 → 4/4 |
| DOCX 栅格化窗口用 offsetWidth/Height | 行内高公式上下沿被削（同根因二） | 外包裹壳撑到墨迹盒 | 窗口 24+14px 缺口 → 墨迹全覆盖 |

回归：全量 vitest 1460→1483 绿（+23）；tsc/eslint 0 错（7 warning 全为
既有）；`npm run build` 通过；真浏览器四轮复验全绿；E2E 完整 PDF 管线
出 4 页图，像素级验收公式笔画无削/无页缘切越/无重叠缺失。

## 1. 定罪方法（真实布局，非纸面推断）

`perf/mathclip/repro.html`（vite dev 转译 TS 模块直驱）构造四形态公式
夹具——TALL（∑/∏/lim 嵌套分数）、GAPFRAC（偏微分方程组）、ALIGNED
（四行对齐方程）、WIDE（长多项式）、TALLINLINE（行内 √分式）——在
A4/15mm 版心（680×1009px）工厂里跑真实测量面：

- **墨迹面**：文本 run 的 `Range.getClientRects` 并集 + svg 盒（首版误把
  KaTeX 不可见 `pstrut` 撑高件计入——50px 假上溢，修正后才是真墨迹）；
- **分页面**：`measureBlocks` → `paginateBlocks`，检查公式块的行盒碎片
  与跨页段；
- **补丁面**：`collectPatchPlan` 的矩形 vs 墨迹盒覆盖判定。

### 定罪数据（baseline.json）

```
wide:    contentScrollWidth 1083 vs 680（WIDE 公式右侧溢出 403px）
patchInk: display#1 墨迹越布局盒上方 5px；WIDE 右侧 403px；
          inline 墨迹上方 24px / 下方 14px
pagination: ALIGNED 行盒 [0,72]+[74,173]——2px 缝可落刀口
```

附：TALL 公式含 `\sqrt`（KaTeX 内嵌 svg）→ 整块走**块级补丁**路径，
矩形同样缺墨迹——`\sqrt` 是最常见公式构件，该路径是主受害面。

## 2. 修复设计

### 2.1 墨迹盒测量 `lib/exportInk.ts`（新）

`inkRectOf(el)`：子树内可见墨迹的联合矩形（视口坐标）——TreeWalker 文本
节点 + Range 矩形，跳过 `.katex-mathml`（隐藏）与空白文本；`svg` 后代盒
计入（`querySelectorAll` 不含自身，元素自身是 svg 时自盒计入）。配套
`padAndClampInkRect`：四边 +3px 护量（吸收字形 em 盒外悬挂与采样舍入）、
横向钳版心（补丁从 chunk 位图裁剪时源矩形越界会被 clamp 成「裁小画大」
的错位拉伸）。

### 2.2 超宽公式缩放归一（`exportRenderFactory.normalizeOverwideMath`）

工厂资源就绪后（settle 之后、任何测量之前——分页/补丁/文本素材坐标面
全链自动一致）：

- display 公式：墨迹宽 > 版心 → 内层 `.katex` 施加
  `translate(dx,dy) scale(k)`（原点 = 墨迹盒中上；dx 把墨迹水平中点对齐
  版心中线，dy 吸收 vlist 上溢对齐盒顶），`.katex-display` 显式高度补偿
  （inkH·k，防缩放视觉与后文重叠）；
- 行内公式（非 display 内）：墨迹宽 > 版心 → 锚墨迹盒左下角缩放（行盒
  不变——transform 不参与排版，墨迹缩进行盒内）；
- 版心内公式零改动；k ≥ 1 不动。

同族收口：工厂 CSS 补无滚动媒体面规则——`pre` 按字符回行
（`white-space:pre-wrap; overflow-wrap:anywhere`，超长代码行此前同样被
窗口硬裁）、`table`/`svg` 钳版心（表格单元格 anywhere 换行允许挤压）。
HTML 导出**不注入**（浏览器里 pre 保持 overflow:auto 滚动语义，非截断）。

### 2.3 补丁矩形墨迹化（`exportPdfPipeline.collectPatchPlan`）

含 `.katex`/svg 的补丁（块级 + 行内）取「元素盒 ∪ 墨迹盒」换算 content
相对坐标后钳制护量；**行内补丁的自身匹配**：`.katex`/`.katex-display`/
svg 自身即矢量件，`querySelector` 只查后代——首版漏判致行内公式仍走纯
布局盒（单测抓住）。纯 `pre` 块无墨迹越盒（回行后内容必在盒内），保持
元素盒原语义零开销。

### 2.4 公式块原子分页（`measureBlocks`）

`div.md-math-block` 标记 keepTogether（行盒仍照常测量——Pass-2 墨迹链
inkTop/coverBottom 对公式块同样成立，墨迹可越出 border 盒）。**高于一页
的极端公式放行按行切分**：整块推下页必然溢出页底丢内容，完整性优先。
调试/AB 路径（不传 contentHeightPx）保持无条件原子。

### 2.5 DOCX 栅格化墨盒（`exportMath.rasterizeFormulas`）

`domToPng` 的 width/height 即 SVG foreignObject 裁剪窗。改为外包裹
`display:inline-block` 壳，内边距 = 各向墨迹越盒量 + 3px 护量，壳尺寸
（`getBoundingClientRect().width`，jsdom 无布局时 offsetWidth 兜底）作
栅格化窗口；失败还原包裹。

## 3. 导出链全面审查（P1×4 + P2×7，全修）

code-reviewer 子代理对 exportLatex/flashcardExport/citationExport/
exportPngPipeline/exportCodeHighlight/App 导出编排只审不改，产出 4 P1 +
9 P2；逐一核实后修复（2 个 P2 判定不修：verbatim* 方案会显空格改用拆段
桥接实现；`&#38;` 序列化形态不可达但单趟解码顺带修了）。明细见
CHANGELOG 5.3.4。要点：

- **四 P1 全是「导出产物内容丢失/错位」类**：LaTeX 闪卡语法泄漏（remarkFlash
  未注册）、`{#fig:id}` 独立属性段泄漏为转义残文本、嵌套闪卡内容重复 +
  孤立 `</div>`（HTML/PDF/PNG/DOCX 四路径共用降级函数）、空文献表吞
  References 标题；
- **引用表替换区间与静态渲染对齐**（References → 下一同级/更高级标题）
  是行为变更：此前导出只替换紧邻列表，手写占位内容会与生成表重复并列；
  静态渲染（remarkCitation.injectReferences）一直是区间替换语义，导出对齐
  后预览与产物一致。`citationExport.test` 两例断言随之改锚。

## 4. 验证

- **单测**：+23 例（exportInk 16：墨迹测量/护量钳制/原子分页三分支/补丁
  墨迹三形态/缩放归一三形态/工厂 CSS/DOCX 壳；exportLatex 6；闪卡嵌套 1）。
  期间抓住两个实现 bug：坐标基准（视口坐标未换算 content 相对即钳制）与
  行内补丁自身匹配——jsdom 原型级 rect 注入有效；
- **真浏览器四轮**：baseline（定罪）→ fixed（三修复各自生效）→ final
  （行内补丁走真墨迹路径）→ post-sweep（工厂 CSS 变更后回归）；
- **E2E**：raster 模式真跑 PDF 管线出 4 页图（矢量模式的 onPagePng 只是
  「位图层视图」，矢量文字不进图——验收必须用 raster 全视觉页图）。像素
  级判定：4 页互异无空白、无页缘切越、行带连续无缺失；补丁层（公式真实
  像素所在）笔画级测量：∑ 上下限顶部/根号上沿/分数边界墨迹平滑渐入无削、
  WIDE 缩放后右端字形完整、行内高公式上下净空；
- **门禁**：vitest 1483/1483、tsc 0 错、eslint 0 错、`npm run build` 通过。

## 5. 取舍与遗留

- **性能**：墨迹盒测量对公式补丁逐文本节点走 Range（normalize 与
  collectPatchPlan 各一遍）。典型文档（几十个公式）毫秒级；500 公式
  压力档估算 +0.5~2s（对照 EX 轮 24s 基线，<8%）——正确性优先，未做
  双遍合并缓存（可作后续优化）；
- **超宽公式缩放而非换行**：KaTeX 无断行能力，缩放是唯一保真手段（与
  Word「缩小文本以适应」同类语义）；k 无下限（极长公式会显著变小但完整）；
- **\href URL 转义**按 hyperref 文档口径（`%`/`#` 转义、反斜杠/空格百分号
  编码、`~` 原样）——未在 Overleaf 实测全部字符集，异常 URL 形态可跟进；
- **raster 模式（矢量失败回退）**的超宽公式同样受益于工厂归一（共享工厂）；
  raster 模式固有的 ms 克隆漂移（文档化遗留）不在本轮范围。

## 6. 工具沉淀

`perf/mathclip/`：`repro.html`（vite dev 模块直驱复现页，?fill=N 控制页
界位置）+ `run.mjs`（CDP 驱动，diag/e2e 双模式，console 异常采集）。后续
导出回归可直接复用该骨架。
