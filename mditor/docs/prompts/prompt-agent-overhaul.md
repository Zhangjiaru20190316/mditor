# AI Agent 化改造提示词（工具调用 · 笔记整理/撰写/修改/检索/问答）

> **使用方式**：将本提示词完整粘贴给 AI 编码代理作为任务指令，一次性执行全部改造。目标项目 `mditor/`（Tauri 2 桌面应用）。执行前先读「二、项目背景与现状」，所有行号基于 v4.8.0。

---

## 一、角色定义

你是一名资深全栈工程师（React/TypeScript + Rust + LLM 应用方向），受命将本项目现有「纯对话 AI 面板」改造为**具备工具调用能力的 Agent 系统**，让 AI 真正参与笔记的整理、撰写、修改、检索与问答。你以最小侵入为原则：现有对话链路的行为、设置兼容性、取消机制一律不得破坏。

## 二、项目背景与现状（先读再动手）

### 2.1 技术栈

- **前端**：React 18 + TypeScript + Milkdown（Crepe）+ Vite 5；状态以组件 state + `lib/store.ts`（Settings 持久化到 `mditor.json`）为主。
- **后端**：Tauri 2，Rust 源码 `src-tauri/src/`（`ai.rs`、`commands.rs`、`lib.rs`），插件 fs / dialog 等。
- **基建**：`npm run build`（tsc --noEmit + vite build）、`npm run test`（Vitest）、`npm run lint`；Rust 侧 `cargo check` / `cargo clippy` / `cargo test`。注释用中文，模块头注释说明设计意图。

### 2.2 现有 AI 链路（已探明，动手前请通读这些文件）

| 事实 | 位置 |
|---|---|
| `ChatMessage { role, content }`，无 tool_calls 字段 | `src-tauri/src/ai.rs` L111-115 |
| `build_request_body` 手动构造请求体（serde_json::json!），**无 tools 参数** | `src-tauri/src/ai.rs` L590-625 |
| SSE 解析只认 content delta / reasoning delta / finish_reason，**无 tool_calls 增量聚合** | `src-tauri/src/ai.rs` L406-551 |
| 事件：`ai_stream_chunk` / `ai_stream_reasoning` / `ai_stream_done` / `ai_stream_error`，均带 `request_id` | `src-tauri/src/ai.rs` L338-349 |
| 取消机制：`ai_chat_cancel` + `CancelRegistry`（HashSet + Drop 守卫） | `src-tauri/src/ai.rs` L26-95 |
| `ai_chat` 单次请求（120s 超时）、`ai_embed` 嵌入 | `src-tauri/src/ai.rs` L94-336 |
| thinking 参数注入（reasoning_effort / thinking.budget_tokens） | `src-tauri/src/ai.rs` L635-657 |
| invoke_handler 命令注册 | `src-tauri/src/lib.rs` L148-169 |
| 前端流式封装 `chatStream`（回调式，监听上述 4 事件） | `src/lib/ai.ts` L550-620 |
| system prompt 构造（笔记注入 `<note>`）、截断策略 full/standard/large/smart | `src/lib/ai.ts` L123-185, L315-369 |
| 活动模型解析（`Settings.aiModels` + `aiActiveModelId`） | `src/lib/ai.ts` L232-258 |
| AI 面板（消息渲染、追问线程、RAG、选区模式、快捷指令） | `src/components/AiPanel.tsx`（约 950 行） |
| **现有 diff 审阅 UI**：`diffText` + 逐 hunk accept/reject + `applyHunks` 写回编辑器 | `src/components/AiPanel.tsx` L777-840 |
| **编辑器命令句柄 `EditorHandle`**：getValue/setValue/insertAtCursor/replaceContent/replaceSelection/insertAfterSelection/insertAtPos | `src/components/Editor.tsx` L65-191（实现 L813-878） |
| Milkdown 底层写入实现（insertValue/updateValue/insertAfter/getSelectionRange/insertAtPos） | `src/hooks/useMilkdown.ts` L1301-1430 |
| 关键词全文检索 `searchWorkspaces`（防失控上限：500 文件/2000 命中） | `src/lib/workspaceSearch.ts` |
| 向量索引 `RagIndexManager`（`ragIndex` 单例，`EmbedFn` 注入） | `src/lib/ragIndex.ts` L29, L78, L356 |
| Settings 读写 / 最近文件 / 工作区列表 | `src/lib/store.ts` L23-164 |
| 文件树懒加载（readDirLevel） | `src/components/FileTree.tsx` L207-219 |
| 类型定义：`AiModelConfig`、`AiProvider`、`QuickAction`（总结/润色/纠错/扩写/翻译等 preset） | `src/types.ts` L23-136, L415-447 |

### 2.3 硬约束

1. **CSP 锁定 `connect-src 'self' ipc:`**：所有 LLM 请求必须走 Rust `invoke`，前端不得直接 fetch。
2. **API key 只在前端传递**，Rust 侧不持久化（现状保持）。
3. **提供商均为 OpenAI 兼容协议**（DeepSeek/GLM/Moonshot/OpenRouter/Ollama）。Ollama 本地模型可能不支持 tools——必须有不带 tools 的降级路径。
4. **项目红线：`trash` > `rm`**。删除文件必须进系统回收站，禁止直接删除。
5. 现有普通对话模式的行为**完全不变**。

## 三、目标与已确认的产品决策

**痛点**：当前 AI 只限于对话，无法实际操作笔记。
**目标**：改造为 Agent 架构，AI 能检索、读取、编辑、新建、重命名、删除笔记，支持批量整理。

已确认的四项决策（不得偏离）：

1. **独立模式切换**：AI 面板顶部加「对话 / Agent」分段开关。普通对话保持现状，Agent 模式走新链路。默认「对话」，选择持久化到 Settings。
2. **写入策略可配置**：设置新增 `agentWriteMode: "confirm" | "auto"`，默认 `"confirm"`（diff 预览逐条确认）。`"auto"` 仅对**当前笔记的内容编辑**直接应用（依赖编辑器 undo 兜底）；文件系统级操作（create/rename/move/delete）**无论如何都要确认**。
3. **全功能工具集**：读当前笔记/指定文件/文件列表、关键词+向量双路检索、精确编辑、追加内容、新建、重命名/移动、删除（进回收站）、大纲读取。
4. **批量整理一期就支持**：Agent 循环可多轮读取多个文件，产出统一「改动清单」（跨文件多条操作），一次性预览、逐条/全部 accept/reject 后应用。

## 四、总纪律

1. **先读后改**：动手前通读 `src-tauri/src/ai.rs`、`src/components/AiPanel.tsx`、`src/lib/ai.ts`、`src/types.ts`、`src/components/Editor.tsx`（L65-191）、`src/lib/store.ts`、`src/lib/workspaceSearch.ts`、`src/lib/ragIndex.ts`。
2. **每阶段结束应用可编译运行**，按 阶段 1 → 5 顺序推进。
3. **向后兼容**：`ChatMessage` 序列化格式对旧消息（无 tool 字段）必须逐字节不变（用 `skip_serializing_if`）；`ai_chat`（测试连接用）继续工作。
4. **小步提交**：每阶段至少一个 conventional commit。
5. **不过度设计**：复用下文「复用点」中列出的现有函数，禁止重复造轮子。

## 五、架构设计

### 5.1 数据流（前端驱动 Agent Loop）

```
用户输入（Agent 模式）
  → AiPanel 构造 agent system prompt（当前文件路径+大纲+工作区根列表）
  → lib/agent/loop.ts: runAgent()
      循环（上限 MAX_ITERATIONS=12）:
        → lib/ai.ts: agentChatStream(messages, tools)   ← 新函数，复用现有流式封装
            → invoke("ai_chat_stream", { ..., tools })   ← Rust 透传 tools 字段
            ← SSE 事件流：chunk / reasoning / tool_calls(新) / done / error
        ← 若 finish_reason == "tool_calls":
             每个工具调用 → lib/agent/tools.ts 执行器
               读类工具：直接执行返回结果
               写类工具：写入「待应用改动清单 ChangePlan」（暂存，不落盘）
             结果以 { role:"tool", tool_call_id, content } 追加进 messages → 继续循环
        ← 若纯文本回答:
             循环结束 → 汇报答案 + ChangePlan
  → ChangePlan 非空:
       confirm 模式 → 审阅 UI（逐条 diff，accept/reject）→ 应用
       auto 模式   → 仅当前笔记的 edit 直接应用；其余（其他文件/FS 操作）仍弹审阅
```

**决策依据**：工具执行器需要访问编辑器状态（EditorHandle）、工作区、设置——全部在前端；Rust 保持「哑管道」角色（HTTP 透传 + SSE 解析），不引入工具执行逻辑到 Rust。

### 5.2 前端新模块 `src/lib/agent/`

```
src/lib/agent/
├── types.ts      # AgentMessage、ToolDefinition、ToolCallRecord、ChangeOperation、ChangePlan
├── tools.ts      # 工具注册表：OpenAI function schema + 执行器（含安全边界）
├── loop.ts       # runAgent() 主循环、迭代上限、降级、取消
└── prompt.ts     # Agent system prompt 构造
```

`src/lib/ai.ts` 新增 `agentChatStream()`（不动现有 `chatStream` 签名，复用其内部事件监听/模型解析/取消逻辑）。

### 5.3 工具规格表（10 个）

所有工具返回值一律 JSON 字符串化后放入 `{ role: "tool", tool_call_id, content }` 的 `content`。工具结果超过约 24,000 字符时截断并置 `truncated: true`。

| 工具名 | 参数（JSON Schema） | 行为 | 实现复用点 |
|---|---|---|---|
| `read_note` | `{ path?: string }`（缺省 = 当前笔记） | 读取笔记全文（截断保护） | 当前笔记：`EditorHandle.getValue()`；其他：`@tauri-apps/plugin-fs` readTextFile（参照 `workspaceSearch.ts` 的用法） |
| `get_outline` | `{ path?: string }` | 返回标题结构 `[{level, text, line}]`，不读全文（省 token） | 正则解析 `^#{1,6}\s` 行；纯函数可单测 |
| `list_notes` | `{ dir?: string, query?: string }` | 列工作区 Markdown 文件（相对路径/大小/mtime），上限 300 条 | **复用/导出** `workspaceSearch.ts` 内部的 md 文件收集逻辑 |
| `search_notes` | `{ query: string, case_sensitive?: boolean }` | 关键词全文检索，返回命中文件/行/文本 | `searchWorkspaces()`（`src/lib/workspaceSearch.ts`） |
| `semantic_search` | `{ query: string, top_k?: number }` | 向量检索 top-k | `ragIndex`（`src/lib/ragIndex.ts`）；**未配置嵌入或未建索引时返回错误字符串**，提示模型改用 `search_notes` |
| `edit_note` | `{ path?: string, old_text: string, new_text: string, replace_all?: boolean }` | **暂存**精确替换：`old_text` 必须在工作副本中恰好匹配一次（`replace_all` 除外），否则返回错误让模型重读重试 | 工作副本机制见 5.4；应用阶段走 `EditorHandle.setValue`（当前笔记）或 read-modify-write（其他文件） |
| `append_to_note` | `{ path?: string, text: string }` | **暂存**追加内容到笔记末尾（撰写场景） | 同上 |
| `create_note` | `{ path: string, content: string }` | **暂存**新建笔记（强制确认） | `tauriFs` / plugin-fs 写文件 |
| `rename_note` | `{ old_path: string, new_path: string }` | **暂存**重命名/移动（强制确认） | plugin-fs rename（参照 FileTree 现有写操作惯例） |
| `delete_note` | `{ path: string }` | **暂存**删除 → **系统回收站**（强制确认，红线） | 新 Rust command `trash_file`（见阶段 4） |

**路径校验**：所有写类工具的路径必须解析后落在当前工作区根目录内（用 `lib/path-shim.ts` 的 join/resolve 判断前缀），拒绝越界——这是桌面应用安全边界。

### 5.4 工作副本与 ChangePlan（批量整理的核心）

```ts
type ChangeOperation =
  | { kind: "edit";   opId: string; path: string; title: string; oldText: string; newText: string }
  | { kind: "append"; opId: string; path: string; title: string; text: string }
  | { kind: "create"; opId: string; path: string; title: string; content: string }
  | { kind: "rename"; opId: string; fromPath: string; toPath: string; title: string }
  | { kind: "delete"; opId: string; path: string; title: string };

interface ChangePlan {
  ops: ChangeOperation[];
  /** 每个文件的工作副本：edit/append 连续生效，old_text 匹配针对最新副本 */
  workingCopies: Map<string, string>;   // path → 最新内容
}
```

- Agent 循环期间，`edit_note`/`append_to_note` 只改内存工作副本 + 追加 op，**不落盘**。同一文件多条 op 依序链式生效（第二条的 `old_text` 匹配第一条改后的内容）。
- 循环结束统一呈现 ChangePlan。**应用时**再次对磁盘/编辑器实际内容做 old_text 校验，冲突的 op 标记失败并展示原因（文件在循环期间被外部修改等）。
- ops 数量上限 100，超出则工具返回错误让模型收敛。
- 当前笔记的 edit/append 应用后必须触发 `markDirty()`（走现有自动保存链路）。

### 5.5 Settings 扩展（`src/types.ts` + `src/lib/store.ts`）

```ts
interface Settings {
  // ...现有字段不动
  /** AI 面板当前模式：普通对话 / Agent */
  aiPanelMode: "chat" | "agent";        // 默认 "chat"（迁移：缺失时补默认值）
  /** Agent 写入策略（见决策 2） */
  agentWriteMode: "confirm" | "auto";   // 默认 "confirm"
}
```

`loadSettings` 的迁移逻辑里补默认值（参照现有 `aiModels` 迁移的写法）。设置 UI 在「AI」区新增「Agent」小节：模式说明 + 写入策略单选。

## 六、阶段 1：Rust 端 tool calling 支持

### 6.1 `ChatMessage` 扩展（`ai.rs` L111-115）

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant" | "tool"
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<serde_json::Value>, // assistant 消息的工具调用数组
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,          // tool 消息的回执 id
}
```

`#[serde(default)]` 保证旧调用（只传 role/content）反序列化不受影响；`skip_serializing_if` 保证旧消息序列化结果逐字节不变。assistant 消息带 tool_calls 时 `content` 允许空字符串（OpenAI 兼容端接受）。

### 6.2 `ai_chat_stream` / `ai_chat` 新增 `tools` 参数

- 签名加 `tools: Option<serde_json::Value>`，透传给 `build_request_body`（L590-625）：`if let Some(t) = tools { body["tools"] = t; }`。`None` 时不发送该字段（现有调用方零影响）。
- `ai_chat`（单次，L94-238）的响应解析 `CompletionMessage` 增加 `tool_calls: Option<serde_json::Value>`，`ChatResult` 增加 `pub tool_calls: Option<serde_json::Value>`（对称支持，主要服务可测性）。

### 6.3 SSE 流式 tool_calls 增量聚合（核心难点）

OpenAI 流式协议中 tool_calls 的 `function.arguments` 是**分片拼接**的，形如：

```
delta: {"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search_notes","arguments":""}}]}
delta: {"tool_calls":[{"index":0,"function":{"arguments":"{\"qu"}}]}
delta: {"tool_calls":[{"index":0,"function":{"arguments":"ery\":\"foo\"}"}}]}
choices[0].finish_reason == "tool_calls"
```

聚合算法（在现有流循环 L406-551 中扩展）：

```rust
#[derive(Default)]
struct AggToolCall {
    id: Option<String>,
    name: Option<String>,
    arguments: String, // 分片 concat
}
// key = delta.tool_calls[i].index（缺失时用数组下标兜底）
// id / name：取首个非空值；arguments：字符串拼接
// finish_reason == "tool_calls" 时：按 index 排序，组装成 OpenAI 完整格式并发射新事件
```

### 6.4 新事件 `ai_stream_tool_calls`

```json
{ "id": "<request_id>", "tool_calls": [
  { "id": "call_1", "type": "function",
    "function": { "name": "search_notes", "arguments": "{...完整 JSON 字符串...}" } }
] }
```

- 仅在 `finish_reason == "tool_calls"` 时发射**一次**，随后照常发射 `ai_stream_done`。
- 现有 4 个事件的 payload 结构不变；`ai_stream_done` 保持 `{ id }`。
- 发射前尝试 `serde_json::from_str` 校验每个 arguments 是否为合法 JSON；非法则原样透传（宽容处理，由前端/模型层兜底）。
- 取消检查（`stream_cancelled`）在每个含 tool_calls 的 delta 处同样生效。

### 6.5 单元测试（`cargo test`）

1. 聚合：多个分片、多个 index 交错、id/name 缺失、arguments 分片拼接。
2. `ChatMessage` 序列化：无 tool 字段时输出与旧格式逐字节一致；有字段时形状正确。
3. `build_request_body`：`tools: None` 不出现 `tools` 键；`Some` 时透传。
4. finish_reason == "stop" 时不发射 tool_calls 事件。

## 七、阶段 2：前端 Agent 核心（`src/lib/agent/`）

### 7.1 `lib/ai.ts` 新增 `agentChatStream()`

- 不修改现有 `chatStream` 的签名与行为；新增导出 `agentChatStream(params): Promise<AgentStreamResult>`，其中 `params` 含 `messages: AgentMessage[]`、`tools: ToolDefinition[]` 及现有采样参数（复用 `getActiveModel`、token 预算、`ai_chat_cancel` 停止按钮链路）。
- 监听 5 个事件（多一个 `ai_stream_tool_calls`），返回 `{ content, reasoning, toolCalls }`。
- `AgentMessage = ChatMessage` 的前端镜像（含可选 `tool_calls` / `tool_call_id` 字段），与 Rust 结构一一对应。

### 7.2 `loop.ts`：`runAgent()`

```ts
interface AgentContext {
  editorHandle: EditorHandle;      // 读写当前笔记
  workspaces: string[];            // 工作区根列表（store.getWorkspaces）
  signal: AbortSignal;             // 复用现有停止按钮 → ai_chat_cancel
  onEvent: (e: AgentEvent) => void; // 工具执行状态 → UI 渲染步骤卡片
}
```

- 迭代上限 `MAX_ITERATIONS = 12`；到顶后强制注入一条 user 消息「请基于已获得的信息直接给出最终答案」，再跑最后一轮（不带 tools）。
- **降级路径**：请求返回 4xx 且错误信息含 tools 不支持特征（如 "tool" / "function" 字样，或 Ollama 常见报错），自动降级为不带 tools 的单轮对话，并在 UI 提示「当前模型不支持工具调用，已降级为普通对话」。
- 每轮工具结果追加进 messages；模型给出的 `arguments` 先 `JSON.parse`，失败则把原始文本与解析错误作为 tool 消息回传（让模型自我纠正）。
- 工具执行异常一律捕获为 `{ ok: false, error }` 的 tool 消息，不得让循环崩溃。

### 7.3 `prompt.ts`：Agent system prompt（中文）

内容要点（构造为 `buildAgentSystemPrompt(ctx)`）：
- 身份：本地 Markdown 笔记库的整理助手。
- **上下文注入**：当前文件路径 + 大纲（`get_outline` 逻辑复用）+ 大小；全文仅当 < 8,000 字符时注入；工作区根列表。
- **工具使用规则**：需要事实就检索/读取，禁止凭记忆编造笔记内容；修改用 `edit_note` 且 `old_text` 必须与文件原文完全一致；编辑是**暂存**语义（循环结束后统一审阅应用）。
- **批量整理套路**：先 `list_notes`/`search_notes` 圈定范围 → 逐个 `read_note` → 逐个 `edit_note` → 最终答案汇总每条改动。
- 输出规范：中文、简洁；结束时列出所有已暂存的改动摘要。

### 7.4 Vitest 单测（`src/lib/agent/*.test.ts`）

- `tools.ts`：edit_note 的 old_text 唯一匹配/多重匹配报错/replace_all；路径越界校验；工作副本链式生效。
- `loop.ts`：mock `agentChatStream`（一轮 tool_calls → 一轮纯文本）验证消息序列与 ChangePlan 产出；迭代上限；降级触发。
- `prompt.ts`：大纲注入与全文注入阈值。
- `get_outline` 纯函数：各级标题、代码块内 `#` 不误判（跳过 fence 内行）。

## 八、阶段 3：AiPanel 集成与审阅 UI

### 8.1 模式切换

- AiPanel 顶部分段控件「对话 | Agent」，绑定 Settings.aiPanelMode（默认 chat）；chat 模式下所有现有逻辑（快捷指令、追问、RAG、选区、review）原样运行。
- agent 模式下：输入框发送 → `runAgent()`；快捷指令按钮仍可用（作为首条用户消息进入 agent 链路）；RAG 开关对 agent 模式隐藏（检索已由工具承担）。

### 8.2 工具调用卡片（消息流内渲染）

- 每个工具调用渲染紧凑卡片：图标 + 工具中文名（如「检索笔记」「读取 xxx.md」）+ 参数摘要一行 + 状态（执行中/成功/失败）+ 可展开的结果预览（代码块样式，复用面板现有样式约定）。
- 执行中卡片与流式文本按发生顺序穿插展示。

### 8.3 ChangePlan 审阅（扩展现有 review 流程）

- 现有单笔记 review（`diffText` + 逐 hunk accept/reject + `applyHunks`，AiPanel L777-840）**保留不动**（chat 模式继续用）。
- 新增 `AgentPlanReview` 组件：按文件分组的操作列表；`edit` 类每条可展开 diff（**复用 `diffText`**）；每条带 checkbox（默认勾选）+ 底部「应用所选 / 全部应用 / 放弃」。create/rename/delete 显示目标路径与操作说明（delete 标红 + 「移入回收站」措辞）。
- 应用成功后：刷新文件树与最近列表（找到 FileTree/RecentList 现有 refreshKey 机制并复用）；当前笔记编辑走 `EditorHandle`（触发 markDirty → 自动保存链路）。
- auto 模式：`edit/append` 且 path == 当前笔记 → 循环结束静默应用 + toast「已应用 N 处修改（Ctrl+Z 撤销）」；其余操作仍进审阅。

## 九、阶段 4：文件系统操作与回收站

1. `src-tauri/Cargo.toml` 添加 `trash` crate（跨平台移入回收站；先检查是否已有等价依赖）。若不希望加依赖，备选：Windows 用 PowerShell `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(..., RecycleOption)`——**二选一，推荐 `trash` crate**。
2. `commands.rs` 新增 command：

```rust
#[command]
pub fn trash_file(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| format!("移入回收站失败：{e}"))
}
```

注册进 `lib.rs` 的 invoke_handler。
3. 前端 `rename_note`/`create_note` 的应用逻辑用 `@tauri-apps/plugin-fs` 现有能力；删除一律走 `trash_file`。**全代码库禁止出现不可恢复的删除调用**。
4. 应用 rename/delete 后文件树刷新；若删除/重命名的是当前打开笔记，给出明确提示（不静默关闭）。

## 十、阶段 5：验证与收尾

### 10.1 自动化验证（每阶段跑，收尾全跑）

- `npm run build`、`npm run test`、`npm run lint`
- `src-tauri/`：`cargo check` + `cargo clippy` + `cargo test`

### 10.2 手动端到端清单

1. **回归**：chat 模式行为与改造前一致（流式、停止、快捷指令、追问、选区、单笔记 review、测试连接）。
2. **检索问答**：Agent 模式问「我哪几篇笔记讲过 X」→ 观察工具卡片（search_notes → read_note）→ 引用文件与行号正确。
3. **单笔记修改（confirm）**：「把当前笔记的二级标题统一改成大写」→ edit_note 暂存 → 审阅 UI 逐条 diff → 应用 → Ctrl+Z 可撤销。
4. **单笔记修改（auto）**：设置切 auto → 同类指令直接应用 + toast；FS 操作仍弹审阅。
5. **撰写**：「在当前笔记末尾追加一节总结」→ append_to_note → 应用。
6. **批量整理**：「把 XX 文件夹下笔记统一加 frontmatter 并规范标题」→ 多轮 read+edit → 统一清单 → 部分勾选应用 → 文件树刷新、内容正确。
7. **新建/重命名/删除**：各自走审阅；删除后到系统回收站确认可恢复。
8. **降级**：配一个不支持 tools 的本地 Ollama 模型 → agent 请求自动降级普通对话并提示。
9. **取消**：多轮工具执行中途点「停止」→ 循环终止、无残留请求（复用 ai_chat_cancel）。
10. **安全**：诱导模型 edit_note 越界路径（如 `../outside.md`、绝对路径）→ 被拒绝。

### 10.3 收尾

- 更新 `CHANGELOG.md`（新版本号递增 minor）与 `mditor/README.md` 的功能特性/安全模型小节（Agent 工具能力 + 写入安全边界）。
- 输出《改造报告》：每个阶段的关键改动文件清单、测试结果、已知限制（如：向量检索依赖嵌入配置、Ollama 降级语义）。

## 附录：OpenAI tool calling 线格式速查（实现参照）

请求体（ai_chat_stream 透传的 `tools`）：

```json
{
  "model": "deepseek-chat",
  "stream": true,
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "",
      "tool_calls": [{ "id": "call_1", "type": "function",
        "function": { "name": "search_notes", "arguments": "{\"query\":\"xx\"}" } }] },
    { "role": "tool", "tool_call_id": "call_1", "content": "{...结果 JSON...}" }
  ],
  "tools": [
    { "type": "function", "function": {
        "name": "search_notes", "description": "关键词全文检索工作区笔记",
        "parameters": { "type": "object", "properties": { "query": { "type": "string" } },
                        "required": ["query"] } } }
  ]
}
```

流式响应（Rust 聚合目标）：

```
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search_notes","arguments":""}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"qu"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"read_note","arguments":"{\"path\":\"a.md\"}"}}]}}]}
data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}
```

聚合规则：按 `index` 分组；`id`/`name` 取首个非空；`arguments` 字符串拼接；`finish_reason == "tool_calls"` 时按 index 排序输出完整数组。
