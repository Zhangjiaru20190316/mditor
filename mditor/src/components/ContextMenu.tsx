// Generic right-click context menu: portal to document.body + click-away
// backdrop + viewport clamping + Escape close.
//
// Extracted from FileTree's internal ContextMenu so the block-level editor
// menu (BlockContextMenu) can share the exact same shell. Enhancements over
// the original:
//   * entries are a typed list built by the caller — header / separator /
//     item (with danger/disabled/hint/active states) / inline input row
//   * viewport clamping re-measures the real size after mount (in a layout
//     effect, before paint) instead of trusting a hardcoded estimate
//   * `onMouseDown` preventDefault keeps the ProseMirror selection alive
//     while the user clicks through the menu (input rows opt out so they can
//     take focus), and the scale-in animation grows from the clamped corner
//     so the menu never appears to "slide" away from the cursor.
//
// Performance: renders only while open; the caller memoises `entries`, and
// the menu itself does no per-frame work (a one-shot measurement on mount).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type CtxEntry =
  | { kind: "header"; key: string; label: string }
  | { kind: "sep"; key: string }
  | {
      kind: "item";
      key: string;
      label: string;
      fn: () => void;
      /** 红色破坏性操作（删除类）。 */
      danger?: boolean;
      /** 置灰不可点。 */
      disabled?: boolean;
      /** 右侧灰色快捷键提示。 */
      hint?: string;
      /** 当前状态匹配（显示 ✓）。 */
      active?: boolean;
      /** 点击后不关闭菜单（用于就地切换菜单形态，如「编辑链接…」）。 */
      keepOpen?: boolean;
    }
  | {
      kind: "input";
      key: string;
      /** 输入框初始值。 */
      initial: string;
      placeholder?: string;
      /** 回车 / 点确定提交；空字符串交由调用方解释（如移除链接）。 */
      onCommit: (value: string) => void;
    };

interface Props {
  /** 打开菜单的屏幕坐标（contextmenu 的 clientX/Y）。 */
  x: number;
  y: number;
  entries: CtxEntry[];
  onClose: () => void;
}

/** Clamp a point so a w×h box anchored at it stays inside the viewport. */
function clampPoint(x: number, y: number, w: number, h: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    left: Math.max(8, Math.min(x, vw - w - 8)),
    top: Math.max(8, Math.min(y, vh - h - 8)),
  };
}

// Rough row heights for the pre-measurement estimate; the real size is
// measured right after mount (before paint), so this only needs to be close.
const EST_HEADER_H = 26;
const EST_ITEM_H = 28;
const EST_SEP_H = 7;
const EST_INPUT_H = 36;
const EST_W = 220;

export function ContextMenu({ x, y, entries, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => {
    let h = 8; // padding
    for (const e of entries) {
      h += e.kind === "header"
        ? EST_HEADER_H
        : e.kind === "sep"
          ? EST_SEP_H
          : e.kind === "input"
            ? EST_INPUT_H
            : EST_ITEM_H;
    }
    return clampPoint(x, y, EST_W, h);
  });

  // Re-clamp against the measured size (layout effect → pre-paint, no jank).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const next = clampPoint(x, y, r.width, r.height);
    if (next.left !== pos.left || next.top !== pos.top) setPos(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y]);

  // Close on Escape; the backdrop handles click-away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The scale-in animation should grow out of the corner nearest the cursor:
  // when the menu got pushed left/up by the clamp, anchor bottom-right instead
  // of top-left so it visually opens "toward" the click.
  const clampedLeft = pos.left < x;
  const clampedTop = pos.top < y;

  // Render at document.body via portal: containers with `transform` +
  // `overflow: hidden` (the sidebar, editor panels) would otherwise clip a
  // `position: fixed` menu. Portaling escapes any containing block so the
  // menu is truly viewport-fixed and aligns with the click position.
  return createPortal(
    <div
      className="ctx-menu-backdrop"
      onMouseDown={(e) => {
        // Click-away close (mousedown feels more immediate than click, and
        // avoids the "click leaked into the page after close" feel).
        const t = e.target as HTMLElement;
        if (menuRef.current && t && menuRef.current.contains(t)) return;
        onClose();
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        const t = e.target as HTMLElement;
        if (menuRef.current && t && menuRef.current.contains(t)) return;
        onClose();
      }}
    >
      <div
        ref={menuRef}
        className="ctx-menu"
        style={{
          left: pos.left,
          top: pos.top,
          transformOrigin: `${clampedLeft ? "right" : "left"} ${clampedTop ? "bottom" : "top"}`,
        }}
        // Keep the editor (ProseMirror) selection alive while the user moves
        // the mouse over / clicks the menu — without this the caret collapses
        // and commands act on the wrong block. Input rows opt out below so
        // they can receive focus.
        onMouseDown={(e) => {
          const t = e.target as HTMLElement;
          if (!t.closest("input, textarea, button.ctx-input-ok")) e.preventDefault();
        }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        role="menu"
      >
        {entries.map((e) =>
          e.kind === "sep" ? (
            <div key={e.key} className="ctx-menu-sep" />
          ) : e.kind === "header" ? (
            <div key={e.key} className="ctx-menu-header">
              {e.label}
            </div>
          ) : e.kind === "input" ? (
            <InputEntry key={e.key} initial={e.initial} placeholder={e.placeholder} onCommit={e.onCommit} />
          ) : (
            <button
              key={e.key}
              className={`ctx-menu-item${e.danger ? " danger" : ""}${e.active ? " active" : ""}`}
              disabled={e.disabled}
              onClick={() => {
                if (e.disabled) return;
                if (!e.keepOpen) onClose();
                e.fn();
              }}
            >
              <span className="ctx-check" aria-hidden>
                {e.active ? "✓" : ""}
              </span>
              <span className="ctx-label">{e.label}</span>
              {e.hint && <span className="ctx-hint">{e.hint}</span>}
            </button>
          )
        )}
      </div>
    </div>,
    document.body
  );
}

/** The inline input row (link editor). Owns its value; Enter or the 确定
 *  button commits; Escape closes the whole menu via the parent's window
 *  listener. */
function InputEntry({
  initial,
  placeholder,
  onCommit,
}: {
  initial: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const commit = () => onCommit(value.trim());
  return (
    <div className="ctx-input-row">
      <input
        className="ctx-input"
        autoFocus
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
      <button className="ctx-input-ok" title="确定" onClick={commit}>
        ✓
      </button>
    </div>
  );
}
