# PDF 导出直连光栅定案与性能收口（EX #8–#18，2026-10-30）

续 [../../docs/archive/optimization_report5.md] 的导出性能线。本轮完成正确性定案、修复字体内联失效 bug、三项有效优化与两项回退尝试，并以测试 + 出包收口。

## 结论速览

| 指标 | 基线 | 本轮终态 |
|---|---|---|
| 500 块多公式全管线（3 reps 中位） | 74.4s | **24.0s（3.1x）** |
| 36 页哈希稳定性 | — | i10→i18 全程一致 |
| chunk 位图 vs 工厂真值 | ms 路径漂移至 ~400 CSS px | direct **max 1 设备像素** |
| npm test | — | 1198/1198 全绿 |

## 一、正确性定案：direct 是对的，「参照」是错的

交接时的疑团「direct 路径哈希全变 + 累积垂直位移」实为**测量参照系错误**：

- **modern-screenshot `domToCanvas` 的 iframe 克隆存在累积布局漂移**——320 块
  fixture 文档末段偏移达 ~400 CSS px（带起始偏移 ±10px 起步、单调放大）。
  i7 及以前的全部「哈希参照」都建立在这个漂移的渲染上。
- 证明工具 `perf/mexport-isolate8.mjs`：把工厂 iframe 挪到屏上用
  `Page.captureScreenshot` 取**真值**，与 ms/direct 画布做行墨带结构对比：

  | 渲染路径 | 带 | 与真值起始偏移 |
  |---|---|---|
  | direct（字体修复后） | 64/64 全同 | **max 1 px（mean 0.03）** |
  | ms（默认配置） | 0/64 | max 809 px（mean 93.9） |
  | ms（管线配置 + MS_STYLE_PROPS） | 0/64 | 同上（配置无关） |

- 因此：直连 foreignObject SVG 光栅不仅更快，还**修复了旧路径大文档公式补丁
  逐页错位的隐性缺陷**（补丁按工厂 rect 从 chunk 位图裁剪，ms 位图漂移 =
  补丁裁错区域）。

## 二、修复的 bug

1. **字体内联静默失效**（`inlineCssFontUrls`）：替换回调用
   `whole.match(/['"]?([^'")]+)['"]?\s*\)$/)` 反解 URL，但 `[^'")]+`
   不排除 `(`，提取出的 key 带 `url(` 前缀，与 `resolved` 表的裸 URL 永不
   相等 → 替换从未发生（实测 fontFaces 20 / dataUri 0，fetch 全部成功）。
   SVG-image 拦截外链字体 → 公式回退 roman、布局发散。修法：`replace`
   回调直接消费正则捕获组 `(whole, _q, u) => …`。
2. **标记拼接路径的 XML 转义缺口**（本轮引入、当轮修复）：CSS 编码缓存把
   raw CSS 拼进 XML，绕过 XMLSerializer 文本转义——CSS 中 `&`（嵌套
   选择器）/`]]>` 会拼出非法 XML → 解码失败 → 静默回退漂移的 ms 路径。
   修法：缓存前过 `& < >` 文本转义（解析后语义与整段序列化等价）。

## 三、有效优化（i10 → i18）

- **#10 CSS 编码缓存**：`<style>` 里放随机标记，raw XML 上定位头/尾分别
  编码，中间拼接按 `cssInline` 字符串记忆的一次性编码（含 XML 转义）。
  注意 XMLSerializer 会给 HTML 命名空间 style 补 `xmlns`，匹配须
  `<style[^>]*>` 属性无关。serialize 2.22→2.00s（encodeURIComponent 非
  大头，主收益在 #12）。
- **#13 woff2 独占内联（复审 P1）**：@font-face 的 src 多候选（woff2/woff/ttf）浏览器只取首个支持的候选，全量内联 = 载荷 ~3 倍白背。收窄到仅 woff2（与 exportMath.ts inlineKatexFonts 同模式），serialize 1.17→0.86s，总墙钟 25.9→24.0s。
- **#12 @font-face 按使用裁剪**：浏览器按需加载字体面，工厂
  `document.fonts` 中 `status==="loaded"` 的 family|weight|style 三元组
  并集（超集覆盖任意 chunk 子窗口）过滤未用面；解析失败/匹配不到一律保留。
  serialize 2.00→1.17s，且减小每 chunk SVG 解码量。
- **计时归位**：`raster.encodeWait` 子计时（并行 toBlob 的池吞吐等待
  ~7s，原落在 raster 未归类区间），为后续优化提供真实归因。

## 四、失败尝试（已回退，教训入代码注释）

| 尝试 | 结果 | 教训 |
|---|---|---|
| #11a blob URL 替代 data URL | canvas 污染（toDataURL SecurityError），整管回退 raster（45.8s） | blob: SVG 经 `<img>` 绘入画布即污染；data: 才是同源干净资源 |
| #11b 跨 chunk 预启动流水线 | 27.1s（更慢）：serialize 2.0→7.1s、encodeWait 6.9→8.1s | SVG 解码与 toBlob 编码抢同一线程池；encodeWait 是编码器吞吐瓶颈而非主线程空闲，预启动制造竞争 |
| （过程中的顺序错误）restore 早于 clone | 哈希全变 + 克隆全量文档 | `ChunkTrim` 绝对定位 + P-δ 锚点回拨是像素保真必要条件；restore 必须在克隆快照之后 |

## 五、验收

- **像素**：i18（终态代码）四方对比 direct vs 工厂真值 max 1px；36 页 dump
  无空白页；i17 dump 与 i10 逐字节一致（字体裁剪零像素影响）。
- **视觉门声明**：本会话运行模型无图像输入，visual-judge 与人工看图均不可
  用，页面验收以程序化手段（alpha 合成白底 + 行墨带结构 + 逐带偏移量化）
  完成；上线前建议人工抽页复核。
- **npm test**：1204/1204 全绿（含新增 6 例：prune 三元组/引号族名/bold 归一/旧引擎全量保留、woff2 独占内联 + woff/ttf 原样、内联失败抛出回退、html/body 选择器改写含 `body>*`/`body .x` 形态）。exporterImages 两个 7×9.5MB 用例补 20s 显式 timeout（并行负载抖动，与本次改动无关）。exporterImages 两个 7×9.5MB 用例补 20s
  显式 timeout（单跑 ~4s，并行负载下超默认 5s 抖动，与本次改动无关）。
- **出包**：`npm run build` ✅（tsc + vite，31.4s）；`tauri build` 见当次
  会话记录。

## 六、遗留与建议

- raster 模式（整页位图导出）仍走 `domToCanvas`——ms 漂移同样影响该模式
  的大文档输出；后续可把 direct 路径扩展到 raster 模式（需先解决外链图片
  内联进 SVG 的问题）。
- `encodeWait`（~7s，PNG 编码器吞吐）是下一个最大单块：候选方向为块级补丁
  走矢量文本层（结构性改动）或编码格式评估（pdf-lib 仅支持 png/jpeg）。
- 本轮基准均在 vite dev 页面内跑（与历史口径一致）；生产 bundle 的首次
  导出含 modern-screenshot 冷加载，与本研究无关。

## 七、复审处置（code-reviewer 终审）

P0 零缺陷。已处置：P1-1 woff2 独占内联（#13）；P2-1 timings.resources 双计修复；
P2-2 arrayBuffer 兜底防挂死（+crop.blobNull/arrayBufferFail 计数）；P2-3 字体内联
失败改为抛出→整程回退 domToCanvas（宁慢勿错）；P2-4 新增 6 例单测；P2-5 杂项
（column-gap 去重、选择器字符集防御性补全 `>`/`*`/`(`）。未处置留档：
directFallback 计数字段命名（既有惯例，改动涉及 meta 消费方）。

## 附：产物索引

- 基准结果：`perf/results/mexport/i10-*.json … i18-*.json`（失败尝试
  i11/i14/i15 留档）；页面 dump：`i17-pages-pages/`、`i10-pages-pages/`
- 探针：`perf/mexport-isolate8.mjs`（四方真值对比，可复用验收工具）、
  isolate5/6/7（诊断过程留档）
- 真值截图与画布：`perf/results/mexport/isodump8/`
