# 提示词：公式块「首次滑到必闪刷」修复——输入全类型预挂载收口（R13 轮）

> 用法：将本文件全文作为任务提示词投喂给编码 agent（如 ZCode / Claude Code），在 `mditor/` 项目根目录下执行。
> 前置阅读（动手前必读，防重走）：
>
> - `docs/large-doc-reveal-flicker-scroll-perf-report.md`（R11：块级预挂载 E-a 原型、换装可见口径、"第一次三态"分类）
> - `docs/large-doc-upscroll-coldblock-flicker-report.md`（R12：上滚冷块首挂 + premount-comp 同步补偿 + recheck 链，含二段根因）
> - `src/lib/blockPreMount.ts` 头注（R11/R12 全部机制与红线）+ `src/lib/lazyInlineMath.ts` 头注（行内侧 Fix-A 同款"滚动输入驱动"纪律）
> - `docs/large-doc-scroll-stability-report.md`（anchor-comp 两帧确认制与 scrollDebug 观测口）
> - `docs/r11-decision-materials.md`（bandPx 800 / perFrame 1 / 默认开启的拍板来历）
> - 探针模板：`perf/tmp-r12/probe-upscroll.mjs`，历史基线 `perf/results/r11-*`、`r12-upscroll-*.json`

---

## 一、角色与任务

你是 **mditor**（Tauri 2 + React 18 + Milkdown 7 + Vite 5，Windows/WebView2 优先）大文档滚动性能专项的负责人。R10→R12 已把块级公式（Crepe 把 math 改写为 `code_block(language:"LaTeX")`，占位 pre → CodeMirror+KaTeX 换装）的首挂闪刷治理到「wheel/touch 驱动 + 慢滚」场景实测零可见（R12 主门：换装可见 3→0、大位移帧 4→0、premount-comp 4/4）。但用户终检仍在复现：

> **症状原话（2026-11-08）**："第一次滑动到公式块时肯定公式块刷新"，"不够无感"，要求 **"提前刷新渲染好"**——公式块应在滚到它之前就渲染完毕，首次到达即成品，绝不看到占位→成品换装。

你的任务：**先归因、后修复**，把「首次滑到公式块必闪刷」的残余路径找全并收口。目标语义一句话：**任何输入方式下，公式块首次到达视口前已完成挂载换装**（占位→成品换装不允许发生在视口内或浏览器预渲染窗内）。

## 二、已知格局与残余嫌疑（阶段 0 逐一定罪/排除，勿跳过归因）

R12 已修好且不许翻案重查的：wheel/touch 驱动的预测带扫描（bandPx 800 + stepMargin）、上滚冷块首挂 premount-comp、recheck 链、防护三重门（漂移/超限/越界）、anchor-comp 兜底。R12 实测 down/up 慢滚 6000px 换装可见均为 0——用户仍见闪刷，说明残余在**未被覆盖的路径**。嫌疑按优先级：

- **H1 输入盲区（最大嫌疑）**：`blockPreMount.ts` 只挂 wheel/touchmove 驱动 sweep——**滚动条拖拽、PgDn/End/方向键、目录/大纲跳转、查找定位、打开文档恢复上次位置**等程序化滚动完全不触发 sweep，冷块只能走 IO 原路径；cv 档下 IO 派发被布局延迟（R10 S-a/S-g 机制），挂载完成落进视口 = 必闪刷。"第一次滑到肯定刷新"与此形态高度吻合。
- **H2 快滚残差**：R11 E1 down-fast 16→1（旧门 -80% 且 ≤2 放行）——fast flick 下仍有可见换装；perFrame=1 限速在多块连续进带时追不上滚动速度。
- **H3 档位门**：预挂载只在 cv 档大文档武装（`setBlockPreMountEnabled(isBigDocCv(seed))` + sweep 内 `host.dataset.big` 早退）——非 cv 档文档全靠 IO rootMargin 800px，主线程忙时 IO 回调迟到即视口内挂载。需确认用户复现文档落在哪一档（体量/公式密度判据见 `src/lib/memory.ts:163`）。
- **H4 开篇首滚窗**：打开 → 恢复位置 → cv 变现批 → 用户第一下滚动之间，无轮输入则 sweep 不动，首个到达的冷块闪刷（"第一次"可能特指开篇后的第一滚）。
- **H5 版本核实**：确认用户手上安装包含 R12（CHANGELOG"未发布（前批次）"节 + 实包行为探针），排除"旧包旧行为"假阳性。

## 三、文件地图（已探明，直接引用）

- `src/lib/blockPreMount.ts`——块级预挂载主体：wheel/touch hook、rAF sweep、预测带、perFrame 限速、premount-comp/recheck、stats（`__blockPreMountStats`）、开关 `window.__blockPreMountCfg`。
- `src/hooks/useMilkdown.ts:716,1246`——`setBlockPreMountEnabled(isBigDocCv(seed))` 挂钩位点（实例创建 + 载入）。
- `patches/@milkdown+components+7.22.1.patch`——补丁侧：IO rootMargin 800px、`__codeBlockPreMount` 受控触发器（cancelTeardown + initializeCodeMirror，幂等）、`dataset.mnt` 标记、teardown 观测 tap。
- `src/lib/lazyInlineMath.ts`——行内侧 Fix-A 预测式扫描（若 H1 定罪，须评估行内是否有同款输入盲区）。
- `src/lib/scrollDebug.ts`——anchor-comp 两帧确认、`noteScrollWrite`/`scrollCount`、OVERLAP_INTRUDERS。
- `src/lib/memory.ts`（isBigDocCv）+ `src/hooks/useMemoryGuard.ts`——档位判据与内存守卫（idle 预挂预算设计必须 consult）。
- `src/lib/cvMemory.ts`——cv 档预热（startCvPrewarm / prewarm-comp 同步化纪律）。
- `perf/scroll-abab.mjs`——ABAB 测量电池；`perf/tmp-r12/probe-upscroll.mjs`——探针模板。

## 四、修复方案（分阶段，每阶段一个 commit + 简报）

### 阶段 0：归因探针（先行，产物是证据不是代码）

- 扩展探针/电池，新增输入臂：**滚动条拖拽**（CDP Input 合成或 host scrollTop 步进）、**PgDn/End 键**、**目录跳转后慢滚**、**打开→首滚**、**wheel fast**（复测 R11 down-fast 残差）。每臂记录 R10 口径：换装可见 / 首挂落入视口 / anchor-comp 次数 / 大位移帧。
- 对 H1–H5 逐条给定罪/排除结论与数据。若归因与 §二 完全吻合可并档直入阶段 1；有偏差先呈报再动手。

### 阶段 1：输入全类型预挂载（主线——用户拍板方向"提前渲染好"）

- **驱动源扩展**：保留 wheel/touch 的同时挂 host scroll 事件（或等价全输入信号）驱动 scheduleSweep——所有输入类型统一走同一条预测带路径；滚动方向与步进取 scrollTop 差分，stepMargin 语义对齐现有 noteStep。
- **无输入闲置兜底**：载入完成后（cv prewarm 之后）以 rAF/idle 限速扫描，把预测带内冷块逐帧清零（预算：单帧挂载累计耗时 <8ms，帧间让路；与 useMemoryGuard/teardown 预算协同，防常驻 CodeMirror 实例膨胀——预算策略写进头注）。开篇场景（恢复位置、初始视口 ±band）由此天然覆盖（H4）。
- **限速自适应**：perFrame 放宽为"帧预算内尽量多挂"（挂满 8ms 或 perFrameMax 即停），消除快滚追不上形态（H2）。
- **抢修禁令维持**：视口内冷块仍不抢修（换装必然可见，预挂的目标是"永远早于到达"）；若归因证明存在结构性到不了的场景（如跳转落点视口内冷块），单列"打开即渲染"例外口径并在报告记录。
- 若 H1 定罪，评估行内侧 lazyInlineMath 同款盲区：同修或另立（写明理由）。

### 阶段 2：非 cv 档武装与门重审（视 H3 归因）

- 用户复现文档若在非 cv 档：重审 isBigDocCv 门——小档块数有限、sweep 开销 O(块数)/帧，评估直接武装或按块数阈值分档，附帧代价实测。
- 若 cv 档即全貌：降级为"门重审结论留档"，不扩面。

### 阶段 3：验证与结题

- 主门见表 §六；基线臂（`window.__blockPreMountCfg={on:false}`）记录旧值对照。
- 交付 R13 报告 `docs/large-doc-first-scroll-formula-flash-report.md`（沿用 R12 报告骨架：归因实锤链 → 改动清单 → 门禁表 → 遗留）、CHANGELOG 条目、探针产物 `perf/results/r13-*`。

## 五、硬约束（红线，违反即返工）

1. 挂载永不在 wheel/scroll/IO 回调内同步执行——rAF/idle 纪律（红线 17 沿用）。
2. anchor-comp / premount-comp 兜底链与防护三重门原样保留；新路径补偿语义对齐 R12 同步化纪律（补差在 paint 前提交）。
3. ABAB 开关语义保留：`__blockPreMountCfg={on:false}` 必须回到 IO-only 旧行为供基线臂；stats 字段只增不破（历史探针/基线对照兼容）。
4. 不引入新依赖；补丁侧改动须再生成 patch 并清 `node_modules/.vite`（R11 执行事故教训）；Git Bash 下 taskkill 须 `cmd //c`。
5. teardown/内存守卫语义不被 idle 预挂破坏：预挂 ≠ 永挂，常驻实例数上限与预算策略落实并写进头注。
6. 阶段 0 归因结论先落报告再动修复；R12 报告"与既有水位的关系"段（±4~28px 结构性小位移非本轮引入）不许翻案重查。

## 六、验收标准（门禁表，全达标才可结题）

| # | 门 | 判定 |
|---|---|---|
| G1 | 换装可见（R10 口径） | 全输入臂 × up/down 双向 = **0** |
| G2 | 首挂落入视口（dataset.mnt 无→有那帧与视口相交） | 同上 = **0** |
| G3 | M3 挂载率 / katex-error | 100% / 不新增 |
| G4 | 帧代价 | P2 ±10% 内；单块挂载耗时不劣化 |
| G5 | 位移水位 | R12 ±小位移帧不劣化；大位移帧（\|px\|≥46）= 0 |
| G6 | 内存 | useMemoryGuard 门不回归 + 常驻挂载数实测留档 |
| G7 | 测试 | vitest 全绿（新增：scroll 驱动 / idle 兜底 / 自适应限速 / 默认关零行为）+ tsc / eslint / build 绿 |
| G8 | 文档 | R13 报告 + CHANGELOG + 探针产物齐 |
