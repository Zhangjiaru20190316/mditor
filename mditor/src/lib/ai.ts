// AI helpers — wrappers around the Rust `ai_chat` / `ai_chat_stream` commands
// (OpenAI-compatible).
//
// All HTTP happens in Rust so we don't have to relax the webview's CSP and the
// API key is never logged to the JS console. This module just shapes messages,
// wires up the SSE-stream event listeners, and surfaces friendly errors.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AiModelConfig, Settings } from "../types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  settings: Settings;
  messages: ChatMessage[];
}

/**
 * Resolve the currently active model connection from settings. Falls back to
 * the first configured entry when the active id is stale, then to the legacy
 * flat fields. Centralising this here means every caller (AiPanel, the test
 * button, selection toolbar) supports multi-model without per-caller changes.
 */
export function resolveActiveModel(s: Settings): AiModelConfig {
  const models = Array.isArray(s.aiModels) ? s.aiModels : [];
  const byId = models.find((m) => m.id === s.aiActiveModelId);
  if (byId) return byId;
  if (models.length > 0) return models[0];
  // Last-resort fallback: synthesise from legacy flat fields.
  return {
    id: "default",
    name: "默认模型",
    provider: s.aiProvider ?? "custom",
    baseUrl: s.aiBaseUrl ?? "",
    apiKey: s.aiApiKey ?? "",
    model: s.aiModel ?? "",
  };
}

/** True when the active model has enough config to attempt a request. */
export function isAiConfigured(s: Settings): boolean {
  const m = resolveActiveModel(s);
  return m.baseUrl.trim().length > 0 && m.model.trim().length > 0;
}

/** Built-in default system prompt (used when settings.aiSystemPrompt is empty). */
const DEFAULT_SYSTEM_PROMPT = [
  "你是一个 Markdown 写作助手，集成在 Mditor 编辑器中。",
  "用户正在编辑一篇笔记，下面用 <note> 标签给出当前全文作为上下文。",
  "回答请使用中文。涉及代码时用 Markdown 代码块；涉及数学公式时用 LaTeX 语法，",
  "行内公式用 $...$、独立公式块用 $$...$$。",
  "当用户要求修改笔记时，只输出修改后的 Markdown 片段或全文，不要多余解释，",
  "以便用户直接插入或替换。其他问题正常作答。",
].join("\n");

/**
 * Build the system prompt that gives the assistant the current note as context.
 * Prefers the user's custom prompt (if non-empty) over the built-in default.
 */
export function buildSystemPrompt(note: string, custom?: string): string {
  const base = custom && custom.trim() ? custom.trim() : DEFAULT_SYSTEM_PROMPT;
  return [
    base,
    "",
    "<note>",
    note.trim() || "（当前笔记为空）",
    "</note>",
  ].join("\n");
}

/**
 * Build a "selection mode" system prompt: the user has highlighted a fragment
 * and wants the model to act on just that fragment (rewrite / translate /
 * explain / answer a question about it). The full note is provided read-only
 * as broader context, but the model should focus on the selection.
 *
 * When `instruction` contains a `{selection}` placeholder, the selection is
 * spliced in there; otherwise it's appended under a <selection> tag.
 */
export function buildSelectionMessages(opts: {
  instruction: string;
  selection: string;
  noteContext?: string;
  systemPromptOverride?: string;
}): ChatMessage[] {
  const { instruction, selection, noteContext, systemPromptOverride } = opts;
  const sys = systemPromptOverride?.trim() || DEFAULT_SYSTEM_PROMPT;
  const system = [
    sys,
    "",
    "当前模式：用户选中了笔记中的一个片段，希望你针对【选中的片段】进行操作。",
    "修改类操作（润色/改写/翻译等）请只输出处理后的片段，不要任何解释或前后缀，",
    "以便用户直接替换选区。问答类操作（解释/提问）正常作答。",
    noteContext && noteContext.trim()
      ? `\n<note>\n${noteContext.trim()}\n</note>`
      : "",
  ].join("\n");

  const user = instruction.includes("{selection}")
    ? instruction.replace(/\{selection\}/g, selection)
    : `${instruction}\n\n<selection>\n${selection}\n</selection>`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Build the refinement request that turns a long AI reply into an annotation.
 * Used by the "批注" action on each assistant message. The result is rendered
 * as Markdown in the annotation popover / list, so the prompt enforces a
 * lightweight structure the renderer can handle (no headings / code fences /
 * images / links / tables / blockquotes — those would break the popover layout).
 *
 * Note: 「可增 / 可删 / 可改」是对批注**功能**的能力描述（用户可在 popover /
 * 列表面板里编辑、删除批注），不是对批注**内容**的强制三段结构。因此正文
 * 不再套用固定分类，由模型按内容性质自由组织。
 *
 * Output shape:
 *   1. 首行：**加粗** 一句话核心结论（≤25 字，直击重点）。
 *   2. 正文：根据内容性质自由组织 —— 几条要点、一段说明或按需分小节均可，
 *      不强制三段分类；有数学公式时用 $...$ / $$...$$。
 *   3. 末尾可选「重点」一行，给出最该优先处理的事（≤30 字）。
 *
 * Hard rules:
 *   - 每条建议必须指向具体点，禁止泛泛而谈（如「可以更生动」）。
 *   - 单条 15-40 字，先说改什么，再说为什么。
 *   - 总长 150-400 字，信息密度高、避免空话，不得只输出一句话总结。
 *   - 只输出批注正文，无前后缀、无引号、无「批注：」之类前缀。
 */
export function buildAnnotationMessages(reply: string): ChatMessage[] {
  const system = [
    "你是 Mditor 编辑器中的批注助手。把下面的内容精炼成一条结构清晰、高信息密度的 Markdown 批注，挂在用户选中的文字旁。",
    "",
    "输出要求：",
    "1. 首行：用 **加粗** 给出一句话核心结论（≤25 字，直击重点；禁止「本段主要讲述了…」这类套话）。",
    "2. 正文：根据内容性质自由组织 —— 可以是几条无序列表要点、一段说明，或按需分小节；",
    "   不要强制套用「可增 / 可删 / 可改」三段结构，按实际需要选择最清晰的呈现方式。",
    "3. 末尾可选附一行「重点」：给出最该优先处理的一件事（≤30 字）。",
    "",
    "风格与约束：",
    "- 每条建议必须指向原文 / 回复中的具体点，禁止泛泛而谈（如「可以更生动」「需要优化」）。",
    "- 单条建议 15-40 字，先说改什么，再说为什么。",
    "- 总长 150-400 字，信息密度高、避免空话，不得只输出一句话总结。",
    "- 允许使用 **加粗**、`行内代码`、无序 / 有序列表、$行内公式$、$$独立公式块$$；列表保持扁平（不嵌套）。",
    "- 禁止使用标题（#）、代码块（```）、图片、链接、表格、引用块（>）。",
    "- 只输出批注正文，不要解释、不要引号、不要「批注：」「好的」之类前后缀。",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: reply },
  ];
}

/** Single-shot chat: returns the assistant's text reply. Used for "测试连接". */
export async function chat({ settings, messages }: ChatOptions): Promise<string> {
  const m = resolveActiveModel(settings);
  const result = await invoke<{ content: string }>("ai_chat", {
    baseUrl: m.baseUrl,
    apiKey: m.apiKey,
    model: m.model,
    provider: m.provider,
    thinkingStrength: settings.aiThinkingStrength,
    messages,
    temperature: settings.aiTemperature,
    maxTokens: settings.aiMaxTokens || undefined,
    topP: settings.aiTopP,
  });
  return result.content;
}

/** A minimal "are these credentials valid" ping. Returns true on success. */
export async function testConnection(settings: Settings): Promise<void> {
  await chat({
    settings,
    messages: [{ role: "user", content: "ping" }],
  });
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Event payload shapes (mirror the Rust structs in ai.rs). */
interface StreamChunkEvent {
  id: string;
  delta: string;
}
interface StreamReasoningEvent {
  id: string;
  delta: string;
}
interface StreamDoneEvent {
  id: string;
}
interface StreamErrorEvent {
  id: string;
  error: string;
}

export interface StreamHandlers {
  onChunk: (delta: string) => void;
  /** Reasoning / thinking tokens (reasoning models only). Optional: when the
   *  provider doesn't emit reasoning, this is never called. */
  onReasoning?: (delta: string) => void;
  onDone: () => void;
  onError: (err: string) => void;
}

export interface StreamHandle {
  /** Detach listeners and signal the backend (best-effort). No-op if already done. */
  cancel: () => void;
}

/**
 * Start a streaming chat. Spawns the Rust `ai_chat_stream` command (which emits
 * `ai_stream_chunk` / `ai_stream_reasoning` / `ai_stream_done` / `ai_stream_error`
 * events tagged with `requestId`) and wires those events to the handlers. Returns
 * a handle whose `cancel()` tears everything down. The invoke promise itself
 * resolves on clean completion; we route its rejection through `onError` so callers
 * don't need separate try/catch paths. `onReasoning` (optional) receives the
 * reasoning-model thinking tokens via `ai_stream_reasoning`.
 */
export function chatStream(
  opts: ChatOptions & { requestId: string; handlers: StreamHandlers }
): StreamHandle {
  const { settings, messages, requestId, handlers } = opts;
  const m = resolveActiveModel(settings);
  let cancelled = false;
  let finished = false;
  // unlisten funcs arrive asynchronously (listen() resolves a Promise). We
  // stash them in a ref so cleanup always reads the latest set — important
  // when the backend stream completes before the listen() promises resolve
  // (fast local servers); without this the handlers would leak.
  const unlistenFns: UnlistenFn[] = [];

  const cleanup = () => {
    unlistenFns.splice(0).forEach((fn) => fn());
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    cleanup();
  };

  listen<StreamChunkEvent>("ai_stream_chunk", (ev) => {
    if (ev.payload.id === requestId && !cancelled) handlers.onChunk(ev.payload.delta);
  }).then((fn) => {
    if (finished) fn();
    else unlistenFns.push(fn);
  });
  // Reasoning / thinking tokens (reasoning models only). Optional handler —
  // only registered when the caller supplied onReasoning, to avoid an idle
  // listener for non-reasoning flows.
  if (handlers.onReasoning) {
    const onReasoning = handlers.onReasoning;
    listen<StreamReasoningEvent>("ai_stream_reasoning", (ev) => {
      if (ev.payload.id === requestId && !cancelled) onReasoning(ev.payload.delta);
    }).then((fn) => {
      if (finished) fn();
      else unlistenFns.push(fn);
    });
  }
  listen<StreamDoneEvent>("ai_stream_done", (ev) => {
    if (ev.payload.id === requestId && !cancelled) {
      finish();
      handlers.onDone();
    }
  }).then((fn) => {
    if (finished) fn();
    else unlistenFns.push(fn);
  });
  listen<StreamErrorEvent>("ai_stream_error", (ev) => {
    if (ev.payload.id === requestId && !cancelled) {
      finish();
      handlers.onError(ev.payload.error);
    }
  }).then((fn) => {
    if (finished) fn();
    else unlistenFns.push(fn);
  });

  // Kick off the backend. Rejection (network / HTTP error) is routed to onError.
  invoke("ai_chat_stream", {
    baseUrl: m.baseUrl,
    apiKey: m.apiKey,
    model: m.model,
    provider: m.provider,
    thinkingStrength: settings.aiThinkingStrength,
    messages,
    temperature: settings.aiTemperature,
    maxTokens: settings.aiMaxTokens || undefined,
    topP: settings.aiTopP,
    requestId,
  })
    .then(() => {
      // Clean completion resolves here; the done event is the canonical signal,
      // but guard against the (rare) case where the event was missed.
      if (!finished && !cancelled) {
        finish();
        handlers.onDone();
      }
    })
    .catch((e) => {
      if (cancelled || finished) return;
      finish();
      handlers.onError(String(e));
    });

  return {
    cancel: () => {
      cancelled = true;
      finish();
      handlers.onDone();
    },
  };
}
