# HX 阶段一 E-P1 定罪结论（症状：PDF 分页边界一行字上半截留本页、下半截落下页）

日期：2026-10-17 · HEAD `3660e93`（5.0.2-beta 同源）· 取证环境：dev 实例（CDP 9223）+ `__exportDebug.exportPdfTo` 直驱
+ Edge headless 像素级判定（visual-judge）

## 结论（双共根因，均在测量/分页段——家族甲；两缺陷独立成立、 jointly 产生症状）

### P-α：lineBoxes/tableRows 坐标系混用（exportPdfPipeline.ts:280-300, :266-274）

`textRectsOf`/`tableRows` 的 `Range.getClientRects`/`getBoundingClientRect` 返回**视口绝对坐标**，
而 `measureBlocks` 传入的 `blockTop` 是**content 相对坐标**（已减 content 基准）。`cur.top − blockTop`
只在「content 容器视口原点恰好为 0」时碰巧正确。实测 demo.md 工厂中 content 视口原点 = **21.4px**
（首块 H1 的 margin-top 21.4px 塌陷到 #mditor-export-content 之外，contentOffsetTop=21），
**所有行盒系统性 +21.4px** → 分页刀口切在「真实行底 + 21.4px」＝下一行中部 13.4px 深处（与墨迹审计
above:13.4 精确吻合）。表格行盒同构缺陷。demo.md 实测：段落真实行盒 rel [4,24]/[32,52]，measureBlocks
返回 [25,45]/[53,73]（多次调用确定性复现）。

### P-β：变高页 vs 定高网格切片（exportPdfPipeline.ts:598-651）

`paginateBlocks` 的 `endPage` 令 page.bottom = 末段绝对底（≤ limit）——**变高页**，页顶链式推进
（demo 实测 page1 仅 991.3px ≠ 1009px）。而 `rasterizeAndAssemble` 的页画布裁切源 y =
`Math.round(i × contentHeightPx × scale)`——**定高网格**（chunkTop + i×1009）。任何提前收尾的页
（split/keepTogether push/orphan-widow/heading push——密度档 86 刀中 78 次提前收尾）都使 chunk 内
后续页切片 y 累计漂移（实测最大 **211.2px**），产物物理页界 ≠ 分页刀口，落在任意墨迹上。
文本层 `fragmentsToPageRuns` 用 pages[i].top（变高）——与光栅网格互相脱节。

## 三层证据链（全部落 perf/results/ex-hx-repro/）

1. **程序化刀口审计**（ex-hx-pdf-audit-*.json / ex-hx-grid-audit-*.json）：
   分页刀口骑墨 31/86（P-α 域）；产物网格边界骑墨 **56/86（65%）**（P-β 域）；漂移剖面
   [0,−46.6,−49.4,−58.2,0,−3.7,−57.6,−106.3,0,−29.8…]（chunk 边清零又再漂，maxAbs 211.2）。
2. **坐标溯源探针**（ex-hx-probe-block11.json + 会话内探针）：同厂同刻重复测量稳定；
   `contentViewportTopRaw=21.4` 恒定（before/during/after 全同，无瞬态）；行盒 +21.4 与
   [25,45]/[53,73] 输出精确互推。
3. **产物视觉判定**（density/hx-density.pdf 87 页真导出 + 8 张页界条带，visual-judge 像素级）：
   - 组 2（p5/p6，chunk 内网格界）：同一行对称切两半，列位 IoU 0.592，上 11.5/下 8 CSS px，内容可拼接
   - 组 3（p9/p10）：行顶薄片切分（上 2.5/下 11 px，IoU 0.571）
   - 组 4（p13/p14）：半行切分 + 右半下半截**完全丢失**（0/39 列延续——内容丢失级）
   - 组 1（p3/p4，chunk 边界=P-α 域）：全宽 CJK 行上半截切平留上页、下半截丢失
   - 程序化预测全部命中（`programmatic_prediction_confirmed: true`）
   - 内容类型指纹：正文 CJK + 行内公式/西文字形（密度档=数学讲义语料）

## 家族二分与嫌疑排除

- **家族乙（光栅/裁切段 S-P3/S-P4）排除**：切字位置由测量/分页/切片坐标决定，与 rasterScale 档位无关
  （网格边界在 CSS 坐标系就骑墨，光栅只是忠实渲染窗口）；ChunkTrim 绝对定位钉的是 content 坐标快照
  （自身基准相减正确，ex6 轮 A/B 已证 trim1/trim2 零差）。未动 rasterAb 即完成二分（刀口位置错误在
  光栅之前就已确定）。
- **S-P1（行盒合并盲区）**：合并逻辑本身（1px 容差垂直合并）在 demo/density 语料无失效证据；实测行盒
  错误全部由 P-α 坐标混用解释（+C 常量偏移，非合并碎片化）。作为独立根因排除，但 P-α 修复后行盒数据
  回归真实值，合并语义保持不变。
- **S-P2（分页器弃用行盒边界的路径）**：keepTogether 超页强制放置（clippedSegments）密度档实测为 0，
  排除；resume 续排/表格行断/孤儿寡妇路径的刀口全部取自 unitBottoms（行盒底）——数据源被 P-α 污染，
  路径本身无独立缺陷。
- **S-P5（行盒外扩不足）**：demo 段落行盒 rect 与字形包络一致（rect 高 20 = 字面高），无紧贴性证据；
  密度档切字深度 2.5~11.5px 远超亚像素级，排除。

## git 考古（回归引入点）

两缺陷同源引入：**`2418c31`（2026-10-12，feat(export): EX 阶段三原型——PDF 自研管线落地）**——
`lineBoxes` 与定高网格切片均诞生于该 commit，从未正确过。EX 轮 C1 门只验「产物页数 = 分页器页数 +
首尾块完整」，不验逐页刀口对齐（EX 报告 §5-2 Q1 人工验收遗留）——本轮报障 = Q1 开口兑现。

## 复现稳定性

- 分页/测量确定性：measureBlocks 多次调用（≥5 次）输出逐字节一致；
- demo.md 导出 ×2（12:21/12:23）meta 全同（3 页、paginate stats 全同）；
- 密度档 87 页导出 ×1，四处页界（chunk 边/网格界/对称切/丢失切）全部实锤且与程序化预测坐标吻合。

## 修复方向（阶段二，两项独立 Fix，先失败测试后修，一次一项）

- **Fix P-α**：`lineBoxes`/`tableRows`（含 lineBoxes 空矩形 fallback）改为对 content 基准相减——
  把 base.top 传入或在 measureBlocks 内先行换算，使行盒回到 content 相对坐标。最小波及：仅
  exportPdfPipeline.ts 测量段；分页器/光栅/文本层契约不变。
- **Fix P-β**：页画布裁切源 y 从 `i × contentHeightPx` 改为 `chunk[i].top − chunkTop`（该 chunk 首页
  顶为基准的每页真实窗口顶）；win 高度同步取 `chunkBottom − chunkTop`。光栅与分页刀口/文本层窗口
  三者坐标系对齐。
