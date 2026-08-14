// AI assistant panel — chat with an LLM about the current note (or a selection
// within it) and write its answers back into the editor.
//
// Talks to the Rust `ai_chat_stream` command (SSE streaming) via lib/ai.ts.
// Assistant replies are rendered as Markdown using Vditor's static `preview`.
// Conversation history is kept in component state (not persisted) and can be
// cleared with the 🗑 button.
//
// Two context modes:
//   * "full"     — the whole note is the context; replies can be inserted at
//                  the cursor or replace the whole document.
//   * "selection"— a highlighted fragment is the focus; replies can replace
//                  just that selection or be inserted below it.
//
// Performance: AiPanel and MsgRow are both React.memo'd. App passes stable
// useCallback props so the panel skips re-renders during typing in the editor.
// MsgRow's memo prevents re-rendering older messages when a new token streams
// into the latest assistant reply.

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildSelectionMessages,
  buildSystemPrompt,
  chatStream,
  isAiConfigured,
  resolveActiveModel,
  type ChatMessage,
} from "../lib/ai";
import { MarkdownText } from "./MarkdownText";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AiIcon, TrashIcon, CloseIcon, ChevronRightIcon } from "./icons";
import type { Settings, Theme, ThinkingStrength } from "../types";

export interface AiPanelHandle {
  /** Ask about the current editor selection (called from the selection toolbar). */
  askSelection: (selection: string, instruction: string, range?: { from: number; to: number } | null) => void;
}

interface Props {
  open: boolean;
  settings: Settings;
  /** Read the current note text (for the system-prompt context). */
  getNote: () => string;
  /** Read the current editor selection text. */
  getSelection: () => string;
  /** Insert AI output at the cursor (full-doc mode). */
  onInsert: (md: string) => void;
  /** Replace the whole note with AI output (full-doc mode). */
  onReplace: (md: string) => void;
  /** Replace the current editor selection with AI output (selection mode). */
  onReplaceSelection: (md: string) => void;
  /** Insert AI output immediately after the current selection. */
  onInsertAfterSelection: (md: string) => void;
  /** Turn an assistant reply into an annotation. The panel awaits this so it
   *  can show a busy state on the clicked message. `anchorText` is the
   *  selection the reply was about (selection mode only); `range` is the
   *  document position captured when that selection was made, so the marker can
   *  be anchored exactly (passed through to addAnnotation). */
  onAnnotate: (reply: string, anchorText?: string, range?: { from: number; to: number } | null) => Promise<void> | void;
  /** Open the settings modal (jumped to from the "not configured" banner). */
  onOpenSettings: () => void;
  /** Apply a settings patch (used by the header model / thinking selectors). */
  onSettingsChange: (patch: Partial<Settings>) => void;
  /** 关闭 AI 面板（顶部 ✕ 按钮）。 */
  onClose: () => void;
}

type Role = "user" | "assistant";
type CtxMode = "full" | "selection";

interface Msg {
  /** Stable identity (monotonic counter). Used as React key so reaching the
   *  MAX_MESSAGES cap (which slices the front of the array) doesn't shift every
   *  remaining index and remount all MsgRows — that would trigger an O(N) burst
   *  of Vditor.preview rebuilds (highlight + KaTeX DOM) on each new message. */
  id: number;
  role: Role;
  content: string;
  /** Which context this turn operated on (drives the action buttons). */
  mode: CtxMode;
  /** The selection text, when mode === "selection" (kept so the tag can show). */
  selection?: string;
  /** The selection's document positions {from,to}, captured when the user asked
   *  about it so the「批注」action can anchor the marker exactly (selection mode
   *  only). Stale once the document is edited; addAnnotation re-validates it. */
  range?: { from: number; to: number };
  /** True while this assistant message is still streaming in. */
  streaming?: boolean;
  /** Reasoning / thinking tokens (reasoning models only). Shown in a
   *  collapsible block above the answer: auto-expands while the model thinks,
   *  auto-collapses once the visible answer starts flowing in. */
  reasoning?: string;
}

// Cap the in-memory conversation: each finished assistant reply holds a full
// rendered Markdown DOM subtree (syntax-highlight spans + KaTeX) that React
// keeps mounted. Without a cap, a long AI session grows without bound
// → webview OOM. 100 messages (~50 turns) is plenty for live use; the user can
// clear with 🗑. This also bounds the history sent on the next request.
const MAX_MESSAGES = 100;

export const AiPanel = memo(forwardRef<AiPanelHandle, Props>(function AiPanel(
  { open, settings, getNote, getSelection, onInsert, onReplace, onReplaceSelection, onInsertAfterSelection, onAnnotate, onOpenSettings, onSettingsChange, onClose },
  ref
) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Id of the assistant message currently being refined into an annotation
  // (shows a busy hint on its "批注" button). -1 when idle. Tracked by stable
  // message id (not array index) so the hint stays on the right row even if the
  // list is sliced at the MAX_MESSAGES cap mid-operation.
  const [annotatingId, setAnnotatingId] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<{ cancel: () => void } | null>(null);
  // Last selection the user asked about, so a follow-up free-form question in
  // the same session keeps the selection context until they clear it.
  const activeSelectionRef = useRef<string>("");

  // Pending streaming deltas are batched via requestAnimationFrame. SSE feeds
  // 30-100 chunks/sec; calling setMessages per chunk piles up React updates
  // and GC pressure on long replies → webview OOM. We accumulate deltas in a
  // ref and flush once per animation frame, capping the update rate regardless
  // of how fast the server emits tokens.
  //
  // T3: deltas accumulate in a string[] buffer and are joined on flush, instead
  // of repeatedly string-concatenating the whole reply (O(n²) alloc + GC on a
  // long answer). Each chunk is a small append; join only happens once/frame.
  const pendingDeltaRef = useRef<string[]>([]);
  // Reasoning deltas share the same rAF batching pipeline as content deltas
  // (one flush per frame regardless of how many tokens arrive), so a reasoning
  // model's high token rate never causes per-chunk setState. See flushDelta.
  const pendingReasoningRef = useRef<string[]>([]);
  const rafIdRef = useRef<number | null>(null);
  // Monotonic counter minting stable message ids (see Msg.id).
  const msgIdRef = useRef(0);

  const flushDelta = useCallback(() => {
    rafIdRef.current = null;
    const hasContent = pendingDeltaRef.current.length > 0;
    const hasReasoning = pendingReasoningRef.current.length > 0;
    if (!hasContent && !hasReasoning) return;
    const contentDelta = hasContent ? pendingDeltaRef.current.join("") : "";
    const reasoningDelta = hasReasoning ? pendingReasoningRef.current.join("") : "";
    pendingDeltaRef.current = [];
    pendingReasoningRef.current = [];
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].role === "assistant" && next[i].streaming) {
          next[i] = {
            ...next[i],
            content: hasContent ? next[i].content + contentDelta : next[i].content,
            reasoning: hasReasoning
              ? (next[i].reasoning ?? "") + reasoningDelta
              : next[i].reasoning,
          };
          break;
        }
      }
      return next;
    });
  }, []);

  // Refine an assistant reply into an annotation. Sets a busy hint on the
  // clicked message while the (async) refinement + insertion runs in App.
  const handleAnnotate = useCallback(
    async (id: number, reply: string, anchorText?: string, range?: { from: number; to: number } | null) => {
      setAnnotatingId(id);
      try {
        await onAnnotate(reply, anchorText, range);
      } finally {
        setAnnotatingId(-1);
      }
    },
    [onAnnotate]
  );

  // Auto-scroll to the latest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading]);

  // Reset the conversation whenever the panel is reopened.
  useEffect(() => {
    if (open) {
      setMessages([]);
      setError("");
      setInput("");
      activeSelectionRef.current = "";
    }
  }, [open]);

  // Tear down any in-flight stream on unmount / close.
  useEffect(() => {
    if (!open) {
      streamRef.current?.cancel();
      streamRef.current = null;
      setLoading(false);
    }
  }, [open]);

  // Hard teardown on actual unmount: cancel a pending stream-flush rAF and any
  // in-flight stream (which owns 3 global Tauri event listeners). The effect
  // above only fires on `open` changes; if the panel is removed from the tree
  // while a stream is active, those would otherwise orphan and keep capturing
  // React state setters + the requestId closure forever.
  useEffect(() => {
    return () => {
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      streamRef.current?.cancel();
      streamRef.current = null;
    };
  }, []);

  const configured = isAiConfigured(settings);

  const fullActions = useMemo(
    () => settings.aiQuickActions.filter((a) => a.scope === "full"),
    [settings.aiQuickActions]
  );

  // T2: dynamic-height virtual scrolling for the message list. Each finished
  // assistant reply is a full Markdown DOM (syntax-highlight spans + KaTeX), so
  // a long session mounts a lot of DOM. We render only the visible rows + an
  // overscan; off-screen rows unmount and re-hit the renderMarkdown LRU (T1)
  // when scrolled back. Dynamic measurement (measureElement) handles the
  // variable heights of code blocks / formulas / streaming replies.
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 160,
    overscan: 6,
    // Preserve the original 12px inter-message spacing; matches .ai-msgs gap.
    gap: 12,
    // Stable per-row key so recycling keeps component state on the right msg.
    getItemKey: (index) => messages[index].id,
  });

  // ---- the core send routine, shared by free-form input, quick actions, and
  // ---- selection-bar invocations. `mode` decides the system prompt shape and
  // ---- which write-back actions attach to the assistant reply.
  const send = async (
    raw: string,
    opts: { mode: CtxMode; selection?: string; range?: { from: number; to: number } | null } = { mode: "full" }
  ) => {
    const text = raw.trim();
    if (!text || loading) return;
    if (!configured) {
      setError("请先在「设置 → AI」中填写 Base URL、API Key 和模型。");
      return;
    }
    setError("");

    const selection = opts.selection ?? (opts.mode === "selection" ? activeSelectionRef.current : "");
    // Carry the selection's document positions onto the AI turn so the「批注」
    // action can re-anchor the marker exactly (selection mode only). Undefined
    // in full mode or when no range was captured.
    const range = opts.mode === "selection" ? opts.range ?? undefined : undefined;
    const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let history: ChatMessage[];
    if (opts.mode === "selection" && selection) {
      history = buildSelectionMessages({
        instruction: text,
        selection,
        noteContext: getNote(),
        systemPromptOverride: settings.aiSystemPrompt,
      });
      activeSelectionRef.current = selection;
    } else {
      history = [
        { role: "system", content: buildSystemPrompt(getNote(), settings.aiSystemPrompt) },
        ...messages
          .filter((m) => !m.streaming)
          .map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
        { role: "user", content: text },
      ];
      if (opts.mode === "full") activeSelectionRef.current = "";
    }

    setMessages((prev) => {
      const next: Msg[] = [
        ...prev,
        { id: ++msgIdRef.current, role: "user", content: text, mode: opts.mode, selection, range },
        // Carry the selection (and its range) onto the assistant message too,
        // so the「批注」action on this reply can anchor the marker on the exact
        // text it was about (m.selection/m.range are read by the 批注 button).
        // Without this the marker always falls back to the cursor and lands at
        // the doc start.
        { id: ++msgIdRef.current, role: "assistant", content: "", mode: opts.mode, selection, range, streaming: true },
      ];
      // Trim oldest messages beyond the cap. The new user+assistant pair is
      // always preserved (they're at the tail). Unmounted MsgRows release their
      // rendered preview DOM via the effect cleanup below.
      return next.length > MAX_MESSAGES
        ? next.slice(next.length - MAX_MESSAGES)
        : next;
    });
    setInput("");
    setLoading(true);

    streamRef.current = chatStream({
      settings,
      messages: history,
      requestId,
      handlers: {
        onChunk: (delta) => {
          if (delta) pendingDeltaRef.current.push(delta);
          if (rafIdRef.current == null) {
            rafIdRef.current = requestAnimationFrame(flushDelta);
          }
        },
        onReasoning: (delta) => {
          if (delta) pendingReasoningRef.current.push(delta);
          // 复用同一条 rAF 管线：reasoning 与 content 共享一次 flush，禁止 per-chunk setState。
          if (rafIdRef.current == null) {
            rafIdRef.current = requestAnimationFrame(flushDelta);
          }
        },
        onDone: () => {
          // Flush any buffered deltas before flipping streaming=false,
          // so the final content includes the last batch of tokens.
          if (rafIdRef.current != null) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
          }
          if (pendingDeltaRef.current.length > 0 || pendingReasoningRef.current.length > 0) {
            flushDelta();
          }
          setMessages((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i].role === "assistant" && next[i].streaming) {
                next[i] = { ...next[i], streaming: false };
                // Drop an empty assistant reply entirely (e.g. cancelled);
                // keep one that only has reasoning (model thought but didn't answer).
                if (!next[i].content && !next[i].reasoning) next.splice(i, 1);
                break;
              }
            }
            return next;
          });
          setLoading(false);
          streamRef.current = null;
        },
        onError: (err) => {
          // Flush buffered deltas so partial content is preserved in the
          // error-stranded assistant message.
          if (rafIdRef.current != null) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
          }
          if (pendingDeltaRef.current.length > 0 || pendingReasoningRef.current.length > 0) {
            flushDelta();
          }
          setError(err);
          setMessages((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i].role === "assistant" && next[i].streaming) {
                // Remove the empty placeholder; keep partial content/reasoning.
                if (!next[i].content && !next[i].reasoning) next.splice(i, 1);
                else next[i] = { ...next[i], streaming: false };
                break;
              }
            }
            return next;
          });
          setLoading(false);
          streamRef.current = null;
        },
      },
    });
  };

  const stop = () => {
    streamRef.current?.cancel();
    streamRef.current = null;
    setLoading(false);
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].role === "assistant" && next[i].streaming) {
          if (!next[i].content && !next[i].reasoning) next.splice(i, 1);
          else next[i] = { ...next[i], streaming: false };
          break;
        }
      }
      return next;
    });
  };

  const clearChat = () => {
    streamRef.current?.cancel();
    streamRef.current = null;
    setMessages([]);
    setError("");
    setInput("");
    activeSelectionRef.current = "";
  };

  // Keep a ref to the latest `send` so the imperative handle below can stay
  // stable (empty deps) instead of rebuilding every turn. Without this, every
  // chat message makes `askSelection` a new function — harmless, but the
  // selection toolbar's poll loop (App.tsx) re-resolves it needlessly.
  const sendRef = useRef(send);
  sendRef.current = send;

  // Imperative entry from the selection toolbar.
  useImperativeHandle(
    ref,
    (): AiPanelHandle => ({
      askSelection: (selection, instruction, range) => {
        sendRef.current(instruction, { mode: "selection", selection, range });
      },
    }),
    // sendRef is stable; the handle never needs to be recreated.
    []
  );

  if (!open) return null;

  return (
    <div className="ai-panel">
      <div className="ai-head">
        <span className="ai-title"><AiIcon size={14} className="ai-title-icon" /> AI 助手</span>
        <div className="ai-head-actions">
          <button
            className="ai-clear-btn"
            title="清空对话"
            onClick={clearChat}
            disabled={loading || messages.length === 0}
          >
            <TrashIcon size={14} />
          </button>
          <select
            className="ai-model-select"
            title={resolveActiveModel(settings).baseUrl || "未配置"}
            value={settings.aiActiveModelId}
            onChange={(e) => onSettingsChange({ aiActiveModelId: e.target.value })}
          >
            {settings.aiModels.length === 0 && <option value="">未配置</option>}
            {settings.aiModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name?.trim() || m.model || "未命名模型"}
              </option>
            ))}
          </select>
          <select
            className="ai-thinking-select"
            title="思考强度（仅推理型模型生效）"
            value={settings.aiThinkingStrength}
            onChange={(e) =>
              onSettingsChange({
                aiThinkingStrength: e.target.value as ThinkingStrength,
              })
            }
          >
            <option value="off">思考:关</option>
            <option value="low">思考:低</option>
            <option value="medium">思考:中</option>
            <option value="high">思考:高</option>
          </select>
          <button
            className="ai-close-btn"
            title="关闭 AI 面板 (Ctrl+I)"
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </div>
      </div>

      {!configured && (
        <div className="ai-banner">
          尚未配置 AI。<button onClick={onOpenSettings}>去设置</button>
        </div>
      )}

      {activeSelectionRef.current && (
        <div className="ai-ctx-banner" title={activeSelectionRef.current}>
          当前针对「选中片段」回答。
          <button
            className="ai-ctx-clear"
            onClick={() => {
              activeSelectionRef.current = "";
            }}
          >
            回到全文
          </button>
        </div>
      )}

      {fullActions.length > 0 && (
        <div className="ai-quick">
          {fullActions.map((q) => (
            <button
              key={q.label}
              className="ai-quick-btn"
              disabled={loading}
              onClick={() => void send(q.prompt)}
              title={q.prompt}
            >
              {q.label}
            </button>
          ))}
        </div>
      )}

      <div className="ai-msgs" ref={scrollRef}>
        {messages.length === 0 && !loading && (
          <div className="ai-empty">
            问任何关于这篇笔记的问题，或试试上方的快捷操作。
            <br />
            选中文字可针对片段提问 / 改写 / 翻译。
            <br />
            例如：「这篇笔记的要点是什么？」「把第二段改得更简洁。」
          </div>
        )}
        {messages.length > 0 && (
          <div
            className="ai-msgs-virtual"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const m = messages[vi.index];
              return (
                <div
                  key={m.id}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  className="ai-msgs-row"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <MsgRow
                    msg={m}
                    theme={settings.theme}
                    onInsert={() => onInsert(m.content)}
                    onReplace={() => {
                      if (confirm("用这条 AI 回复替换当前笔记全部内容？")) onReplace(m.content);
                    }}
                    onReplaceSelection={() => onReplaceSelection(m.content)}
                    onInsertAfterSelection={() => onInsertAfterSelection(m.content)}
                    onAnnotate={() => void handleAnnotate(m.id, m.content, m.selection, m.range)}
                    annotating={annotatingId === m.id}
                    onCopy={() => navigator.clipboard?.writeText(m.content)}
                  />
                </div>
              );
            })}
          </div>
        )}
        {loading && messages.every((m) => !(m.role === "assistant" && m.streaming)) && (
          <div className="ai-msg ai-msg-assistant ai-typing">正在思考…</div>
        )}
        {error && <div className="ai-error">{error}</div>}
      </div>

      <div className="ai-input-row">
        <textarea
          className="ai-input"
          placeholder={
            activeSelectionRef.current
              ? "针对选中片段提问，Enter 发送，Shift+Enter 换行"
              : "输入问题，Enter 发送，Shift+Enter 换行"
          }
          value={input}
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        {loading ? (
          <button className="ai-send ai-stop-btn" onClick={stop}>
            停止
          </button>
        ) : (
          <button
            className="ai-send"
            disabled={!input.trim()}
            onClick={() => void send(input)}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}));

// ---- single message row ----------------------------------------------------

interface MsgRowProps {
  msg: Msg;
  /** App theme, to pick Vditor's light/dark content theme for the preview. */
  theme: Theme;
  onInsert: () => void;
  onReplace: () => void;
  onReplaceSelection: () => void;
  onInsertAfterSelection: () => void;
  onAnnotate: () => void;
  /** True while this reply is being refined into an annotation. */
  annotating: boolean;
  onCopy: () => void;
}

// 思考阶段动效占位：reasoning 不可用（非推理模型 / 首字未到）时显示三点跳动
// + 计时文案。组件自持 setInterval(200ms)，卸载即清——不会让父组件或老消息
// 随计时器重渲染（满足"新动画不得导致老消息重渲染"的全局约束）。
const ThinkingDots = memo(function ThinkingDots() {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    setMs(0);
    const id = window.setInterval(() => setMs(Date.now() - start), 200);
    return () => window.clearInterval(id);
  }, []);
  const secs = Math.floor(ms / 1000);
  return (
    <div className="ai-msg-content ai-thinking-placeholder">
      <span className="ai-typing-dots" aria-hidden="true">
        <i></i>
        <i></i>
        <i></i>
      </span>
      <span className="ai-thinking-label">
        {secs > 8 ? "深度思考中…" : `思考中 · ${secs}s`}
      </span>
    </div>
  );
});

const MsgRow = memo(function MsgRow({
  msg,
  theme,
  onInsert,
  onReplace,
  onReplaceSelection,
  onInsertAfterSelection,
  onAnnotate,
  annotating,
  onCopy,
}: MsgRowProps) {
  const isAssistant = msg.role === "assistant";
  const hasContent = msg.content.length > 0;
  const hasReasoning = !!(msg.reasoning && msg.reasoning.length > 0);

  // 思考过程折叠态：reasoning 首次有内容时自动展开，正文开始流入时自动折叠，
  // 之后交给用户手动控制。用 ref 追踪上一次的空/非空状态以检测"首次到达"，
  // 避免每帧都触发 setReasoningOpen。
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const prevReasoningEmpty = useRef(true);
  const prevContentEmpty = useRef(true);
  useEffect(() => {
    const reasoningEmpty = !hasReasoning;
    const contentEmpty = !hasContent;
    // reasoning 刚开始流入 → 展开，让用户实时看到思考
    if (prevReasoningEmpty.current && !reasoningEmpty) setReasoningOpen(true);
    // 正文刚开始流入 → 折叠思考过程，把焦点让给正文
    if (prevContentEmpty.current && !contentEmpty) setReasoningOpen(false);
    prevReasoningEmpty.current = reasoningEmpty;
    prevContentEmpty.current = contentEmpty;
  }, [hasReasoning, hasContent]);

  if (!isAssistant) {
    return (
      <div className="ai-msg ai-msg-user">
        <div className="ai-msg-content">{msg.content}</div>
      </div>
    );
  }

  return (
    <div className="ai-msg ai-msg-assistant">
      {msg.mode === "selection" && (
        <span className="ai-ctx-tag">选区上下文</span>
      )}
      {/* 思考过程（推理模型）：正文上方可折叠区。纯文本渲染，不复用重型
          MarkdownText，避免 KaTeX / 语法高亮的 DOM 与内存开销。 */}
      {hasReasoning && (
        <div className="ai-reasoning-wrap">
          <button
            className="ai-reasoning-toggle"
            onClick={() => setReasoningOpen((o) => !o)}
            aria-expanded={reasoningOpen}
          >
            <span>思考过程</span>
            <span className="ai-reasoning-caret">
              <ChevronRightIcon size={11} className={`chevron${reasoningOpen ? " open" : ""}`} />
            </span>
          </button>
          {reasoningOpen && (
            <div className="ai-reasoning-body">{msg.reasoning}</div>
          )}
        </div>
      )}
      {msg.streaming ? (
        hasContent ? (
          // 正文流入中：纯文本 + 闪烁光标（streaming 结束后因条件渲染自动移除）
          <div className="ai-msg-content ai-streaming">
            {msg.content}
            <span className="ai-cursor" aria-hidden="true">▍</span>
          </div>
        ) : hasReasoning ? null : (
          // 既无正文也无思考内容：动效占位。首字（content/reasoning 任一）到达后
          // 条件翻转，ThinkingDots 卸载，自带的计时器随之清除。
          <ThinkingDots />
        )
      ) : hasContent ? (
        <MarkdownText
          content={msg.content}
          theme={theme}
          className="ai-msg-content"
        />
      ) : null}
      {!msg.streaming && hasContent && (
        <div className="ai-actions">
          {msg.mode === "selection" ? (
            <>
              <button onClick={onReplaceSelection} title="用这条回复替换编辑器中选中的文字">
                替换选区
              </button>
              <button onClick={onInsertAfterSelection} title="在选中文字下方插入这条回复">
                插入到选区下方
              </button>
            </>
          ) : (
            <>
              <button onClick={onInsert}>插入到光标</button>
              <button onClick={onReplace}>替换全文</button>
            </>
          )}
          <button
            onClick={onAnnotate}
            disabled={annotating}
            className={annotating ? "busy" : ""}
            title="把这条回复精炼成一条批注，挂在选中文字上（或在光标处）"
          >
            {annotating ? "精炼中…" : "批注"}
          </button>
          <button onClick={onCopy}>复制</button>
        </div>
      )}
    </div>
  );
});
