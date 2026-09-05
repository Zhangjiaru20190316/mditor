# AI 面板 Agent 化改造报告（v4.9.0）

> 日期：2026-09-05 · 交付：按《Agent 改造方案》阶段 1→5 全量完成，5 个 conventional commit。

## 总览

AI 面板从「纯对话」改造为可选 Agent 架构：顶部「对话 | Agent」分段开关（默认对话，持久化到 Settings）。Agent 模式下模型经 OpenAI 兼容 tool calling 协议驱动 10 个前端工具，可检索/读取/编辑/新建/重命名/删除笔记并批量整理；所有写操作先暂存为内存「改动清单 ChangePlan」，审阅（逐条勾选）后才应用。普通对话链路行为不变（请求体逐字节一致，有单测锚点）。

数据流：前端驱动 Agent Loop（`runAgent`），Rust 保持「哑管道」（HTTP 透传 + SSE 解析 + 工具调用增量聚合），不引入任何工具执行逻辑到 Rust——工具需要编辑器/工作区/设置状态，全部在前端。

## 阶段 1：Rust 端 tool calling（commit a32f379）

| 改动 | 文件 | 说明 |
|---|---|---|
| ChatMessage 扩展 | `src-tauri/src/ai.rs` | 可选 `tool_calls` / `tool_call_id`，`#[serde(default, skip_serializing_if)]` 双保险 |
| tools 参数透传 | `src-tauri/src/ai.rs` | `ai_chat` / `ai_chat_stream` 新增 `tools: Option<Value>`；`build_request_body` None 时不出现该键 |
| SSE 增量聚合 | `src-tauri/src/ai.rs` | `ToolCallDelta` / `AggToolCall` / `merge_tool_call_deltas` / `finalize_tool_calls`（BTreeMap 按 index 有序；id/name 首非空、arguments 拼接；index 缺失用数组下标兜底） |
| 新事件 | `src-tauri/src/ai.rs` | `ai_stream_tool_calls`（`{id, tool_calls}`）——`finish_reason=="tool_calls"` 发射一次；[DONE]/EOF 时未决分片补发（安全网，兼容漏发 finish_reason 的实现）；先于 `ai_stream_done` |
| 非流式对称支持 | `src-tauri/src/ai.rs` | `ChatResult.tool_calls`（`ai_chat` 响应解析） |

测试：Rust 9 → 15（聚合多分片/多 index 交错/id 缺失/线格式样例回放、序列化逐字节兼容、请求体透传、空聚合）。

## 阶段 2：前端 Agent 核心（commit 5228 前后）

| 模块 | 文件 | 职责 |
|---|---|---|
| 类型 | `src/lib/agent/types.ts` | AgentMessage / ToolCall / ToolDefinition / ChangeOperation / ChangePlan / ToolCallRecord / AgentTimelineItem（MAX_OPS=100） |
| 工具 | `src/lib/agent/tools.ts` | 10 工具 schema + 执行器；路径安全边界（`resolveToolPath`：工作区前缀校验 + `..` 拒绝 + 相对路径挂首根）；工作副本（`effectiveNoteText`：暂存副本 > 编辑器实时 > 磁盘）；`extractOutline` 纯函数（围栏内 # 不误判）；结果 24k 截断 |
| 循环 | `src/lib/agent/loop.ts` | `runAgent`：MAX_ITERATIONS=12、到顶注入收尾指令再跑最后一轮（不带 tools）、`isToolsUnsupportedError` 降级（一次）、arguments JSON.parse 失败回传自纠、工具异常捕获为 `{ok:false}`、AbortSignal 取消 |
| 提示词 | `src/lib/agent/prompt.ts` | `buildAgentSystemPrompt`：当前路径 + 大纲（≤120 条）+ 大小 + 短文（<8k 字符）内联 + 工作区根列表 + 工具规则/批量套路/输出规范 |
| 应用 | `src/lib/agent/apply.ts` | `applyChangePlan`：部分勾选从基线重算（当前笔记走编辑器一步撤销写回；其他文件读盘-改-写一次）；应用时二次校验 old_text，冲突标记失败；create/rename 拒绝覆盖；delete 唯一出口 `trash_file` |
| 流式封装 | `src/lib/ai.ts` | `agentChatStream`：Promise 化整轮结果 `{content, reasoning, toolCalls, cancelled}`；监听 5 事件；cancel 复用 `ai_chat_cancel`；不动现有 `chatStream` |
| 复用导出 | `src/lib/workspaceSearch.ts` | `collectMdFiles` 导出（list_notes 复用同一收集逻辑与黑名单） |

测试：新增 `src/lib/agent/agent.test.ts` 39 用例（路径安全边界 8 / edit 语义与链式 8 / 大纲 3 / prompt 3 / 主循环 7 / 降级判定 2 / apply 重算 3 / 杂项）；全套 578 全过。

## 阶段 3：AiPanel 集成与审阅 UI（commit 075cf…）

| 改动 | 文件 | 说明 |
|---|---|---|
| 模式开关 | `src/components/AiPanel.tsx` | 顶部分段控件绑定 `settings.aiPanelMode`（onSettingsChange 持久化，多窗口天然同步）；agent 分支条件 `agentMode && mode==="full" && !preset && !parent`——选区/追问/一键修复恒走普通对话 |
| 工具卡片 | `src/components/AiPanel.tsx` | `Msg.timeline`（AgentTimelineItem[]）承载「文本段 ↔ 工具卡片」按发生顺序穿插；`flushDelta` 分支写入时间线；回合结束结算纯文本 content（插入/复制/追问动作可用）；ToolCard：状态点动画 + 中文名 + 摘要 + 可展开结果 |
| 改动清单审阅 | `src/components/AgentPlanReview.tsx` | 按文件分组（当前笔记组置顶打标）；edit 懒展开 diff（复用 `diffText` + `.diff-line` 样式）；append/create 内容预览；每条 checkbox（默认全选）+ 全选/全不选/放弃；delete 标红 +「移入回收站（可恢复）」 |
| 应用链路 | `src/components/AiPanel.tsx` | `handleAgentPlan`：auto 模式当前笔记 edit/append 直接应用 + toast（Ctrl+Z 提示），其余进审阅；`reportAgentApply`：FS 变更 → `onTreeChange`（复用 App 的 FileTree TreeChange 处理：关标签/改路径/清最近）+ `mditor:vault-mutated` 全局事件刷新文件树；当前笔记被删/改名明确提示 |
| 停止/清理 | `src/components/AiPanel.tsx` | `agentAbortRef`（AbortController）：停止按钮、清空、面板关闭/卸载全部中止 |
| 接线 | `src/App.tsx` | AiPanel 新 props：`getNotePath` / `workspaces` / `onTreeChange` |
| 文件树刷新 | `src/components/FileTree.tsx` | 监听 `mditor:vault-mutated` → `refreshAll()`（复用 ↻ 按钮逻辑） |
| 设置 | `src/components/SettingsModal.tsx` | AI 区「Agent」小节：模式说明 + `agentWriteMode` 单选 |
| 样式 | `src/styles/global.css` | 模式开关 / 时间线 / 工具卡片 / apr 清单（沿用 CSS 变量主题体系） |
| 锚点 | `src/types.ts` + `src/lib/store.ts` + `src/types.test.ts` | `aiPanelMode`/`agentWriteMode` 字段 + 默认值 + 迁移归一 + 清单锚点更新 |

## 阶段 4：文件系统操作与回收站（commit 613d608）

- 新命令 `trash_file`（`src-tauri/src/commands.rs`，注册于 `lib.rs`）。
- **零依赖实现**（规格书二选一的备选方案；trash crate 因本环境 crates.io 不可达未采用）：
  - Windows：PowerShell `Microsoft.VisualBasic.FileIO.FileSystem::DeleteFile/DeleteDirectory(path, 'OnlyErrorDialogs', 'SendToRecycleBin')`——路径经环境变量 `MDITOR_TRASH_PATH` 传入，零转义面（中文/空格/`&` 均安全）；已冒烟验证（文件进回收站）。
  - macOS：osascript Finder delete；Linux：`gio trash` → `trash-put` 兜底。
- `src/lib/fileOps.ts` 的 `deleteFile` / `deleteDirRecursive` 迁移到 `trash_file`——**全代码库不再有不可恢复删除调用**（含文件树自身的删除，同样变为可恢复，行为向上兼容）。
- Agent 的 rename/create 走 plugin-fs 现有能力（`renamePath` 等），删除一律 `trashFile`。

## 阶段 5：验证与收尾

### 自动化验证（全绿）

| 检查 | 结果 |
|---|---|
| `npm run build`（tsc --noEmit + vite build） | ✓ |
| `npm run test`（Vitest） | ✓ 53 文件 578 用例（含 agent 39） |
| `npm run lint` | 本次改动文件 0 错误（存量 125 条在 perf/ 等无关文件，与基线一致） |
| `cargo check` / `cargo clippy` / `cargo test` | ✓ 15 用例；clippy 较基线仅 +1 条与既有同类 too_many_arguments（build_request_body 8 参） |
| PowerShell 回收站 | ✓ 冒烟：临时文件删除 exit 0、进回收站 |
| 版本号三处同步 | `package.json` / `tauri.conf.json` / `Cargo.toml` → 4.9.0 |
| 文档 | CHANGELOG 4.9.0 条目；README 功能特性 + 安全模型（Agent 写入边界） |

### 手动端到端清单（建议按序过一遍）

1. 回归：chat 模式流式/停止/快捷指令/追问/选区/单笔记 review/测试连接。
2. 检索问答：「我哪几篇笔记讲过 X」→ search_notes → read_note 卡片 → 引用与行号。
3. 单笔记修改（confirm）：edit_note → 清单逐条 diff → 应用 → Ctrl+Z 一步撤销。
4. 单笔记修改（auto）：直接应用 + toast；FS 操作仍弹审阅。
5. 撰写：append_to_note → 应用。
6. 批量整理：多轮 read+edit → 统一清单 → 部分勾选应用 → 文件树刷新。
7. 新建/重命名/删除：各自审阅；删除后到系统回收站确认可恢复。
8. 降级：不支持 tools 的 Ollama 模型 → 自动降级 + 面板提示。
9. 取消：多轮执行中点「停止」→ 循环终止、无残留请求。
10. 安全：诱导 `../outside.md` / 绝对路径越界 → 工具返回「安全边界」错误。

### 已知限制

- 语义检索依赖嵌入配置与已建向量索引；不可用时工具报错并引导模型改用 `search_notes`。
- Ollama 本地模型可能不支持 tools → 自动降级为普通对话（无工具能力），面板提示。
- Agent 消息的追问/批注/插入基于最终纯文本（工具卡片仅展示，不参与这些动作）。
- 选区问答、「一键修复格式」在 Agent 模式下仍走普通对话链路（设计如此：精确任务/选区语境不适合工具循环）。
- Windows 回收站删除经 PowerShell 子进程，单次约数百 ms；批量删除串行执行。
- trash crate 未引入（网络不可达）：`trash_on_current_os` 已按平台分层，后续联网可无痛切换。
- Agent 多轮历史不做 token 预算裁剪（每轮全量回传工具结果；靠 24k 截断 + 12 轮上限收敛）。
