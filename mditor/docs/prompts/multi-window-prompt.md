# 提示词：多窗口多开（Mditor 一次性开发任务）

> 用法：将本文整体粘贴给 AI 编程助手（ZCode / Claude Code / TRAE 等），或作为独立任务的入口提示词。
> 范围：浏览器式多窗口一次交付——可同时打开多个编辑器窗口，任务栏/Alt+Tab 切换、并排对比阅读；窗口内标签页系统保持不变。无阶段排序，但 commit 按依赖顺序逐模块提交（见工作流程）。

---

## 角色

你是资深桌面编辑器工程师，在本仓库（Mditor：Tauri 2 + React 18 + Milkdown/Crepe 富文本 + CodeMirror 源码模式）上实现**多窗口多开**。用户群体：用 Mditor 做长文写作与文档阅读的重度用户，痛点是「同时只能看一个文档，切换要在软件内点标签」。

## 使命

把 Mditor 从「单窗口多标签」升级为「多窗口多开」：像浏览器一样，每个窗口是一套完整的编辑器（自带标签栏、侧栏、AI 面板），可以开任意多个窗口，把不同文档分窗并排（Win+左/右分屏）对比阅读，用任务栏/Alt+Tab 切换，无需在软件内部点来点去。

## 铁律（违反任何一条即返工）

1. **第一窗口 label 恒为 `main`**：冷启动路径（`PendingFile`、heal snapshot 恢复、splash 开屏）只属于 `main`；新建窗口 label 一律 `doc-{n}`。单实例插件「二次启动抬升已有实例」的行为不得回退。
2. **capabilities 必须覆盖新窗口**：`src-tauri/capabilities/default.json` 现为 `"windows": ["main"]`，不改它则新窗口**所有** invoke（fs/dialog/store）全部失败。改为 `["main", "doc-*"]`。除实际必需项外不得新增任何权限，CSP 不得放宽。
3. **关闭语义不得杀全 app**：现有 `forceClose`（App.tsx ~L566）里 `exit(0)` 会结束整个进程——多窗下关一个窗口绝不允许带走其它窗口。只有「最后一个窗口关闭」才允许 exit。所有关闭路径（点 X / Alt+F4 / 菜单退出 / 落盘超时兜底）都必须过这条检查。
4. **大内容禁止走 URL**：标签迁移（含未命名脏缓冲、几百 KB 文档快照）必须走 Rust 侧 handoff stash（存-取-删）；URL 查询参数只允许 `path` / `handoff` 短参数。
5. **零新依赖**：前端零新 npm 包，Rust 零新 crate（`WebviewWindowBuilder` 是 tauri 自带）。
6. **不破坏既有工程纪律**：App.tsx 的 ref 镜像 / 空依赖稳定回调模式、「监听注册一次 + ref 转发」模式必须延续；vitest 532 基线全绿不回归；注释与文档使用中文、风格与仓库一致。
7. **防镀金**：只做本文列出的模块，「明确不做」清单之外不得扩张。

## 现状底图（先读这些，避免重复造轮子和踩坑）

| 关注点 | 文件:位置 | 要点 |
| --- | --- | --- |
| 标签状态机（V3.6 多标签） | `src/App.tsx` L174-186 `tabs`/`activeKey`；L286-297 `snapshotActiveTab`；L306-377 `activateTab`；L381-413 `newUntitledTab`；L417-473 `closeTab` | 只有活动标签住在编辑器/useFile 里，切走时快照进 `TabItem`；有路径的脏标签切走/关闭前静默落盘 |
| TabItem 类型 | `src/types.ts` L564-574 | `{ key, path, name, dirty, content }` —— handoff 载荷以它为基 |
| 关闭收尾链 | `src/App.tsx` L486-509 `flushDirtyTabs`；L511-558 `shutdownSequence`（3s 超时+未命名确认）；L566-584 `forceClose`（destroy + 250ms 后 exit(0) 兜底）；L595-629 `onCloseRequested` 拦截 | 本次改造的核心区：`forceClose` 与 `app_exit` 必须感知「还有别的窗口」 |
| 打开文件入口 | `src/App.tsx` L689 `openPath`（同路径去重 `tabPathKey`）；L983 `maybeOpen`；L1024-1040 `open-file` 监听；L1045-1077 拖放 | 「在新窗口打开」= 绕过本窗去重，直接建窗 |
| 菜单分发 | `src/App.tsx` L1421 `dispatchMenu`；L1545-1560 `app_exit`；`src-tauri/src/lib.rs` L232-238 `on_menu_event`（`app.emit("menu", id)` **广播**，仅非 Windows 原生菜单触发）；Windows 菜单是前端 `src/components/MenuBar.tsx`（直接 onDispatch，天然按窗） | 广播事件必须改为定向 |
| 单实例 | `src-tauri/src/lib.rs` L98-113：二次启动 `app.emit("open-file", path)` **广播** + 硬编码抬升 `main` | 多窗下广播会导致每个窗口都开这个文件——必须定向到焦点窗口 |
| 窗口配置 | `src-tauri/tauri.conf.json`：label `main`、1280×820、min 720×480、`decorations:false`（自绘标题栏 `src/components/TitleBar.tsx`，用 `getCurrentWindow()`，天然按窗口生效） | 新窗参数照抄 main |
| 权限 | `src-tauri/capabilities/default.json` | 见铁律 2 |
| 设置/最近/工作区存储 | `src/lib/store.ts`（LazyStore `mditor.json`：loadSettings/saveSettings/pushRecent/getWorkspaces/setWorkspaces） | 多窗并发写：last-write-wins，可接受；需广播设置变更 |
| 文件外部修改 | `src/hooks/useFileWatcher.ts`：clean 静默重载 / dirty 弹确认；自触发抑制仅认**本窗** autosave | 同文件开两窗时，A 窗保存对 B 窗是「外部修改」：B 干净则自动刷新（对比阅读的免费同步），B 脏则走现有确认——语义正确，不要改 |
| heal snapshot | `src/lib/session.ts`（sessionStorage，每 webview 独立） | 新窗口 webview 的 sessionStorage 天然为空，无需处理 |
| 开屏 | `src/lib/splash.ts` + `src/main.tsx` 兜底 | 新窗口必须跳过 splash |
| 右键菜单基建 | `src/components/ContextMenu.tsx`（`ContextMenu` + `CtxEntry`，FileTree 已在用，见 `src/components/FileTree.tsx` L827-835） | TabsBar/RecentList 的右键直接复用 |
| 滚动恢复范式 | `src/App.tsx` L797-819 heal restore 的 tryScroll 重试梯子 | handoff 恢复 scrollTop 照抄此模式 |
| 性能纪律 | `docs/performance.md`、`docs/perf-optimization-prompt.md` | 新窗不得引入常驻主线程开销 |

## 总体设计

**每个窗口 = 一个独立 webview = 一份完整 App 实例**（自带标签栏/侧栏/AI），状态天然隔离，零状态架构迁移。第一窗口恒为 `main`，新窗口 label `doc-{n}`（Rust 侧 `AtomicU64` 分配 + 存活检查防碰撞）。

| 决策点 | 方案 |
| --- | --- |
| 建窗入口 | Rust 命令 `create_doc_window`（`WebviewWindowBuilder` + `WebviewUrl::App("index.html?…")`，dev/build 两种模式都正确解析）；不从前端 JS 建窗，省掉 `core:webview:allow-create-webview-window` 权限 |
| 传参 | URL 只带 `?path=<encodeURIComponent>` 或 `?handoff=<id>`；未命名/脏标签迁移走 Rust stash：`stash_tab_payload(json) -> id`（60s TTL）+ `take_tab_payload(id)`（取即删） |
| 定位 | 级联：相对源窗口 `outerPosition()` 偏移 (32, 32)，越界回卷（或 clamp ≥0，注释说明取舍）；尺寸/minSize/decorations 照抄 main，`focused(true)` |
| 焦点路由 | Rust 记录最后聚焦窗口 label（`on_window_event` 的 `WindowEvent::Focused(true)` → `Mutex<String>`）；`open-file`（单实例）与 `menu`（非 Windows 原生菜单）一律 `emit_to(焦点||main)` + 抬升该窗 |
| 关闭 | 每窗只负责自己：`forceClose` 先 `WebviewWindow.getAll()`（权限不足则在 capabilities 增补必需的 core:window 项），`length <= 1` 才走现行 destroy+exit 兜底，否则只 destroy 自己；「退出」= 广播后各窗自己 `close()`，全部复用现有单窗关闭管线（见模块 3） |

---

## 模块 1：Rust 窗口基座（最先提交）

**文件**：`src-tauri/src/commands.rs`（新命令）、`src-tauri/src/lib.rs`（焦点跟踪 + 定向 emit）、`src-tauri/capabilities/default.json`。

- 新命令（挂进 `invoke_handler`，风格照抄 `get_pending_file`）：
  - `create_doc_window(path: Option<String>, handoff: Option<String>) -> Result<String, String>`：分配 label `doc-{n}`；构造 `index.html?path=…&handoff=…`（只带有的参数）；级联定位；返回 label。若同名 label 窗口已存在（理论不撞，撞了就自增重试）。
  - `stash_tab_payload(payload: String) -> String`：存入 `Mutex<HashMap<String, (String, Instant)>>`，id 用 uuid 或 `AtomicU64`+时间戳；惰性清理过期（>60s）条目。
  - `take_tab_payload(id: String) -> Option<String>`：取即删。
- `lib.rs`：
  - `builder.on_window_event`：记录 `Focused(true)` 的 label 到 managed state `LastFocused(Mutex<String>)`（初始 `"main"`）。
  - 单实例回调（L100-112）：`open-file` 改 `emit_to(焦点窗口, ...)`；抬升目标从硬编码 `main` 改为焦点窗口（无则 `main`）。
  - `on_menu_event`（L232-238）：`emit_to(焦点窗口, "menu", id)` 替代 `app.emit`。
  - `menu_ids` 增加 `NEW_WINDOW: &str = "file_new_window"`；非 Windows 原生「文件」菜单加「新建窗口」项。
- `capabilities/default.json`：`"windows": ["main", "doc-*"]`；若前端需要 `WebviewWindow.getAll()` / `emit` 广播而 `core:default` 不够，增补对应 `core:window:` / `core:event:` 权限项（只加必需的）。

**验收**：`cargo check` 通过；`npm run tauri dev` 里从 DevTools `invoke("create_doc_window", { path: null })` 能弹出第二个完整可用窗口（能打开/保存文件）。

## 模块 2：前端窗口库 + 启动路由

**新文件**：`src/lib/multiWindow.ts`。

```ts
// 纯函数（全部可 vitest）：
buildDocWindowUrl(path?: string, handoffId?: string): string   // 参数编码、只含有值参数
parseBootParams(search: string): { path: string | null; handoff: string | null }
formatWindowTitle(name: string, dirty: boolean): string        // "• name — Mditor"
// 副作用封装：
openPathInNewWindow(path: string): Promise<void>               // invoke create_doc_window
moveTabToNewWindow(tab: TabItem, scrollTop?: number): Promise<void>
  // stash_tab_payload(含 scrollTop 的 TabItem JSON) → create_doc_window(null, id)
```

**App.tsx 启动路由**（挂载时一次）：

- `parseBootParams(location.search)`：
  - 有 `path` → 把初始未命名标签替换为该文档（复用 `openPath` 语义作为首个标签，不叠加多余空标签）。
  - 有 `handoff` → `take_tab_payload` 取回 `{ TabItem, scrollTop }`：恢复为初始标签（含未命名脏缓冲：`showDoc` 后 `markDirty`）；scrollTop 用 tryScroll 重试梯子恢复（照抄 heal restore L797-819，best-effort，失败静默）。
  - 都没有 → 现状（heal snapshot / 空白未命名）。
- splash：`getCurrentWindow().label !== "main"` 时立即 `dismissSplash()`（main.tsx 的 4s 兜底不动）。
- 窗口标题同步：effect 监听活动标签 name/dirty → `getCurrentWindow().setTitle(formatWindowTitle(...))`（main 窗口同样生效；任务栏预览与 Alt+Tab 因此可区分）。注意用 ref 读最新值、空依赖注册一次。

**验收**：vitest 覆盖 URL 构建/解析往返、title 格式、参数编码边界（含 `#`、`&`、中文、空格路径）；新窗口无 splash、直接落在目标文档。

## 模块 3：关闭与退出语义改造

**全部在 `src/App.tsx` 现有关闭链上改，不新增第二条管线。**

- `forceClose`（L566-584）：
  ```ts
  const all = await WebviewWindow.getAll();
  if (all.length <= 1) { /* 现行 destroy + 250ms exit(0) 兜底，原样保留 */ }
  else { void getCurrentWindow().destroy().catch(retry destroy); /* 绝不 exit */ }
  ```
  注释更新：说明「destroy 失败兜底 exit」只在最后一窗时成立，非最后窗 destroy 失败仅重试 destroy（进程交给最后一窗的关闭收尾）。
- `app_exit`（L1545-1560）改为广播协议：
  1. `emit("app-quit-request")`（全窗广播，含自己）；
  2. 各窗监听该事件（注册一次 + ref 转发模式）→ 自行 `getCurrentWindow().close()`，走**现有** `onCloseRequested → shutdownSequence（flush 3s + 未命名确认）→ forceClose` 管线；
  3. 有窗口的用户取消（未命名脏缓冲确认点「否」）→ 该窗留存、退出中止——行为与浏览器一致；最后一窗关闭时 `forceClose` 自然 exit。
  4. 兜底：广播后 5s 进程仍在且无弹窗（理论不会发生），发起窗按现行 `exit(0)` 硬退。
- 防重入：现有 `shutdownInFlightRef` 语义已覆盖单窗连点；跨窗「一窗收尾中另一窗发起退出」由各窗独立 close 串行消化，无需全局锁（在注释中说明）。

**验收**：开 A/B 两窗，关 B 时 A 不受影响；关最后一个窗口进程退出（任务管理器无残留）；菜单「退出」时多窗全部 flush 后整 app 退出；某窗有未命名脏缓冲时弹确认、取消则整个 app 保留。

## 模块 4：入口 UI（让用户用得上）

- **菜单**：Windows 前端 `MenuBar.tsx`「文件」加「新建窗口」（id `file_new_window`，dispatchMenu 新 case → `openPathInNewWindow` 的空窗变体：`create_doc_window(null, null)`）；与 lib.rs 的 menu_ids 对齐。
- **快捷键**：App.tsx 全局键盘 effect 加 `Ctrl/Cmd+Shift+N` → 新建窗口（`Ctrl+N` 已被 file_new 占用，不得冲突）。
- **TabsBar 右键菜单**：标签上 `onContextMenu` 弹 `ContextMenu`（复用 `src/components/ContextMenu.tsx`），单项「移到新窗口」：活动标签先 `snapshotActiveTab()` → `moveTabToNewWindow(tab, scrollTop)` → 本窗 `closeTab(key)`（复用现有语义：本窗剩 0 个标签时自动回退干净未命名标签）。未命名/脏内容随 handoff 完整迁移。
- **FileTree 右键**：现有 ContextMenu（L827 附近）对 `.md` 文件加「在新窗口打开」→ `openPathInNewWindow(path)`（不动本窗标签）。
- **RecentList 右键**：条目加 `onContextMenu`（复用 ContextMenu 组件），「在新窗口打开」。
- 文案统一：新建空窗=「新建窗口」；把已有文档放新窗=「在新窗口打开」；标签迁移=「移到新窗口」。

**验收**：四个入口全部可用；移动一个未命名脏标签到新窗，内容与脏标记完整保留，原窗标签消失。

## 模块 5：多窗一致性

- **设置同步**：`saveSettings` 成功后 `emit("settings-changed")`；各窗 `useSettings` 监听 → 幂等重载磁盘设置（主题等即时一致；自己收到自己的回声也无害）。注意保持 useSettings 返回值引用稳定性纪律（参照 App.tsx L117-122 的 stabilise 模式，避免监听 effect 反复重注册）。
- **最近列表**：多窗并发 pushRecent 为 last-write-wins，可接受，不改（在 CHANGELOG 已知问题里注明）。窗口重新聚焦时 bump `recentKey` 刷新侧栏即可（复用现有 onFocusChanged 或 Tauri focus 事件，注册一次）。
- **同文件多窗**：不改 `useFileWatcher`。语义：干净窗随另一窗保存自动静默重载（对比阅读的实时同步，是卖点不是 bug）；脏窗走现有「外部已修改」确认。
- **索引/内存**：每窗独立 vaultIndex / 内存守护（visibilitychange 的 `app-idle` 已让后台窗动画让路）。接受重复成本，CHANGELOG 注明「每窗口约一个 webview 的额外内存」，不做跨窗共享。
- **AI 面板 / 导出 / 搜索**：每窗独立实例，无需改动，但验收必须逐项过一遍（见验收清单）。

## 明确不做（防镀金）

- 标签拖拽出窗成新窗（webview 内 drag 跨窗不可靠）——右键「移到新窗口」已覆盖该场景
- 窗口内 split/并排分栏视图（OS 分屏 Win+左/右已满足对比阅读）
- 跨窗口标签拖放、「合并全部窗口」
- 多窗布局会话恢复（重启还原窗口数量与位置）
- Rust 侧共享 vaultIndex / RAG 索引
- QuickSwitcher Ctrl+Enter 新窗打开（后续可加）

## 工作流程

按依赖顺序逐模块 commit，每个 commit 自带测试且全绿：

1. **Rust 基座**：命令 + 焦点跟踪 + 定向 emit + capabilities（`cargo check`）
2. **multiWindow.ts + 启动路由 + splash 跳过 + 标题同步**（vitest 新用例）
3. **关闭/退出语义改造**（forceClose 分级 + app_exit 广播协议）
4. **入口 UI 四件套 + 快捷键**（菜单 id 对齐）
5. **设置广播同步 + 版本号（package.json / tauri.conf.json / Cargo.toml 三处同步升 4.8.0）+ CHANGELOG 条目（按现有格式写功能、已知成本与已知问题）**

交付前全量跑：`npm run build`（含 tsc --noEmit）、`npm run test`、`npm run lint`、`cargo check`，并完成下方手工验收。

## 手工验收清单（Windows 优先）

- [ ] Ctrl+Shift+N / 菜单「新建窗口」→ 新窗级联出现（偏移 32px），无 splash，空白未命名标签
- [ ] 文件树 / 最近列表右键「在新窗口打开」→ 新窗直接加载该文档，原窗不动
- [ ] 标签右键「移到新窗口」：未命名脏标签内容+脏标记完整迁移；有路径脏标签先落盘再迁移（沿用手动 close 语义）
- [ ] 同一文件开两窗并排：A 窗 Ctrl+S → B 窗（干净）秒级自动刷新；B 窗若为脏则弹「外部已修改」确认
- [ ] 任务栏预览每窗显示各自文档名；Alt+Tab 可区分
- [ ] 关 B 窗 A 窗无感；关最后一窗进程退出无残留；关闭前 flush（有路径脏标签静默落盘）多窗下依旧成立
- [ ] 菜单「退出」：多窗全部收尾退出；某窗未命名脏缓冲取消确认 → 整 app 保留
- [ ] app 运行中双击 .md / 命令行 `mditor.exe a.md` → **焦点窗口**开新标签并前置（不是每个窗口都开、不是永远 main）
- [ ] 新窗全功能可用：打开/保存/另存/导出 PDF/全库搜索/AI 面板/设置（capabilities 生效的直接证据）
- [ ] A 窗改主题 → B 窗即时跟随；B 窗改 → A 窗跟随
- [ ] `npm run build` + `npm run test` + `npm run lint` + `cargo check` 全绿，532 基线无回归
