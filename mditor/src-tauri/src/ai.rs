//! AI chat commands — call an OpenAI-compatible Chat Completions endpoint.
//!
//! Kept in Rust (rather than a fetch from the webview) for two reasons:
//!   1. The app's CSP pins `connect-src` to `'self' ipc:` — a direct fetch to
//!      an LLM provider would violate it. Going through `invoke` sidesteps CSP.
//!   2. The API key never has to live in the JS store; the frontend passes it
//!      per-call from settings but it's never persisted on the Rust side.
//!
//! Two flavours:
//!   * `ai_chat` — single-shot, returns the full reply (used by "测试连接").
//!   * `ai_chat_stream` — Server-Sent-Events streaming; emits incremental
//!     `ai_stream_chunk` / `ai_stream_done` / `ai_stream_error` events tagged
//!     with a frontend-supplied `request_id` so the UI can route them.
//!
//! Compatible endpoints include OpenAI, DeepSeek, 智谱 GLM, Moonshot, OpenRouter,
//! and local servers like Ollama (`http://localhost:11434/v1`) or LM Studio.

use std::collections::{BTreeMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Emitter};

// ---- 流式取消（v4.6.2 阶段3：已知问题「流式停止不停止计费」根修） ----------
//
// 前端「停止」原先只摘除自己的事件监听（本地 onDone 即生效），Rust 侧对
// 上游的拉流会一直跑到自然结束——被中止的请求同样消耗计费 token。现在
// 前端停止时调用 `ai_chat_cancel` 登记 request_id，流循环在每个 chunk 到达
// 时检查并提前退出。

/// 取消注册表（纯逻辑，可单测）。
///
/// `finish` 由流自身的 Drop 守卫在一切退出路径调用（含 `?` 早退）；「迟到
/// 的取消」（流已结束才到达）没有对应流来消费条目，靠容量上限整表清空兜
/// 底——上限取一个远超并发流数的值，正常使用永不触达。
#[derive(Debug)]
struct CancelRegistry {
    inner: HashSet<String>,
    cap: usize,
}

impl CancelRegistry {
    fn new(cap: usize) -> Self {
        Self {
            inner: HashSet::new(),
            cap,
        }
    }

    fn cancel(&mut self, id: &str) {
        if self.inner.len() >= self.cap {
            self.inner.clear();
        }
        self.inner.insert(id.to_string());
    }

    fn is_cancelled(&self, id: &str) -> bool {
        self.inner.contains(id)
    }

    fn finish(&mut self, id: &str) {
        self.inner.remove(id);
    }
}

static CANCELS: OnceLock<Mutex<CancelRegistry>> = OnceLock::new();

fn cancels() -> &'static Mutex<CancelRegistry> {
    CANCELS.get_or_init(|| Mutex::new(CancelRegistry::new(1024)))
}

/// 登记一个流式请求为已取消（前端「停止」时调用；fire-and-forget）。
#[command]
pub fn ai_chat_cancel(request_id: String) {
    let mut g = cancels().lock().unwrap_or_else(|e| e.into_inner());
    g.cancel(&request_id);
}

fn stream_cancelled(request_id: &str) -> bool {
    cancels()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_cancelled(request_id)
}

/// 流退出时清掉自己的取消条目（Drop 兜住所有 return/`?`/panic-unwind 路径）。
struct CancelGuard(String);

impl Drop for CancelGuard {
    fn drop(&mut self) {
        cancels()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .finish(&self.0);
    }
}

/// Total-request timeout for the single-shot `ai_chat` call. Applied per
/// request — the shared client itself carries no total timeout (see `http()`).
const REQUEST_TIMEOUT_SECS: u64 = 120;

/// Connect timeout on the shared client (covers the TCP + TLS handshake).
const CONNECT_TIMEOUT_SECS: u64 = 10;

/// Upper bound on the unparsed SSE buffer (leftover partial line with no
/// newline yet). A well-formed SSE frame is tiny; if `buf` grows past this
/// the server is misbehaving (no newlines / absurdly long frame) and
/// continuing would balloon memory → OOM.
const MAX_BUFFER_BYTES: usize = 1024 * 1024; // 1 MiB

/// One chat message, mirroring OpenAI's wire format.
///
/// Agent 链路（v4.9）扩展了两个可选字段：assistant 消息可携带 `tool_calls`
/// （模型发起的工具调用数组），tool 消息以 `tool_call_id` 回执对应调用。
/// 两个都 `#[serde(default, skip_serializing_if)]`——旧调用方只传
/// role/content 时反序列化不受影响，且序列化输出与旧格式逐字节一致
/// （普通对话的请求体零变化，见单测 chat_message_serialization_unchanged_*）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant" | "tool"
    pub content: String,
    /// assistant 消息的工具调用数组（OpenAI 完整格式，流式聚合产物）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<serde_json::Value>,
    /// tool 消息的回执 id（对应某个 tool_calls[i].id）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// Payload returned to the frontend.
#[derive(Debug, Serialize)]
pub struct ChatResult {
    pub content: String,
    /// 非流式响应里的工具调用数组（Agent 链路对称支持；普通对话为 None）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<serde_json::Value>,
}

/// Truncate an upstream error body to at most 300 chars (plus an ellipsis when
/// cut), slicing on char boundaries so multi-byte characters survive. Callers
/// pass `resp.text()` output, which already decodes non-UTF-8 bodies lossily.
fn truncate_error_body(body: &str) -> String {
    const MAX_CHARS: usize = 300;
    if body.chars().count() <= MAX_CHARS {
        return body.to_string();
    }
    let cut = body
        .char_indices()
        .nth(MAX_CHARS)
        .map(|(i, _)| i)
        .unwrap_or(body.len());
    format!("{}…", &body[..cut])
}

/// Error message aimed at being directly showable to a Chinese-speaking user.
fn friendly_error(status: u16, body: &str) -> String {
    // Cap the body before echoing it back: gateway error pages can be huge
    // HTML blobs and may leak internal details.
    let body = truncate_error_body(body);
    match status {
        401 | 403 => format!("鉴权失败（HTTP {status}）：API Key 无效或无权访问该模型。"),
        404 => format!("接口未找到（HTTP 404）：请检查 Base URL 是否正确（应类似 https://api.openai.com/v1）。响应：{body}"),
        429 => "请求过于频繁或额度不足（HTTP 429），请稍后重试。".to_string(),
        s if s >= 500 => format!("服务端错误（HTTP {s}），请稍后重试。响应：{body}"),
        _ => format!("请求失败（HTTP {status}）：{body}"),
    }
}

/// Call an OpenAI-compatible chat completions endpoint and return the text.
///
/// `base_url` should already end with `/v1` (or equivalent). We append
/// `/chat/completions`. Empty `api_key` is allowed (for local servers).
#[command]
#[allow(clippy::too_many_arguments)] // 命令签名 = wire 格式，参数数量是接口的一部分
pub async fn ai_chat(
    base_url: String,
    api_key: String,
    model: String,
    provider: Option<String>,
    thinking_strength: Option<String>,
    messages: Vec<ChatMessage>,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    top_p: Option<f32>,
    tools: Option<serde_json::Value>,
) -> Result<ChatResult, String> {
    if base_url.trim().is_empty() {
        return Err("未配置 AI Base URL，请在「设置 → AI」中填写。".into());
    }
    if model.trim().is_empty() {
        return Err("未配置模型名称，请在「设置 → AI」中填写。".into());
    }

    let thinking = thinking_fields(
        provider.as_deref().unwrap_or("custom"),
        thinking_strength.as_deref().unwrap_or("off"),
    );

    let client = http();
    let body = build_request_body(
        &model,
        &messages,
        temperature,
        max_tokens,
        top_p,
        false,
        thinking.as_ref(),
        tools.as_ref(),
    );

    let resp = send_request(
        client,
        &base_url,
        &api_key,
        body,
        // Non-streaming: keep the original 120s total timeout, per request.
        Some(Duration::from_secs(REQUEST_TIMEOUT_SECS)),
    )
    .await?;
    let status = resp.status().as_u16();
    // E8：响应体读取失败映射为传输错误——此前静默成空串，用户只看到
    // 「无法解析 AI 响应」而丢失真实原因（截断读/连接中断）。
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取 AI 响应失败：{e}"))?;
    if status >= 400 {
        return Err(friendly_error(status, &text));
    }

    // Parse the standard OpenAI completion envelope.
    #[derive(Deserialize)]
    struct CompletionResponse {
        choices: Vec<CompletionChoice>,
    }
    #[derive(Deserialize)]
    struct CompletionChoice {
        message: CompletionMessage,
    }
    #[derive(Deserialize)]
    struct CompletionMessage {
        content: Option<String>,
        // Agent 链路：模型直接发起的工具调用（对称支持；普通对话为 None）。
        #[serde(default)]
        tool_calls: Option<serde_json::Value>,
    }

    let parsed: CompletionResponse = serde_json::from_str(&text).map_err(|e| {
        // 响应体截断后回显（与 friendly_error 同款纪律：网关错误页可能是
        // 巨大 HTML，且不该整段透传）。
        format!(
            "无法解析 AI 响应（可能 Base URL 不是 OpenAI 兼容接口）：{e}\n原始响应：{}",
            truncate_error_body(&text)
        )
    })?;

    let first = parsed.choices.into_iter().next();
    let content = first
        .as_ref()
        .and_then(|c| c.message.content.clone())
        .unwrap_or_default();
    let tool_calls = first.and_then(|c| c.message.tool_calls);

    Ok(ChatResult {
        content,
        tool_calls,
    })
}

/// Payload returned by `ai_embed`: one embedding per input text, in the
/// ORIGINAL input order (the /embeddings API returns `index` per item and
/// servers are not required to preserve order).
#[derive(Debug, Serialize)]
pub struct EmbedResult {
    pub vectors: Vec<Vec<f32>>,
}

/// Call an OpenAI-compatible `/embeddings` endpoint (v4.7 模块 5「全库问答」).
///
/// Same CSP rationale as `ai_chat`: the webview's `connect-src` is pinned to
/// `'self' ipc:`, so embedding requests must go through the Rust side. The
/// API key is passed per-call and never persisted here. Batches are small
/// (frontend sends ≤16 texts per call), so a plain total timeout suffices.
#[command]
pub async fn ai_embed(
    base_url: String,
    api_key: String,
    model: String,
    input: Vec<String>,
) -> Result<EmbedResult, String> {
    if base_url.trim().is_empty() {
        return Err("未配置嵌入 Base URL，请在「设置 → 知识功能」中填写。".into());
    }
    if model.trim().is_empty() {
        return Err("未配置嵌入模型名称，请在「设置 → 知识功能」中填写。".into());
    }
    if input.is_empty() {
        return Ok(EmbedResult { vectors: vec![] });
    }

    let client = http();
    let endpoint = if base_url.ends_with('/') {
        format!("{}embeddings", base_url)
    } else {
        format!("{}/embeddings", base_url)
    };
    let body = serde_json::json!({ "model": model, "input": input });
    let mut req = client
        .post(&endpoint)
        .json(&body)
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS));
    if !api_key.trim().is_empty() {
        req = req.bearer_auth(api_key);
    }
    let resp = req.send().await.map_err(|e| {
        let msg = e.to_string();
        if e.is_timeout() {
            "嵌入请求超时：请检查网络连接，以及 Base URL 是否可达。".to_string()
        } else if e.is_connect() {
            format!("无法连接到嵌入服务：{msg}。请确认 Base URL 正确且网络可用。")
        } else {
            format!("嵌入请求失败：{msg}")
        }
    })?;
    let status = resp.status().as_u16();
    // E8：同 ai_chat——读取失败映射为传输错误而非静默空串。
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取嵌入响应失败：{e}"))?;
    if status >= 400 {
        return Err(friendly_error(status, &text));
    }

    // 标准 OpenAI 响应：data[i] = { index, embedding }（index 指回输入序号）。
    #[derive(Deserialize)]
    struct EmbeddingsResponse {
        data: Vec<EmbeddingItem>,
    }
    #[derive(Deserialize)]
    struct EmbeddingItem {
        index: usize,
        embedding: Vec<f32>,
    }
    let parsed: EmbeddingsResponse = serde_json::from_str(&text).map_err(|e| {
        format!(
            "无法解析嵌入响应（可能不是 OpenAI 兼容 /embeddings 接口）：{e}\n原始响应：{}",
            truncate_error_body(&text)
        )
    })?;
    if parsed.data.len() != input.len() {
        return Err(format!(
            "嵌入响应数量不匹配：请求 {} 条，返回 {} 条。",
            input.len(),
            parsed.data.len()
        ));
    }
    let mut vectors: Vec<Option<Vec<f32>>> = (0..input.len()).map(|_| None).collect();
    for item in parsed.data {
        if item.index >= vectors.len() {
            return Err(format!("嵌入响应 index 越界：{}", item.index));
        }
        vectors[item.index] = Some(item.embedding);
    }
    if let Some(i) = vectors.iter().position(|v| v.is_none()) {
        return Err(format!("嵌入响应缺少第 {i} 条输入的向量。"));
    }
    let vectors = vectors.into_iter().flatten().collect();
    Ok(EmbedResult { vectors })
}

/// Streaming variant: emits SSE chunks as Tauri events.
///
/// Events (all carry `id` matching `request_id`):
///   * `ai_stream_chunk`     → `{ id, delta }`  (visible answer tokens)
///   * `ai_stream_reasoning` → `{ id, delta }`  (thinking tokens; reasoning models only)
///   * `ai_stream_tool_calls`→ `{ id, tool_calls }` (聚合完成的工具调用数组；仅 finish_reason == "tool_calls" 时发射一次)
///   * `ai_stream_done`      → `{ id }`
///   * `ai_stream_error`     → `{ id, error }`
///
/// `tools`（v4.9 Agent 链路）透传给上游；None 时不发送该字段，普通对话
/// 请求体逐字节不变。流式 tool_calls 的分片聚合见下方 `AggToolCall`。
///
/// The command returns `Ok(())` once the stream closes cleanly; a stream-level
/// error is delivered via the `ai_stream_error` event AND returned as `Err`,
/// so the frontend's `invoke` promise rejects too (defensive: some event races
/// may drop the last event before the listener detaches).
#[command]
#[allow(clippy::too_many_arguments)] // 同 ai_chat：命令签名即 wire 格式
pub async fn ai_chat_stream(
    app: AppHandle,
    base_url: String,
    api_key: String,
    model: String,
    provider: Option<String>,
    thinking_strength: Option<String>,
    messages: Vec<ChatMessage>,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    top_p: Option<f32>,
    tools: Option<serde_json::Value>,
    request_id: String,
) -> Result<(), String> {
    if base_url.trim().is_empty() {
        let msg = "未配置 AI Base URL，请在「设置 → AI」中填写。".to_string();
        let _ = app.emit(
            "ai_stream_error",
            StreamErr {
                id: request_id,
                error: msg.clone(),
            },
        );
        return Err(msg);
    }
    if model.trim().is_empty() {
        let msg = "未配置模型名称，请在「设置 → AI」中填写。".to_string();
        let _ = app.emit(
            "ai_stream_error",
            StreamErr {
                id: request_id,
                error: msg.clone(),
            },
        );
        return Err(msg);
    }

    let thinking = thinking_fields(
        provider.as_deref().unwrap_or("custom"),
        thinking_strength.as_deref().unwrap_or("off"),
    );

    let client = http();
    let body = build_request_body(
        &model,
        &messages,
        temperature,
        max_tokens,
        top_p,
        true,
        thinking.as_ref(),
        tools.as_ref(),
    );

    // Streaming: NO total timeout — a slow but healthy stream may legitimately
    // run for minutes; only the shared client's connect timeout applies.
    let resp = send_request(client, &base_url, &api_key, body, None).await?;
    let status = resp.status().as_u16();
    if status >= 400 {
        // Drain the body for a helpful message, then surface via event + Err.
        // E8：错误分支读取详情失败也不再吞成空串——保留占位说明。
        let text = resp
            .text()
            .await
            .unwrap_or_else(|e| format!("（错误详情读取失败：{e}）"));
        let msg = friendly_error(status, &text);
        let _ = app.emit(
            "ai_stream_error",
            StreamErr {
                id: request_id,
                error: msg.clone(),
            },
        );
        return Err(msg);
    }

    // 取消守卫：任何退出路径（含 `?` 早退）都会清掉自己的取消条目。
    let _cancel_guard = CancelGuard(request_id.clone());

    // Walk the SSE byte stream line by line. Each `data:` line is either
    // `[DONE]` (terminator) or a JSON chunk whose choices[0].delta.content
    // holds the incremental text.
    let mut stream = resp.bytes_stream();
    // Raw byte buffer with a read cursor: `pos` marks where parsed lines end.
    // The consumed prefix is dropped once per chunk (below). Draining per line
    // instead would memmove the remaining tail on every line — O(n²) when a
    // burst of frames arrives inside one big chunk.
    let mut buf: Vec<u8> = Vec::new();
    let mut pos: usize = 0;
    // 流式 tool_calls 分片聚合（v4.9 Agent 链路）：key = delta 序号，值按
    // OpenAI 线格式逐片拼接（见 merge_tool_call_deltas）。普通对话（不带
    // tools）恒为空，任何路径零影响。
    let mut tool_agg: BTreeMap<u64, AggToolCall> = BTreeMap::new();

    // P7：读空闲超时（60s）。原实现仅设 connect_timeout：服务器建连后不
    // 发数据则本命令永久挂起，且取消检查只在 chunk 到达时求值——「停止」
    // 按钮对停滞流无效（恰是空转计费场景）。SSE 保活注释行本就无害透传，
    // 60 秒收不到任何字节即判死流并向用户报错。
    const STREAM_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
    loop {
        let chunk_result = match tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.next()).await {
            Ok(Some(cr)) => cr,
            Ok(None) => break, // 流正常结束
            Err(_elapsed) => {
                let msg = "AI 流式响应已停滞超过 60 秒，连接中断（可重试）".to_string();
                let _ = app.emit(
                    "ai_stream_error",
                    StreamErr {
                        id: request_id.clone(),
                        error: msg.clone(),
                    },
                );
                return Err(msg);
            }
        };
        // 前端已取消：停拉上游流（不再消耗计费 token），按正常收尾通知。
        if stream_cancelled(&request_id) {
            let _ = app.emit("ai_stream_done", StreamDone { id: request_id });
            return Ok(());
        }
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("流式读取失败：{e}");
                let _ = app.emit(
                    "ai_stream_error",
                    StreamErr {
                        id: request_id.clone(),
                        error: msg.clone(),
                    },
                );
                return Err(msg);
            }
        };
        buf.extend_from_slice(&chunk);

        // Process complete lines (terminated by `\n`). Decode lossily per LINE
        // rather than per chunk: a multi-byte UTF-8 char split across a chunk
        // boundary would otherwise turn into U+FFFD pairs (`\n` is ASCII, so a
        // line never slices a multi-byte char in half). Any trailing partial
        // line stays in `buf` for the next chunk.
        while let Some(nl) = buf[pos..].iter().position(|&b| b == b'\n') {
            let end = pos + nl;
            let line = String::from_utf8_lossy(&buf[pos..end]);
            pos = end + 1; // consume the line + its newline

            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with(':') {
                // Blank line / SSE comment — skip.
                continue;
            }
            let data = match trimmed.strip_prefix("data:") {
                Some(d) => d.trim(),
                None => continue, // event/id lines we don't use
            };
            if data == "[DONE]" {
                // 安全网：部分兼容实现流完 tool_calls 分片却不给显式
                // finish_reason=="tool_calls"，此处补发聚合结果（空表无操作；
                // finish_reason 路径发射后已直接 return，不会与之重复）。
                if !emit_pending_tool_calls(&app, &request_id, &tool_agg) {
                    return Ok(());
                }
                let _ = app.emit(
                    "ai_stream_done",
                    StreamDone {
                        id: request_id.clone(),
                    },
                );
                return Ok(());
            }
            // Parse the delta content (may be absent, e.g. role-only frames).
            #[derive(Deserialize)]
            struct ChunkResponse {
                #[serde(default)]
                choices: Vec<ChunkChoice>,
            }
            #[derive(Deserialize)]
            struct ChunkChoice {
                #[serde(default)]
                delta: ChunkDelta,
                #[serde(default)]
                finish_reason: Option<String>,
            }
            #[derive(Deserialize, Default)]
            struct ChunkDelta {
                #[serde(default)]
                content: Option<String>,
                // Reasoning / thinking tokens. Different providers disagree on
                // the field name, so accept all known variants and merge below:
                //   * reasoning         — OpenAI o-series
                //   * reasoning_content — DeepSeek-R1 / GLM / Qwen3 / Kimi
                #[serde(default)]
                reasoning: Option<String>,
                #[serde(default)]
                reasoning_content: Option<String>,
                // 工具调用分片（v4.9）：每片带 index 定位，function.arguments
                // 为增量字符串，需跨帧拼接（聚合见 merge_tool_call_deltas）。
                #[serde(default)]
                tool_calls: Option<Vec<ToolCallDelta>>,
            }
            let parsed: ChunkResponse = match serde_json::from_str(data) {
                Ok(p) => p,
                Err(_) => continue, // ignore unparseable frames (keepalive etc.)
            };
            if let Some(choice) = parsed.choices.into_iter().next() {
                if let Some(delta) = choice.delta.content {
                    if !delta.is_empty() {
                        // Emit failure ⇒ the frontend receiver is gone (page
                        // closed / request cancelled): stop pulling the stream
                        // instead of burning tokens nobody sees.
                        if !emit_to_frontend(
                            &app,
                            "ai_stream_chunk",
                            StreamChunk {
                                id: request_id.clone(),
                                delta,
                            },
                        ) {
                            return Ok(());
                        }
                    }
                }
                // Reasoning / thinking tokens (o1 / deepseek-r1 / glm-z1 /
                // kimi-k2 …). Providers disagree on the field name, so accept
                // both reasoning_content (DeepSeek/GLM/Qwen) and reasoning
                // (OpenAI o-series); the non-empty one wins. May interleave
                // with content above.
                let reasoning = choice.delta.reasoning_content.or(choice.delta.reasoning);
                if let Some(delta) = reasoning {
                    if !delta.is_empty() {
                        // Frontend gone — same early exit as content above.
                        if !emit_to_frontend(
                            &app,
                            "ai_stream_reasoning",
                            StreamReasoning {
                                id: request_id.clone(),
                                delta,
                            },
                        ) {
                            return Ok(());
                        }
                    }
                }
                // Some providers signal end via finish_reason without [DONE].
                // tool_calls 路径（v4.9）：先把聚合表组转成 OpenAI 完整格式
                // 发射一次（ai_stream_tool_calls），随后照常 done。
                match choice.finish_reason.as_deref() {
                    Some("stop") => {
                        let _ = app.emit(
                            "ai_stream_done",
                            StreamDone {
                                id: request_id.clone(),
                            },
                        );
                        return Ok(());
                    }
                    Some("tool_calls") => {
                        if !tool_agg.is_empty()
                            && !emit_to_frontend(
                                &app,
                                "ai_stream_tool_calls",
                                StreamToolCalls {
                                    id: request_id.clone(),
                                    tool_calls: finalize_tool_calls(&tool_agg),
                                },
                            )
                        {
                            return Ok(());
                        }
                        let _ = app.emit(
                            "ai_stream_done",
                            StreamDone {
                                id: request_id.clone(),
                            },
                        );
                        return Ok(());
                    }
                    _ => {}
                }
                // 工具调用分片：逐片并入聚合表（取消检查由外层每个 chunk 到达
                // 时的 stream_cancelled 覆盖——含 tool_calls 的 delta 同样生效）。
                if let Some(tcs) = choice.delta.tool_calls {
                    merge_tool_call_deltas(&mut tool_agg, &tcs);
                }
            }
        }

        // Drop the consumed prefix in one go — amortised O(n) per chunk.
        if pos > 0 {
            buf.drain(..pos);
            pos = 0;
        }

        // Guard: if the leftover partial line (no newline yet) exceeds the
        // cap, the server is misbehaving — bail before buf grows unbounded.
        if buf.len() > MAX_BUFFER_BYTES {
            let msg = format!(
                "SSE 缓冲区超出上限（{} 字节），服务端可能未按行分隔响应。",
                MAX_BUFFER_BYTES
            );
            let _ = app.emit(
                "ai_stream_error",
                StreamErr {
                    id: request_id.clone(),
                    error: msg.clone(),
                },
            );
            return Err(msg);
        }
    }

    // Stream ended without an explicit terminator — still signal done so the
    // UI exits its "thinking" state. 未决工具调用同样补发（同 [DONE] 安全网）。
    if !emit_pending_tool_calls(&app, &request_id, &tool_agg) {
        return Ok(());
    }
    let _ = app.emit("ai_stream_done", StreamDone { id: request_id });
    Ok(())
}

// ---- shared helpers -------------------------------------------------------

/// Process-wide shared HTTP client. A `reqwest::Client` owns a connection
/// pool; building one per call throws that pool away, so every call re-pays
/// TCP + TLS handshakes. One client for the app's lifetime via `OnceLock`.
///
/// Deliberately NO total timeout here — long SSE streams are legitimate.
/// Callers needing a total bound (`ai_chat`, image downloads) set one per
/// request via `RequestBuilder::timeout`.
static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

/// Accessor for the shared client; also used by `commands::fetch_image`.
pub(crate) fn http() -> &'static reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
            // Only fails if the TLS backend fails to initialise — nothing
            // sensible to degrade to, so crash loudly at first use.
            .build()
            .expect("failed to build reqwest client")
    })
}

/// Emit a stream event; `false` means the frontend receiver is gone (page
/// closed / request cancelled). In-loop callers stop pulling the upstream
/// stream when this returns false — not an error path, whatever was already
/// delivered stands. Terminal events (done/error) skip this check since the
/// command returns right after them anyway.
fn emit_to_frontend(app: &AppHandle, event: &str, payload: impl Serialize + Clone) -> bool {
    app.emit(event, payload).is_ok()
}

/// Build the chat-completions JSON body. Optional sampling params are only
/// included when `Some`, so we never send `max_tokens: 0` (which some servers
/// reject). `thinking`, when `Some`, is merged in as-is (provider-specific fields
/// computed by `thinking_fields`). `tools`（v4.9 Agent 链路）透传；None 时不
/// 出现该键，普通对话请求体逐字节不变。
#[allow(clippy::too_many_arguments)] // 请求体字段一一对应，收拢会失去显式性
fn build_request_body(
    model: &str,
    messages: &[ChatMessage],
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    top_p: Option<f32>,
    stream: bool,
    thinking: Option<&serde_json::Value>,
    tools: Option<&serde_json::Value>,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": stream,
    });
    if let Some(t) = temperature {
        body["temperature"] = serde_json::json!(t);
    } else {
        body["temperature"] = serde_json::json!(0.7);
    }
    if let Some(m) = max_tokens {
        if m > 0 {
            body["max_tokens"] = serde_json::json!(m);
        }
    }
    if let Some(p) = top_p {
        body["top_p"] = serde_json::json!(p);
    }
    // Merge provider-specific reasoning/thinking fields (reasoning_effort or
    // thinking.budget_tokens) when the user picked a non-"off" strength.
    if let Some(t) = thinking {
        if let (Some(obj), Some(t_obj)) = (body.as_object_mut(), t.as_object()) {
            obj.extend(t_obj.iter().map(|(k, v)| (k.clone(), v.clone())));
        }
    }
    if let Some(t) = tools {
        body["tools"] = t.clone();
    }
    body
}

// ---- 流式 tool_calls 增量聚合（v4.9 Agent 链路）------------------------------
//
// OpenAI 流式协议中 tool_calls 的 function.arguments 是分片拼接的：
//   delta: {"tool_calls":[{"index":0,"id":"call_1","type":"function",
//           "function":{"name":"search_notes","arguments":""}}]}
//   delta: {"tool_calls":[{"index":0,"function":{"arguments":"{\"qu"}}]}
//   delta: {"tool_calls":[{"index":0,"function":{"arguments":"ery\":\"foo\"}"}}]}
//   finish_reason: "tool_calls"
// 聚合规则：按 index 分组（缺失时用数组下标兜底）；id/name 取首个非空值；
// arguments 字符串拼接；finish_reason == "tool_calls" 时按 index 排序输出
// 完整数组（BTreeMap 天然有序）。arguments 不在此处校验 JSON 合法性——
// 非法片段原样透传，由前端 Agent 循环把解析失败回传给模型自我纠正。

/// 单帧 delta.tool_calls[i] 的线格式（字段全部可选：首片带 id/name，后续
/// 片通常只有 arguments 增量）。
#[derive(Deserialize, Default, Clone, Debug)]
struct ToolCallDelta {
    #[serde(default)]
    index: Option<u64>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<FunctionDelta>,
}

#[derive(Deserialize, Default, Clone, Debug)]
struct FunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

/// 聚合中的单个工具调用（空串 = 尚未见到该字段）。
#[derive(Default, Clone, Debug, PartialEq)]
struct AggToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// 把一帧 delta.tool_calls 数组合并进聚合表。纯函数，可单测。
fn merge_tool_call_deltas(agg: &mut BTreeMap<u64, AggToolCall>, deltas: &[ToolCallDelta]) {
    for (fallback, d) in deltas.iter().enumerate() {
        let key = d.index.unwrap_or(fallback as u64);
        let slot = agg.entry(key).or_default();
        if let Some(id) = d.id.as_deref() {
            if !id.is_empty() && slot.id.is_empty() {
                slot.id = id.to_string();
            }
        }
        if let Some(f) = &d.function {
            if let Some(name) = f.name.as_deref() {
                if !name.is_empty() && slot.name.is_empty() {
                    slot.name = name.to_string();
                }
            }
            if let Some(args) = f.arguments.as_deref() {
                slot.arguments.push_str(args);
            }
        }
    }
}

/// 聚合表 → OpenAI 完整 tool_calls 数组（BTreeMap 按 index 升序）。
fn finalize_tool_calls(agg: &BTreeMap<u64, AggToolCall>) -> Vec<serde_json::Value> {
    agg.values()
        .map(|c| {
            serde_json::json!({
                "id": c.id,
                "type": "function",
                "function": { "name": c.name, "arguments": c.arguments },
            })
        })
        .collect()
}

/// 流正常收尾（[DONE]/EOF）时的未决工具调用安全网。空表无操作；发射失败
/// （前端接收方已消失）返回 false，调用方停止拉流按正常收尾退出。
fn emit_pending_tool_calls(
    app: &AppHandle,
    request_id: &str,
    agg: &BTreeMap<u64, AggToolCall>,
) -> bool {
    if agg.is_empty() {
        return true;
    }
    emit_to_frontend(
        app,
        "ai_stream_tool_calls",
        StreamToolCalls {
            id: request_id.to_string(),
            tool_calls: finalize_tool_calls(agg),
        },
    )
}

/// Map a (provider, thinking_strength) pair to the JSON fields the provider's
/// OpenAI-compatible endpoint expects. Returns `None` for "off"/unknown so we
/// send nothing and stay compatible with non-reasoning models.
///
/// Mapping (per public docs):
///   * openai / openrouter / deepseek / custom / ollama → `reasoning_effort`
///   * glm / moonshot → Anthropic-style `thinking: { type: "enabled",
///     budget_tokens: <N> }`
fn thinking_fields(provider: &str, strength: &str) -> Option<serde_json::Value> {
    let effort = match strength {
        "low" => "low",
        "medium" => "medium",
        "high" => "high",
        _ => return None, // "off" / "" / unknown → send nothing
    };
    // Reasoning budget for the Anthropic-style `thinking` object (GLM/Kimi).
    // Tunable defaults; GLM requires budget_tokens and it must be > 0.
    let budget = match strength {
        "low" => 2048u32,
        "medium" => 8192,
        "high" => 32768,
        _ => return None,
    };
    match provider {
        "glm" | "moonshot" => Some(serde_json::json!({
            "thinking": { "type": "enabled", "budget_tokens": budget }
        })),
        // openai / openrouter / deepseek / custom / ollama / unknown
        _ => Some(serde_json::json!({ "reasoning_effort": effort })),
    }
}

/// POST the body to `{base_url}/chat/completions` with bearer auth when a key
/// is present. `total_timeout`, when `Some`, bounds the whole request via a
/// per-request timeout (the shared client itself has none). Centralises the
/// timeout/connect error wording.
// ---------------------------------------------------------------------------
// S3/SSRF 防线：出站端点校验
//
// base_url 由渲染层逐次传入。被攻破的 webview 可把端点指向
// http://169.254.169.254/（云元数据服务）、内网服务或攻击者主机——而请求
// 会附带用户 api_key，构成密钥外泄 + 内网探测通道。规则与 s3.rs 的
// 「仅 localhost 允许 http」特判同一纪律：
//   * 仅接受 http/https；
//   * http 仅限环回地址（本地 LLM 服务场景），远程端点必须 https；
//   * https 目标拒绝环回/链路本地字面 IP（云元数据服务、本机管理端口）；
//   * 校验失败 → 请求不发出、密钥不附带。
fn endpoint_host(u: &url::Url) -> String {
    u.host_str().unwrap_or_default().to_string()
}

fn host_ip(host: &str) -> Option<std::net::IpAddr> {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .ok()
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host_ip(host).map(|ip| ip.is_loopback()).unwrap_or(false)
}

fn is_link_local_host(host: &str) -> bool {
    host_ip(host)
        .map(|ip| match ip {
            std::net::IpAddr::V4(v4) => v4.is_link_local(),
            std::net::IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80,
        })
        .unwrap_or(false)
}

fn is_private_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_private(),
        // IPv6 unique local（fc00::/7）
        std::net::IpAddr::V6(v6) => (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

/// 校验 AI/嵌入端点（附带 api_key 的出站请求）。
pub fn validate_ai_endpoint(endpoint: &str) -> Result<(), String> {
    let u = url::Url::parse(endpoint).map_err(|e| format!("AI 端点 URL 非法：{e}"))?;
    match u.scheme() {
        "http" => {
            if !is_loopback_host(&endpoint_host(&u)) {
                return Err("AI 端点仅 localhost 允许 http，远程端点必须使用 https".into());
            }
        }
        "https" => {
            let host = endpoint_host(&u);
            if is_loopback_host(&host) || is_link_local_host(&host) {
                return Err(format!(
                    "AI 端点拒绝环回/链路本地地址（云元数据服务）：{host}"
                ));
            }
        }
        other => return Err(format!("AI 端点协议不支持：{other}")),
    }
    Ok(())
}

/// 校验图片代理目标（响应字节回传渲染层，构成内网读取原语）：
/// 拒绝环回/内网/链路本地目标；公网 http/https 均可（远端图片的现实需求）。
pub fn validate_image_url(url_str: &str) -> Result<(), String> {
    let u = url::Url::parse(url_str).map_err(|e| format!("图片地址非法：{e}"))?;
    match u.scheme() {
        "http" | "https" => {}
        other => return Err(format!("图片地址协议不支持：{other}")),
    }
    let host = endpoint_host(&u);
    let internal = is_loopback_host(&host)
        || is_link_local_host(&host)
        || host_ip(&host).map(is_private_ip).unwrap_or(false);
    if internal {
        return Err(format!("图片地址拒绝内网/环回/链路本地目标：{host}"));
    }
    Ok(())
}

async fn send_request(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    body: serde_json::Value,
    total_timeout: Option<Duration>,
) -> Result<reqwest::Response, String> {
    let endpoint = if base_url.ends_with('/') {
        format!("{}chat/completions", base_url)
    } else {
        format!("{}/chat/completions", base_url)
    };
    // S3：端点校验前置——失败则请求不发出、api_key 不附带。
    validate_ai_endpoint(&endpoint)?;
    let mut req = client.post(&endpoint).json(&body);
    if let Some(t) = total_timeout {
        req = req.timeout(t);
    }
    if !api_key.trim().is_empty() {
        req = req.bearer_auth(api_key);
    }
    req.send().await.map_err(|e| {
        let msg = e.to_string();
        if e.is_timeout() {
            "请求超时：请检查网络连接，以及 Base URL 是否可达。".to_string()
        } else if e.is_connect() {
            format!("无法连接到 AI 服务：{msg}。请确认 Base URL 正确且网络可用。")
        } else {
            format!("网络请求失败：{msg}")
        }
    })
}

#[derive(Serialize, Clone)]
struct StreamChunk {
    id: String,
    delta: String,
}

#[derive(Serialize, Clone)]
struct StreamReasoning {
    id: String,
    delta: String,
}

/// v4.9 Agent 链路：聚合完成的工具调用数组（仅 finish_reason == "tool_calls"
/// 或收尾安全网时发射一次，先于 ai_stream_done）。
#[derive(Serialize, Clone)]
struct StreamToolCalls {
    id: String,
    tool_calls: Vec<serde_json::Value>,
}

#[derive(Serialize, Clone)]
struct StreamDone {
    id: String,
}

#[derive(Serialize, Clone)]
struct StreamErr {
    id: String,
    error: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 取消注册表语义（v4.6.2 阶段3 回归网）：登记即取消、流退出清理、
    /// 容量上限整表清空兜「迟到的取消」。
    #[test]
    fn cancel_registry_lifecycle() {
        let mut r = CancelRegistry::new(4);
        assert!(!r.is_cancelled("req-1"));
        r.cancel("req-1");
        assert!(r.is_cancelled("req-1"));
        assert!(!r.is_cancelled("req-2"));
        // 流正常退出 → 条目清理，同 id 的迟到取消不再命中新流
        r.finish("req-1");
        assert!(!r.is_cancelled("req-1"));
    }

    #[test]
    fn cancel_registry_cap_clears_table() {
        let mut r = CancelRegistry::new(3);
        r.cancel("a");
        r.cancel("b");
        r.cancel("c");
        assert!(r.is_cancelled("a"));
        r.cancel("d"); // 触及上限 → 整表清空后插入 d
        assert!(!r.is_cancelled("a"));
        assert!(r.is_cancelled("d"));
    }

    // ---- v4.9 tool calling：序列化兼容 / 聚合 / 请求体 ------------------------

    fn plain_msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.to_string(),
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: None,
        }
    }

    fn tc_delta(
        index: Option<u64>,
        id: Option<&str>,
        name: Option<&str>,
        args: Option<&str>,
    ) -> ToolCallDelta {
        ToolCallDelta {
            index,
            id: id.map(|s| s.to_string()),
            function: Some(FunctionDelta {
                name: name.map(|s| s.to_string()),
                arguments: args.map(|s| s.to_string()),
            }),
        }
    }

    /// 向后兼容红线：无 tool 字段的消息序列化结果与旧格式逐字节一致
    /// （普通对话的请求体零变化）。
    #[test]
    fn chat_message_serialization_unchanged_without_tool_fields() {
        let json = serde_json::to_string(&plain_msg("user", "你好")).unwrap();
        assert_eq!(json, r#"{"role":"user","content":"你好"}"#);
        let json = serde_json::to_string(&plain_msg("system", "sys")).unwrap();
        assert_eq!(json, r#"{"role":"system","content":"sys"}"#);
    }

    /// 带 tool 字段的消息形状正确；旧调用（只传 role/content）能反序列化。
    #[test]
    fn chat_message_roundtrip_with_tool_fields() {
        let assistant = ChatMessage {
            role: "assistant".into(),
            content: String::new(),
            tool_calls: Some(serde_json::json!([{
                "id": "call_1", "type": "function",
                "function": { "name": "search_notes", "arguments": "{\"query\":\"x\"}" }
            }])),
            tool_call_id: None,
        };
        let json = serde_json::to_string(&assistant).unwrap();
        assert!(json.contains(r#""tool_calls""#));
        let back: ChatMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(back.role, "assistant");
        assert!(back.tool_calls.is_some());
        // 旧格式（无 tool 键）→ 字段为 None。
        let old: ChatMessage = serde_json::from_str(r#"{"role":"tool","content":"{}"}"#).unwrap();
        assert_eq!(old.tool_calls, None);
        assert_eq!(old.tool_call_id, None);
        // tool 消息回执 id。
        let tool_msg = ChatMessage {
            role: "tool".into(),
            content: "{}".into(),
            tool_calls: None,
            tool_call_id: Some("call_1".into()),
        };
        let json = serde_json::to_string(&tool_msg).unwrap();
        assert_eq!(
            json,
            r#"{"role":"tool","content":"{}","tool_call_id":"call_1"}"#
        );
    }

    /// 聚合：同一 index 的 arguments 分片拼接，id/name 取首个非空值。
    #[test]
    fn tool_call_aggregation_concatenates_fragments() {
        let mut agg = BTreeMap::new();
        merge_tool_call_deltas(
            &mut agg,
            &[tc_delta(
                Some(0),
                Some("call_1"),
                Some("search_notes"),
                Some(""),
            )],
        );
        merge_tool_call_deltas(&mut agg, &[tc_delta(Some(0), None, None, Some("{\"qu"))]);
        merge_tool_call_deltas(
            &mut agg,
            &[tc_delta(
                Some(0),
                None,
                Some("ignored-later"),
                Some("ery\":\"foo\"}"),
            )],
        );
        assert_eq!(
            agg.get(&0),
            Some(&AggToolCall {
                id: "call_1".into(),
                name: "search_notes".into(),
                arguments: "{\"query\":\"foo\"}".into(),
            })
        );
    }

    /// 聚合：多个 index 交错到达，各自独立拼接；finalize 按 index 排序。
    #[test]
    fn tool_call_aggregation_interleaved_indices() {
        let mut agg = BTreeMap::new();
        merge_tool_call_deltas(
            &mut agg,
            &[tc_delta(
                Some(1),
                Some("call_2"),
                Some("read_note"),
                Some("{\"path\":\"a.md\"}"),
            )],
        );
        merge_tool_call_deltas(
            &mut agg,
            &[tc_delta(
                Some(0),
                Some("call_1"),
                Some("search_notes"),
                Some("{\"q"),
            )],
        );
        merge_tool_call_deltas(
            &mut agg,
            &[
                tc_delta(Some(0), None, None, Some("uery\":\"x\"}")),
                tc_delta(Some(1), None, None, None), // 空片（无增量）
            ],
        );
        let out = finalize_tool_calls(&agg);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["id"], "call_1");
        assert_eq!(out[0]["function"]["name"], "search_notes");
        assert_eq!(out[0]["function"]["arguments"], "{\"query\":\"x\"}");
        assert_eq!(out[1]["id"], "call_2");
        assert_eq!(out[1]["function"]["arguments"], "{\"path\":\"a.md\"}");
        assert_eq!(out[0]["type"], "function");
    }

    /// 聚合：index 缺失时用数组下标兜底（个别兼容实现的简化输出）。
    #[test]
    fn tool_call_aggregation_missing_index_falls_back_to_position() {
        let mut agg = BTreeMap::new();
        merge_tool_call_deltas(
            &mut agg,
            &[tc_delta(None, Some("call_a"), Some("t1"), Some("{}"))],
        );
        merge_tool_call_deltas(&mut agg, &[tc_delta(None, None, None, Some("+"))]);
        assert_eq!(agg.get(&0).unwrap().arguments, "{}+");
        assert_eq!(agg.len(), 1);
    }

    /// 线格式样例（附录）逐帧回放：三片 arguments + finish_reason。
    #[test]
    fn tool_call_aggregation_wire_example() {
        let mut agg = BTreeMap::new();
        for data in [
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search_notes","arguments":""}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"qu"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ery\":\"foo\"}"}}]}}]}"#,
        ] {
            #[derive(Deserialize)]
            struct Wire {
                choices: Vec<WireChoice>,
            }
            #[derive(Deserialize)]
            struct WireChoice {
                delta: WireDelta,
            }
            #[derive(Deserialize, Default)]
            struct WireDelta {
                #[serde(default)]
                tool_calls: Option<Vec<ToolCallDelta>>,
            }
            let w: Wire = serde_json::from_str(data).unwrap();
            let tcs = w
                .choices
                .into_iter()
                .next()
                .unwrap()
                .delta
                .tool_calls
                .unwrap();
            merge_tool_call_deltas(&mut agg, &tcs);
        }
        let out = finalize_tool_calls(&agg);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["function"]["name"], "search_notes");
        assert_eq!(out[0]["function"]["arguments"], "{\"query\":\"foo\"}");
    }

    /// 请求体：tools: None 不出现 tools 键（普通对话零影响）；Some 时透传。
    #[test]
    fn build_request_body_tools_passthrough() {
        let msgs = [plain_msg("user", "hi")];
        let no_tools = build_request_body("m", &msgs, None, None, None, false, None, None);
        assert!(no_tools.get("tools").is_none());

        let tools = serde_json::json!([{
            "type": "function",
            "function": {
                "name": "search_notes",
                "description": "检索",
                "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] },
            }
        }]);
        let with_tools = build_request_body("m", &msgs, None, None, None, true, None, Some(&tools));
        assert_eq!(with_tools["tools"], tools);

        // 带 tool_calls/tool_call_id 的消息原样进入 messages（Agent 循环回传）。
        let tool_msg = ChatMessage {
            role: "tool".into(),
            content: "{\"ok\":true}".into(),
            tool_calls: None,
            tool_call_id: Some("call_9".into()),
        };
        let body = build_request_body("m", &[tool_msg], None, None, None, false, None, None);
        assert_eq!(body["messages"][0]["tool_call_id"], "call_9");
    }

    /// 空聚合表 finalize 为空数组（finish_reason=="stop" 路径不会发射事件）。
    #[test]
    fn finalize_empty_aggregation_is_empty() {
        let agg: BTreeMap<u64, AggToolCall> = BTreeMap::new();
        assert!(finalize_tool_calls(&agg).is_empty());
    }
}

// S3：SSRF 校验回归（独立模块，避免改动既有 tests 的大括号序列）。
#[cfg(test)]
mod ssrf_tests {
    use super::{validate_ai_endpoint, validate_image_url};

    #[test]
    fn ai_endpoint_allows_local_llm_and_public_https() {
        // 本地 LLM（Ollama/LM Studio 场景）：http 环回允许
        assert!(validate_ai_endpoint("http://localhost:11434/v1/").is_ok());
        assert!(validate_ai_endpoint("http://127.0.0.1:1234/v1/").is_ok());
        assert!(validate_ai_endpoint("http://[::1]:9000/v1/").is_ok());
        // 公网 https 允许
        assert!(validate_ai_endpoint("https://api.openai.com/v1/").is_ok());
    }

    #[test]
    fn ai_endpoint_blocks_metadata_and_private_http() {
        // 远程 http 明文拒绝（密钥外泄 + 明文探测通道）
        assert!(validate_ai_endpoint("http://api.example.com/v1/").is_err());
        // 云元数据服务：链路本地无论 http/https 一律拒绝
        assert!(validate_ai_endpoint("http://169.254.169.254/latest/meta-data/").is_err());
        assert!(validate_ai_endpoint("https://169.254.169.254/").is_err());
        // https 环回拒绝（本机管理端口）
        assert!(validate_ai_endpoint("https://127.0.0.1:9222/").is_err());
        // 非法协议
        assert!(validate_ai_endpoint("file:///etc/passwd").is_err());
    }

    #[test]
    fn image_url_blocks_internal_targets_allows_public() {
        assert!(validate_image_url("https://cdn.example.com/a.png").is_ok());
        // 公网 http 允许（远端图片的现实需求）
        assert!(validate_image_url("http://example.com/a.png").is_ok());
        // 内网/环回/链路本地全拒
        assert!(validate_image_url("http://127.0.0.1:9222/json").is_err());
        assert!(validate_image_url("http://localhost:8080/x.png").is_err());
        assert!(validate_image_url("http://192.168.1.1/admin").is_err());
        assert!(validate_image_url("http://10.0.0.2/").is_err());
        assert!(validate_image_url("http://169.254.169.254/latest/meta-data/").is_err());
        assert!(validate_image_url("ftp://x/y").is_err());
    }
}
