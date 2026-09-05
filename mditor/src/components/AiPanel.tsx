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
//                  the cursor or, for rewrite-type replies, reviewed hunk-by-
//                  hunk before replacing the document (改动预览).
//   * "selection"— a highlighted fragment is the focus; replies can replace
//                  just that selection (also via 改动预览) or be inserted
//                  below it.
//
// Follow-ups (追问): every assistant reply carries a「追问」button. A follow-up
// hangs under the answer it targets (Msg.parentId), rendered as an indented
// thread; its request history is the targeted thread chain (lib/aiThread), not
// the whole chat. Threads nest arbitrarily deep and one answer can carry
// several parallel follow-up threads.
//
// Rewrite safety: 润色/改写/纠错 replies never replace the document directly —
// the「审查改动」action diffs the reply against the target text and shows the
// DiffReview panel (per-hunk accept/reject, jump-to-context, one-shot apply
// that lands as a single undo step).
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
  buildFormatFixMessages,
  buildHistoryWithBudget,
  buildSelectionMessages,
  buildSystemPrompt,
  chatStream,
  embedTexts,
  estimateTokens,
  isAiConfigured,
  isEmbedConfigured,
  resolveActiveModel,
  type ChatMessage,
} from "../lib/ai";
import { buildThreadHistory } from "../lib/aiThread";
import { applyHunks, diffText, unwrapWholeFence, type DiffHunk } from "../lib/diff";
import { MarkdownText } from "./MarkdownText";
import { DiffReview } from "./DiffReview";
import { AgentPlanReview } from "./AgentPlanReview";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useDelayedUnmount } from "../hooks/useDelayedUnmount";
import { AiIcon, TrashIcon, CloseIcon, ChevronRightIcon } from "./icons";
import { buildRagMessages, RAG_TOP_K, toSources, type RagSource } from "../lib/rag";
import { ragIndex } from "../lib/ragIndex";
import { vaultIndex } from "../lib/vaultIndex";
import { confirmDialog } from "../lib/dialogs";
import { runAgent } from "../lib/agent/loop";
import { applyChangePlan, type ApplyPlanOutcome } from "../lib/agent/apply";
import { CURRENT_KEY, TOOL_BY_NAME, normPath, type ToolContext } from "../lib/agent/tools";
import { emptyPlan, type AgentTimelineItem, type ChangePlan, type ToolCallRecord } from "../lib/agent/types";
import type { TreeChange } from "./FileTree";
import type { Settings, Theme, ThinkingStrength } from "../types";

export interface AiPanelHandle {
  /** Ask about the current editor selection (called from the selection toolbar). */
  askSelection: (selection: string, instruction: string, range?: { from: number; to: number } | null) => void;
  /** Trigger the built-in 一键修复格式 action (menu / Ctrl+Alt+F entry). */
  fixFormat: () => void;
}

/** A pending 改动预览（AI 修改类回复的应用前审查）。 */
export interface ReviewState {
  mode: "full" | "selection";
  /** 审查的目标原文（全文或选区文本）。 */
  original: string;
  /** AI 修订文本（已去整体围栏）。 */
  revised: string;
  hunks: DiffHunk[];
  /** decisions[i] === true 表示接受第 i 处。 */
  decisions: boolean[];
  /** 选区模式：捕获的文档区间（应用时校验，失效则按内容回退定位）。 */
  range: { from: number; to: number } | null;
}

/** 一次改动审查的应用请求（交给 App 落盘）。 */
export interface ApplyChangesPayload {
  mode: "full" | "selection";
  range: { from: number; to: number } | null;
  original: string;
  merged: string;
}

interface Props {
  open: boolean;
  settings: Settings;
  /** Read the current note text (for the system-prompt context). */
  getNote: () => string;
  /** 当前笔记的磁盘绝对路径（null = 未命名）——Agent 工具的当前笔记锚点（v4.9）。 */
  getNotePath: () => string | null;
  /** 工作区根列表（Agent 检索/文件操作的安全边界基准，v4.9）。 */
  workspaces: string[];
  /** Insert AI output at the cursor (full-doc mode) — one undo step. */
  onInsert: (md: string) => void;
  /** Insert AI output immediately after the current selection. */
  onInsertAfterSelection: (md: string) => void;
  /** Apply an accepted 改动预览（一步撤销的写回，见 Editor.aiWriteDoc/aiWriteRange）。 */
  onApplyChanges: (payload: ApplyChangesPayload) => void;
  /** Jump the editor to a hunk's original text (查看上下文). */
  onJumpToText: (needle: string) => void;
  /** Turn an assistant reply into an annotation. The panel awaits this so it
   *  can show a busy state on the clicked message. `anchorText` is the
   *  selection the reply was about (selection mode only); `range` is the
   *  document position captured when that selection was made, so the marker can
   *  be anchored exactly (passed through to addAnnotation). */
  onAnnotate: (reply: string, anchorText?: string, range?: { from: number; to: number } | null) => Promise<void> | void;
  /** Open the settings modal (jumped to from the "not configured" banner). */
  onOpenSettings: () => void;
  /** 全库问答（v4.7 模块 5）：打开来源笔记并尽量跳到对应标题。 */
  onOpenNote: (path: string, heading?: string) => void;
  /** Apply a settings patch (used by the header model / thinking selectors). */
  onSettingsChange: (patch: Partial<Settings>) => void;
  /** 关闭 AI 面板（顶部 ✕ 按钮）。 */
  onClose: () => void;
  /** Agent 应用 FS 操作后的变更通知（复用 App 的 FileTree TreeChange 处理，v4.9）。 */
  onTreeChange?: (change: TreeChange) => void;
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
  /** （用户消息）全库问答模式标记（渲染模式 chip）。 */
  rag?: boolean;
  /** （回答）全库问答的来源块列表（可点击跳转对应笔记）。 */
  sources?: RagSource[];
  /** Which context this turn operated on (drives the action buttons). */
  mode: CtxMode;
  /** The selection text, when mode === "selection" (kept so the tag can show). */
  selection?: string;
  /** （v3.9 划选追问）本条追问显式引用的回答片段：渲染为引用条，并作为
   *  <quote> 块随请求发送 —— 追问历史沿线程链自然携带它。 */
  quote?: string;
  /** The selection's document positions {from,to}, captured when the user asked
   *  about it so the「批注」action can anchor the marker exactly (selection mode
   *  only). Stale once the document is edited; addAnnotation re-validates it. */
  range?: { from: number; to: number };
  /** 追问：本条消息挂在哪条 AI 回答之下（根层消息无此字段）。同一条回答可挂
   *  多条并行追问；追问的回答也可继续被追问（多层嵌套）。 */
  parentId?: number;
  /** （assistant）本条回答回复的是哪条用户消息——追问历史沿
   *  parentId×repliedUser 链回溯到线程根（lib/aiThread）。 */
  repliedUser?: number;
  /** True while this assistant message is still streaming in. */
  streaming?: boolean;
  /** Reasoning / thinking tokens (reasoning models only). Shown in a
   *  collapsible block above the answer: auto-expands while the model thinks,
   *  auto-collapses once the visible answer starts flowing in. */
  reasoning?: string;
  /** （v4.9 Agent）时间线：文本段与工具卡片按发生顺序穿插。存在时正文渲染
   *  走时间线而非 content（content 仅在回合结束时结算为纯文本，供插入/
   *  复制/追问等动作使用）。 */
  timeline?: AgentTimelineItem[];
  /** （v4.9 Agent）本条用户消息走 Agent 链路（渲染模式 chip）。 */
  agent?: boolean;
}

// Cap the in-memory conversation: each finished assistant reply holds a full
// rendered Markdown DOM subtree (syntax-highlight spans + KaTeX) that React
// keeps mounted. Without a cap, a long AI session grows without bound
// → webview OOM. 100 messages (~50 turns) is plenty for live use; the user can
// clear with 🗑. This also bounds the history sent on the next request.
const MAX_MESSAGES = 100;

export const AiPanel = memo(forwardRef<AiPanelHandle, Props>(function AiPanel(
  { open, settings, getNote, getNotePath, workspaces, onInsert, onInsertAfterSelection, onApplyChanges, onJumpToText, onAnnotate, onOpenSettings, onOpenNote, onSettingsChange, onClose, onTreeChange },
  ref
) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // ---- 全库问答（v4.7 模块 5）-----------------------------------------------
  const [ragOn, setRagOn] = useState(false);
  const [ragStats, setRagStats] = useState(() => ragIndex.stats());
  useEffect(() => {
    const un = ragIndex.subscribe(() => setRagStats(ragIndex.stats()));
    setRagStats(ragIndex.stats());
    return un;
  }, []);
  /** 面板内轻提示（审查应用成功等），下一次发送/清空时消失。 */
  const [notice, setNotice] = useState("");
  /** 当前展开追问输入框的回答 id（-1 = 无）。 */
  const [followUpFor, setFollowUpFor] = useState(-1);
  /** 追问输入框草稿（挂在 AiPanel 层而非 MsgRow：虚拟列表回收行时草稿
   *  不丢失、不串行 —— 行卸载只是看不见，回来继续编辑）。 */
  const [followUpDraft, setFollowUpDraft] = useState("");
  /** 划选追问携带的引用片段（「追问这段」入口写入；普通「追问」为 null）。 */
  const [followUpQuote, setFollowUpQuote] = useState<string | null>(null);
  /** 本会话 token 用量（本地估算，仅展示）：输入累计 / 输出累计。 */
  const [usage, setUsage] = useState<{ input: number; output: number }>({ input: 0, output: 0 });
  /** 流式输出累计（flushDelta 写入；完成/出错/停止时结算进 usage）。 */
  const streamOutRef = useRef("");
  /** 进行中的改动预览（非空时面板切换为审查视图）。 */
  const [review, setReview] = useState<ReviewState | null>(null);
  // ---- Agent 链路（v4.9）-----------------------------------------------------
  /** Agent 模式进行中请求的中止器（「停止」按钮触发）。 */
  const agentAbortRef = useRef<AbortController | null>(null);
  /** Agent 改动清单审阅（非空时面板切换为清单视图）。 */
  const [agentReview, setAgentReview] = useState<{
    plan: ChangePlan;
    decisions: Record<string, boolean>;
  } | null>(null);
  // Agent 回合中工具卡片/时间线的更新走 ref 镜像，保持回调稳定。
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const getNotePathRef = useRef(getNotePath);
  getNotePathRef.current = getNotePath;
  // Id of the assistant message currently being refined into an annotation
  // (shows a busy hint on its "批注" button). -1 when idle. Tracked by stable
  // message id (not array index) so the hint stays on the right row even if the
  // list is sliced at the MAX_MESSAGES cap mid-operation.
  const [annotatingId, setAnnotatingId] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 本轮问题的消息 id，作为滚动锚点：回合开始把问题对齐视口顶部，
  // 生成期间不跟随输出滚动，回答结束时回到问题开头。
  const turnAnchorIdRef = useRef<number | null>(null);
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
  // Mirror of `messages` for stable callbacks (submitFollowUp reads the live
  // list without rebuilding its identity every turn — keeps MsgRow memo valid).
  const messagesRef = useRef<Msg[]>([]);
  messagesRef.current = messages;
  // 一键修复格式：流式成功完成后待自动打开改动预览的回复 id。只在 onDone
  // 里写入 —— 出错 / 手动停止的半截回复不触发（其 diff 会显示大片误删）。
  const autoReviewIdRef = useRef<number | null>(null);

  const flushDelta = useCallback(() => {
    rafIdRef.current = null;
    const hasContent = pendingDeltaRef.current.length > 0;
    const hasReasoning = pendingReasoningRef.current.length > 0;
    if (!hasContent && !hasReasoning) return;
    const contentDelta = hasContent ? pendingDeltaRef.current.join("") : "";
    const reasoningDelta = hasReasoning ? pendingReasoningRef.current.join("") : "";
    pendingDeltaRef.current = [];
    pendingReasoningRef.current = [];
    streamOutRef.current += contentDelta;
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].role === "assistant" && next[i].streaming) {
          // Agent 消息：正文进时间线（与工具卡片按发生顺序穿插），不进 content
          // ——content 只在回合结束时结算为纯文本供插入/复制/追问使用。
          if (next[i].timeline) {
            const tl: AgentTimelineItem[] = [...(next[i].timeline ?? [])];
            if (hasContent) {
              const last = tl[tl.length - 1];
              if (last && last.type === "text") {
                tl[tl.length - 1] = { type: "text", text: last.text + contentDelta };
              } else {
                tl.push({ type: "text", text: contentDelta });
              }
            }
            next[i] = {
              ...next[i],
              timeline: tl,
              reasoning: hasReasoning
                ? (next[i].reasoning ?? "") + reasoningDelta
                : next[i].reasoning,
            };
          } else {
            next[i] = {
              ...next[i],
              content: hasContent ? next[i].content + contentDelta : next[i].content,
              reasoning: hasReasoning
                ? (next[i].reasoning ?? "") + reasoningDelta
                : next[i].reasoning,
            };
          }
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

  // 滚动锚定：以「本轮问题」为锚。回合开始（loading 翻转为 true，与新增
  // 消息同批提交）把问题行对齐到视口顶部；流式生成期间完全不滚动——长回答
  // 不再把视图一直拽向底部，生成中可自由回看历史；回答结束（完成/出错/停止，
  // loading 翻转为 false）再次对齐问题开头，方便从头阅读整段回答。
  // 锚点行的偏移只取决于其上方的行（均已定稿），流式帧不会使其抖动。
  useEffect(() => {
    const anchorId = turnAnchorIdRef.current;
    if (anchorId == null) return;
    const idx = rows.findIndex((r) => r.msg.id === anchorId);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "start" });
    // 仅依赖 loading 的翻转沿（回合开始/结束）；流式帧引起的 messages
    // 变化不触发滚动。rows/virtualizer 经闭包读取最新值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // Reset the conversation whenever the panel is reopened.
  useEffect(() => {
    if (open) {
      setMessages([]);
      setError("");
      setNotice("");
      setInput("");
      setFollowUpFor(-1);
      setFollowUpDraft("");
      setFollowUpQuote(null);
      setUsage({ input: 0, output: 0 });
      streamOutRef.current = "";
      setReview(null);
      setAgentReview(null);
      // 精炼流挂起（invoke 永不落地）时 handleAnnotate 的 finally 不会执行，
      // 复位防「批注」按钮永久停在“精炼中…”禁用态。
      setAnnotatingId(-1);
      activeSelectionRef.current = "";
    }
  }, [open]);

  // Tear down any in-flight stream on unmount / close.
  useEffect(() => {
    if (!open) {
      agentAbortRef.current?.abort();
      agentAbortRef.current = null;
      streamRef.current?.cancel();
      streamRef.current = null;
      setLoading(false);
      setAnnotatingId(-1);
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
      agentAbortRef.current?.abort();
      agentAbortRef.current = null;
      streamRef.current?.cancel();
      streamRef.current = null;
    };
  }, []);

  const configured = isAiConfigured(settings);
  /** Agent 模式（v4.9）：面板顶部「对话 | Agent」分段开关的当前档。 */
  const agentMode = settings.aiPanelMode === "agent";

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
  //
  // 追问层级（DFS 展开）：消息按「根层顺序 + 每条回答下挂的追问子树」排布，
  // 每行携带 depth 供缩进渲染。消息数组本身保持追加序（流式更新只碰末尾），
  // 展示序是纯派生——MAX_MESSAGES 截断掉的祖先会被当作根层优雅降级。
  const rows = useMemo(() => {
    const byId = new Map<number, Msg>();
    for (const m of messages) byId.set(m.id, m);
    const childrenOf = new Map<number, Msg[]>();
    const roots: Msg[] = [];
    for (const m of messages) {
      const p = m.parentId != null ? byId.get(m.parentId) : undefined;
      if (p && p.role === "assistant") {
        const list = childrenOf.get(p.id);
        if (list) list.push(m);
        else childrenOf.set(p.id, [m]);
      } else {
        roots.push(m);
      }
    }
    const out: Array<{ msg: Msg; depth: number }> = [];
    const walk = (m: Msg, depth: number) => {
      out.push({ msg: m, depth });
      if (m.role === "assistant") {
        for (const c of childrenOf.get(m.id) ?? []) walk(c, depth + 1);
      }
    };
    for (const r of roots) walk(r, 0);
    return out;
  }, [messages]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 160,
    overscan: 6,
    // Preserve the original 12px inter-message spacing; matches .ai-msgs gap.
    gap: 12,
    // Stable per-row key so recycling keeps component state on the right msg.
    getItemKey: (index) => rows[index].msg.id,
  });

  // ---- the core send routine, shared by free-form input, quick actions,
  // ---- selection-bar invocations and 追问. `mode` decides the system prompt
  // ---- shape and which write-back actions attach to the assistant reply;
  // ---- `parent` (追问) targets a specific answer: the new turn hangs under
  // ---- it and its request history is that thread's chain, not the whole chat;
  // ---- `quote` (v3.9 划选追问) carries the explicitly-selected fragment of
  // ---- the targeted answer as a <quote> block; `preset` (v4.5 一键修复格式)
  // ---- supplies pre-built request messages and skips history assembly /
  // ---- truncation entirely (full-document contract).
  const send = async (
    raw: string,
    opts: {
      mode: CtxMode;
      selection?: string;
      range?: { from: number; to: number } | null;
      /** 追问目标（被追问的那条回答）。 */
      parent?: Msg;
      /** 划选追问引用的回答片段。 */
      quote?: string;
      /** 内置动作（一键修复格式）：预组装请求消息；autoReview 时成功完成后
       *  自动打开该条回复的改动预览。 */
      preset?: { messages: ChatMessage[]; autoReview?: boolean };
      /** 全库问答（v4.7 模块 5）：本回合的来源块（挂在回答消息上）。 */
      ragSources?: RagSource[];
    } = { mode: "full" }
  ) => {
    const text = raw.trim();
    if (!text || loading) return;
    if (!configured) {
      setError("请先在「设置 → AI」中填写 Base URL、API Key 和模型。");
      return;
    }
    setError("");
    setNotice("");

    // Agent 模式（v4.9）：全文问答 / 快捷指令走 runAgent 工具循环。选区、
    // 追问、内置动作（一键修复等 preset）保持普通对话行为不变。
    if (agentMode && opts.mode === "full" && !opts.preset && !opts.parent) {
      await sendAgent(text);
      return;
    }

    // ---- 全库问答（v4.7 模块 5）：问题 → 嵌入 → 余弦 top-k → 上下文消息。
    // 追问（parent）走线程链携带上下文，不重新检索；失败静默回退普通全文
    // 模式（铁律：不阻塞交互）。
    let ragSources = opts.ragSources;
    if (ragOn && !opts.preset && !opts.parent) {
      if (!settings.ragEnabled || !isEmbedConfigured(settings)) {
        setError("全库问答需先在「设置 → 知识功能」中开启并配置嵌入模型。");
        return;
      }
      if (!ragIndex.isBuilt(settings.ragEmbedModel)) {
        setError("全库向量索引尚未构建——请点击输入框上方的「构建索引」。");
        return;
      }
      try {
        setNotice("正在检索笔记库…");
        const [qvec] = await embedTexts(settings, [text]);
        const hits = ragIndex.search(qvec, RAG_TOP_K);
        ragSources = toSources(hits);
        opts = {
          ...opts,
          mode: "full",
          preset: { messages: buildRagMessages(text, ragSources) },
          ragSources,
        };
        setNotice("");
      } catch (e) {
        // 回退普通对话模式（不上传任何库内容，只带当前笔记）。
        setNotice(`全库检索失败，已回退普通模式：${String(e)}`);
      }
    }

    const parent = opts.parent;
    const quote = opts.quote?.trim() ? opts.quote.trim() : undefined;
    // 追问继承被追问回答的选区上下文；顶层提问维持原行为（显式 selection →
    // 会话选区 → 空）。
    const effSelection =
      opts.selection ??
      (parent
        ? parent.selection
        : opts.mode === "selection"
          ? activeSelectionRef.current
          : "");
    // Carry the selection's document positions onto the AI turn so the「批注」
    // action can re-anchor the marker exactly (selection mode only). Undefined
    // in full mode or when no range was captured.
    const range =
      opts.mode === "selection" ? (opts.range ?? parent?.range ?? undefined) : undefined;
    const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // v3.9 token 降本：笔记按策略截断；历史按 token 预算从后往前保留。
    const strategy: Settings["aiContextStrategy"] =
      settings.aiContextStrategy ?? "standard";
    const budget =
      settings.aiHistoryBudgetTokens > 0 ? settings.aiHistoryBudgetTokens : 8000;
    const userContent = quote
      ? `${text}\n\n<quote>\n${quote}\n</quote>`
      : text;

    let history: ChatMessage[];
    if (opts.preset) {
      // 内置动作（一键修复格式）：请求消息已预组装 —— 全文原文 + 专用提示
      // 词。不掺历史、不经截断 / 预算裁剪：任务契约是「输出完整全文」，任
      // 何裁剪都会让模型只修复文档的一部分。
      history = opts.preset.messages;
      if (opts.mode === "full") activeSelectionRef.current = "";
    } else if (parent) {
      // 追问：沿 parentId×repliedUser 链回溯目标线程，聚焦该线程的上下文；
      // 链同样过 token 预算（长线程丢早期、保最近）。
      const chain = buildHistoryWithBudget(
        buildThreadHistory(messages, parent.id),
        budget
      ).messages;
      if (opts.mode === "selection" && effSelection) {
        // 选区追问不带 note（线程链 + 选区足够）。
        const [sys] = buildSelectionMessages({
          instruction: text,
          selection: effSelection,
          systemPromptOverride: settings.aiSystemPrompt,
        });
        history = [
          sys,
          ...chain,
          {
            role: "user",
            content: `${text}\n\n<selection>\n${effSelection}\n</selection>`,
          },
        ];
      } else {
        history = [
          { role: "system", content: buildSystemPrompt(getNote(), settings.aiSystemPrompt, strategy) },
          ...chain,
          { role: "user", content: userContent },
        ];
      }
    } else if (opts.mode === "selection" && effSelection) {
      history = buildSelectionMessages({
        instruction: text,
        selection: effSelection,
        noteContext: getNote(),
        systemPromptOverride: settings.aiSystemPrompt,
        strategy,
      });
      activeSelectionRef.current = effSelection;
    } else {
      // 顶层全文问答：全部历史 + 新问题按 token 预算裁剪（本地估算，
      // 零额外请求）；最近的问答对始终完整发送。
      const sys: ChatMessage = {
        role: "system",
        content: buildSystemPrompt(getNote(), settings.aiSystemPrompt, strategy),
      };
      const past = messages
        .filter((m) => !m.streaming)
        .map((m) => ({ role: m.role, content: m.content }) as ChatMessage);
      history = buildHistoryWithBudget(
        [sys, ...past, { role: "user", content: userContent }],
        budget
      ).messages;
      if (opts.mode === "full") activeSelectionRef.current = "";
    }

    // 本会话输入用量累计（本地估算）。
    setUsage((u) => ({
      ...u,
      input: u.input + history.reduce((n, m) => n + estimateTokens(m.content), 0),
    }));

    // 在 updater 外铸造消息 id（保持 updater 纯函数），并记录本轮滚动锚点。
    const userMsgId = ++msgIdRef.current;
    const aiMsgId = ++msgIdRef.current;
    turnAnchorIdRef.current = userMsgId;
    setMessages((prev) => {
      const next: Msg[] = [
        ...prev,
        {
          id: userMsgId,
          role: "user",
          content: text,
          rag: ragOn && !!ragSources,
          mode: opts.mode,
          selection: effSelection,
          quote,
          range,
          parentId: parent?.id,
        },
        // Carry the selection (and its range) onto the assistant message too,
        // so the「批注」action on this reply can anchor the marker on the exact
        // text it was about (m.selection/m.range are read by the 批注 button).
        // Without this the marker always falls back to the cursor and lands at
        // the doc start. repliedUser 让追问链能回溯到本回合的问题。
        {
          id: aiMsgId,
          role: "assistant",
          content: "",
          sources: ragSources,
          mode: opts.mode,
          selection: effSelection,
          range,
          parentId: parent?.id,
          repliedUser: userMsgId,
          streaming: true,
        },
      ];
      // Trim oldest messages beyond the cap. The new user+assistant pair is
      // always preserved (they're at the tail). Unmounted MsgRows release their
      // rendered preview DOM via the effect cleanup below. 被截断的追问祖先由
      // rows DFS 优雅降级为根层。
      return next.length > MAX_MESSAGES
        ? next.slice(next.length - MAX_MESSAGES)
        : next;
    });
    setInput("");
    setFollowUpFor(-1);
    setFollowUpDraft("");
    setFollowUpQuote(null);
    streamOutRef.current = "";
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
          tallyOutput();
          setLoading(false);
          streamRef.current = null;
          // 一键修复格式：成功完成后排队自动打开这条回复的改动预览（由
          // autoReviewIdRef 上的 effect 消费）。只在 onDone 设置 —— 出错 /
          // 手动停止的半截回复不触发。
          if (opts.preset?.autoReview) autoReviewIdRef.current = aiMsgId;
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
          tallyOutput();
          setLoading(false);
          streamRef.current = null;
        },
      },
    });
  };

  // ---- Agent 链路（v4.9）----------------------------------------------------
  // runAgent 驱动「模型 → 工具 → 模型」循环：流式正文/思考进时间线（与工具
  // 卡片按发生顺序穿插），工具结果驱动卡片状态；循环结束产出 ChangePlan，
  // 按 agentWriteMode 分流（auto：当前笔记 edit/append 直接应用；其余一律
  // 弹 AgentPlanReview 审阅）。

  // 结算一次流式输出的本地 token 估算（完成/出错/停止/清空时调用）。
  // （提前到 Agent 段之前定义——sendAgent 的依赖数组在渲染期引用它。）
  const tallyOutput = useCallback(() => {
    const out = streamOutRef.current;
    streamOutRef.current = "";
    if (out) setUsage((u) => ({ ...u, output: u.output + estimateTokens(out) }));
  }, []);

  /** 把流式缓冲立即落到消息（回合结束/出错前调用，避免丢尾帧）。 */
  const flushNow = useCallback(() => {
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (pendingDeltaRef.current.length > 0 || pendingReasoningRef.current.length > 0) {
      flushDelta();
    }
  }, [flushDelta]);

  /** 时间线上的工具卡片 upsert：无 patch（或 callId 不存在）时新增，否则原地更新。 */
  const upsertAgentTool = useCallback(
    (record: ToolCallRecord, patch?: Partial<ToolCallRecord>) => {
      setMessages((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const m = next[i];
          if (m.role === "assistant" && m.streaming && m.timeline) {
            const exists = m.timeline.some(
              (it) => it.type === "tool" && it.record.callId === record.callId
            );
            const tl = exists
              ? m.timeline.map((it) =>
                  it.type === "tool" && it.record.callId === record.callId
                    ? { type: "tool" as const, record: { ...it.record, ...patch } }
                    : it
                )
              : [...m.timeline, { type: "tool" as const, record }];
            next[i] = { ...m, timeline: tl };
            break;
          }
        }
        return next;
      });
    },
    []
  );

  /** 回合收尾：结算纯文本 content（供插入/复制/追问），置 streaming=false。 */
  const finalizeAgentMessage = useCallback((id: number, answerText: string) => {
    setMessages((prev) => {
      const next = [...prev];
      const i = next.findIndex((m) => m.id === id);
      if (i >= 0) {
        const m = next[i];
        const joined = (m.timeline ?? [])
          .filter((it): it is { type: "text"; text: string } => it.type === "text")
          .map((it) => it.text)
          .join("");
        const text = answerText || joined;
        const hasTool = (m.timeline ?? []).some((it) => it.type === "tool");
        if (!text && !m.reasoning && !hasTool) {
          next.splice(i, 1);
        } else {
          next[i] = { ...m, streaming: false, content: text };
        }
      }
      return next;
    });
  }, []);

  /** Agent 改动的应用出口（当前笔记经 onApplyChanges 一步撤销写回）。 */
  const runApply = useCallback(
    async (plan: ChangePlan, selected: Set<string>): Promise<ApplyPlanOutcome> => {
      return applyChangePlan(plan, selected, {
        currentPath: getNotePathRef.current(),
        getCurrentNote: getNote,
        writeCurrentNote: (merged) => {
          onApplyChanges({ mode: "full", range: null, original: getNote(), merged });
        },
      });
    },
    [getNote, onApplyChanges]
  );

  /** 应用结果上报：提示 + FS 变更通知（标签页/最近列表 + 文件树刷新）。 */
  const reportAgentApply = useCallback(
    (outcome: ApplyPlanOutcome) => {
      const failed = outcome.results.filter((r) => !r.ok);
      const okCount = outcome.results.length - failed.length;
      const fs = outcome.fs;
      // FS 变更 → 复用 App 的 FileTree TreeChange 处理（关标签/改路径/清最近）。
      if (fs.deleted.length > 0) onTreeChange?.({ type: "deleted", paths: fs.deleted });
      for (const r of fs.renamed) onTreeChange?.({ type: "renamed", from: r.from, to: r.to });
      if (fs.created.length + fs.renamed.length + fs.deleted.length > 0) {
        // 文件树刷新（FileTree 监听的轻量全局事件）。
        window.dispatchEvent(new CustomEvent("mditor:vault-mutated"));
      }
      const parts: string[] = [];
      if (okCount > 0) parts.push(`已应用 ${okCount} 条改动`);
      if (failed.length > 0) parts.push(`${failed.length} 条失败`);
      // 当前笔记被删除/重命名：明确提示（标签处理已由 onTreeChange 完成，
      // 绝不静默关闭）。
      const cur = getNotePathRef.current();
      if (cur) {
        const ncur = normPath(cur);
        if (fs.deleted.some((p) => normPath(p) === ncur)) {
          parts.push("当前笔记已移入系统回收站（可恢复），其标签已关闭");
        } else if (fs.renamed.some((r) => normPath(r.from) === ncur)) {
          parts.push("当前笔记已重命名，标签与路径已同步");
        }
      }
      setNotice(parts.length > 0 ? parts.join("，") + "。" : "没有可应用的改动。");
      if (failed.length > 0) {
        setError(
          `部分改动未应用：${failed
            .map((f) => f.error ?? "未知原因")
            .join("；")
            .slice(0, 300)}`
        );
      }
    },
    [onTreeChange]
  );

  /** 循环结束后的改动分流：auto 当前笔记内容编辑直接应用，其余进审阅。 */
  const handleAgentPlan = useCallback(
    async (plan: ChangePlan) => {
      const s = settingsRef.current;
      const curPath = getNotePathRef.current();
      const curKey = curPath ? normPath(curPath) : CURRENT_KEY;
      let remaining = plan.ops;
      if (s.agentWriteMode === "auto") {
        const autoOps = plan.ops.filter(
          (o) => (o.kind === "edit" || o.kind === "append") && normPath(o.path) === curKey
        );
        if (autoOps.length > 0) {
          const outcome = await runApply(plan, new Set(autoOps.map((o) => o.opId)));
          const okCount = outcome.results.filter((r) => r.ok).length;
          if (okCount > 0) setNotice(`已自动应用 ${okCount} 处当前笔记修改（Ctrl+Z 可撤销）。`);
          if (outcome.results.some((r) => !r.ok)) reportAgentApply(outcome);
          const autoIds = new Set(autoOps.map((o) => o.opId));
          remaining = plan.ops.filter((o) => !autoIds.has(o.opId));
        }
      }
      if (remaining.length > 0) {
        setAgentReview({
          plan: { ops: remaining, workingCopies: plan.workingCopies },
          decisions: Object.fromEntries(remaining.map((o) => [o.opId, true])),
        });
      }
    },
    [runApply, reportAgentApply]
  );

  const sendAgent = useCallback(
    async (text: string) => {
      const userMsgId = ++msgIdRef.current;
      const aiMsgId = ++msgIdRef.current;
      turnAnchorIdRef.current = userMsgId;
      setMessages((prev) => {
        const next: Msg[] = [
          ...prev,
          { id: userMsgId, role: "user", content: text, mode: "full", agent: true },
          { id: aiMsgId, role: "assistant", content: "", mode: "full", timeline: [], streaming: true },
        ];
        return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
      });
      setInput("");
      setFollowUpFor(-1);
      setFollowUpDraft("");
      setFollowUpQuote(null);
      streamOutRef.current = "";
      setLoading(true);
      setUsage((u) => ({ ...u, input: u.input + estimateTokens(text) }));

      const ac = new AbortController();
      agentAbortRef.current = ac;
      const ctx: ToolContext = {
        currentPath: getNotePathRef.current(),
        getCurrentNote: getNote,
        workspaces: workspacesRef.current,
        settings: settingsRef.current,
        plan: emptyPlan(),
      };

      let result: Awaited<ReturnType<typeof runAgent>>;
      try {
        result = await runAgent({
          ctx,
          userMessage: text,
          signal: ac.signal,
          onEvent: (e) => {
            if (e.type === "chunk") {
              if (e.delta) pendingDeltaRef.current.push(e.delta);
            } else if (e.type === "reasoning") {
              if (e.delta) pendingReasoningRef.current.push(e.delta);
            } else if (e.type === "tool-start") {
              upsertAgentTool(e.record);
            } else if (e.type === "tool-end") {
              upsertAgentTool(
                {
                  callId: e.callId,
                  name: "",
                  argsRaw: "",
                  status: e.status,
                  summary: e.summary,
                  result: e.result,
                },
                { status: e.status, summary: e.summary, result: e.result }
              );
            } else if (e.type === "degraded") {
              setNotice("当前模型不支持工具调用，已降级为普通对话。");
            }
            if ((e.type === "chunk" || e.type === "reasoning") && rafIdRef.current == null) {
              rafIdRef.current = requestAnimationFrame(flushDelta);
            }
          },
        });
      } catch (e) {
        flushNow();
        finalizeAgentMessage(aiMsgId, "");
        setError(String(e));
        setLoading(false);
        agentAbortRef.current = null;
        return;
      }
      flushNow();
      finalizeAgentMessage(aiMsgId, result.answer);
      tallyOutput();
      setLoading(false);
      agentAbortRef.current = null;
      if (!result.cancelled && result.plan.ops.length > 0) {
        await handleAgentPlan(result.plan);
      }
    },
    [getNote, flushNow, finalizeAgentMessage, handleAgentPlan, upsertAgentTool, flushDelta, tallyOutput]
  );

  const stop = () => {
    // Agent 回合：中止器触发 runAgent 取消路径，收尾（flush/结算/清 loading）
    // 由 sendAgent 的 await 返回后的续体完成；这里同步翻 loading 让按钮即时复位。
    if (agentAbortRef.current) {
      agentAbortRef.current.abort();
      tallyOutput();
      setLoading(false);
      return;
    }
    streamRef.current?.cancel();
    streamRef.current = null;
    tallyOutput();
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
    agentAbortRef.current?.abort();
    agentAbortRef.current = null;
    streamRef.current?.cancel();
    streamRef.current = null;
    tallyOutput();
    setMessages([]);
    setError("");
    setNotice("");
    setInput("");
    setFollowUpFor(-1);
    setFollowUpDraft("");
    setFollowUpQuote(null);
    setUsage({ input: 0, output: 0 });
    setReview(null);
    setAgentReview(null);
    activeSelectionRef.current = "";
  };

  // ---- 追问 -----------------------------------------------------------------

  const startFollowUp = useCallback((id: number) => {
    setFollowUpFor(id);
    setFollowUpDraft("");
    setFollowUpQuote(null);
  }, []);

  /** 划选追问入口：携带选中的回答片段打开行内输入框。 */
  const startQuoteFollowUp = useCallback((id: number, quote: string) => {
    setFollowUpFor(id);
    setFollowUpDraft("");
    setFollowUpQuote(quote);
    window.getSelection()?.removeAllRanges();
  }, []);

  const closeFollowUp = useCallback(() => {
    setFollowUpFor(-1);
    setFollowUpDraft("");
    setFollowUpQuote(null);
  }, []);

  // followUpQuote 的 ref 镜像（submitFollowUp 保持稳定身份，MsgRow memo 有效）。
  const followUpQuoteRef = useRef<string | null>(null);
  followUpQuoteRef.current = followUpQuote;

  /** 追问草稿变更（稳定回调，行内输入框直接写面板状态）。 */
  const changeFollowUpDraft = useCallback((t: string) => setFollowUpDraft(t), []);

  // 行内追问输入框的提交（草稿与引用片段由面板持有：虚拟列表回收行时
  // 草稿不丢失、不串行 —— 行只是暂时看不见）。
  const submitFollowUp = useCallback(
    (id: number, text: string) => {
      const target = messagesRef.current.find(
        (m) => m.id === id && m.role === "assistant"
      );
      if (!target || target.streaming) return;
      const quote = followUpQuoteRef.current ?? undefined;
      void sendRef.current(text, { mode: target.mode, parent: target, quote });
    },
    []
  );

  // ---- 改动预览（修改类回复的应用前审查）------------------------------------

  /** 打开某条回复的改动审查：diff 目标原文（全文 / 选区）与 AI 修订文本。 */
  const openReview = useCallback(
    (m: Msg) => {
      const revised = unwrapWholeFence(m.content);
      let original: string;
      if (m.mode === "selection") {
        if (!m.selection) {
          setError("这条回复缺少选区上下文，无法审查改动。");
          return;
        }
        original = m.selection;
      } else {
        original = getNote();
      }
      const hunks = diffText(original, revised);
      setReview({
        mode: m.mode,
        original,
        revised,
        hunks,
        decisions: hunks.map(() => true),
        range: m.range ?? null,
      });
    },
    [getNote]
  );

  const toggleReviewHunk = useCallback((index: number) => {
    setReview((prev) => {
      if (!prev) return prev;
      const decisions = [...prev.decisions];
      decisions[index] = !decisions[index];
      return { ...prev, decisions };
    });
  }, []);

  const setReviewAll = useCallback((accept: boolean) => {
    setReview((prev) =>
      prev ? { ...prev, decisions: prev.hunks.map(() => accept) } : prev
    );
  }, []);

  const cancelReview = useCallback(() => setReview(null), []);

  const jumpToHunk = useCallback(
    (hunk: DiffHunk) => {
      // 纯新增没有原文可跳；退而求其次跳到新内容（在原文中不存在，无操作）。
      if (hunk.anchorLine) onJumpToText(hunk.anchorLine);
    },
    [onJumpToText]
  );

  /** 应用已接受的 hunks：一次合并写回（一步撤销），随后回到聊天视图。 */
  const applyReview = useCallback(() => {
    if (!review) return;
    const accepted = review.decisions.filter(Boolean).length;
    if (accepted === 0) {
      setReview(null);
      return;
    }
    const merged = applyHunks(review.original, review.hunks, review.decisions);
    onApplyChanges({
      mode: review.mode,
      range: review.range,
      original: review.original,
      merged,
    });
    setNotice(`已应用 ${accepted} 处改动（Ctrl+Z 可一步撤销）。`);
    setReview(null);
  }, [review, onApplyChanges]);

  // 一键修复格式的自动审查：目标回复结束 streaming 且有内容 → 打开改动
  // 预览。消息被 MAX_MESSAGES 裁剪（找不到 id）时放弃并清 ref。
  useEffect(() => {
    const id = autoReviewIdRef.current;
    if (id == null) return;
    const m = messagesRef.current.find((x) => x.id === id);
    if (!m) {
      autoReviewIdRef.current = null;
      return;
    }
    if (!m.streaming && m.content) {
      autoReviewIdRef.current = null;
      openReview(m);
    }
  }, [messages, openReview]);

  // ---- Agent 改动清单审阅（v4.9）---------------------------------------------

  const toggleAgentOp = useCallback((opId: string) => {
    setAgentReview((prev) =>
      prev
        ? { ...prev, decisions: { ...prev.decisions, [opId]: !prev.decisions[opId] } }
        : prev
    );
  }, []);

  const setAgentAll = useCallback((accept: boolean) => {
    setAgentReview((prev) =>
      prev
        ? {
            ...prev,
            decisions: Object.fromEntries(prev.plan.ops.map((o) => [o.opId, accept])),
          }
        : prev
    );
  }, []);

  const cancelAgentReview = useCallback(() => setAgentReview(null), []);

  const applyAgentReview = useCallback(async () => {
    if (!agentReview) return;
    const selected = new Set(
      Object.entries(agentReview.decisions)
        .filter(([, v]) => v)
        .map(([k]) => k)
    );
    if (selected.size === 0) {
      setAgentReview(null);
      return;
    }
    const outcome = await runApply(agentReview.plan, selected);
    reportAgentApply(outcome);
    setAgentReview(null);
  }, [agentReview, runApply, reportAgentApply]);

  // Keep a ref to the latest `send` so the imperative handle below can stay
  // stable (empty deps) instead of rebuilding every turn. Without this, every
  // 全库问答索引构建（v4.7 模块 5）：首次构建前明示成本（嵌入 API 处理 N 个
  // 文档），用户确认后才开始（铁律：消耗 API 的功能须显式授权）。
  const startRagBuild = async () => {
    if (!settings.ragEnabled || !isEmbedConfigured(settings)) {
      setError("请先在「设置 → 知识功能」中开启全库问答并配置嵌入模型。");
      return;
    }
    const entries = vaultIndex.entries();
    if (entries.length === 0) {
      setError("全库索引为空——请先打开工作区并等待索引完成。");
      return;
    }
    if (!ragIndex.isBuilt(settings.ragEmbedModel)) {
      const ok = await confirmDialog(
        `将调用嵌入 API 处理 ${entries.length} 个文档（约 ${Math.max(
          1,
          Math.round(entries.length * 4)
        )} 个文本块），会产生相应 API 费用。之后增量更新只对改动的块计费。\n\n确认开始构建？`,
        "全库问答"
      );
      if (!ok) return;
    }
    void ragIndex
      .resume(entries, settings, (texts) => embedTexts(settings, texts))
      .catch((e) => setError(`索引构建失败：${String(e)}`));
  };

  // chat message makes `askSelection` a new function — harmless, but the
  // selection toolbar's poll loop (App.tsx) re-resolves it needlessly.
  const sendRef = useRef(send);
  sendRef.current = send;

  // 内置「一键修复格式」（v4.5）：全文原文走专用提示词（不截断、不带历
  // 史），成功完成后自动打开改动预览。入口：面板常驻按钮、格式菜单、
  // Ctrl+Alt+F（后两者经 AiPanelHandle.fixFormat 转发到这里）。
  const fixFormat = useCallback(() => {
    const note = getNote();
    if (!note.trim()) {
      setError("当前笔记为空，没有需要修复的格式。");
      return;
    }
    void sendRef.current("一键修复 Markdown 格式", {
      mode: "full",
      preset: { messages: buildFormatFixMessages(note), autoReview: true },
    });
  }, [getNote]);

  const fixFormatRef = useRef(fixFormat);
  fixFormatRef.current = fixFormat;

  // Imperative entry from the selection toolbar.
  useImperativeHandle(
    ref,
    (): AiPanelHandle => ({
      askSelection: (selection, instruction, range) => {
        sendRef.current(instruction, { mode: "selection", selection, range });
      },
      fixFormat: () => fixFormatRef.current(),
    }),
    // sendRef/fixFormatRef are stable; the handle never needs to be recreated.
    []
  );

  // v4.1 退场动效：关闭后保持挂载 240ms 播 .closing 退场动画再卸载（重开
  // 立即恢复，不与入场叠加）。流式取消/状态清理仍由上面 [open] 的 effect
  // 即时执行——退场窗口内面板只是「看得见的残影」，不再有活动请求。
  const mounted = useDelayedUnmount(open, 240);

  if (!mounted) return null;

  return (
    <div className={`ai-panel${open ? "" : " closing"}`}>
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

      {/* 模式分段开关（v4.9）：普通对话（现状）| Agent（工具调用链路）。 */}
      <div className="ai-mode-row">
        <div className="ai-mode-switch" role="group" aria-label="AI 面板模式">
          <button
            className={agentMode ? "" : "on"}
            title="普通对话：AI 只回答，不操作文件（行为与既往一致）"
            onClick={() => onSettingsChange({ aiPanelMode: "chat" })}
          >
            对话
          </button>
          <button
            className={agentMode ? "on" : ""}
            title="Agent：AI 可检索/读取/编辑/新建/重命名/删除笔记；改动先暂存，审阅后才应用"
            onClick={() => onSettingsChange({ aiPanelMode: "agent" })}
          >
            Agent
          </button>
        </div>
      </div>

      {!configured && (
        <div className="ai-banner">
          尚未配置 AI。<button onClick={onOpenSettings}>去设置</button>
        </div>
      )}

      {activeSelectionRef.current && !review && !agentReview && (
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

      {notice && !review && !agentReview && <div className="ai-notice">{notice}</div>}

      {review ? (
        <DiffReview
          hunks={review.hunks}
          decisions={review.decisions}
          mode={review.mode}
          onToggle={toggleReviewHunk}
          onSetAll={setReviewAll}
          onApply={applyReview}
          onCancel={cancelReview}
          onJump={jumpToHunk}
        />
      ) : agentReview ? (
        <AgentPlanReview
          plan={agentReview.plan}
          currentKey={
            getNotePath() ? normPath(getNotePath()!) : CURRENT_KEY
          }
          decisions={agentReview.decisions}
          onToggle={toggleAgentOp}
          onSetAll={setAgentAll}
          onApply={() => void applyAgentReview()}
          onCancel={cancelAgentReview}
        />
      ) : (
        <>
          <div className="ai-quick">
            <button
              className="ai-quick-btn ai-fix-btn"
              disabled={loading}
              onClick={fixFormat}
              title="AI 修复全文 Markdown 语法错误，完成后自动打开改动预览（Ctrl+Alt+F）"
            >
              修复格式
            </button>
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

          <div className="ai-msgs" ref={scrollRef}>
            {messages.length === 0 && !loading && (
              <div className="ai-empty">
                {agentMode ? (
                  <>
                    Agent 模式：AI 可以检索、读取、编辑、新建、重命名和删除笔记。
                    <br />
                    所有改动先暂存为「改动清单」，审阅（可逐条勾选）后才应用；
                    删除进系统回收站，可恢复。
                    <br />
                    例如：「我哪几篇笔记讲过 X？」「把当前笔记的二级标题统一
                    改成大写」「给 XX 文件夹下的笔记统一加 frontmatter」。
                  </>
                ) : (
                  <>
                    问任何关于这篇笔记的问题，或试试上方的快捷操作。
                    <br />
                    选中文字可针对片段提问 / 改写 / 翻译；每条回答下的「追问」可就
                    该回答继续深入。
                    <br />
                    例如：「这篇笔记的要点是什么？」「把第二段改得更简洁。」
                  </>
                )}
              </div>
            )}
            {rows.length > 0 && (
              <div
                className="ai-msgs-virtual"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {virtualizer.getVirtualItems().map((vi) => {
                  const row = rows[vi.index];
                  const m = row.msg;
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
                        depth={row.depth}
                        theme={settings.theme}
                        busy={loading}
                        followUpActive={followUpFor === m.id}
                        followUpDraft={followUpFor === m.id ? followUpDraft : ""}
                        followUpQuote={followUpFor === m.id ? followUpQuote : null}
                        onStartFollowUp={startFollowUp}
                        onStartQuoteFollowUp={startQuoteFollowUp}
                        onFollowUpDraftChange={changeFollowUpDraft}
                        onSubmitFollowUp={submitFollowUp}
                        onCloseFollowUp={closeFollowUp}
                        onInsert={() => onInsert(m.content)}
                        onReview={() => openReview(m)}
                        onInsertAfterSelection={() => onInsertAfterSelection(m.content)}
                        onAnnotate={() => void handleAnnotate(m.id, m.content, m.selection, m.range)}
                        annotating={annotatingId === m.id}
                        onCopy={() => navigator.clipboard?.writeText(m.content)}
                        onOpenNote={onOpenNote}
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

          {/* v4.7 模块 5：全库问答开关 + 索引构建（默认关；开启前需配置嵌入模型）。
              构建走 appDataDir/rag-index.json 增量缓存，暂停/续跑随时可续。
              v4.9：Agent 模式下隐藏——检索已由工具（search_notes /
              semantic_search）承担。 */}
          {!agentMode && (
            <div className="ai-rag-row">
            <button
              className={`ai-rag-toggle${ragOn ? " on" : ""}`}
              title={
                settings.ragEnabled
                  ? "对整个笔记库提问：问题嵌入 → 余弦检索 top-8 → 带来源回答"
                  : "需先在「设置 → 知识功能」中开启全库问答并配置嵌入模型"
              }
              disabled={!settings.ragEnabled}
              aria-pressed={ragOn}
              onClick={() => setRagOn((v) => !v)}
            >
              全库问答
            </button>
            {ragOn && (
              <>
                <span
                  className="ai-rag-status"
                  title={
                    ragStats.error ??
                    `${ragStats.docs} 篇 / ${ragStats.chunks} 块 · 模型 ${ragStats.model || "未设置"}`
                  }
                >
                  {ragStats.phase === "building"
                    ? `构建中 ${ragStats.done}/${ragStats.total}`
                    : ragStats.phase === "paused"
                      ? `已暂停（${ragStats.done}/${ragStats.total}）`
                      : ragStats.phase === "error"
                        ? "构建失败（悬停查看）"
                        : `${ragStats.chunks} 块已索引`}
                </span>
                {ragStats.phase === "building" ? (
                  <button className="ai-rag-ctl" onClick={() => ragIndex.pause()}>
                    暂停
                  </button>
                ) : (
                  <button className="ai-rag-ctl" onClick={() => void startRagBuild()}>
                    {ragStats.phase === "paused" ? "续跑" : "构建索引"}
                  </button>
                )}
              </>
            )}
            </div>
          )}

          <div className="ai-input-row">
            <textarea
              className="ai-input"
              placeholder={
                agentMode
                  ? activeSelectionRef.current
                    ? "Agent 模式针对全文工作；选区问答请切回「对话」"
                    : "描述任务，Enter 发送——Agent 将检索并修改笔记（改动需审阅）"
                  : activeSelectionRef.current
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

          {/* v3.9 用量统计：本地估算（零额外请求），重开面板/清空时归零。 */}
          <div
            className="ai-usage"
            title="本地估算（按中英混合分词密度近似），仅供参考；精确用量以服务商账单为准。可在「设置 → AI」调整上下文策略与历史预算来降低输入成本。"
          >
            本会话 ≈ 输入 {(usage.input / 1000).toFixed(1)}k / 输出{" "}
            {(usage.output / 1000).toFixed(1)}k tokens
          </div>
        </>
      )}
    </div>
  );
}));

// ---- single message row ----------------------------------------------------

interface MsgRowProps {
  msg: Msg;
  /** 线程深度（0 = 根层，1+ = 追问层级），驱动缩进与连接线。 */
  depth: number;
  /** App theme, to pick Vditor's light/dark content theme for the preview. */
  theme: Theme;
  /** 面板正在流式输出中（禁用追问入口）。 */
  busy: boolean;
  /** 追问输入框是否展开在本行下方。 */
  followUpActive: boolean;
  /** 追问草稿（面板持有；本行未展开时为 ""）。 */
  followUpDraft: string;
  /** 划选追问携带的引用片段（本行未展开时为 null）。 */
  followUpQuote: string | null;
  onStartFollowUp: (id: number) => void;
  /** 划选追问入口：携带选中的回答片段打开输入框。 */
  onStartQuoteFollowUp: (id: number, quote: string) => void;
  onFollowUpDraftChange: (text: string) => void;
  onSubmitFollowUp: (id: number, text: string) => void;
  onCloseFollowUp: () => void;
  onInsert: () => void;
  /** 打开改动预览（替换类写回的审查入口）。 */
  onReview: () => void;
  onInsertAfterSelection: () => void;
  onAnnotate: () => void;
  /** True while this reply is being refined into an annotation. */
  annotating: boolean;
  onCopy: () => void;
  /** 全库问答：打开来源笔记（v4.7 模块 5）。 */
  onOpenNote: (path: string, heading?: string) => void;
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

/** Agent 工具调用卡片（v4.9）：图标 + 工具中文名 + 参数/结果摘要 + 状态，
 * 可展开结果预览（代码块样式）。状态自持 expanded，卸载即清。 */
const ToolCard = memo(function ToolCard({ record }: { record: ToolCallRecord }) {
  const [open, setOpen] = useState(false);
  const label = TOOL_BY_NAME.get(record.name)?.label ?? record.name;
  return (
    <div className={`agent-card agent-card-${record.status}`}>
      <button
        className="agent-card-head"
        onClick={() => setOpen((v) => !v)}
        title={record.argsRaw.slice(0, 300)}
      >
        <span className="agent-card-dot" aria-hidden="true" />
        <span className="agent-card-label">{label}</span>
        {record.summary && <span className="agent-card-summary">{record.summary}</span>}
        <span className="agent-card-caret">
          <ChevronRightIcon size={11} className={`chevron${open ? " open" : ""}`} />
        </span>
      </button>
      {open && record.result && (
        <pre className="agent-card-result">
          {record.result.length > 4000 ? record.result.slice(0, 4000) + "\n…（截断）" : record.result}
        </pre>
      )}
    </div>
  );
});

const MsgRow = memo(function MsgRow({
  msg,
  depth,
  theme,
  busy,
  followUpActive,
  followUpDraft,
  followUpQuote,
  onStartFollowUp,
  onStartQuoteFollowUp,
  onFollowUpDraftChange,
  onSubmitFollowUp,
  onCloseFollowUp,
  onInsert,
  onReview,
  onInsertAfterSelection,
  onAnnotate,
  annotating,
  onCopy,
  onOpenNote,
}: MsgRowProps) {
  const isAssistant = msg.role === "assistant";
  const hasContent = msg.content.length > 0;
  const hasReasoning = !!(msg.reasoning && msg.reasoning.length > 0);
  const isThread = depth > 0;
  // Agent 时间线消息：已有文本段（流式或定稿）时不再显示「正在思考」占位。
  const hasTimelineText = (msg.timeline ?? []).some(
    (it) => it.type === "text" && it.text.length > 0
  );
  const fuRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (followUpActive) fuRef.current?.focus();
  }, [followUpActive]);

  // ---- 划选追问（v3.9）：回答正文里划选文字 → 出现「追问这段」浮动入口。
  // 仅对已完成且有正文的回答开放（流式未完成时不可追问）；选区两端都落
  // 在本行正文内才有效。Esc / 点击空白（选区塌陷）自动消失；入口按钮
  // mousedown preventDefault，不与操作按钮争抢焦点/选区。
  const rowRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const selectable = isAssistant && !msg.streaming && hasContent;
  const [selChip, setSelChip] = useState<{
    x: number;
    y: number;
    quote: string;
  } | null>(null);
  useEffect(() => {
    if (!selectable) {
      setSelChip(null);
      return;
    }
    const update = () => {
      const body = bodyRef.current;
      const s = window.getSelection();
      if (!body || !s || s.rangeCount === 0 || s.isCollapsed) {
        setSelChip(null);
        return;
      }
      const anchor = s.anchorNode;
      const focus = s.focusNode;
      if (
        !anchor ||
        !focus ||
        !body.contains(anchor) ||
        !body.contains(focus)
      ) {
        setSelChip(null);
        return;
      }
      const text = s.toString().replace(/\s+/g, " ").trim();
      if (!text) {
        setSelChip(null);
        return;
      }
      const rect = s.getRangeAt(0).getBoundingClientRect();
      const rowRect = rowRef.current?.getBoundingClientRect();
      if (!rowRect) return;
      // 行内绝对定位：钳在行宽内，贴选区下缘。
      const x = Math.min(
        Math.max(rect.left - rowRect.left, 0),
        Math.max(0, rowRect.width - 150)
      );
      setSelChip({ x, y: rect.bottom - rowRect.top + 6, quote: text });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        window.getSelection()?.removeAllRanges();
        setSelChip(null);
      }
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("keydown", onKey);
    };
  }, [selectable]);

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

  // 追问层级渲染：缩进封顶 4 层深度对应的宽度，再深保持对齐（避免窄面板
  // 被挤没）；连接线交给 CSS（.ai-msg-thread）。
  const threadStyle =
    depth > 0 ? { marginLeft: `${Math.min(depth, 4) * 18}px` } : undefined;

  if (!isAssistant) {
    return (
      <div
        ref={rowRef}
        className={`ai-msg ai-msg-user${isThread ? " ai-msg-thread" : ""}`}
        style={threadStyle}
      >
        {isThread && <span className="ai-thread-tag">追问</span>}
        {msg.rag && <span className="ai-ctx-tag">全库问答</span>}
        {msg.agent && <span className="ai-ctx-tag agent">Agent</span>}
        {msg.quote && (
          <div className="ai-quote-chip" title={msg.quote}>
            {msg.quote}
          </div>
        )}
        <div className="ai-msg-content">{msg.content}</div>
      </div>
    );
  }

  return (
    <div
      ref={rowRef}
      className={`ai-msg ai-msg-assistant${isThread ? " ai-msg-thread" : ""}`}
      style={threadStyle}
    >
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
      {/* Agent 时间线（v4.9）：文本段与工具卡片按发生顺序穿插。流式期间纯文本
          + 光标；定稿后文本段用 MarkdownText 渲染（与普通回答一致）。 */}
      {msg.timeline ? (
        <div className="agent-timeline">
          {msg.timeline.map((it, i) =>
            it.type === "tool" ? (
              <ToolCard key={`tool-${it.record.callId}`} record={it.record} />
            ) : it.text ? (
              msg.streaming ? (
                <div key={`text-${i}`} className="ai-msg-content agent-text ai-streaming">
                  {it.text}
                  <span className="ai-cursor" aria-hidden="true">▍</span>
                </div>
              ) : (
                <div
                  key={`text-${i}`}
                  ref={i === 0 ? bodyRef : undefined}
                  className="ai-msg-body"
                >
                  <MarkdownText content={it.text} theme={theme} className="ai-msg-content" />
                </div>
              )
            ) : null
          )}
          {msg.streaming && !hasTimelineText && !hasReasoning && <ThinkingDots />}
        </div>
      ) : msg.streaming ? (
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
        <div ref={bodyRef} className="ai-msg-body">
          <MarkdownText
            content={msg.content}
            theme={theme}
            className="ai-msg-content"
          />
        </div>
      ) : null}
      {/* 全库问答来源（v4.7 模块 5）：回答完成后展示可点击的来源笔记列表。 */}
      {!msg.streaming && msg.sources && msg.sources.length > 0 && (
        <div className="ai-rag-sources">
          <div className="ai-rag-sources-head">来源（点击跳转）</div>
          {msg.sources.map((s, i) => (
            <button
              key={`${s.path}-${i}`}
              className="ai-rag-src"
              title={s.snippet}
              onClick={() => onOpenNote(s.path, s.heading || undefined)}
            >
              <span className="ai-rag-src-name">
                {s.name}
                {s.heading ? ` › ${s.heading}` : ""}
              </span>
              <span className="ai-rag-src-score">{(s.score * 100).toFixed(0)}%</span>
            </button>
          ))}
        </div>
      )}
      {/* 划选追问入口：仅已完成回答的正文上方划选时出现。 */}
      {selChip && (
        <div
          className="ai-sel-followup"
          style={{ left: `${selChip.x}px`, top: `${selChip.y}px` }}
        >
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onStartQuoteFollowUp(msg.id, selChip.quote);
              setSelChip(null);
            }}
            title="把选中的这段回答作为显式上下文发起追问"
          >
            追问这段
          </button>
        </div>
      )}
      {!msg.streaming && hasContent && (
        <div className="ai-actions">
          {msg.mode === "selection" ? (
            <>
              <button
                onClick={onReview}
                title="先审查这处修改（原内容 → 新内容对照，可逐处接受/拒绝），确认后替换选中文字"
              >
                替换选区…
              </button>
              <button onClick={onInsertAfterSelection} title="在选中文字下方插入这条回复">
                插入到选区下方
              </button>
            </>
          ) : (
            <>
              <button onClick={onInsert}>插入到光标</button>
              <button
                onClick={onReview}
                title="先审查这处修改（原内容 → 新内容对照，可逐处接受/拒绝），确认后替换全文"
              >
                替换全文…
              </button>
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
          <button
            onClick={() => onStartFollowUp(msg.id)}
            disabled={busy}
            title={busy ? "等待当前回答完成" : "针对这条回答继续追问（挂在其下方，可多层嵌套；也可在回答正文中划选后「追问这段」）"}
          >
            追问
          </button>
        </div>
      )}
      {/* 行内追问输入框：挂在被追问的回答正下方（actions 之内）。提交后
          新的问答对以缩进线程渲染在本回答之下。草稿与引用片段由面板层
          持有 —— 虚拟列表回收本行后再滚回来，草稿仍在。 */}
      {followUpActive && (
        <div className="ai-followup">
          {followUpQuote && (
            <div className="ai-quote-chip active" title={followUpQuote}>
              追问范围：{followUpQuote}
            </div>
          )}
          <textarea
            ref={fuRef}
            className="ai-followup-input"
            rows={2}
            value={followUpDraft}
            placeholder={
              followUpQuote
                ? "针对选中的这段回答追问…（Enter 发送，Shift+Enter 换行，Esc 取消）"
                : "针对这条回答继续追问…（Enter 发送，Shift+Enter 换行）"
            }
            onChange={(e) => onFollowUpDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (followUpDraft.trim()) onSubmitFollowUp(msg.id, followUpDraft);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onCloseFollowUp();
              }
            }}
          />
          <div className="ai-followup-actions">
            <button
              className="ai-followup-send"
              disabled={!followUpDraft.trim() || busy}
              onClick={() => onSubmitFollowUp(msg.id, followUpDraft)}
            >
              发送追问
            </button>
            <button onClick={onCloseFollowUp}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
});
