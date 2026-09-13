# 鸿蒙（HarmonyOS PC）版本迁移提示词（ArkWeb 混合壳 · 核心 MVP）

> **使用方式**：将本提示词完整粘贴给 AI 编码代理作为任务指令，一次性执行全部迁移。目标项目 `mditor/`（Tauri 2 桌面应用，React 前端）。执行前先读「二、项目背景与现状」，事实表中行号基于 **v4.10.0-beta.2** 探查，执行时以实际代码为准。开发环境已于 2026-09-13 装好（见 2.4），如与实测不符，以 `memory/2026-09-13.md` 记录为准。

---

## 一、角色定义

你是一名资深全栈工程师（React/TypeScript 方向）兼鸿蒙应用工程师（ArkTS/ArkUI/ArkWeb 方向），受命为本项目增加**鸿蒙（HarmonyOS PC）版本**。你以最小侵入为原则：现有 Windows 桌面版的一切行为、测试、构建链路一律不得破坏。你不重写编辑器，只做「平台适配层重构 + ArkWeb 原生壳」，让现有 React 前端跑在鸿蒙 ArkWeb 里。

## 二、项目背景与现状（先读再动手）

### 2.1 技术栈

- **前端**：React 18 + TypeScript + Milkdown 7.22（Crepe/ProseMirror）+ CodeMirror 6 + Vite 5；无状态管理库，`src/App.tsx` 单体承载全局状态；UI 完全自绘（`src/styles/global.css` 4400+ 行令牌体系 + 5 主题 CSS 懒加载），无组件库。
- **桌面后端**：Tauri 2（`src-tauri/`，Rust 4 文件：`lib.rs`/`commands.rs`/`ai.rs`/`main.rs`），插件 dialog / fs(watch) / shell / store / process / single-instance。
- **基建**：`npm run build`（tsc --noEmit + vite build）、`npm run test`（Vitest 582 用例）、`npm run lint`；Rust 侧 `cargo check/test`。注释用中文，模块头注释说明设计意图。
- **平台现状**：仅 Windows（NSIS 打包），窗口 `decorations:false` 自绘标题栏，窗口 minWidth 720。

### 2.2 已探明事实表（动手前请按此索引通读）

| 事实 | 位置（基于 v4.10.0-beta.2） |
|---|---|
| 前端 **25 个文件**直接 `import @tauri-apps/*`，无统一平台适配层 | 全局搜索 `@tauri-apps` |
| `plugin-fs` 直接调用 15 处 | `App.tsx`、`Editor.tsx`、`hooks/useSettings.ts`、`hooks/useFileWatcher.ts`、`lib/tauriFs.ts`、`lib/fileOps.ts`、`lib/exporter.ts`、`lib/ragIndex.ts`、`lib/vaultIndex.ts`、`lib/reviewStore.ts`、`lib/imageManager.ts`、`lib/bibliography.ts`、`lib/filePrefetch.ts`、`lib/workspaceSearch.ts`、`lib/agent/apply.ts`、`lib/agent/tools.ts` |
| `plugin-dialog` 直接调用 6 处 | `lib/tauriFs.ts`、`lib/dialogs.ts`、`lib/exporter.ts`、`App.tsx`、`Editor.tsx`、`components/SettingsModal.tsx` |
| `invoke` 非测试调用约 17 处 | `lib/ai.ts` ×9、`lib/multiWindow.ts` ×7、`lib/imageManager.ts` ×5、`lib/fileOps.ts` ×3、`lib/diagnostics.ts` ×3、`lib/devMode.ts` ×3 等 |
| 事件 `listen/emit`：menu / open-file / settings-changed / ai_stream_* | `lib/multiWindow.ts`、`lib/ai.ts`、`App.tsx` |
| 已有雏形层（迁移的落脚点，**必须复用不得重造**） | `lib/tauriFs.ts`（读/开/存封装 + TreeNode）、`lib/fileOps.ts`（破坏性操作集中审计）、`lib/dialogs.ts`（原生弹窗统一封装）、`lib/store.ts`（设置存储唯一入口）、`lib/path-shim.ts`（跨平台路径工具）、`lib/ipcTrace.ts`（tracedIo 追踪包装） |
| **无任何运行时检测**（无 isTauri），浏览器 dev 下 IPC 直接不可用 | README「开发」节；`src/` 全局无对应判断 |
| Rust 自定义命令 8 个 | `src-tauri/src/commands.rs`：`append_log`(L54)、`app_data_dir`(L97)、`get_pending_file`(L107)、`fetch_image`(L118，绕 CSP 图片代理)、`create_doc_window`/`stash_tab_payload`/`take_tab_payload`(L324，多窗口)、`trash_file`(L234，Windows 回收站) |
| Rust AI 命令 4 个（SSE 代理 + 取消 + 嵌入） | `src-tauri/src/ai.rs`：`ai_chat`/`ai_chat_stream`/`ai_chat_cancel`/`ai_embed`；代理原因：CSP `connect-src` 锁死 `ipc:`，渲染层不能直连外网（ai.rs 头部注释） |
| 设置/最近文件/工作区 = `appDataDir/mditor.json`（plugin-store，keys: settings/recent/workspaces） | `lib/store.ts` L19-21, L138-156 |
| 其余持久化全是 appData 下 JSON：`rag-index.json`、`review-state.json`、`logs/` | `lib/ragIndex.ts` L11、`lib/reviewStore.ts` L1、`commands.rs` append_log |
| 唯一 web storage：sessionStorage（webview reload 自愈快照） | `lib/session.ts` |
| 无 SQLite / IndexedDB；文档 = 用户文件系统任意路径（fs 权限 `**` + asset 协议 `**`） | `src-tauri/capabilities/default.json` L33-45 |
| UI 零移动适配：`@media` 仅 6 处（reduced-motion ×5 + print ×1），无断点、无触摸布局 | `styles/global.css` L1640/1668/3407/3868/4452、`annotation.css` L739 |
| 交互已用 `pointerdown`（触摸兼容的正面基础） | `hooks/useResizable.ts`、`lib/activity.ts` L38 |
| 全局 `contextmenu` preventDefault + 自绘菜单（鸿蒙可用，无需原生菜单） | `main.tsx` L37-46 |
| PDF 导出依赖 webview `print()` | `lib/exporter.ts` L10-11 |
| patch-package ×4（Milkdown/ProseMirror 补丁，迁移时保持不丢） | `patches/`：@milkdown/components（表格 update() 根修）、@milkdown/crepe、@milkdown/plugin-listener、prosemirror-virtual-cursor |
| vite 固定端口 1420、manualChunks 拆 vendor-react/vendor-milkdown、2MB+ 导出库动态导入 | `vite.config.ts` L49-66 |
| 测试已用 IO 注入面 / vi.mock 模式（平台层改造的安全网） | `lib/bibliography.ts` L14、`lib/vaultIndex.ts` L233、`lib/agent/agent.test.ts` L9 |

### 2.3 硬约束

1. **桌面零回归**：Windows 版行为、582 个 Vitest 用例、NSIS 构建链路全部不得破坏。每阶段结束 `npm run build && npm run test` 必须绿。
2. **项目红线：`trash` > `rm`**。Windows 侧继续走回收站（`trash_file`）；鸿蒙侧无公共回收站 API，MVP 允许「确认弹窗后永久删除」，但必须经 `fileOps.ts` 审计层，不得绕过。
3. **最小侵入**：不重构 `App.tsx`、不改 Milkdown 管线、不动 patch-package；所有平台差异收进新的 `src/platform/` 层。
4. **先读后改**：动手前通读事实表所列文件；`src/lib/` 各模块的现有函数签名尽量保持不变，内部实现切到适配层。
5. 小步提交：每阶段至少一个 conventional commit。

### 2.4 开发环境（2026-09-13 已装好并实测验证）

| 项 | 值 |
|---|---|
| 工具链 | HarmonyOS **Command Line Tools 6.0.2.670**（官方下载中心 2026/08/31 Release） |
| 安装位置 | `C:\Huawei\command-line-tools\`（bin\ hvigorw.bat / ohpm\bin\ ohpm.bat / sdk\ / tool\node\ / codelinter\ / hstack\） |
| 内嵌 SDK | **HarmonyOS 6.0.2 Release（Ohos_sdk_public 6.0.2.130，API Version 22）**，位于 `sdk\default\{openharmony,hms}`，无需单独装 SDK |
| 版本明细 | hvigor 6.22.9、ohpm 6.0.1、hdc 3.2.0c、codelinter 6.0.240 |
| 环境变量 | 用户级已设 `DEVECO_SDK_HOME=C:\Huawei\command-line-tools\sdk`；用户 PATH 已追加 `bin`、`ohpm\bin`、`sdk\default\openharmony\toolchains` 三个目录。**已开进程不生效，执行前新开 shell 或手动 export**；若失效按 memory/2026-09-13.md 恢复 |
| ohpm 源 | 已是官方源 `https://ohpm.openharmony.cn/ohpm/`，无需改 |
| 本机其他 | Node v24.15.0、npm 11.12.1、Git Bash；**无 DevEco Studio、无模拟器、无签名证书、无 Java** |
| 构建命令 | 在 `mditor/harmony/` 下 `hvigorw assembleHap --mode module -p product=default`；依赖安装 `ohpm install` |
| 已知限制 | 无签名证书时只能构建**未签名 HAP**验证编译；真机部署需要用户后续在 AGC 申请调试证书（签名工具 hap-sign-tool 为 Java 实现，届时需装 JDK 17 并设 `JAVA_HOME`） |
| 安装包 | `%USERPROFILE%\Downloads\mditor-clt-6.0.2.670.zip`（重装可用） |

## 三、目标与已确认决策

**目标**：mditor 在鸿蒙 PC（窗口化桌面形态，键鼠交互）上以 ArkWeb 混合壳运行，覆盖核心编辑能力，与 Windows 版共享同一份前端代码。

已确认的四项决策（不得偏离）：

1. **技术路线 = ArkWeb 混合壳**：React 前端构建产物离线打进鸿蒙工程 `rawfile/`，由 ArkWeb 组件加载；ArkTS 原生层补齐文件/存储/弹窗能力。**不做**纯原生重写，**不用** RNOH/Flutter（编辑器内核是 DOM 技术栈，不可迁移）。
2. **首期范围 = 核心 MVP**：打开/编辑/保存 .md（含工作区目录）、文件树、三种编辑模式（wysiwyg/ir/sv）、大纲、主题切换、设置、最近文件、HTML 导出。明确不做清单见「七」。
3. **设备形态 = 鸿蒙 PC 优先**：复用现有三栏桌面布局（minWidth 720 保留），不做手机布局、不做触摸优化。仅隐藏自绘窗口控制按钮（系统窗口管理接管）。
4. **构建 = 命令行工具**：全程用 commandline-tools（hvigorw/ohpm），不依赖 DevEco Studio；`npm run build:harmony` 一条命令完成「vite 构建 → 产物拷贝 → hvigor 打 HAP」。

## 四、总纪律

1. **先读后改**：按 2.2 事实表通读现状，再动手。
2. **每阶段可编译可运行**：按 阶段 0 → 5 顺序推进，每阶段验收标准见「六」。
3. **桌面零回归优先**：任何重构先保证 Tauri 路径行为不变，再接鸿蒙实现。
4. **不过度设计**：复用 2.2 列出的雏形层函数；适配层接口以「现有调用点需要什么」为准裁剪，不预留用不到的抽象。
5. **小步提交**：每阶段至少一个 conventional commit；`harmony/` 工程与前端改造分开提交。

## 五、架构设计

### 5.1 总体数据流

```
┌─ 鸿蒙 PC 应用（ArkTS）────────────────────────────┐
│ EntryAbility → Index.ets (ArkWeb)                  │
│   ├─ 加载 $rawfile/web/index.html（vite 产物）      │
│   ├─ createWebMessagePorts 建双向通道               │
│   └─ Bridge.ets 分发 RPC → FileManager/SettingsStore│
│        （DocumentViewPicker / fs / preferences）    │
└──────────────┬─────────────────────────────────────┘
               │ JSON-RPC {id,method,params} ⇄ {id,result|error} + {event,payload}
┌──────────────┴─────────────────────────────────────┐
│ React 前端（与 Windows 版同源）                       │
│ platform/index.ts 运行时检测 → tauri | harmony      │
│   harmony: bridge-client.ts（端口封装，promise 化）  │
│   全部业务代码只认 PlatformAdapter 接口              │
└────────────────────────────────────────────────────┘
Windows 版：platform/tauri/* 包装现有 @tauri-apps 调用，行为与迁移前逐字节一致。
```

### 5.2 前端平台适配层 `src/platform/`

```
src/platform/
├── types.ts          # PlatformAdapter 接口：fs / dialog / store / app 四域
├── index.ts          # detectRuntime(): 'tauri'|'harmony'|'browser' + getAdapter()
├── errors.ts         # UnsupportedError（AI/多窗口/watch 等不支持能力统一错误）
├── tauri/            # 现有 @tauri-apps 调用的搬运与包装（行为不变）
└── harmony/
    └── bridge-client.ts  # WebMessagePort JSON-RPC 客户端 + 事件订阅
```

**接口裁剪原则**：只定义 MVP 调用点实际用到的方法。四个域的最小集合：

- `fs`：readTextFile / writeTextFile / readDir（树懒加载）/ mkdir / rename / remove（带永久删除语义）/ exists / stat
- `dialog`：pickDirectory（工作区）/ pickOpenFile / pickSaveFile / message（提示框）/ confirm
- `store`：get(key) / set(key,value)（底层 JSON 文件，格式沿用 `mditor.json`）
- `app`：appDataDir / appendLog / version / fetchImageUrl（见 5.6）/ onMenuEvent / windowControls（hide/minimize/maximize/close 的能力探测，鸿蒙下隐藏）

**迁移方式**：`lib/tauriFs.ts`、`fileOps.ts`、`dialogs.ts`、`store.ts` 的现有函数签名保持不变，内部改为 `getAdapter().fs.xxx` 转发；其余 15+ 文件的直接 import 全部收敛为 import 这几个 lib 模块（或直接 import platform）。**禁止**在业务代码里出现 `@tauri-apps` 字样。

**运行时检测**：Tauri 环境存在 `window.__TAURI_INTERNALS__`；鸿蒙由 ArkTS 在 `javaScriptOnDocumentStart` 注入 `window.__MDITOR_HARMONY__ = { version, platform:'harmony' }`。两者皆无 → `browser`（`npm run dev` 时给明确提示条「当前为浏览器预览，文件功能不可用」，替代现在的静默失败，顺手修掉 README 提到的老问题）。

### 5.3 JSBridge 协议（前后端各一份实现，必须一致）

- 通道：ArkWeb `webview.Webview.createWebMessagePorts()`，端口 0 留在 ArkTS，端口 1 通过 `javaScriptOnDocumentStart` 注入的引导代码交给前端 `bridge-client`。
- 请求：`{ type:'rpc', id:number, method:string, params:object }`；响应：`{ type:'rpc', id, ok:true, result } | { type:'rpc', id, ok:false, error:{code,message} }`。前端 promise 化，超时 30s。
- 事件：`{ type:'event', event:string, payload }`（MVP 仅 `settings-changed` 预留，事件名对齐现有 `lib/multiWindow.ts` 命名风格）。
- method 命名域：`fs.*` / `dialog.*` / `store.*` / `app.*`，与 5.2 接口一一对应，便于两端对表。
- ArkTS 分发：`Bridge.ets` 维护 `Map<string, (params)=>Promise<object>>` 注册表，统一 try/catch 转 `error`；所有方法必须显式注册，未注册方法返回 `UNSUPPORTED`。

### 5.4 鸿蒙工程 `mditor/harmony/`（与 `src-tauri/` 平级）

```
harmony/
├── AppScope/app.json5                 # bundleName "com.mditor.app"（占位，上架前改）
├── build-profile.json5 hvigorfile.ts  # 标准 hvigor 工程
├── oh-package.json5
└── entry/src/main/
    ├── module.json5                   # abilityStage + 主窗口（PC 免悬浮窗等特殊权限）
    ├── ets/
    │   ├── entryability/EntryAbility.ets
    │   ├── pages/Index.ets            # Web 组件：加载 rawfile、建端口、onConsole 看门狗
    │   ├── bridge/Bridge.ets          # RPC 分发注册表
    │   ├── io/FileManager.ets         # 见 5.5
    │   ├── io/UriMapper.ets           # 工作区 token ↔ 根 URI ↔ 相对路径 映射，持久化到 filesDir/uri-map.json
    │   └── store/SettingsStore.ets    # filesDir/mditor.json（与桌面格式完全一致）
    ├── resources/base/profile/main_pages.json
    └── resources/rawfile/web/         # vite 构建产物（gitignore，脚本拷贝）
```

### 5.5 文件访问模型（本次迁移最深的设计点，按此实现）

鸿蒙沙箱下无任意路径访问，而前端全部业务以「路径字符串」为语义。方案：

1. 用户经 `DocumentViewPicker`（DIRECTORY 模式）选工作区根 → ArkTS 拿到根 URI 并持久化权限（picker 返回的 URI 按官方文档方式保活；若权限过期，下次访问报 `E_PERMISSION`，前端提示重新选择）。
2. `UriMapper` 分配稳定 token（如 `ws-1`），前端看到的路径 = `/Docs/<token>/<相对路径>` 形式的**虚拟路径**；映射细节全部收在 ArkTS 侧。
3. `fs.*` 方法收到虚拟路径 → 拆 token + 相对路径 → `fs.open(根URI + '/' + relPath)` 读写。相对路径的 join/normalize 复用 `path-shim.ts` 的语义（`/` 分隔）。
4. 单文件打开（无工作区）：`DocumentViewPicker` 单选 → 临时 token 挂载。
5. 最近文件/工作区列表：`store` 域存的仍是「虚拟路径」，重启后由 UriMapper 还原；还原本失败（权限过期）时标记缺失而非崩溃（对齐桌面版对失效最近文件的现有容错行为，动手前先看 `store.ts` 如何处理）。
6. **桌面版完全不受影响**：Tauri 实现里路径就是真实路径，`path-shim.ts` 照旧。

### 5.6 其余桌面能力的鸿蒙映射

| 桌面（Rust/插件） | 鸿蒙 MVP 实现 |
|---|---|
| `fetch_image`（绕 CSP 图片代理） | ArkWeb 无 Tauri CSP 限制：`fetchImageUrl(url)` 直接返回原 URL，`<img>` 直连 |
| `trash_file` | `fs.unlink` 永久删除；前端确认弹窗文案在鸿蒙下注明「永久删除，不进回收站」（`fileOps.ts` 审计照走） |
| `append_log` / `app_data_dir` | 写沙箱 `filesDir/logs/` 与 `filesDir/`，路径由 bridge 返回 |
| AI 四命令 | `UnsupportedError`；`lib/ai.ts` 调用点已有错误管道，鸿蒙下 AI 面板发消息显示「鸿蒙版暂不支持 AI（规划中）」；设置页 AI 配置允许保存（写 store 不受影响） |
| 多窗口三命令 | `UnsupportedError`；`multiWindow.ts` 调用点加运行时守卫（`getAdapter().capabilities.multiWindow === false` 时整段跳过），单窗口照常 |
| fs watch（`useFileWatcher`） | 不支持；验证该 hook 对订阅失败的容错（找不到就补 try/catch 降级为不监听） |
| `get_pending_file` / CLI 参数 | 鸿蒙无此语义，adapter 返回 null |
| 窗口 min/max/close（TitleBar） | 鸿蒙下隐藏这三个按钮与拖拽区（保留菜单栏与标题文字），通过 `app.windowControls` 能力探测驱动，不改 TitleBar 结构 |
| 导出 | HTML 导出走 `dialog.pickSaveFile` + `fs.writeTextFile`，MVP 保留；PDF/Word/PNG/LaTeX 见「七」 |

### 5.7 ArkWeb 已知坑（实现时逐条核对）

- vite `base` 必须设为 `'./'`（相对路径），否则 rawfile 下资源 404——用 vite 的**多配置/命令行 `--base`** 处理，不改桌面版默认行为。
- `sessionStorage`/`localStorage` 在 ArkWeb 可用，`lib/session.ts` 自愈逻辑照常。
- KaTeX/highlight.js 字体与资源全部本地打包，无外链依赖。
- 端口注入必须在页面 JS 运行前（`javaScriptOnDocumentStart`），否则 `bridge-client` 错过握手窗口；握手采用「注入代码挂全局 → 页面 load 后 bridge-client 主动连接」的幂等模式。
- ArkWeb 默认 UA 含 HarmonyOS 标识：运行时检测不要依赖 UA（用 5.2 的注入变量），但日志里记录 UA 便于诊断。
- 中文路径/文件名在桥接 JSON 里天然安全（全程字符串），但 UriMapper 落盘的 map 文件必须 UTF-8 无 BOM。

## 六、实施阶段（顺序执行，每阶段结束提交）

### 阶段 0：环境核验（0.5h）

`hvigorw -v`、`ohpm -v`、`hdc version` 三条命令可执行即通过；不符则按 `memory/2026-09-13.md` 修正 PATH 后重试。

### 阶段 1：前端平台适配层重构（核心，纯前端，本机可全程验证）

1. 建 `src/platform/`（types/index/errors/tauri/*）；先把 `tauriFs/fileOps/dialogs/store/path-shim` 内部切到 `platform/tauri/*`（行为不变的自搬运）。
2. 按事实表逐文件收敛 15 处 plugin-fs、6 处 plugin-dialog、17 处 invoke、事件监听——**每收敛 3-5 个文件跑一次 `npm run test`**。
3. `browser` 运行时降级提示（见 5.2）。
4. 验收：`npm run build`（tsc + vite）绿、`npm run test` 582 用例绿、`npm run tauri dev` 人工冒烟（打开工作区→编辑→保存→导出 HTML→设置持久化）；全局 `grep -r "@tauri-apps" src/ --include="*.ts" --include="*.tsx"` 仅剩 `src/platform/tauri/` 命中。

### 阶段 2：鸿蒙工程壳（能出 HAP）

1. 手写 5.4 工程骨架（module.json5 / build-profile / EntryAbility / Index.ets + ArkWeb）。
2. `package.json` 加 `build:harmony`：`vite build --base=./` → 拷 `dist/` 至 `harmony/entry/src/main/resources/rawfile/web/` → `ohpm install` + `hvigorw assembleHap`（脚本用 Node 写，放 `scripts/build-harmony.mjs`，跨 shell 稳定）。
3. `harmony/.gitignore` 忽略 rawfile/web 与 build 产物。
4. 验收：`npm run build:harmony` 产出未签名 HAP；该阶段不要求页面可交互（桥还没通）。

### 阶段 3：JSBridge + 鸿蒙文件能力（端到端核心）

1. ArkTS：`Bridge.ets`（5.3 协议分发）+ `FileManager.ets`/`UriMapper.ets`（5.5 模型）+ `SettingsStore.ets`（`fs.*`/`dialog.*`/`store.*`/`app.*` 全部注册）。
2. 前端：`harmony/bridge-client.ts` + `platform/harmony/index.ts` 适配器；`detectRuntime` 接入。
3. **无真机/模拟器的验收方式**：桥协议两端逻辑各写单测——前端侧用内存 mock 端口模拟 ArkTS 行为（复用 2.2 的 vi.mock 惯例）；ArkTS 侧纯逻辑类（UriMapper/协议分装）用 `@ohos/hypium` 本地单测。`npm run test` 全绿。
4. 真机端到端联调（选工作区→文件树→打开→编辑→保存→重启恢复）标注为「待签名证书后执行」的后续清单，不阻塞本阶段。

### 阶段 4：PC 形态收尾

1. TitleBar 窗口控制按钮按 5.6 隐藏（能力探测驱动）。
2. 右键菜单、hover、Ctrl 快捷键、拖拽分隔条在 ArkWeb 下逐项人工过（有条件真机）或代码走查（无设备时）。
3. README 平台徽章加 HarmonyOS PC + 构建一节；CHANGELOG 加 Unreleased 段（版本号三处不动，发布节奏用户定）。

### 阶段 5：验证与交付

- `npm run build && npm run test` 绿（含新增用例）；`npm run build:harmony` 出 HAP。
- 新增 `harmony/README.md`：构建指南、AGC 调试证书申请与签名步骤、真机部署步骤、MVP 能力矩阵、已知限制（AI/watch/回收站/多窗口/PDF 导出）。
- 提交全部改动，输出「后续清单」（真机联调、签名、上架材料）。

## 七、MVP 明确不做清单（接口留位，不实现）

| 能力 | 处理 |
|---|---|
| AI 助手 / Agent / RAG 问答 / 嵌入 | UnsupportedError + UI 提示；二期走 ArkTS http SSE 代理 |
| 全库索引/双链/BibTeX/闪卡（科研套件） | 不注册入口；`ragIndex`/`vaultIndex` 等模块代码保留（fs 已走适配层，天然可在鸿蒙沙箱工作区工作，二期评估开启） |
| 文件 watch / 外部修改监听 | 降级为不监听 |
| 回收站删除 | 永久删除 + 确认文案 |
| 多窗口多开 | 单窗口 |
| PDF / Word / PNG / LaTeX 导出 | 入口隐藏（能力探测），仅保留 HTML 导出 |
| 远程图片代理 | 前端直连 |
| 手机/折叠屏布局、触摸优化 | 不做 |

## 八、风险与对策

| 风险 | 对策 |
|---|---|
| URI 权限模型与前端路径语义冲突（最深） | 5.5 的 token 映射方案；权限过期统一 `E_PERMISSION` 错误码，前端有引导 |
| 25 文件收敛引入桌面回归 | 分批收敛 + 每批 vitest + 阶段 1 人工冒烟；测试注入面（2.2）兜底 |
| commandline-tools 与 SDK 版本漂移 | 阶段 0 核验；SDK 内嵌于工具包，锁定 6.0.2.670 |
| hvigorw 需要 JDK（签名工具为 Java 实现） | 本机无 Java：若 `hvigorw assembleHap` 报缺 JDK，装 Temurin JDK 17 并设 `JAVA_HOME`（先核查再改环境变量）；构建本身（hvigor 为 Node 实现）不依赖 Java |
| ArkWeb rawfile 资源 404 | vite `--base=./`（5.7 第一条）；阶段 2 构建后用未签名包结构检查产物路径 |
| 无设备导致端到端验证缺失 | 阶段 3 双端单测 + mock 集成测试；真机清单移交用户 |
