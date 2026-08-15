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

use std::sync::OnceLock;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Emitter};

/// Total-request timeout for the single-shot `ai_chat` call. Applied per
/// request — the shared client itself carries no total timeout (see `http()`).
const REQUEST_TIMEOUT_SECS: u64 = 120;

/// Connect timeout on the shared client (covers the TCP + TLS handshake).
const CONNECT_TIMEOUT_SECS: u64 = 10;

/// Upper bound on the unparsed SSE buffer (leftover partial line with no
/// newline yet). A well-formed SSE frame is tiny; if `buf` grows past this
/// the server is misbehaving (no newlines / absurdly long frame) and
/// continuing would balloon memory → OOM.
const MAX_BUFFER_BYTES: usize = 1 * 1024 * 1024; // 1 MiB

/// One chat message, mirroring OpenAI's wire format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
}

/// Payload returned to the frontend.
#[derive(Debug, Serialize)]
pub struct ChatResult {
    pub content: String,
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
    );

    let resp = send_request(
        &client,
        &base_url,
        &api_key,
        body,
        // Non-streaming: keep the original 120s total timeout, per request.
        Some(Duration::from_secs(REQUEST_TIMEOUT_SECS)),
    )
    .await?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
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
    }

    let parsed: CompletionResponse = serde_json::from_str(&text).map_err(|e| {
        format!("无法解析 AI 响应（可能 Base URL 不是 OpenAI 兼容接口）：{e}\n原始响应：{text}")
    })?;

    let content = parsed
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message.content)
        .unwrap_or_default();

    Ok(ChatResult { content })
}

/// Streaming variant: emits SSE chunks as Tauri events.
///
/// Events (all carry `id` matching `request_id`):
///   * `ai_stream_chunk`     → `{ id, delta }`  (visible answer tokens)
///   * `ai_stream_reasoning` → `{ id, delta }`  (thinking tokens; reasoning models only)
///   * `ai_stream_done`      → `{ id }`
///   * `ai_stream_error`     → `{ id, error }`
///
/// The command returns `Ok(())` once the stream closes cleanly; a stream-level
/// error is delivered via the `ai_stream_error` event AND returned as `Err`,
/// so the frontend's `invoke` promise rejects too (defensive: some event races
/// may drop the last event before the listener detaches).
#[command]
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
    request_id: String,
) -> Result<(), String> {
    if base_url.trim().is_empty() {
        let msg = "未配置 AI Base URL，请在「设置 → AI」中填写。".to_string();
        let _ = app.emit("ai_stream_error", StreamErr { id: request_id, error: msg.clone() });
        return Err(msg);
    }
    if model.trim().is_empty() {
        let msg = "未配置模型名称，请在「设置 → AI」中填写。".to_string();
        let _ = app.emit("ai_stream_error", StreamErr { id: request_id, error: msg.clone() });
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
    );

    // Streaming: NO total timeout — a slow but healthy stream may legitimately
    // run for minutes; only the shared client's connect timeout applies.
    let resp = send_request(&client, &base_url, &api_key, body, None).await?;
    let status = resp.status().as_u16();
    if status >= 400 {
        // Drain the body for a helpful message, then surface via event + Err.
        let text = resp.text().await.unwrap_or_default();
        let msg = friendly_error(status, &text);
        let _ = app.emit("ai_stream_error", StreamErr { id: request_id, error: msg.clone() });
        return Err(msg);
    }

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

    while let Some(chunk_result) = stream.next().await {
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("流式读取失败：{e}");
                let _ = app.emit("ai_stream_error", StreamErr { id: request_id.clone(), error: msg.clone() });
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
                let _ = app.emit("ai_stream_done", StreamDone { id: request_id.clone() });
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
                            StreamChunk { id: request_id.clone(), delta },
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
                let reasoning = choice
                    .delta
                    .reasoning_content
                    .or(choice.delta.reasoning);
                if let Some(delta) = reasoning {
                    if !delta.is_empty() {
                        // Frontend gone — same early exit as content above.
                        if !emit_to_frontend(
                            &app,
                            "ai_stream_reasoning",
                            StreamReasoning { id: request_id.clone(), delta },
                        ) {
                            return Ok(());
                        }
                    }
                }
                // Some providers signal end via finish_reason without [DONE].
                if choice.finish_reason.as_deref() == Some("stop") {
                    let _ = app.emit("ai_stream_done", StreamDone { id: request_id.clone() });
                    return Ok(());
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
            let _ = app.emit("ai_stream_error", StreamErr { id: request_id.clone(), error: msg.clone() });
            return Err(msg);
        }
    }

    // Stream ended without an explicit terminator — still signal done so the
    // UI exits its "thinking" state.
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
/// computed by `thinking_fields`).
fn build_request_body(
    model: &str,
    messages: &[ChatMessage],
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    top_p: Option<f32>,
    stream: bool,
    thinking: Option<&serde_json::Value>,
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
    body
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

#[derive(Serialize, Clone)]
struct StreamDone {
    id: String,
}

#[derive(Serialize, Clone)]
struct StreamErr {
    id: String,
    error: String,
}
