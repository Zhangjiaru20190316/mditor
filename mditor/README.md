# Mditor

本地优先的 Markdown 编辑器，体验对标 Typora。基于 **Tauri 2 + React 18 + Milkdown (Crepe)** 构建 —— 无云端、无遥测，文件始终保存在你的电脑上。

![platform](https://img.shields.io/badge/platform-Windows-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![downloads](https://img.shields.io/github/downloads/Zhangjiaru20190316/mditor/total?label=downloads&color=success)

> 🌐 官网与下载：<https://Zhangjiaru20190316.github.io/mditor/>（GitHub Pages）

## 功能特性

- **所见即所得编辑**：Milkdown/ProseMirror 内核，支持 GFM（表格 / 任务列表 / 脚注 / 删除线）、KaTeX 公式、CodeMirror 代码块高亮
- **三种编辑模式**：`wysiwyg`（所见即所得）/ `ir`（即时渲染）/ `sv`（源码），状态栏一键切换
- **工作区文件树**：懒加载目录、新建 / 重命名 / 删除 / 批量多选、外部修改实时监听（自动同步 / 冲突确认）
- **大纲 & 批注**：侧边栏大纲跳转；原生脚注语法的行内批注（`[^anno-N]`），支持 AI 一键批注
- **AI 助手**：OpenAI 兼容接口（自定义 BaseURL / Key / 模型，多配置管理），SSE 流式输出，选中文字快捷操作
- **导出**：HTML / PDF / PNG（长图）/ Word (docx)，主题样式完整保留
- **专注模式**、主题（浅色 / 深色 / 护眼 / Claude 双色）、字体字号行距可调、拼写检查开关
- **大文档性能模式**：超过阈值自动关闭代码高亮与公式渲染；内置内存守护（软重建 / 会话快照自愈）
- **本地化持久化**：设置与最近文件存于应用数据目录（`mditor.json`），无任何网络上报

## 环境要求

- [Node.js](https://nodejs.org/) ≥ 20，npm ≥ 10
- [Rust](https://www.rust-lang.org/tools/install) stable（含 MSVC 工具链）
- Windows 10/11（WebView2）；macOS / Linux 见下方说明

## 开发

```bash
cd mditor
npm install        # 安装前端依赖
npm run tauri dev  # 启动开发模式（热重载）
```

常用脚本：

| 命令 | 说明 |
|---|---|
| `npm run dev` | 仅启动 Vite（浏览器预览，无 Tauri 外壳，IPC 功能不可用） |
| `npm run tauri dev` | 完整应用开发模式 |
| `npm run build` | 类型检查 + 前端产物构建 |
| `npm test` | Vitest 单元测试 |
| `npm run lint` | ESLint 检查 |
| `npm run tauri build` | 打包发布版（NSIS 安装包） |

## 构建与发布

```bash
npm run tauri build
# 产物：src-tauri/target/release/bundle/nsis/Mditor_<version>_x64-setup.exe
```

CI（`.github/workflows/release.yml`）在推送 `v*` 标签时自动构建并创建 GitHub Release（含 rust-cache 加速）。

### 关于自动更新的移除（v3.5.0）

此前集成的 tauri-plugin-updater 使用的端点是占位符（`github.com/USER/REPO`），"检查更新"必然失败，因此 v3.5.0 整体移除了更新器（插件、权限、UI 入口）以收窄权限面。若要恢复：

1. `Cargo.toml` 加回 `tauri-plugin-updater`，`lib.rs` 注册插件；
2. `package.json` 加回 `@tauri-apps/plugin-updater`；
3. `tauri.conf.json` 配置真实 `plugins.updater` 端点与公钥，`bundle.createUpdaterArtifacts` 设为 `true`；
4. 恢复 `capabilities/default.json` 的 `updater:default` 权限及前端入口（历史上曾存在 `src/lib/updater.ts` 与 `src/components/UpdateModal.tsx`，可在 git 历史 `v3.4.2` 中找到）。

## 安全模型

- **CSP**：`script-src 'self'`（无 unsafe-eval）、出站连接仅 `ipc:`——AI 请求与图片下载全部经 Rust 侧代理，渲染层无法直连外网
- **HTML 消毒**：AI 回复 / 批注预览的 Markdown 渲染管线内置 `rehype-sanitize`，`<img onerror>`、`javascript:` 链接等不可执行
- **权限面（capabilities）**：仅授予实际使用的 fs/dialog/store/shell-open 权限（含 `fs:allow-watch` 供外部修改监听）；`fs` 与 asset 协议的 `**` 通配是"任意目录可打开"这一产品能力的必然结果——本应用的定位即本地文件编辑器
- **无 updater / 无 shell 执行**：不存在执行外部进程的权限

## 项目结构

```
mditor/
├── src/                    # React 前端
│   ├── components/         # Editor / FileTree / AiPanel / SettingsModal 等
│   ├── hooks/              # useMilkdown（编辑器核心）/ useFile / useFileWatcher 等
│   └── lib/                # exporter / renderMarkdown / store / ai 等纯逻辑
├── src-tauri/              # Rust 后端（菜单、AI HTTP 代理、图片下载）
└── docs/                   # 设计与实施文档
```

## 支持本项目

Mditor 是完全开源、免费、无广告、无遥测的软件。如果它帮到了你，欢迎请我喝杯咖啡，每一份支持都会直接转化为更好的更新。

- **爱发电**（中国大陆，推荐）：https://afdian.com/u/d582c7c0989811f18da15254001e7c00
- **GitHub Sponsors**：https://github.com/sponsors/Zhangjiaru20190316
- **微信赞赏码 / 支付宝**：待补充

## License

MIT
