// Popover that reveals an annotation's content when its marker is clicked.
//
// Annotations live in the document as `[^anno-N]` markers that Milkdown renders
// as <sup data-type="footnote_reference" data-label="anno-N"> badges (restyled
// by annotation.css). This component listens for clicks anywhere on those
// badges, resolves the id from `data-label`, and opens a fixed-position card
// showing the body (looked up from the parsed `annotations` list — with an
// on-demand parse of the live markdown as fallback while the debounced list
// lags behind a fresh insert / file switch). Edit / delete actions call back
// into the editor bridge.
//
// 代码行级批注：当批注带有 codeLine 元数据（锚在代码块内的具体行上，见
// lib/codeAnno.ts）时，打开前先按当前文档内容重新解析行位（跟随内容而非行
// 号），高亮对应代码行（CodeMirror .cm-line / 整块 pre 兜底），popover 贴着
// 第一个高亮行定位；关闭时清掉高亮。
//
// The component is self-contained: drop one instance in and it manages its own
// open/close, positioning, and edit state.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { parseAnnotations, type Annotation } from "../lib/annotations";
import {
  CODE_LINE_HL_CLASS,
  clearCodeLineHighlights,
  highlightCodeLines,
  resolveCodeLines,
} from "../lib/codeAnno";
import { confirmDialog } from "../lib/dialogs";
import type { Theme } from "../types";
import { MarkdownText } from "./MarkdownText";
import { AnnotationIcon, CloseIcon } from "./icons";

interface Props {
  /** Current parsed annotations (used to look up the active one's body). */
  annotations: Annotation[];
  /** Live document markdown — re-resolves code-line anchors against edits. */
  markdown: string;
  /** Save edited content for the given id. */
  onUpdate: (id: string, content: string) => void;
  /** Delete the given annotation (marker + definition). */
  onDelete: (id: string) => void;
  /** App theme, forwarded to the Markdown renderer. */
  theme: Theme;
}

/** CSS selector matching an annotation marker rendered by Vditor. */
const MARKER_SELECTOR =
  'sup[data-type="footnote_reference"][data-label^="anno-"]';

interface Pos {
  left: number;
  top: number;
}

export const AnnotationPopover = memo(function AnnotationPopover({
  annotations,
  markdown,
  onUpdate,
  onDelete,
  theme,
}: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // annotations prop 落后于实时文档（useAnnotations 的 150ms 防抖）：刚插入
  // 批注 / 刚切换文件后的徽章点击，prop 列表里还查不到该 id。点击时刻用
  // markdownRef 现场解析一次作为兜底存到这里，避免弹窗开了立刻被当成
  // “批注不存在”关掉（表现为点击没反应）。
  const [fallback, setFallback] = useState<Annotation | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // activeId 的 ref 镜像：全局监听器只注册一次（mount），回调内读最新值，
  // 避免 activeId 每次变化都重注册 mousedown/keydown。
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  // annotations / markdown 的 ref 镜像（同上，供一次性注册的 mousedown 用）。
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const markdownRef = useRef(markdown);
  markdownRef.current = markdown;

  const active = activeId
    ? annotations.find((a) => a.id === activeId) ??
      (fallback?.id === activeId ? fallback : null)
    : null;

  const close = useCallback(() => {
    setActiveId(null);
    setPos(null);
    setEditing(false);
    setDraft("");
    setFallback(null);
    clearCodeLineHighlights();
  }, []);

  // Close if the active annotation vanished from the document (deleted /
  // rewritten by an external edit). The props list lags the live markdown by
  // its 150ms parse debounce (see useAnnotations), so a missing id is only
  // trusted once a fresh parse of the live document confirms it's really gone.
  useEffect(() => {
    if (!activeId || annotations.some((a) => a.id === activeId)) return;
    if (!parseAnnotations(markdownRef.current).some((a) => a.id === activeId)) {
      close();
    }
  }, [activeId, annotations, close]);

  // Listen for clicks on annotation markers anywhere in the editor surface.
  // 注册一次（close 是稳定的）：是否"当前有打开的批注"通过 activeIdRef 在
  // 回调内读取，无需随 activeId 变化重注册监听器。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      // Click inside the popover itself → keep open.
      if (cardRef.current && target && cardRef.current.contains(target)) return;
      const marker = target?.closest<HTMLElement>(MARKER_SELECTOR);
      if (marker) {
        // Opening / moving between markers — swallow so the editor's own
        // footnote handling (if any) doesn't also fire.
        e.preventDefault();
        e.stopPropagation();
        const id = marker.getAttribute("data-label") ?? "";
        const rect = marker.getBoundingClientRect();
        // 代码行级批注：按当前内容重解行位并高亮；popover 贴第一个高亮行。
        // 解析失败（行内容被删等）或非代码批注 → 回退到 marker 旁定位。
        clearCodeLineHighlights();
        let initialPos: Pos | null = null;
        let anno: Annotation | null =
          annotationsRef.current.find((a) => a.id === id) ?? null;
        if (!anno) {
          // prop 列表还在防抖窗口内 —— 对实时文档现场解析兜底。
          anno = parseAnnotations(markdownRef.current).find((a) => a.id === id) ?? null;
        }
        if (anno?.codeLine) {
          const resolved = resolveCodeLines(markdownRef.current, id, anno.codeLine);
          if (resolved) {
            const lineEl = highlightCodeLines(marker, resolved.start, resolved.end);
            if (lineEl) {
              const r = lineEl.getBoundingClientRect();
              initialPos = { left: r.right + 8, top: r.top };
            }
          }
        }
        setActiveId(id);
        setFallback(anno);
        // Re-derive position on next paint once we know the marker's viewport
        // position is current (it may shift right after a setValue re-render).
        setPos(initialPos ?? { left: rect.right + 8, top: rect.top });
        setEditing(false);
        return;
      }
      // Click anywhere else → close.
      if (activeIdRef.current) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && activeIdRef.current) close();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [close]);

  // Recompute position relative to the marker whenever it opens, clamping into
  // the viewport. Done in useLayoutEffect so the card never flashes off-screen.
  // 代码行级批注优先贴第一个高亮行（.anno-code-line-hl），否则贴 marker。
  useLayoutEffect(() => {
    if (!activeId) return;
    const hl = document.querySelector<HTMLElement>(`.${CODE_LINE_HL_CLASS}`);
    const marker =
      hl ??
      document.querySelector<HTMLElement>(
        `${MARKER_SELECTOR}[data-label="${cssEsc(activeId)}"]`
      );
    if (!marker) return;
    const rect = marker.getBoundingClientRect();
    const cardW = cardRef.current?.offsetWidth ?? 304;
    const margin = 8;
    let left = rect.right + margin;
    if (left + cardW > window.innerWidth - margin) {
      left = rect.left - margin - cardW;
    }
    if (left < margin) left = margin;
    let top = rect.top;
    const maxTop = window.innerHeight - 160;
    if (top > maxTop) top = Math.max(margin, maxTop);
    setPos({ left, top });
    // Re-run not only when the active marker changes, but also when its content
    // changes: editing+saving calls setValue(), which re-renders the editor and
    // can shift the marker, so the card must re-derive its position.
  }, [activeId, active?.content]);

  // Seed the textarea whenever we (re)enter edit mode.
  useEffect(() => {
    if (editing && active) setDraft(active.content);
  }, [editing, active]);

  if (!activeId || !active) return null;

  const commitEdit = () => {
    onUpdate(active.id, draft.trim());
    setEditing(false);
  };

  return (
    <div
      ref={cardRef}
      className={`anno-popover${editing ? " editing" : ""}`}
      style={pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : undefined}
      role="dialog"
      aria-label="批注"
    >
      <div className="anno-popover-head">
        <span className="anno-popover-title">
          <AnnotationIcon size={12} className="anno-popover-title-icon" />
          批注 #{active.marker}
          {active.codeLine && (
            <span className="anno-popover-lines" title="批注锚定的代码行（随内容跟随）">
              代码 第 {active.codeLine.start}
              {active.codeLine.end > active.codeLine.start
                ? `–${active.codeLine.end}`
                : ""}{" "}
              行
            </span>
          )}
        </span>
        <button
          className="anno-popover-close"
          title="关闭"
          onMouseDown={(e) => e.preventDefault()}
          onClick={close}
        >
          <CloseIcon size={13} />
        </button>
      </div>
      {editing ? (
        <div className="anno-popover-body">
          <textarea
            className="anno-edit-area"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commitEdit();
              }
            }}
            placeholder="批注内容…"
          />
        </div>
      ) : (
        <div className="anno-popover-body">
          {active.content ? (
            <MarkdownText content={active.content} theme={theme} />
          ) : (
            <span className="anno-popover-empty">（空批注）</span>
          )}
        </div>
      )}
      <div className="anno-popover-actions">
        {editing ? (
          <>
            <button
              className="anno-btn primary"
              onMouseDown={(e) => e.preventDefault()}
              onClick={commitEdit}
            >
              保存 (Ctrl+Enter)
            </button>
            <button
              className="anno-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setEditing(false)}
            >
              取消
            </button>
          </>
        ) : (
          <>
            <button
              className="anno-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setEditing(true)}
            >
              编辑
            </button>
            <button
              className="anno-btn danger"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                void (async () => {
                  if (await confirmDialog("删除这条批注？")) {
                    onDelete(active.id);
                    close();
                  }
                })();
              }}
            >
              删除
            </button>
          </>
        )}
      </div>
    </div>
  );
});

/** Escape a value for safe use inside a CSS attribute selector. */
function cssEsc(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}
