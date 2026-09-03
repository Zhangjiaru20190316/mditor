// `[[` 输入补全弹层（v4.7 双链）：监听编辑器表面的 selectionchange，向
// EditorHandle.getWikiLinkContext 查询光标前是否存在未闭合的 `[[query`；
// 有则列出 vaultIndex 候选（<100ms），↑↓/Enter/Esc 键盘操作，选中后经
// insertWikiLinkAt 替换 `[[query` 为 `[[target]]` 原文（编辑器 remark 插件
// 随即解析为节点）。
//
// 定位：跟随光标的 getBoundingClientRect（selectionchange 时刷新）；失败
// 退化为编辑器容器上方居中。

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { vaultIndex, type VaultEntry } from "../lib/vaultIndex";
import { toPosix } from "../lib/path-shim";

interface Props {
  /** 编辑器是否就绪（未就绪时静默不弹）。 */
  isReady: () => boolean;
  getWikiLinkContext: () => { from: number; query: string } | null;
  /** 用 `md` 替换 [from, 光标)。 */
  insertWikiLinkAt: (md: string, from: number) => void;
  /** 功能开关（设置 wikiLinksEnabled）。 */
  enabled: boolean;
}

const MAX_ITEMS = 12;

interface SuggestState {
  from: number;
  query: string;
  items: VaultEntry[];
  sel: number;
  top: number;
  left: number;
}

export const WikiLinkSuggest = memo(function WikiLinkSuggest({
  isReady,
  getWikiLinkContext,
  insertWikiLinkAt,
  enabled,
}: Props) {
  const [st, setSt] = useState<SuggestState | null>(null);
  // 键盘拦截窗：弹层激活时吃掉 ↑↓/Enter/Esc（capture，避免编辑器先处理）。
  const stRef = useRef<SuggestState | null>(null);
  stRef.current = st;

  const close = useCallback(() => setSt(null), []);

  const refresh = useCallback(() => {
    if (!enabled || !isReady()) {
      setSt(null);
      return;
    }
    const ctx = getWikiLinkContext();
    if (!ctx) {
      setSt((prev) => (prev === null ? prev : null));
      return;
    }
    const items = vaultIndex.suggestTargets(ctx.query, MAX_ITEMS);
    // 光标坐标（尽力而为——拿不到就放编辑器上方）。
    let top = 0;
    let left = 0;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const rects = sel.getRangeAt(0).getClientRects();
      const r = rects.length > 0 ? rects[0] : sel.getRangeAt(0).getBoundingClientRect();
      top = r.bottom + 6;
      left = r.left;
    } else {
      const host = document.querySelector<HTMLElement>(".mditor-editor-host");
      if (host) {
        const b = host.getBoundingClientRect();
        top = b.top + 60;
        left = b.left + 40;
      }
    }
    setSt((prev) => {
      // 同一上下文的 query 没变 & 条目一致 → 保持既有状态（防抖动闪烁）。
      if (
        prev &&
        prev.from === ctx.from &&
        prev.query === ctx.query &&
        prev.items.length === items.length
      ) {
        return prev;
      }
      return { from: ctx.from, query: ctx.query, items, sel: 0, top, left };
    });
  }, [enabled, isReady, getWikiLinkContext]);

  useEffect(() => {
    if (!enabled) return;
    const onSel = () => refresh();
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [enabled, refresh]);

  // 键盘：capture 阶段拦截，避免编辑器 keymap 先消费。
  useEffect(() => {
    if (!st) return;
    const onKey = (e: KeyboardEvent) => {
      const s = stRef.current;
      if (!s) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setSt({ ...s, sel: Math.min(s.sel + 1, s.items.length - 1) });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSt({ ...s, sel: Math.max(s.sel - 1, 0) });
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        pick(s, s.sel);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pick/close 稳定引用
  }, [st != null]);

  const pick = (s: SuggestState, i: number) => {
    const item = s.items[i];
    if (!item) {
      close();
      return;
    }
    const stem = stemLabel(item);
    insertWikiLinkAt(`[[${stem}]]`, s.from);
    close();
  };

  if (!st || st.items.length === 0) return null;
  return (
    <div className="wls-pop" style={{ top: st.top, left: st.left }} role="listbox" aria-label="双链补全">
      {st.items.map((e, i) => (
        <div
          key={e.path}
          className={`wls-item${i === st.sel ? " sel" : ""}`}
          onMouseEnter={() => setSt({ ...st, sel: i })}
          onMouseDown={(ev) => {
            // mousedown（先于编辑器失焦 blur）落定，避免 selectionchange 抖动。
            ev.preventDefault();
            ev.stopPropagation();
            pick(st, i);
          }}
        >
          <span className="wls-title">{e.title}</span>
          <span className="wls-path" title={e.path}>
            {shortPath(e.path)}
          </span>
        </div>
      ))}
    </div>
  );
});

/** 插入文本：带路径消歧的场景（同目录直接文件名；由索引保证唯一名时也是文件名）。 */
function stemLabel(e: VaultEntry): string {
  const posix = toPosix(e.path);
  const base = posix.slice(posix.lastIndexOf("/") + 1).replace(/\.(md|markdown|mdx|mdown)$/i, "");
  return base;
}

function shortPath(p: string): string {
  const posix = toPosix(p);
  const parts = posix.split("/");
  return parts.length > 2 ? "…" + parts.slice(-2).join("/") : posix;
}
