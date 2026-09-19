// Recently opened files. Loaded from the store; click reopens, hover shows path.
//
// Performance: React.memo'd so it only re-renders when `refreshKey` or
// `onOpen` change — not on every keystroke in the editor.
//
// v4.8 多窗口：条目右键「在新窗口打开」（复用共享 ContextMenu 壳）——新窗
// 直接加载该文档，本窗标签不动。

import { memo, useEffect, useState } from "react";
import { loadRecent } from "../lib/store";
import { baseName } from "../lib/tauriFs";
import type { RecentFile } from "../types";
import { MarkdownFileIcon } from "./icons";
import { ContextMenu, type CtxEntry } from "./ContextMenu";

interface Props {
  onOpen: (path: string) => void;
  /** Re-load trigger (bump to refresh after a file is opened/saved). */
  refreshKey: number;
  /** v4.8：右键「在新窗口打开」。 */
  onOpenNewWindow?: (path: string) => void;
}

export const RecentList = memo(function RecentList({ onOpen, refreshKey, onOpenNewWindow }: Props) {
  const [items, setItems] = useState<RecentFile[]>([]);
  // 右键菜单：定位 + 目标路径（复用共享 ContextMenu 壳）。
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string } | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;
    loadRecent()
      .then((r) => {
        if (!cancelled) setItems(r);
      })
      // 加载失败视为无最近列表（与 QuickSwitcher 的处理一致）。
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (items.length === 0) {
    return <div className="rc-empty">暂无最近文件</div>;
  }

  const ctxEntries: CtxEntry[] = ctxMenu
    ? [
        {
          kind: "item",
          key: "open-new-window",
          label: "在新窗口打开",
          fn: () => onOpenNewWindow?.(ctxMenu.path),
        },
      ]
    : [];

  return (
    <ul className="rc-root">
      {items.map((r) => (
        <li
          key={r.path}
          className="rc-row"
          title={r.path}
          onClick={() => onOpen(r.path)}
          onContextMenu={(e) => {
            if (!onOpenNewWindow) return;
            e.preventDefault();
            setCtxMenu({ x: e.clientX, y: e.clientY, path: r.path });
          }}
        >
          <span className="rc-icon">
            <MarkdownFileIcon size={15} />
          </span>
          <span className="rc-name">{r.name || baseName(r.path)}</span>
          <span className="rc-time">{relativeTime(r.openedAt)}</span>
        </li>
      ))}
      {/* v4.8：条目右键「在新窗口打开」 */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          entries={ctxEntries}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </ul>
  );
});

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return "刚刚";
  if (diff < hr) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hr)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(iso).toLocaleDateString();
}
