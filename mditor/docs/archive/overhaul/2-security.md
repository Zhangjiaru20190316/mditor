# 项目全面治理 · 阶段 2：安全审计报告

> 日期：2026-08-28 ｜ 审计人：ZCode ｜ 修复提交：`dfb0d89`（魔数门）、`3880ead`（.. 穿越）
> 等级定义：P0 严重 / P1 高 / P2 中 / P3 低。P0/P1 直接修复；P2/P3 待决策（本次已顺带修复两项低风险 P2/P3）。
> 总体结论：**无 P0/P1**。应用经过 v3.9.1 一轮加固，CSP/sanitize/日志收敛等防线完整有效；本轮发现 1 项 P2（供应链 DoS，已修）与若干 P3（1 项已修，其余为记录性/上游项）。

## 1. 前端 / WebView 侧

| # | 项 | 结论 | 证据 |
| --- | --- | --- | --- |
| F1 | rehype 管线顺序 | ✅ 安全 | `renderMarkdown.ts:127-136`：`rehypeRaw → rehypeSanitize → rehypePruneStyle → rehypeKatex → rehypeHighlight`——raw 先解析再消毒；KaTeX/highlight 输出在消毒之后生成，不被剥离也不绕过消毒 |
| F2 | sanitize 白名单 | ✅ 安全 | 基于 GitHub 风格 defaultSchema + `mark`/span 的 className/style；**实测** `protocols: {src: ["http","https"], href: ["http","https","irc","ircs","mailto","xmpp"]}`——`javascript:`/`file:`/`data:` 不可达；v3.9.1 的 style 裁剪（仅 color/background-color）仍在位 |
| F3 | dangerouslySetInnerHTML / innerHTML | ✅ 安全 | 全仓无 dangerouslySetInnerHTML；innerHTML 写入仅 2 处——`MarkdownText`（输入必经 F1 管线 + hardenLinks `rel=noopener`）与 `exportMath`（KaTeX renderToString 输出，trust 默认关）；失败兜底走 textContent |
| F4 | KaTeX | ✅ 安全 | 全仓未开启 `trust`（默认 false——`\href`/`\includegraphics` 等潜在命令不渲染为可交互元素）；mhchem/宏均为本地注册，无外联 |
| F5 | 外链打开（shell:allow-open） | ✅ 安全 | 唯一用户内容入口 `Editor.tsx:771` `openExternal` 有 scheme 白名单 `/^(https?:\|mailto:)/i`——`file://`/`smb://`/自定义协议全部拒绝，`file:///…exe` 经系统默认程序执行的路径不存在；`devMode.openLogsDir` 打开的是应用自算路径；crepe 内无 window.open；WebView 新窗口请求由 wry 默认拒绝 |
| F6 | 粘贴 | ✅ 安全 | 富文本粘贴经 PM schema 解析（节点白名单），源码模式为纯文本；AI 回复/批注预览走 F1 管线 |
| F7 | 编辑器路径（getHTML → 导出） | ⚠️ 见 S1 | 编辑器图片节点可携带任意 `file://` src 并进入 DOCX 内联路径——已被本轮魔数门（`dfb0d89`）掐断 |

## 2. 供应链

| # | 项 | 等级 | 结论与处置 |
| --- | --- | --- | --- |
| S1 | **image-size 解析死循环**（经 @turbodocx/html-to-docx，运行时依赖） | **P2 → 已修** | GHSA-w3rx-r6r6-pgpr（ICNS）/ GHSA-5p2g-fcmc-qvqq（JXL/HEIF），npm audit high，全部已发布版本受影响。利用路径：恶意 `.md` 引用本地构造的 ICNS/JXL/HEIF 文件（或伪造扩展名字节）→ 用户导出 DOCX → `inlineLocalImages` 内联 → html-to-docx 内 image-size 死循环 → 应用挂起（DoS，无 RCE/数据外泄）。**修复**（`dfb0d89`）：内联入口魔数白名单（PNG/JPEG/GIF/WebP/BMP/ICO/SVG），未知格式保留原引用静默丢弃；附 9 例回归测试。**不采用** `npm audit fix`（其方案是把 image-size 换成 probe-image-size——未获维护者认可的依赖换包，供应链风险大于 DoS 收益，已回退并留档） |
| S2 | esbuild ≤0.24.2 dev-server 跨域读取（GHSA-67mh-4wv8-2f99） | P3 记录 | 仅影响开发态（vite dev server，默认绑定 127.0.0.1，vite.config 未开 host），不影响分发产物；修复需 vite@8（breaking），等上游升级窗口 |
| S3 | cargo audit | ✅ 0 漏洞 | 519 crate 依赖，0 vulnerability；18 条 warning 全为 unmaintained/unsound/yanked 类传递依赖（gtk-rs GTK3 链、glib、proc-macro-error、chacha20 yanked 等），均为 Tauri 上游依赖树，应用层不可处置，随 Tauri 升级自然消解 |
| S4 | patches/ 四补丁 | ✅ 无安全面变更 | 均为性能补丁且经 CHANGELOG 归档：crepe 行内公式 Schema 缓存/视图销毁、plugin-listener 停键序列化挪 idle、components code-block teardown 重排、prosemirror-virtual-cursor rAF 合并——逐文件复读，无权限/IO/网络行为变更 |

## 3. Tauri 能力面

| # | 项 | 结论 |
| --- | --- | --- |
| T1 | CSP | ✅ `script-src 'self'`（无 unsafe-inline/eval）、`connect-src 'self' ipc:`（外联 fetch 全禁——AI/图片下载均走 Rust 命令）、`dangerousDisableAssetCspModification` 的取舍已有 docs/security.md 完整论证并显式放行 asset: |
| T2 | capabilities | ✅ 逐条审过：窗口操作 8 项（无 setUrl/show 创建等敏感项）；dialog 5 项只读型；store/process 默认集；shell 仅 allow-open（F5 白名单管住）；fs 13 项全部 `**`——**全盘读写删除是本地优先编辑器的刚需**（docs/security.md 已声明取舍），攻击面收敛依赖 CSP+sanitize，WebView 被攻破即等同用户权限运行，属平台边界 |
| T3 | 命令逐个审计（6 个 #[tauri::command]） | `append_log`：日志目录收敛 + 本轮补 `..` 防御（`3880ead`）✅；`app_data_dir`/`get_pending_file`：无输入面 ✅；`fetch_image`：http(s) only + 20MB 上限，URL 来自用户显式「持久化图片」操作（非自动触发）✅；`ai_chat`/`ai_chat_stream`：见下节 ✅。**无命令注入面**（无 shell 拼接）、无 TOCTOU 敏感窗口（写盘均为一次性完整写） |
| T4 | devtools / release 差异 | ✅ Cargo.toml 未启 devtools feature，tauri.conf 无 devtools 项——release 默认关闭；`withGlobalTauri` 未开 |
| T5 | assetProtocol scope `**` | 记录（同 T2 取舍）：本地图片经 asset: 读取需要全盘；CSP img-src 显式列出 asset: |

## 4. Rust 侧

| # | 项 | 结论 |
| --- | --- | --- |
| R1 | ai.rs 密钥 | ✅ API key 由前端设置逐调用传入、Rust 不持久化、无日志输出点；仅作为 bearer header 发往用户配置的 endpoint |
| R2 | SSRF 面 | ✅ 记录性：`base_url`/图片 URL 均为用户自配置/文档内容 + 显式操作触发，无「不可信输入直接驱动 URL」的自动路径；本地网关（169.254.169.254 等）可达性受「用户主动配置」约束，属 BYO-endpoint 设计边界（docs/security.md 同款结论） |
| R3 | unwrap/expect/panic | ✅ 全量仅 3 处：lib.rs:224 启动锁 unwrap（毒锁仅在先前 panic 后发生）、lib.rs:238 Tauri run 惯例 expect、ai.rs:390 reqwest 构建失败 expect（注释论证过）；无用户输入路径上的 panic |
| R4 | 错误信息泄漏 | ✅ `friendly_error` 截断上游响应体至 300 字符；P3 记录：`ai_chat` 解析失败分支回显完整 `原始响应：{text}` 无截断（仅用户自己配置的 endpoint 可见，影响极低，阶段 3 顺手修） |

## 5. 数据与隐私

| # | 项 | 结论 |
| --- | --- | --- |
| D1 | 设置/密钥存储 | 记录（既有取舍）：`%APPDATA%/com.mditor.app/mditor.json` 含明文 API key——docs/security.md 已论证（应用自管加密无法防御同权限攻击者，OS 级是实际边界）并给出更强隔离的使用建议。维持现状 |
| D2 | 日志脱敏 | ✅ **实测**：dev + 生产全部 9 个日志文件（含 2MB 轮转档）扫描无密钥/Bearer/apiKey 字样；日志内容为事件/计数/异常栈 |
| D3 | 数据位置 | ✅ 设置/日志均在用户 Profile 下（Windows per-user ACL）；文档数据只存在于用户自己的目录，应用不复制 |

## 6. 处置状态汇总

- **已修复（本轮）**：S1 图片魔数门（`dfb0d89`，P2）；T3 append_log `..` 穿越防御（`3880ead`，P3）。
- **维持现状（记录在案）**：T2/T5 fs 全盘 scope、D1 明文密钥（均为已文档化的产品取舍）；S2 esbuild dev-only；S3 上游 unmaintained 传递依赖。
- **待阶段 3 顺手处理**：R4 解析失败分支的响应回显无截断。
- **P0/P1：无。**

## 7. 验证方式

- `npm run test` 376/376（含 imageSniff 9 例新回归网）；`tsc --noEmit` / `vite build` / 改动文件 ESLint 全绿；`cargo test` 4/4（含穿越回归）；`cargo clippy` 无新增警告。
- 回滚：两项修复各自独立 commit，可单独 revert。
