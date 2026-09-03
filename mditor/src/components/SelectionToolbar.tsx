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
import { HighlightIcon, TextColorIcon, ChevronRightIcon, CloseIcon, LinkIcon } from "./icons";

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
  /** Toggle *italic* on the current selection（V3.6）. */
  onItalic: () => void;
  /** Toggle ~~strikethrough~~ on the current selection（V3.6）. */
  onStrike: () => void;
  /** Toggle `inline code` on the current selection（V3.6）. */
  onCode: () => void;
  /** Apply a link to the current selection; null removes it（V4.6.1，接替
   *  crepe Toolbar 停用后的链接按钮）. */
  onLink: (href: string | null) => void;
  /** Toggle $inline math$ on the current selection（V4.6.1，接替 crepe Toolbar
   *  停用后的行内公式按钮）. */
  onMath: () => void;
  /** 打开引用选择器（模块 3）：选中 .bib 条目后在光标处插入 [@citekey]。 */
  onCite: () => void;
  /** 做成闪卡（模块 4）：打开做卡弹层（答案预填选中文本）。 */
  onFlashcard: () => void;
  /** AI 改写为问答卡（模块 4）：AI 生成 Q/A 后经做卡弹层人工确认。 */
  onAiFlashcard: () => void;
  /** Apply a text color to the current selection (rich + source modes). */
  onSetColor: (color: string) => void;
  /** Remove any text color from the current selection. */
  onClearColor: () => void;
  /** Whether the current selection/caret already carries bold / highlight /
   *  italic / strike / code / a text color, so the buttons reflect active state. */
  getActiveMarks: () => {
    bold: boolean;
    highlight: boolean;
    italic: boolean;
    strike: boolean;
    code: boolean;
    color: string | null;
  };
}

type TranslateDir = "zh2en" | "en2zh";

interface Pos {
  top: number;
  left: number;
  flipDown: boolean;
}

type ActiveMarks = {
  bold: boolean;
  highlight: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  color: string | null;
};

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
  onItalic,
  onStrike,
  onCode,
  onLink,
  onMath,
  onCite,
  onFlashcard,
  onAiFlashcard,
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
    italic: false,
    strike: false,
    code: false,
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
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  // Last selection range captured while it was still live. The 批注 popout's
  // <textarea autoFocus> collapses the editor selection once it opens, so we
  // stash the range here (on each selectionchange while the editor holds the
  // selection) and hand it to onAnnotate at submit time.
  const rangeRef = useRef<{ from: number; to: number } | null>(null);
  // getActiveMarks 经 ref 镜像读取：App 侧它是稳定 useCallback（空依赖），
  // 但走 ref 让「挂载一次的监听器永不闭包过期回调」不依赖上游约定（与
  // App 的 fileApiRef 惯例一致），effect deps 也保持最小。
  const getActiveMarksRef = useRef(getActiveMarks);
  getActiveMarksRef.current = getActiveMarks;

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

    // V4.6.1 性能重构：拆成两条路径。
    // · frame（selectionchange 每帧）：只做 collapsed/编辑器包含性判断与隐藏
    //   —— 绝不序列化选区文本。大文档（KaTeX 双份深嵌套 DOM）上
    //   sel.toString() 是 O(选区 DOM)/帧，拖选即准 O(n²)，三击/Ctrl+A 单次
    //   上百 ms，这是拖选 728ms 事件的主付款人。
    // · commit（mouseup/keyup/resize）：选区稳定后才取一次文本 + rect + marks。
    //   取文本走 getSelection()（App→PM textBetween / sv textarea 切片），
    //   绕开 DOM toString 对 KaTeX 公式双份 DOM 的重复序列化。
    const updateFrame = () => {
      // Don't reposition while the user is interacting with the toolbar itself.
      const active = document.activeElement;
      if (rootRef.current && active && rootRef.current.contains(active)) return;
      const sel = window.getSelection();
      const selInEditor =
        !!sel && !sel.isCollapsed && editorAreaContains(sel.anchorNode);
      if (!selInEditor) {
        rangeRef.current = null;
        setVisible(false);
        closeMenus();
      }
      // 非折叠的有效选区：等 commit 再显示/定位（拖选期间工具栏不再跟手移动，
      // 与 Notion 等编辑器一致——松开即出现）。
    };

    const updateCommit = () => {
      // Don't reposition while the user is interacting with the toolbar itself.
      const active = document.activeElement;
      if (rootRef.current && active && rootRef.current.contains(active)) return;
      const sel = window.getSelection();
      const selInEditor =
        !!sel && !sel.isCollapsed && editorAreaContains(sel.anchorNode);
      if (!selInEditor) {
        rangeRef.current = null;
        setVisible(false);
        closeMenus();
        return;
      }
      // 选区已稳定：此刻才付一次序列化的钱（且走 PM 的 textBetween）。
      const text = getSelection().trim();
      if (text.length < 1) {
        // 无文字选区（如纯图片拖选）——同旧行为：不弹工具栏。
        rangeRef.current = null;
        setVisible(false);
        closeMenus();
        return;
      }
      const rect = sel!.getRangeAt(0).getBoundingClientRect();
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
      setActiveMarks(getActiveMarksRef.current());
      setVisible(true);
    };

    // selectionchange 在输入 / 移动光标 / 拖选时高频触发，用 rAF 合并帧内
    // 多次触发；frame 路径本身只读 isCollapsed/包含性（无布局、无序列化）。
    let rafId: number | null = null;
    const scheduleFrame = () => {
      if (rafId != null) return; // 已有一帧挂起，合并本帧内的后续触发
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateFrame();
      });
    };
    const scheduleCommit = () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateCommit();
      });
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setVisible(false);
        closeMenus();
        setRewriteOpen(false);
        setFreeOpen(false);
        setAnnoOpen(false);
        setLinkUrl("");
      }
    };

    // 挂 document 级委托：内存守护会整体重建 .mditor-editor-host 节点，挂在
    // 旧宿主上的 mouseup/keyup 会随节点脱离文档而永久失效。改为监听 document
    // 并在回调里用 closest 判定事件是否来自（任意代次的）编辑器宿主，重建后
    // 无需重新挂载即可继续工作。
    const editorHostFromNode = (node: Node | null): Element | null => {
      if (!node) return null;
      const el =
        node.nodeType === Node.ELEMENT_NODE
          ? (node as Element)
          : node.parentElement;
      return el?.closest(".mditor-editor-host") ?? null;
    };
    const onEditorMouseUp = (e: MouseEvent) => {
      if (editorHostFromNode(e.target as Node | null)) scheduleCommit();
    };
    const onEditorKeyUp = (e: KeyboardEvent) => {
      if (editorHostFromNode(e.target as Node | null)) scheduleCommit();
    };

    const attach = () => {
      document.addEventListener("selectionchange", scheduleFrame);
      document.addEventListener("mouseup", onEditorMouseUp);
      document.addEventListener("keyup", onEditorKeyUp);
      window.addEventListener("resize", scheduleCommit);
      window.addEventListener("keydown", onKey);
      cleanup = () => {
        if (rafId != null) cancelAnimationFrame(rafId);
        rafId = null;
        document.removeEventListener("selectionchange", scheduleFrame);
        document.removeEventListener("mouseup", onEditorMouseUp);
        document.removeEventListener("keyup", onEditorKeyUp);
        window.removeEventListener("resize", scheduleCommit);
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
    // `getSelectionRange`/`getSelection` are stable useCallbacks from App, so
    // listing them is safe and never triggers re-runs; it satisfies
    // exhaustive-deps.
  }, [isReady, getSelectionRange, getSelection]);

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
    setLinkOpen(false);
  }

  /** Apply the typed URL (empty input = remove the link) and close the popout. */
  const applyLink = () => {
    const url = linkUrl.trim();
    onLink(url ? url : null);
    setLinkOpen(false);
    setLinkUrl("");
  };

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
    setLinkUrl("");
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
    setLinkOpen(false);
    setRewriteOpen(false);
    setFreeOpen(false);
    setAnnoOpen(false);
  };
  const toggleAiMenu = () => {
    setAiOpen((o) => !o);
    setColorOpen(false);
    setLinkOpen(false);
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
      {/* ---- Formatting (bold / italic / strike / code / highlight) — toggle in place. ---- */}
      <button
        className={`sel-btn${activeMarks.bold ? " active" : ""}`}
        title="加粗 (Ctrl+B)"
        onClick={() => runFormat(onBold)}
      >
        <strong>B</strong>
      </button>
      <button
        className={`sel-btn${activeMarks.italic ? " active" : ""}`}
        title="斜体"
        onClick={() => runFormat(onItalic)}
      >
        <em>I</em>
      </button>
      <button
        className={`sel-btn${activeMarks.strike ? " active" : ""}`}
        title="删除线"
        onClick={() => runFormat(onStrike)}
      >
        <span style={{ textDecoration: "line-through" }}>S</span>
      </button>
      <button
        className={`sel-btn${activeMarks.code ? " active" : ""}`}
        title="行内代码"
        onClick={() => runFormat(onCode)}
      >
        {"{ }"}
      </button>
      <button
        className={`sel-btn sel-btn-hl${activeMarks.highlight ? " active" : ""}`}
        title="高光 (Ctrl+Shift+H)"
        onClick={() => runFormat(onHighlight)}
      >
        <HighlightIcon size={14} />
      </button>
      <button
        className={`sel-btn${linkOpen ? " active" : ""}`}
        title="插入链接（留空并应用 = 去除链接）"
        aria-expanded={linkOpen}
        onClick={() => {
          setLinkOpen((o) => !o);
          setColorOpen(false);
          setAiOpen(false);
          setRewriteOpen(false);
          setFreeOpen(false);
          setAnnoOpen(false);
        }}
      >
        <LinkIcon size={14} />
      </button>
      <button
        className="sel-btn"
        title="行内公式（选区包裹为 $…$；选中公式时还原为文字）"
        onClick={() => runFormat(onMath)}
      >
        <em>fx</em>
      </button>
      <button
        className="sel-btn"
        title="插入学术引用 [@citekey]（在设置 → 知识功能配置 .bib 文献库）"
        onClick={onCite}
      >
        <em>@</em>
      </button>
      <button
        className="sel-btn"
        title="做成闪卡（答案预填选中文本，插入 :::flash 块）"
        onClick={onFlashcard}
      >
        <em>卡</em>
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
          title="让 AI 把选中内容改写为问答闪卡（人工确认后插入）"
          onClick={onAiFlashcard}
        >
          改写为问答卡
        </button>
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

      {/* ============ 输入弹出层（链接 / 改写 / 问AI / 批注），挂在工具栏下方 ============ */}
      {linkOpen && (
        <div className="sel-popout">
          <input
            className="sel-input"
            autoFocus
            placeholder="链接地址，如 https://example.com"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              }
            }}
          />
          <button className="sel-btn primary" onClick={applyLink}>
            应用
          </button>
        </div>
      )}

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

/** True if `node` lives inside an editable editor surface.
 *  WYSIWYG/IR: the ProseMirror contenteditable; SV: the CodeMirror content or
 *  the fallback source textarea. */
function editorAreaContains(node: Node | null): boolean {
  if (!node) return false;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  if (!el) return false;
  return (
    !!el.closest(".ProseMirror") ||
    !!el.closest(".mditor-source") ||
    !!el.closest(".mditor-sv")
  );
}
