# HTML 笔记 Spike 报告（阶段 0 · 闸门）

- 日期：2026-10-22
- 环境：Windows 10（10.0.26200）· WebView2 Edg/155 · Tauri dev（`tauri dev`，CDP 9222 采证）
- 结论：**A —— iframe + asset 协议路线在 Windows 成立**，阶段 1 按原方案继续。
- 鸿蒙（④）：**未验证**（无真机/模拟器连接）。按保守原则处理：
  `capabilities.htmlNoteView = false`（沿用 multiWindow 的能力位守卫模式），
  UI 降级为「用系统浏览器打开」，不做假成功。待真机补测后翻转。

## 一、四项实测结果

实测载体：官方测试页 `public/html-note-demo/`（index.html + sub/relative.html +
ipc-probe.html + assets/），dev 专用通道 `src/dev/htmlNoteSpike.tsx`（App 尾部
`import.meta.env.DEV` 门控挂载，产物构建被静态消除）。测试页自检结果经
`http://127.0.0.1:8901/report` 上报采集器（`scripts/spike-collector.mjs`），
原始数据：`perf/results/html-note-spike.jsonl`；窗口截图：
`perf/results/html-note-spike-final.png`。

### ① 内联 script 是否执行 —— ✅ 执行

- 计数按钮初始化为 1、可点击递增；页面全部逻辑（资源检测/选项卡/自检/上报）
  都由内联脚本驱动，自检数据能够产出即为执行铁证。
- iframe 形态：`sandbox="allow-scripts allow-forms allow-popups"`（无
  allow-same-origin）。

### ② 相对路径子资源是否解析 —— ✅ 解析（需要一项 URL 形态修正）

| 检查 | 结果 |
| --- | --- |
| `<img src="assets/mditor-demo.png">`（子目录） | ✅ 加载 |
| `<img src="sub/../assets/…">`（.. 段消解） | ✅ 加载 |
| `<link rel=stylesheet href="assets/note.css">`（外链 CSS） | ✅ 生效（rgb(255,122,0)） |
| sub/relative.html 内 `<img src="../assets/…">` 与 `<link href="../assets/note.css">`（真子目录页 + .. 上跳） | ✅ 全部生效 |

**关键发现（必改点 1）**：`convertFileSrc` 对路径整体做
`encodeURIComponent`，分隔符全部变成 `%2F` —— 文档 URL 里没有任何字面 `/`，
RFC 3986 相对解析把所有相对引用都落到协议根（`/assets/x.png` → 不在授权
scope → 404）。首页测得 imgSubdir/imgDotDot/cssLink 全 false 即此因。
修复：自建「按路径段编码、保留字面 `/`」的 URL（
`http://asset.localhost/C%3A/Users/hh/…/index.html`），相对解析按目录层级
自然工作（上表全 ✅ 即修复后实测）。该函数 `assetFrameUrl` 已随 spike 通道
落地（阶段 1 移入 `HtmlNoteView`），仅 Tauri 运行时启用；harmony 的
`mditor-asset://` 解析行为未验证，保持适配器原样输出。

**关键发现（必改点 2）**：CSP `frame-src` 缺失时 iframe 整体被拦
（default-src 'self' 回退；实测第一轮无 frame-src 时测试页完全未执行、零上报）。
且本项目 CSP 有**两份镜像**：`tauri.conf.json`（打包时 Tauri 注入）与
`index.html` 的 meta（dev/vite 直连时生效的那份）——只改配置不改 meta，dev
下照样被拦（实测确认）。两处均已加
`frame-src asset: http://asset.localhost mditor-asset:`，并以
`src/lib/tauriCspConfig.test.ts` 断言钉死（含两份 CSP 指令集一致性）。

Windows 盘符 `C:` 的 `%3A` 编码本身不构成问题（Tauri 资产处理器对路径整体
做百分号解码）；构成问题的是分隔符编码，见上。

### ③ 隔离三断言 —— ✅ 全部成立（含无 sandbox 纵深验证）

sandbox 形态（生产形态，无 allow-same-origin）：

| 断言 | 结果 | 细节 |
| --- | --- | --- |
| `window.__TAURI__` 为 undefined | ✅ | withGlobalTauri 关闭，主窗同样没有 |
| 父窗 DOM 不可访问 | ✅ | `window.parent.document` 抛 SecurityError |
| 顶层窗不可读 | ✅ | `window.top.location` 跨源拦截 |
| IPC invoke 不可达 | ✅ | `__TAURI_INTERNALS__` 虽被注入所有 frame（信息项），但 invoke 被拒：`Origin header is not a valid URL`（sandbox 使 Origin 为 null，Rust 侧拒绝） |
| `fetch ipc://localhost` 不可达 | ✅ | 网络层可达（405，type=cors）——**防护不在网络层**，在 invoke 的 Origin/capability 校验层；见下 |

**无 sandbox 变体（`ipc-probe.html`，纵深防御验证）**：去掉 sandbox 属性后，
`__TAURI_INTERNALS__.invoke("app_data_dir")` 仍被拒
（`app_data_dir not allowed. Plugin not found` —— capability ACL 按 frame
origin 判定，asset 源不在任何 capability 的 remote/local 白名单），
父窗 DOM 仍跨源拦截。**两层防御（sandbox opaque origin + Tauri capability
ACL）互相独立、各自成立**——产品保留 sandbox 属性作纵深，但隔离不依赖它。

如实记录（非失败项）：
- `fetch('http://ipc.localhost/')` 网络层是通的（405 响应可读）。这意味着
  「fetch 不可达」的准确表述是「**IPC 命令不可达**」：真实攻击路径
  （invoke）被 Origin/capability 双层拒绝，裸 fetch 拿不到任何命令执行。
- `__TAURI_INTERNALS__` 会被 WebView 注入到所有 frame（含笔记 iframe）——
  注入本身无害，可達性止步于 invoke 校验。测试页将其列为信息项。
- sandbox 下 `localStorage` 抛 SecurityError（信息项：每篇笔记互不共享
  storage，隔离反而更强）。

### ④ harmony（mditor-asset://）—— ⏸ 未验证

无真机/模拟器。处理：能力位 `capabilities.htmlNoteView=false`（harmony），
HTML 笔记标签降级为「用系统浏览器打开」提示页；`assetFrameUrl` 对 harmony
返回适配器原输出（其 onInterceptRequest 的相对解析行为待真机补测后再定）。

## 二、结论与后续

**A：Windows 全项通过 → 阶段 1 继续。** 两个必改点已随本阶段落地：

1. `frame-src`：tauri.conf.json + index.html meta 双份同步 + 测试钉死；
2. `assetFrameUrl`：按段编码、保留字面 `/`（进 `HtmlNoteView`）。

### 附：dev 与打包版差异说明

本 spike 在 `tauri dev`（vite 直连 + index.html meta CSP）下完成。打包版
走 `tauri://localhost` + Tauri 注入 CSP（同一份配置）。frame-src 已同时落在
两份源上；阶段 1 手动回归清单含「打包版（`tauri build --no-bundle`）开笔记
iframe 复验」一项，防 dev/prod 注入差异。

### 附：Plan B 备忘（未触发，仅记录）

若未来任一平台出现「iframe+asset 不成立」：
Rust 侧 `register_uri_scheme_protocol("mditor-note", …)` 专用协议（路径映射
笔记目录，天然相对解析），或独立 `WebviewWindow` 主路线。本报告不实施。

### 附：阶段 3 设计占位（本期不实施）

- **快照导出 PNG/PDF**：modern-screenshot 走 SVG foreignObject，跨 origin
  iframe 不可捕获（asset 协议 iframe 与主窗不同源）。备选：Windows 侧
  `webview2-com CaptureScreenshot`（仅 Windows），或产品级取舍「JS 渲染型
  笔记不支持快照」。
- **md 内嵌 html-block（shadow DOM，L1 级）**：进主 DOM 必须 rehype-sanitize
  白名单（renderMarkdown 现有管线），只保留纯 CSS 交互能力。
- **离线模式设置项**：iframe 文档无 CSP，外链 https 默认放行；离线开关需在
  加载前注入 `<meta CSP>` 或经 Rust 协议层过滤——均涉及内容改写，与「不
  转换不消毒」原则冲突，需单独设计评审。

## 三、复现步骤

1. 采集器：`node scripts/spike-collector.mjs perf/results/html-note-spike.jsonl`
2. （可选自动化弹出）`echo auto > public/html-note-spike-auto.flag`（采证后删除）
3. `npm run tauri dev`，点右下角「🧪 HTML 笔记 Spike」（或靠 flag 自动弹出）
   → 「加载」= 授权 demo 目录 + 挂 iframe；
4. 观察面板全绿 + 采集器输出；CDP 深查（可选）：
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev`
   后 `node scripts/spike-cdp.mjs out.png`（注意本机 9222/IPv4 可能被其它
   浏览器占用，脚本优先走 `[::1]`）。
