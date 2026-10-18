# mditor 导出两症状修复——结题报告（HX 轮）

> 任务书 `docs/prompts/html-pdf-export-fix-prompt.md`（用户报障两症状，均观察于打包版 5.0.2-beta）。
> 修复系列：`8da2982`（定罪）→ `b2ab0e9`（Fix-H1）→ `fc5adfc`/`18754ca`/`2f7a57a`（P-α/β）→
> `0cab9ff`/`58eb0ce`/`c0b7a37`（P-γ）→ `e1f5a52`（P-δ）。

## 0. 症状与结局

| 症状 | 根因 | 修复 | 终验 |
| --- | --- | --- | --- |
| E-H1 导出 HTML 浏览器打开无法滚动 | 应用外壳 `html,body,#root{height:100%}` + `body{overflow:hidden}` 随 `collectThemeCss` 整包进入导出文件，`wrapHtml` 默认层叠盖不掉 | Fix-H1：wrapHtml 外壳显式覆盖 height/overflow | H2 门 5/5（light/dark × 公式/内联/无公式矩阵：用户滚动到底 + 主题保真） |
| E-P1 PDF 分页边界一行字被横切 | 四层叠加：坐标系混用（P-α）/ 定高网格 vs 变高页（P-β）/ 行盒外墨迹（P-γ）/ trim 塌缩再生漂移（P-δ） | 分层修复见 §1 | 密度档 87 页全量重导：程序扫描 0 切字 + 视觉终裁 5/5 A |

npm test 98 文件 **1089/1089 绿**；demo 档（2 页）零标记；C1/H2 回归 5/5。

## 1. PDF 四层根因与修复（按定罪顺序）

### 1.1 P-α：行盒坐标系混用（`fc5adfc`）

`lineBoxes`/`tableRows` 里 Range/getBoundingClientRect 是**视口坐标**，块顶是 content 相对坐标——
content 视口原点 ≠ 0（首块塌缩 margin）时全部行盒整体偏移，刀口切进视觉行内部。
修复：先减 `base.top` 换算回 content 相对。

### 1.2 P-β：变高页 vs 定高网格切片（`18754ca` + `2f7a57a`）

分页器产出**变高页**（短页提前收尾，页顶链式推进），光栅切片却按 `i×contentHeightPx`
定高网格取条带 → 提前收尾页之后累计漂移（密度档实测最大 211px），页界落在任意墨迹上；
取满窗还会使变高页窗口互相重叠（内容跨页重复 + 页底缘切在下页开头内容上）。
修复：`pageSliceSourceY`/`pageSlicePlan` 切片位严格跟随 `pages[i].top`，页竖片按变高页拼接
（零缝隙零重叠，短页尾部由页画布背景填充）。

### 1.3 P-γ：行盒外墨迹出刀（`0cab9ff` + `58eb0ce` + `c0b7a37`）

字形墨迹可越出文本 rect 盒：KaTeX 大操作符降部（∑）越盒 ~0.5px、行内极限栈
（vlist 零高盒）越盒 ~3.5px——刀口贴行盒底会剃进笔画（页尾全浓墨平切像）。
修复：两遍式墨迹感知 rebase（首单元负顶进 inkTop 链）+ 行盒底自适应护量
`INK_GUARD_MAX_PX=4`（外扩 min(4, 相邻行间隙半宽 − 0.25)，表格行不外扩）。

### 1.4 P-δ：trim 绝对化后 margin 塌缩再生 → 内容 +16px 漂移（`e1f5a52`，本轮终局）

**定罪链**（密度档 87 页重导后残余三处：p71 页底粗体行拦腰切断、p75/p76 页顶 1~3px
孤立墨条残端，且 p74/p75 页底反而干净）：

1. 刀口取证（`perf/hx-knife-forensics.mjs`）：测量布局里三处刀口两侧各有 4~16px 净空
   ——**测量面本身无骑墨**，矛盾指向光栅面漂移。
2. trim 复刻探针（`perf/hx-trim-drift.mjs` + `hx-drift-anatomy.mjs`）：复刻
   `rasterizeAndAssemble` 的 win+translateY+ChunkTrim 流程后实测，**列表内容整体 +16px**：
   OL/UL 盒顶不动、盒高 +16、内部全部 LI 下移 16；非列表 kid（P/H3/TABLE）drift=0
   ——干净刀口与症状刀口的分野完全吻合。
3. 机制：`ChunkTrim` 把 content 顶层子元素 `position:absolute`（配 `margin:0`、top=原
   border 盒顶）以做窗口裁剪——**绝对定位盒的 margin 不再与子级塌缩**（CSS 2.1 §8.1），
   原本「塌缩穿透到盒外」的首行链 margin（本应用列表/段落 16px）在盒内重新生效，把该块
   全部内容推低同距。页窗刀口按测量布局落位 → 在此类块上系统性偏上 16px：
   - 刀口落进上一行字身 → 页底拦腰切（p71）；
   - 上一行墨尾被推出本页窗、以残端出现在下页顶（p75/p76）；
   - 上页页底净空反而变大（p74/p75 页底干净）——三症状同源。
4. 症状稀少性（86 刀仅 3 处）自洽：漂移只发生在「被绝对化的 kid 内部」，且仅当列表
   内容骑刀口时可见。

**修复**：构造期记录每 kid「首个流内块级后代」锚点（`anchorOf`：沿首个非 inline/非浮动/
非 absolute 子元素下钻，塌缩链只经这条路径穿透块顶）的原位 top；`apply()` 绝对化后强制
一次布局、重测锚点，漂移 >0.5px 则把 kid `top` 回拨（先全量读后统一写，避免逐 kid 回流）。
测量即真值：无需枚举塌缩条件（padding/伪元素/BFC 分隔等）；有涂装盒自带 padding 分隔
塌缩不漂移，回拨量自然为 0。

**终验**（`perf/hx-g3-verify.mjs`，生产路径 `runPdfPipeline` 全量导出 + 逐页页缘墨扫描 +
疑点条带图自动裁剪）：

- 程序门：87 页唯一标记 p0 = 首页顶（文档自带整宽暗带，内容从 y=0 起排，上轮已知正常）
  + 首页底（完整整宽分隔线，页底净空 66 CSS px；末行「墨」为 JPEG 振铃 <3 像素）。
  三症状位全净：p71 页底净空 10 CSS px AA 收排、p75 顶净空 5 px、p76 顶净空 6 px 自然起排。
- 视觉门：pdf:visual-judge 终裁 5/5 全 A（上轮三 B 位复验确认修复）。
- 分页统计与修复前完全一致（87 页 / 22 splits / 0 clipped）——补偿只还原几何，不改分页。

## 2. 工具沉淀（perf/，均 CDP 驱动免对话框）

- `hx-g3-verify.mjs`：生产路径全量导出 + 页缘墨扫描 + 条带图（可复跑验收门，取代上轮
  一次性扫描器；`ALSO_STRIP=71,75,76` 可强制指定页裁带做前后对照）。
- `hx-knife-forensics.mjs` / `hx-trim-drift.mjs` / `hx-drift-anatomy.mjs`：刀口几何取证与
  trim 漂移定罪三件套（本轮 P-δ 定罪链的复现脚本）。
- `hx-png-profile.mjs`：零依赖 PNG 行墨剖面分析器（Node zlib 解码，非交错 8bit 全色型）。
- 既有 `ex-hx-pdf-audit.mjs`（刀口 vs 墨迹骑刀审计）注意其墨迹集只含文本/svg rect，对
  「rect 外墨迹」与「光栅面漂移」两类盲——P-γ/P-δ 各补一类，审计仍是最快的第一道筛。

## 3. 已知取舍与待办

- 页图 JPEG 档（87 页 × 2x 解码预算 > 256MB）在白底上末行可有 <3 像素振铃，扫描阈值
  已按「>2 像素」豁免；主题深底档未复测该阈值。
- `runPdfRasterAb`（EX 阶段六 A/B 工具）内部仍用定高网格切片（其行剖面互相关与 rectDiff
  结论不受影响，但页位图 dump 不可作为切片正确性证据）——如需复用先同步 pageSlicePlan。
- 表格行不做墨迹护量（边框线贴行界，外扩反而切边框）：若未来出现「表格行内公式降部
  越界」症状，需单独评估。
- 文本层（fragmentsToPageRuns）与位图同用测量坐标，P-δ 后三路坐标系对齐；未做逐页文本
  层偏移的独立回归（C1 口径未覆盖）。
