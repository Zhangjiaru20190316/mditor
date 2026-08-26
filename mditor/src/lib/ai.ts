// AI helpers — wrappers around the Rust `ai_chat` / `ai_chat_stream` commands
// (OpenAI-compatible).
//
// All HTTP happens in Rust so we don't have to relax the webview's CSP and the
// API key is never logged to the JS console. This module just shapes messages,
// wires up the SSE-stream event listeners, and surfaces friendly errors.

import { invoke } from "@tauri-apps/api/core";
import { sysEmit } from "./sysDebug";
import { tracedIo } from "./ipcTrace";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AiModelConfig, AiContextStrategy, Settings } from "../types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  settings: Settings;
  messages: ChatMessage[];
}

// ---------------------------------------------------------------------------
// Token 降本（v3.9）：上下文截断 / 估算 / 历史预算
// ---------------------------------------------------------------------------
// DeepSeek 等 OpenAI 兼容服务的输入 token 密度高、计费敏感：旧实现把整篇
// 笔记 + 全部历史原样塞进每次请求（长文档多轮聊天输入 token 轻松上探
// 数万）。以下三个纯函数把请求体收敛到可配置预算内，全部本地计算、零
// 额外请求；调用方（AiPanel / App）只负责传策略参数。

/** 各策略保留的笔记正文字符预算（smart 的总预算同 large）。 */
const STANDARD_NOTE_CHARS = 6000;
const LARGE_NOTE_CHARS = 12000;
/** 截断尾标 —— 让模型明确知道上文不完整，避免“复述全文”类任务漏内容。 */
const TRUNCATED_MARK = "\n\n（笔记过长，已截断）";

/**
 * 中英混合 token 估算（逼近 DeepSeek/OpenAI 分词密度）：CJK 字符 ≈ 1.5
 * 字符/token，其余（ASCII/空白/符号）≈ 4 字符/token。够准的量级估计，
 * 用于预算裁剪与用量展示，不追求逐 token 精确。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // CJK 统一表意文字 + 扩展A + 全角符号 + 假名 + 谚文
    if (
      (c >= 0x2e80 && c <= 0x9fff) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xffef) ||
      (c >= 0x3040 && c <= 0x30ff) ||
      (c >= 0xac00 && c <= 0xd7af)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

/** 笔记按行切成“块”（空行分隔；围栏代码块整块不拆），供 smart 策略打分。 */
function splitBlocks(note: string): string[] {
  const lines = note.split(/\r?\n/);
  const blocks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === "") {
      if (cur.length) blocks.push(cur.join("\n"));
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join("\n"));
  return blocks;
}

/** 字符二元组集合（CJK 相关度打分用；ASCII 词整词进集合）。 */
function textFingerprint(s: string): Set<string> {
  const norm = s.toLowerCase();
  const set = new Set<string>();
  const asciiWords = norm.match(/[a-z0-9]+/g) ?? [];
  for (const w of asciiWords) if (w.length >= 2) set.add(w);
  for (let i = 0; i < norm.length - 1; i++) {
    const a = norm.charCodeAt(i);
    const b = norm.charCodeAt(i + 1);
    if (a >= 0x2e80 && a <= 0x9fff && b >= 0x2e80 && b <= 0x9fff) {
      set.add(norm.slice(i, i + 2));
    }
  }
  return set;
}

/** 块与问题的相关度：指纹交集占块指纹的比例（标题行额外 +0.5 权重）。 */
function blockScore(block: string, fp: Set<string>): number {
  let hit = 0;
  let total = 0;
  const norm = block.toLowerCase();
  const words = norm.match(/[a-z0-9]+/g) ?? [];
  for (const w of words) {
    if (w.length < 2) continue;
    total++;
    if (fp.has(w)) hit++;
  }
  for (let i = 0; i < norm.length - 1; i++) {
    const a = norm.charCodeAt(i);
    const b = norm.charCodeAt(i + 1);
    if (a >= 0x2e80 && a <= 0x9fff && b >= 0x2e80 && b <= 0x9fff) {
      total++;
      if (fp.has(norm.slice(i, i + 2))) hit++;
    }
  }
  const ratio = total === 0 ? 0 : hit / total;
  return /^\s{0,3}#{1,6}\s/.test(block) ? ratio + 0.5 : ratio;
}

/**
 * 按策略截断进 <note> 的笔记正文：
 *   * full     — 不截断（用户显式选择，原样发送）；
 *   * standard — 保留开头 6000 字符（默认）；
 *   * large    — 12000 字符；
 *   * smart    — 本地零成本保质量：按块打分（与提问的字符级共现相关度，
 *                标题恒高权），拼「开头段 + 高相关中间块 + 结尾段」，
 *                总预算同 large。无提问时退化为头尾保留。
 */
export function truncateNoteForContext(
  note: string,
  strategy: AiContextStrategy = "standard",
  question?: string
): string {
  const trimmed = note.trim();
  if (!trimmed) return "";
  if (strategy === "full") return trimmed;
  if (strategy === "standard") {
    return trimmed.length <= STANDARD_NOTE_CHARS
      ? trimmed
      : trimmed.slice(0, STANDARD_NOTE_CHARS) + TRUNCATED_MARK;
  }
  if (strategy === "large") {
    return trimmed.length <= LARGE_NOTE_CHARS
      ? trimmed
      : trimmed.slice(0, LARGE_NOTE_CHARS) + TRUNCATED_MARK;
  }
  // smart
  const budget = LARGE_NOTE_CHARS;
  if (trimmed.length <= budget) return trimmed;
  const blocks = splitBlocks(trimmed);
  if (blocks.length <= 2) return trimmed.slice(0, budget) + TRUNCATED_MARK;
  const fp = textFingerprint(question ?? "");
  const scored = blocks.map((b, i) => ({
    i,
    b,
    score: fp.size > 0 ? blockScore(b, fp) : 0,
    len: b.length,
  }));
  const head = scored[0];
  const tail = scored[scored.length - 1];
  const middle = scored.slice(1, -1);
  // 头尾固定保留（文档走向 + 结论区），剩余预算按相关度装填。
  let used = head.len + tail.len;
  const picked = new Set<number>([head.i, tail.i]);
  {
    let room = budget - used - TRUNCATED_MARK.length * 2;
    for (const c of [...middle].sort((a, b) => b.score - a.score)) {
      if (c.len > room) continue;
      picked.add(c.i);
      used += c.len;
      room -= c.len;
    }
  }
  const parts: string[] = [];
  let dropped = 0;
  for (const c of scored) {
    if (picked.has(c.i)) parts.push(c.b);
    else dropped += c.len;
  }
  if (dropped > 0) parts.push("（笔记过长，已按相关度节选）");
  return parts.join("\n\n");
}

/** 历史预算裁剪结果。 */
export interface BudgetedHistory {
  messages: ChatMessage[];
  /** 因超预算被丢弃的消息条数（不含被修剪的孤儿回答）。 */
  dropped: number;
  /** 裁剪后消息集的 token 估算（含 system）。 */
  estimate: number;
}

/**
 * 把消息列表（通常 [system, ...历史, 新问题]）按 token 预算从后往前保留：
 * 最新消息无条件保留（单条超预算也只能发）；超预算时丢弃更早的消息；
 * 丢弃后若开头是“孤儿回答”（其问题已被裁掉），一并修剪以免上下文悬空。
 * system 消息（第一条）恒保留。纯本地估算，零额外请求。
 */
export function buildHistoryWithBudget(
  messages: ChatMessage[],
  budgetTokens = 8000
): BudgetedHistory {
  if (messages.length === 0) {
    return { messages: [], dropped: 0, estimate: 0 };
  }
  const sys: ChatMessage | null = messages[0].role === "system" ? messages[0] : null;
  const rest = sys ? messages.slice(1) : [...messages];
  let estimate = sys ? estimateTokens(sys.content) : 0;
  const kept: ChatMessage[] = [];
  let dropped = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const t = estimateTokens(rest[i].content);
    if (kept.length > 0 && estimate + t > budgetTokens) {
      dropped = i + 1;
      break;
    }
    estimate += t;
    kept.unshift(rest[i]);
  }
  // 修剪孤儿回答：最早保留的消息若是 assistant，它对应的问题已被裁掉。
  while (kept.length > 1 && kept[0].role === "assistant") {
    kept.shift();
    dropped++;
  }
  if (sys) kept.unshift(sys);
  return { messages: kept, dropped, estimate };
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
 * v3.9: the note runs through truncateNoteForContext first (strategy from
 * settings; "full" preserves the old behaviour) — long notes no longer go to
 * the API verbatim on every turn.
 */
export function buildSystemPrompt(
  note: string,
  custom?: string,
  strategy: AiContextStrategy = "standard"
): string {
  const base = custom && custom.trim() ? custom.trim() : DEFAULT_SYSTEM_PROMPT;
  const ctx = truncateNoteForContext(note, strategy);
  return [
    base,
    "",
    "<note>",
    ctx || "（当前笔记为空）",
    "</note>",
  ].join("\n");
}

/**
 * Build a "selection mode" system prompt: the user has highlighted a fragment
 * and wants the model to act on just that fragment (rewrite / translate /
 * explain / answer a question about it). The full note is provided read-only
 * as broader context (v3.9: truncated per strategy), but the model should
 * focus on the selection.
 *
 * When `instruction` contains a `{selection}` placeholder, the selection is
 * spliced in there; otherwise it's appended under a <selection> tag.
 */
export function buildSelectionMessages(opts: {
  instruction: string;
  selection: string;
  noteContext?: string;
  systemPromptOverride?: string;
  strategy?: AiContextStrategy;
}): ChatMessage[] {
  const { instruction, selection, noteContext, systemPromptOverride, strategy } = opts;
  const sys = systemPromptOverride?.trim() || DEFAULT_SYSTEM_PROMPT;
  const note = noteContext
    ? truncateNoteForContext(noteContext, strategy ?? "standard")
    : "";
  const system = [
    sys,
    "",
    "当前模式：用户选中了笔记中的一个片段，希望你针对【选中的片段】进行操作。",
    "修改类操作（润色/改写/翻译等）请只输出处理后的片段，不要任何解释或前后缀，",
    "以便用户直接替换选区。问答类操作（解释/提问）正常作答。",
    note ? `\n<note>\n${note}\n</note>` : "",
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
export function buildAnnotationMessages(
  reply: string,
  maxChars = 4000
): ChatMessage[] {
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
    // v3.9 降本：长回复精炼不再原样重发 —— 输入截断到 maxChars（默认
    // 4000，设置可调）。精炼任务是“压缩”，截断尾部对结果影响可控。
    {
      role: "user",
      content:
        reply.length <= maxChars
          ? reply
          : reply.slice(0, maxChars) + "\n\n（内容过长，已截断）",
    },
  ];
}

/**
 * Build the "一键修复 Markdown 格式" request: the whole note goes to the model
 * verbatim (NO truncateNoteForContext — trimming would produce a half-fixed
 * document) and the model must hand back the full document with only syntax
 * errors repaired, so the reply can be diffed against the original in the
 * 改动预览 (DiffReview) panel.
 *
 * 不携带聊天历史、不受 token 预算裁剪：全文修复是单轮任务，历史与裁剪都会
 * 破坏"输出完整全文"的契约。
 */
export function buildFormatFixMessages(note: string): ChatMessage[] {
  const system = [
    "你是 Mditor 编辑器中的 Markdown 格式修复器。下面给出笔记的完整原文，",
    "请修复其中所有 Markdown 语法错误，输出修复后的完整全文。",
    "",
    "修复范围（只动语法结构）：",
    "- 未闭合 / 未正确开闭的代码围栏（```），补齐围栏并保持原有语言标注；",
    "- 表格：缺失分隔行（| --- |）、列数与表头不齐、单元格竖线错位；",
    "- 标题：# 后缺空格、连续层级跳跃（如 # 一级直接跟 ### 三级）；",
    "- 列表：缩进错误、有序/无序标记混用导致的嵌套错乱；",
    "- 链接 / 图片语法：缺 ]、( ) 或括号不配对；",
    "- 全角标点混入语法位（如 ＃、＊、１．、（） 应作列表/标题/链接符号时）；",
    "- 数学公式定界符错误（行内 $...$、独立块 $$...$$ 不配对）；",
    "- 连续多余空行压缩为一个、行尾多余空格（强调语法前的两个空格除外）。",
    "",
    "硬性约束：",
    "- 逐字保留全部文字内容：不改写、不润色、不增删任何句子或段落、不调换顺序；",
    "- 语法本身正确的部分原样保留，能不动就不动；",
    "- 只输出修复后的完整全文：不要解释、不要前后缀、不要用整体代码围栏包裹。",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: note.trim() ? note : "（当前笔记为空）" },
  ];
}

/** Single-shot chat: returns the assistant's text reply. Used for "测试连接". */
export async function chat({ settings, messages }: ChatOptions): Promise<string> {
  const m = resolveActiveModel(settings);
  // v4.3 诊断：请求失败→MD-8001；不设慢阈值（大模型 legitimately 慢）。
  const result = await tracedIo<{ content: string }>(
    "ai:request",
    `ai_chat ${m.model}`,
    () =>
      invoke<{ content: string }>("ai_chat", {
        baseUrl: m.baseUrl,
        apiKey: m.apiKey,
        model: m.model,
        provider: m.provider,
        thinkingStrength: settings.aiThinkingStrength,
        messages,
        temperature: settings.aiTemperature,
        maxTokens: settings.aiMaxTokens || undefined,
        topP: settings.aiTopP,
      }),
    { slowMs: Infinity }
  );
  // v4.3 诊断：响应形态异常（content 缺失/非字符串）→MD-8004，不改行为。
  if (typeof result?.content !== "string") {
    sysEmit(
      "ai:response-fail",
      `AI 响应异常：content 非字符串（${String(result?.content).slice(0, 60)}）`,
      { level: "warn", data: { model: m.model, got: typeof result?.content } }
    );
  }
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
      sysEmit("ai:stream-fail", `AI 流式错误：${ev.payload.error.slice(0, 160)}`, {
        level: "error",
        data: { requestId, error: ev.payload.error.slice(0, 300), model: m.model },
      });
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
        sysEmit("ai:stream-abnormal-end", "AI 流式结束但未收到 done 事件（异常收尾）", {
          level: "warn",
          data: { requestId, model: m.model },
        });
        finish();
        handlers.onDone();
      }
    })
    .catch((e) => {
      if (cancelled || finished) return;
      sysEmit("ai:stream-fail", `AI 流式启动/请求失败：${String(e).slice(0, 160)}`, {
        level: "error",
        data: { requestId, error: String(e).slice(0, 300), model: m.model },
      });
      finish();
      handlers.onError(String(e));
    });

  return {
    cancel: () => {
      sysEmit("ai:stream-abort", `AI 流式被取消（用户中止/组件卸载）`, {
        data: { requestId, model: m.model },
      });
      cancelled = true;
      finish();
      handlers.onDone();
    },
  };
}
