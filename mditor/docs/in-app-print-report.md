# mditor 应用内打印——结题报告（PI2 轮）

> 状态：**M1~M6 已落地**，代码门禁全绿（§3）；桌面手测清单（§5）待真机执行。
> 任务来源：用户重设计指令（2026-11-03）——「重新设计打印功能，自己重新写
> 一个组件，不要调用外部功能；功能完善无 bug」。取代 PR 轮的外部通道方案
> （`docs/prompt-print-notes.md` / `docs/print-notes-report.md`，未随版本发布）。
> 前置：`docs/export-overhaul-report.md`（EX 轮——webview 打印退役根因）。

## 0. 设计决策（用户拍板 + 推导）

| 决策点 | 结论 | 依据 |
|---|---|---|
| 打印体验 | **应用内完成全流程**，自研 React 打印对话框组件 | 用户指令「自己写一个组件、不调用外部功能」 |
| 打印执行 | **Rust GDI 直打**（StretchDIBits 位图送打印机） | 唯一不经任何外部程序的路径：不开浏览器/阅读器、不走 print verb、不碰 WebView2 打印设施 |
| 旧外部通道 | **彻底移除**（openExternal 打印调用全删） | 与指令一致；铁律升级为全仓零 print 字面量 |
| html 笔记 | 应用内重排版（提取正文+样式进 PDF 管线） | 统一四格式体验；保真度边界显式化 |
| 与 wry#707 的关系 | 不冲突——新方案**不碰 webview 打印** | 自研 PDF 管线（已解决 RC-4）排版 + GDI 输出，铁律反而更强 |
| harmony | caps.print 维持 false | GDI 为 Windows 实装；鸿蒙打印 API 留待后续轮次 |

## 1. 架构（自研四层）

```
入口（不变：菜单 file_print / Ctrl+Shift+P / pdf·docx 视图按钮）
 ↓ App.doPrint → 组装 PrintDialogRequest → lazy 挂载对话框
【组件层】PrintDialog.tsx：设置面板 + pdf.js 分页预览 + 双阶段进度
【内容层】printJob.ts：四 kind 打印源（md=buildExportContext / docx=mammoth /
          html=重排版提取 / pdf=原文件副本）→ buildPdf（+orientation 横向）
【执行层】renderPageToPng（pdf.js 按所选 DPI 逐页 PNG → $APPDATA/print/job-*/）
          → invoke 三命令（Rust）
【引擎层】printing.rs（cfg windows）：EnumPrinters / DEVMODE 协商 / CreateDC /
          逐页 png 解码 → BGRA → StretchDIBits（HALFTONE 等比居中）
```

## 2. 实现面清单

### 2.1 Rust 引擎（`src-tauri/src/printing.rs`，469 行，新）

- `list_printers`：EnumPrintersW level 4（最轻量，不逐台打开打印机）+
  GetDefaultPrinterW 标记默认；无打印机返回空清单（前端降级）；
- `print_png_job`：注册取消旗标 → spawn 线程立即返回；线程内：
  OpenPrinter → DocumentPropertiesW 两步法（先探驱动所需字节数，Vec<u64>
  8 字节对齐缓冲）→ 纸张设置（DMPAPER_A4/LETTER/A3 + DM_IN_BUFFER|
  DM_OUT_BUFFER 驱动验证合并）→ CreateDCW → StartDoc → 份数×页循环：
  PNG 解码（png crate，EXPAND|STRIP_16 统一 8bit；Rgb/Rgba/Gray/GrayAlpha
  四色型 → BGRA top-down）→ 按位图宽高比 ResetDC 逐页切横竖向（混排 PDF
  支持；ResetDC 失败降级为现方向居中）→ StartPage/StretchDIBits（可打印
  区等比居中 + PHYSICALOFFSET）/EndPage → 页边界检查取消 → EndDoc；
- 事件 `print-job-progress`（started/page/done/failed/cancelled，job 过滤）；
- `print_job_cancel`：AtomicBool 页边界生效，取消走 AbortDoc；
- 纪律：release panic=abort 下全路径零 panic（PrintJobs 锁中毒、驱动失败
  全走显式错误字符串）；windows-sys 符号分布查证留痕——打印机族在
  `Graphics::Printing`（PRINTER_HANDLE 结构体）、StartDoc/EndPage 族在
  `Storage::Xps`（gdi32 链接）、DEVMODEW/位图族在 `Graphics::Gdi`。

### 2.2 前端内容层（`src/lib/printJob.ts`，566 行，重构自 printNote.ts）

| 面 | 内容 |
|---|---|
| 值域 | PRINT_ORIENTATIONS / PRINT_DPI_CHOICES（150/300）/ printDpiOf；parsePageRange（中文逗号·分号·–~ 容忍、去重升序、显式错误文案） |
| html 源 | extractHtmlPrintParts（body 提取 + style 收集/剥除 + 本地 link 收集 + 远程跳过计数；大写标签/残缺文档容错）→ buildHtmlPrintContext（本地 css 逐个读取、url() 按 css 自身目录 file:/// 绝对化）；图片经 prepareExportHtml 的 inlineExportImages 按 docPath 内联（与 md 同语义） |
| docx/pdf 源 | buildDocxPrintContext（mammoth + arrayBuffer slice 副本纪律）/ readPdfPrintBytes（readDocNoteBytes 副本） |
| 排版 | buildPrintPdfBytes：md/docx/html 走 buildPdf（增量仅 orientation）；pdf 原样返回（零转码） |
| 作业 | ensureJobDir（print/job-<stem>-<ts>/）→ renderPageToPng（pdf.js 按 dpi/72 光栅，canvas 用毕清零）→ 逐页写 page-NNN.png → **先注册 listen 再 invoke**（零竞态）→ 等终态事件 → finally 递归删 job 目录（成败都删） |
| 清理 | cleanupOldPrintFiles：48h 前旧件 + job 目录（recursive）；目录缺失 console.warn 不抛 |

### 2.3 自研对话框（`src/components/PrintDialog.tsx`，核心交付物）

- 状态机 prepare → ready →（参数变化防抖 500ms 重排，旧预览保留）→
  printing（render/print 双阶段进度）→ done（toast + 关闭）/ failed；
- 左栏：打印机下拉（默认标记 + ⟳ 刷新 + 空清单降级文案）/ 份数 1-99 /
  页面范围（全部|自定义 + 实时校验与错误文案）/ 纸张/方向/边距（pdf kind
  禁用并注「按原文件页面直打」）/ 打印质量（150/300 DPI）；保真度边界
  提示（docx 版式 / html 重排版 / 远程样式表跳过计数 toast）；
- 右栏预览：pdf.js 逐页 canvas（IntersectionObserver 可视渲染 + LRU 12 页
  缓存 + dpr≤2 感知 + 卸载/换代位图释放——PdfNoteView 惯用法简版）；页码
  角标 + 共 N 页；ResizeObserver 容器自适应（宽度变化清缓存）；
- 打印：runPrintJob（同一 doc 光栅——所见即所打）→ done 提示「已发送到
  打印队列（N 页 × M 份）」；取消双语义（渲染即时中止 / 打印页边界收场）；
- 「保存 PDF…」：pickSaveFile + 直写当前预览 bytes（pdf kind = 原文件副本）；
  无打印机时唯一出口；
- 偏好记忆：settings.printPrefs（paper/orientation/marginMm/lastPrinter）
  参数或打印机变化即回写，下次打开预选；
- 样式自足：组件级 `<style>`（printdlg- 前缀），纸面恒浅色、铬部中性双色，
  不依赖全局 CSS/主题变量。

### 2.4 管线与设置

- `exportPdfPipeline.ts`：PdfPipelineOptions.orientation（横向版心宽高交换，
  单点注入 :478 附近；meta 回填 orientation）；导出路径不传，行为零变化；
- 设置：printChannel 删除（migrateSettings 清除遗留键 + printPrefs 幂等归
  一：纸张/方向/边距值域校验、lastPrinter 仅字符串）；SettingsModal「打印
  通道」Field 改为打印说明；defaults/defaults.test 锚点更新；
- 入口零变化：MenuBar / useMenuCommands（case "p" 注释更新为 PI2 口径）/
  PdfNoteView·DocxNoteView 按钮（title 更新）；App.doPrint 简化为打开对话
  框（ExportProgressDialog 不再用于打印）；
- 平台：caps.print 语义改为「应用内打印（对话框+GDI）」；harmony false 注
  释更新（GDI Windows 实装，鸿蒙打印留待后续）。

### 2.5 保留的 PR 轮资产

- `wrapStandaloneHtml` 共享骨架抽取（exporter，导出字节等价——本轮仅改注释）；
- `tauri.conf.json` shell.open 本地路径正则 + capability `$APPDATA/**` 条目
  （HtmlNoteView「系统浏览器打开」按钮仍依赖；打印不再使用）；
- 菜单/键位/视图按钮入口、48h 启动清理惯例。

## 3. 代码门禁实测

| 门禁 | 结果 |
|---|---|
| `cargo check` | **过**（首次编译暴露 windows-sys 0.61 符号分布与 PRINTER_HANDLE/DEVMODE union 形态差异，按 registry 源码逐一核对修正） |
| `npx tsc --noEmit` | **0 错误**（插曲：jsdom 组件面 pdfjs v6 destroy 在 loadingTask 上非 doc——对齐 PdfNoteView 结构类型惯例） |
| `npm run lint` | **0 问题** |
| `npm run test` | **1343 / 119 文件全绿**（新增 printJob 19 + PrintDialog 5 + 铁律改写 2 + defaults 1 + 管线横向 1；首跑 1 例计时型 flake，两次复跑全绿——与 PR 轮报告同类现象，环境负载抖动非回归） |
| `npm run build` | **过**；打印面只在独立 chunk（PrintDialog 18.0 kB / printJob），`print-job-progress`/`printdlg-` 标记在 index 等 chunk 零命中——首屏零增量 |
| 铁律 grep | `window.print` 拼接字面量全仓 src/ **零命中**（printIronRule.test.ts 锚定，随全量测试绿） |
| `npm run build:harmony` | 待跑（见 §5 手测前清单） |

## 4. 与历史铁律的对账

| 铁律 | PR 轮口径 | PI2 口径 |
|---|---|---|
| webview 打印 | 应用内不出现 print 调用；唯一例外 = 打印模板注入用户浏览器 | **全仓零 print 字面量**（例外删除；GDI 是另一条路） |
| 临时件 | 只写 $APPDATA/print/，48h 清理 | 同左 + job 目录作业即删 + 递归清理遗留 |
| 原件神圣 | 四 kind 只读链 | 同左（pdf/docx 副本纪律不变） |
| 依赖 | 零新依赖 | Cargo +png（纯 Rust 解码器）+ windows-sys 两 feature；npm 零变化 |
| 失败显式 | 浏览器/写入失败 toast | 打印机/解码/渲染失败显式 toast + 对话框错误态 |

## 5. 桌面手测清单（Windows/WebView2——待真机执行）

> 入口：菜单 文件→打印… / Ctrl+Shift+P / pdf·docx 视图顶栏「打印」。

- [ ] 1. md（图片/公式/代码块/表格/深色主题）→ 对话框预览分页正确（代码块
      不拦腰、标题不悬空）→ 默认打印机实打一页，文字清晰（300 DPI 档）；
- [ ] 2. 横向 A4：预览变宽页、打印方向正确（DEVMODE landscape）；
- [ ] 3. 边距/纸张切换 → 防抖重排生效、旧预览期间不闪断；
- [ ] 4. 页码范围「1-3,5」：只打所选页；非法输入打印钮禁用并显示原因；
- [ ] 5. 份数 2：实体纸出两份（应用层 copies 循环）；取消：打印中点取消，
      当前页完成后停止 +「已取消打印」；
- [ ] 6.「Microsoft Print to PDF」打印机：产出 PDF 文件（内容完整、可选
      中文字）；「保存 PDF…」直存与预览一致；
- [ ] 7. docx 笔记：mammoth 版式可打；html 笔记（含相对图片的保存网页）：
      本地图显示、远程样式表跳过提示；pdf 笔记：原文件页面直打（横竖混排
      文档逐页方向正确）；
- [ ] 8. 无打印机环境（如拔掉/停服务）：清单空 + 打印禁用 + 保存 PDF 可用；
- [ ] 9. 远程图断网：missing 列报 + 占位框，预览/打印不阻断；
- [ ] 10. 超大文档（1MB md）：预览可滚动、打印逐页进度可取消（内存受控）；
- [ ] 11. 工作区目录全程零新文件；`%APPDATA%/com.mditor.app/print/` 作业
       目录打印结束即删；重启清理 48h 前旧件（含 PR 轮遗留 .html/.pdf）；
- [ ] 12. Ctrl+P 快速打开 / Ctrl+Shift+P 打印互不干扰；Esc 关闭对话框
       （打印中关闭 = 取消作业）；
- [ ] 13. harmony 构建 `npm run build:harmony` 通过、菜单无打印项。

## 6. 已知边界（文档化）

- **GDI 位图打印**：150/300 DPI 位图输出，文字质量与矢量无肉眼差异；打印
  队列状态不回查（完成口径 =「已发送到打印队列」，spooler 异步）；
- **html 重排版折损**：页面宽度驱动布局会重排、远程样式表跳过（对话框明
  示 + 计数 toast）；css 内相对 url() 已改 **fs 读取 + base64 data: 内联**
  （原 file:/// 形态被应用 CSP 拦截、本地背景图静默丢失，见 §8 修复 4）；
- **纸张不匹配**：打印机未装所选纸张时驱动默认处理（缩放/提示），Word 同
  行为；list_printers 不探测纸张能力；
- **取消粒度**：页边界生效（当前页输出完成后停止，已出页不撤回）；
- **harmony**：GDI 为 Windows 实装；鸿蒙系统打印 API 留待后续轮次。

## 7. 文件清单

```
src-tauri/src/printing.rs            新增（GDI 直打引擎，三命令 + 事件）
src-tauri/src/lib.rs                 模块注册 + manage(PrintJobs) + handler 三命令
src-tauri/Cargo.toml                 windows-sys +Gdi/+Printing/+Xps feature；+png
src/lib/printJob.ts                  新增（重构自 printNote.ts：值域/源/编排）
src/lib/printNote.ts                 删除（外部通道整体退役）
src/lib/printJob.test.ts             新增（19 例）
src/components/PrintDialog.tsx       新增（自研打印对话框，核心交付物）
src/components/PrintDialog.test.tsx  新增（5 例）
src/lib/printIronRule.test.ts        改写（全仓零 print 字面量，更强口径）
src/lib/printNote.test.ts            删除
src/lib/exportPdfPipeline.ts         orientation 选项（导出零变化）+ 头注更新
src/lib/exportPdfPipeline.test.ts    横向数学锚点
src/lib/exporter.ts                  注释去 printNote 引用（wrapStandaloneHtml 注入点保留）
src/App.tsx                          doPrint→对话框 + lazy 挂载 + 启动清理指向 printJob
src/hooks/useMenuCommands.ts         doPrintRef 类型（void）+ 注释更新
src/components/PdfNoteView.tsx       打印按钮 title（应用内口径）
src/components/DocxNoteView.tsx      同上
src/types.ts / defaults.ts           printPrefs 新键（printChannel 删除）
src/lib/store.ts                     printPrefs 归一 + printChannel 清除
src/components/SettingsModal.tsx     打印分区说明（删通道单选）
src/defaults.test.ts                 键清单 + printPrefs 默认值锚点
src/platform/types.ts                caps.print 注释（应用内语义）
src/platform/harmony/index.ts        print:false 注释（Windows 实装口径）
CHANGELOG.md / README.md / site/index.html  5.3.0 条目重写（应用内打印）
```

## 8. 加固轮（2026-11-04，全面审查 + 性能/动效迭代）

门禁基线：vitest 1343/1343 · eslint 全仓 0 告警 · tsc --noEmit 通过 ·
cargo check 通过（本机 cargo 镜像不可达时经官方 index 直连验证）。

### 8.1 漏洞/bug 修复

1. **能力面死配置清除**（capabilities/default.json）：shell:allow-open 的
   `$APPDATA/**` path 条目对 plugin-shell 2.3.5 的 open 命令是装饰性的
   （open 唯一值闸门是 tauri.conf.json `plugins.shell.open` 正则——已核
   对插件源码 scope.rs/open.rs），系 PR 轮遗留；移除并把描述改为现状事实。
   正则本身保留：缺省正则只放行 URL，「用系统应用打开」本地文件与
   devMode 打开目录都依赖它（修的是存量坏损，非打印遗留）。
2. **is_default 失效**（printing.rs）：GetDefaultPrinterW 成功时 pcchBuffer
   含结尾 NUL，按长度切片把 ' ' 带进 String → 与枚举名永不相等、默认打印
   机标记全体失灵。改按首个 NUL 截断 + 长度钳制。
3. **打印↔重排竞态**（PrintDialog）：重排防抖 500ms 窗口内点「打印」，
   防抖在打印开始后才触发 → runLayout 对正在被光栅化的 doc 调
   task.destroy() → 打印中途失败。三重修复：canPrint 重排期间禁用 +
   doPrintAction 清防抖定时器并 abort 在途重排 + finally 复位条件按
   「是否被接替」判定（不再卡死 reformatting）。
4. **CSS url() 的 CSP 拦截**（printJob.ts）：file:/// 背景图/字体在离屏工
   厂 iframe 被 CSP（img-src/font-src 无 file:）静默拦截。改
   inlineCssUrls：fs 读取 → 魔数/扩展名定 MIME → base64 data: 内联（与
   <img> 的 inlineExportImages 同语义，自包含且不受 asset scope 限制）；
   读取失败/超 8MB 保留原引用并计数（HtmlPrintContext.skippedCssAssets，
   对话框 toast 列报）。
5. **invoke 窗口期取消竞态**（printJob.ts）：取消若在 Rust 注册旗标前到达
   会落空、作业照跑误报 done。invoke 返回后 signal 已中止则补发一次取消
   再等终态。
6. **作业目录秒级碰撞**（printJob.ts）：多窗口同一秒对同名文档开打会共用
   job-*/ 目录（页 PNG 互相覆盖 + 先结束方整目录删除抽走对方的页）。目录
   名改以 jobId（print-<ms>-<seq>）打头，截断后唯一段必然存活。
7. **stretch_page 静默白页**（printing.rs）：HORZRES/VERTRES≤0 原为静默跳
   过绘制、页仍计 done——违反铁律 5。改返回 bool，失败走显式错误中止作业。
8. **failed 态锁死**（PrintDialog）：首排失败后改纸张/边距不触发重排。改
   为 failed 也允许参数变更重试（functional setPhase 切回 prepare），并给
   runLayout 补「源缺失显式失败」防假 ready。

### 8.2 性能（P1：份数下沉）

**dmCopies 协商**（printing.rs）：份数优先经 DEVMODE dmCopies 下沉驱动/
spooler（页循环单遍——同一 PNG 不再 copies 次重复解码；300 DPI 多份大文档
省分钟级纯 CPU）。驱动不接受（清位/截低）则回写 dmCopies=1 防 spooler 叠
加复制，回退原 copies 外循环。started 事件移入协商后发送（total 依协商结
果而定：驱动备份 = 页数；回退 = 页数 × 份数）。

### 8.3 纵深防御

print_png_job 增页路径域校验：仅允许 appDataDir/print/ 内（分隔符归一 +
小写比较）。命令面不成为「把盘上任意文件送物理打印机」的外泄通道（前端
本就只传该目录，无行为变化）。

### 8.4 UI/动效

PrintDialog 样式对齐全仓动效体系：进出场动画（overlay 淡入淡出 + 面板
scale/translate，--dur-base 进/--dur-exit 出，退场播完再卸载 ~220ms）、
控件 hover/active 过渡与 focus-visible 焦点环、预览 canvas 轻淡入；「无」
档与 prefers-reduced-motion 由 global.css 通配 kill switch 压为瞬时（组件
无需自理）；lively 档惰性增强（sheet 曲线面板 + 侧栏字段 25ms/项级联）。
PreviewPage key 改 docGen 代际计数（原 `docRef.current ? "d" : ""` 恒真 hack）。
