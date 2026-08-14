// Floating toolbar that appears above a text selection inside the editor
// surface. Offers formatting (bold / highlight / text color) plus AI actions that
// target the selected fragment: 解释/翻译 (with a direction toggle), 改写 (with a
// free-form requirement field), 问 AI, and 批注. Dispatching an AI action hands the
// selected text + the instruction to `onAsk`, which the App routes into the AI panel.
//
// The toolbar is intentionally compact: the formatting color picker and the AI
// actions each collapse into a 二级菜单 (flyout submenu) so the top row stays short
// (`B | 高光 | 文字颜色▾ | AI▾ | 批注…`). The submenus are always mounted while the
// toolbar is visible and toggled with an `.open` class, which lets CSS transition
// them smoothly on BOTH enter and exit (conditional mount/unmount can only animate
// the enter). See `.sel-submenu` in global.css.
//
// Performance: React.memo'd. App passes stable useCallback props and a stable
// filtered `actions` array (useMemo) so the toolbar skips re-renders during
// typing — it only re-renders when its own internal state (visibility,
// position, selection text, open submenu) changes.

import { memo, useEffect, useRef, useState } from "react";
import type { QuickAction } from "../types";
import { HighlightIcon, TextColorIcon, ChevronRightIcon, CloseIcon } from "./icons";

interface Props {
  /** Read the current editor selection text on demand. */
  getSelection: () => string;
  /** Read the current selection's document positions {from,to} on demand
   *  (null when collapsed). Captured while the selection is still live so the
   *  annotation can be anchored exactly even after focus moves to the popout. */
  getSelectionRange: () => { from: number; to: number } | null;
  /** Whether the editor surface is ready to be queried. */
  isReady: () => boolean;
  /** Called when the user picks an action. `instruction` may contain {selection}. */
  onAsk: (selection: string, instruction: string, range?: { from: number; to: number } | null) => void;
  /** Create an annotation anchored to the current selection with the given body.
   *  `range` is the selection captured while it was still live (best-effort). */
  onAnnotate: (
    selection: string,
    content: string,
    range?: { from: number; to: number } | null
  ) => void;
  /** User-customised selection-scope quick actions (rendered as chips in the AI menu). */
  actions: QuickAction[];
  /** Toggle bold on the current selection (rich + source modes). */
  onBold: () => void;
  /** Toggle ==highlight== on the current selection (rich + source modes). */
  onHighlight: () => void;
  /** Apply a text color to the current selection (rich + source modes). */
  onSetColor: (color: string) => void;
  /** Remove any text color from the current selection. */
  onClearColor: () => void;
  /** Whether the current selection/caret already carries bold / highlight / a
   *  text color, so the buttons and swatches can reflect active state. */
  getActiveMarks: () => { bold: boolean; highlight: boolean; color: string | null };
}

type TranslateDir = "zh2en" | "en2zh";

interface Pos {
  top: number;
  left: number;
  flipDown: boolean;
}

type ActiveMarks = { bold: boolean; highlight: boolean; color: string | null };

// Curated preset palette (红/橙/黄/绿/青/蓝/紫/粉/灰). Colors are stored as hex
// in the document via `<span style="color:…">`.
const COLOR_PALETTE = [
  "#e53935",
  "#fb8c00",
  "#fdd835",
  "#43a047",
  "#00897b",
  "#1e88e5",
  "#8e24aa",
  "#d81b60",
  "#757575",
];

// The editor stores the color verbatim (hex when applied via the palette, but
// browsers normalize colors parsed from raw HTML to rgb()), so compare swatch
// active state through a normalized form. A single hidden probe element + cache
// keeps this cheap (the toolbar renders rarely — only on selection/menu changes).
const probeEl =
  typeof document !== "undefined" ? document.createElement("span") : null;
const normCache = new Map<string, string>();
function normalizeColor(c: string): string {
  const hit = normCache.get(c);
  if (hit) return hit;
  let out = c.toLowerCase();
  if (probeEl) {
    probeEl.style.color = "";
    probeEl.style.color = c;
    const v = probeEl.style.color;
    if (v) out = v.toLowerCase();
  }
  normCache.set(c, out);
  return out;
}
const PALETTE_NORM = COLOR_PALETTE.map(normalizeColor);

export const SelectionToolbar = memo(function SelectionToolbar({
  getSelection,
  getSelectionRange,
  isReady,
  onAsk,
  onAnnotate,
  actions,
  onBold,
  onHighlight,
  onSetColor,
  onClearColor,
  getActiveMarks,
}: Props) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<Pos>({ top: 0, left: 0, flipDown: false });
  const [selection, setSelection] = useState("");
  const [activeMarks, setActiveMarks] = useState<ActiveMarks>({
    bold: false,
    highlight: false,
    color: null,
  });
  const [translateDir, setTranslateDir] = useState<TranslateDir>("zh2en");
  const [colorOpen, setColorOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [rewriteReq, setRewriteReq] = useState("");
  const [freeOpen, setFreeOpen] = useState(false);
  const [freeText, setFreeText] = useState("");
  const [annoOpen, setAnnoOpen] = useState(false);
  const [annoText, setAnnoText] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  // Last selection range captured while it was still live. The 批注 popout's
  // <textarea autoFocus> collapses the editor selection once it opens, so we
  // stash the range here (on each selectionchange while the editor holds the
  // selection) and hand it to onAnnotate at submit time.
  const rangeRef = useRef<{ from: number; to: number } | null>(null);

  // Recompute position/visibility on selection changes & editor mouse/keys.
  // NOTE: `isReady` is a stable useCallback that reads editorRef.current at
  // call time, so this effect's deps never change → it runs only ONCE on mount.
  // At mount time the editor hasn't finished initialising, so `isReady()` is
  // false. We must therefore poll until the editor is ready before attaching
  // listeners, otherwise the selection toolbar will never appear.
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const update = () => {
      // Don't reposition while the user is interacting with the toolbar itself.
      const active = document.activeElement;
      if (rootRef.current && active && rootRef.current.contains(active)) return;

      const sel = window.getSelection();
      const text = sel && !sel.isCollapsed ? sel.toString().trim() : "";
      const selInEditor = !!sel && !!text && editorAreaContains(sel.anchorNode);
      if (!selInEditor) {
        rangeRef.current = null;
        setVisible(false);
        closeMenus();
        return;
      }
      const rect = sel!.getRangeAt(0).getBoundingClientRect();
      // Hide if the selection is too short to be meaningful (a stray click).
      if (text.length < 1) {
        rangeRef.current = null;
        setVisible(false);
        closeMenus();
        return;
      }
      // Place above the selection; flip below if there isn't room.
      const margin = 8;
      const toolbarH = 40;
      const flipDown = rect.top < toolbarH + margin + 4;
      const top = flipDown
        ? rect.bottom + margin
        : rect.top - toolbarH - margin;
      setPos({ top, left: Math.max(margin, rect.left), flipDown });
      setSelection(text);
      // Capture the selection range while it's still live; the 批注 popout's
      // autoFocus will collapse it later, so stash it now for onAnnotate.
      rangeRef.current = getSelectionRange();
      // Reflect whether the selection already carries bold/highlight/color so
      // the formatting controls show active state.
      setActiveMarks(getActiveMarks());
      setVisible(true);
    };

    // selectionchange 在输入 / 移动光标 / 拖选时高频触发，直接每次同步跑
    // getBoundingClientRect + 多个 setState 会让选区交互产生可感的滞后。
    // 用 rAF 合并：触发只标记并请求一帧，真正的测量与 setState 一帧最多一次。
    let rafId: number | null = null;
    const scheduleUpdate = () => {
      if (rafId != null) return; // 已有一帧挂起，合并本帧内的后续触发
      rafId = requestAnimationFrame(() => {
        rafId = null;
        update();
      });
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setVisible(false);
        closeMenus();
        setRewriteOpen(false);
        setFreeOpen(false);
        setAnnoOpen(false);
      }
    };

    const attach = () => {
      document.addEventListener("selectionchange", scheduleUpdate);
      const editor = document.querySelector<HTMLElement>(".mditor-editor-host");
      editor?.addEventListener("mouseup", scheduleUpdate);
      editor?.addEventListener("keyup", scheduleUpdate);
      window.addEventListener("resize", scheduleUpdate);
      window.addEventListener("keydown", onKey);
      cleanup = () => {
        if (rafId != null) cancelAnimationFrame(rafId);
        rafId = null;
        document.removeEventListener("selectionchange", scheduleUpdate);
        editor?.removeEventListener("mouseup", scheduleUpdate);
        editor?.removeEventListener("keyup", scheduleUpdate);
        window.removeEventListener("resize", scheduleUpdate);
        window.removeEventListener("keydown", onKey);
      };
    };

    const setup = () => {
      if (cancelled) return;
      if (!isReady()) {
        // Editor not ready yet — retry shortly. Boots in an async callback,
        // so this typically resolves within a tick or two.
        pollTimer = setTimeout(setup, 100);
        return;
      }
      attach();
    };
    setup();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      cleanup?.();
    };
    // `getSelectionRange` is a stable useCallback from App, so listing it is
    // safe and never triggers re-runs; it satisfies exhaustive-deps.
  }, [isReady, getSelectionRange]);

  // Close when a click lands outside both the toolbar and the editor surface.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (rootRef.current && t && rootRef.current.contains(t)) return;
      if (editorAreaContains(t)) return; // editor clicks are handled by selectionchange
      setVisible(false);
      closeMenus();
      setRewriteOpen(false);
      setFreeOpen(false);
      setAnnoOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // Close the two flyout submenus (used by every hide / dismiss path). Declared
  // as a hoisted function so the effect closures above can call it.
  function closeMenus() {
    setColorOpen(false);
    setAiOpen(false);
  }

  if (!visible) return null;

  // Apply a formatting toggle (bold/highlight/color) and refresh the active
  // state. Unlike the AI `dispatch`, this does NOT hide the toolbar — the user
  // can stack several formats and immediately see each one light up. Toggling a
  // mark changes the selection's marks without moving the caret, so the
  // selectionchange-driven update() does not refire; we refresh manually.
  const runFormat = (fn: () => void) => {
    fn();
    setActiveMarks(getActiveMarks());
  };

  const dispatch = (instruction: string) => {
    const sel = selection || getSelection();
    if (!sel) return;
    // Carry the range captured while the selection was still live, so the
    //「批注」action on the AI reply can anchor the marker exactly (the live
    // selection collapses once the AI panel takes focus).
    onAsk(sel, instruction, rangeRef.current ?? undefined);
    // Hide after dispatch so the toolbar doesn't linger over the panel.
    setVisible(false);
    closeMenus();
    setRewriteOpen(false);
    setFreeOpen(false);
    setAnnoOpen(false);
    setRewriteReq("");
    setFreeText("");
    setAnnoText("");
  };

  // Create a local (non-AI) annotation on the current selection.
  const dispatchAnnotate = () => {
    const sel = selection || getSelection();
    const body = annoText.trim();
    if (!sel || !body) return;
    // Pass the range captured while the selection was live so the marker lands
    // exactly on the chosen text (the live selection has since collapsed).
    onAnnotate(sel, body, rangeRef.current ?? undefined);
    rangeRef.current = null;
    setVisible(false);
    setAnnoOpen(false);
    setAnnoText("");
  };

  const translatePrompt =
    translateDir === "zh2en"
      ? "请把以下文字翻译成英文，只输出译文。\n\n{selection}"
      : "请把以下文字翻译成中文，只输出译文。\n\n{selection}";

  // Open one submenu and close the other + any input popout.
  const toggleColorMenu = () => {
    setColorOpen((o) => !o);
    setAiOpen(false);
    setRewriteOpen(false);
    setFreeOpen(false);
    setAnnoOpen(false);
  };
  const toggleAiMenu = () => {
    setAiOpen((o) => !o);
    setColorOpen(false);
    setRewriteOpen(false);
    setFreeOpen(false);
    setAnnoOpen(false);
  };
  // Open the 改写/问AI input popout from within the AI menu (closes the menu so
  // the input shows cleanly below the toolbar).
  const openRewriteFromMenu = () => {
    setRewriteOpen(true);
    setFreeOpen(false);
    setAnnoOpen(false);
    setAiOpen(false);
  };
  const openFreeFromMenu = () => {
    setFreeOpen(true);
    setRewriteOpen(false);
    setAnnoOpen(false);
    setAiOpen(false);
  };

  const activeColorNorm = activeMarks.color ? normalizeColor(activeMarks.color) : null;

  return (
    <div
      ref={rootRef}
      className={`sel-toolbar${pos.flipDown ? " flip-down" : ""}`}
      style={{ top: `${pos.top}px`, left: `${pos.left}px` }}
      onMouseDown={(e) => e.preventDefault()} // keep the editor selection while clicking
    >
      {/* ---- Formatting (bold / highlight) — toggle in place, don't dismiss. ---- */}
      <button
        className={`sel-btn${activeMarks.bold ? " active" : ""}`}
        title="加粗 (Ctrl+B)"
        onClick={() => runFormat(onBold)}
      >
        <strong>B</strong>
      </button>
      <button
        className={`sel-btn sel-btn-hl${activeMarks.highlight ? " active" : ""}`}
        title="高光 (Ctrl+Shift+H)"
        onClick={() => runFormat(onHighlight)}
      >
        <HighlightIcon size={14} />
      </button>

      <span className="sel-sep" />
      {/* ---- Text color — opens a palette submenu (二级菜单). ---- */}
      <button
        className={`sel-btn${colorOpen ? " active" : ""}`}
        title="文字颜色"
        aria-expanded={colorOpen}
        onClick={toggleColorMenu}
      >
        <TextColorIcon size={14} />
        <span className="sel-caret">
          <ChevronRightIcon size={10} className="chevron open" />
        </span>
      </button>

      {/* ---- AI — opens a vertical action submenu (二级菜单). ---- */}
      <button
        className={`sel-btn${aiOpen ? " active" : ""}`}
        title="AI 操作"
        aria-expanded={aiOpen}
        onClick={toggleAiMenu}
      >
        AI
        <span className="sel-caret">
          <ChevronRightIcon size={10} className="chevron open" />
        </span>
      </button>

      <span className="sel-sep" />
      <button
        className={`sel-btn${annoOpen ? " active" : ""}`}
        title="为选中的文字添加一条批注"
        onClick={() => {
          setAnnoOpen((o) => !o);
          setColorOpen(false);
          setAiOpen(false);
          setRewriteOpen(false);
          setFreeOpen(false);
        }}
      >
        批注…
      </button>

      {/* ============ 文字颜色色板（常驻 DOM，.open 切换，进出过渡）============ */}
      <div className={`sel-submenu sel-color-panel${colorOpen ? " open" : ""}`}>
        {COLOR_PALETTE.map((c, i) => (
          <button
            key={c}
            className={`sel-swatch${activeColorNorm === PALETTE_NORM[i] ? " active" : ""}`}
            style={{ background: c }}
            title={c}
            aria-label={`文字颜色 ${c}`}
            onClick={() => runFormat(() => onSetColor(c))}
          />
        ))}
        <button
          className="sel-swatch sel-swatch-clear"
          title="清除颜色"
          aria-label="清除文字颜色"
          onClick={() => runFormat(onClearColor)}
        >
          <CloseIcon size={11} />
        </button>
      </div>

      {/* ============ AI 二级菜单（常驻 DOM，.open 切换）============ */}
      <div className={`sel-submenu sel-ai-panel${aiOpen ? " open" : ""}`}>
        <button
          className="sel-btn sel-menu-item"
          title="让 AI 解释这段内容"
          onClick={() =>
            dispatch("请解释以下选中的内容，条理清晰地说明其含义。\n\n{selection}")
          }
        >
          解释
        </button>

        <div className="sel-menu-row">
          <button
            className="sel-btn sel-menu-item"
            title="翻译选中的文字"
            onClick={() => dispatch(translatePrompt)}
          >
            翻译
          </button>
          <button
            className="sel-btn sel-dir"
            title={translateDir === "zh2en" ? "中 → 英" : "英 → 中"}
            onClick={() => setTranslateDir((d) => (d === "zh2en" ? "en2zh" : "zh2en"))}
          >
            {translateDir === "zh2en" ? "中→英" : "英→中"}
          </button>
        </div>

        <button
          className={`sel-btn sel-menu-item${rewriteOpen ? " active" : ""}`}
          title="按你的要求改写选中的文字"
          onClick={openRewriteFromMenu}
        >
          改写…
        </button>
        <button
          className={`sel-btn sel-menu-item${freeOpen ? " active" : ""}`}
          title="就选中的内容向 AI 提问"
          onClick={openFreeFromMenu}
        >
          问 AI…
        </button>

        {actions.length > 0 && (
          <>
            <span className="sel-menu-sep" />
            {actions.map((a) => (
              <button
                key={a.label}
                className="sel-btn sel-menu-item"
                title={a.prompt}
                onClick={() => dispatch(a.prompt)}
              >
                {a.label}
              </button>
            ))}
          </>
        )}
      </div>

      {/* ============ 输入弹出层（改写 / 问AI / 批注），挂在工具栏下方 ============ */}
      {annoOpen && (
        <div className="sel-popout sel-popout-anno">
          <textarea
            className="sel-input sel-anno-area"
            autoFocus
            placeholder="批注内容（支持多行），回车换行，Ctrl+Enter 提交"
            value={annoText}
            onChange={(e) => setAnnoText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                dispatchAnnotate();
              }
            }}
          />
          <button className="sel-btn primary" onClick={dispatchAnnotate}>
            添加
          </button>
        </div>
      )}

      {rewriteOpen && (
        <div className="sel-popout">
          <input
            className="sel-input"
            autoFocus
            placeholder="改写要求，如「更简洁」「扩写为 200 字」「改为正式口吻」"
            value={rewriteReq}
            onChange={(e) => setRewriteReq(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const req = rewriteReq.trim() || "请改写得更通顺自然";
                dispatch(`请按以下要求改写选中的文字：${req}。只输出改写后的片段。\n\n{selection}`);
              }
            }}
          />
          <button
            className="sel-btn primary"
            onClick={() => {
              const req = rewriteReq.trim() || "请改写得更通顺自然";
              dispatch(`请按以下要求改写选中的文字：${req}。只输出改写后的片段。\n\n{selection}`);
            }}
          >
            改写
          </button>
        </div>
      )}

      {freeOpen && (
        <div className="sel-popout">
          <input
            className="sel-input"
            autoFocus
            placeholder="针对这段内容的问题，如「这里是什么意思？」"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const q = freeText.trim();
                if (q) dispatch(`关于以下选中内容：${q}\n\n{selection}`);
              }
            }}
          />
          <button
            className="sel-btn primary"
            onClick={() => {
              const q = freeText.trim();
              if (q) dispatch(`关于以下选中内容：${q}\n\n{selection}`);
            }}
          >
            提问
          </button>
        </div>
      )}
    </div>
  );
});

/** True if `node` lives inside the Milkdown editable surface.
 *  WYSIWYG/IR: the ProseMirror contenteditable; SV: the source textarea. */
function editorAreaContains(node: Node | null): boolean {
  if (!node) return false;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  if (!el) return false;
  return !!el.closest(".ProseMirror") || !!el.closest(".mditor-source");
}
