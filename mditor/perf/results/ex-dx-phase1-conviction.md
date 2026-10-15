# EX-DX 阶段一：DOCX 导出失败定罪报告（症状 E-D1）

- 日期：2026-10-15　轮次：DX（Word 导出失败修复专项）
- 基线：HEAD `8068283`（工作树干净，仅任务书未跟踪）；npm test 实跑 1077 例
  （全量 1076 绿 + `exportPdfAssembly` 1 例并发负载型超时，单跑 183ms 绿——
  基线 1077 全绿）；fixtures 在位。
- 活体环境：`tauri dev` @ WebView2 CDP 9223（vite dev server 1420），
  驱动脚本 `perf/ex-dx-matrix.mjs` / `perf/ex-dx-repro-docx.mjs` /
  `perf/ex-dx-probe-node.mjs`。

## 结论（根因唯一）

**`@turbodocx/html-to-docx@1.22.0` 的 browser 构建
（`dist/html-to-docx.browser.esm.js`，webview 按 package.json `exports.browser`
条件实际加载的那份）裸引用 Node 全局 `Buffer` 与 `global`——在 WebView2（纯
浏览器环境，无 Node 全局）里必然抛 `ReferenceError`，被 `App.tsx` doExport
统一 catch 弹「导出失败：ReferenceError: …」。**

两个 throw 点（活体堆栈 + vite deps 产物行号）：

| # | throw 点（vite deps `@turbodocx_html-to-docx.js`） | 原始 browser.esm.js | 触发条件 | 报错原文 |
|---|---|---|---|---|
| T1 | `yM` @ :33875 → `EM`(buildParagraph) @ :33904 → `RF` @ :33169 | `Buffer.from(decodeURIComponent(i),"base64")` @1584789 | HTML 含 **data URL 图**（Fix-C2 内联产物 / 公式栅格化产物） | `ReferenceError: Buffer is not defined` |
| T2 | `fL` 尾段 @ :35222 | `hasOwnProperty.call(global,"Buffer")` @1647953（同型 @1648067） | **任何文档**（产物转换段，最后一步） | `ReferenceError: global is not defined` |

弹窗全文 = `String(e)` =「导出失败：ReferenceError: Buffer is not defined」
（含图档）或「导出失败：ReferenceError: global is not defined」（纯文本档）。

### 为什么 1077 绿测不出来

包 `exports` 字段区分构建：`node` 条件 → `esm.js`（vitest 实际加载，Node 下
Buffer/global 都在，全绿）；`browser` 条件 → `browser.esm.js`（vite/webview
实际加载，裸引用即崩）。**已有 DOCX 钉子测试（exporterDocx.test.ts）从未
覆盖 browser 构建**。EX 轮「data URL 真实嵌入 word/media」实证（commit
3f91375）同样跑在 Node 构建——webview 侧 DOCX 导出自依赖引入（init 3.4.0,
226b807）以来从未成功过，与「代码库无活跃报障记录」不矛盾（无人在真实
webview 验收过）。

### 上游状态（已核实，不重查）

- 1.22.0 → 最新 1.23.1（2026-09-11）：下载 tarball 比对，
  browser 构建仍含同样的裸 `Buffer.from(decodeURIComponent(...))` 与
  `hasOwnProperty.call(global,...)`——**升级不解决**，排除依赖升级路径。
- browser 构建内部其实打包了完整 buffer 模块实现
  （`var re=Object.freeze({Buffer:v,...})`，Feross/buffer 特征齐全），但库
  代码裸引用全局 `Buffer` 而非命名空间 `re.Buffer`——rollup CJS→ESM 转换
  漏替换，上游构建缺陷。
- browser 构建 API 面盘点：`Buffer.from`×10（utf-8/base64/arrayLike 三种
  形态）、`Buffer.isBuffer`×1；裸 `global` 真正危险的 2 处（其余为字符串
  字面量/typeof 保护）；`process` 无裸运行时引用（自带 shim）。

## 判别实验矩阵（demo.md 全语法语料 × 三格式，活体两轮一致）

| 链路段 | 结果 | 证据 |
|---|---|---|
| S7 getHTML（模型序列化） | OK 10128B | 矩阵步骤 |
| S7 renderBlockMath | OK hasMath=true | |
| S4 rasterizeFormulas | OK 508ms → 53369B（data URL 图产物） | 栅格化本体不抛 |
| 双链/引用/闪卡降级 ×3 | OK | |
| S7 collectThemeCss | OK 255313B | |
| S6 sanitizeExportHtml | OK 1ms（保留 data URL 图） | |
| C2 inlineExportImages(remote:fetch) | OK（missing=1：demo 引用的 loss.png 磁盘不存在，列报语义正常） | |
| **S2 juice.inlineContent** | **OK 195ms** | **排除** |
| **S1 htmlToDocx #1/#2** | **ReferenceError: Buffer is not defined ×2** | **定罪** |
| HTML wrapHtml+katex 字体 | OK 309044B | HTML 路径无恙 |
| PDF exportPdfTo（自研管线全量） | OK 998ms，A4×3 页 | PDF 管线无恙 |

最小复现档（`perf/fixtures/docx-repro/`，均两轮稳定）：

- `min-global.md`（452B 纯文本，无公式无图）→ T2 `global is not defined`
- `min-dataurl.md`（2001B 单 data URL 图）→ T1 `Buffer is not defined`
- demo.md 全语料 → T1（公式栅格化 data URL 图）

## §2.C 嫌疑排除表

| 嫌疑 | 判定 | 依据 |
|---|---|---|
| S1 htmlToDocx | **定罪** | 活体堆栈两 throw 点均在库内帧；Node 构建同输入成功（vitest 钉子）；上游 1.23.1 未修 |
| S2 juice.inlineContent | 排除 | 活体 195ms OK（demo 全语料 55KB 内联产物） |
| S3 toArrayBuffer | 排除 | 位于 htmlToDocx 之后未到达；防御 throw 文字「html-to-docx returned a Blob」与症状原文不符 |
| S4 rasterize 下游 | 排除（非独立根因） | 栅格化本体 OK；其 data URL 产物只是 T1 的触发形态之一——纯文本档无公式无图也崩（T2），「有公式才报错」指纹被证伪 |
| S5 fs.writeFile | 排除 | 位于 htmlToDocx 之后未到达；活体堆栈无平台帧 |
| S6 sanitizeExportHtml | 排除 | 活体 OK；输出保留 data URL 图（11462B，missing=0） |
| S7 共享段（getHTML 等） | 排除 | :1844 之前不触发弹窗（§2.B 位置分析，调用侧已核实无包装）；矩阵全过；HTML/PDF 产物正常 |
| pickSaveFile | 排除 | 用户取消返回 null 非抛；活体复现绕过对话框仍崩同错 |

## 修复方向（阶段二依据，红线 7 输入侧规避路径）

webview 侧在加载库前注入最小 Node 全局垫片：`globalThis.global ??= globalThis`
+ `globalThis.Buffer ??= <Uint8Array 子类最小实现>`（覆盖 from(str,'utf-8'|'base64')/
from(arrayLike)/isBuffer，实例 length 天然继承）。幂等（仅 undefined 时注入），
不覆盖真实实现；产物 `Buffer` 实例经 exporter.ts toArrayBuffer
（`instanceof Uint8Array`）正常转 ArrayBuffer，闭环。零新依赖、零包体积影响。
sidecar/Node 子进程（TODO P1）不需要。

## 观察项（记入报告待办区，不顺手修）

- dev 活体 fs scope 只放行 `$APPDATA/**`/`$DOCUMENT/**`（capabilities/
  default.json），仓库内图片 inlineExportImages read-error 进列报——活体验收
  语料需用 data URL 或 Documents 内图片。
- `__exportDebug.open()` 对打开失败可能静默返回 true（编辑器保持旧文档）——
  perf 驱动需自行校验 docPath 切换（ex-dx-matrix.mjs 已内置）。
