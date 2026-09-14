# Mditor

本地优先的 Markdown 编辑器，体验对标 Typora。基于 **Tauri 2 + React 18 + Milkdown (Crepe)** 构建 —— 默认无云端、无遥测，文件始终保存在你的电脑上；如需多设备同步，可选用你自己的 S3 兼容对象存储（见「云同步」）。

![platform](https://img.shields.io/badge/platform-Windows-blue) ![platform](https://img.shields.io/badge/HarmonyOS%20PC-6.0-red) ![license](https://img.shields.io/badge/license-MIT-green) ![downloads](https://img.shields.io/github/downloads/Zhangjiaru20190316/mditor/total?label=downloads&color=success)

<p align="center">
  <img src="docs/assets/mditor-promo.svg" alt="Mditor — 本地优先 · 所见即所得的 Markdown 编辑器" width="720"/>
</p>

> 🌐 官网与下载：<https://Zhangjiaru20190316.github.io/mditor/>（GitHub Pages）

## 功能特性

- **所见即所得编辑**：Milkdown/ProseMirror 内核，支持 GFM（表格 / 任务列表 / 脚注 / 删除线）、CodeMirror 代码块高亮
- **数学公式全场景**：`$…$` / `$$…$$` / `\(…\)` / ```` ```math ```` 定界符全支持（打开 LaTeX 风格文档保存时统一回写为 `$` 风格）；mhchem 化学式 `\ce{}`、自定义 KaTeX 宏、可选公式自动编号与 `\label`/`\ref` 交叉引用（编号生效于 AI 面板与导出，编辑器内用 `\tag{}` 手动编号）；导出 HTML/PDF 公式完整渲染（独立 HTML 自动内嵌 KaTeX 字体）、导出 Word 公式栅格化为高清图片；AI 面板复制公式自动还原 LaTeX 源码
- **三种编辑模式**：`wysiwyg`（所见即所得）/ `ir`（即时渲染）/ `sv`（源码），状态栏一键切换
- **工作区文件树**：懒加载目录、新建 / 重命名 / 删除 / 批量多选、外部修改实时监听（自动同步 / 冲突确认）
- **大纲 & 批注**：侧边栏大纲跳转；原生脚注语法的行内批注（`[^anno-N]`），支持 AI 一键批注
- **AI 助手**：OpenAI 兼容接口（自定义 BaseURL / Key / 模型，多配置管理），SSE 流式输出，选中文字快捷操作
- **AI Agent 模式（v4.9）**：面板顶部「对话 | Agent」切换——Agent 可检索（关键词 + 向量双路）、读取、精确编辑、追加、新建、重命名、删除笔记，支持批量整理；所有改动先暂存为「改动清单」，逐条审阅（可部分勾选）后才应用，当前笔记编辑一步撤销；写入策略可配置（逐条确认 / 自动应用当前笔记编辑）；删除一律进系统回收站（可恢复）
- **导出**：HTML / PDF / PNG（长图）/ Word (docx) / **LaTeX (.tex)**（纯前端 md→tex，XeLaTeX/ctexart 可编译），主题样式完整保留
- **知识功能（v4.7 科研套件，本地优先）**：全库索引 + Ctrl+P 快速跳转；`[[双链]]` 输入补全 / 点击跳转 / 反链与标签面板；学术引用链（.bib 文献库、`[@citekey]` 行内引用、References 自动文献表、图表编号交叉引用）；`:::flash` 间隔重复闪卡（SM-2 简化调度、AI 改写做卡、复习模式）；库级 AI 问答（RAG 向量检索，默认关闭、需配置嵌入模型）——语法规范见 `docs/research-features.md`
- **专注模式**、主题（浅色 / 深色 / 护眼 / Claude 双色）、字体字号行距可调、拼写检查开关
- **大文档性能模式**：超过阈值自动关闭代码高亮与公式渲染；内置内存守护（软重建 / 会话快照自愈）
- **本地化持久化**：设置与最近文件存于应用数据目录（`mditor.json`），无任何网络上报
- **云同步（v4.12，可选）**：自带存储（BYO storage）双向同步工作区目录到你自己的 S3 兼容对象存储（七牛云 Kodo / 阿里云 OSS / Cloudflare R2 / MinIO 自建 / AWS S3 / 任意自定义端点）。默认关闭、不开即零网络；文件级 3-way 合并，冲突自动产生 `.冲突-时间戳` 副本双端可见，本地删除进应用内回收站；支持保存后防抖 / 定时 / 启动自动同步与断网自动恢复；状态栏四态指示器，多窗口状态一致。鸿蒙端 v4.13 起同步支持（待真机验收，能力矩阵见 `harmony/README.md`）

## 环境要求

- [Node.js](https://nodejs.org/) ≥ 20，npm ≥ 10
- [Rust](https://www.rust-lang.org/tools/install) stable（含 MSVC 工具链）
- Windows 10/11（WebView2）；macOS / Linux 见下方说明
- **鸿蒙 PC（可选）**：HarmonyOS Command Line Tools 6.0+（内嵌 API 22 SDK）+ JDK 17（仅打包/签名需要），详见 `harmony/README.md`

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

## 鸿蒙（HarmonyOS PC）构建

前端与 Windows 版同源（React 构建产物离线打进 `harmony/entry/src/main/resources/rawfile/web/`，由 ArkWeb 加载；文件/存储/弹窗经 JSBridge 走 ArkTS 原生实现）：

```bash
npm run build:harmony   # vite --base ./ → 拷贝 rawfile → ohpm → hvigor 打未签名 HAP
```

能力矩阵（AI / 富文本导出 / 云同步 / 文件监听 / 回收站已实现待真机验收；PDF 导出与多窗口未做）、签名与真机部署、上架 AppGallery 步骤见 [`harmony/README.md`](harmony/README.md) 与 [`docs/harmony-release.md`](docs/harmony-release.md)。

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
- **Agent 写入安全边界（v4.9）**：AI 工具的写类操作路径必须解析后落在已打开的工作区根目录内（拒绝 `..` 穿越与越界绝对路径，当前笔记除外）；循环期间改动只暂存内存「工作副本」，应用前对磁盘/编辑器实际内容二次校验 `old_text`；文件系统级操作（新建/重命名/删除）无论设置如何都需用户逐条确认；删除唯一出口是 Rust `trash_file` 命令（系统回收站），全代码库无不可恢复删除调用

### 云同步信任边界（v4.12）

- **默认关闭**：不开启即零网络请求、零行为变化；开启后也只访问你配置的单桶单前缀，无任何遥测
- **你的桶、你的密钥**：连接信息与 AccessKey/SecretKey 明文保存在本机 `mditor.json`（与 AI API Key 同惯例），建议使用仅限该桶的最小权限子账号与私有桶；对象存储提供方可以看到同步内容——端到端加密不在 v1 范围
- **渲染层不直连**：所有 S3 请求经 Rust 侧代理（CSP 的 `connect-src` 不变）；键名双向校验（Rust 命令入口 + 前端写盘前）拒绝 `..` 穿越，下载内容只落盘到工作区内目标路径或应用内回收站
- **删除可恢复性不对称**：本地删除进应用内回收站（`<app-data>/sync/trash/`），远端删除不可恢复——建议为同步桶开启版本控制

## 项目结构

```
mditor/
├── src/                    # React 前端
│   ├── components/         # Editor / FileTree / AiPanel / SettingsModal 等
│   ├── hooks/              # useMilkdown（编辑器核心）/ useFile / useSwitchFlow 等
│   ├── lib/                # exporter / renderMarkdown / store / 解析缓存与后台解析管线
│   └── workers/            # parseWorker（大文档后台 remark 解析）
├── src-tauri/              # Rust 后端（菜单、AI HTTP 代理、图片下载）
└── docs/                   # 设计与实施文档
```

进阶文档：[大文档性能三阶段架构](docs/performance.md) ·
[安全说明（CSP / 文件权限 / AI 密钥存储）](docs/security.md)

## 支持本项目

Mditor 是完全开源、免费、无广告、无遥测的软件。如果它帮到了你，欢迎请我喝杯咖啡，每一份支持都会直接转化为更好的更新。

- **爱发电**（中国大陆，推荐）：https://afdian.com/a/zhangabc
- **GitHub Sponsors**：https://github.com/sponsors/Zhangjiaru20190316
- **微信 / 支付宝赞赏码**：

  ![赞赏码](../site/assets/receipt-qr.jpg)

## License

MIT
