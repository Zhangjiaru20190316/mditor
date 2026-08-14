// Sidebar panel that lists every annotation in the current document.
//
// Annotations live inline as `[^anno-N]` markers (rendered as badges) with
// their bodies hidden in footnote definitions and shown in the
// AnnotationPopover on click. This panel gives a scannable overview:
//   * each row shows the marker number, a snippet of the text it's anchored to,
//     and a clamped preview of the annotation body;
//   * click a row to jump to the marker (and open the popover);
//   * edit inline or delete right from the list.
//
// Re-render cadence mirrors Outline: the annotation list is derived from a
// DEFERRED copy so a fast typist in a large doc doesn't re-render the list on
// every keystroke.

import { memo, useCallback, useDeferredValue, useMemo, useState } from "react";
import type { Annotation } from "../lib/annotations";
import { getAnchorSnippet } from "../lib/annotations";

interface Props {
  annotations: Annotation[];
  /** Live document markdown — used to derive each annotation's anchor snippet. */
  markdown: string;
  /** Jump the editor to the given annotation id and open its popover. */
  onJump: (id: string) => void;
  /** Save edited content for the given id. */
  onUpdate: (id: string, content: string) => void;
  /** Delete the given annotation (marker + definition). */
  onDelete: (id: string) => void;
}

/** Strip light Markdown to a single-line plain-text preview. */
function toPlain(md: string): string {
  return md
    .replace(/^\s*[-+*]\s+/gm, "") // list bullets
    .replace(/^\s*\d+\.\s+/gm, "") // ordered list markers
    .replace(/^\s{0,3}>\s?/gm, "") // blockquote markers
    .replace(/\*\*|__/g, "") // bold
    .replace(/\*/g, "") // italic / leftover asterisks
    .replace(/~~/g, "") // strikethrough
    .replace(/`/g, "") // inline code
    .replace(/\[\^[^\]]*\]/g, "") // footnote refs
    .replace(/\s+/g, " ")
    .trim();
}

export const AnnotationList = memo(function AnnotationList({
  annotations,
  markdown,
  onJump,
  onUpdate,
  onDelete,
}: Props) {
  const deferredAnnos = useDeferredValue(annotations);
  const deferredMd = useDeferredValue(markdown);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // Anchor snippets depend only on (deferred) markdown + ids; recompute cheaply.
  const snippets = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of deferredAnnos) {
      map.set(a.id, getAnchorSnippet(deferredMd, a.id));
    }
    return map;
  }, [deferredAnnos, deferredMd]);

  const beginEdit = useCallback((a: Annotation) => {
    setEditingId(a.id);
    setDraft(a.content);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setDraft("");
  }, []);

  const commitEdit = useCallback(
    (id: string) => {
      onUpdate(id, draft.trim());
      setEditingId(null);
      setDraft("");
    },
    [draft, onUpdate]
  );

  const handleDelete = useCallback(
    (a: Annotation) => {
      if (!confirm(`删除批注 #${a.marker}？`)) return;
      if (editingId === a.id) cancelEdit();
      onDelete(a.id);
    },
    [editingId, cancelEdit, onDelete]
  );

  if (deferredAnnos.length === 0) {
    return (
      <div className="anno-list-empty">
        <p>无批注</p>
        <p className="anno-list-hint">
          选中文字后用浮动工具栏的「批注」按钮，或在 AI 回复上点「批注」即可添加。
        </p>
      </div>
    );
  }

  return (
    <ul className="anno-list">
      {deferredAnnos.map((a) => {
        const editing = editingId === a.id;
        const snippet = snippets.get(a.id) ?? "";
        const plain = toPlain(a.content);
        return (
          <li
            key={a.id}
            className={`anno-item${editing ? " editing" : ""}`}
            onClick={() => !editing && onJump(a.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (editing) return;
              // Only react when the row itself has focus — let the inner
              // buttons handle their own Enter/Space (otherwise pressing Enter
              // on 编辑/删除 would both act on the button and jump).
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onJump(a.id);
              }
            }}
          >
            <div className="anno-item-head">
              <span className="anno-item-badge" title={`批注 #${a.marker}`}>
                #{a.marker}
              </span>
              <span
                className="anno-item-anchor"
                title={snippet || "（未找到锚点文字）"}
              >
                {snippet || "（未锚定到正文）"}
              </span>
              <span className="anno-item-actions">
                {editing ? (
                  <>
                    <button
                      className="anno-item-btn primary"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        commitEdit(a.id);
                      }}
                      title="保存 (Ctrl+Enter)"
                    >
                      保存
                    </button>
                    <button
                      className="anno-item-btn"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        cancelEdit();
                      }}
                      title="取消"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="anno-item-btn"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        beginEdit(a);
                      }}
                      title="编辑这条批注"
                    >
                      编辑
                    </button>
                    <button
                      className="anno-item-btn danger"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(a);
                      }}
                      title="删除这条批注"
                    >
                      删除
                    </button>
                  </>
                )}
              </span>
            </div>
            {editing ? (
              <textarea
                className="anno-item-edit"
                value={draft}
                autoFocus
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    commitEdit(a.id);
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEdit();
                  }
                }}
                placeholder="批注内容…"
              />
            ) : (
              <div className="anno-item-preview" title={plain}>
                {plain || <span className="anno-item-empty">（空批注）</span>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
});
