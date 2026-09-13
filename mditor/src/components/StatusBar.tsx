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

import { memo, useEffect, useMemo, useState } from "react";
import type { EditMode } from "../types";
import { getAdapter } from "../platform";
import { formatBytes, getHeapUsage, IS_DEV } from "../lib/memory";
import { countWords } from "../lib/textStats";
import { useSync } from "../hooks/useSync";
import { SidebarIcon, AiIcon, ExpandIcon, CloudIcon } from "./icons";

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

  // 选区字数统计（V3.6）：自包含监听 selectionchange —— 只在编辑器表面持有
  // 非空选区时显示「已选 N 字」。不上抛父组件（打字零开销）。
  // V4.6.1 性能：旧版 150ms 防抖是「到点即读」——拖选期间每 150ms 就
  // sel.toString() + countWords 一次（KaTeX 大文档上每次都是全选区序列化）。
  // 改为尾随防抖：选区每变化一次就把计时器往后推，只有选区静止 ≥400ms
  // （mouseup/keyup 后 250ms）才读一次文本；拖选全程零序列化。
  const [selWords, setSelWords] = useState(0);
  useEffect(() => {
    let timer: number | null = null;
    const read = () => {
      timer = null;
      const sel = window.getSelection();
      const node = sel?.anchorNode ?? null;
      const el =
        node && node.nodeType === Node.ELEMENT_NODE
          ? (node as Element)
          : node?.parentElement ?? null;
      const inside = !!el?.closest(
        ".ProseMirror, .mditor-source, .mditor-sv .cm-content"
      );
      const text = inside && sel && !sel.isCollapsed ? sel.toString() : "";
      const n = text ? countWords(text) : 0;
      setSelWords((prev) => (prev === n ? prev : n));
    };
    const schedule = (delay: number) => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(read, delay);
    };
    const inEditorSurface = (t: EventTarget | null): boolean => {
      const el =
        t instanceof Element
          ? t
          : t instanceof Node
            ? (t.parentElement ?? null)
            : null;
      return !!el?.closest(".mditor-editor-host, .mditor-source, .mditor-sv");
    };
    const onSelectionChange = () => schedule(400);
    const onEnd = (e: Event) => {
      if (inEditorSurface(e.target)) schedule(250);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mouseup", onEnd);
    document.addEventListener("keyup", onEnd);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("mouseup", onEnd);
      document.removeEventListener("keyup", onEnd);
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);

  // 云同步指示（v4.12）：自包含 useSync 订阅（不穿透父组件），点击 = 手动
  // 同步。四态渲染：idle 灰云 / syncing 旋转 / offline 云+斜杠 / error 红。
  // 鸿蒙运行时不渲染该元素（§7.5.3——不是错误态/转圈，是彻底隐藏）。
  const sync = useSync();
  const syncTooltip = useMemo(() => {
    if (!sync.last) return "云同步：点击立即同步";
    const t = sync.last.lastSyncAt
      ? `上次同步 ${new Date(sync.last.lastSyncAt).toLocaleTimeString()}`
      : "";
    const err = sync.last.error ? `\n${sync.last.error.code}: ${sync.last.error.message}` : "";
    const note = sync.last.status === "offline" ? "\n离线中——恢复网络后自动重试" : "";
    return `云同步：点击立即同步${t ? `\n${t}` : ""}${note}${err}`;
  }, [sync.last]);
  const syncLabel =
    sync.status === "syncing"
      ? "同步中…"
      : sync.status === "offline"
        ? "离线"
        : sync.status === "error"
          ? "同步出错"
          : "已同步";

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
      {selWords > 0 && (
        <span className="sb-status-sel" title="当前选区字数">
          已选 {selWords} 字
        </span>
      )}
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
      {sync.supported && (
        <button
          className={`sb-icon-btn sb-sync-ind sb-sync-${sync.status}`}
          title={syncTooltip}
          aria-label={`云同步：${syncLabel}`}
          onClick={() => {
            // error 态点击弹错误详情（复用平台弹窗）；其余状态点击 = 手动同步。
            if (sync.status === "error" && sync.last?.error) {
              void getAdapter().dialog.message(
                `${sync.last.error.code}：${sync.last.error.message}`,
                { kind: "error", title: "云同步出错" }
              );
              return;
            }
            sync.syncNow();
          }}
        >
          <CloudIcon size={15} className={sync.status === "syncing" ? "spin" : undefined} />
        </button>
      )}
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
