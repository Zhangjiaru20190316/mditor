# mditor Word(DOCX) 导出失败修复报告（DX 轮）

- 轮次：DX（单症状修复专项）　日期：2026-10-15
- 症状：E-D1——菜单「导出 Word (docx)」弹「导出失败：ReferenceError: …」
  错误框（App.tsx doExport 统一 catch :1918-1924）。
- 基线：HEAD `8068283` + DX 两 commit（观测 `98dcfd7` / 修复 `4155006`）；
  npm test 基线 1077 全绿（EX 收口实跑复认，其中 `exportPdfAssembly` 一例
  在并发全量下有负载型超时、单跑 183ms 绿）。
- 任务书：`docs/prompts/docx-export-fix-prompt.md`；定罪证据原件：
  `perf/results/ex-dx-phase1-conviction.md`。

## 1. 定罪（D1 门：根因唯一，证据落盘）

**根因：`@turbodocx/html-to-docx@1.22.0` 的 browser 构建
（`dist/html-to-docx.browser.esm.js`——webview 按 `exports.browser` 条件实际
加载的那份）裸引用 Node 全局 `Buffer` 与 `global`，WebView2（无 Node 全局）
里任何文档必抛 `ReferenceError`。**

| throw 点 | 位置（vite deps 产物） | 触发 | 报错原文 |
|---|---|---|---|
| T1 | `yM` 图片解码 `:33875`（`EM` buildParagraph→`RF`） | HTML 含 data URL 图（Fix-C2 内联 / 公式栅格化产物） | `ReferenceError: Buffer is not defined` |
| T2 | `fL` 尾段产物转换 `:35222` | 任何文档（最后一步） | `ReferenceError: global is not defined` |

弹窗全文 = `String(e)` =「导出失败：ReferenceError: Buffer is not defined」
（含图档）/「导出失败：ReferenceError: global is not defined」（纯文本档）。

### 为什么此前测不出来

包 `exports` 区分构建：vitest 走 `node` 条件（esm.js，Node 全局齐全，1077
绿）；webview 走 `browser` 条件（browser.esm.js，裸引用即崩）。**DOCX 钉子
测试从未覆盖 browser 构建**；EX 轮「data URL 真实嵌入」实证也跑在 Node 构建。
该库自 init（3.4.0，`226b807`）引入——webview 侧 DOCX 导出从未成功过。上游
1.22.2/1.23.0/1.23.1 tarball 比对：**同样未修**（库内打包了完整 buffer 实现
`re.Buffer` 却未挂全局，rollup CJS→ESM 转换漏替换），升级路径排除。

### 判别实验矩阵（demo.md 全语料，活体两轮一致）

共享段（getHTML/renderBlockMath/rasterizeFormulas/双链/引用/闪卡降级/
collectThemeCss）+ S6 消毒门 + C2 内联 + S2 juice + HTML wrapHtml + PDF 自研
管线（A4×3 页 998ms）**全过**；仅 S1 htmlToDocx 两轮 `Buffer is not defined`。
→ 根因锁定 DOCX 专属段（§1 判别协议）。

### 嫌疑排除表（§2.C 全项）

S2 juice（活体 195ms OK）/ S3 toArrayBuffer（未到达，防御 throw 文字不符）/
S4 rasterize 下游（栅格化本体 OK；纯文本无公式也崩，指纹证伪——非独立根因）/
S5 fs.writeFile（未到达，堆栈无平台帧）/ S6 消毒门（活体 OK，data URL 图保
留）/ S7 共享段（矩阵全过）/ pickSaveFile（取消返回 null 非抛）——逐项依据
见 `perf/results/ex-dx-phase1-conviction.md`。

## 2. 修复（D2 门：最小，一次一项）

**输入侧全局垫片（红线 7 的「输入侧规避」路径；零新依赖、零包体积影响、
sidecar/Node 子进程预案不需要）**：

- `src/lib/exporter.ts`：`ensureBrowserNodeGlobals()`——`globalThis.global
  ??= globalThis` + `globalThis.Buffer ??= MiniBuffer`（仅补缺不覆盖、幂等），
  在 `exportDocx` 首次 `import("@turbodocx/html-to-docx")` 前注入（库顶层与
  图片解码路径都读这两个全局）。
- `MiniBuffer`：Uint8Array 子类（产物进 zip 流、`toArrayBuffer` 的
  `instanceof Uint8Array` 天然通过）。API 面=库实测调用形态：静态
  `from(str,"utf-8"|"base64")`/`from(arrayLike)`/`isBuffer` + 核心工具
  `byteLength`/`alloc`/`concat`（后者为 node 侧 undici fetch 旁路兜底）。
  `from` 以 Object.assign 挂载——Buffer 语义与 `Uint8Array.from` 的 mapfn
  重载静态签名冲突，class 内命名 `make`。
- `src/turbodocx-browser-build.d.ts`：browser 构建深路径类型垫片。

**契约保持**：documentOptions（cantSplit/footer/pageNumber）不变；消毒→内联
→juice→转换链路语义不变；S10 消毒门原样保留在输入侧；修复点在 DOCX 分支
内部，PDF/PNG/HTML/LaTeX 管线零触碰。

## 3. 门禁实测表

| 门 | 要求 | 实测 | 判定 |
|---|---|---|---|
| D1 定罪 | 根因唯一 + 证据落盘 + 嫌疑排除 + 复现 ≥2 | 两 throw 点活体堆栈钉死（demo/最小档各 ≥2 轮）；判别矩阵 + 排除表落 `perf/results/ex-dx-phase1-conviction.md`；最小复现档 `perf/fixtures/docx-repro/{min-global,min-dataurl}.md` | ✅ |
| D2 修复 | 原复现文档导出成功 + 产物可开 + 契约保持 | 5/5 语料（最小×2/demo/公式/多图）转换出包；zip 结构合法（ContentTypes/document.xml/rels/media）；**本机 Word COM 无头实开 5/5**（demo 39 段 5 图、公式档 6 图、多图档 4 图）；产物样本 `C:/Users/hh/Documents/ex-dx-accept-*.docx`；exporterDocx.test.ts 钉子绿 | ✅ |
| D3 回归 | npm test ≥1077 零回退 + 新增根因回归 | **1080/1080 全绿**（基线 1077 + 新增 3：`exporterDocxBrowserBuild.test.ts`——jsdom 模拟 webview 全局缺失直驱 browser 构建，钉 T1/T2 两 throw 点 + 垫片幂等语义）；tsc --noEmit / eslint 干净 | ✅ |
| D4 交付 | 报告 + CHANGELOG + memory | 本报告 + CHANGELOG Unreleased（DX 段）+ `memory/2026-10-15.md` | ✅ |

红线自查：观测（`98dcfd7`）与修复（`4155006`）分开 commit；每 commit 前
npm test 全量实跑；热路径模块 diff 为零；KaTeX/S10/编辑器管线未动；无新增
依赖（无红线 8 体积评估项）。

## 4. 遗留与待办（顺带发现，未顺手修）

- dev 活体 fs scope 只放行 `$APPDATA/**`/`$DOCUMENT/**`
  （`src-tauri/capabilities/default.json`）——仓库内图片在导出内联时
  read-error 进列报。仅影响 dev 活体验收语料形态，生产用户文档不受影响；
  若日后要仓库内 fixture 直测，需评估扩 scope 或语料放 Documents。
- `__exportDebug.open()` 打开失败可能静默返回 true（编辑器保持旧文档），
  perf 驱动需自行校验 docPath（ex-dx-matrix.mjs 已内置该校验）。
- 库对 `Buffer` 的引用若在未来版本扩展（升级 1.23.x 时），MiniBuffer 面需
  复评——回归测试直驱 browser 构建，升级会立刻暴露缺口。
- DOCX 转换仍在主线程同步执行（juice+htmlToDocx 大文档 UI 冻结，EX 轮已知
  挂起项）——本轮未动，worker 化仍待用户拍板。
- 上游缺陷线索（库内 buffer 实现未挂全局）可提 issue 反馈上游，非本轮范围。
