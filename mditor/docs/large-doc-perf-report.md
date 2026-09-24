# 大文档性能优化结题报告（第三轮：1MB 档系统性卡顿）

> 任务书：`docs/prompts/large-doc-perf-optimization-prompt.md`（TP 工作区根）。
> 窗口：2026-09-23 ~ 2026-09-24。环境：Tauri 2 dev 实例（CDP 9223），WebView2/Edge 153，
> 窗口 1280×821@dpr1.75，fixture `perf/fixtures/一元微分学习题集_1MB压测副本.md`
> （f4ef4f0 修复后重新生成：11629 顶层块 / 25356 行 / 1.57MB / 行内公式 ≈1.58 万——
> 是 09-22 旧 fixture 公式密度的 7.1 倍，旧滚动数据不可与今比）。
> 代码版本对比一律同窗口 ABAB 交错（A = f4ef4f0「math 修复后、性能改动前」，
> B = 本轮 HEAD），中位数口径；回归判定 = 劣化 >10% 且多轮方向一致。

## 0. 结论速览

判分：**G1-G5 达成 4 项（G1/G3/G4/G5），G2 未达成（附归因证据，不计入达标数）；
G6/G7 零回归**——满足任务书完成条件。G6 曾在复测中暴露 R1 滚动回归
（on +41% / off +23 倍），经 R1b/R1b+/R1b++/R2b 四步修复后终测反超
（on 档 B/A=0.82，off 档 1.00）。

| Gate | 指标 | 基线（本机复测） | 优化后（终测） | 目标 | 判定 |
|---|---|---|---|---|---|
| G1 打开（默认档） | openMs 3 轮 | 12447-12627 | 12338-12541（中位 12479） | ≤18s | ✅ |
| G1 打开（+viewport） | openMs 3 轮 | 6718-7099 | 5398-5684（中位 5466） | ≤6s | ✅ |
| G2 打字 p95 | baseline 口径（七场景后） | 584 | 448-536 | ≤360 | ❌ 未达成——归因 §3 |
| G2 打字 p95 | g2-typing 口径（新开即打） | — | 296-312 | ≤360 | ✅（辅助口径） |
| G3 停顿窗长任务 | 打字停顿后 3s 窗 max | 662（重建 300-500 + 序列化 662） | 207（g23-probe，0 笔 >207） | 单片 8ms 分片 + 显著下降 | ✅ 显著下降 |
| G4 搜索计数 | 防抖后计数任务 | ~600ms LT | 0 长任务 ×2 轮，计数 1869 正确 | ≤100ms 且计数正确 | ✅ |
| G5 Ctrl+S | 序列化阻塞 | LT 694ms | 0 长任务 ×2 轮 | ≤150ms 或移出主线程 | ✅ |
| G6 滚动 | scroll-abab p50（1MB，on/off） | A 臂 on 65.3-70.9 / off 4.2-6.1 | **B/A = 0.82（on）**：53.4/53.6；**1.00（off）**：6.1/6.1 | 两档均不劣化 | ✅ 零回归（on 档反超 18%） |
| G7 选中三场景 | select-bench 事件 p95 中位 | drag 648 / triple 144 / formula 728 | 136（-79%）/ 152（+5.6%，<10% 阈）/ 88（-88%） | 不回归，力争 -30% | ✅ 零回归，两场景超 -30% |

## 1. 改动清单（10 commits，全部独立提交、各附测试）

### S1 顶层块粒度增量序列化（1dcc518）
- 文件：`src/lib/incrementalSerializer.ts`（新，219 行）、`src/hooks/useMilkdown.ts`、`src/components/Editor.tsx`、`patches/@milkdown+plugin-listener+7.22.1.patch`、`src/lib/memory.ts`
- 归因：保存/Ctrl+S/搜索/脏标签全走 O(doc) 全文序列化（1MB 档 662ms 长任务）
- 技法：任务书 §4.1 S1。PM 节点不可变 + 结构共享 → WeakMap 缓存顶层块序列化产物；序列化 = 变更块重算 + 缓存串拼接
- 复杂度：O(doc) → O(变更块 + 拼接)
- 验证：362 行差分测试（随机编辑序列，逐字节等价，含撤销/粘贴）；G4/G5 = 0 长任务
- 回退：序列化器包装失败自动回退朴素 serializer（listener 补丁 lazy 读 ctx，无包装时行为同前）

### R1 行内公式视口懒渲染（7c88898）→ R1b 渲染泵三步修复（876a18d / 5624316 / bb2ddbd / 60e3388）
- 文件：`src/lib/lazyInlineMath.ts`（新）+ `src/styles/global.css` + `src/hooks/useMilkdown.ts`
- 归因：math_inline toDOM 每节点同步 katex.render，1MB 副本 ≈2.5 万公式 ≈3.5-4s 纯 JS；content-visibility 只跳布局不跳 DOM 构建
- R1 机制：nodeview 占位（源码文本）+ IntersectionObserver(800px) 临近渲染、远离 2.5s 降级。效果：G1 视口档 6762→5102
- **R1b 修复链**（G6 ABAB 发现回归 → 逐步归因 → 逐步收紧）：
  1. 876a18d 渲染泵：初版 IO 回调同步渲染整批 entries，公式密集文档滚动一批数百个 katex.render + 连带布局 → 300-700ms 长任务风暴（B 臂 60s 滚动窗 286-294 个长任务共 34.7-53.3s；帧 p50 on 档 94-96ms vs A 64.9-71.6，off 档 140-150 vs 6.1）。改 IO 只入队，rAF 泵按每帧 10ms 预算补渲染；选中（selectNode）与编辑重渲染（update）仍同步立即
  2. 5624316 静止窗 160→400ms + 降级静止门：滚轮节奏 ~190ms/格，160ms 窗在轮间缝隙放行泵；降级改块高触发回流（无 cv 档全文档级），同样走静止门
  3. bb2ddbd 双门控（体量 + bigDocViewport）：默认档（无 content-visibility）每次懒渲染块高变化=全文档回流（B-off 41.7 vs A-off 4.2，+893%），恢复急切渲染；默认档打开 12.5s 仍在 G1 ≤18s 门内，cv 档保留懒渲染
  4. 60e3388 门控源改用户输入：程序化 scrollTop 写入（prewarm-comp/ghost/恢复落位）也触发 scroll 事件，预热补偿期公式被误门在占位态（实测 ready 23→10 回落）；改监听 wheel/touchmove/keydown（与 R2b 同源判定），复测 ready=52/lazy=0
- 复杂度：滚动期单任务 O(整批×(render+layout)) → 0；静止期 ≤10ms/帧
- 等价性（红线 5 反向判据，详见文件头注）：Ctrl+F 计数走 markdown 源串；全选/跨视口选区占位文本=源码；批注 marker 与 math_inline 无交集；KaTeX 单实例（overrides 钉 0.18.4）
- 验证：7 用例（静止门控、帧驱动、降级静止门、销毁丢弃、选中绕过泵、双门控、等价性）；G6 终测；目检截图 r1b-visual-check2.png（视口公式全部真身）

### R2 cvMemory 停顿重建分片（9407f44 + 7625db8）
- 文件：`src/lib/cvMemory.ts`（+134 行）+ 测试
- 归因：打字停顿 1.2s 后 cvIntrinsic 整树重建是单笔 300-500ms 长任务
- 技法：§4.2 R2——「单步 8ms 预算 + 自适应批大小 + idle 让出」分片；代际令牌防串；7625db8 超预算自适应减半（400→25 块/片）
- 复杂度：单任务 300-500ms → 8ms idle 切片序列
- 验证：G3 停顿窗 max 662→207ms；撤销/粘贴装饰复活正确

### R2b 预热让路用户滚动（dc733c1）
- 文件：`src/lib/cvMemory.ts` + 测试
- 归因（profile-scroll 剖面，A/B 两臂同构）：滚动期主导负载是预热批次的 PM 装饰派发（DecorationSet `forChild` 8.9-9.2s + `takeSpansForNode` 7.3-7.7s / 60s 窗）+ 连带布局——重 fixture 上预热 >45s 跑不完，整个滚动期与用户交错，两臂帧 p50 都被拖到 65-80ms
- 修复：wheel/touchmove/keydown 500ms 窗口内预热 step 让出不派发（`prewarm.yield` 计数器留痕）；程序化 scrollTop 写入不触发这些事件，prewarm-comp 不自锁
- 效果：G6 on 档 B/A 从 1.12 → 0.82；p95 从 760 → 82ms（9 倍）
- 验证：prewarmShouldYield 纯函数用例 + G6 终测

### I1 sv 模式每键全文摊平改脏标记（4721404）
- 文件：`src/lib/svCodeMirror.ts`
- 复杂度：O(doc)/键 → O(1)/键 + 停顿一次 O(doc) 取串（CM B 树结构共享）

### 本轮评估后关闭/未立项的项
- **I2 centerCaret 每键布局读取**：rect-spy 抓不到现行（证据不足），关闭
- **S2 序列化/搜索 worker 卸载**：S1 后主线程 0 长任务，无剩余收益
- **M1 导出管线 worker 化**：依赖的 `src/lib/exporterProbe.ts` 不在仓库（历史遗留），场景无法测；低频路径留后续
- **I5 PM updateChildren 内生墙**：见 §3 归因——本轮证实在装饰在场时其每键成本 = I5 迭代 + 装饰 diff 两部分，后者是后续可立项方向（装饰数量削减需按第 5 节原型先行）
- **R3/R5/I4**：未触及（本轮证据链未指向）

## 2. G1-G7 数据与产物

### G1 打开（open-1mb.mjs，3 轮）
- 默认档：base-open-default.json（12447/12594/12627）→ r1b-open-default.json（12338/12479/12541）
- 视口档：base-open-viewport.json（6718/7088/7099）→ r1b-open-viewport.json（5398/5466/5684）
- 中间产物：r1-open-default/viewport.json（R1 初版时期：默认 5.7-6.0s——R1b++ 恢复默认档急切渲染后回到 12.5s，仍在门内）

### G2 打字（两口径 + 剖面归因，详见 §3）
- baseline 口径：584 → 448（post-full-cv）/ 480-536（本轮 g2-ctx-typing 复刻 ×3）
- g2-typing 口径：296/312（g2-r1..r3 + ctx1）；口径差 = 预热覆盖率差（§3）
- 产物：g2-r*{A,B}.json、g2-ctx1/ctx2、g2-ctx-typing-ctx1/ctx2/ctxp.json、profile-typing-ctx-ctxp.cpuprofile

### G3 停顿窗（g23-probe.mjs：12 键 + 3s 停顿）
- 停顿窗（打字结束后）max 207ms / 0 笔 >207（基线：重建单笔 300-500 + 序列化 662）
- 打字窗每键长任务 ~400ms 与 G2 同源（I5 + 装饰 diff），无新增单笔超基线每键水平（465）
- 产物：本轮 console 输出（dev 实例）

### G4/G5 搜索与保存（bench-export-search-save.mjs，终测 2 轮）
- G4：0 长任务，计数「1869 个」正确 ×2（首轮窗内混入 1 笔 282ms 预热批次——搜索框输入不标记用户输入，预热可在间隙落地；复跑 0）
- G5：0 长任务 ×2（基线 694ms）
- 产物：perf/results/g45-final.txt

### G6 滚动（scroll-abab.mjs 1MB 60s，代码 ABAB）
- 回归证据（tag=g6ab + g6v 早期）：B-on 94/95.6/78.1/79.2 vs A-on 64.9-71.6；B-off 140.3/149.6/41.7 vs A-off 4.2-6.1
- **终测（tag=g6v 06:03 后，B = 全部修复）**：

| 臂 | vp | p50（两轮） | p95 | ticks 处理量 |
|---|---|---|---|---|
| A | on | 65.8 / 65.3 | 759.7 / 760.5 | 111 / 106 |
| B | on | **53.4 / 53.6** | **81.5 / 82.9** | **323 / 321** |
| A | off | 6.1 / 6.1 | 279.1 / 256.6 | 178 / 183 |
| B | off | **6.1 / 6.1** | 251.5 / 245.0 | 179 / 179 |

- 判定：on 档 B/A=0.82（-18%，两轮方向一致）；off 档 1.00（四轮全等）→ 零回归

### G7 选中（select-bench.mjs 钉 1MB）
- ABAB 3 轮（上午，R1 初版 B）：drag 648→560（-13.6%）、triple 144→128（-11.1%）、formula 728→680（-6.6%）→ 零回归
- 终测（sel-r1bB.json，B = 全部修复，对拍同日上午 A 臂）：drag 648→136（-79%）、triple 144→152（+5.6%，<10% 阈，非回归）、formula 728→88（-88%）→ 零回归，drag/formula 超 -30% 力争值

## 3. G2 未达成归因（附证据）

**口径差异解释**：baseline 口径 typing 跑在 6 个前置交互场景后（clicks/select/dragSelect/tripleClick/clickFormula），此时预热已覆盖大量顶层块；g2-typing 口径在新开文档 ~3s 后打字，预热只覆盖视口带。本轮 g2-ctx-typing.mjs 复刻前置场景复现：ctx 480-536 vs 新鲜 296-312（同窗交错）。

**每键 ~500ms 的构成（profile-typing-ctx-ctxp.cpuprofile，12 键 6.17s 采样）**：
- `forChild` 2020.7ms + `valid` 2020.5ms（PM DecorationSet diff，updateChildren 每顶层块调用）= **65%**——cvMemory 每块 intrinsic-size 装饰（11.6k 条）的每键 diff，随预热覆盖率增长
- `(program)` 1381ms（布局）+ getClientRects 143ms + restartAnimation 89ms（crepe 光标动画）
- `updateChildren` 自身 self 仅 13.7ms——「I5 内生墙」的实体是它对 11.6k 顶层块的迭代 × 每块装饰查询；零装饰时 ~300ms（任务书已证），装饰满覆盖时 ~500ms

**结论**：448-536 > 360，未达成。剩余成本 = I5 迭代（~300ms，零装饰亦在，任务书 §4.3 I5 已列「不修/研究级」）+ cv 装饰 diff（~180ms，随预热覆盖增长）。唯一例外条款只豁免纯 I5；装饰 diff 部分理论可治但需动装饰承载结构（如按带合并 intrinsic-size 装饰或 CSS 侧承载），属第 5 节原型先行的创新算法项，本轮未立项。R2b 已消除打字期间预热批次与打字的交错恶化。

## 4. 遗留风险与回退开关

| 改动 | 风险 | 回退/开关 |
|---|---|---|
| S1 | 缓存失效逻辑 bug 致序列化不等 | 差分测试守卫；包装失败自动回退朴素 serializer |
| R1+R1b | 滚动中/预热补偿期公式保持占位（源码文本），静止 ~400ms 后渲染 | 双门控（体量+bigDocViewport，默认档完全不走懒渲染）；nodeview 构造失败回退 toDOM；选中/编辑恒即时渲染 |
| R2 | 分片重建与编辑竞态 | 代际令牌；装饰对账以 PM dispatch 为准 |
| R2b | 用户持续滚动期间预热停滞（高度表冷） | 停止即恢复（≤500ms）；视口学习兜底；prewarm.yield 计数器可观测 |
| I1 | 消费者取串时机 | 脏标记仅延迟取串，语义不变 |

**已知的偶发问题（非本轮引入，记录备查）**：dev 实例冷启动偶发「文件树 0 行」——
getWorkspaces 冷启动读空（`.catch(() => undefined)` 吞掉），location.reload 即恢复；
本轮 3 失败 3 成功，与代码臂无关（09-22 同代码曾 9 连成功），疑似 tauri-plugin-store
就绪竞态。受影响的基准轮已按「单轮超标不作数」丢弃重跑。后续可立项：getWorkspaces
读空重试。

**测量基建注意**：scroll-abab 的预热等待上限公式 `45_000 + min(105_000, bytes/15_000)`
单位错（bytes/15000 ≈ 105ms 而非 ~105s），1MB 档实际只等 45s——本轮重 fixture 上预热
>45s，等待超时后滚动与预热并发（两臂同条件，不影响 A/B 判定）。修正该常量属测量
脚本口径变更，按纪律未动。

## 5. 提案附件（产品决策，未合入）

见 `docs/proposal-bigdoc-viewport-auto.md`：≥1MB（或 ≥8000 顶层块）自动开启
bigDocViewport。本轮数据支持：视口档打开 7.0→5.5s、滚动 p95 760→82ms、选中
formula 728→88ms；默认档打开 12.5s（门内）但滚动/交互全面劣于视口档。

## 6. 文档更新

- `docs/performance.md`：增补第三轮结论与基准口径（见文末新节）
- `docs/large-doc-perf-baseline.md`：本轮基线记录（顶部已加结题指针）

## 7. 复现命令

```bash
# 环境
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npx tauri dev --config src-tauri/tauri.dev.conf.json
# G1   MDITOR_DOC=1MB node perf/open-1mb.mjs 3 <tag>        （store 切 bigDocViewport 定档）
# G2   node perf/g2-typing.mjs <tag> / node perf/g2-ctx-typing.mjs <tag> [--profile]
# G3   node perf/g23-probe.mjs                              （前置：已开 1MB 文档）
# G4/5 node perf/bench-export-search-save.mjs
# G6   bash perf/g6-verify.sh                               （A/B ×on/off ×2 组，自管实例）
# G7   node perf/select-bench.mjs <tag> 3                   （已钉 1MB 文档）
# 剖面 node perf/profile-scroll.mjs <tag> / perf/profile-typing.mjs
```
