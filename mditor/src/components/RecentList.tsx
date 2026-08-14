// Recently opened files. Loaded from the store; click reopens, hover shows path.
//
// Performance: React.memo'd so it only re-renders when `refreshKey` or
// `onOpen` change — not on every keystroke in the editor.

import { memo, useEffect, useState } from "react";
import { loadRecent } from "../lib/store";
import { baseName } from "../lib/tauriFs";
import type { RecentFile } from "../types";
import { MarkdownFileIcon } from "./icons";

interface Props {
  onOpen: (path: string) => void;
  /** Re-load trigger (bump to refresh after a file is opened/saved). */
  refreshKey: number;
}

export const RecentList = memo(function RecentList({ onOpen, refreshKey }: Props) {
  const [items, setItems] = useState<RecentFile[]>([]);

  useEffect(() => {
    let cancelled = false;
    loadRecent().then((r) => {
      if (!cancelled) setItems(r);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (items.length === 0) {
    return <div className="rc-empty">暂无最近文件</div>;
  }
  return (
    <ul className="rc-root">
      {items.map((r) => (
        <li
          key={r.path}
          className="rc-row"
          title={r.path}
          onClick={() => onOpen(r.path)}
        >
          <span className="rc-icon">
            <MarkdownFileIcon size={15} />
          </span>
          <span className="rc-name">{r.name || baseName(r.path)}</span>
          <span className="rc-time">{relativeTime(r.openedAt)}</span>
        </li>
      ))}
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
