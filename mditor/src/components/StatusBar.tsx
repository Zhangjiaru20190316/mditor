// Bottom status bar: doc path/name, dirty flag, word count, mode, autosave,
// 以及侧边栏 / AI 面板 / 焦点模式的显式切换按钮（模块 C）。
//
// Wrapped in React.memo: App re-renders on every keystroke (liveMarkdown),
// but StatusBar's props only change when the doc/words/mode actually move —
// so memo lets the footer skip re-renders during typing. Requires App to pass
// stable toggle callbacks (useCallback), which it does.
//
// Mode switching lives HERE: a native <select> drives Editor.switchMode()
// (wysiwyg/ir share one Milkdown instance; sv is a Markdown textarea). A
// dev-only heap readout polls performance.memory (Chromium-only) to make OOM
// growth visible while developing, colored by how close `used` is to the heap
// `limit`. (The editor is Milkdown/ProseMirror — pure JS, fully counted in this
// JS heap. The self-heal in useMemoryGuard recreates the editor — now that
// destroy is awaited — and reloads the page only when that fails to reclaim.)

import { memo, useEffect, useState } from "react";
import type { EditMode } from "../types";
import { formatBytes, getHeapUsage, IS_DEV } from "../lib/memory";
import { SidebarIcon, AiIcon, ExpandIcon } from "./icons";

interface Props {
  name: string;
  path: string | null;
  dirty: boolean;
  words: number;
  mode: string;
  autosaveMsg: string;
  sidebarOpen: boolean;
  aiOpen: boolean;
  focusMode: boolean;
  onToggleSidebar: () => void;
  onToggleAi: () => void;
  onToggleFocus: () => void;
  /** Switch edit mode (destroy + rebuild). Omit to render a static label. */
  onSwitchMode?: (m: EditMode) => void;
}

const MODES: { value: EditMode; label: string }[] = [
  { value: "wysiwyg", label: "所见即所得" },
  { value: "ir", label: "即时渲染" },
  { value: "sv", label: "源码模式" },
];

export const StatusBar = memo(function StatusBar({
  name,
  path,
  dirty,
  words,
  mode,
  autosaveMsg,
  sidebarOpen,
  aiOpen,
  focusMode,
  onToggleSidebar,
  onToggleAi,
  onToggleFocus,
  onSwitchMode,
}: Props) {
  // Dev-only JS-heap readout (Chromium performance.memory). Self-contained so
  // it never re-renders the parent on its 2s tick. The idle leak it tracked was
  // found & fixed (2026-08), so it is now gated behind IS_DEV: visible while
  // developing, off in production builds. Colored by how close `used` is to the
  // heap `limit`; the full rolling log lives at <app-data>/logs/memory.log.
  const [heap, setHeap] = useState<{ used: number; limit: number } | null>(null);
  useEffect(() => {
    if (!IS_DEV) return;
    const tick = () => {
      const h = getHeapUsage();
      setHeap(h ? { used: h.used, limit: h.limit } : null);
    };
    tick();
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
  }, []);
  const heapRatio = heap && heap.limit > 0 ? heap.used / heap.limit : 0;
  const heapColor =
    heapRatio > 0.85 ? "#e53935" : heapRatio > 0.7 ? "#f9a825" : undefined;

  return (
    <footer className="sb-status">
      <button
        className={`sb-icon-btn${sidebarOpen ? " active" : ""}`}
        title="侧边栏 (Ctrl+\)"
        onClick={onToggleSidebar}
      >
        <SidebarIcon size={15} />
      </button>
      <button
        className={`sb-icon-btn${aiOpen ? " active" : ""}`}
        title="AI 面板 (Ctrl+I)"
        onClick={onToggleAi}
      >
        <AiIcon size={15} />
      </button>
      <button
        className={`sb-icon-btn${focusMode ? " active" : ""}`}
        title="焦点模式"
        onClick={onToggleFocus}
      >
        <ExpandIcon size={15} />
      </button>
      <span className="sb-status-sep" />
      <span className="sb-status-name" title={path ?? "未保存"}>
        {name}
        {dirty ? " •" : ""}
      </span>
      <span className="sb-status-sep" />
      <span className="sb-status-words">{words} 字</span>
      {IS_DEV && heap != null && (
        <span
          className="sb-status-heap"
          style={heapColor ? { color: heapColor } : undefined}
          title={`JS 堆 ${formatBytes(heap.used)} / ${formatBytes(heap.limit)}（完整日志：app-data/logs/memory.log）`}
        >
          {formatBytes(heap.used)}
        </span>
      )}
      <span className="sb-status-spacer" />
      <span className={`sb-status-auto${autosaveMsg ? " show" : ""}`}>{autosaveMsg}</span>
      <span className="sb-status-sep" />
      {onSwitchMode ? (
        <label className="sb-status-mode-wrap" title="切换编辑模式（重建编辑器以释放内存）">
          <select
            className="sb-status-mode"
            value={mode}
            onChange={(e) => onSwitchMode(e.target.value as EditMode)}
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span className="sb-status-mode">{modeLabel(mode)}</span>
      )}
    </footer>
  );
});

function modeLabel(m: string): string {
  switch (m) {
    case "wysiwyg":
      return "所见即所得";
    case "ir":
      return "即时渲染";
    case "sv":
      return "源码模式";
    default:
      return m;
  }
}
