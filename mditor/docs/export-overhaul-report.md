# mditor 导出体系全面翻新——结题报告（EX 轮）

> 状态：**阶段一~六已落地**，§4 门禁表收口（遗留：1MB 档基线、Q1 视觉半/Q2 人工验收——见 §5）。任务书：`docs/prompts/export-overhaul-optimization-prompt.md`（仓库根）。
> 本报告按阶段追加，最终以门禁实测表收口。

## 0. 基线核实（§0 执行记录）

| 项 | 任务书口径 | 实测 | 结论 |
|---|---|---|---|
| HEAD | `7d3acf8` | `git log` 实跑 = `7d3acf8`，工作树仅任务书未跟踪文件 | 一致 |
| npm test | ≥997（R10 收尾 997） | **997 / 90 文件全绿**（两次串行实跑；一次与 dev 实例+复现脚本并发时 1 例时长抖动，串行复跑全绿——记为环境负载抖动，非回归） | 一致 |
| fixture 在位 | 密度档 156KB/2355 公式、切换档 60KB、1MB 档 | 全部在位（密度档实数 156,021B/2,155 行/2,355 行内公式；1MB 档 1,574,112B/25,355 行） | 一致 |
| 多图验收语料 | 本轮新建 | `perf/gen-export-fixtures.mjs` 生成：`多图导出压测副本.md` + assets（13.7MB 噪声图/5KB 两帧动图/4KB 伪 PNG/574B 对照小图）+ 远程 picsum 引用 | 就位 |
| 减配触发变体 | C3 减配档需要 | 密度档原文 + 900 行纯文本垫层 = 3,061 行（> BIG_DOC_LINES 3000），公式数不变 2,355 | 就位 |
| 观察版本 | dev/main vs 打包 v5.0.1-beta 待补 | 复现全部在 dev 实例（= main HEAD）完成；打包版与 main 的导出代码差异属「用户装包时间点」问题（2026-09-18 修复已在 main），症状 E-1/E-2 的根因（RC-1/RC-2）为结构性代码事实，与版本无关 | dev 口径钉死 |

## 1. 根因定罪表（阶段一产物）

复现环境：dev 实例（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npm run tauri dev`，WebView2 Edg/154.0.4258.62），证据脚本 `perf/ex1-repro.mjs`（e1e2/rc4/rc5 三段）+ `perf/ex1-rc4b.mjs`，产物 `perf/results/ex-phase1-*`。

### 定罪总表

| 根因 | 症状 | 状态 | 关键证据（实测数据） |
|---|---|---|---|
| **RC-1** 系统打印对话框不可控 | E-2 主犯 | **活跃，定罪** | 版心 717px（A4−2×1cm）下 body 实际布局宽 **1917px**；长 URL `<a>` 右缘 x=1917（右溢 1200px，100% 缩放即右缘截切）。代码层：`wrapHtml` 零 `@page` 规则，纸张/边距/缩放全由 OS 对话框会话决定，应用无控制点 |
| **RC-2** 图片内联静默降级 + iframe 相对引用必 404 | E-1 主犯 | **活跃，定罪** | 五图对照：对照小图/动图正常内联（load@20ms）；**13.7MB 大图（>10MB 预算）→ KEPT → 打印 iframe `error@22ms`、naturalWidth=0（裂图）**；伪 PNG（魔数嗅探失败）→ KEPT → `error@22ms`；远程图 → 永不内联 → `error@20ms`。全程零用户可见报告 |
| **RC-3** 5s 资源盲等 | E-1 帮凶 | **代码定罪 + 即时错误分支活体捕获** | 本机无外网，远程图 20ms 即 error（连「慢图晚到」分支都轮不到就被打）；代码事实：`imgsReady`/`fontsReady` 与 5s `deadline` race，超时照打不误（exporter.ts:265-279）。慢网环境下慢图/慢字体必产缺图缺字 PDF |
| **RC-4** 超大 HTML 打印管线崩溃 | 潜伏（整体截断/超时） | **活跃于 1MB 档，定罪** | 1MB 源文档 → getHTML 23.5MB（KaTeX 膨胀 ~15×）→ 版心布局 831,220px = **预期 795 页**。10% 切片（2.4MB/1,163 块）printToPDF **9.2s / 80 页**（引擎正常，吞吐基线）；全量 23MB 两次尝试（23min 被杀 + 15min 封顶）**printToPDF 均无返回**——打印分页碎片化在超大 DOM 上超线性崩溃。OS 对话框路径在此档位等于不可用 |
| **RC-5** 减配档公式导出为源码 | 潜伏（全格式） | **活跃于总开关 ON + 超阈值，定罪** | UI 实拨总开关 ON（设置→性能与诊断→大文档性能模式→应用），3,061 行减配变体：编辑器 katex 节点 231→**0**，getHTML `$` 字符 3→**4713**（2,355 公式全部源码化）；`renderBlockMath` 补渲染零效果（`data-language="LaTeX"` 块 = 0，减配下块公式也退化为普通段落文本）。总开关 OFF 复测正常（19,689 katex 标记）。开关已还原 OFF |
| **RC-6** PNG 截实时 DOM 继承懒渲染状态 | 潜伏（PNG 专属） | **活跃，定罪** | 密度档文档默认档实时 DOM：2,355 行内公式中 **1,371 已渲染 / 984 为源码占位**（懒渲染未换装）。`exportPng` 截 `previewEl()` 此刻 DOM，984 个公式以 `$...$` 文本入图 |

### 逐项细节

**E-1（RC-2/RC-3）时间线**（`ex-phase1-e1e2.json` → iframeTimeline）：
- `data:image/png`（574B 对照）load@20ms w=320 ✓；`data:image/gif`（动图）load@20ms w=200 ✓
- `assets/big-noise.png` error@22ms、`assets/fake.png` error@22ms、`https://picsum.photos/...` error@20ms——进打印的就是这三张裂图，`atPrint`/`atEnd` 快照 `naturalWidth=0` 恒定
- 内联耗时 107ms / 5 图（本地图读盘基线）

**E-2（RC-1）**：同 JSON → `bodyScrollWidth: 1917 / a4ContentWidthPx: 717`；越界元素唯一：长 URL `<a>`（right=1917）。宽表格在 717px 内可换行未越界——长不可断内容（URL/长公式/代码行）是右缘裁切的第一受害者；页尾裁切由对话框缩放 >100% 场景贡献（结构性不可控，换自研管线后整类消失）。

**RC-4 补充**：切片页数自洽（10% 块 → 80 页 ≈ 795/10 ✓ 分页器语义正常），失败模式是**不完成**而非缺页——OS 对话框在本机该档位的实态是打印预览无限转圈/内存压力。归因用户未报此形态：主战场文档未达 1MB 档。

**RC-5 复现路径记录**：设置弹窗为 draft 制，「应用」才落盘（首次复跑只点复选框未生效，修正驱动后成功）——复现脚本已固化正确路径。

## 2. 修复与重构（阶段二起）

### 2.1 共享管线修复（全格式受益）

| Fix | commit | 内容 | 验证 |
|---|---|---|---|
| **Fix-C2** 图片内联全量显式报告 + 远程图抓取（E-1 主犯） | `1b949a7` | `inlineExportImages`：每张参与内联的图片给出显式结局（inlined/oversize/sniff-fail/budget/read-error/remote-error/remote-timeout/remote-skip），missing 清单交 UI 列报；远程图经平台 fetchImage（Tauri Rust http，SSRF 防线 + 20MB 硬顶）抓取，并发 3、单图 JS 侧 15s 超时；顺手修掉 exportDocx 既有 S10 缺口（消毒结果此前被丢弃） | `exporterImages.test.ts` 17 例 + dev 实例活体验证：多图 fixture 五图分类全对、missing=3 文案成形 |
| **Fix-D4** 减配档公式补渲染（RC-5，全格式公式覆没） | `cedc30f` | `renderDegradedMath`：块容器逻辑串扫描（em/strong 透明拼接、`<br>`→`\n`、code/pre/katex NUL 屏障）+ Range 手术跨元素替换；定界规则镜像 remark-math v6 ∩ remarkMathGuard；`isBigDoc()` 门控接入 doExport 与 doCopyRich | `ex-phase1-rc5-fix.json`：残留 `$` 4713→3（=非减配基线），renderedInline 2355；18 用例 + 全量 1032 |
| **C2 产物内占位框** | `6634948` | `markMissingImages`：未内联图片在工厂渲染路径（PDF/PNG）换成带原因的可见占位框——静默裂图禁止（「列报 + 占位框」双保险；HTML 保留引用语义不变） | +2 单测 + 多图 fixture 活体（阶段六） |
| 资源就绪确定性基建 | `de8eb56` | `exportRenderFactory`：真实版心宽度离屏 iframe + 逐图/字体确定性就绪（超时显式带清单继续，FACTORY_READY_TIMEOUT_MS=20s 文档化）+ 进度事件 + AbortSignal + 幂等回收 | 10 例单测 + 活体 |

### 2.2 PDF 自研管线（核心重建）

管线：`getHTML()` → 共享预处理（消毒/公式/降级）→ 图片内联强化 → 离屏工厂（真实版心宽）→ 块测量（列表展开 li / 表格行盒 / 行盒垂直区间合并）→ **分页器纯函数**（块级断点 / keep-together / 表格行断 / 孤儿寡妇（两侧各 ≥2 行）/ 标题随文）→ 分块光栅（画布预算 16384px/120MP + ≤4 页/块，裁剪窗口 translateY）→ **pdf-lib 组装**（页位图 + 隐形文本层）→ pickSaveFile 落盘。

| 部件 | commit | 要点 |
|---|---|---|
| 分页器纯函数 | `d5550df` | 15 例单测（含 2 万块规模不变量：页窗口首尾衔接、末块完整）；显式 resume 状态机（部分放置的块下页从块内恢复点继续） |
| 组装器 + 文本层 | `2418c31`/`6634948` | Tr 3（`TextRenderingMode.Invisible` 原生支持）+ CJK 子集内嵌 + ε-合并组铺字（期望 advance 与嵌入字体自然 advance 一致 <0.5px 的连续字符合并一次 drawText——CJK 算子骤减；不一致处断组按实测位重锚）；JPEG 内存护栏（>256MB 解码预算 → 页图转 JPEG 0.92，embedJpg 直通 DCT 字节） |
| 全量落地 + 退役 | `be39beb` | `printHtml`/0×0 iframe/5s 盲等/50ms 拍前等待/300s 兜底/win.print **整体删除**（grep 零残留，注释存档）；U1 进度对话框（阶段文案/逐页进度/取消/结束即卸载）；U2 设置持久化（A4/Letter/A3 × 10/15/20/25mm × 1/1.5/2x，设置面板「导出」分区） |
| 生产级修复 | `be39beb` | ①布局收帧弃 rAF（被遮挡窗口 rAF 暂停 = 导出挂死——EX-P 实测教训，改强制同步布局读+双定时器）②组装逐页宏任务让渡（pdf-lib 铺字饱和主线程会冻结进度 UI/饿死取消信号）③字形宽度 (char,size) 缓存 |
| **分块序列化裁剪（ChunkTrim）** | 本批收尾 | 密度档 87 页实测：流式（整文档克隆进 foreignObject）第 7 块冻死 renderer（domToPng 全量克隆 ~80 万节点/块）。裁剪法：每块把窗口外顶层块暂存 DocumentFragment、窗口内块绝对定位钉在实测坐标（margin 归零并入 top），出图后按原序还原——克隆成本 O(块内)×块数，87 页 145s 全量跑通（vs 冻死）；**决定性 A/B（§4.1）证实它同时是坐标保真修复** |

### 2.3 周边收口

| 项 | commit | 结论 |
|---|---|---|
| PNG 改走离屏工厂（RC-6） | `3f91375` | `exportPngPipeline`：模型序列化 HTML → 工厂全量渲染 → 分块光栅 → 纵向拼接（画布预算沿旧惯例 2x→1x→fractional≥0.2）；不再依赖预览模式；进度/取消沿 U1；深色主题背景语义保持（isDarkTheme 同源） |
| DOCX 图片可靠性显式化 | `3f91375` | **sidecar/Node 子进程方案：不需要**。实测（`exporterDocx.test.ts` 钉子）：@turbodocx/html-to-docx 对 data URL 图片真实嵌入 `word/media/*.png`（drawing + a:blip + 关系齐全）——Fix-C2 输入侧内联后 DOCX 图片已可靠；此测试防依赖升级回归 |
| Harmony `pdfExport` | `3f91375` | 维持 false；注释更新为新架构评估口径（纯前端管线无打印依赖；翻 true 前需真机 spike 验证 ArkWeb 的 foreignObject 光栅质量与 pdf-lib 内存表现——见未拍板清单） |

### 2.4 导出设置持久化（U2）

`Settings` 新增 `exportPdfPaper`（A4/Letter/A3）/ `exportPdfMarginMm`（10/15/20/25）/ `exportPdfRasterScale`（1/1.5/2 = 96/144/192dpi 等效），默认 **A4 / 15mm / 2x**（未拍板清单项）；设置面板新增「导出」分区（导航第 5 项），doExport 透传管线。锚点测试同步（settings 字段全集 +3、分区 10→11、指示条 342px）。

## 3. 原型比选数据（D-1~D-5 拍板记录）

实测环境：dev 实例（WebView2 Edg/154）+ Node 24；数据文件 `perf/results/ex-phase3-exp.json`。

### D-1 组装库：**pdf-lib + @pdf-lib/fontkit 胜出**

| 维度 | pdf-lib + fontkit | jsPDF 2.x |
|---|---|---|
| CJK 字体格式 | ✅ 直吞 CFF OTF（Noto CJK 唯一静态形态） | ❌ glyphFor 崩溃（`jspdf.node.min.js` ttffont 解析器不吃 OTTO，实测 PubSub Error + 产物 3.3KB 损坏） |
| 子集内嵌 | ✅ `subset:true`——8.33MB 字体 → 20 字形产物 **46KB**（实测 84ms 总耗时） | ❌ 无子集化（整字体 +8.3MB/文件） |
| 隐形文本 API | ✅ 原生 `TextRenderingMode.Invisible`（Tr 3）+ `setTextRenderingMode` 算子导出 | ✅ `renderingMode:'invisible'` |
| 结论 | **采用** | 排除（格式兼容 + 体积双杀） |

### D-2 文本层粒度：**ε-合并组（CJK 整组 + 拉丁逐字锚定的分治）**

- 全逐字：算子数 = 字符数（demo 1603 字形 → 1603 ops，内容流爆炸）；
- 全 run 单锚：拉丁 proportional 字体（Segoe UI 渲染 vs Noto 嵌入）advance 差 ~3%/字，60 字行累计漂移 ~15px > Q1 预算 4.25px（0.25×17px）——**不合格**；
- **ε-合并组（实现）**：DOM 实测 cumulative 位置 vs 嵌入字体自然 advance，一致（<0.5px）则并组、不一致断组重锚。demo 实测：1603 字形 → **386 ops**（压缩 76%），CJK 几乎全组合并。
- 文本素材成本：24,625 片段（密度档）收集 201ms（canvas measureText + (font,char) 缓存）。

### D-3 原型门 EX-P 三指标

| 指标 | 门 | 实测 | 判 |
|---|---|---|---|
| Q1 对位（程序化半） | ≤0.25×字号 | demo 110 片段换算链 **maxDx=0 / maxDy=0**（rect→run 零损）；基线推导用 canvas fontBoundingBox（同引擎同字体） | **过**（视觉半——Edge/Acrobat 逐字符选区与视觉重合——留用户人工验收，见未达项） |
| 文件大小增量 | 记录 | demo（2 页）：文本版 467,657B vs 纯光栅 365,366B = **+102KB**（子集字体 ~40KB + 铺字内容流） | 过（2x 位图主导体积，文本层占比 ~20%） |
| 生成时长 | 记录 | demo 全链 **876ms**（factory 15 / raster 565 / assemble 185）；含 1MB 档护栏推演见 §5 | 过（demo 档） |

**结论：文本层过 EX-P 门，默认启用（`textLayer: true`）**；字体缺位自动纯光栅降级，不为文本层牺牲完整性主门。

### D-4 减配档公式修复路线：**b) 导出管线补渲染**（Fix-D4 已落地）

密度档 fixture 正确性（残留 $ = 非减配基线 3）+ 396ms/232KB 时长——a)（独立全功能 Crepe 实例）的重建成本无必要。宏语义：`renderDegradedMath` 与编辑器同源 KaTeX 0.18.4 实例 + mathMacros 透传（红线 2 遵守）。

### D-5 远程图内联：**fetch→dataURL，失败显式入清单**（Fix-C2 已落地）

并发 3 / JS 侧 15s / Rust 30s 兜底；本机无外网环境实测 remote-error 即时入清单（不盲等不静默）。

## 4. 门禁实测表（§4）

实测环境：dev 实例（WebView2 Edg/155）+ Node 24；数据文件 `perf/results/ex-phase6-*`、`ex-phase3-density-run.json`。密度档 = 87 页公式压测文档（156KB Markdown / 2,355 公式 / 939 块）。

| 门 | 实测 | 判 |
|---|---|---|
| **C1** 零截断 | 密度档全量 2x：**87/87 页 MATCH**（pdf-lib pageCount = 分页器页数；145s / 28.1MB；页位图抽检 page0/43/86 落盘）；多图 fixture 3/3 MATCH；首末块经文本层抽检在产物中 | **过**（已跑 fixture 各 1 轮；三 fixture × ≥3 轮矩阵与 1MB 档 → §5 遗留） |
| **C2** 图片完整性 | 多图 fixture 8 图：6 内联 + **2 项显式列报**（`big-noise.png` oversize 13.7MB / `fake.png` sniff-fail 4KB）——与预期清单一致；产物内为带原因占位框（page0/2 PNG 抽检）；导出完成弹窗列报 | **过** |
| **C3** 公式完整性 | 三档 `$` 残留 **3/3/3**（= 非减配基线假阳性，无新增）；工厂 KaTeX 节点 **2355/2355/2354**。减配档 Δ1 与 60 条清单 diff 全部归因（见 §5-4：编辑器减配档把公式内 `](...)` 链接化吞字符——**范围外既有缺陷**；其余为重渲染注记序列化伪差 `\,`/`{}`/`[4pt]`，不可见无影响） | **过（带归因）** |
| **Q1** 文本层对位 | 程序化半：rect→run 链 **maxDx=0 / maxDy=0**（D-3）；密度档 82,168 字形 / 24,625 片段全量入层 | 程序化半**过**；视觉半 → §5-1 用户人工验收 |
| **Q2** 视觉保真 | demo.md 全语法导出链路就绪（docs/demo.md 附验收操作路径） | §5-1 用户人工验收 |
| **Q3** 体积/时长基线 | 密度档：87 页 **28.1MB**（JPEG 档触发）、全链 **145s**——factory 1.2s / measure 78ms / paginate 0.6ms / text 267ms / **raster 125.1s（86%）** / assemble 0.9s | 基线落档；硬门 → §6-5 |
| **T1** 1MB 档时长 | 未跑（规模推算 ~800 页 / raster 主导 ≈ 15~20min 量级） | §5-2 遗留 |
| **T2** 峰值内存 | 分块 = min(16,384px 边长, 120MP 像素, 4 页)（密度档实取 4 页/块）；JPEG 护栏按整本解码预算触顶降档；全程无 OOM/白画布 | **过** |
| **R 组** 零回归 | npm test **1077 绿**；tsc/eslint 干净；编辑器热路径模块 diff 为零 | **过** |

### 4.1 分块裁剪语义 A/B（阶段六收口判定）

问题：ChunkTrim（绝对定位钉实测坐标）相对流式（整文档进窗口）是否引入像素级差异；此前跨文件对比曾见 18px 文字位移 vs 布局层 8px 常量差，疑似字体竞态。

方法：同工厂内三变体光栅同一批页——trim1（现行为）→ stream（修复前行为）→ trim2（trim 对照二跑，夹住 stream 检出 renderer 状态污染）；行墨量剖面互相关（±24px 窗）+ 分窗滞后 + 块顶对原位基准取差（`runPdfRasterAb` 调试口 / `perf/ex6-ab*.mjs` / `ex-phase6-raster-ab*.json`）。

| 发现 | 数据 |
|---|---|
| **trim 完全确定性** | trim1 vs trim2：corr **1.0**、lag 0、墨量逐位相同（30s stream 重活夹中间亦无污染） |
| **stream 序列化坐标漂移** | 活 DOM 块顶两变体均为 0 差，但 stream 的 foreignObject 产物：首块下移 **21px**（首块 margin 在克隆上下文重新出现；page0 首墨行 69 vs 27 设备px，差 42 = 21CSS×2）+ 逐页累积 ~1.5–3px（page0/1/2 最优滞后 −21.5/−25/−27 CSS px） |
| **块内渲染两变体一致** | 分窗最优滞后处 r ≈ 0.96–1.00——差异全在块间位置，非字形/抗锯齿 |
| **性能/生存性** | 30 页文档：stream 30.4s vs trim 1.7s（**18×**）；87 页密度档：stream 首块即冻死 renderer（480s 无返回 + eval 双静默，2026-10-14 实测复现） |
| **坐标保真** | trim 块顶对原位基准差 **2×10⁻⁶ px**（=坐标精确）；fractional top 不取整（取整反而引入 ≤0.5px 误差） |

**结论：18px 谜题关闭**——非字体竞态（工厂内 `doc.fonts.ready` 已等待 + trim 确定性 r=1.0 排除随机源），是修复前流式输出的序列化坐标漂移（首块 margin 逃逸 + 逐页累积）。**裁剪语义保留**：它同时是性能修复（18×，且流式在大文档上不可生存）与坐标保真修复（文本层与光栅像素同坐标系）。

## 5. 未达项归因与后续提案

1. **Q1 视觉半 / Q2 demo.md 人工验收**：程序化半全过；「Edge/Acrobat 逐字符选区与视觉重合」「明暗双主题逐块比对」需用户肉眼验收（验收路径见 docs/demo.md 顶部导出说明）。
2. **1MB 档 C1/T1 基线**：未跑。按密度档比例推算 ~800 页、raster 主导 15~20min 量级；建议单独专场跑（长任务 + 进度落盘沿 `ex3-density5.mjs` 模式），跑完补 §4 行 + §6-5 硬门拍板。
3. **三 fixture × ≥3 轮矩阵**：各 1 轮已过；多轮稳定性由 trim 确定性（corr=1.0）与管线纯函数单测背书，轮次补齐随 1MB 专场一并。
4. **编辑器减配档 LaTeX 源码有损往返（范围外，只记录不修）**：本轮新实证——减配档 getHTML 把公式内 markdown 链接形态吞字符：`$\left[-\ln(1-x)\right](1+x+\cdots)$` → `$\left<a href="1+x+\cdots">-\ln(1-x)\right</a>$`（`[`/`](`/`)` 结构性丢失，C3 的 Δ1 即此；证据 `ex-phase6-c3-delta1.json`）。与此前记录的 `\{`→`{`、`\,`→`,`、`_`/`=` 加转义同源，均在编辑器重建/序列化侧（`useMilkdown.ts` bigDoc 逻辑 / `useFile.ts` save 路径）；**若保存走同一序列化会静默改写用户文件**，建议独立修复轮处理。
5. **跨文件 18px 文字位移**：已归因关闭（§4.1，修复前流式序列化漂移），无需后续动作。

## 6. 未拍板清单（显式呈报用户）

1. 打印菜单项去留（§3-1，默认建议：彻底移除——**现状：应用内本无独立「打印…」菜单项**，旧打印路径仅由导出 PDF 隐式借道，已随管线替换整体退役；如需物理打印场景可后续加回独立菜单）
2. C2 未内联图片的产物内处理：**已实现「列报 + 占位框」双保险**（导出完成对话框列报清单 + 产物内可见占位框标注原因）；如倾向「中止导出」可改为硬失败
3. 新管线默认纸张/边距/DPI：**当前默认 A4 / 15mm / 2x（192dpi 等效）**，设置面板「导出」分区可调
4. JPEG 内存护栏参数：阈值 256MB 解码预算 / 质量 0.92。密度档基线已落：87 页 × 2x 触发护栏，产物 28.1MB（~323KB/页），文本可读性抽检 page0/43/86 无碍——**建议维持现值**；如要求大文档无损 PNG 可调高阈值（代价：pdf-lib 内存驻留）
5. Q3（文件大小/时长）与 T 组硬门数值：密度档基线见 §4（28.1MB / 145s，raster 占 86%——瓶颈为分块光栅即 domToPng 序列化，属 modern-screenshot 固有成本）；1MB 档基线（§5-2）后一并拍板
6. 安装包体积 +8.3MB（Noto Sans SC OFL 字体内置，public/assets/fonts/，许可证 OFL.txt 同目录）——如不可接受可改为构建期下载脚本
7. Harmony `pdfExport` 能力位翻 true（真机 spike 后）
