# 安全说明

本页解释 `src-tauri/tauri.conf.json` 里几个容易被误解的安全相关配置，以及
数据存储的边界。改动这些配置前请先读完对应小节。

## `dangerousDisableAssetCspModification: true`（CSP）

Tauri 默认会在运行时**自动改写**应用声明的 CSP：向 `script-src` 注入由
asset 协议动态生成的 nonce/hash，以便 `asset://`（Windows 上为
`http://asset.localhost`）加载的本地资源能通过 CSP。注入的具体形式随
Tauri 版本变化，且会绕过开发者对 CSP 的完全控制。

本应用将其禁用（`dangerousDisableAssetCspModification: true`），改为在 CSP
里**显式**放行所需来源：

```json
"csp": "default-src 'self';
        img-src 'self' asset: http://asset.localhost data: blob:;
        style-src 'self' 'unsafe-inline';
        script-src 'self';
        connect-src 'self' ipc: http://ipc.localhost;
        font-src 'self' data:"
```

要点：

- `script-src 'self'`——无 `'unsafe-inline'`、无 `eval`，所有脚本（含 V3.6.5
  起的解析 worker chunk）都来自应用自身打包产物；
- 本地图片经 asset 协议（`asset:` / `http://asset.localhost`）读取，已在
  `img-src` 显式列出，不依赖 Tauri 的自动注入；
- 富文本/导出内容里的 HTML 由 sanitize 管线兜底（rehype-sanitize +
  白名单），CSP 是第二道防线而非唯一防线。

**改动者注意**：如果未来把资源改成经 asset 协议加载 `<script>`/`<style>`
（目前没有），关闭自动注入意味着必须手动在 CSP 里放行对应来源，否则资源
会被静默拦截。JSON 配置不支持注释，因此该说明放在本页——改动 CSP 前请
同步更新这里。

## 文件系统权限为全盘（`**`）

`fs` 插件的 scope 为 `**`：编辑器需要打开/保存用户任意位置的 Markdown 文档
（打开文件夹、拖放、最近列表、另存为），无法预枚举路径白名单。这是本地
优先编辑器的刚需取舍。攻击面收敛依赖：

- 任意 HTML/脚本内容**只**进入富文本渲染与导出管线，均过 sanitize；
- CSP 禁止外联脚本；网络请求仅 AI 面板的受控 fetch（`connect-src`）。

## AI API Key 以明文存储

设置（含各 AI 模型连接的 `apiKey`）保存在本机的 Tauri store
（`mditor.json`，位于应用数据目录），**未加密**——与主流桌面工具
（VS Code 扩展、Typora 主题类配置）一致的取舍：

- 本地优先：密钥不出机器、不经任何第三方中转，直达你配置的 provider；
- OS 级保护（磁盘加密 / 用户账户隔离）是实际的安全边界；
- 不做加密的原因：任何由应用自身保管密钥的加密（混淆式主密钥）都无法
  防御同权限下的攻击者，只会制造"已加密"的错觉。

如需更强隔离：使用支持细粒度限额 / 可随时吊销的 key，并通过系统级凭据
管理器（如 Windows 凭据管理器）配合本地网关（如 Ollama、one-api）使用。

## HTML 笔记隔离模型（HN 轮）

背景：用户可把 HTML 文件导入 vault 作为「可交互 HTML 笔记」——笔记自带的
CSS/JS（折叠、选项卡、脚本组件、CDN 图表）必须在应用内完整生效。实测依据
与复现工具见 `docs/html-note-spike-report.md` 与 `public/html-note-demo/`。

**威胁面**：HTML 笔记是不可信内容（可能来自任意网站/工具的导出）。若其
脚本进入主窗 origin，可直接调用全部 Tauri IPC（fs 读写、命令执行）——等于
把应用权限让渡给笔记作者。

**防御层次（相互独立，各自成立）**：

1. **协议 origin 隔离（地基）**：笔记在 iframe 中以 asset 协议 URL 加载
   （Windows `http://asset.localhost/...`，打包版主窗为
   `tauri.localhost`——不同源）。主窗 CSP 显式 `frame-src` 放行协议源，
   除此之外 iframe 通道对主窗不可达（`srcdoc`/`blob:` 会继承主窗 CSP，
   内联脚本必死，故不可用）。
2. **sandbox 属性（纵深）**：`allow-scripts allow-forms allow-popups`，不给
   `allow-same-origin`——opaque origin，父窗/顶层窗互访在浏览器层被拦
   （SecurityError），笔记间也不共享 storage。
3. **Tauri capability ACL（保底）**：spike 无 sandbox 探针实测——即使
   前两层失效，`__TAURI_INTERNALS__.invoke` 仍被拒（`... not allowed`）：
   asset 源不在任何 capability 的 local/remote 白名单内。IPC 的防护在
   invoke 校验层，不在网络层（`fetch ipc:` 网络层可达但拿不到命令执行）。

**内容策略（与既有两套 HTML 策略的边界）**：

- 笔记 iframe 内**零转换零消毒**（转换杀交互、消毒杀脚本）；
- 任何笔记派生物进入主 DOM 前：搜索摘要 = 纯文本（React 转义承载，无标记）；
  「转 Markdown」预览 = `renderMarkdown` 现有 rehype-sanitize 白名单管线；
  笔记原文**绝不**注入主文档 innerHTML；
- 笔记 iframe 不持有任何 Tauri capability / IPC 通道，无跨 frame 桥。

**外链策略（决策记录）**：iframe 文档无 CSP，外链 `https` 资源（CDN 组件）
默认放行——L3「完整单文件应用」形态是需求的一部分；离线模式涉及加载前
内容改写（注入 CSP meta 或协议层过滤），与「不转换不消毒」原则冲突，
留作后续设置项单独设计评审（见 spike 报告「阶段 3 设计占位」）。

**能力位**：`capabilities.htmlNoteView`——Windows true（spike 结论 A）；
harmony false（`mditor-asset://` 行为未真机验证，保守降级为「用系统浏览器
打开」，不假成功）。

**URL 形态注意**：iframe src 必须用 `lib/htmlNote.ts` 的 `assetFrameUrl`
（按路径段编码、保留字面 `/`）——`convertFileSrc` 的全量编码会把分隔符
编成 `%2F`，文档内相对引用将全部解析到协议根（spike ②实测失败根因）。
