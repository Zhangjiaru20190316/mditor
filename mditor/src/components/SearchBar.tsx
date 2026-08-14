// Find & replace panel. Vditor binds Ctrl+F / Ctrl+H to its own overlay, so
// for full Typora parity we provide our own panel that operates on the
// contentEditable surface using Selection APIs, plus a "replace all" that
// works on the raw markdown (more reliable than DOM-range bulk replace).
//
// Performance: React.memo'd. App passes stable useCallback props so the panel
// skips re-renders during typing (it only re-renders when `open` flips or the
// find/replace text changes via its own state).

import { memo, useEffect, useRef, useState } from "react";
import { CloseIcon } from "./icons";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Read raw markdown (for replace-all). */
  getMarkdown: () => string;
  /** Set raw markdown (after replace-all). */
  setMarkdown: (md: string) => void;
  /** Focus the editor surface so highlight navigation is visible. */
  focusEditor: () => void;
}

export const SearchBar = memo(function SearchBar({ open, onClose, getMarkdown, setMarkdown, focusEditor }: Props) {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [count, setCount] = useState(0);
  const findRef = useRef<HTMLInputElement>(null);

  // focus the find field when opening
  useEffect(() => {
    if (open) findRef.current?.focus();
  }, [open]);

  // recompute matches
  useEffect(() => {
    if (!find) {
      setCount(0);
      return;
    }
    const md = getMarkdown();
    const flags = caseSensitive ? "g" : "gi";
    try {
      const re = new RegExp(escapeRegExp(find), flags);
      setCount((md.match(re) ?? []).length);
    } catch {
      setCount(0);
    }
  }, [find, caseSensitive, getMarkdown]);

  // keyboard: Esc closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const highlightNext = () => {
    focusEditor();
    // Milkdown WYSIWYG/IR renders into an editable .ProseMirror; source mode
    // uses a .mditor-source textarea. window.find works on the contenteditable.
    const editable = document.querySelector<HTMLElement>(
      ".mditor-milkdown .ProseMirror, .mditor-source"
    );
    if (!editable || !find) return;
    const sel = window.getSelection();
    const rootRange = document.createRange();
    rootRange.selectNodeContents(editable);
    // use built-in find via window.find when available
    const w = window as unknown as { find?: (s: string, cs?: boolean, bw?: boolean) => boolean };
    if (typeof w.find === "function") {
      w.find(find, caseSensitive, false);
    } else {
      sel?.removeAllRanges();
      sel?.addRange(rootRange);
    }
  };

  const replaceOne = () => {
    // Replace the currently-selected occurrence if it matches.
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !find) return;
    const text = sel.toString();
    const matches = caseSensitive ? text === find : text.toLowerCase() === find.toLowerCase();
    if (!matches) return;
    document.execCommand("insertText", false, replace);
  };

  const replaceAll = () => {
    if (!find) return;
    const md = getMarkdown();
    const flags = caseSensitive ? "g" : "gi";
    let next: string;
    try {
      next = md.replace(new RegExp(escapeRegExp(find), flags), replace);
    } catch {
      return;
    }
    setMarkdown(next);
    setCount(0);
  };

  return (
    <div className="sb-root" role="dialog" aria-label="查找替换">
      <div className="sb-row">
        <input
          ref={findRef}
          className="sb-input"
          placeholder="查找…"
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
        <button className="sb-btn" onClick={highlightNext} title="查找下一个">↓</button>
        <label className="sb-toggle" title="区分大小写">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          Aa
        </label>
        <span className="sb-count">{find ? `${count} 个` : ""}</span>
        <button className="sb-close" onClick={onClose} title="关闭 (Esc)"><CloseIcon size={13} /></button>
      </div>
      <div className="sb-row">
        <input
          className="sb-input"
          placeholder="替换为…"
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
        />
        <button className="sb-btn" onClick={replaceOne} title="替换当前">替换</button>
        <button className="sb-btn sb-primary" onClick={replaceAll} title="全部替换">
          全部替换
        </button>
      </div>
    </div>
  );
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
