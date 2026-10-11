# Mditor 项目代码优化实施报告（第五批）+ 第十轮全量审计

> **实施日期：** 2026-09-21
> **前置文档：** [`optimization_report.md`](./optimization_report.md)（58 项 + 第 1 批 24 项）、[`optimization_report2.md`](./optimization_report2.md)（第 2 批 17 项 + 21 项）、[`optimization_report3.md`](./optimization_report3.md)（第 3 批 26 项）、[`optimization_report4.md`](./optimization_report4.md)（第 4 批 9 项 + 第九轮审计 Q1-Q14）
> **本文范围：** ① report4 §六第五批路线图落地（快赢批 4 项 / P3 性能批 / 重构批首块 + types 拆分 / 工程批全部）；② 全门禁实测 + 1MB 基准 ×3 轮 + coverage 对比；③ v4.17.0 出包（NSIS + HAP）；④ 第十轮全量审计（新发现 20 项，含对抗复核：1 项驳回、1 项存疑），为第六批备料
> **代码基线：** v4.17.0（NSIS 5,900,607 B / HAP 7,843 KB 已出包；vitest 870 / cargo 27 / hypium 15）
> **编排方式：** workflow 协议——3 轮修复 worker（6 并行快赢+工程 / 1 串行 types 拆分 / 1 串行 App 首块拆分）+ 3 并行只读审计 worker + 2 对抗复核 worker；全部验证命令实跑留痕（checkpoint 目录 `.workflow/batch5-20260921/`）

---

## 目录

- [一、执行摘要](#一执行摘要)
- [二、实施记录（report4 第五批路线图落地）](#二实施记录report4-第五批路线图落地)
- [三、实测数据分析](#三实测数据分析)
- [四、打包与验证记录](#四打包与验证记录)
- [五、全量审计：新发现问题（按维度）](#五全量审计新发现问题按维度)
- [六、优先级总表与第六批路线图](#六优先级总表与第六批路线图)
- [七、遗留项追踪表](#七遗留项追踪表)

---

## 一、执行摘要

本会话完成 report4 §六第五批路线图 **1/2/3/4 条的全部可本地执行项**并出新审计：

1. **路线图四条线全落地：** 快赢批（Q8 时区 / Q6 侧栏边界 / Q5 DR-001 决策册 / Q13 runbook 三方核对——首跑即揪出 README S3 命令数漂移"六→八"）；P3 性能批（Q1 发射侧门控 `diagRecordingOn()` + 诊断面板 React.lazy）；重构批（Q4 types.ts 899→523 行纯类型化、Q2 首块 useMenuCommands 拆出 App.tsx 净减 356 行、Q11 SettingsModal 组件测试 22 例、Q7 App 侧 16 处裸 catch 全部注释清零）；工程批（Q9 Rust 路径圈禁完整档 + 3 测试、Q12 coverage 阈值生效、G3 scripts checkJs 111→0 错）。
2. **质量面：** vitest 841 → **870**；cargo 24 → **27**；hypium **15/15** 维持；coverage 总行 34.78% → **36.38%**（components +5.32pp，SettingsModal 单文件 81.65%）；1MB 基准打字 p95 88–96ms 历史最优带，**热路径零回归**。
3. **第十轮审计 20 项新发现（高 2 / 中 8 / 低 10），对抗复核战果：** ① **R1【高】首屏 eager 4.13MB 里钉着整条静态渲染链**——katex 因**版本冲突双实例**（0.18.4 vs 0.16.47）在两个 eager chunk 各打包一份（合计 ~545KB），"lazily imported" 注释从未兑现，预计可移出 450-520KB 且版本对齐再省 ~272KB；② R3 被**驳回**——`drop:console` 是从未生效的死配置（Vite 5.4 不认 `build.esbuildOptions` 键），生产 console.warn 逐字存活，真实问题是配置意图与实际相反；③ 安全侧 S11（grant_fs_scope 自授权原语）/ S13（s3_upload_file 任意读外发）经复核**确认**并给出最小利用链，S12（symlink 逃逸）**存疑**（威胁模型内前提链断裂）。
4. **诚实修正两笔第九轮预期：** Q1b lazy 面板实际只移出 **9.4KB**（预期 60-80KB）——真正的重量不在诊断面板，在 R1 的渲染链；G2 索引访问点编译口径实测 **396 处**（粗扫 129 低估近 3 倍）。

---

## 二、实施记录（report4 第五批路线图落地）

> 编号沿用 report4 Q 系列。✅ 完整实施 / ◐ 部分实施（原因注明）。各 worker 详细过程留档 `.workflow/batch5-20260921/task-01…09.md`。

### 2.1 快赢批（路线图第 1 条，原计划半天）

| 项 | 内容 | 关键证据 |
|---|---|---|
| **Q8 ✅** | overdue 时区混比：`FlashcardModal.tsx:61` 右式 UTC epoch 日序 `Math.floor(now / 86_400_000) - 1` 改本地日序 `dayOf(now) - 1`，与 `dueDay` 口径统一——UTC+8 下逾期 1–2 天的卡恢复正确标记。+1 边界用例（today−2 标 / today−1 不标，种子按 `dayOf(Date.now())` 构造，任何时区稳定） | `FlashcardModal.tsx:64`；10/10 PASS |
| **Q6 ✅** | 侧栏错误边界：`.sb-panel` 全部面板（FileTree/Outline/RecentList/WorkspaceSearch/LinksPanel/AnnotationList）整体包 `<ErrorBoundary key={sidebarTab} label="侧边栏" onReset={…}>`——`key=sidebarTab` 保证崩溃态不粘连到下一标签，onReset 回退文件树；编辑区维持根边界（分级策略对齐） | `App.tsx:2517-2523` |
| **Q5 ✅** | 决策显性化：新建 `docs/decision-records.md`，**DR-001**「界面语言保持中文单语，暂不引入 i18n 框架」——i18n 推迟至 App.tsx/useMilkdown 两拆分之后，届时无出海计划则永久搁置；含复审机制，后续审计不再重复提出 | `docs/decision-records.md` |
| **Q13 ✅** | runbook 桥协议三方核对：`mditor/docs/harmony-release.md` §4 末新增三方核对清单（Registry.ets 注册表 ↔ platform/types.ts ↔ harmony/README）+ 可复制 grep 命令 + 判读规则。**首次核对实跑：45 条注册命令 0 孤儿**；揪出 README:180 S3 命令数漂移（"六命令"实为八，v4.16.0 P6 增文件通道未同步）——本批已修正 | `harmony-release.md`；`harmony/README.md:180` |

### 2.2 P3 性能批（路线图第 2 条）

| 项 | 内容 | 状态 |
|---|---|---|
| **Q1a 发射侧门控 ✅** | devMode.ts 新增统一谓词 `diagRecordingOn()`（`!lifecycleOwned \|\| enabled \|\| diagPanelOpen`），发射函数函数头早退——sysDebug（sysEmit/sysCount）、annoDebug（annoEmit/annoCount）、ipcTrace（tracedIo 遥测段）。**正确性红线逐个核对留档：** tracedIo 只短路追踪、被包装 IO 照常执行；scrollDebug 不门控（recentWrite 是 ghost 归因的**生产行为**）、opDebug 不门控（noteOpError 仅错误路径）、cvMemory/devAnomaly 不门控（生产特性）——各自理由注释留档。`lifecycleOwned` 保证 App 接管前保持记录、库级单测不受影响 | `devMode.ts:95-122`、`sysDebug.ts:42/56`、`annoDebug.ts:49/63`、`ipcTrace.ts:48` |
| **Q1b 诊断面板 lazy ✅** | AnnoDiagnostics/DevAlerts 改 `React.lazy`（具名导出 `then(m => ({ default: m.X }))` 适配）+ `<Suspense fallback={null}>`，独立 chunk 落地（6,971 + 2,453 B）。**诚实记档：实际只移出 9.4KB**（第九轮预期 60–80KB 未兑现——根因见审计 R1/R2：插桩主体经 28 个生产文件静态引用钉在主包，面板只是冰山一角） | `App.tsx:116/121/2747/2759`；`dist/assets/AnnoDiagnostics-*.js` |

```ts
// devMode.ts —— 发射侧统一门控（Q1a 核心，调用点零改动）
export function diagRecordingOn(): boolean {
  return !lifecycleOwned || enabled || diagPanelOpen;
}
// sysDebug.ts —— 发射函数函数头早退（annoDebug/ipcTrace 同型）
export function sysEmit(code: string, detail?: unknown): void {
  if (!diagRecordingOn()) return;   // 生产热路径不再付参数组装成本
  /* …原有记录逻辑… */
}
```

### 2.3 重构批（路线图第 3 条）

| 项 | 内容 | 回归 |
|---|---|---|
| **Q4 types.ts 拆分 ✅** | 899 → **523 行纯类型**（24 个 interface/type，运行时导出 0、re-export 0）；运行时迁 `src/defaults.ts`（346 行：DEFAULT_SETTINGS / FONT_PRESETS / MONO_FONT_PRESETS / SYNC_PROVIDERS / AI_PROVIDERS / isDarkTheme / newAiModelId 等 12 导出）与 `src/settingsNormalize.ts`（63 行：normalizeSyncSettings / pickEditorSettings）；消费方 11 文件 import 迁移；`types.test.ts` 拆 `defaults.test.ts` ×6 + `settingsNormalize.test.ts` ×10——**先对旧实现跑绿再搬家**（防行为漂移）。"from types 必是类型"心智模型成立 | tsc 0 / eslint 0 / vitest 870 / build PASS |
| **Q2 首块拆分 ✅** | 菜单/快捷键层（dispatchMenu 264 行 switch + Rust `menu` 事件监听 + 全局快捷键 effect + execOnEditor）抽为 `src/hooks/useMenuCommands.ts`（536 行）；App.tsx **3,269 → 2,913 行**（净减 356，hook 调用 176→172）。**行为逐字节等价**：依赖数组、case 顺序、preventDefault 语义一字未动；deps 对象 30 字段一次性显式注入（App.tsx:1720-1751），无 prop drilling 恶化。MenuBar 命令表本就在 MenuBar.tsx 无需迁 | 四门禁全过；审计 A2 评为 exemplary（0 any、38-95 行逐字段注释、两处 exhaustive-deps disable 附逐字理由） |
| **Q11 SettingsModal 测试 ✅** | **22 例**：10 分区导航（aria-current/指示条/单分区渲染）+ 9 条"改值→应用"链路（主题/字体预设耦合/性能联动禁用/AI 模型增删与激活重指/RAG 显隐/云同步）+ 保存三重校验（信息不全/HTTP/占位符）+ localhost 豁免 + 测试连接走真实 `syncConfigPayload`/`parseSyncError` + 排除路径恢复 + 关闭与草稿生命周期。SettingsModal 行覆盖 **81.65%**；新踩坑留档：role="radio" 可访问名来自 author 须 getByText 定位 | 22/22 PASS |
| **Q7 裸 catch（App 侧清零）✅** | App.tsx 全部 16 处 `catch {` 带注释（补 3 处 + 13 处原有）；useMenuCommands 迁移随带 1 处。全仓 244 处基线持平——余量按既定计划与 Q3 拆分同期（第六批） | — |

```ts
// Q2 拆分形态：deps 对象显式注入（App.tsx 侧装配，节选）
const { dispatchMenu } = useMenuCommands({
  // ref 镜像（避开闭包过期）
  tabsRef, activeKeyRef, closeTabRef,
  // setters
  setTabs, setActiveKey, setQuickOpen, setSettingsOpen,
  // 稳定回调
  saveTab, saveAsTab, exportTab, openSettings,
  /* …共 30 字段，接口逐字段注释… */
});
```

### 2.4 工程批（路线图第 4 条）

| 项 | 内容 | 状态 |
|---|---|---|
| **Q9 Rust 圈禁 ✅（完整档）** | `trash_file`/`local_copy_file` 强制"运行时 fs scope（grant_fs_scope 授权根 ∪ 拖放自动授权）∪ appData"圈禁：判定下沉纯函数 `is_fs_path_confined`（commands.rs:295-311），`..` 组件**先拒**（即使 scope 谓词恒真）、相对路径拒、appData 严格内部、UNC/`\\?\` verbatim fail-closed、大小写盘符 fail-closed；`to` 不存在路径走词法判定。+3 cargo 单测（合法通过 / `..` 逃逸拒绝 / 圈外拒绝，含"scope 恒真也拒"对抗性用例）。**前端全部真实调用路径（启动恢复/对话框/拖放/sync 暂存区）无回退**。审计对拍 tauri 2.11.5 fs.rs 源码逐向量核验七类攻击全 fail-closed——残留基座问题见 S11/S12/S13 | cargo 24→27 |
| **Q12 coverage 阈值 ✅** | vitest per-glob thresholds：`src/lib/**` lines ≥55、`src/components/**` lines ≥12（基线略下方防抖动）；全量 coverage 实跑通过（阈值语义经审计核读正确；CI 未接见 T4） | 全量跑 exit 0 |
| **G3 scripts checkJs ✅** | 六脚本 `tsc -p tsconfig.scripts.json` **111 错 → 0**（build-harmony 7 / make-icons 30 / mirror-check 22 / release-harmony 11 / sign-and-install 5 / sigv4-check 36），纯 JSDoc 注解**零 @ts-expect-error**、零逻辑改动；行为等价复验：sigv4 oracle 21 向量 PASS、mirror-check 5 对指纹一致、make-icons 产物 md5 逐字节不变 | ✅（CI 接入留第六批与 T4 同做） |

```rust
// Q9 圈禁核心（commands.rs，纯函数下沉便于对抗性单测）
fn is_fs_path_confined(app: &AppHandle, p: &Path) -> bool {
    // `..` 一律先拒——即使 scope 谓词恒真也不放行（对齐 v4.6.2 教训）
    if p.components().any(|c| matches!(c, Component::ParentDir)) { return false; }
    let app_data = app.path().app_data_dir();
    if p.parent().map(|d| d.starts_with(&app_data)).unwrap_or(false) { return true; }
    FsExt::fs_scope(app).is_allowed(p)   // 运行时授权根 ∪ 拖放自动授权
}
```

---

## 三、实测数据分析

### 3.1 质量矩阵（第 4 批后 → 第 5 批后）

| 门禁 | v4.16.0 | v4.17.0 | Δ |
|---|---|---|---|
| vitest | 841 / 78 文件 | **870 / 80 文件** | **+29 / +2**（SettingsModal 22 + flashcard 1 + normalize 16 − 重组 10） |
| cargo test | 24 | **27**（+1 ignored 延续） | Q9 ×3 |
| hypium（LocalUnit） | 15/15 | **15/15** | 零 .ets 改动，维持全绿 |
| `tsc --noEmit` | 0 错 | 0 错 | — |
| eslint | 0 错 0 警 | 0 错 0 警 | — |
| `tsc -p tsconfig.scripts.json` | 111 错（G3 债） | **0 错** | **清零** |
| cargo fmt + clippy -D warnings | 0 | 0 | — |
| sigv4 oracle / mirror-check | PASS / 5 对 | PASS（21 向量）/ 5 对 | 注解后指纹不变 |
| `npm run build` | PASS | PASS | — |
| `hvigorw assembleHap` | PASS（7,841KB） | **PASS（7,843KB）** | +2KB |
| `npm run tauri build`（NSIS） | PASS | **PASS** | 出包见 §四 |

### 3.2 运行时基准（1MB 压测文档 1,649 块，七场景同法同 fixture，CDP 9223）

| 轮次 | open (ms) | 点击 p95 (ms) | 打字 p95 / max (ms) | 打字长任务 | 滚动 p50/p95 (ms) |
|---|---|---|---|---|---|
| batch4-r1/r2/r3（v4.16.0） | 3,458 / 2,949 / 2,910 | 88 / 88 / 96 | 88/88 · 88/96 · 88/96 | 0 | 6/30 · 6/36 · 6/35 |
| **batch5-r1** | 3,454 | 88 | **88 / 96** | 0 | 6/35 |
| **batch5-r2** | 2,934 | 88 | **96 / 104** | 0 | 6/35 |
| **batch5-r3** | 2,959 | 96 | **96 / 104** | 0 | 6/35 |

**结论：** 打字 p95 88–96ms 全程处于历史最优带（batch2 A/B 臂以来 88–96ms 区间），max ≤104ms、长任务 0；点击 p95 88–96 与 batch4 持平；open 2,934–3,454 在历史方差带（2,893–3,495ms）内，r1 偏高为冷启动索引长任务（2,255ms 一次性）；滚动 p50 6 / p95 35 历史持平；undo 收尾恢复原文。**本批（门控 + lazy + 两项拆分 + 28 文件 import 改道）对热路径零回归**——与设计意图一致：改动全部不在打字/滚动路径。原始 JSON：`mditor/perf/results/batch5-r{1,2,3}.json`。

### 3.3 Coverage 对比（v8 provider，阈值已生效）

| 维度 | v4.16.0 | v4.17.0 | Δ |
|---|---|---|---|
| 总行覆盖 | 34.78% | **36.38%** | **+1.60pp** |
| src/lib | 57.01% | **59.35%** | +2.34pp（sync 80.72%） |
| src/components | 12.26% | **17.58%** | **+5.32pp**（SettingsModal 81.65% / FlashcardModal 94.36% / PickerShell 100%） |
| src/platform | 76.19% | 77.27% | +1.08pp |
| src/hooks | 4.86% | **4.32%** | **−0.54pp（回退，见 T5/V1）**——useMenuCommands 536 行 0 覆盖入分母 |
| src/workers | 0% | 0% | 持平（parseWorker 回退路径未测） |

判读：report4 Q11 目标（components→25%+ / hooks→15%+）**过半达成**——components 大幅抬升但 AiPanel/Editor/MarkdownText 仍 0 覆盖；hooks 因拆分反降，教训固化为路线纪律：**Q2 后续每拆一块随附测试**（V1 垫 useMenuCommands 8–10 例是第六批第一件事）。

### 3.4 产物体积

| 指标 | 4.15.0 | 4.16.0 | **4.17.0** | Δ（4.16→4.17） |
|---|---|---|---|---|
| NSIS 安装包 (B) | 5,896,722 | 5,896,341 | **5,900,607** | +4,266（+0.07%，Q9 圈禁 +147 行 Rust 与测试增量） |
| 鸿蒙 HAP (KB) | 7,825 | 7,841 | **7,843** | +2 |
| 主包 index.js (B) | — | — | 1,222,241 | eager 总量 4.13MB——**结构未变**（lazy 只移出 9.4KB，见 R2；真正的瘦身机会是 R1） |

---

## 四、打包与验证记录

- **版本：** 4.17.0 五处对齐（package.json / Cargo.toml / tauri.conf.json / app.json5 versionCode **1001700**——已从 HAP 打包产物 module.json 反查确认 / site/index.html 三处标记）；根 README 版本标记顺带从滞留 4 版的 v4.12.3 更新（D10 清账）；CHANGELOG 按根因级惯例记档（D9 出包前补齐）。
- **产物：** `src-tauri/target/release/bundle/nsis/Mditor_4.17.0_x64-setup.exe`（5,900,607 B）；`harmony/entry/build/default/outputs/default/entry-default-unsigned.hap`（7,843 KB，versionCode 1001700 经 module.json 验证）。release profile 维持 lto + codegen-units=1 + strip + panic=abort。
- **打包前门禁（= ci.yml 全部本地预演）：** vitest 870/870（打包后复跑）· tsc 0 错 · eslint 0/0 · scripts tsc 0 错 · cargo fmt+clippy+test 27 · sigv4 21 向量 PASS · mirror 5 对 · `npm run build` PASS · `build:harmony` PASS · hypium 15/15（零 ERROR 行 + coverage 报告证明执行）。
- **过程事故留档：** NSIS 与 HAP 构建**并发跑导致 `dist/` 竞态清空**（build:harmony 的 dist→rawfile 拷贝步骤报 index.html 缺失、HAP 停留在旧时间戳）——串行重跑后恢复。**教训：桌面/鸿蒙出包不得并行（共享 dist/），已按Runbook 语义执行，建议 release runbook 补一行。**
- **基准冒烟：** dev 实例（CDP 9223）三轮完整跑通，undo 收尾恢复原文；进程/端口清理完毕（9223/1420 释放、mditor.exe 无残留）。
- **待真机验收（沿袭 report4 §四 5 项 + 本批新增）：** ① TaskPool 轮询无周期卡顿；② s3_put_file/s3_get_file 真实桶往返；③ N16 两分支；④ legacy 回收站迁移可见；⑤ /AppData 路径落点正确；⑥（本批新增）Q1 门控后诊断面板打开仍能恢复记录（`setDiagPanelOpen` 链路真机核验）；⑦ 静态管线 `\ce{}` 化学式渲染（R1 附带疑点，见 5.1）。

---

## 五、全量审计：新发现问题（按维度）

> 编号：性能 R1–R5 / 质量 V1–V6 / 安全 S11–S14 / 测试 T4–T5 / 文档 D8–D10（已核对 report1–4 无撞号）。**P0/P1 级发现经对抗复核 worker 独立验证**，结论三态标注（确认/驳回/存疑）；复核过程留档 `.workflow/batch5-20260921/review-01/02-*.md`。

### 5.1 性能

**R1【高·已复核确认，两处修正】首屏 eager 4.13MB 钉着整条静态渲染链 + katex 双实例打包**

- **证据（对抗复核后修正版）：** `MarkdownText.tsx:24` **静态** import renderMarkdown（头注 :9 声称的 "lazily imported" 与 `renderMarkdown.ts:14-18` 的 "none of this weight lands in the initial page bundle" 均与事实相反——注释漂移，懒加载从未落地）；`main.tsx:23` `import "katex/contrib/mhchem"` side-effect 钉入入口。dist 实测：主包 1,222,241B + vendor-milkdown 2,722,523B + vendor-react 186,050B = **eager 4.13MB**；katex 唯一错误串 "Expected group after" 在两个 eager chunk 各 1 次。**复核修正：** 双打包根因不是 manualChunks 切分，而是 **katex 版本冲突双实例**——app 侧 `^0.18.4` vs `rehype-katex` 嵌套 `0.16.47`，Rollup 视为两个模块各打一份（单份 ~272KB，**合计 ~545KB**）；版本对齐去重可再省 ~272KB（原发现未提）。附带疑点：mhchem 注册在 0.18.4 实例而静态渲染管线用 0.16.47——"注册一次全部生效"注释不成立，静态管线 `\ce{}` 疑似失效（待运行时确认）。消费方均非首屏必需（MarkdownText 仅 AiPanel 条件挂载 + AnnotationPopover 激活时用）。
- **建议与步骤：** ① MarkdownText 内 `const rm = import("../lib/renderMarkdown")` 缓存 promise，peekRenderedHtml 同帧命中退化或预热；② mhchem 注册移入 renderMarkdown 模块初始化；③ **先做①②再** manualChunks 补 katex 归并（顺序反了会把 katex 留在 eager）；④ 版本对齐消灭双实例；⑤ 修正两处过期注释。
- **收益：** eager −450–520KB（webview 首屏 parse/exec 与内存）+ 去重再省 ~272KB；这是第六批唯一预期有桌面端可测收益的性能项。**优先级：高。**

**R2【中】Q1 画像修正：插桩 2,744 行经 28 个生产文件钉在主包（第九轮预期的结构性 lazy 未兑现）**

- **证据：** lazy 面板仅 −9.4KB（见 §2.2）；调试模块生产 import 静态引用面 **24 → 28 个文件**（新增 useMenuCommands 等）；插桩串（dev-events.log / MD-9002）grep index 主包实证在。运行时门控本身核证通过（Q1a 收益成立）。
- **建议：** 短期不动（运行时门控已拿主要收益）；若第六批做 R1，顺带评估"诊断链接口注入"（发射函数经 devMode 的 no-op 默认实现注入生产模块）——把 2,744 行移出主包的唯一结构性路径。**优先级：中。**

**R3【中·复核驳回 → 更正为新发现】`drop:console` 是从未生效的死配置**

- **原发现：** vite.config.ts:31 `esbuildOptions.drop: ["console","debugger"]` 会删掉 opDebug 的"被吞异常至少上一次控制台"最低保障。
- **复核结论（驳回原发现，附新事实）：** `build.esbuildOptions` 不是 Vite 5.4.11 `BuildOptions` 的有效键（该形状属 optimizeDeps），**被静默忽略——drop 从未生效**；产物 index chunk 中 `console.warn("[mditor:op] …异常被吞…")` 逐字存活（15 处 console.warn）。生产可观测性完好；真问题是**配置意图与实际相反**（写着删 console 实际没删，未来升 Vite 或改对写法时行为会突变）。
- **建议：** 删除死配置或改为生效写法 `esbuild: { pure: ["console.log","console.info","console.debug"] }`（保留 warn/error）+ 注释说明取舍；opDebug 注释同步。**优先级：中（可观测性意图澄清）。**

**R4【低】WikiLinkSuggest 的 selectionchange → suggestTargets 全库扫描**：双链输入期间每击键 O(n log n) 全量打分排序（vaultIndex.ts:635-649），5,000 文件库单次 3–8ms；建议 query 前缀复用或 100ms 防抖。

**R5【低】modal 外壳 6 处重复（~90 行抽取候选）**：AboutModal/TemplateModal/LinkDialog/SettingsModal/FlashcardModal/FlashcardMaker 各自重复 EXIT_MS + useDelayedUnmount + backdrop/closing + Esc（14–18 行/处）——抽 `<ModalShell>` 与 N19 PickerShell 同模式，22+9 例既有测试当护网。另列 5 组子阈值重复备档（build/release-harmony 脚本 ~20 行且已漂移、trimRoot/shortPath 逐字节同、copyText/clipboard、scanOne/rescanFile、errMsg 家族 ×3）。

**bundle 构成 top（2026-09-21 构建）：** vendor-milkdown 2.72MB（eager）/ html-to-docx 1.68MB（lazy）/ index 1.22MB（eager）/ juice 313KB（lazy）/ vendor-react 186KB（eager）/ parseWorker 173KB（worker）。导出三件套确实全 lazy；再分割唯一大头是 R1 渲染链。

### 5.2 可读性 / 可维护性 / 设计模式

**V1【中】useMenuCommands 零测试——Q2 计划的"护网先行"未执行，hooks 覆盖被分母拖低（4.86→4.32%）**

- **证据：** 全仓测试 0 处引用 useMenuCommands/dispatchMenu；report4 §6.2 明确"先补 3-5 个集成测试再迁"——本批以"逐字节等价"声明替代。deps 对象恰好使它成为**最可单测的一块**（全依赖是 refs/setters/纯回调，`renderHook + fireEvent.keyDown` 即可覆盖）。
- **建议：** 补 8–10 例（dispatchMenu 各命令触发 / Ctrl+S 分流 / Esc 焦点模式 / Ctrl+Tab 边界 / Ctrl+W）+ vitest thresholds 补 `"src/hooks/**"` 下限。约半天。**优先级：中（第六批第一件事）。**

**V2【低】G2 口径修正：noUncheckedIndexedAccess 编译实测 396 处**（第四批粗扫 129 低估 3 倍；Top：AiPanel 43 / annotations 27 / codeAnno 22 / App 22 / vaultIndex 19；sync/ 仅 2 处接近达标）。推进顺序建议按风险：sync → store/vaultIndex → outline/annotations → AiPanel → 调试件。

**V3【低】file_sync_now emit 失败静默吞（useMenuCommands.ts:201）**——Q7②级"用户数据路径"在菜单层的唯一残留；一行对齐 `noteOpError + flashStatus`。

**V4【低】SidebarTab 联合类型双份声明（App.tsx:110 / useMenuCommands.ts:32）**——App 侧加新值 hook 不知情（单向漏网）；移 types.ts 单一导出即闭环。

**V5【低】SettingsModal 不响应 Esc**（测试已钉死为记录性断言）——补 Esc 对齐 FlashcardModal 模式，或进 decision-records 显性决策，二选一闭环。

**V6【低】偶发 flaky：全量首轮 2 例失败、后续 4 轮全绿**——动画窗口类断言（240ms 退场 vs `setTimeout 260`）高负载下天然 flaky 候选；建议 fake timers 或窗口放宽 2×。

**App.tsx 拆分后画像与下一块（审计 A2 确认）：** 2,913 行 / hook 调用 172；**下一块 = ②标签页状态机**（App.tsx:341-776 连续 ~436 行纯标签生命周期：snapshotActiveTab→activateTab→newUntitledTab→closeTab→moveToNewWindow→flushDirtyTabs→shutdownSequence→forceClose，边界天然清晰）；③工作区仅 ~95 行收益小建议合并；④AI 装配维持 17-props（**全仓 0 Context，为第 17 个 prop 引入第一个 Context 得不偿失**，先拆 useAiBridge 逻辑层）。

### 5.3 安全（对抗复核后）

**S11【中·复核确认，附最小利用链】grant_fs_scope 是渲染进程可自调的自授权原语——Q9 圈禁的授权基座在所述威胁模型下塌陷**

- **证据：** commands.rs:234-263 接受任意 paths 无过滤无确认直接入 scope；复核确认最小利用链：被攻破的渲染进程 `grant_fs_scope(["C:\\"], true)` → `trash_file("C:\\Users\\victim\\x.docx")` 绕过 Q9（tauri 2.11.5 对本地 origin 自有命令不做 ACL 门禁，webview/mod.rs ~L1822 核读；上游 `windows_root_paths` 测试自证 `allow_directory("C:\\")` 后 system.ini 可过）。**属第一批 S1"用户意图运行时授权"的架构属性残留**，此前报告未显式指出。
- **建议：** ①短期（0.1 天）：security.md 与命令注释显性记录威胁模型边界；②中期（2-3 天）：授权事件源迁 Rust 侧（dialog 确认回调/拖放事件内直接 grant，grant_fs_scope 降级为仅接受"Rust 侧会话登记过的候选路径"）。**优先级：中。**

**S12【低-中·复核存疑】local_copy_file 的 to 路径符号链接祖先逃逸（词法匹配盲区）**

- **复核结论（存疑）：** 机制在 tauri 源码层成立（不存在路径原样词法匹配、`fs::copy` 穿透写出），**但前提链在威胁模型内断裂**——capabilities 无 `fs:allow-symlink`、tauri-plugin-fs 2.5.1 无 symlink 命令、write/mkdir/s3_download 均只造普通文件；junction 须外部植入（恶意克隆仓库带 `assets -> Startup`）。修复仍值得做（15 行 `resolve_existing_prefix` 复检 + junction 单测），与 fs 插件自身同病属平台平价。**优先级：低-中（存疑标注，未独立验证前提链可达成）。**

**S13【中·复核确认】Q9 同族三条更强命令漏网：local_files_equal / s3_upload_file / s3_download_file 未圈禁**

- **证据：** `s3_upload_file`（s3.rs:357-384）`local_path` 任意本地读（仅大小上限）+ 渲染层传入 cfg 端点——**任意本地文件读 → 外发原语**，一步到位不经 fs scope；`s3_download_file`（:390-459）远端字节 → 任意路径落盘（含启动目录持久化）；`local_files_equal`（commands.rs:491-534）存在性 oracle + 内容确认。Q9 注释自称"两条文件原语命令"实有五条——前三批报告均未提及这三条（审计盲区实案）。
- **建议：** 三命令补 `ensure_fs_path_confined`（与 trash_file 同型注入）；合法调用面（appData 暂存区/工作区）现有 helper 语义已覆盖，0.5 天。**优先级：中（成本低，第六批安全批顺手做）。**

**S14【中·复核确认】依赖漏洞：cargo audit 2 high + 1 medium；npm 1 high（已有仓内缓解）**

- **证据：** quick-xml 0.39.4 ×2 high（RUSTSEC-2026-0194/0195，各 7.5）经 object_store 0.13.2 传递——该 crate 解析 S3 ListObjectsV2 XML = **用户配置端点的不可信输入**（恶意端点可 DoS 同步线程）；修复 ≥0.41.0 但 object_store 钉 `^0.39`，需上游发版或 `[patch]`。rustls 0.23.43 medium（RUSTSEC-2026-0285）——`cargo update -p rustls --precise 0.23.45` 一行即修。npm image-size ≤2.0.2 high 经 html-to-docx 传递，**仓内魔数门已实际缓解**（imageSniff.ts:1-14 仅放行七格式，v4.6.2 设计）。
- **建议：** ①立即 rustls 升级（一行）；②quick-xml 追上游 + 必要时 patch；③`npm audit fix` 深防御；④ci.yml 加 weekly audit job。**优先级：中。**

**✅ 正面确认（10 项，全文见 checkpoint）：** dangerouslySetInnerHTML/eval/new Function 维持 0；密钥全链路不入日志（前端 10 处 console 逐条核验 + Rust map_store_error 脱敏 + 鸿蒙 SIGV4 门控只输出中间值）；Q9 七类向量 fail-closed；AI/S3 出站防线（端点校验/key 校验/HTTPS-only/内网拒绝）三批无回退；trash_file 对 symlink 免疫；24 命令参数可信度全表过审（除上述三条）；桥注册表 45 条 0 孤儿。

### 5.4 测试覆盖

**T4【中】coverage 阈值未接 CI——Q12 防回退门禁只在本地生效**：ci.yml:63 前端门禁只有 `npm test`（无 coverage），阈值永不执行。一行改 `npm run test:coverage`（增量 ~30-40s）。**优先级：中。**

**T5【低】hooks 覆盖回退与拆分-测试节奏**：拆分把无测试代码搬进 hooks 目录稀释覆盖（4.86→4.32%）——固化为路线纪律：Q2 后续每拆一块随附测试；parseWorker 回退 1 例仍欠（report4 Q11 ④）。

### 5.5 文档完善度

**D8【高】security.md 三节仍描述 S1/S2/S6 修复前的 insecure 现状（落后代码两个安全批次）**：fs scope `**`（实为 $APPDATA/$DOCUMENT+运行时授权）、密钥明文（实为 Credential Manager + @keychain 标记）、已移除的 CSP flag 仍主打——**面向用户/审计者的安全说明系统性低报实际水位，本审计初读即被误导**。按现状重写三节（0.5 天）+ 补 Q9/S13 现状 + "改 capabilities/secrets/store 时同步本页"核对提示。**优先级：高（第六批文档头号项）。**

**D9【中→本批已修】CHANGELOG 未覆盖第五批**：出包前已补 Unreleased 段（含 870/27/15 矩阵与 36.38% 覆盖）。
**D10【低→本批已修】根 README 版本滞后 4 版**：v4.12.3 → v4.17.0 已更新。

---

## 六、优先级总表与第六批路线图

### 6.1 新发现 20 项优先级总表（D9/D10 本批已修，不占批次）

| # | 优先级 | 项 | 一句话建议 | 预期收益 | 工作量 |
|---|---|---|---|---|---|
| R1 | **高** | 渲染链 lazy + katex 版本对齐去重 | MarkdownText 动态 import + mhchem 迁模块 + manualChunks 归并 + 版本统一 | eager −450-520KB、去重 −272KB、首屏 parse/exec↓ | 1-1.5 天 |
| D8 | **高** | security.md 重写 | 对照 capabilities/secrets/store 现状重写三节 | 安全说明与代码一致 | 0.5 天 |
| S13 | 中 | 三命令补圈禁 | ensure_fs_path_confined 注入 s3_upload/download + local_files_equal | 消除"任意读外发"最短路径 | 0.5 天 |
| S14 | 中 | 依赖漏洞 | rustls 一行升级 + quick-xml 追上游 + npm audit fix | TLS/S3 解析面收敛 | 0.5 天 |
| S11 | 中 | grant_fs_scope 自授权 | 文档先行 → 授权事件源迁 Rust | 后端防线可自证 | 0.1+2-3 天 |
| V1 | 中 | useMenuCommands 8-10 例 | renderHook + 表驱动 dispatch 测试 | Q2 下一块护网 + hooks 止跌 | 0.5 天 |
| T4 | 中 | 阈值接 CI | ci.yml 改 test:coverage | 防回退门禁生效 | 0.1 天 |
| R3 | 中 | drop 死配置澄清 | 删除或改 pure 写法 + 注释 | 意图与实际一致 | 0.1 天 |
| R2 | 中 | 插桩主包钉死（结构性） | 诊断链接口注入（与 R1 同批评估） | 主包 −100KB 级 | 1 天 |
| Q3 续 | 中 | useMilkdown 拆分（四职责） | 先抽纯函数再留壳 | 编辑器层可测性 | 3-4 天 |
| Q2 续 | 中 | App.tsx ②标签页状态机（436 行连续块） | 先 V1 垫测试再迁 | 2,913 → ~2,400 行 | 1-2 天 |
| R4 | 低 | WikiLinkSuggest 全库扫描 | 前缀复用或 100ms 防抖 | 大库双链击键尾延迟 | 0.2 天 |
| R5 | 低 | ModalShell 抽取 | 6 处外壳收口（N19 同模式） | ~90 行去重 | 0.5 天 |
| V2 | 低 | G2 按 396 口径推进 | sync→vaultIndex→outline 顺序 | 索引访问安全 | 分批 |
| V3 | 低 | file_sync_now 吞错 | 一行 noteOpError+flashStatus | 菜单层 Q7②清零 | 0.1 天 |
| V4 | 低 | SidebarTab 单一声明 | 移 types.ts | 消双份 | 0.1 天 |
| V5 | 低 | SettingsModal Esc | 补齐或 DR 决策 | UX 一致性 | 0.2 天 |
| V6 | 低 | flaky 动画断言 | fake timers / 2× 窗口 | CI 信号可信 | 0.2 天 |
| S12 | 低（存疑） | to 路径祖先解析复检 | resolve_existing_prefix + junction 单测 | 闭合词法盲区 | 0.3 天 |
| T5 | 低 | 拆分随附测试纪律 | 已入路线图 | hooks 覆盖 | 持续 |

### 6.2 第六批路线图（建议顺序）

1. **安全批（1-1.5 天）：** S13 三命令圈禁 + S14 rustls 一行升级 + S11 文档先行 + D8 security.md 重写——四项合计 <2 天，全部即时可验（cargo test + 文档核对）。
2. **性能批（1-1.5 天）：** R1 渲染链 lazy（①动态 import → ②mhchem 迁模块 → ③manualChunks 归并 → ④版本对齐 → ⑤注释修正）→ eager 前后对比 + 打字/首屏复测（第六批唯一桌面端可测收益大头）；R3 drop 澄清顺手做；R2 诊断链注入同批评估。
3. **测试垫（0.5 天）：** V1 useMenuCommands 8-10 例 + T4 阈值接 CI + V6 flaky 治理——为重构批开路。
4. **重构批（主体，1-2 天 + 3-4 天）：** Q2 ②标签页状态机（App.tsx:341-776）→ Q3 useMilkdown 四块拆（Q7 裸 catch 分级余量与 G2 sync/ 推进同期，冲突面共享一次付）。
5. **快赢批（0.5 天）：** V3/V4/V5/R4 四个 0.1-0.2 天项打包。
6. **真机窗口（与鸿蒙 owner 协调）：** §四验收清单 7 项 + S12 前提链验证。

---

## 七、遗留项追踪表（report4 §七 对账）

| 遗留项 | report4 状态 | 本批变化 |
|---|---|---|
| M1 App.tsx 拆分（Q2） | ⏳ 四块计划 | **◐ 首块完成**（菜单层 536 行 → useMenuCommands.ts；App 3,269→2,913）；②标签页状态机被审计确认为下一块（:341-776 连续 436 行） |
| M2 useMilkdown 拆分（Q3） | ⏳ | 未动（画像不变 2,703 行/33 catch/0% 覆盖）——第六批主体 |
| **P3 调试插桩（Q1）** | ⏳ 高优 | **◐ 门控完成 + 面板 lazy 完成；画像修正：lazy 仅 −9.4KB、2,744 行仍钉主包（R2）→ 结构性收口（接口注入）转第六批与 R1 同批** |
| **Q4 types.ts** | ⏳ | **✅ 完成**（899→523 纯类型 + defaults 346 + settingsNormalize 63 + 16 测试） |
| Q5 i18n 决策 | ⏳ | **✅ DR-001 决策册建立** |
| Q6 侧栏错误边界 | ⏳ | **✅ 完成**（六面板整包 + key 隔离） |
| **Q7 裸 catch 分级** | ⏳ 244 处 | **◐ App 侧 16 处清零**（全带注释）；全仓 244 持平，余量绑 Q3 拆分；V3 一处新残留 |
| **Q8 overdue 时区** | ⏳ | **✅ 完成**（dayOf 统一 + 边界用例） |
| **Q9 后端圈禁** | ⏳ | **✅ trash_file/local_copy_file 完成**（七向量 fail-closed + 3 测试）；S13 三命令漏网转第六批 |
| Q10 零散 Esc | 维持现状 | 维持（V5 关联项有决策出口） |
| **Q11 组件测试扩展** | ⏳ SettingsModal→AiPanel | **◐ SettingsModal 22 例完成**（81.65% 行覆盖）；AiPanel/parseWorker 转第六批；hooks 回退教训 → V1 |
| **Q12 工程口径** | ⏳ | **✅ G3 scripts 111→0 错 + coverage 阈值生效**；T4（CI 接入）与 G2 新口径（V2：396 处）转第六批 |
| Q13 协议-文档核对 | ⏳ | **✅ runbook 清单落地**，首跑揪出并修正 README S3 命令数漂移 |
| G2 noUncheckedIndexedAccess | ⏳（粗扫 129） | **口径修正：编译实测 396 处**（V2），推进顺序 sync→vaultIndex→outline |
| P8 RAG stringify | ⏳ 观察 | 无变化（无新证据） |
| 真机验收清单 | ⏳ 5 项 | 未做（无设备窗口）+2 项（Q1 门控面板恢复、\ce{} 渲染疑点） |
| hvigor test 退出码陷阱 | 留档 | 沿用 grep ERROR 判据（15/15） |

---

*报告生成方式：workflow 协议三轮编排——R1 六并行修复 worker（快赢/门控+lazy+边界/时区/圈禁+阈值/文档/脚本注解/SettingsModal 测试，文件所有权互斥）→ R2 types 拆分 → R3 App 首块拆分；第十轮审计 3 并行只读 worker（性能+重复 / 质量+模式+错误处理 / 安全+测试+文档）+ 2 对抗复核 worker（R1 确认并修正归因与数字、R3 驳回并翻出死配置新事实、S11/S13/S14 确认、S12 存疑）。全部验证命令实跑：vitest 870（打包后复跑）/ cargo 27+1 / hypium 15（零 ERROR 行 + coverage 证明执行）/ tsc ×2（src 与 scripts）/ eslint 0-0 / clippy / sigv4 21 向量 / mirror 5 对 / build ×2 / CDP 基准 ×3 轮 JSON 落盘。新发现 20 项全部附 file:line 证据；对抗复核驳回与存疑如实标注；两笔第九轮预期修正（lazy −9.4KB / G2 396 处）诚实记档。checkpoint：`.workflow/batch5-20260921/`（16 份过程留档）。*
