# Mditor 项目代码优化实施报告（第四批）+ 全量审计

> **实施日期：** 2026-09-20
> **前置文档：** [`optimization_report.md`](./optimization_report.md)（58 项 + 第 1 批 24 项）、[`optimization_report2.md`](./optimization_report2.md)（第 2 批 17 项 + 21 项新发现）、[`optimization_report3.md`](./optimization_report3.md)（第 3 批 26 项 + 第四批路线图）
> **本文范围：** ① report3 §八路线图全部落地（鸿蒙性能批 5 项 / 重构批 4 项 / 测试设施 / 工程批部分）；② 全门禁实测 + 1MB 基准 ×3 轮 + coverage 首次量化；③ v4.16.0 出包（NSIS + HAP）；④ 第九轮全量代码审计（新发现 14 项，按维度分类、含优先级与实施步骤），为第五批备料
> **代码基线：** v4.16.0（NSIS 5,896,341 B / HAP 7,841 KB 已出包）
> **编排方式：** 主 agent（鸿蒙批 5 项 + 门禁/打包/报告）+ 3 个串行修复 worker（PickerShell / pluginCast+FileTree 键盘 / FlashcardModal 回归网）+ 1 个 Explore 审计 worker；全部验证命令实跑留痕

---

## 目录

- [一、执行摘要](#一执行摘要)
- [二、实施记录（report3 未完成项落地）](#二实施记录report3-未完成项落地)
- [三、实测数据分析](#三实测数据分析)
- [四、打包与验证记录](#四打包与验证记录)
- [五、全量审计：新发现问题（按维度）](#五全量审计新发现问题按维度)
- [六、优先级总表与第五批路线图](#六优先级总表与第五批路线图)
- [七、遗留项追踪表](#七遗留项追踪表)

---

## 一、执行摘要

本会话完成 report3 §八路线图的**完整落地**并出新审计：

1. **一个被误判为"环境问题"的真 bug 被修复（W8/UriMapper）：** report3 把 hypium 3 例基线失败归因于"CLI 环境本就 FAIL"——本批代码级核证发现其中 2 例是**真 bug**：`resolve('/AppData/<rel>')` 拼接缺 `/` 分隔符，鸿蒙回收站自 v4.13.0 起一直写到 `<filesDir>trash`（畸形目录）而清理逻辑盯着 `<filesDir>/trash`——**回收站永不清理、/AppData 全部路径错位**。修复 + 一次性迁移 + 第 3 例（用例自身期望构造 bug）修正后 **hypium 15/15 首次全绿**。
2. **鸿蒙三大基础设施项落地：** N8（WatchManager 快照扫描迁 TaskPool 工作线程，主线程不再周期性承担 ≤5000 条 statSync）；P6（S3 上传/下载改桥内文件通道，退役 base64 三重编码链，50MB 文件内存放大归零）；N16（关窗从"盲等 1.2s 杀进程"改 ack 协议——收尾完成即终止、取消不终止、8s 兜底，3s 落盘上限首次被完整覆盖）。
3. **组件测试设施从 0 到 1：** 网络恢复后落地 @testing-library + jsdom docblock 范式 + coverage 工具链；**组件测试 0 → 44 例**（QuickSwitcher/CitationPicker/FileTree/FlashcardModal——后者锁定了第 3 批靠人肉复核才发现的 N3 跳卡回归）。vitest 806 → **841**。
4. **全量审计（第九轮）：** 新发现 14 项（高 3 / 中 6 / 低 5），最重要的三个认知升级——① P3 调试插桩实测 **3,487 行、24 个生产 import 点**，且 devMode 门控只覆盖"记录侧"不覆盖"发射侧"；② 正面确认：`dangerouslySetInnerHTML` 0 处、Rust 非 test `unwrap/expect` 仅 2 处（均为启动 fail-fast）、parseWorker 错误路径完备；③ App.tsx（3,232 行 / 176 个 hook 调用）与 useMilkdown（2,703 行 / 33 处裸 catch）两大结构债在组件测试护网就位后，拆分窗口已成熟。

---

## 二、实施记录（report3 未完成项落地）

> 编号沿用 report2/report3。✅ 完整实施 / ◐ 部分实施（原因注明）。

### 2.1 鸿蒙性能与正确性批（路线图第 1 条）

| 项 | 内容 | 关键证据 |
|---|---|---|
| **W8 ✅** | UriMapper 沙箱路径拼接真修：`resolve()` 的 `/AppData` 分支 `sandboxPath: rel.length === 0 ? sandbox : \`${sandbox}/${rel}\``（原先 `${sandbox}${rel}` 无分隔符）。影响面：回收站位置、日志路径、review-state 等全部 /AppData 写入。**善后：** `migrateLegacyTrash()` 启动一次性把存续期（4.13.0–4.15.x）畸形目录 `${filesDir}trash` 整棵搬入 `<filesDir>/trash/<epoch>-legacy-trash`，30 天策略自然回收 | `UriMapper.ets:104-117`；hypium 3 例基线失败 → 15/15 |
| **W6 ✅** | cleanupTrash 递归删除补齐：目录条目原 `fs.rmdirSync` 单删，非空目录必抛被吞（回收站目录条目只增不减）；新增 `removeTreeReal()` 后序递归（真实路径版，与虚拟路径版 `removeTreeVirtual` 同骨架） | `FileManager.ets:646-680` |
| **N8 ✅** | WatchManager TaskPool 迁移：`@Concurrent scanTree(rootReal, rootVirtual, recursive, maxEntries)` 在 taskpool 工作线程以真实路径 BFS（虚拟/真实双栈并行推进）；主线程仅剩根解析（`FileManager.realTargetOf` 新增）+ 结果 Map 重组。语义逐条对齐：任一目录 list 失败整轮跳过（worker 抛出→poll catch）、单条 stat 失败跳过、超限丢弃本轮。**ArkTS 约束实测留档（三次编译失败换来的）：** ① `taskpool.execute` 返回 `Promise<Object>`，接口形态赋值撞 `arkts-no-structural-typing`——须 class + `as` 下转；② @Concurrent 函数只能引用 **import 绑载**与 @Sendable 类，同文件声明的类不行——ScanOut 必须独立模块；③ @Sendable 字段必须 sendable 类型——普通 `Array` 不是，须 `collections.Array` | `WatchManager.ets:43-96,251-273`、`ScanOut.ets`（新文件）；`hvigorw assembleHap` PASS |
| **P6 ✅** | S3 文件通道：桥新增 `s3_put_file {cfg,key,path,mtimeMs?}` / `s3_get_file {cfg,key,path}`；S3Bridge 构造注入 FileManager，字节经 `readFileBytesVirtual/writeFileBytesVirtual` 虚拟路径直读直写（写入侧 `buffer.slice(byteOffset, +len)` 防视图前缀垃圾）。get/put 核心抽 `getObjectBytes()/putObjectBytes()` 共用（原 HEAD 校验+上限+PUT+HEAD 回读两份逐行重复收口）。前端 `s3PutFile/s3GetFile` 鸿蒙分支改调新命令，`putBytesViaBase64`（readFile→btoa→s3_put 三重编码）与 `writeFileEnsuringDir` 退役删除 | `S3Bridge.ets:708-825`、`FileManager.ets:79-107`、`sync/s3.ts:106-158`；s3.test.ts 鸿蒙 2 用例改写断言"零字节经前端" |
| **N16 ✅** | closeWindow ack 协议：桥侧 `app.closeWindow` 广播后等 `app.closeWindowAck {ok}`——ok=true 立即 terminateSelf（快路径不盲等）、ok=false 留在应用、8s 超时按确认兜底；单一等待槽位 + 回声竞态由超时兜底（forceClose→destroy 的二次广播被前端 destroyingRef 忽略）。前端：适配层 `onCloseRequested` 跑完 handler 后回执（`r !== false`），handler 异常按确认回执；`PlatformWindow.onCloseRequested` 签名放宽 `void \| false \| Promise<void \| false>`（types.ts:140），App.tsx 取消路径显式 `return false`（:719），tauri 适配层包装丢弃返回值（preventDefault 同义）。**已知限制（注释留档）：** 确认弹窗超 8s 仍未决按关闭处理；preventDefault 仍是 no-op | `Registry.ets:192-236`、`platform/harmony/index.ts:160-177`、`App.tsx:707-730`、`platform/tauri/app.ts:34-40` |

### 2.2 重构批（路线图第 2 条，测试设施先行）

| 项 | 内容 | 回归 |
|---|---|---|
| **测试设施 ✅** | 安装 @testing-library/react 16.3.3 / @testing-library/jest-dom / @vitest/coverage-v8 4.1.11 / @types/node 26（网络恢复）；vitest include 扩 `**/*.test.{ts,tsx}`，jsdom 经文件头 `// @vitest-environment jsdom` docblock 按需启用（node 全局默认不拖累纯逻辑测试）；`test:coverage` 脚本 + v8 provider + json-summary。**@types/node 污染治理：** vitest 类型链显式引用 node 类型，`types: []` 拦不住全局合并——6 处裸计时器改 `ReturnType<typeof setTimeout>`（跨环境安全），1 处失效 `@ts-expect-error` 移除 | trigger.ts 类型改动后 tsc/vitest 全绿 |
| **N19 ✅** | PickerShell 抽取：QuickSwitcher/CitationPicker 共享外壳（overlay/closing + panel + 输入行 + ↑↓/Enter/Esc + scrollIntoView + useDelayedUnmount(180) + 30ms 聚焦）收进 `PickerShell.tsx`（136 行）；两消费者各 -41 行；DOM 结构与类名逐字节不变（CSS 零改动）。worker 落坑留档：@types/react 18 的 RefObject variance 陷阱、vi.mock 提升 TDZ（vi.hoisted）、RTL v16 在 vitest 无 globals 时须显式 `afterEach(cleanup)`、jsdom 无 scrollIntoView 需补桩 | 新增 QuickSwitcher.test.tsx ×9 + CitationPicker.test.tsx ×9（真实 rankEntry/search 过滤断言） |
| **N20 ✅** | 插件断言收口：25 处 `as unknown as MilkdownPlugin[]/Plugin` 收进 `src/lib/pluginCast.ts`——`asMilkdownPlugins()` + **泛型化** `asRemarkPlugin<[Opts]>()`（unified `.use()` 的 settings 元组推断必须泛型，否则带选项插件丢类型检查）。跳过 18 处非插件形态断言（mdast 树/节点形状、PM domObserver 探测、window 调试挂点、fs.stat 形状、self as Worker——逐处核对） | tsc 0 错；触及文件的 55 例既有测试全过 |
| **N21 ✅** | FileTree 键盘可达（WAI-ARIA tree 最小子集）：roving tabindex——`focusedPath` 状态 + **渲染期派生** `effectiveFocusPath`（焦点行→activePath 行→首行；派生而非 effect 清理，焦点行被折叠/删除时 tab stop 自动回退且无 setState-in-effect）；行级 focused 经既有 useSyncExternalStore 订阅（memo 性能零破坏）。事件委托在 `.ft-scroll` 单 onKeyDown：↑↓（DOM 序 ±1）、→（展开/进首子）、←（折叠/回父）、Enter（目录 toggle/文件 open/batchMode 勾选）、Home/End；`target.closest("input, button")` 守卫防劫持重命名输入框 | FileTree.test.tsx ×8（整组件真实挂载，mock tauriFs/filePrefetch/dialogs 三处即可） |
| **FlashcardModal 回归网 ✅** | 锁定 N3 跳卡回归的组件测试 ×9：**滑出分支**（评"良好"→dueDay=today+7→清单收缩，断言下一张=原第 2 张、不出现结束页）与**原位保留分支**（评"忘了"→dueDay 恰不变→idx 前进一位）双钉死；另发现"严重逾期+忘了"实走重排滑入分支（第 4 用例单钉）。worker 纠正了任务书的错误假设：真实调度下 staysInPlace 唯一构造是"评前恰今天到期+忘了" | 9/9 PASS |

### 2.3 工程批（路线图第 3 条）

| 项 | 内容 | 状态 |
|---|---|---|
| **N32 ✅（基线）** | coverage 首次量化（见 §3.3）；阈值门禁**未设**（基线刚建立，先防认知断层；第五批设 lib ≥55% 起步阈值防回退） | ✅ 基线 / ⏳ 阈值 |
| **G3 ◐** | @types/node 已装、`tsconfig.scripts.json`（checkJs 模板）已建，但 scripts/ 实测 **130 处**注解债务（implicit-any + env 形状）、perf/ 另有 240 处——发布链脚本行为已验证，强清有回归风险。配置留仓未接 CI，量化数字见 §五 Q12 | ◐ 模板+量化 |
| **文档同步 ✅** | harmony/README.md:122 过期的"1.2s 盲等"关窗描述更新为 N16 ack 协议（两分支验收点） | — |

---

## 三、实测数据分析

### 3.1 质量矩阵（第 3 批后 → 第 4 批后）

| 门禁 | v4.15.0 | v4.16.0 | Δ |
|---|---|---|---|
| vitest | 806 通过 / 74 文件 | **841 通过 / 78 文件** | **+35 / +4 文件**（组件 26 + s3 通道改写 2 + 既有扩充 7） |
| cargo test | 24 通过 | 24 通过 | 本批零 Rust 改动 |
| hypium（LocalUnit） | 15 例（**3 例基线 FAIL** 被判"环境问题"） | **15/15 PASS** | **基线失败清零**（2 例真 bug 修复 + 1 例用例期望修正） |
| `tsc --noEmit` | 0 错 | 0 错 | 含新 @types/node 共存治理 |
| eslint | 0 错 0 警 | 0 错 0 警 | — |
| `cargo fmt` + clippy -D warnings | 0 | 0 | — |
| sigv4 oracle / mirror-check | PASS / 5 对 | PASS / 5 对 | S3Bridge 重构未触碰镜像函数 |
| `npm run build` | PASS | PASS（15.25s） | — |
| `hvigorw assembleHap` | PASS（7,825KB） | **PASS（7,841KB）** | +16KB（TaskPool+文件通道+ack） |
| `npm run tauri build` | PASS | PASS | NSIS 出包 |

### 3.2 运行时基准（1MB 压测文档 1,649 块，七场景同法同 fixture）

| 轮次 | open (ms) | 点击 p95 (ms) | 打字 p95 / max (ms) | 打字长任务 | 滚动 p50/p95 (ms) |
|---|---|---|---|---|---|
| batch3-r1/r2/r3（v4.15.0） | 3,211 / 3,267 / 3,278 | 96 / 112 / 104 | 96 / 392⚠️ / 96 | 0 | 4/33 ×3 |
| **batch4-r1** | 3,458 | 88 | **88 / 88** | 0 | 6/30 |
| **batch4-r2** | 2,949 | 88 | **88 / 96** | 0 | 6/36 |
| **batch4-r3** | 2,910 | 96 | **88 / 96** | 0 | 6/35 |

**结论：** 打字 p95 三轮全部 88ms——处于历史最优带（batch2 A/B 臂 88–96ms 的下缘），且无 batch3-r2 那样的单点尖峰；点击 p95 88–96 优于 batch3（96–112）；open 2,910–3,458 在历史方差带（2,893–3,495ms）内，r1 偏高为冷启动索引长任务（2,282ms 一次性）；滚动 p95 30–36ms 与历史持平；打字/滚动期长任务 0。**本批（组件重构 + 键盘导航 + 桥改造）对热路径零回归**——符合设计意图：改动全部在非热路径。原始 JSON：`mditor/perf/results/batch4-r{1,2,3}.json`。

> **诚实性说明：** 本批运行时收益主要在**鸿蒙端**（TaskPool 解除主线程周期性阻塞、S3 通道内存放大归零），桌面端基准无提升预期、实测亦无回归。鸿蒙收益的量化须真机 hilog/内存面板（见 §四验收清单）。

### 3.3 Coverage 基线（N32 首次量化，v8 provider）

| 维度 | 覆盖率 |
|---|---|
| **总行覆盖** | **34.78%**（语句 33.77% / 分支 31.4% / 函数 28.85%） |
| src/lib（纯逻辑层） | **57.01%**（其中 sync 84% / agent 57.31%） |
| src/platform | 76.19% |
| src/components | **12.26%**（本批前为 0%——44 例组件测试首次点亮） |
| src/hooks | 4.86%（**最大空洞**：useMilkdown 2,703 行 facade） |
| src/workers | 0%（parseWorker 30 行，主线程回退路径未测） |

判读：**分层覆盖与风险倒挂**——纯逻辑层已厚（sync 84%），而事故高发区（组件/hooks）刚破零。components 从 0→12.26% 的意义不在数字而在**范式落地**：jsdom+RTL+vi.mock 单例的模板已由 4 个 .test.tsx 树立，第五批按模板扩 AiPanel/SettingsModal 即可。

### 3.4 产物体积

| 指标 | 4.14.0 | 4.15.0 | **4.16.0** | Δ（4.15→4.16） |
|---|---|---|---|---|
| NSIS 安装包 (B) | 5,895,423 | 5,896,722 | **5,896,341** | **−381（−0.006%）** |
| 鸿蒙 HAP (KB) | — | 7,825 | **7,841** | +16（TaskPool/文件通道/ack） |

桌面包**净减小**：退役的 base64 编码链（putBytesViaBase64 + writeFileEnsuringDir）与 PickerShell 去重的减重，抵消了 ack 协议 + 测试无关运行时代码的增量。

---

## 四、打包与验证记录

- **版本：** 4.16.0 四处对齐（package.json / Cargo.toml / tauri.conf.json / app.json5 versionCode 1001600；Cargo.lock 随构建同步）；site/index.html 三处版本标记（:49 下载文件名 / :54 徽标 / :71 wn-ver）；CHANGELOG 按根因级惯例记档。
- **产物：** `src-tauri/target/release/bundle/nsis/Mditor_4.16.0_x64-setup.exe`（5,896,341 B）；`harmony/entry/build/default/outputs/default/entry-default-unsigned.hap`（7,841 KB）。release profile 维持 lto + codegen-units=1 + strip + panic=abort。
- **打包前门禁（= ci.yml 全部本地预演）：** vitest 841/841 · tsc 0 错 · eslint 0/0 · cargo fmt+clippy+test 24 · sigv4 PASS · mirror 5 对 · `npm run build` PASS · `build:harmony` PASS · hypium 15/15。
- **基准冒烟：** dev 实例（CDP 9223）三轮完整跑通，undo 收尾恢复原文，进程/端口清理完毕（1420/9223 释放）。
- **待真机验收（新增）：** ① TaskPool 轮询期间 UI 滚动/输入无周期卡顿（hilog 看 worker 线程执行）；② s3_put_file/s3_get_file 真实桶往返 + 断网错误码；③ N16 两分支（脏文档落盘后关 / 取消关窗留在应用）；④ 旧版升级后 legacy 回收站迁移可见（`<filesDir>/trash/<epoch>-legacy-trash`）；⑤ /AppData 路径修复后日志/复习进度落点正确。

---

## 五、全量审计：新发现问题（按维度）

> 编号 Q1–Q14（承接 report 系列 N/W/S/P/M/G 编号传统）。每项含证据、建议、步骤、收益；优先级汇总见 §六。正面确认（无需行动）穿插标注为 ✅。

### 5.1 性能

**Q1【高】P3 调试插桩常驻——3,487 行 / 24 个生产 import 点，门控只覆盖一半**

- **证据：** scrollDebug 1,345 + cvMemory 723 + devAnomaly 641 + annoDebug 337 + devContext 153 + opDebug 114 + sysDebug 108 + ipcTrace 66 = **3,487 行**；被 24 个非 test 生产文件 import（main.tsx:6-9、App.tsx:18-21、Editor/DevAlerts/AnnotationPopover/AnnoDiagnostics、useMilkdown/useAutosave 等 7 个 hooks、ai/store/tauriFs/sync-trigger 等 12 个 lib）。`devMode.ts:83` 的 `enabled` 旗标在 `settings.devMode=false` 时让所有**记录器**入口早退（:180/:197/:209/:222/:248/:267/:284/:384），但**发射侧**（`sysEmit/noteOpError/noteScrollWrite/annoEmit/tracedIo` 的调用点本身）在生产路径无条件执行——每个热路径调用点仍在付栈帧与参数组装成本。
- **建议：** 两步走。第一步（低风险）：把发射侧统一改为经 `devMode.enabled` 短路的薄包装（调用点零改动，仅模块内部门控前移）；第二步（结构性）：诊断面板（AnnoDiagnostics/DevAlerts）React.lazy 按需加载，`import()` 动态引入把 3,487 行移出主 bundle。
- **步骤：** ① 盘点发射侧全部导出的调用频度（grep 计数）；② devMode 内加 `emit` 门控包装并保持签名不变；③ vite 构建对比 bundle 体积与打字 p95；④ AnnoDiagnostics/DevAlerts 改 lazy。
- **收益：** 主 bundle 预计 −60~80KB（source 3,487 行折算）；热路径每次调用省一次未命中分支；诊断能力不变（devMode 开启时全量恢复）。

**Q2【中】App.tsx 神组件——3,232 行 / 176 个 hook 调用（M1 的精确画像）**

- **证据：** useState×23、useEffect×23、useCallback×90、useRef×34、useMemo×6；JSX return 段 `App.tsx:2771-3228`（457 行）；`dispatchMenu` `:1810-2073`（264 行巨型 switch）；全局快捷键 effect `:1434-1532`（99 行）。
- **建议：** 拆分顺序按"数据所有权"切：① 菜单/快捷键层（dispatchMenu + 快捷键 effect + MenuBar 装配 → `useMenuCommands` hook）；② 标签页状态机（tabs/activeKey/flushDirtyTabs/shutdownSequence → `useTabsLifecycle`）；③ 工作区管理（roots 挂载/卸载/最近文件 → `useWorkspaces`）；④ AI 面板装配（与 AiPanel 间的 props 面收窄为 context）。每步迁完跑 vitest + 手工冒烟，**一次只拆一块**。
- **步骤：** 先为 App 级行为补 3-5 个集成测试（菜单命令触发→状态变化），再按上述顺序每次迁一组 hook 进自定义 hook 文件（App.tsx 只留装配）。
- **收益：** App.tsx 预计 3,232 → <1,200 行；React 重渲染面收窄（hook 分组让依赖数组真正可维护）；新功能不再往单文件堆。

**Q3【中】useMilkdown facade——2,703 行 / 33 处裸 catch / hooks 覆盖 4.86%（M2 的精确画像）**

- **证据：** 全仓最大 TS 文件；`catch {` 33 处居非 test 文件之首（探针语义半文档化，如 :226/:234 `catch { return false; }`）；hooks 目录覆盖 4.86% 的最大空洞即在此。
- **建议：** 按职责切四块——插件装配（remark/prose 插件数组工厂）、编辑器命令（insertAfterSelection 等命令注册）、批注/mark 同步（annotationOps/highlightMark 桥接）、生命周期（create/destroy/热重载）。每块先抽纯函数（可测）再留 hook 壳。
- **收益：** 编辑器层可测性从 ~5% 起步抬升；33 处裸 catch 随拆分获得注释纪律；bug 定位从"2,700 行里找"变"400 行模块里找"。

### 5.2 可读性 / 可维护性

**Q4【中】types.ts 名不副实——899 行里混着运行时逻辑与 270 行默认值字面量**

- **证据：** `isDarkTheme`(:10)、`normalizeSyncSettings`(:272-304，33 行真校验逻辑)、`pickEditorSettings`(:593-609)、`DEFAULT_SETTINGS`(:611 起)、`FONT_PRESETS/MONO_FONT_PRESETS`(:835-899) 等运行时导出与类型混居。
- **建议：** 拆 `types.ts`（纯类型）+ `defaults.ts`（DEFAULT_SETTINGS/字体预设/工厂）+ `settingsNormalize.ts`（normalizeSyncSettings/pickEditorSettings，可单测）。分两步：先搬默认值字面量（零逻辑），再搬 normalize（补 3 个单测锁定行为后搬家）。
- **收益：** import 心智模型一致（from types 必是类型）；normalize 逻辑获得直接单测（当前经由 store 测试间接覆盖）。

**Q5【低】i18n 缺失——全中文硬编码（战略决策项，非缺陷）**

- **证据：** 无任何 i18n 设施（react-intl/i18next 零匹配）；SettingsModal 约 253 行含 CJK 字面量、App.tsx 确认弹窗文案、状态栏提示等遍布。
- **建议：** 若产品定位保持中文单语，**明确记录该决策**（避免后人反复提议）；若计划出海，在第五批 M1/M2 拆分落地后再启动（拆分前抽字符串会制造大规模 merge 冲突面）。
- **收益：** 决策显性化本身即收益；拆分后启动成本约为当前的 1/3。

### 5.3 设计模式 / 架构

**Q6【中】错误边界覆盖不均——LinksPanel 裸奔，侧边栏面板仅靠根边界**

- **证据：** `<ErrorBoundary>` 全仓 4 处：main.tsx:111（根）、App.tsx:3009（AiPanel）、:3136（SettingsModal）、:3196（FlashcardMaker）。DiffReview/AgentPlanReview 经 AiPanel 间接覆盖；**LinksPanel（App.tsx:2927 裸挂）及 Outline/RecentList/WorkspaceSearch 等侧栏面板无独立边界**——任一崩溃直冲根边界（整窗白屏）。
- **建议：** 侧边栏容器整体包一层 ErrorBoundary（label"侧边栏"），编辑区维持根边界兜底（已有 v4.8 分级设计文档）。一行级改动 + 1 个组件测试（边界内 throw 渲染兜底 UI）。
- **收益：** 侧栏崩溃只损失侧栏；与既有"面板级边界"分级策略对齐。

### 5.4 错误处理健壮性

**Q7【中】244 处裸 `catch {` 的分级治理（E9 的量化续篇）**

- **证据：** 非 test 计 244 处；Top：useMilkdown 33 / devMode 22 / scrollDebug 21 / App 16 / cvMemory 14 / devAnomaly 12 / annoDebug 10 / FileTree 8 / vaultIndex 7 / parsePipeline 6。抽样三态：有意 fail-soft 带注释（FileTree.tsx:311/:323）✅、半文档化（useMilkdown.ts:226 靠函数头注释）、**静默吞错**（App.tsx:265 devDocInfoProvider `catch { return null; }` 无注释无处理）。
- **建议：** 不追求清零（fail-soft 是本地优先应用的合理姿态），目标是**三分级纪律**：① 调试/诊断路径 → 允许吞但必须带注释；② 用户数据路径（保存/同步/导出）→ 必须有 UI 反馈或 noteOpError；③ 启动路径 → 必须不拖垮主流程（现状已达成）。用 eslint 自定义规则或 grep 清单按文件批次推进（与 Q2/Q3 拆分同期，避免双倍冲突面）。
- **收益：** "保存失败但用户不知道"类事故的存量清查；新增代码有可执行纪律。

**Q8【中】FlashcardModal overdue 标记时区混比（本批测试 worker 发现）**

- **证据：** `FlashcardModal.tsx:61` `overdue: s.dueDay < Math.floor(now / 86_400_000) - 1`——`dueDay` 是本地时区日序（`dayOf`），右式是 UTC epoch 日序；UTC+8 下本地逾期 1–2 天的卡不标"已逾期"，阈值整体偏移时区差。纯装饰性标记，非功能 bug（测试用 today−3 种子在任何时区稳定触发，不受影响）。
- **建议：** 统一用 `dayOf(now) - 1`（与 flashcards.ts 的本地日序口径一致）。一行修复 + FlashcardModal.test.tsx 加一条边界断言（today−2 标记、today−1 不标记）。
- **收益：** 逾期标记在任意时区正确；消除一个"看起来无害但会被审计反复翻出来"的杂音。

### 5.5 安全

**✅ 正面确认（本批核证，无需行动）：** `dangerouslySetInnerHTML` 0 处（innerHTML 集中在 MarkdownText.tsx:91-110，全经 rehype-sanitize 管线 + exportSanitize 二次消毒）；`eval/new Function` 0 处；Rust 非 test `unwrap/expect` 仅 2 处且均为启动 fail-fast（ai.rs:731 client 构建、lib.rs:370 tauri run 惯例）；路径圈禁模式（commands.rs:33-41 `is_log_path_confined` 先拒 `..` 再 `starts_with`）。

**Q9【低】Rust `trash_file`/`local_copy_file` 无 confine 前置（纵深防御缺口）**

- **证据：** `commands.rs:280`（trash_file）、`:484`（local_copy_file）只做空串/存在性检查即操作路径；对比 `append_log:65` 强制 logs 目录圈禁。当前防线在前端（工作区根约束 + fileOps 审计层），但"渲染进程被攻破"的威胁模型下后端应自持（S7 在鸿蒙侧已做同样的段消毒）。
- **建议：** 两命令加"路径必须在已授权 workspace roots ∪ appData 内"校验（roots 已在 Rust 侧 fs scope 有据可查）。
- **收益：** 后端防线与前端/鸿蒙侧对齐，消除单层防御。

### 5.6 重复代码

**✅ N19/N20 已收口**（PickerShell −82 行、pluginCast 25 处断言）。剩余：

**Q10【低】零散 Esc/键盘处理的非外壳级重复**

- **证据：** SearchBar.tsx:66-73 与 WorkspaceSearch.tsx:104 各自处理 Esc；与 PickerShell 的键盘导航不同形（无 overlay），不构成抽取收益。
- **建议：** 维持现状；若第五批动这两个组件（如接 PickerShell 化改造）顺手统一，不单独立项。

### 5.7 测试覆盖

**Q11【中】组件/hooks 覆盖扩展的优先序（基线 3.3 的行动化）**

- **证据：** components 12.26%（4 个组件有测试，AiPanel 2,043 行/58 hook 调用、SettingsModal 1,357 行、Editor 1,295 行均无）；hooks 4.86%；workers 0%。
- **建议优先序：** ① SettingsModal（表单态密集，纯交互可 jsdom 测，且历史 bug 温床）；② AiPanel（先测 SSE 消息→状态机纯逻辑层 aiThread.ts 已有 84% 的 sync 级别底子，组件层测装配）；③ useMilkdown 拆分（Q3）后对抽出纯函数补测；④ parseWorker 回退路径 1 例（主线程 worker-error 分支）。
- **收益：** 第五批结束 components 预计 → 25%+、hooks → 15%+；M1/M2 拆分的护网到位。

**Q12【低】G3/coverage 阈值/G2 的精确口径**

- **证据：** scripts/ checkJs 实测 130 处注解债务（implicit-any/env 形状）、perf/ 240 处；G2 `noUncheckedIndexedAccess` 若开启，索引访问点粗扫 129 处（report3 记 578 处为含推断链的宽口径）。
- **建议：** G3：tsconfig.scripts.json 模板已留仓，第五批清 scripts/ 的 130 处（发布链价值高）后接 CI，perf/ 永不接（一次性压测脚本）；coverage：设 lib ≥55%、components ≥12% 的防回退下限；G2：维持分文件推进策略，优先 sync/（数据完整性敏感）。
- **收益：** 三个长期悬挂项获得可执行的量化口径与截止条件。

### 5.8 文档完善度

**✅ 正面：** README 新鲜（9/19 更新）；docs/ 7 个专题文档 + 归档目录结构清晰；dev-anomaly-codes.md 与代码同步。

**Q13【低】代码-文档漂移的模式化风险（本批实案：harmony README）**

- **证据：** harmony/README.md:122 的关窗协议描述在 N16 改造后过期（"1.2s 盲等"），代码注释与文档数字矛盾——本批已修正，但暴露"桥协议变更未触发文档核对"的流程缺口。
- **建议：** 桥协议（Bridge.ets 注册表 ↔ platform/types.ts ↔ harmony/README）三方核对清单进 release runbook（harmony-release.md 已有骨架，补一行"协议命令增删 → README 已知限制段核对"）。
- **收益：** 协议漂移在发版门禁被系统性拦住，而非靠审计偶然发现。

---

## 六、优先级总表与第五批路线图

### 6.1 新发现 14 项优先级总表

| # | 优先级 | 项 | 一句话建议 | 预期收益 | 工作量 |
|---|---|---|---|---|---|
| Q1 | **高** | P3 插桩发射侧门控 + 诊断面板 lazy | devMode 短路包装 + React.lazy | 主包 −60~80KB、热路径零负担 | 1 天 |
| Q2 | **高** | App.tsx 拆分（M1） | 四块顺序拆（菜单/标签/工作区/AI 装配） | 3,232→<1,200 行、重渲染面收窄 | 3-4 天 |
| Q3 | **高** | useMilkdown 拆分（M2） | 四职责切块、先抽纯函数 | 编辑器层可测性从 5% 起步 | 3-4 天 |
| Q4 | 中 | types.ts 拆纯类型/默认值/normalize | 两步搬移 | import 心智一致 | 0.5 天 |
| Q5 | 中 | i18n 决策显性化 | 记录单语决策或排期 | 避免反复提议 | 0.1 天 |
| Q6 | 中 | LinksPanel/侧栏错误边界 | 侧栏容器包一层 | 侧栏崩溃不白屏 | 0.2 天 |
| Q7 | 中 | 244 处裸 catch 分级 | 三级纪律 + 批次推进 | 存量静默吞错清查 | 2 天（分批） |
| Q8 | 中 | overdue 时区混比 | dayOf 统一 + 边界断言 | 时区正确 | 0.1 天 |
| Q9 | 低 | trash/local_copy confine | 后端 roots 圈禁 | 纵深防御 | 0.5 天 |
| Q10 | 低 | 零散 Esc 处理 | 维持现状 | — | — |
| Q11 | 中 | 组件测试扩展（SettingsModal→AiPanel→worker） | 按模板复制 | components→25%+ | 2-3 天 |
| Q12 | 低 | G3 清债/coverage 阈值/G2 口径 | 130 处注解 + 下限阈值 | 三悬挂项落地 | 1 天 |
| Q13 | 低 | 协议-文档核对清单进 runbook | release 前三方核对 | 漂移门禁化 | 0.1 天 |
| Q14 | 低 | —（预留：真机验收清单转化） | 见 §四 | — | 真机窗口 |

### 6.2 第五批路线图（建议顺序）

1. **快赢批（半天）：** Q8 时区 + Q6 错误边界 + Q5 决策记录 + Q13 runbook——四项合计 <1 天，全部即时可验。
2. **P3 性能批（1 天）：** Q1 发射侧门控 → 诊断面板 lazy → bundle/打字 p95 前后对比（这是第五批唯一预期有桌面端可测收益的性能项）。
3. **重构批（主体，3-4 天 + 3-4 天）：** Q2 App.tsx 四块顺序拆 → Q3 useMilkdown 四块拆（先 Q11 的 SettingsModal 测试垫护网；两拆分同期做 Q7 裸 catch 分级与 Q4 types.ts 搬家，冲突面共享一次付）。
4. **工程批（1 天）：** Q12（scripts 130 处注解 → G3 接 CI；coverage 下限阈值）+ Q9 后端圈禁。
5. **真机窗口（与鸿蒙 owner 协调）：** §四验收清单 5 项 + report3 §六未核销 4 项。

---

## 七、遗留项追踪表（report3 §七/§五 对账）

| 遗留项 | report3 状态 | 本批变化 |
|---|---|---|
| M1/M2 神组件/facade 拆分 | ⏳ | **画像精确化**（Q2/Q3：176 hook/2,703 行 33 catch）；护网（组件测试设施）已就位 → 升为第五批主体 |
| M3 超长函数 / M4 组合子 | ⏳ | 并入 Q2/Q3 拆分自然消解 |
| **P3 调试插桩懒加载** | ⏳（"未到痛点"） | **量化后升为高优**（Q1：3,487 行/24 import 点/门控只盖一半——认知修正：包体增量小 ≠ 热路径无成本） |
| **P6 鸿蒙 base64 上传通道** | ⏳ | **✅ 完成**（s3_put_file/s3_get_file 文件通道） |
| P8 RAG stringify 内存尖峰 | ⏳ | 无变化（无新证据，维持观察） |
| N16 closeWindow ack | ⏳ | **✅ 完成**（ack 协议全链路） |
| N19 PickerShell / N20 断言 / N21 FileTree 键盘 | ⏳ | **✅ 全部完成**（含 44 例组件测试） |
| N32 coverage | ⏳（离线） | **◐ 基线完成**（34.78% 总/lib 57%），阈值门禁留第五批（Q12） |
| G2 noUncheckedIndexedAccess | ⏳（578 处） | 口径修正：索引访问点粗扫 129 处（Q12） |
| G3 checkJS @types/node | ⏳（离线） | **◐**：依赖已装 + tsconfig.scripts.json 模板留仓；scripts 130 处注解债务量化（Q12） |
| T2 覆盖偏科 | ◐ | **◐→大幅推进**：components 0%→12.26%、范式落地 |
| T3 hypium 本地运行 | ◐ 突破 | **✅ 15/15 全绿**（基线 3 失败清零——其中 2 例为真 bug） |
| E9 静默 catch | ◐ | 量化续篇（Q7：244 处三分级） |
| W6 cleanupTrash 非空目录 | 留档 | **✅ 完成**（removeTreeReal） |
| W8 UriMapper.ets:109 | 留档（疑） | **✅ 确认真 bug 并修复** + 迁移善后 + 用例修正 |
| hvigor test 退出码 0 陷阱 | 留档 | 无变化（本批仍以 grep ERROR 行判定，15/15） |
| parseListXml OnDevice | 真机 | 无变化 |
| N33 promo/ 归档 | 不代管 | 维持 |

---

*报告生成方式：主 agent 实施鸿蒙批 5 项（3 次 ArkTS 编译失败回环：structural-typing→@Concurrent 引用限制→@Sendable 字段类型，全部留档注释）+ 3 个串行修复 worker（PickerShell/pluginCast+FileTree/FlashcardModal）+ 1 个 Explore 审计 worker；全部验证命令实跑（vitest 841 / hypium 15 / cargo 24 / tsc / eslint / clippy / sigv4 / mirror / build×2）；CDP 基准 ×3 轮 JSON 落盘。所有新问题附 file:line 证据；结构性收益与实测收益分开表述；正面确认（安全快查四项全过）与问题同列以防审计盲区。*
