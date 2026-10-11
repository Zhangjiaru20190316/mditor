# Mditor 项目代码优化实施报告（第三批）

> **实施日期：** 2026-09-19
> **前置文档：** [`optimization_report.md`](./optimization_report.md)（58 项全量审计 + 第 1 批 24 项）、[`optimization_report2.md`](./optimization_report2.md)（第 2 批 17 项 + 21 项新发现）
> **本文范围：** 按 report2 §十二路线图实施第三批（3a + 3b 鸿蒙专项 + 中低顺手项，共 26 项），含对抗复核、回归修复、实测数据与出包记录
> **代码基线：** v4.15.0（第 3 批 26 项落地，NSIS 已出包）
> **编排方式：** `/workflow` 协议——8 个并行修复 worker + 3 个对抗复核 worker + 主 agent 门禁/打包/报告，过程留档 `.workflow/fix-batch3-mditor-20260919/`

---

## 目录

- [一、执行摘要](#一执行摘要)
- [二、实施记录（26 项）](#二实施记录26-项)
- [三、实测数据分析](#三实测数据分析)
- [四、对抗复核记录](#四对抗复核记录)
- [五、否决项与未实施项](#五否决项与未实施项)
- [六、待真机验收清单](#六待真机验收清单)
- [七、遗留项复核](#七遗留项复核)
- [八、第四批路线图](#八第四批路线图)
- [九、打包与验证记录](#九打包与验证记录)

---

## 一、执行摘要

本会话完成三件事：**① N1 发版链落定**——两批 41 项修复产物（124 文件）以 commit `f6647a8` 入库，`release.yml:33` 引用 `ci.yml` 的 404 风险消除；**② 第三批 26 项修复全部落地**（鸿蒙 11 项 / 前端 10 项 / CI 与工程 5 项，N1 单列），全程 8 worker 并行 + 3 worker 对抗复核；**③ 实测与出包**——全门禁绿（含新增 mirror-check、npm run build 两道门），1MB 文档七场景基准 ×3 轮热路径零回归，NSIS 出包 4.15.0。

三个最高杠杆结论：

1. **对抗复核抓到一个真回归并被修复：** N3（FlashcardModal 订阅失效）按 report2 的建议修法（tick 纳入 memo 依赖）与 `grade()` 的 `setIdx(i+1)` 叠加，产生"每评一张卡跳过一张"的回归（清单收缩滑入 + 手动前进双重计数）。修复为"仅当被评卡原位保留（dueDay 不变且仍到期）才手动前进"，tsc/eslint/vitest 806 全绿。**这正是"按建议清单修 bug"需要复核环节的实证。**
2. **report2 的 N6 对照物有偏差被修正：** 桌面端白名单不在 platform 层而在共享前端层 `Editor.tsx:785`（https?/mailto，无 tel）——鸿蒙桥白名单按真实口径对齐，而非 report2 表述的"platform/tauri 层白名单"。
3. **P9（watch 按目录 mtime 预筛）被否决：** 父目录 mtime 不随子文件**内容**修改而变化，预筛会漏报"外部编辑当前文档"这一主场景（v4.13.0 CHANGELOG 已记载该设计权衡）。仅落地 N8 最小版：`statOf` 三连系统调用（open+stat+close）改 `fs.statSync(path)` 直调，WatchManager 轮询成本降约 3×。

---

## 二、实施记录（26 项）

> 逐项效果与回归方式见[第三章](#三实测数据分析)；复核结论见[第四章](#四对抗复核记录)。✅ 完整实施 / ◐ 部分实施（原因随项注明）。

### 2.1 工程与发布链（N1 / N7 / N29 / N30 / N31 / N23）

| 项 | 内容 | 关键证据 |
|---|---|---|
| N1 ✅ | 两批产物落库：`git add -A` 收齐 27 untracked + 63 modified，保留"私人文件出索引"的 staged 删除；commit `f6647a8`（124 文件，+23,282/−2,425） | 发版门禁 `release.yml:33`→`ci.yml` 引用链完整 |
| N7 ✅ | pages.yml 四个 action 全部钉 40 位 SHA（GitHub API 双端点交叉验证）：checkout `11bd719…`、configure-pages `983d773…`、upload-pages-artifact `56afc609…`、deploy-pages `d6db9016…`；新增 `check` job 复用 ci.yml 门禁，deploy `needs: [check]`——坏代码不再直上官网 | `.github/workflows/pages.yml` |
| N29 ✅ | ci.yml 加 `permissions: contents: read`（workflow_call 复用时 callee 只能降权，release 的 write 由 publish job 自持，发布链不受影响）；新增 windows-latest Rust job——**secrets.rs（Credential Manager FFI）首次进 CI 编译验证** | `.github/workflows/ci.yml` |
| N30 ✅ | pages.yml 部署前注入最新版本号（`gh api …/releases/latest` → sed 按锚定模式替换下载文件名/徽标/wn-ver 三类标记，历史版本与日期零误伤；fallback `git describe`；资产缺失软告警）——下载链接不再随发版漂移 404 | site/index.html:49/54/71 |
| N31 ✅ | ci.yml 前端门禁加 `npm run build`（= tsc + vite build）——生产构建回归不再等出包才暴露 | ci.yml 前端步骤 |
| N23 ✅ | 新增 `scripts/mirror-check.mjs`：SigV4 双侧镜像（S3Bridge.ets ↔ sigv4-check.mjs）按"标识符指纹序列"比对 5 对函数（uriEncode/uriEncodePath/amzDateOf/canonicalQueryOf/canonicalRequestOf），单侧改逻辑即 FAIL、双侧同步改 PASS、注释/字符串剥离稳健（蓄意破坏自验：单侧改字符/删函数→FAIL→还原→PASS→同步改→PASS）；已接进 ci.yml 前端门禁 | 本地 exit 0 零误报 |

### 2.2 前端正确性与健壮性（N3 / N4 / N11 / N12 / N14 / N15 / N17 / N18 / N9 / N10）

| 项 | 内容 | 回归 |
|---|---|---|
| N3 ✅ | FlashcardModal 订阅-记忆化脱节修复：`recompute`/`tick` 计数器可读化并纳入 `snapshot` 的 useMemo 依赖（`:71-77`），索引/复习进度变化现会重算到期清单。**伴随修正**（R2 复核发现的回归）：`grade()` 改"仅当被评卡原位保留（`isDue` 且 `dueDay` 不变，稳定排序不位移）才 `setIdx(i+1)`"，否则让清单收缩的滑入自然前进——否则每评一卡跳一张 | 修复回退心理推演（R2）；组件无测试设施，代码路径级验证如实记录 |
| N4 ✅ | QuickSwitcher `trimRoot` 字符下标误作数组下标修复：改尾部两层语义（`parts.slice(-2)`，对齐 WikiLinkSuggest `shortPath` 写法）；导出为纯函数。已知微瑕疵：路径以 `/` 结尾时显示 `…b/`（R2 记录，无 crash） | QuickSwitcher.test.ts ×4（根级/单层/深层/裸名） |
| N14 ✅ | RecentList `loadRecent().then` 补 `.catch`（与 QuickSwitcher 同款兜底） | — |
| N11 ✅ | App.tsx `file_save_as` 分支补 `.catch` + `flashStatus("另存为失败", 5000)`（与 `file_save` 分支对齐） | — |
| N12 ✅ | FileTree `noticeTimerRef` 补 unmount 清理 effect（范式抄 TabsBar:73-79） | — |
| N15 ✅ | WikiLinkSuggest：keydown 回调经 `pickRef` 镜像取最新值（effect 依赖改写为 `[open, close]`，**eslint-disable 移除**）；dedupe 由只比 `items.length` 改为逐条比 `path` | tsc/eslint |
| N17 ✅ | `isDarkTheme(theme)` 谓词入 `types.ts`（Theme 类型旁）作单一事实源；App.tsx:1746 与 MarkdownText.tsx:87 两处三连枚举收编；新增主题漏改时由断言表钉死 | types.test.ts ×2（7 主题全断言，`Record<Theme, boolean>` 编译期穷尽） |
| N18 ✅ | vaultIndex `setRoots` 拆分：`rewatch()` 仅随 roots 变化执行（excluded-only 变化不再全量拆重建 watch）；excluded 变化触发 rebuild，被排除文件经 keep-set 剔出索引（缩小 excluded 重新入索引进索引路径验证 ✓） | vaultIndex.test.ts ×3（剔除生效/watch 计数不变/roots 变化仍重建） |
| N9 ✅ | vaultIndex `entries()` 改缓存快照 + `Object.freeze`（bump 失效；byPath 全部 4 个变更点均随 bump）。**决策依据：** 全仓消费点逐一核实无就地 mutate（QuickSwitcher 排序作用于 map/filter 副本、FlashcardModal/ragIndex 仅遍历） | 消费点清单见 `.workflow/.../task-W3-vaultindex.md` |
| N10 ✅ | AnnoDiagnostics 事件合并抽 `mergeEvents` 纯函数 + useMemo（依赖三总线版本信号），copyReport 复用同函数——3×300 环形缓冲不再每次渲染全量重排 | bump→tick+1→重算链路实证（R2） |

### 2.3 鸿蒙端（N2 / N13 / N8 / N27 / N6 / N24 / N25 / N26 / N28 / N22 / N5 部分）

| 项 | 内容 | 备注 |
|---|---|---|
| N2 ✅ | `FileManager.remove` 读取 `params.recursive`（缺省 false，非 boolean 安全降级）；recursive=true 且目录走新增 `removeTreeVirtual` 后序递归删除（复用 copyTreeVirtual 遍历骨架 + UriMapper 编解码 + wrapFsError 包装）；recursive=false 与文件目标行为与基线逐字一致（R1 确认） | 前端 `platform/harmony/index.ts:87` 语义兑现 |
| N13 ✅ | trashFile 跨边界回退：原件删除（rmdirSync/unlinkSync）包 `wrapFsError`（已是 BridgeError 原样上抛保码）；失败先 `cleanupTrashArtifact` 清回收站副本（清理失败吞掉不掩盖原错误）；目录分支升级递归删 | Bridge.ets 错误模型对齐（R1 确认） |
| N8 ◐ | `statOf` 改 `fs.statSync(path/URI)` 直调（open+stat+close 三连→1 次系统调用；stat 自 API 22 支持 URI，项目 compatibleSdkVersion=6.0.2(22)）；签名/返回结构/错误包装不变，7 处调用链核对。**TaskPool 全量迁移遗留**（本批明确不做） | WatchManager 轮询成本降 ~3× |
| N27 ✅ | appendLog 轮转判据 UTF-16 码元 → UTF-8 字节数（`utf8ByteLen` 与 S3Bridge.utf8Bytes 逐字同款，util.TextEncoder 按码元展开代理对）；中文不再系统性偏早触发轮转 | 与 Rust 字节轮转语义对齐 |
| N6 ✅ | `app.openExternal` 加 scheme 白名单 `/^(https?:\|mailto:)/i`（对齐共享前端层 Editor.tsx:785 口径——**非 report2 表述的 platform 层**）；不匹配抛 `BridgeError('E_ARGS')`；两处前端调用方均有同款前置过滤或 try/catch，无破坏 | R3/主 agent 确认 |
| N24 ✅ | `windowToggleMaximize` 真双向：`maximize()` ↔ `recover()`（**d.ts 语义勘误：undo-maximize 是 recover()，restore() 是"从最小化恢复"**，W7 经官方文档 + 开源 ArkTS 代码交叉验证）。初版用 `windowStatusType` 实时查态，**本机 SDK 22 d.ts 无此属性编译失败**——主 agent 修复回环改桥内布尔 + `recover()`，失步限制（双击标题栏绕过桥）注释留档 | `hvigorw assembleHap` PASS |
| N25 ✅ | SettingsStore `keyOf` 裸 Error → `BridgeError('E_ARGS')`（Bridge→SettingsStore 单向依赖无成环） | 桥层错误码归一 |
| N26 ✅ | S3Bridge `parseCfg` 前置校验 region/accessKeyId/secretAccessKey 非空，缺失列全字段名抛 E_ARGS（空配置不再跑到签名时才产误导性 SYNC-003） | 错误码口径：配置缺失属调用方参数问题，对齐桌面 serde 行为 |
| N28 ✅ | EntryAbility hilog 域 5 处统一 `DOMAIN`(0x0D01)（含 0x0000 字面量） | — |
| N22 ◐ | LocalUnit.test.ets 新增 9 用例（AiBridge：parseStreamChunk ×3 / mergeToolCallDeltas ×2 / finalizeToolCalls；S3Bridge：validateKeyError / mapStatusError / xmlDecode+stripEtagQuotes），**9/9 实际执行 PASS**（有效命令 `hvigorw --mode module -p module=entry@default -p isLocalTest=true test`）。**parseListXml ⏳：** 本地单测宿主对 kit API 是无实现 stub（`util.TextEncoder.encodeInto` 返回空→解析恒 0 条），降级为纯字符串子件覆盖，真机项 | kit import 编译无碍、运行时 stub 阻碍——根因链留档 task-W8 |
| N5 ◐ | hap-sign-tool 经 `--help` + **反编译全 jar** 确认不支持口令文件/stdin/env（仅 `-keyPwd/-keystorePwd` argv；`-extCfgFile` 是未接线保留字）——argv 保留，兜底：两脚本 `run()` 包 try/catch，对 message/stdout/stderr/cmd（string/Buffer 双形态）脱敏 `******` 后 exit(1)；`windowsHide: true`；成功路径 stdio inherit 不变。**泄漏向量实测复现**（故意失败调用 `e.message` 确含 spawnargs 口令→脱敏生效） | CONTRIBUTING.md 补 5 行局限说明 |

---

## 三、实测数据分析

### 3.1 质量矩阵（第 2 批后 → 第 3 批后）

| 门禁 | 第 2 批后（v4.14.0） | 第 3 批后（v4.15.0） |
|---|---|---|
| vitest | 797 通过 / 73 文件 | **806 通过 / 74 文件**（+9：N4 ×4、N17 ×2、N18 ×3） |
| cargo test | 24 通过 | 24 通过（本批零 Rust 改动） |
| hypium（LocalUnit） | 6 例（仅 UriMapper） | **15 例**（+9 鸿蒙纯函数，9/9 实际执行 PASS；基线 3 例 CLI 环境本就 FAIL，非本批引入，见 §五） |
| `tsc --noEmit` | 0 错 | 0 错 |
| eslint（含 scripts） | 0 错 0 警 | 0 错 0 警 |
| `cargo clippy -D warnings` | 0 | 0 |
| sigv4-check oracle | PASS | PASS |
| **mirror-check（新门禁）** | — | **5 对 PASS** |
| **`npm run build`（新门禁）** | — | **PASS**（vite 16.25s） |
| `hvigorw assembleHap` | PASS（7,807KB） | **PASS（7,825KB，+18KB）** |
| `npm run tauri build` | PASS | **PASS** |

### 3.2 运行时基准（1MB 压测文档 1,649 块，七场景，与 batch2 同法同 fixture）

| 轮次 | open (ms) | 点击 p95 (ms) | 打字 p95 / max (ms) | 打字长任务 | 滚动 p50/p95 (ms) |
|---|---|---|---|---|---|
| batch2-r1 / r2（第 2 批后） | 3,495 / 2,918 | 96 / 96 | 88–96 / 96 | 0 | 6 / 35 |
| **batch3-r1（本批后）** | 3,211 | 96 | **96** / 104 | 0 | 4 / 33 |
| **batch3-r2（本批后）** | 3,267 | 112 | 392 / 400 ⚠️ | 0 | 4 / 33 |
| **batch3-r3（复测）** | 3,278 | 104 | **96** / 104 | 0 | 4 / 33 |

**结论：** 打字 p95 r1/r3 = 96ms，处于第 2 批后 B 臂带（88–96ms）上缘、仍优于第 1 批前 A 臂（96–104ms）；打字/点击/滚动期长任务均为 0；open 3,211–3,278ms 在历史方差带（2,893–3,495ms）内；滚动 p50/p95（4/33ms）与历史（6/31–36ms）持平微优。r2 打字 392ms 为 24 个事件中 1 个单点尖峰——加跑 r3 回到 96ms 确认偶发，与第 1 批方法论记载的"同代码跨时段整机负载漂移（96→816ms）"现象一致，**不作为回归信号**。**第三批 26 项改动对热路径零回归**——符合本批"正确性与跨端一致性收益、不碰热路径"的设计意图。原始 JSON：`mditor/perf/results/batch3-r{1,2,3}.json`。

> **诚实性说明：** 本批收益是**结构性的**（数据正确性、跨端语义一致、发版链完整性、测试与守卫资产），不打字/滚动等热路径无可测提升；第 1 批的 P1/P2 才是热路径收益来源。

### 3.3 产物体积

| 指标 | 4.13.0 | 4.14.0 | 4.15.0 | Δ（4.14→4.15） |
|---|---|---|---|---|
| NSIS 安装包 (B) | 5,886,382 | 5,895,423* | **5,896,722** | **+1,299（+0.02%）** |
| 鸿蒙 HAP (KB) | 7,807 | — | **7,825** | +18（ArkTS 4 项行为修复） |

\* 磁盘现存值；report2 记录为 5,894,925（差 498B，属出包时间戳级差异，不影响结论）。

---

## 四、对抗复核记录

> 复核员独立读 diff 验证，三态结论（确认/驳回/存疑）；全文见 `.workflow/fix-batch3-mditor-20260919/review-0{1,2,3}-*.md`。

| 复核 | 范围 | 结论 |
|---|---|---|
| R1 | W6 FileManager（删除/回收站/日志轮转，数据安全敏感面） | **6 确认 / 0 驳回 / 1 存疑**（存疑仅为某注释的事实性前提，不影响代码行为）。5 条非阻断风险留档：7-A 大树删除中断的数据窗口、7-B rmdirSync 语义前提、7-C 符号链接、7-D EISDIR 中断、7-E 错误文案 |
| R2 | W3 vaultIndex 行为变化 + W1 浮层修复 | **6 确认 / 1 回归**——N3 修复引入自评跳卡（清单收缩滑入 + `setIdx(i+1)` 双重前进）。**已修复**（`staysInPlace` 判据，§2.2 N3），修复后 tsc/eslint/vitest 806 全绿。另记录：trimRoot 尾部 `/` 微瑕疵、AnnoDiagnostics 新增 1 处有注释的 disable |
| R3 | W7 桥改动 + 全部 workflow/签名/mirror-check | **5 确认 / 0 驳回 / 1 存疑**（两条低危备注：sed 未转义 VER 中 `&`/`\`——现实 tag 形态不可触发；windows job 无 npm ci——依赖错误会即时红非静默）。mirror-check 经只读变异实验验证检测力 |

**流程资产沉淀：** 本次"worker 修复 → 主 agent 门禁 → 对抗复核"链条实测抓出 1 个门禁抓不到的行为回归（组件无测试设施）+ 1 个编译期 SDK 兼容问题（N24）。组件级修复（无测试护网）的复核价值得到实证。

---

## 五、否决项与未实施项

| 项 | 处置 | 理由 |
|---|---|---|
| **P9 watch 目录 mtime 预筛** | **否决** | 父目录 mtime 不随子文件**内容**修改变化，预筛漏报"外部编辑当前文档"主场景（v4.13.0 已记载该设计权衡：有意全量对比）。N8 最小版已把单条目成本降 ~3×，全量 stat 语义保留 |
| N16 closeWindow ack 协议 | ⏳ | 需跨端协议设计（前端 ack 事件），鸿蒙 UI 行为本机不可验证，留真机窗口 |
| N19 PickerShell / N20 类型断言收口 / N21 FileTree 键盘可达 | ⏳ | 纯重构、无测试护网（全仓无组件测试设施），与第 4 批 M1/M2 拆分同期收益更好 |
| N32 vitest coverage | ⏳ | 需 npm 安装 @vitest/coverage-v8，本机离线 |
| N33 promo/ 归档 | 不代管 | 用户本机文件（已 gitignore），不代做文件处置 |
| W6 新发现：`cleanupTrash`(:604) 非空目录仍单删 | 留档 | 报告未列项，超本批范围；建议下批改走 `removeTreeVirtual` |
| W8 新发现：UriMapper.ets:109 沙箱路径疑缺 `/` 分隔符 | 留档 | 基线既有 CLI 环境测试失败（非本批引入），疑似真 bug 待 owner 真机决断 |
| W8 工程发现：hvigor test 断言失败退出码仍为 0 | 留档 | 若未来把 hvigorw test 接进 CI，须 grep `ERROR: Error in` 而非只看退出码 |

---

## 六、待真机验收清单

| 项 | 验收点 |
|---|---|
| N2 | 鸿蒙删除含子目录的工作区文件夹（recursive=true 路径）成功且不留残件 |
| N13 | trashFile 跨边界回退在非空目录下：回收站副本存在、原件递归删除、错误码 E_IO/E_PERMISSION 而非 E_INTERNAL |
| N24 | 菜单触发窗口最大化↔还原双向切换（含 recover() 行为） |
| N8 | `/Docs` URI 条目 statSync 直调冒烟（URI 形态 vs 沙箱路径） |
| N22 | parseListXml OnDevice Test（本地宿主 kit stub 不可行） |
| N26 | 空凭证配置的报错文案（SYNC 前置校验） |

---

## 七、遗留项复核（report2 §十一 ⏳ 项现状）

| 项 | 状态 | 本批变化 |
|---|---|---|
| M1/M2 神组件/facade 拆分、M3 超长函数、M4 组合子 | ⏳ | 维持第 4 批路线；P10/P11（第 2 批）+ N17（单一事实源）继续在外围减负 |
| M5 其余项 | ⏳ | 无变化 |
| P3 调试插桩懒加载 | ⏳ | 包体 +0.02%，未到痛点 |
| P6 鸿蒙 base64 上传通道 | ⏳ | 并入鸿蒙性能批（与 N8 TaskPool 同窗口） |
| P8 RAG stringify 内存尖峰 | ⏳ | 无变化 |
| R1/R2 协议层重复 | **◐ 推进** | **N23 mirror-check 落地**——SigV4 双侧镜像从"纪律"变"门禁"；R1 剩余（hypium 向量）N22 落地 9 用例 |
| T2 覆盖偏科 | ◐ | +9 vitest +9 hypium；组件层测试设施仍缺（jsdom/testing-library 待装） |
| T3 hypium 本地运行 | **◐ 实质突破** | 有效命令实锤 + 9/9 PASS（此前 0 执行）；kit stub 边界已探明 |
| E9 全量静默 catch | ◐ | N11/N14 再收 2 处 |
| S2 macOS Keychain / 鸿蒙 HUKS | ◐ | 架构就绪不变 |
| G2 noUncheckedIndexedAccess | ⏳ | 578 处不变 |
| G3 checkJS @types/node | ⏳ | 离线不变 |

---

## 八、第四批路线图

1. **鸿蒙性能批（两天 + 真机窗口）：** N8 TaskPool 迁移 + P6 base64 通道 + cleanupTrash 递归删补齐 + N16 ack 协议 + §六清单验收。
2. **重构批（配合测试设施先行）：** 安装 jsdom/@testing-library（补组件测试护网）→ N19 PickerShell 抽取 → N20 断言收口 → N21 FileTree 键盘可达 → M1/M2 拆分 → P3 插桩懒加载。
3. **工程批（离线解除后）：** G3 @types/node + N32 coverage 阈值基线 + G2 578 处 noUncheckedIndexedAccess 分文件推进。
4. **零散决断项：** UriMapper.ets:109 真伪判定（真机 stat 冒烟）、7-B 注释前提核对、E_ARGS 错误文案统一审。

---

## 九、打包与验证记录

- **版本：** 4.15.0 四处对齐（package.json / Cargo.toml / tauri.conf.json / app.json5 versionCode 1001500）；site/index.html 三处当前版本标记同步（:49 下载文件名 / :54 徽标 / :71 wn-ver，历史版本串不动）；CHANGELOG 按根因级惯例记档。
- **产物：** `mditor/src-tauri/target/release/bundle/nsis/Mditor_4.15.0_x64-setup.exe`（5,896,722 B，较 4.14.0 +1,299 B / +0.02%）；`harmony/entry/build/default/outputs/default/entry-default-unsigned.hap`（7,825 KB）。release profile 维持 lto + codegen-units=1 + strip + panic=abort。
- **打包前门禁（= ci.yml 全部门禁本地预演）：** vitest 806/806 · tsc 0 错 · eslint 0/0 · cargo fmt + clippy -D warnings 0 + test 24 · sigv4 oracle PASS · **mirror-check 5 对 PASS** · **npm run build PASS** · build:harmony PASS · hypium 9/9 新用例 PASS。
- **冒烟：** dev 实例（CDP 9223）启动正常，七场景基准完整跑通三轮（§3.2），undo 收尾恢复原文；基准后 dev 进程/端口清理完毕（1420/9223 释放）。
- **过程留档：** `.workflow/fix-batch3-mditor-20260919/`（meta.json + 8 份 task-*.md + 3 份 review-*.md + 本报告 synthesis）。

---

*报告生成方式：8 个并行修复 worker（文件所有权互斥）+ 主 agent 门禁/修复回环（N24 编译错误、N3 跳卡回归）+ 3 个对抗复核 worker + 3 轮 CDP 基准 + NSIS/HAP 出包。所有新问题附 file:line 证据；实测数据 JSON 与复核全文可追溯；结构性收益与实测收益分开表述（见 §3.2 诚实性说明）。*
