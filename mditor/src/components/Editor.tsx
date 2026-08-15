// The editor surface: mounts Milkdown (Crepe) and bridges it to the app.
//
// Responsibilities:
//   * create the Milkdown editor via useMilkdown
//   * feed loaded content in (via the `setOnLoaded` mechanism)
//   * dirty tracking + autosave wiring
//   * expose imperative handles (getValue/getHTML/previewEl) up to App for
//     export & copy
//   * forward spellcheck + theme changes
//   * the in-editor find/replace via the SearchBar panel (find() just focuses
//     the surface; the panel drives window.find on the contenteditable)

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useMilkdown } from "../hooks/useMilkdown";
import { useAnnotationMarkers } from "../hooks/useAnnotationMarkers";
import { useFile } from "../hooks/useFile";
import { useAutosave } from "../hooks/useAutosave";
import { useFileWatcher } from "../hooks/useFileWatcher";
import { useMemoryGuard } from "../hooks/useMemoryGuard";
import { BlockContextMenu } from "./BlockContextMenu";
import { persistImage } from "../lib/imageManager";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { basename } from "../lib/path-shim";
import {
  appendAnnotationDefinition,
  nextAnnotationId,
  refToken,
  removeAnnotationFromMd,
  updateAnnotationInMd,
} from "../lib/annotations";
import { formatBytes, getHeapUsage, IS_DEV } from "../lib/memory";
import { logMemory } from "../lib/diagnostics";
import { saveHealSnapshot } from "../lib/session";
import type { EditMode, Settings, BlockInfo, FlatHeading } from "../types";

export interface EditorHandle {
  getValue: () => string;
  setValue: (md: string) => void;
  getHTML: () => string;
  /** Insert markdown at the cursor (used by the AI panel). */
  insertAtCursor: (md: string) => void;
  /** Replace the whole document (used by the AI panel). */
  replaceContent: (md: string) => void;
  /** The rendered preview element (for PNG snapshot). */
  previewEl: () => HTMLElement | null;
  /** sv mode: scroll the source textarea so `line` (0-based) is in view and
   *  place the caret at its start. No-op outside sv mode. Used by outline
   *  jumps, which can't target the hidden Milkdown DOM there. */
  jumpToSourceLine: (line: number) => void;
  /** Focus the editor surface (so find/replace highlights are visible). */
  find: () => void;
  /** Current text selection inside the editor, or "" if none. */
  getSelection: () => string;
  /** Replace the current selection with `md`. Used by AI selection actions. */
  replaceSelection: (md: string) => void;
  /** Insert `md` immediately after the current selection (cursor stays after). */
  insertAfterSelection: (md: string) => void;
  /** Live selection's document positions {from,to}, or null if collapsed. */
  getSelectionRange: () => { from: number; to: number } | null;
  /** Insert `md` at an explicit document position (independent of the live
   *  selection). Used to anchor annotations at a range captured earlier. */
  insertAtPos: (md: string, pos: number) => void;
  /** Place a `[^id]` annotation marker near the anchor (range / anchorText).
   *  Inserts inline for normal prose; when the anchor is inside a block that
   *  can't hold an inline footnote_reference (code_block / math_block / …) it
   *  places a marker paragraph right after that block. Returns false when no
   *  usable spot was found (caller falls back to appending at the tail). */
  insertAnnoMarker: (
    id: string,
    range: { from: number; to: number } | null,
    anchorText?: string
  ) => boolean;
  /** Toggle bold (strong) on the current selection. Works in rich + source modes. */
  toggleBold: () => void;
  /** Toggle ==highlight== on the current selection. Works in rich + source modes. */
  toggleHighlight: () => void;
  /** Apply a text color to the current selection (replaces any existing color).
   *  Stored as `<span style="color:…">`. Works in rich + source modes. */
  setTextColor: (color: string) => void;
  /** Remove any text color from the current selection. */
  clearTextColor: () => void;
  /** Whether the current selection/caret already carries bold / highlight / a
   *  text color, for showing the toolbar buttons' active state. */
  getActiveMarks: () => { bold: boolean; highlight: boolean; color: string | null };
  /** Add an annotation: inserts a `[^anno-N]` marker and appends the definition.
   *  Anchored at `range` when provided (a selection captured while it was still
   *  live — the robust path, since selections collapse once focus moves to a
   *  popover/panel); else the live selection; else the first occurrence of
   *  `anchorText`; else the cursor. Returns the new annotation id, or null if
   *  the editor isn't ready. */
  addAnnotation: (
    content: string,
    anchorText?: string,
    range?: { from: number; to: number } | null
  ) => string | null;
  /** Replace the body of an existing annotation definition. */
  updateAnnotation: (id: string, content: string) => void;
  /** Remove an annotation entirely: strips its marker(s) and definition. */
  removeAnnotation: (id: string) => void;
  /** Whether the editor is currently mounted and ready. */
  ready: () => boolean;
  /**
   * Switch edit mode. wysiwyg/ir share one Milkdown instance (Milkdown is a
   * live WYSIWYG, so they are visually identical); sv is a Markdown source
   * textarea that round-trips through getMarkdown()/replaceAll. Content is
   * preserved; undo history is cleared on the sv ⇄ rich transition. Driven
   * from the StatusBar mode selector and reported back through `onModeChange`.
   */
  switchMode: (m: EditMode) => void;
}

interface Props {
  settings: Settings;
  fileApi: ReturnType<typeof useFile>;
  /** Live markdown change (for outline + word count). */
  onInput?: (md: string) => void;
  /** Live document headings from the ProseMirror doc (rich-mode outline). */
  onHeadings?: (flat: FlatHeading[]) => void;
  onAutosaved?: () => void;
  /** Status-line flash from the file watcher ("已从外部同步" etc). */
  onWatcherStatus?: (msg: string, kind: "sync" | "warn") => void;
  /** Fires with the active mode after the editor (re)builds, for StatusBar. */
  onModeChange?: (m: EditMode) => void;
}

const EDITOR_ID = "mditor-editor";

// memo: App re-renders on every keystroke (word count / dirty state); Editor
// is by far the heaviest child, and its props are all stable across those
// re-renders (fileApi is memoised by useFile; the callbacks come from App as
// useCallback refs), so skipping the reconcile of the whole Milkdown subtree
// on every keystroke is the single biggest typing-path win. [handle] in the
// imperative handle below still refreshes on editor rebuilds as before.
export const Editor = memo(
  forwardRef<EditorHandle, Props>(function Editor(
    { settings, fileApi, onInput, onHeadings, onAutosaved, onWatcherStatus, onModeChange },
    ref
  ) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sourceRef = useRef<HTMLTextAreaElement | null>(null);
  const getContentRef = useRef<() => string>(() => "");
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;
  const onModeChangeRef = useRef(onModeChange);
  onModeChangeRef.current = onModeChange;
  // True while a save write is in flight, so the file watcher ignores events
  // mid-write. Our own write's echo AFTER completion is recognized by content
  // signature (watcherApi.noteSaved), not by this flag — so the flag resets
  // exactly when the write settles instead of after a fixed grace period,
  // which used to swallow a genuine external change landing within it.
  const isSavingRef = useRef(false);
  // Content that arrived via fileApi.onLoaded while Milkdown was still
  // initializing. Replayed into the editor once it becomes ready.
  const pendingContentRef = useRef<string | null>(null);

  // fileApi is consumed through a ref so effects below don't re-subscribe on
  // every fileApi identity change. CRITICAL: useFile memoises fileApi on
  // [..., onLoaded, ...], and onLoaded changes on every setOnLoaded call. An
  // effect that calls fileApi.setOnLoaded and also lists `fileApi` as a dep
  // forms a self-sustaining loop (setOnLoaded → onLoaded changes → fileApi
  // rebuilt → effect re-runs → setOnLoaded → …) that pins React in a render
  // storm and leaks the fileApi useMemo factory closure at ~MB/s — this was
  // the heap leak. setOnLoaded itself is referentially stable, so reading it
  // through a ref breaks the cycle without changing behaviour.
  const fileApiRef = useRef(fileApi);
  fileApiRef.current = fileApi;

  const handle = useMilkdown({
    hostRef,
    sourceRef,
    docPath: () => fileApi.doc.path,
    onInput: (md) => {
      fileApi.markDirty();
      // keep our content mirror in sync for save-without-editor-ready races
      getContentRef.current = () => md;
      onInputRef.current?.(md);
    },
    onHeadings,
    settings,
  });

  // Stamp annotation marker/def attributes after every editor DOM change so
  // CSS can restyle markers into badges and hide their definition blocks.
  useAnnotationMarkers(handle.ready);

  // Wire fileApi.onLoaded so opening a file pushes content into the editor.
  // `fileApi` is deliberately NOT in the dep array — see fileApiRef above. The
  // callback only closes over handle.editor + refs, so re-subscribing purely
  // when the editor instance changes is both correct and loop-free.
  useEffect(() => {
    fileApiRef.current.setOnLoaded((content) => {
      const ed = handle.editor;
      if (ed) {
        // 整篇文档载入：clearStack=true 清空 undo/redo 栈（Milkdown 的
        // replaceAll flush 重建 state，history 随之重置）。
        ed.setValue(content, true);
        pendingContentRef.current = null;
      } else {
        // Editor not ready yet. Buffer the latest content and replay it once
        // ready — otherwise the open is lost and the editor stays blank.
        pendingContentRef.current = content;
      }
      getContentRef.current = () => content;
      // setValue does NOT echo through the onInput listener (it is suppressed),
      // so push the content up manually so the outline / word count update.
      onInputRef.current?.(content);
      void logMemory("file-load");
    });
  }, [handle.editor, handle.ready]);

  // Replay buffered content once Milkdown finishes initializing.
  useEffect(() => {
    if (handle.ready && pendingContentRef.current != null) {
      handle.editor?.setValue(pendingContentRef.current, true);
      pendingContentRef.current = null;
    }
  }, [handle.ready, handle.editor]);

  // Apply theme whenever settings change.
  useEffect(() => {
    handle.applyTheme(settings);
  }, [settings, handle]);

  // Spellcheck on the editable surface (Milkdown's ProseMirror + the source textarea).
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".mditor-milkdown .ProseMirror");
    if (el) el.setAttribute("spellcheck", String(settings.spellcheck));
    if (sourceRef.current) sourceRef.current.setAttribute("spellcheck", String(settings.spellcheck));
  }, [settings.spellcheck, handle.ready, handle.mode]);

  // Report the active mode up to App (for the StatusBar selector) whenever the
  // editor (re)builds / mode changes.
  useEffect(() => {
    onModeChangeRef.current?.(handle.mode);
    void logMemory("mode-switch", { mode: handle.mode });
  }, [handle.mode]);

  // Surface big-document preview degradation as a one-shot status flash each
  // time a freshly built instance lands in degraded mode.
  useEffect(() => {
    if (handle.ready && handle.bigDoc) {
      onWatcherStatus?.(
        "大文档性能模式：已关闭代码高亮与公式渲染以降低内存占用",
        "warn"
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle.ready, handle.bigDoc]);

  // Dev-only heap probe: log JS heap size every 30s to characterise growth
  // across idle / typing / mode-switch. performance.memory is Chromium-only.
  useEffect(() => {
    if (!IS_DEV) return;
    const id = window.setInterval(() => {
      const h = getHeapUsage();
      if (!h) return;
       
      console.debug(
        `[mditor:mem] used=${formatBytes(h.used)} total=${formatBytes(h.total)} limit=${formatBytes(h.limit)}`
      );
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Live reload when the open file is modified externally.
  const watcherApi = useFileWatcher({
    path: fileApi.doc.path,
    dirty: fileApi.doc.dirty,
    getContent: () => handle.editor?.getValue() ?? getContentRef.current(),
    onReload: (content) => {
      handle.editor?.setValue(content, true);
      onInputRef.current?.(content);
      fileApi.markClean();
    },
    onStatus: onWatcherStatus,
    isSavingRef,
  });

  // Autosave.
  useAutosave({
    intervalMs: settings.autosaveIntervalMs,
    dirty: fileApi.doc.dirty,
    hasPath: !!fileApi.doc.path,
    // Fall back to the input mirror when the editor is briefly null during a
    // rebuild, so we never autosave an empty buffer.
    getContent: () => handle.editor?.getValue() ?? getContentRef.current() ?? "",
    doSave: async (getContent) => {
      isSavingRef.current = true;
      try {
        const content = getContent();
        const ok = await fileApi.writeOnly(() => content);
        if (ok) {
          watcherApi.noteSaved(content);
        }
        return ok;
      } finally {
        isSavingRef.current = false;
      }
    },
    onSaved: onAutosaved,
  });

  // Persist current content now. Shared by the memory guard's threshold heal.
  const saveNow = useCallback(async (): Promise<boolean> => {
    isSavingRef.current = true;
    try {
      const content = handle.editor?.getValue() ?? getContentRef.current() ?? "";
      const ok = await fileApi.writeOnly(() => content);
      if (ok) watcherApi.noteSaved(content);
      return ok;
    } finally {
      setTimeout(() => { isSavingRef.current = false; }, 600);
    }
  }, [fileApi, handle, watcherApi]);

  // Tier-2 heal escape hatch: a full webview reload tears down the whole V8
  // context. Snapshot the session first so App can rehydrate (reopen the file
  // or restore untitled content + mode + scroll) after the page reloads. The
  // memory guard escalates to this once a soft recreate fails to dent usage.
  const reloadForHeal = useCallback(() => {
    const ed = handle.editor;
    const path = fileApi.doc.path;
    const scrollEl = document.querySelector<HTMLElement>(".mditor-editor-host");
    saveHealSnapshot({
      path,
      mode: handle.mode,
      scrollTop: scrollEl ? scrollEl.scrollTop : 0,
      untitledContent: path
        ? null
        : ed?.getValue() ?? getContentRef.current() ?? null,
    });
    window.location.reload();
  }, [handle, fileApi]);

  // Memory self-heal, decoupled from autosave. Milkdown has no GopherJS heap,
  // so this is far less likely to fire than under Vditor — but the subsystem
  // is retained (per the migration plan) and stays functional.
  useMemoryGuard({
    enabled: settings.memoryGuard,
    thresholdMb: settings.memoryGuardThresholdMb,
    recreate: handle.recreate,
    reload: reloadForHeal,
    canSave: () => fileApi.doc.dirty && !!fileApi.doc.path,
    save: saveNow,
    onStatus: onWatcherStatus,
  });

  /* ---- 块级右键菜单（仅 wysiwyg/ir；sv 保留 WebView2 原生菜单） ---- */
  const [blockMenu, setBlockMenu] = useState<{ x: number; y: number; info: BlockInfo } | null>(
    null
  );

  // 右键 → 解析点击处的块并弹菜单。目标进入 .ProseMirror（且非输入框）即
  // preventDefault：块解析失败只是不弹菜单，绝不让 WebView2 原生菜单从编辑
  // 区漏出（其余区域的兜底见 main.tsx）。文档级监听沿用 SelectionToolbar 的
  // hit-test 范式；handle 仅在 ready/mode/bigDoc 变化时重建，监听器随其重挂。
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (handle.mode === "sv") return;
      const t = e.target as HTMLElement | null;
      if (!t || !t.closest(".ProseMirror")) return;
      // 输入框（如 Crepe link-tooltip 的链接输入框）保留原生复制/粘贴菜单。
      if (t.closest("input, textarea")) return;
      e.preventDefault();
      const ed = handle.editor;
      if (!ed) return;
      const info = ed.getBlockInfoAt(e.clientX, e.clientY);
      if (!info) return;
      setBlockMenu({ x: e.clientX, y: e.clientY, info });
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [handle]);

  // Ctrl+Shift+↑/↓：块级移动（Notion 手势）。仅富文本模式且焦点在编辑区时
  // 拦截，避免影响 textarea 与其它面板。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (handle.mode === "sv") return;
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const t = e.target as HTMLElement | null;
      if (!t || !t.closest(".ProseMirror")) return;
      const ed = handle.editor;
      if (!ed) return;
      e.preventDefault();
      ed.moveBlock(e.key === "ArrowUp" ? "up" : "down");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handle]);

  // 用系统浏览器打开链接（shell:allow-open 已在 capability 中授予）。
  const openExternal = useCallback(async (url: string) => {
    if (!/^(https?:|mailto:)/i.test(url)) return;
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
    } catch {
      /* shell 插件不可用 — 静默忽略 */
    }
  }, []);

  // 「更换图片」：选文件 → 按文档规则持久化（assets/…）→ 写回可移植引用。
  // 图片节点位置在菜单打开时快照在 info 里；即便文档已变，setImageSrc 会
  // 校验目标仍是 image 节点。
  const replaceImage = useCallback(
    async (pos: number) => {
      const ed = handle.editor;
      if (!ed) return;
      try {
        const picked = await openDialog({
          multiple: false,
          filters: [
            { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"] },
          ],
        });
        if (!picked) return;
        const bytes = await readFile(picked);
        const file = new File([bytes], basename(String(picked)));
        const r = await persistImage(file, fileApiRef.current.doc.path);
        ed.setImageSrc(pos, r.ref);
      } catch {
        /* 选择器取消 / 读取失败 — 静默忽略 */
      }
    },
    [handle]
  );

  const closeBlockMenu = useCallback(() => setBlockMenu(null), []);

  useImperativeHandle(
    ref,
    (): EditorHandle => ({
      getValue: () => handle.editor?.getValue() ?? "",
      setValue: (md) => handle.editor?.setValue(md, true),
      getHTML: () => handle.editor?.getHTML() ?? "",
      insertAtCursor: (md) => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.insertValue(md);
        // insertValue is suppressed on the listener; mark dirty so the change
        // flows into autosave / outline.
        fileApi.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      replaceContent: (md) => {
        const ed = handle.editor;
        if (!ed) return;
        ed.setValue(md, true);
        fileApi.markDirty();
        onInputRef.current?.(md);
      },
      getSelection: () => handle.editor?.getSelection() ?? "",
      replaceSelection: (md) => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.updateValue(md);
        fileApi.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      insertAfterSelection: (md) => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.insertAfter(`\n\n${md}`);
        fileApi.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      getSelectionRange: () => handle.editor?.getSelectionRange() ?? null,
      insertAtPos: (md, pos) => {
        const ed = handle.editor;
        if (!ed) return;
        ed.insertAtPos(md, pos);
        fileApi.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      insertAnnoMarker: (id, range, anchorText) => {
        const ed = handle.editor;
        if (!ed) return false;
        const ok = ed.insertAnnoMarker(id, range, anchorText);
        if (ok) {
          fileApi.markDirty();
          onInputRef.current?.(ed.getValue());
        }
        return ok;
      },
      toggleBold: () => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.toggleBold();
        fileApi.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      toggleHighlight: () => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.toggleHighlight();
        fileApi.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      setTextColor: (color: string) => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.setTextColor(color);
        fileApi.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      clearTextColor: () => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.clearTextColor();
        fileApi.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      getActiveMarks: () =>
        handle.editor?.getActiveMarks() ?? { bold: false, highlight: false, color: null },
      addAnnotation: (content, anchorText, range) => {
        const ed = handle.editor;
        if (!ed) return null;
        ed.focus();
        const before = ed.getValue() ?? "";
        const num = nextAnnotationId(before);
        const id = `anno-${num}`;
        const token = refToken(id);
        let withMarker: string | null = null;
        // Place the marker via the unified resolver. It inserts inline for
        // normal prose, and — when the anchor sits inside a block that can't
        // hold an inline footnote_reference (code_block / math_block / …) —
        // drops a marker paragraph right after that block (an inside insert is
        // silently rejected by the schema, which is why annotating code used
        // to leave a dangling definition with no badge). Returns false when
        // no usable spot exists, in which case we fall back to the tail below.
        if (ed.insertAnnoMarker(id, range ?? null, anchorText)) {
          withMarker = ed.getValue() ?? "";
        }
        // No usable anchor — append the marker to the end of the body so it
        // never appears "at the beginning" unexpectedly.
        if (withMarker === null) {
          const trimmed = before.replace(/\s+$/, "");
          withMarker = trimmed === "" ? token : `${trimmed}${token}`;
        }
        // Append the definition block at the end and re-set the whole doc.
        ed.setValue(appendAnnotationDefinition(withMarker, id, content), true);
        fileApi.markDirty();
        onInputRef.current?.(ed.getValue());
        return id;
      },
      updateAnnotation: (id, content) => {
        const ed = handle.editor;
        if (!ed) return;
        const md = ed.getValue() ?? "";
        const next = updateAnnotationInMd(md, id, content);
        if (next === md) return;
        ed.setValue(next, true);
        fileApi.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      removeAnnotation: (id) => {
        const ed = handle.editor;
        if (!ed) return;
        const md = ed.getValue() ?? "";
        const next = removeAnnotationFromMd(md, id);
        if (next === md) return;
        ed.setValue(next, true);
        fileApi.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      previewEl: () => {
        if (handle.mode === "sv") return null;
        return (
          document.querySelector<HTMLElement>(".mditor-milkdown .ProseMirror") ||
          null
        );
      },
      jumpToSourceLine: (line) => {
        if (handle.mode !== "sv") return;
        const ta = sourceRef.current;
        if (!ta || line < 0) return;
        // Char offset of the line's first character (split is count-limited,
        // so this doesn't copy the whole doc per jump).
        const pos =
          line === 0 ? 0 : ta.value.split("\n", line).join("\n").length + 1;
        ta.setSelectionRange(pos, pos);
        // focus() scrolls the caret's line into view. The textarea soft-wraps,
        // so line-height math can't align the heading to the viewport top —
        // guaranteeing the line is visible is the contract here.
        ta.focus();
      },
      ready: () => handle.ready,
      switchMode: (m) => handle.switchMode(m),
      find: () => handle.editor?.focus(),
    }),
    [handle]
  );

  return (
    <div id={EDITOR_ID} className="mditor-editor-host">
      <div
        ref={hostRef}
        className="mditor-milkdown"
        data-mode={handle.mode}
        hidden={handle.mode === "sv"}
      />
      <textarea
        ref={sourceRef}
        className="mditor-source"
        data-mode={handle.mode}
        hidden={handle.mode !== "sv"}
        placeholder="开始书写…  (源码模式 · Ctrl+S 保存，Ctrl+F 查找)"
      />
      {/* 块级右键菜单：portal 到 body，Editor 仅承载状态与命令桥接 */}
      {blockMenu && handle.editor && (
        <BlockContextMenu
          x={blockMenu.x}
          y={blockMenu.y}
          info={blockMenu.info}
          facade={handle.editor}
          onClose={closeBlockMenu}
          onOpenExternal={(u) => void openExternal(u)}
          onReplaceImage={(p) => void replaceImage(p)}
        />
      )}
    </div>
  );
  })
);
