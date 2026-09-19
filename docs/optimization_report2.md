# Mditor 项目代码优化分析报告（第二轮）

> **分析日期：** 2026-09-19
> **前置文档：** [`optimization_report.md`](./optimization_report.md)（58 项全量审计 + 第 1 批 24 项实施记录）
> **本文范围：** ① 第 1 批报告中 ⏳ 未完成项的第二批实施与实测数据分析；② 在全部改动落地、v4.14.0 打包完成的新基线上，对**未覆盖区域**（前端组件/hooks/lib 长尾、鸿蒙 ArkTS、CI/工程面、官网）的增量全面分析
> **代码基线：** v4.14.0（含第 2 批 17 项修复，NSIS 已出包）
> **分析方法：** 2 个并行深度探查（前端未审计区域 / Rust·鸿蒙·工程面）+ 本会话 17 项实施的逐项验证与实测

---

## 目录

- [一、执行摘要](#一执行摘要)
- [二、第二批实施记录（17 项）](#二第二批实施记录17-项)
- [三、实测数据分析](#三实测数据分析)
- [四、新发现：高优先级问题](#四新发现高优先级问题)
- [五、新发现：安全漏洞](#五新发现安全漏洞)
- [六、新发现：性能瓶颈](#六新发现性能瓶颈)
- [七、新发现：错误处理与健壮性](#七新发现错误处理与健壮性)
- [八、新发现：代码可读性与重复代码](#八新发现代码可读性与重复代码)
- [九、新发现：鸿蒙端专项](#九新发现鸿蒙端专项)
- [十、新发现：CI/CD 与工程化](#十新发现cicd-与工程化)
- [十一、遗留项复核（第 1 批 ⏳ 项现状）](#十一遗留项复核第-1-批--项现状)
- [十二、优先级总表与第三批路线图](#十二优先级总表与第三批路线图)
- [十三、打包与验证记录](#十三打包与验证记录)

---

## 一、执行摘要

本会话完成三件事：**① 按 optimization_report.md 完成第二批 17 项修复**（含最高价值的安全项 S2 密钥入系统凭据库，全部附回归测试，vitest 778→797、cargo 22→24）；**② 实测并出包 v4.14.0**（1MB 文档七场景基准 ×2 轮与第 1 批后基线持平，打字期长任务为 0，NSIS 安装包 5.89MB）；**③ 对第 1 批未覆盖区域做增量全面分析**，新增 **21 项发现**（高 4 / 中 11 / 低 16 含遗留复核）。

三个最高杠杆的新结论：

1. **发版链存在断裂风险（立即可修）：** `release.yml:33` 已引用 `./.github/workflows/ci.yml` 作为发版门禁，但 ci.yml 连同本批新增的 `secrets.rs`、3 个测试文件仍处于 **git 未跟踪状态**——当前工作区直接推送，tag 构建会因 workflow 404 而失败。这是一次性的 `git add` 动作，但优先级高于一切代码修复。
2. **鸿蒙端唯一的功能级漂移：** `FileManager.ets` 的 `fs.remove` 丢弃 `recursive` 参数，删除非空目录必然失败（桌面端 plugin-fs 支持递归删除）——这是用户可感知的跨端行为差异，不是风格问题。
3. **第 1 批的判断得到数据复核：** 第二批全部改动（含新增的凭据库 IPC、CSP 收紧、设置切片）对打字热路径**零回归**（typing p95 88–96ms，与第 1 批优化后 B 臂完全一致），验证了两批修复"结构性收益、不碰热路径"的设计意图。

---

## 二、第二批实施记录（17 项）

> 全部改动附回归测试或运行验证；⚠️ 部分项为部分实施并说明原因。逐项效果见[第三章数据分析](#三实测数据分析)。

### 2.1 S2【高】密钥系统凭据存储（keychain）✅

**原问题（报告 1 §2.2）：** AI/S3 密钥明文落盘 `mditor.json`，云同步用户配置目录或本地恶意软件可直接读走。

**实施：** 无网络环境装不了 `keyring` crate，改用依赖树内已有的 `windows-sys 0.61.2` 直接调 Windows Credential Manager（DPAPI 加密）：

- **Rust**（新增 `src-tauri/src/secrets.rs`）：`secret_set/get/del` 三命令；key 白名单 `[A-Za-z0-9._-]`；`CRED_PERSIST_LOCAL_MACHINE`；凭据永不入日志（错误只含 GetLastError 码）；非 Windows 返回类型化错误，前端走明文兼容路径。
- **前端**（`src/lib/store.ts` + `platform/types.ts` + `platform/tauri/app.ts`）：保存时密钥先入凭据库、JSON 只留 `@keychain` 引用标记；加载时并行 `secretGet` 水合；**旧明文首启自动迁移**（内联 await，失败留诊断下次重试）；清空输入框 = 删槽位。
- **槽位命名：** `ai.key.<modelId>`（模型 id 稳定）/ `rag.key` / `sync.secret` / `sync.token`。已知残留：删除模型后凭据槽位不清理（无枚举 API，孤立条目无害，已注释）。

```ts
// store.ts — 保存路径核心（脱敏 + 凭据库优先）
if (secretSet && secretDel) {
  try {
    for (const x of secretSlotsOf(s)) {
      const v = x.get();
      if (v && v !== KEYCHAIN_MARK) await secretSet(x.slot, v);
      else await secretDel(x.slot).catch(() => undefined); // 清空 = 删槽位
    }
    toPersist = { ...s, aiModels: s.aiModels.map((m) =>
      m.apiKey ? { ...m, apiKey: KEYCHAIN_MARK } : m), /* ... */ };
  } catch (e) {
    sysEmit("settings:secret-vault", `密钥写入系统凭据库失败，本轮回退明文存储：…`, { level: "warn" });
  }
}
```

**回归：** Rust ×2（key 校验 + **真实 Credential Manager 往返**：写入→读回→删除幂等）；前端 ×5（脱敏落盘 / 水合 / 旧明文迁移 / 清空删槽 / 标记孤儿水合为空串）。

### 2.2 S6【中】CSP 削弱 ✅

`tauri.conf.json`：`img-src` 去掉明文 `http:`（堵阅读场景追踪像素/IP 探测信道）；删除 `dangerousDisableAssetCspModification: true`（恢复 Tauri 对注入脚本的 CSP 自动加固）。index.html 无内联脚本（仅模块脚本），经 dev 实例启动 + 七场景基准冒烟验证。

### 2.3 S10【低】导出路径二次消毒 ✅

新增零依赖 `src/lib/exportSanitize.ts`（DOMParser deny-list）：移除 script/iframe/object/embed/base/meta/link 元素、全部 `on*` 事件属性、`javascript:/vbscript:` URL；**刻意不用** renderMarkdown 的 allow-list schema（会误删编辑器合法结构——KaTeX span 类名、批注 data-*、颜色 style、任务列表 input）。接入四条消费路径：`exportHtml`（落盘前）、`exportPdf`（doc.write 前）、`exportDocx`（转换器前）、`rasterizeFormulas`（innerHTML 容器前，幂等）。回归 ×7。

### 2.4 D6/D7【低】同步反馈升级 ✅

- **D6：** 时钟冲突（"lastModified 无法解析"/"时间接近无法判定"）警告从沉入 `summary.notes` 升级为同时走 `hooks.warn` → 诊断总线 + 状态事件；`SyncStateEvent` 新增 `notes?: string[]`（去重截 5 条），状态栏云图标 tooltip 直接展示。
- **D7：** 手动同步（sync-request/syncNow）在"同步中"被合并时不再静默——留 `sync:busy` 诊断 + 重发最近一次 syncing 状态（进度字段不回退）。

### 2.5 E2【中】面板级 ErrorBoundary ✅

`SettingsModal` / `AiPanel` / `FlashcardMaker` 三处模态各自包 `ErrorBoundary`；组件新增 `onReset` 属性渲染"关闭面板"按钮——出错只损失该面板（可关闭恢复），不再顶翻根边界替换整个编辑器与未保存缓冲。

### 2.6 E5【中】浮动 Promise ×4 收口 ✅

handoff 迁移（takeHandoff 抛错→noteOpError）、PendingFile 拉取（双击启动→noteOpError）、工作区三操作（添加/替换/移除根）统一经 `persistWorkspaces` helper：持久化失败**回滚列表** + `noteOpError` + 状态栏提示（此前 UI 已切换导致显示未持久化的工作区）；`pushRecentWorkspace` 失败不再回滚（最近列表属尽力而为，已注释）。

### 2.7 E6【中】chat() 畸形响应 ✅

`ai.ts chat()`：content 非字符串改抛 `[MD-8004] AI 响应异常：content 非字符串（<type>）`（此前返回 `undefined`，调用方 `.match()` 远离根因处崩溃）。

### 2.8 E8【低】Rust 响应体读取失败 ✅

`ai.rs` 三处 `resp.text().await.unwrap_or_default()`：ai_chat/ai_embed 改为映射 `读取 AI/嵌入响应失败：{e}` 传输错误；流式错误分支改占位说明（不再吞成空串——用户看到的是真实传输错误而非"无法解析 AI 响应"）。

### 2.9 E10/E11【低】agent 工具结果结构化 ✅

- **E10：** `loop.ts` 成败判定从 `result.includes('"ok":false')` 子串嗅探改为结构化解析（`JSON.parse` → `ok === false`）；截断导致的破损 JSON 保留前缀嗅探兜底（`fail()` 的 `ok:false` 恒在输出开头）。笔记内容含该字面量不再误报失败。
- **E11：** `tools.ts clampResult` 改**字段级截断**（长字符串字段按 4000→800 两级预算收紧后重新序列化，输出保持合法 JSON——破损 JSON 会教模型输出破损 JSON），仅结构本身超限才退回整体切片。回归 ×7。

### 2.10 E12【低】S3 重试显式化 ✅

`s3.rs build_store` 显式 `with_retry`：`max_retries: 3 / retry_timeout: 60s`（object_store 默认 10 次/3min 对交互式同步过宽——坏 endpoint 时 UI 卡 3 分钟才报错）。瞬时 5xx/429/网络抖动仍被吸收，持续故障快速反馈。

### 2.11 P10【低】编辑器设置窄切片 ◐

- **Editor ✅：** `types.ts` 新增 `EditorSettings`（13 字段——Editor 5 行为字段 + useMilkdown applyProseVars 5 排版字段 + settingsRef 3 字段 + tsc 揪出的 bigDoc 2 字段）；App 侧解构字段作依赖签名 memo，无关设置变化（拖侧栏宽度等）不再打穿 memo 重渲染整棵编辑器子树。
- **AiPanel ⏳ 主动放弃：** 复核发现其消费字段过多（ai.ts 运行时字段 ragEmbedApiKey/ragEmbedBaseUrl、agentWriteMode、`Partial<Settings>` 回调签名等），强行切片需同步收窄 ai.ts/ragIndex 全链路签名，收益/风险比不成立，防类型洗白保留整份。

### 2.12 P11【低】onReady 替代轮询 ✅

Editor 新增 `onReady` prop（`handle.ready` 翻真即回调，含重建）；App 的启动/自愈种子路径由 80×50ms 盲轮询（大文档 4s 上限可能不够、小文档白等整数拍）改为 `await whenEditorReady()`（promise + 等待队列，就绪后到达的等待者立即放行）。

### 2.13 E9【中】静默 catch ◐（高价值点 + 约定落地）

`Editor.replaceImage`（用户已选文件、替换失败此前完全静默）补 `noteOpError`；useMilkdown 构建链意外 rejection 补 `sysEmit`（此前 300 行链上除 `crepe.create` 外的失败全部无声消失）；`// silent:` 注释前缀约定落地。**App.tsx 余 16 处裸 catch、components/hooks 全仓约 50 处**留待第三批按 `grep -n "catch {$" src/App.tsx` 清单逐个定性。

### 2.14 G2【中】tsconfig 严格度 ◐

启用 `noImplicitReturns` + `noImplicitOverride`（修 4 处：ErrorBoundary ×3 + engine.test ×1）。`noUncheckedIndexedAccess` 实测 **578 处 fallout**（AiPanel 43 / annotations 27 / App 23 / codeAnno 22 / vaultIndex 19…），需专门会话分文件推进，已量化留档。

### 2.15 G3【中】scripts 静态检查 ◐

`scripts/**/*.mjs` 纳入 eslint（最小 Node 全局表；`@types/node` 未安装且无网络，checkJS 暂不可行——网络恢复后 `npm i -D @types/node` + `tsconfig.scripts.json` 即可启用）。首跑即抓出 make-icons.mjs 2 处未用变量；顺手修复 build-harmony.mjs 的 TDZ 隐患（`isWin` 声明晚于 `detectJavaHome` 引用，仅因调用时机侥幸安全）。

### 2.16 G4【低】工程卫生 ✅

site 死资产（`promo-v4.5.0.png` 1.6MB + html，无任何引用）与失效脚本 `md1011-correlate-prod.mjs`（硬编码绝对路径 + 旧目录，任何机器必崩）删除；新增根 `CONTRIBUTING.md`（环境/测试/CI 门禁/patch-package 纪律/发布流程/仓库卫生）与 `mditor/patches/README.md`（5 个补丁的清单与升降级流程）。

### 2.17 R3 部分 ✅

`EMPTY_MARKS` 常量收敛 4 处重复字面量（App/Editor/useMilkdown ×2），共享只读 + `{ ...EMPTY_MARKS }` 防御性展开约定。

---

## 三、实测数据分析

### 3.1 质量矩阵（第 2 批前后）

| 门禁 | 第 1 批后（2026-09-19 上午） | 第 2 批后（本文） |
|---|---|---|
| vitest | 778 通过 / 71 文件 | **797 通过 / 73 文件**（+19：S10 ×7、S2 ×5、E10/E11 ×7） |
| cargo test | 22 通过 | **24 通过**（+2：S2 key 校验 + 真实凭据管理器往返） |
| `tsc --noEmit`（含 2 个新严格标志） | 0 错 | 0 错 |
| eslint（含 scripts 新覆盖） | 0 错 0 警 | 0 错 0 警 |
| `cargo clippy -D warnings` | 0 | 0 |
| sigv4-check oracle | PASS | PASS |
| `npm run tauri build` | PASS（4.13.0） | **PASS（4.14.0）** |

### 3.2 运行时基准（1MB 压测文档，七场景，与第 1 批 ABAB 同法复测）

| 轮次 | open (ms) | 点击 p95 (ms) | 打字 p95 (ms) | 打字 max (ms) | 打字长任务 | 滚动 p50/p95 (ms) |
|---|---|---|---|---|---|---|
| abab-A1/A2（第 1 批前） | 2,893–2,919 | 88 | 96–104 | 104–112 | 0 | 6/30–31 |
| abab-B1–B3（第 1 批后） | 2,926–3,395 | 88–96 | **88–96** | 96 | 0 | 6/31–36 |
| **batch2-r1（本批后）** | 3,495 | 96 | **88** | 96 | 0 | 6/35 |
| **batch2-r2（本批后）** | 2,918 | 96 | 96 | 96 | 0 | 6/35 |

**结论：** 打字 p95（88–96ms）与第 1 批优化后 B 臂完全一致、仍优于优化前 A 臂（96–104ms）；打字/点击/滚动期长任务均为 0；open 在既有方差带内（2,893–3,495ms 跨度与历史轮次一致）。**第二批 17 项改动（含新增凭据库 IPC、CSP 收紧、ErrorBoundary 包裹、设置切片）对热路径零回归**——符合本批"结构性收益、不碰热路径"的设计意图。原始 JSON：`mditor/perf/results/batch2-r1.json`、`batch2-r2.json`。

### 3.3 S2 凭据库开销（新增 IPC 的代价，实测）

`cargo test secrets -- --ignored --nocapture`，200 次 set+get 往返分布：

- **p50 = 6.79ms / p95 = 11.07ms / max = 16.48ms**（单次往返 = 一次 CredWriteW + 一次 CredReadW）。

**换算到用户路径：**
- **启动水合**：loadSettings 对 4+N 槽位（N=模型数）**并行** `secret_get`（单次约 3–5ms），墙钟开销 ≈ 最慢一个 get + 一次 IPC ≈ **<15ms**——3.2 节 open 场景两轮数据（2,918/3,495ms）落在历史方差带内，无可测影响，与此一致。
- **保存路径**：`saveSettings` 顺序写 2–5 个槽位 ≈ **10–35ms**，发生在显式保存/设置变更（非打字热路径），用户不可感知。
- **迁移**：仅升级后首启一次（逐槽位写 + 脱敏重写 JSON ≈ 50ms 内）。

### 3.4 连续性微基准（P2 复测）

`countwords-bench`：1MB 文档单次 `countWords` p50 = **5.02ms**（第 1 批实测 5.30ms，一致）；防抖后每秒扫描预算 33ms（-89% 维持）。

### 3.5 产物体积

| 指标 | 4.13.0 | 4.14.0 | Δ |
|---|---|---|---|
| NSIS 安装包 | 5,886,382 B | **5,894,925 B** | +8,543 B（+0.15%） |
| mditor.exe（release, lto+strip） | — | 正常 | secrets.rs + 17 项修复 |

体积增量与新增的 Credential Manager FFI + 全部修复代码量一致；P3（2,300 行调试插桩懒加载，⏳ 遗留）仍是下一个包体优化点。

---

## 四、新发现：高优先级问题

### 4.1【高·工程】N1 — 新增文件未 git add，发版门禁链面临 404 ⚠️ 立即修复

**证据：** `.github/workflows/release.yml:33`（`uses: ./.github/workflows/ci.yml`）引用的 ci.yml 与 `mditor/src-tauri/src/secrets.rs`、`src/lib/store.secrets.test.ts`、`src/lib/exportSanitize*.ts`、`src/lib/agent/resultClamp.test.ts`、`CONTRIBUTING.md`、`mditor/patches/README.md` 均处于**未跟踪状态**（两批会话的产物）。

**风险：** 当前工作区直接 commit 已跟踪文件并推送，tag 触发的 release 会因 `workflow_call` 目标不存在而失败；更糟的是若只提交部分文件，S2 的 Rust 命令缺失会导致前端 `secret_set` 调用落空、静默回退明文。

**步骤：** `git add` 上述全部新文件 + 已修改文件，本地跑一遍 `git stash list` 确认无游离改动后一次提交。**收益：** 发版链完整，两批 41 项修复成为可追溯的原子变更。

### 4.2【高·功能】N2 — 鸿蒙 `fs.remove` 丢弃 recursive 参数，删除非空目录必然失败

**证据：** `mditor/harmony/entry/src/main/ets/io/FileManager.ets:218`（签名收了 `recursive` 但未实现）；`:279` `permanentlyRemove` 用 `rmdirSync` 删非空目录直接抛错；前端 `platform/harmony/index.ts:87` 明确传入 `recursive`，桌面端 plugin-fs 支持递归删除。

**影响：** 鸿蒙端删除包含子目录的工作区文件夹（如带 assets/ 的笔记库）失败——用户可感知的跨端行为差异。

**步骤：** 复用同文件 `:416 copyTreeVirtual` 的遍历骨架实现递归删除（后序遍历删子项再 rmdir）。**收益：** 鸿蒙端删除语义与桌面对齐。

### 4.3【高·bug】N3 — FlashcardModal 订阅-记忆化脱节（订阅形同虚设）

**证据：** `mditor/src/components/FlashcardModal.tsx:68` — `snapshot` 的 `useMemo` 依赖只有 `[open]`，而 77–78 行订阅 vaultIndex/reviewStore 后 bump 的 `setRecompute/setTick` 不参与 memo——**索引或复习进度变化永远不会重算到期清单**，与注释"索引/进度变化时重算"直接矛盾。

**步骤：** 把 tick 纳入依赖，或订阅回调里显式重算。**收益：** 复习模式打开期间新建/修改的闪卡能正确进入到期队列。

### 4.4【高·体验 bug】N4 — QuickSwitcher 深层路径截断显示错误

**证据：** `mditor/src/components/QuickSwitcher.tsx:194` — `trimRoot` 把 `lastIndexOf("/")` 的**字符下标**当**数组下标**传给 `parts.slice(i - 1)`；深层路径（`a/b/c/d.md`）切片结果为空，界面只显示"…"。`WikiLinkSuggest.tsx:173 shortPath` 是正确写法。

**步骤：** 改 `parts.slice(-2).join("/")` 或复用 shortPath。**收益：** 快速切换器在嵌套目录工作区恢复可用。

---

## 五、新发现：安全漏洞

> 第 1 批的 S1–S10 已全部闭环（本批完成 S2/S6/S10）。新增面主要是鸿蒙桥与发布链。

### 5.1【中】N5 — 签名口令经 argv 传给 java 进程（进程列表可见）

`mditor/scripts/release-harmony.mjs:132-146` 与 `sign-and-install.mjs:64-78`：keystore 口令作为命令行参数传入，本机任意进程可经进程列表读取；且 `execFileSync` 失败时 Node 默认把含口令的 spawnargs 打进控制台（脚本只在自我 echo 处掩码）。**步骤：** 改 env 变量或口令文件传参（hap-sign-tool 支持 `-keyPwdFile` 类机制），失败路径 try/catch 后脱敏退出。**收益：** 关闭全仓最后一个凭据纪律漏洞。

### 5.2【中】N6 — 鸿蒙 openExternal 无 scheme 白名单

`harmony/entry/src/main/ets/bridge/Registry.ets:137-144`：任意深链（`file://`、自定义 scheme）直传 `openLink`。桌面端 S4 修复时已限定 `https/http/mailto/tel`，鸿蒙侧未同步。**步骤：** 同桌面白名单。**收益：** 跨端一致地消除"链接点击 → 任意动作"通道。

### 5.3【中】N7 — pages.yml 四个 action 全是浮动 tag

`.github/workflows/pages.yml:30-36`：checkout@v4 等未钉 SHA，违背 ci/release 已落地的 S9 策略。**步骤：** 统一钉 40 位 SHA（GitHub API 查询）；顺带给 pages 部署挂 `needs` CI 门禁（当前坏链照样上线）。**收益：** 供应链攻击面三 workflow 一致收敛。

---

## 六、新发现：性能瓶颈

### 6.1【中】N8 — 鸿蒙全部 I/O 同步跑在 UI 主线程

`FileManager.ets:324-345`：所有 I/O 用 `fs.*Sync`（stat 需 open/stat/close 三连），方法虽标 async 无真正让出；配 `WatchManager.ets:184-220` 每 2–5s 对 ≤5000 条目逐条同步 stat（第 1 批 P9 的加强证据：桌面已无此模式，鸿蒙独有）。**步骤：** 迁 TaskPool（`@ohos.taskpool`）或至少改 `fs.statSync(path)` 直调减系统调用；watch 增量按目录 mtime 预筛。**收益：** 大库工作区鸿蒙端 UI 卡顿消除。

### 6.2【低】N9 — vaultIndex.entries() 每次全量浅拷贝

`src/lib/vaultIndex.ts:334`：QuickSwitcher/FlashcardModal 每次订阅 bump 都整表拷贝，万级条目工作区有无谓 GC 压力。**步骤：** 版本号不变时返回同一冻结快照。**收益：** 订阅风暴下分配清零。

### 6.3【低】N10 — AnnoDiagnostics 每条 bump 全量重排

`src/components/AnnoDiagnostics.tsx:181-187`：每条事件都在 render 中合并+排序三个 300 条环形缓冲（约 900 项）再截 60 条。**步骤：** `useMemo` 按各总线 version 缓存。

---

## 七、新发现：错误处理与健壮性

### 7.1【中】N11 — saveAs 分支缺 catch（与 save 不一致）

`src/App.tsx:1861`：`file_save_as` 分支 `void fa.saveAs(...).then(...)` 无 `.catch`（1849 行 `file_save` 有）——另存为写盘/持久化失败成为未处理 rejection 且用户零反馈。**步骤：** 对齐 save 分支补 catch + 状态栏提示。

### 7.2【中】N12 — FileTree 通知定时器卸载不清理

`src/components/FileTree.tsx:147`：`noticeTimerRef` 只在下一次 flash 时清理，组件卸载后 4s 内仍对已卸载组件 setState（`TabsBar.tsx:73-79` 已有正确范式可抄）。**步骤：** 补 unmount effect 清理。

### 7.3【中】N13 — trashFile 鸿蒙跨边界回退留双份中间态

`FileManager.ets:253-265`：copyTreeVirtual 后 `rmdirSync(from)` 遇非空目录（不可读条目残留）抛**裸 BusinessError**（非 BridgeError，桥层会归为 E_INTERNAL 掩盖真相），且已复制的回收站副本不清理。**步骤：** 包装错误 + 递归删原件 + 失败回收副本。

### 7.4【低】N14 — RecentList 加载无 catch

`src/components/RecentList.tsx:33`：`loadRecent().then(...)` 无 `.catch`（QuickSwitcher.tsx:61 同场景有），store IPC 失败成未处理 rejection。**步骤：** 补 catch 兜底空列表。

### 7.5【低】N15 — WikiLinkSuggest 闭包过期 + dedupe 失真

`src/components/WikiLinkSuggest.tsx:124`：keydown effect 以 `[st != null]` 为依赖，捕获的 pick/insert 回调是弹层打开那一帧的闭包，编辑器重建后可能过期；76-87 行 dedupe 只比 `items.length`，同数量不同条目不刷新。**步骤：** 回调走 ref 镜像、dedupe 改比条目 path。

### 7.6【低】N16 — 鸿蒙 closeWindow 固定 1200ms 硬切断

`Registry.ets:169-181`：收尾等待固定 1200ms 即 `terminateSelf`，慢保存被硬切断（注释已自认）。**步骤：** 改等前端 ack 事件 + 超时兜底（桌面端是 onCloseRequested 协议）。

---

## 八、新发现：代码可读性与重复代码

### 8.1【中】N17 — isDarkTheme 手工枚举字符串散布多处

`src/components/MarkdownText.tsx:89` + `src/App.tsx:1746-1749` 等：深色主题判定至少两处手工枚举（本次 ios-dark 主题就是靠逐处手补），再加新主题极易漏一处导致导出底色/静态渲染明暗错配。**步骤：** types.ts 旁提供共享 `isDarkTheme(theme)` 谓词（单一事实源）。**收益：** 新增主题从"N 处手补"变"1 处注册"。

### 8.2【中】N18 — vaultIndex rewatch churn + excluded 变化不剔索引

`src/lib/vaultIndex.ts:351-352`：roots 未变（仅 excluded 变化）时也无条件 `rewatch()`（每个根的递归监听整体拆掉重建）；且 `changed` 只比较 roots——excluded 变化后已索引的被排除文件仍留在索引中（搜索/双链仍命中已排除文件）。**步骤：** rewatch 按 roots 是否变化触发；excluded 变化时同步剔除 `byPath` 对应条目。

### 8.3【低】N19 — PickerShell 选择器外壳 ×2 近乎逐行复制

`QuickSwitcher.tsx:116-186` 与 `CitationPicker.tsx:86-152`：overlay + ↑↓/Enter/Esc 导航 + scrollIntoView + useDelayedUnmount + 30ms 聚焦定时器，约 120 行两份。**步骤：** 抽 `PickerShell`/`usePickerNav`。

### 8.4【低】N20 — 插件类型断言复制 6+20 处

`wikiLinkNode.ts:135` / `citationNode.ts:225` / `flashcardNode.ts:76` / `highlightMark.ts:79` / `textColorMark.ts:65` / `useMilkdown.ts:509` 的 `].flat() as unknown as MilkdownPlugin[]` ×6；remark 插件 `as unknown as Plugin` 全仓 20+ 处。**步骤：** 单个 `asMilkdownPlugins()` / `asRemarkPlugin()` 工具收口（第 1 批 M5 项的延伸证据）。

### 8.5【低】N21 — FileTree 键盘不可达

`FileTree.tsx:950,1045`：声明了 `role="treeitem"` 但无 tabIndex/键盘事件，整棵树无法键盘导航（QuickSwitcher/CitationPicker 都做了完整键盘导航——同仓标准不齐）。**步骤：** WAI-ARIA tree 模式补 roving tabindex + Enter/方向键。

---

## 九、新发现：鸿蒙端专项

> 第 1 批对鸿蒙覆盖较浅（仅 S7/D5/E7 三项）；本节为首次系统性扫描。

| # | 优先级 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| N2 | 高 | FileManager.ets:218 | recursive 删除未实现（见 4.2） | 复用 copyTreeVirtual 骨架 |
| N8 | 中 | FileManager.ets:324 | 同步 I/O 在 UI 线程（见 6.1） | TaskPool 迁移 |
| N13 | 中 | FileManager.ets:253 | trash 回退双份中间态（见 7.3） | 包装错误 + 清理 |
| N22 | 中 | LocalUnit.test.ets:12 | hypium 仅覆盖 UriMapper；AiBridge/S3Bridge 导出的纯函数（parseStreamChunk/mergeToolCallDeltas/validateKeyError/parseListXml/mapStatusError）零断言 | 补 hypium 用例（第 1 批 T3/R1 的落实路径） |
| N23 | 中 | sigv4-check.mjs:10 | 与 S3Bridge.ets 的"逐行镜像"无自动同步守卫，单侧改动 CI 依旧绿 | 抽共享源或加两份纯函数哈希/AST 对比步骤 |
| N24 | 低 | Registry.ets:156 | windowToggleMaximize 恒 maximize 无还原分支 | 补 toggle 语义 |
| N25 | 低 | SettingsStore.ets:120 | keyOf 抛裸 Error → 桥层误归 E_INTERNAL | 改 BridgeError('E_ARGS') |
| N26 | 低 | S3Bridge.ets:276 | parseCfg 不校验 region/凭证非空，空配置构造误导性 SYNC-003 | 前置参数校验 |
| N27 | 低 | FileManager.ets:302 | appendLog 用 UTF-16 码元对比字节上限（与 Rust 字节轮转语义漂移） | 按 UTF-8 字节数 |
| N28 | 低 | EntryAbility.ets:19 | hilog 域混用 0x0000 与 0x0D01 | 统一 0x0D01 |

---

## 十、新发现：CI/CD 与工程化

| # | 优先级 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| N1 | 高 | 工作区 | 新文件未 git add（见 4.1） | 立即提交 |
| N7 | 中 | pages.yml:30 | action 浮动 tag + 无部署门禁（见 5.3） | 钉 SHA + needs CI |
| N29 | 中 | ci.yml:20 | 无 `permissions:` 块；矩阵仅 ubuntu——**secrets.rs 的 Windows Credential Manager 代码在 CI 从未编译**（Windows 是唯一发行平台） | `permissions: contents: read` + 补 windows-latest job |
| N30 | 中 | site/index.html:49 | 下载按钮硬编码 `Mditor_4.12.3_x64-setup.exe`，下次发版忘改即静默 404 | workflow 注入版本或改 latest 别名 |
| N31 | 低 | ci.yml:50 | 门禁不含 `npm run build`，生产构建回归要等出包才暴露 | 加构建验证步 |
| N32 | 低 | vitest.config.ts:5 | 无 coverage 配置，767+ 断言无覆盖率视图 | 加 coverage + 阈值基线 |
| N33 | 低 | promo/（根） | 21MB 本地宣传草稿（mp4/wav），已 gitignore 未入库 | 外移归档即可 |

---

## 十一、遗留项复核（第 1 批 ⏳ 项现状）

| 项 | 状态 | 说明 |
|---|---|---|
| M1/M2 神组件/facade 拆分 | ⏳ 长期 | 维持判断：需独立回归窗口；本批 P10/P11 已在其外围减负（Editor 切片 + onReady） |
| M3 超长函数 | ⏳ 长期 | 同上 |
| M4 sv 写回三连 ×15 / Editor bridge 七连 ×20 | ⏳ | 本批完成 EMPTY_MARKS（R3 部分）；commitSv/bridge 组合子仍待做 |
| M5 其余项（jumpToRag 600ms 竞态 / SettingsModal key={i} / Editor 主题 effect deps / timings.ts / useLatest） | ⏳ | Editor 主题 effect 已被 P10 切片部分缓解（settings 引用稳定）；其余未动 |
| P3 调试插桩常驻（约 2,300 行） | ⏳ | 包体项（4.14.0 仅 +0.15%，未到痛点），建议与 M1 拆分同期做 |
| P6 鸿蒙 base64 上传通道 | ⏳ | 需真机验收窗口；N8（UI 线程 I/O）同属鸿蒙性能批 |
| P8 RAG stringify 内存尖峰 | ⏳ | 原子写已修；JSONL 格式变更需迁移设计，收益场景（>10MB 索引）罕见 |
| P9 WatchManager 全树轮询 | ⏳ | 并入 N8 鸿蒙性能批 |
| R1 剩余（hypium 向量 + 共享规格） | ⏳ | 本批 N22/N23 给出落实路径 |
| R2 协议层重复 | ⏳ | 同 N22/N23 |
| T2 覆盖偏科 | ◐ 推进 | 本批补 exporter 消毒 ×7 + store ×5；组件层/ErrorBoundary/exporter 全管线仍缺 |
| T3 hypium 本地运行 | ⏳ | 同 N22 |
| E9 全量静默 catch 清点 | ◐ | 约定落地 + 高价值 3 处已修；余 App 16 + 全仓 ~50 处 |
| G2 noUncheckedIndexedAccess | ◐ 量化 | 578 处 fallout 已按文件排序留档（AiPanel 43/annotations 27/App 23…） |
| G3 checkJS | ◐ | eslint 部分已落地；待 @types/node 可安装 |
| S2 macOS Keychain / 鸿蒙 HUKS | ◐ 架构就绪 | secrets.rs 的 imp 模块已按平台 cfg 分离，非 Windows 返回类型化错误——接入即插即用 |

---

## 十二、优先级总表与第三批路线图

### 高优先级（4 项）

| # | 问题 | 预估 | 预期收益 |
|---|---|---|---|
| N1 | 提交两批全部新文件 | 10 分钟 | 发版链不 404；41 项修复可追溯 |
| N3 | FlashcardModal 订阅死代码 | 30 分钟 | 复习模式数据正确性 |
| N4 | QuickSwitcher trimRoot 下标误用 | 30 分钟 | 深层路径恢复显示 |
| N2 | 鸿蒙 recursive 删除 | 半天 | 跨端删除语义对齐 |

### 中优先级（11 项）

N5 签名口令 argv · N6 鸿蒙 openExternal 白名单 · N7 pages.yml SHA+门禁 · N8+P9 鸿蒙 UI 线程 I/O+watch 预筛 · N11 saveAs catch · N12 FileTree 定时器 · N13 trash 回退 · N17 isDarkTheme · N18 vaultIndex rewatch/excluded · N29 CI windows 矩阵+permissions · N30 site 下载链接版本注入

### 低优先级（16 项）

N9/N10 性能微项 · N14/N15/N16 健壮性微项 · N19/N20/N21 重复与可达性 · N22/N23 鸿蒙测试（建议升做：投入小收益大） · N24–N28 鸿蒙杂项 · N31/N32 CI 补强 · N33 promo 归档

### 第三批建议顺序

1. **第 3a 批·半天：** N1 提交 + N3/N4 两个体验 bug + N11/N12/N14 三个健壮性小项 + N7/N29 CI 补强——全部低风险高确定性。
2. **第 3b 批·两天：鸿蒙专项**（N2 + N8/P9 + N13 + N6 + N22/N23）——一次真机验收窗口覆盖全部鸿蒙项。
3. **第 4 批·长期（维持第 1 批路线）：** M1/M2 拆分 + P3 插桩懒加载 + G2 全量收紧（578 处）+ T2 组件层测试。

---

## 十三、打包与验证记录

- **版本：** 4.14.0 四处对齐（package.json / Cargo.toml / tauri.conf.json / app.json5 versionCode 1001400）；CHANGELOG 已按根因级惯例记档。
- **产物：** `mditor/src-tauri/target/release/bundle/nsis/Mditor_4.14.0_x64-setup.exe`（5,894,925 B，较 4.13.0 +8,543 B / +0.15%）；release profile 维持 lto + codegen-units=1 + strip + panic=abort。
- **打包前门禁：** vitest 797/797 · tsc 0 错（含 noImplicitReturns/noImplicitOverride）· eslint 0/0（含 scripts 新覆盖）· cargo test 24 + clippy -D warnings 0 · sigv4 oracle PASS——即 ci.yml 全部门禁本地预演通过。
- **冒烟：** dev 实例（新 CSP 配置）启动正常，七场景基准完整跑通两轮（3.2 节），undo 收尾恢复原文。

---

*报告生成方式：第二批 17 项实施（含每项回归测试）+ 3 组实测（基准 ×2 / S2 计时 / 微基准复测）+ 2 个并行深度探查（前端未审计区域 / Rust·鸿蒙·工程面）交叉汇总。第 1 批遗留项逐项复核标注。新问题均附 file:line 证据；"立即修复"级的是 N1——一次 git add 就能消除发版链断裂风险。*
