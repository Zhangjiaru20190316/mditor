# 任务：mditor 大文档滚动流畅度第十轮治理——滚动底部闪刷/换装可见专项（公式块等元素渲染不自然）

> 使用方式：本任务书配套 `/goal` 命令交付（目标文本见下方代码块，直接粘贴）。前端代码在 `mditor/` 子目录，所有 `perf/` 与 `npm` 命令在 `mditor/` 下运行。核心环节分阶段推进（§7），每阶段证据落盘（`perf/results/` 与报告草稿）并自查后才进下一阶段，禁止把归因与修复混在同一批。动手前必读第 0、1、2、3、9 节——本任务禁止盲改，禁止重修已修问题，禁止预设根因结论。
>
> ```text
> /goal 修复 mditor 大文档滚动时视口底部公式块等元素渲染不自然、可见闪刷/刷新（第十轮专项，范围：cv 档大文档滚动换装可见性——块级公式/代码块 nodeview 频带挂载-拆卸换装、行内公式渲染泵预算与帧饥饿、换装过渡视觉呈现、demote/teardown 回访重闪、cvMemory 占位高变现跳动；R5~R9 全部门禁为不可回退基线）。任务书：docs/prompts/large-doc-bottom-flicker-optimization-prompt.md——先通读全文并遵守 §0 基线核实、§2 已查明事实集不重查、§3 禁区与红线，在 mditor/ 子目录下按 §7 阶段顺序执行，禁止盲改、禁止重修已修问题、禁止重走已证伪路线。完成判据（全部满足才 pass）：① 闪刷主门——S1 换装可见事件（渲染/换装完成时刻元素已与视口相交，分元素类型/分形态/十桶位置）较本轮基线 **-80% 且密度档 ≤5 次/全程、1MB ≤15 次/全程**（取先达者，未达项附归因不许留空）；S2 已渲染重闪（teardown→重挂/demote→重绘在视口内可见）密度档 **=0**、1MB 较基线 -80%；S3 高度瞬态显著下降（目标阶段三填死）且 D1 停滚漂移双臂维持 0；S4 视口源码占位（T2 口径按底部三桶单列）不劣化 >10%；S5 录屏观感过用户主观复核；② 历轮门禁零回退——R9 F1 focus/normal 对称比 ≤1.25 与 focus j32=0、D1 双臂 0、M1/M2/M3=0/0/100%、T1/T2 同批 ABAB ≤+10%、R8 上滚对称比 ≤1.25、R1~R5 基准全维持；③ 零回归——npm test 全绿（≥990 基线，以实跑为准），1MB 打开/打字/切换零回归；④ 交付——报告落盘 mditor/docs/large-doc-bottom-flicker-report.md，每个修复项独立 Fix-X commit 且附新增测试，重建打包安装包实机冒烟断言闪刷主门 + R9 双断言（focus j32=0 ×3 臂 + 停滚漂移双臂 0 + keepwarm CSS 钉），CHANGELOG 与 memory 日记更新。红线：复现 prod 优先（R9 教训制度化——dev 预热爬行 26ms/块，dev 复现不了 ≠ 没有）；块公式挂载/拆卸策略与换装过渡视觉策略属拍板项只出原型数据；不得以永不拆卸/全量常驻硬顶内存或拆除 cv 档懒渲染架构换零闪刷；KaTeX 0.18.4 单实例与宏语义不动；R4~R9 全部 Fix 不得破坏；P3 提案不得静默夹带；常量未经拍板不动；overflow-anchor 维持禁用；四层补偿链无归因证据不动；观测与修复分开 commit；每 commit 前 npm test；先测后改六步。
> ```
>
> 前序任务书引用链（体例连续，背景可查）：`docs/prompts/large-doc-perf-optimization-prompt.md`（第三轮，已结题）、`docs/prompts/large-doc-perf-motion-optimization-prompt.md`（第四轮，已结题——1MB cv 档滚动布局墙封案，本轮 1MB 门禁的立论背景底）、`docs/prompts/large-doc-scroll-stability-optimization-prompt.md`（第五轮，已结题——**乱闪 F/乱动 J 与本轮症状 S 是同一管线的近亲切面，其 Fix-A/B/C/D 是本轮防回退基线；"高度二象性 81px↔40px、残余 ~450ms 瞬态"遗留即本轮 S-Ⅲ 形态的前案**）、`docs/prompts/large-doc-formula-render-optimization-prompt.md`（第六轮，已结题——**T2"滚动中视口源码占位"与 Fix-B 上滚带直绘（commit `7ae2879`，peak 21→11）是本轮 S 组口径的直系前案；posBuckets"十桶均匀"结论的口径边界见 §2.B S-f**）、`docs/prompts/large-doc-scroll-drift-optimization-prompt.md`（第七轮停滚漂移，已结题——D 组防回退门来源；Fix-A 锁盒占位与 Fix-B prewarm-comp 不得破坏）、`docs/prompts/large-doc-upscroll-jank-optimization-prompt.md`（第八轮上滚掉帧，已结题——**位置混杂口径禁用与"冷区首渲布局墙"背景底两个教训直接继承**）、`docs/prompts/large-doc-focus-mode-scroll-smoothness-optimization-prompt.md`（第九轮专注模式掉帧，已结题——**Fix-A keepwarm 与 focusKeepwarm.test.ts 守卫、prod 探针全套加固蓝本、"dev 复现不可能"教训是本轮方法论支柱**）。
>
> 【填写】观察环境（用户已确认 2026-10-08）：症状在**打包安装版 v5.0.1-beta**观察到（= R9 Fix-A keepwarm 合入后的构建，commit 链 `e38aaa9`→`15d4f22`→`6d9458d`——阶段一仍须核实安装构建坐实）。主战场文档（已确认）：**大文档**（cv 档优化栈在场：懒挂载/渲染泵/预热/高度记忆全部激活）。症状钉死：**症状 S——滚动时视口底部内容（公式块等元素）渲染不自然，可见闪刷/刷新**（定义见 §1，禁止扩大或偷换）。**形态与元素类型用户未细辨（混合感知、"等元素"未指认）——四形态 S-Ⅰ~S-Ⅳ 全维度采集与元素类型分类（行内公式/块级公式/普通代码块/其它）是本轮探针职责，禁止以单一形态预设结论**。症状补充（典型文档名/下滚还是上滚更明显/快滚还是慢滚/滚轮还是触摸板/正常模式还是专注模式/首开即滚还是预热完成后更明显）：___。

## 0. 基线状态声明（执行第一步必须核实，禁止假设）

本任务书基于 2026-10-08 仓库状态撰写：

- HEAD = `6d9458d`（test(perf): R9 归因定罪书与全部测量产物入库）；版本 5.0.1-beta 四处（`tauri.conf.json`/`Cargo.toml`/`Cargo.lock`/`package.json`）；撰写时工作区 clean。R9 收尾双断言打包冒烟 PASS（`perf/results/r9-phase2-prod-jank-abab-down-slow-other-r9smoke-1.json`），安装包 `Mditor_5.0.1-beta_x64-setup.exe`。
- **执行第一步**：`git status` + `git log --oneline -5`，据实记录 HEAD 相对 `6d9458d` 的实际状态，报告开头声明；后续一切论述以核实后的代码为准。
- **用户构建核实**：`%LOCALAPPDATA%/Mditor/mditor.exe` ProductVersion 应为 5.0.1-beta、构建产物含 focus-keepwarm CSS（`--expect-keepwarm` 硬身份门，R9 冒烟口径）。预期与 main 同源；若版本差坐实，先按 R8 双版本对照流程排除版本差机制再进阶段二。
- fixture 在位性（历轮结题核实惯例）：`mditor/perf/fixtures/` 含 `无穷级数_密度档压测副本.md`（105KB/2,355 行内公式）、`解题技巧_密度档切换副本.md`（60KB/23 个 ```latex 块，M3/S-a 块公式档）、`一元微分学习题集_1MB压测副本.md`（1,574,112B）、`无穷级数_唯一公式超限副本.md`（714,088B/9,420 唯一）——整目录 gitignore（本地化惯例）。执行时先 `ls perf/fixtures/` 确认。**prod 侧主文档是用户真实文档**（R9 复现三元组：打包版 + 真实大文档 + release 预热完成）——典型文档名阶段一向用户确认后钉死。
- 生产证据窗口：`%APPDATA%/com.mditor.app/logs/`（打包版）与 dev 卷 `com.mditor.app.dev`；CDP 端口惯例 dev 9223、prod 探针 9224（避让 9222）。**WebView2 runtime 版本须实测登记**（R9 期间 154.0.4258.48→.53 自动更新曾致 T1/T2 绝对值漂移——本轮涉及跨批对比，环境项必须报告声明）。
- npm test 基线：R9 收尾 990 全绿（986 + focusKeepwarm 4；以实跑为准，执行第一步实跑 `npm test` 记录确数）。

## 1. 角色与主战场

你是资深 Web 文本编辑器渲染管线与视觉合成工程师，熟悉 ProseMirror nodeview 生命周期、IntersectionObserver 频带调度与" outrun"竞态（滚动穿越频带速度快于挂载完成）、rAF 帧预算下的 DOM 换装时序、content-visibility 的 remembered-size 变现语义、合成层与 opacity 过渡的观感心理学。**本轮性质：不是再猜一轮优化，而是「复现 → 建立测得出闪刷的基准 → 归因 → 修复 → 数据+观感双证明」——且是观感命题：数据门禁之外必须过用户主观复核（S5，红线 20）。**

症状钉死（定义，禁止扩大或偷换）：

**症状 S（滚动底部闪刷/换装可见）**：cv 档大文档滚动时（含滚动中与停滚瞬态），视口**底部边缘**内容——公式块等元素——出现可见的闪刷/刷新，渲染过渡不自然。用户未细辨形态，本轮定义四个子形态作**采集目标而非预设结论**（探针四形态全维度采集，§5）：

- **S-Ⅰ 源码先现**：占位态（LaTeX 源码/等宽占位样式）先可见，随后才换成渲染结果——即"占位→真身"换装过程发生在视口内；
- **S-Ⅱ 已渲染重闪**：元素此前已渲染好，滚动离开再回来（或频带边缘抖动）时被拆掉重建/demote 降级又重绘，肉眼看到"又闪一遍"；
- **S-Ⅲ 白闪/高度瞬态**：块区域瞬间空白或高度先塌后弹、内容位置微跳（占位高 ≠ 真实高的变现跳动，R5 高度二象性残余）；
- **S-Ⅳ 底部聚集性本身**：闪刷集中于视口下缘（前向换装区）而非均匀分布——用户感知"底部"是否真实聚集，本轮以数据回答（R6 posBuckets 口径边界见 §2.B S-f）。

区别于（口径不得混用，机制可同源——交叉数据支持时合并归因、一次修复双门复测，R6 惯例）：①**R5 症状 F 乱闪**（占位残留/回弹，已修，门禁防回退）；②**R6 症状 T 及时性**（占位停留时长/补绘拖尾——S 组测的是"换装完成时刻元素是否已在视口内"，不是"多久渲染完"）；③**R9 症状 F 掉帧**（帧间隔拉长，内容连续）。同一"占位↔真身"管线的四个切面。

主战场双档：**公式密集中型文档**（密度档，cv 档旁路 `BIG_DOC_MATH_DOLLARS=800` 生效，行内懒渲染开）+ **1MB 超长文档**（isBigDocCv 生效，叠加 cvMemory 预热/视口学习路径，S-e 候选必要条件在场）+ **prod 用户真实大文档**（阶段一钉死文档名）。三战场各钉各的，只测一档的结论无效。

范围界定：本轮只管**编辑器滚动容器**（`div.mditor-editor-host` 及其内容管线）滚动期间的换装可见性；sv 模式、静态表面（`src/lib/renderMarkdown.ts`）、导出路径不在门禁内。正常/专注两模式同测（R9 后两模式滚动均应丝滑，闪刷若模式不对称须记录）。

方法论铁律沿用第三~九轮：**先测后改、一次一项、ABAB 交错、证据不成立不动手、达不到假设就回滚**（§10）。

## 2. 已查明事实集（直接采用，不要重查；行号经静态核实，以仓库实际为准）

### 2.A 换装管线速览（本轮立论的代码事实）

- **块级公式（$$…$$）= LaTeX code_block nodeview**：Crepe Latex 特性把 math 节点改写为 `code_block(language:"LaTeX")`（`node_modules/@milkdown/crepe/lib/esm/feature/latex/index.js:369-387`），预览 = `katex.renderToString(displayMode:true)`（:396-424）；应用侧 `previewOnlyByDefault:true`（`src/hooks/useMilkdown.ts:730-745`）。nodeview 为 `@milkdown/components` code-block 组件（CodeMirror + Vue + KaTeX 预览），项目补丁 `patches/@milkdown+components+7.22.1.patch` 定型其懒挂载形态：
  - 占位 = 纯 `<pre><code>` 装 **LaTeX 源码文本**（`renderPlaceholder`，index.js:738-745）；
  - 共享 IntersectionObserver，`rootMargin:"800px 0px 800px 0px"`（:574-588，补丁行 10）——设计意图是换装发生在视口外 800px；
  - 进带即 `initializeCodeMirror()`（:746-776）：**移除占位 pre** → 建 CodeMirror EditorView → 挂 Vue 应用 → watchEffect 触发 `renderPreview` → KaTeX HTML → DOMPurify → `previewContainer.innerHTML`（:425-435/:494-514）——**每块一次同步重活**；
  - 离带 `scheduleTeardown()`，`TEARDOWN_DELAY=15e3`（:810-816/:916，补丁自 5s 调至 15s 并修"聚焦块永不拆除"）；`teardownCodeMirror()`（:777-809）**卸载 Vue、销毁 CodeMirror、清空 DOM、重建源码占位**，并冻结包裹高度/overflow（补丁行 39-56）。
  - **块级无任何预热**（`src/lib/mathCachePrewarm.ts:26-28` 明确排除——挂载成本大头是 CodeMirror+Vue，KaTeX 是小头）。
- **行内公式（$…$）= 懒渲染 nodeview + 渲染泵**（`src/lib/lazyInlineMath.ts`）：占位 span 装 LaTeX 源码，锁盒模式钉宽高（R7 Fix-A，`paintPlaceholder` :529-548）；IO 800px 频带（:71/:128-138，R6 Fix-C 重校准）；IO 回调只入队，泵分帧消费：滚动中（`SCROLL_QUIET_MS=400` 未静）冷渲染预算 **5ms/帧**（`SCROLL_RENDER_BUDGET_MS` :83）、缓存命中直绘上限 **64 条/帧**（`SCROLL_HIT_PAINT_CAP` :96），预算耗尽回插下帧（`pumpScrollFrame` :334-430、`classifyEntry` :316-327）；静止后 10ms/帧全量补绘。换装 = `applyRenderedHtml`（:552-557）innerHTML 换装 + `.mditor-math-inline-ready` 类。**CSS 给换装 120ms opacity 过渡**（`src/styles/global.css:5980-6018`，过渡 :6008 附近）——每次晚到补绘都是一次可见交叉淡入。离带 `DEMOTE_DELAY=2500ms`+静止后 `demote()` 降级回源码占位（:588-662）。
- **cv 档 CSS 视口化 + 高度记忆**：`content-visibility:auto + contain-intrinsic-size`（`global.css:1757-1760` 附近，`.mditor-editor-host[data-big] .ProseMirror > *`）；cvMemory 按内容寻址记 `{w,h}`、装饰写死 `contain-intrinsic-size:<w>px <h>px` **无 auto 前缀**（`src/lib/cvMemory.ts:144-149`）；预热批强制可见测高后 `prewarm-end` 收回（:870-921，同帧 prewarm-comp 补偿 :979-1073）；视口学习只挂文档更新（plugin `view.update` :481-490）。未学块按 3em 占位高摆放，进视口变现为真实高——**S-Ⅲ 形态的机制来源**。
- **滚动容器与观测**：`div.mditor-editor-host`（`src/components/Editor.tsx:1258-1270`，`data-big` :1263）；scrollDebug rAF 归因循环（`Editor.tsx:543-547` 挂接）与停滚 anchor-comp 补写（`scrollDebug.ts:1341-1390` 附近，D1 看护对象，非本轮靶）。
- **档位门槛**：`src/lib/memory.ts`——isBigDoc 降配档（>3000 行/500KB）**整体关公式**，非本轮靶；本轮全部工作在 isBigDocCv cv 档（:109-114/:159-162，密度旁路 `BIG_DOC_MATH_DOLLARS=800` :89）。

### 2.B 症状 S 候选源（禁止预设主犯，逐一取证；多候选可并存）

1. **S-a：块公式/代码块频带挂载-拆卸换装可见（S-Ⅰ/S-Ⅱ 主候选，架构性 DOM 互换）**。换装 = 整个子树级"占位 pre ↔ CodeMirror+Vue+KaTeX"互换（§2.A），设计上应发生在视口外 800px，但：①快滚穿越 800px 带用时 < 挂载完成耗时（每块同步重活：CodeMirror+Vue+KaTeX+DOMPurify）→ 换装落进视口内可见；②IO 回调批量到达时多块争用主线程互相拖延；③`TEARDOWN_DELAY=15s` 拆卸后回访重挂 = 完整重建可见（S-Ⅱ 指纹：离开 >15s 再回来必闪）；④冻结高度占位与重挂后真实高度不一致的瞬态。**普通代码块与 LaTeX 块共用此 nodeview——S-a 若定罪，"等元素"（非公式代码块同闪）应同期坐实（探针分元素类型即为此）**。
2. **S-b：行内泵预算/上限与帧饥饿（S-Ⅰ 行内侧）**。滚动中冷渲染 5ms/帧 + 直绘 64 条/帧上限，预算耗尽回插——行内公式以源码占位态滞留底部边缘直至后帧换装；R6 T2 收尾 peak 10、R6 遗留 **T1 帧饥饿长尾**（长 rAF 间隙让 IO 条目堆积、晚到爆开）并案条款见 §6。
3. **S-c：换装视觉呈现本身（渲染够快仍"闪"）**。120ms opacity 交叉淡入 + 占位等宽样式 ↔ KaTeX 排版样式的视觉差——即使换装发生在视口内仅一帧，过渡动画把它放大为 120ms 可见闪；占位高度 ≠ 渲染高度的微跳（R5 定罪高度二象性 81px↔40px、残余 ~450ms 瞬态 = P3 提案）叠加。
4. **S-d：demote/teardown 边缘 churn（S-Ⅱ 行内侧）**。频带边缘反复进出：demote（2500ms+静止）降级回源码占位 → 再进带重绘，肉眼"已渲染的又闪一遍"；R6 曾修 demote 回带竞态漏渲染（Fix-A `656948c`），R7 锁盒已钉尺寸但**视觉互换本身仍在**。
5. **S-e：cvMemory 占位高变现跳动（S-Ⅲ）**。未学块/陈旧宽度块按 3em 或旧 `{w,h}` 摆放，进视口变现真实高度 → 塌/弹/位移；R9 已归档 **F-a 宽度陈旧机制**（宽度突变后高度表集体陈旧且无重学路径，`cvMemory.ts:65-69`/`:481-490`/`:763-770`）——若本轮 S-Ⅲ 形态含"宽度变化后首次进视口跳动"，按 R9 报告 ⑤ 重审条款**直接重开该案**，勿当新发现。
6. **S-f：无罪清单与口径边界（防执行者重查/误引）**：①**R6 posBuckets"十桶均匀（无尾部聚集指纹）"是残留事件口径（滚动停止后还剩多少占位），不是换装可见口径（换装完成时刻元素是否已在视口内）——不得引用它否定 S-Ⅳ，本轮必须以新口径重测**；②katexCache 命中直绘 <0.1ms 非闪源；③锚定补偿链（prewarm-comp/anchor-comp）是 D1 看护对象，无归因证据不是本轮靶；④R9 keepwarm/掉帧机制与本症状正交（帧率正常时闪刷照样可见），勿混同。

### 2.C 版本状态与 R9 收尾基线（本轮防回退基线）

- 版本差机制预期不成立（用户观察版本 = 5.0.1-beta = main 同源）——阶段一只需坐实。
- **R9 收尾数字**（详见 `mditor/docs/large-doc-focus-mode-scroll-smoothness-report.md` ④，本轮基线直接引用）：F1 对称比两指标 ≤1.25（prod 冒烟 focus j32=0 ×3 臂）；D1 双臂停滚漂移 0；M1/M2/M3 = 0/0/100%（23/23，解题技巧档）；T1 0/0、T2 peak 10（durP95 124~130 环境漂移留档——**T 类门以同批 ABAB 内对照为准**）；R1 1MB 打开 4,565ms、R2 打字密度档 112ms/1MB 404ms、R3 切换 2,010ms、R4 vitest 990、R5 scroll-abab p95 中位 165/ghost 11/+0/0/R8 上滚对称比 ≤1.25。
- **R9 方法论遗产（本轮制度化）**：①**dev 复现不可能教训**——dev 预热爬行 1 块/26ms（release 瞬时完成），dev 复现不了 ≠ 打包版没有，**本轮复现 prod 优先**（蓝本 `perf/tmp-r9/prod-focus-jank.mjs`）；②prod 探针加固全套（预杀残留 mditor.exe、单实例转发检测、exe 身份钉、每臂存活自证、证据先落盘、restore 8s 超时、prod 文件树 `el.click()` 开文档——坐标点击在 dpr 1.75 下不可靠）；③基线自发衰减教训——跨批对比只认同批 ABAB，臂序双向；④WebView2 自动更新致绝对值漂移——环境项必须登记。
- 生产日志复析角度：闪刷是观感症状、无专属异常码（MD-9001 是持续掉帧口径）——日志复析仅用于定位高发文档/时段辅助，不作为定罪证据。

### 2.D 测量设施（现存直接挂靠）

- **缺口声明：现存全部基准是"残留/时长/帧间隔"口径（scroll-flash-bench 的 F1/T2、probe-jank 的 j32），无一测"换装可见事件"（换装完成时刻 × 元素视口相交状态的联合判定）——这是本症状未被历轮门禁捕获的直接原因，本轮主建设项。**
- 蓝本：`perf/scroll-flash-bench.mjs`（占位残留事件/p95 + 十桶 posBuckets 口径 + upscroll/roundtrip/longread 场景）、`perf/tmp-r8/probe-jank.mjs`（rAF 逐帧 + `--scenario`/`--start-depth` 位置控制）、`perf/tmp-r9/prod-focus-jank.mjs`（prod 全套加固 + `--doc/--arms/--exp` 原型注入 + `--expect-keepwarm` 身份门）；CDP 底座 `perf/cdp.mjs`。
- 页内观测出口：`window.__mathPumpStats`（队列深度/deferred/直绘/冷算）、`window.__scrollDebug`（layout:shift/layout:block 事件流、anchor.comp 计数）、`cv.relearn` 事件流。**缺口：code-block nodeview 的挂载/拆卸/demote 事件流无观测出口——需在补丁内只加计数不改行为（走 `patches/`，观测独立 commit，红线 6/9）**。
- 单测守卫（不得跳过）：`lazyInlineMath.test.ts`、`cvMemory.test.ts`、`scrollDebug.test.ts`、`viewportAnchor.test.ts`、`md1011-regression.test.ts`、`katexCache.test.ts`、`mathCachePrewarm.test.ts`、`focusKeepwarm.test.ts`（R9 新增 ×4）。

## 3. 禁区与待拍板

- **已证伪勿重查**（第三~九轮证伪链 + 各报告负结果留档节）：R9 五条（位置混杂口径禁用、快滚小样本禁判、opacity:0 不能保温等——与本症状正交但方法论适用）；R6 密度档 toDOM 接缓存等三项降本负结果；R5 已修乱闪机制勿重修（防回退 ≠ 重开）。
- **R4~R9 成果不得破坏**：R5 Fix-A/B/C/D、R6 Fix-A/B/C（含**上滚带直绘 `7ae2879`**）、R7 Fix-A/B、R9 Fix-A keepwarm——任何改动跑 `md1011-regression.test.ts` + `cvMemory.test.ts` + `lazyInlineMath.test.ts` + `scrollDebug.test.ts` + `focusKeepwarm.test.ts` 全绿且不跳过。
- **P3 提案（预热批渲染态测高，R5 留档、R8/R9 两次呈报待拍板）**：S-c/S-e（高度瞬态/占位高保真度）定罪时与 P3 同属"高度表保真度"命题——**拍板材料一并呈报用户，可并案可分案，不得静默夹带**（§6）。
- **块公式挂载/拆卸策略与换装过渡视觉策略属拍板项**（红线 19/20）：`TEARDOWN_DELAY`、IO 频带半径、挂载形态（如轻量预览先行/两段式挂载）、120ms 过渡与占位样式——只出原型数据请拍板后合入，不得直接动。
- 未经用户拍板不得改默认值（`SCROLL_QUIET_MS`/`SCROLL_RENDER_BUDGET_MS`/`FORWARD_BAND_PX`/`SCROLL_HIT_PAINT_CAP`/`PREWARM_USER_YIELD_MS`/`DEMOTE_DELAY`/`IO_MARGIN`/`BLOCK_WALK_*` 等常量，含 nodeview 侧 `TEARDOWN_DELAY`）、不得重引入 bigDocViewportAuto、不得改档位开合逻辑。
- **不得以砍观测/砍公式完整性换指标**：M1/M2/M3 是硬门；T1/T2 劣化 >10% 即回滚。
- `overflow-anchor` 禁用是定案；四层补偿链无归因证据不动；R7 锁盒语义不得破坏。

## 4. 可量化目标（门禁表；判分：S1~S3 与 D 组必须有本机数据，修复类门在证据立项后判定，M/T/R 组全部零回归；未达项附归因，不许留空）

### S 组：底部闪刷（症状 S，本轮主门；"换装可见"= 渲染/换装完成时刻元素已与视口相交）

| # | 指标 | 已知基线 | 目标 | 测量 |
|---|---|---|---|---|
| S1 | 换装可见事件（S-Ⅰ 主口径）：滚动驱动期 + 停滚 2s 窗内换装完成时已在视口的事件计数，分元素类型（行内/块公式/普通代码块/其它）× 分形态 × 十桶位置 | 无独立口径（§2.D 缺口声明——阶段三钉死） | 较本轮基线 **-80% 且密度档 ≤5 次/全程、1MB ≤15 次/全程**（取先达者；1MB 冷区首渲背景底允许残差，未达须归因） | 新建闪刷探针（§5，入 `perf/tmp-r10/`）；产物 `perf/results/r10-phase3-flicker-<dev\|prod>-<场景>-<fixture>-<n>.json` |
| S2 | 已渲染重闪（S-Ⅱ 单列）：teardown→重挂 与 demote→重绘 在视口内可见的换装事件（含离带 >15s/`DEMOTE_DELAY` 后回访重见） | 阶段三钉死 | 密度档 **=0**；1MB 较基线 **-80%** | 同 S1（探针对齐 nodeview 挂载/拆卸/demote 事件流——观测补点见 §2.D） |
| S3 | 高度瞬态（S-Ⅲ）：视口内首次渲染前后块高度差 >8px 事件数 + 每帧 scrollHeight 采样漂移 | R5 曾测高度二象性 81px↔40px、残余 ~450ms 瞬态 | 显著下降（具体目标阶段三填死并写入报告）；**D1 双臂 0 是硬底不得复活** | 探针块高度差分 + scrollHeight 序列 + `cv.relearn` 对齐 |
| S4 | 视口内源码占位峰值/可见时长（T2 口径**按底部三桶单列**——回答"底部聚集"感知是否真实） | peak 10 / durP95 124~130（R9 收尾，同批对照） | **不劣化 >10%**（同批 ABAB）；底部三桶数据单列报告 | `scroll-flash-bench.mjs` 复跑 + 探针十桶 |
| S5 | 观感定性（**用户主观门**）：修复前后分段录屏（CDP screencast 或系统录屏），盲序呈现用户复核 | 无 | 修复后用户复核"底部滚动自然度可接受"——数据门之外必须过观感门（红线 20），未复核不得宣称结题 | 录屏采样 + 用户复核记录入报告 |

### D 组：停滚漂移防回退（R7/R8/R9 硬底，双臂 normal+focus；S-e 类修复最容易复活它）

| # | 指标 | 已知基线（R9 收尾） | 目标 | 测量 |
|---|---|---|---|---|
| D1 | 停滚 10s 窗位移 >4px 帧数 / 程序化写入 / MD-1001/1002 | 双臂密度档 0、1MB ≤9 不劣化（写入全带归因） | **维持**；MD 码维持 0 | `perf/tmp-r7/probe-drift.mjs` 复跑 + r10 探针同口径双采 |

### M 组：完整性（沿承 R6~R9 硬门——禁止砍完整性换观感）

| # | 指标 | 已知基线（R9 收尾） | 目标 | 测量 |
|---|---|---|---|---|
| M1 | 滚动遍历往返 + 静止 10s 后行内公式源码占位残留 | 0（三档） | **维持 0** | R6/R7 探针口径（`perf/tmp-r6/formula-probe.mjs` 规格） |
| M2 | 会话后 10s 泵队列挂起条目 | 0 | **维持 0** | `window.__mathPumpStats` |
| M3 | 视口内块级公式挂载率 / katex-error | 100%（23/23，解题技巧档）/ 0 | **维持 100% / 0**（**S-a 类修复的硬门——挂载策略改动不得漏挂**） | R6 块公式挂载探针口径 |

### T 组：及时性（不劣化 >10%；同批 ABAB 内对照为准）

| # | 指标 | 已知基线（R9 收尾） | 目标 | 测量 |
|---|---|---|---|---|
| T1 | 静止补绘拖尾（quietPhase 占位事件/p95） | 0 / 0 | **不劣化 >10%** | `scroll-flash-bench.mjs` quietPhase 窗 |
| T2 | 滚动中视口源码占位峰值/可见时长 p95 | peak 10 / durP95 124~130 | **不劣化 >10%**（同批对照） | 同上 scrollPhase 窗（= S4 门同源数据，勿重复跑） |

### R 组：防回归（全部零回归；基线为 R9 收尾同机，环境差异须声明）

| # | 指标 | 已知基线 | 测量 |
|---|---|---|---|
| R1 | 1MB 打开（3 轮中位） | 4,565ms | `MDITOR_DOC=1MB node perf/open-1mb.mjs 3 <tag>` |
| R2 | 打字 p95 密度档 / 1MB（g2 口径） | 112ms / 404ms | `MDITOR_DOC=无穷级数_密度档 MDITOR_MIN_BLOCKS=500 node perf/g2-typing.mjs <tag>`；1MB 同法 |
| R3 | 切换中位（20 往返） | 2,010ms | `node perf/switch-bench.mjs --doc-a 无穷级数_密度档 --doc-b 解题技巧_密度档 --viewport off --switches 20 --tag <t>` |
| R4 | 全量守卫 | vitest 990（以实跑为准） | `npm test`（每优化 commit 前）；收尾 `npm run test:coverage` + `npm run lint` + `npm run build` |
| R5 | 历轮门禁复测：ABAB / ghost / R8 上滚对称比 / **R9 focus 对称比与 focus j32（双模式）+ keepwarm CSS 钉** | abab p95 中位 165；ghost 11/+0/0；R8 ≤1.25；R9 F1 ≤1.25、focus j32=0 | `scroll-abab --doc 1MB压测 --viewport on --round 3 --duration 60` + `ghost-stress --minutes 5` + `tmp-r8/probe-jank.mjs` 复跑 + `tmp-r9/prod-focus-jank.mjs --expect-keepwarm`（prod） |

回归判定阈值沿用历轮：**劣化 >10% 且多轮方向一致才算回归**。

## 5. 症状 S：取证设施与可证伪归因路径

- **取证设施（阶段二新建，只加观测不改行为，独立 commit）**：
  - dev 探针 `perf/tmp-r10/probe-flicker.mjs`（蓝本 scroll-flash-bench + tmp-r8/probe-jank：fixture 打开/滚轮驱动/`--scenario` down-slow|down-fast|up-slow|roundtrip|revisit/`--start-depth`）。每帧 rAF 巡视目标元素集，记录每元素状态迁移时间戳（占位→渲染完成、挂载→拆卸→重挂），**换装完成时刻 × 元素 rect 与视口相交状态联合判定**产出换装可见事件；分元素类型选择器（`.mditor-math-inline-lazy` 行内 / `language-LaTeX` 块公式 / 其它 code_block）；十桶位置分桶（复用 R6 posBuckets 机制、新口径）；块首渲高度差分 + scrollHeight 序列 + `__scrollDebug`/`__mathPumpStats`/`cv.relearn` 差分对齐。
  - prod 探针 `perf/tmp-r10/prod-flicker.mjs`（蓝本 `perf/tmp-r9/prod-focus-jank.mjs` 全套加固：预杀残留、单实例转发检测、exe 身份钉、证据先落盘、8s restore 超时；CDP 9224；prod 文件树 `el.click()` 开文档；预热完成自证）。**复现 prod 优先**（§2.C R9 教训），dev 复现为参照臂。
  - 观测补点：code-block nodeview 挂载/拆卸/demote 事件流（`patches/@milkdown+components+7.22.1.patch` 内只加计数出口，如 `window.__blockMountStats`——node_modules 改动只走 patches/，观测独立 commit）。
  - **revisit 场景（S-Ⅱ 专用）**：下滚至目标区 → 静置 16s+（越过 `TEARDOWN_DELAY`）→ 上滚回访——若 S-Ⅱ 成立应稳定复现"已渲染块重闪"。
  - 场景 × 档位矩阵：down-slow/down-fast/up-slow/roundtrip/revisit × 密度档/1MB/prod 真实文档 × 预热完成双态（首开即滚/预热后滚）。
- **归因判据表**（探针数据直接套用；先分形态 S-Ⅰ/Ⅱ/Ⅲ，再归因元素与机制）：
  - 换装可见事件集中块公式/代码块，事件时刻与 nodeview 挂载完成对齐、且快滚场景事件数 >> 慢滚（outrun 指纹：穿越 800px 带用时 < 挂载耗时）→ **S-a 定罪**。
  - 换装可见事件集中行内公式，与泵 deferred/预算耗尽计数同帧对齐，停滚 2s 窗补绘完成事件为主残余 → **S-b 定罪**（与 R6 T1 帧饥饿长尾并案验证，§6）。
  - 换装完成时元素已在视口内滞留 >120ms（渲染并不晚、但过渡期内可见）→ 视觉层问题 → **S-c 定罪**（原型验证：临时移除 120ms transition——原型不合入跑完恢复——S1 计数不变而录屏观感改善即坐实）。
  - revisit 场景稳定复现重闪，事件集中于离带 >15s/`DEMOTE_DELAY` 后重见元素 → **S-d 定罪**。
  - 高度瞬态事件与 `cv.relearn`/`layout:block`/scrollHeight 变化同帧对齐，未学块（首开即滚冷区）显著多于已学块 → **S-e 定罪**；若含"宽度变化后首次进视口跳动"形态 → 直接重开 R9 F-a 归档案（§6）。
  - 十桶分布底部三桶占比显著高于均匀期望（≥2×）→ **S-Ⅳ 坐实**（否则"底部聚集"是感知偏差，报告写明，S1 仍按全视口口径计）。
  - 复现不了的症状必须产出「为何在此环境不触发」的归因（构建/缓存/预热状态/文档差异），不许静默跳过；**dev 复现不了时 prod 探针必须跑完才许下"复现不了"结论**。
- **可证伪句子**（每条先写再动手，§10 第 3 步；证据不成立换下一候选，不许并行改多个）：
  - S-a：若闪刷=频带挂载换装可见，则临时把 IO rootMargin 扩至 2400px（原型开关，不合入，跑完恢复）后块公式/代码块换装可见事件应趋零（换装移到更远的视口外完成）；若不变则 S-a 非主犯。
  - S-b：若=泵预算/帧饥饿，则临时把 `SCROLL_RENDER_BUDGET_MS` 提至 12ms + `SCROLL_HIT_PAINT_CAP` 提至 128（原型不合入）后行内侧 S1 显著下降而帧间隔代价可控；若 S1 不降则非此因。
  - S-c：见判据表（transition 原型对照）。
  - S-d：若=回访重闪，则临时把 `TEARDOWN_DELAY` 与 `DEMOTE_DELAY` 置 +∞（原型不合入）后 revisit 场景 S2 归零；若仍有重闪则另有机制。
  - S-e：若=占位高变现，则首开即滚（未学）与预热完成（已学）同序列对照下 S3 事件数差应达数量级；改用渲染态测高（P3 原型）后 S3 趋零——P3 类改动只出原型数据请拍板。

## 6. 与历轮遗留案件的交叉声明

- **P3 提案（预热批渲染态测高，R5 留档、R8/R9 两次呈报待拍板）**：S-c/S-e 定罪时修复方向与 P3 同属高度表保真度——拍板材料（R8 报告 ⑤：冷区队列膨胀 3,310、每帧 layout 67ms、预期 p95 199→~130）一并呈报，可并案可分案，**不得静默夹带**。
- **R6 T1 帧饥饿长尾遗留**：S-b 定罪时并案验证（长 rAF 间隙 ↔ 换装堆积的时间对齐），一次修复双门复测（S1+T1）。
- **R6 M-f update() 绕泵竞态（未取证）**：若本轮取证撞见按 R6 §6 路径处理，不预改。
- **R9 F-a 宽度陈旧归档案**：S-Ⅲ 形态含"宽度变化后首次进视口跳动"→ 按 R9 报告 ⑤ 重审条款直接重开（代码事实 §2.B S-e 已列），勿当新发现重查。
- **R5 J-α''（+32s 未打标整千跳变，未定罪）**：维持不并案，除非 writeTrap 直接捕获。
- **R8 冷区首渲布局墙 / R6 T3 首开争用窗**：1MB 绝对强度背景底——本轮 S1 的 1MB 门允许其残差（未达须归因），不得宣称"解决 R8 遗留"；修复波及预热/学习窗时须附差分先于合入。
- **口径声明（防混谈）**：症状 S（换装可见）≠ R5 乱闪（残留回弹）≠ R6 T（及时性）≠ R9 F（掉帧）——四个切面机制可同源，交叉数据支持时合并归因，但门禁各自记分不得互抵。

## 7. 执行阶段（各自成阶段，顺序推进；凭实测可重排，报告说明理由）

沿用第五~九轮：直接执行、阶段门禁自查后才进下一阶段。

- **阶段一：版本核实 + 形态学定界**。核实用户安装构建（ProductVersion 5.0.1-beta + keepwarm CSS 身份门）与 main 同源；向用户回填【填写】空位（典型文档名/方向速度/模式/滚轮触摸板/预热状态）并请求一段症状录屏（形态学第一手证据，S5 基线）；生产日志复析定位高发文档与时段（辅助性）。
- **阶段二：复现与探针建设（只加观测不改行为，独立 commit）**。建 dev/prod 双探针 + nodeview 观测补点；**prod 优先复现**（真实文档 × 场景矩阵），dev 参照；至少一档文档探针捕获非零换装可见事件才进阶段三；复现不了按 §5 归因说明并升级用户现场取证。
- **阶段三：基准**。S1~S5 + D1 + M/T/R 对照全口径基线（prod/dev 双环境、预热双态），填死门禁表基线列与 S3 目标值；产物落 `perf/results/r10-phase3-*.json`。
- **阶段四：归因（禁盲改）**。按 §5 归因判据表逐候选定罪/排除（先分形态再归因机制，原型对照按可证伪句子执行且跑完恢复），产出归因结论 `perf/results/r10-phase4-attribution.md`（每条附证据文件与数据）；未定罪不许进修复。
- **阶段五：分批修复（Fix-A/B/C…）**。按定罪排序分批，每项独立 commit（hash+file:line+复杂度+回退开关）、附新增单测、ABAB 交错 ≥3 轮（臂序双向）；拍板项（`TEARDOWN_DELAY`/IO 频带/挂载形态/过渡视觉/P3 类）只出原型数据请用户确认后合入。
- **阶段六：全量门禁 + 打包冒烟 + 用户观感复核 + 报告**。S/D/M/T/R 全表复测（prod 为主）+ 重建安装包实机断言（S1 主门 prod 复测 + R9 双断言沿承：focus j32=0 ×3 臂 + 停滚漂移双臂 0 + `--expect-keepwarm`）+ S5 盲序录屏用户复核 + 报告与文档更新（§11）。

## 8. 创新算法条款（若引入新调度/补偿/预算/挂载机制）

复杂度分析（时间/空间，按视口内条数 n 与全文档 N 表达）+ 三规模档实测（密度档/1MB/prod 真实文档）+ 原型先行（脚本级/原型开关验证再落地，跑完恢复）+ 降级开关（新策略可一键回退旧路径）+ 1,000 次随机编辑差分（新旧行为等价性，渲染结果与最终 scrollTop 逐条比对）+ **挂载形态类改动加录屏帧序列对比**（观感等价性证据）。不满足任一条不合入。

## 9. 红线（编号沿承历轮 + 本轮增补）

1. 未经用户拍板不得改默认值（含 `SCROLL_QUIET_MS`/`SCROLL_RENDER_BUDGET_MS`/`FORWARD_BAND_PX`/`SCROLL_HIT_PAINT_CAP`/`PREWARM_USER_YIELD_MS`/`DEMOTE_DELAY`/`IO_MARGIN`/`BLOCK_WINDOW_MS`/`BLOCK_WALK_WINDOW_MS`/`BLOCK_WALK_IDLE_MS` 及 nodeview 侧 `TEARDOWN_DELAY` 等常量）、不得重引入 bigDocViewportAuto。
2. 已证伪路线勿重走（§3 证伪链，含 R9 五条负结果——位置混杂口径禁用、快滚小样本禁判）。
3. 默认档（非 cv 档）急切渲染定案勿改；减配档关公式是既有决策，非本轮靶。
4. KaTeX 0.18.4 单实例钉住不动（package.json overrides）；不引入新渲染引擎；`src/lib/mathConfig.ts` 宏语义与单一来源不动。
5. R5 Fix-A/B/C/D、R6 Fix-A/B/C、R7 Fix-A/B、R9 Fix-A 不得破坏：`md1011-regression.test.ts`、`cvMemory.test.ts`、`lazyInlineMath.test.ts`、`scrollDebug.test.ts`、`focusKeepwarm.test.ts` 既有用例全绿且不跳过。
6. node_modules 改动只走 `patches/`。
7. 每优化 commit 前 `npm test`；收尾 `test:coverage` + `lint` + `build`。
8. 先测后改六步（§10）；一次一项；ABAB 交错 ≥3 轮；达不到假设就回滚。
9. 观测补点（探针/计数/采样窗，含 patches/ 内观测出口）与行为修复分开 commit。
10. perf 硬清理只杀自 spawn 的 dev/prod PID 树（`taskkill /IM` 误杀教训）；tmp 脚本入 `perf/tmp-r10/` 并头注"不入库"。
11. 不改测量口径；fixture 只许改生成参数不许改测量逻辑。
12. 四层补偿链（viewportAnchor/prewarm-comp/anchor-comp/overflow-anchor 禁用）与 smoothJump 互斥旗标无归因证据不动。
13. 不得以关停静止补绘、关停预热、砍公式完整性或及时性换取任何指标归零——M1/M2/M3 是硬门，T1/T2 劣化 >10% 即回滚。
14. anchor-comp 兜底层不得无证据整体拆除。
15. 不得以复活 R7 停滚漂移换取观感——D1 双臂 0 是硬底。
16. 专注模式视觉设计与交互形态不动（R9 红线沿承；keepwarm 机制与测试守卫不动）。
17. 不得把正常模式改坏拉平任何对称性（R9 红线沿承，适用两模式一切对照）。
18. 高度表宽度失效策略不得引发全量重预热（重蹈 1MB ~45s 预热主线程墙直接否决，须增量/分批并过 §8）；诊断税修复只许节流让路不许砍观测能力。
19. **（本轮增补）块公式挂载/拆卸策略（`TEARDOWN_DELAY`、IO 频带半径、挂载形态）属拍板项**——只出原型数据请用户拍板后合入；M3 挂载率 100% 是硬门；**不得以"永不拆卸/全文档常驻挂载"硬顶内存换零闪刷**。
20. **（本轮增补）换装视觉过渡策略（120ms opacity、占位样式）改动须附录屏/帧序列对比原型数据并过 S5 用户观感复核**——"自然度"是观感命题，数据门之外必须过主观门；不得以"直接去掉过渡"制造更生硬的跳变而不经拍板。
21. **（本轮增补）不得以拆除 cv 档懒渲染架构（懒挂载/渲染泵/预热/高度记忆）或全量急切渲染换零闪刷**——那是 R4~R9 成果的承重结构（重蹈 1MB 主线程墙）；修复方向是把换装移出可视区/消除可见性，不是取消懒加载。

## 10. 先测后改六步（每个修复项逐一过）

1. 基线：改动前跑该门禁指标 ≥2 轮取中位；
2. 定位：探针/观测数据指到具体代码路径（file:line）；
3. 可证伪假设：写成"若改 X 则指标 Y 应变化 Z%"的句子；
4. 单项改动：只改这一处，commit 独立；
5. ABAB 交错：改动/基线 A/B/B/A ≥3 轮，方向一致才算数；
6. 保留或回滚：达标保留并记录，不达标回滚并留档（负结果同样写入报告，防重走）。

## 11. 交付物

- 报告 `mditor/docs/large-doc-bottom-flicker-report.md`，六节体例：①基线声明（HEAD/环境/用户构建核实/录屏与【填写】回填/fixture）；②归因结论（S 候选定罪/排除表 + 形态学分布（S-Ⅰ~S-Ⅳ 各占比）+ 元素类型分布 + 十桶位置结论（S-Ⅳ 判定），附证据与探针产物路径）；③改动清单（每项 commit hash + file:line + 复杂度 + 回退开关）；④门禁全表（S/D/M/T/R 逐行基线→结果，未达项附归因不许留空）；⑤遗留与放弃（含 P3 拍板联动结论、负结果留档）；⑥文档更新清单。
- 文档同步：`mditor/docs/performance.md`（第十轮节：换装可见口径、归因结论与权衡）、`mditor/docs/dev-anomaly-codes.md`（若新增观感类观测口径须登记）、`mditor/CHANGELOG.md` Unreleased 节、memory 日记更新。
- 测量产物：`perf/results/r10-*.json`（tag 命名 `r10-phase<N>-flicker-<dev|prod>-<场景>-<fixture|other>-<n>`）；`perf/tmp-r10/` 一次性探针（不入库惯例，实际历轮均随 commit 入库）；S5 录屏证据归档路径写入报告。
- 发版：本轮不发版；发版节奏（含 5.0.1-beta 是否转正）由用户另行决定。
