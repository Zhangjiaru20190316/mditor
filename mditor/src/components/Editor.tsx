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
import type { CodeLineMeta } from "../lib/codeAnno";
import { formatBytes, getHeapUsage, IS_DEV } from "../lib/memory";
import { normalizeAnchorText } from "../lib/anchorSearch";
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
   *  jumps, which can't target the hidden Milkdown DOM there. smooth=true
   *  scrolls smoothly (outline jump); default instant (annotation/search
   *  jumps measure rects right after landing). */
  jumpToSourceLine: (line: number, smooth?: boolean) => void;
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
  /** Toggle *italic* on the current selection（V3.6）. */
  toggleItalic: () => void;
  /** Toggle ~~strikethrough~~ on the current selection（V3.6）. */
  toggleStrikethrough: () => void;
  /** Toggle `inline code` on the current selection（V3.6）. */
  toggleInlineCode: () => void;
  /** 把选区变成链接（或以 text 为文字在光标处插入链接）（V3.6）。 */
  insertLink: (href: string, text?: string) => void;
  /** 在光标处插入脚注并追加定义（V3.6）；返回脚注 id 或 null。 */
  insertFootnote: () => string | null;
  /** Apply a text color to the current selection (replaces any existing color).
   *  Stored as `<span style="color:…">`. Works in rich + source modes. */
  setTextColor: (color: string) => void;
  /** Remove any text color from the current selection. */
  clearTextColor: () => void;
  /** Whether the current selection/caret already carries bold / highlight / a
   *  text color, for showing the toolbar buttons' active state. */
  getActiveMarks: () => {
    bold: boolean;
    highlight: boolean;
    italic: boolean;
    strike: boolean;
    code: boolean;
    color: string | null;
  };
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
  /* ---- AI 写回（一步撤销）----
   * 每个方法恰好构成一个撤销步骤（见 MilkdownFacade 的契约说明）。
   * Editor 层统一补 markDirty + onInput 通知（facade 静默了内部回声）。 */
  /** 整篇 AI 写回（改动审查应用 / 替换全文）。 */
  aiWriteDoc: (md: string) => void;
  /** 区间 AI 写回（改动审查选区模式）。 */
  aiWriteRange: (from: number, to: number, md: string) => void;
  /** 光标处 AI 插入。 */
  aiWriteInsert: (md: string) => void;
  /** 批注流式写回收尾：以 baseline 为撤销基线，把批注最终内容一步落盘。 */
  finalizeAnnotation: (id: string, content: string, baseline: string) => void;
  /** 滚动到 needle 首次出现处（改动审查「查看上下文」跳转）。 */
  revealText: (needle: string) => void;
  /** 按内容定位文档区间（选区失效时的回退锚定）。 */
  findTextRange: (needle: string, hint?: number) => { from: number; to: number } | null;
  /** [from,to) 的纯文本（选区有效性校验）。 */
  getTextAt: (from: number, to: number) => string;
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
  // sv 模式的 CodeMirror 宿主（V3.6）。
  const svHostRef = useRef<HTMLDivElement | null>(null);
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
    svHostRef,
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

  // Spellcheck on the editable surface (Milkdown's ProseMirror + the sv surface).
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".mditor-milkdown .ProseMirror");
    if (el) el.setAttribute("spellcheck", String(settings.spellcheck));
    if (sourceRef.current) sourceRef.current.setAttribute("spellcheck", String(settings.spellcheck));
    // CodeMirror 的可编辑层是 .cm-content（contenteditable）。
    const cm = svHostRef.current?.querySelector<HTMLElement>(".cm-content");
    if (cm) cm.setAttribute("spellcheck", String(settings.spellcheck));
  }, [settings.spellcheck, handle.ready, handle.mode, handle.svCm]);

  // 打字机模式（富文本路径，V3.6）：光标行保持在视口中部。sv 模式由
  // CodeMirror 的 isTypewriter 钩子在编辑器内部处理。
  useEffect(() => {
    if (!settings.typewriterMode || handle.mode === "sv") return;
    let raf: number | null = null;
    const centerCaret = () => {
      raf = null;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const node = sel.anchorNode;
      const el =
        node && node.nodeType === Node.ELEMENT_NODE
          ? (node as Element)
          : node?.parentElement ?? null;
      if (!el?.closest(".ProseMirror")) return;
      const host = document.querySelector<HTMLElement>(".mditor-editor-host");
      if (!host) return;
      // 大纲平滑跳转进行中（App.jumpToHeading 在 host 上置的标记）：
      // 跳转落点已按打字机对齐到中部，这里的瞬时居中只会掐断平滑动画。
      if (host.dataset.smoothJump) return;
      const range = sel.getRangeAt(0).cloneRange();
      range.collapse(false); // 光标端（选区拖动时跟随活动端）
      const rects = range.getClientRects();
      const rect =
        rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
      if (!rect || (rect.top === 0 && rect.bottom === 0)) return;
      const hostRect = host.getBoundingClientRect();
      const delta = rect.top + rect.height / 2 - (hostRect.top + host.clientHeight / 2);
      // 死区：半个行高以内不滚，避免每个字符的微抖。
      if (Math.abs(delta) < 16) return;
      host.scrollTop += delta;
    };
    const schedule = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(centerCaret);
    };
    document.addEventListener("selectionchange", schedule);
    return () => {
      document.removeEventListener("selectionchange", schedule);
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [settings.typewriterMode, handle.mode, handle.ready]);

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
      // Record content too (not just clean): snapshotActiveTab trusts
      // doc.content for clean tabs and skips the O(n) serialize.
      fileApi.noteExternalReload(content);
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
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      replaceContent: (md) => {
        const ed = handle.editor;
        if (!ed) return;
        ed.setValue(md, true);
        fileApiRef.current.markDirty();
        onInputRef.current?.(md);
      },
      getSelection: () => handle.editor?.getSelection() ?? "",
      replaceSelection: (md) => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.updateValue(md);
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      insertAfterSelection: (md) => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.insertAfter(`\n\n${md}`);
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      getSelectionRange: () => handle.editor?.getSelectionRange() ?? null,
      insertAtPos: (md, pos) => {
        const ed = handle.editor;
        if (!ed) return;
        ed.insertAtPos(md, pos);
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      insertAnnoMarker: (id, range, anchorText) => {
        const ed = handle.editor;
        if (!ed) return false;
        const ok = ed.insertAnnoMarker(id, range, anchorText);
        if (ok) {
          fileApiRef.current.markDirty();
          onInputRef.current?.(ed.getValue());
        }
        return ok;
      },
      toggleBold: () => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.toggleBold();
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      toggleHighlight: () => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.toggleHighlight();
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      toggleItalic: () => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.toggleItalic();
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      toggleStrikethrough: () => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.toggleStrikethrough();
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      toggleInlineCode: () => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.toggleInlineCode();
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      insertLink: (href, text) => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.insertLink(href, text);
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      insertFootnote: () => {
        const ed = handle.editor;
        if (!ed) return null;
        ed.focus();
        const id = ed.insertFootnote();
        if (id) {
          fileApiRef.current.markDirty();
          onInputRef.current?.(ed.getValue());
        }
        return id;
      },
      setTextColor: (color: string) => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.setTextColor(color);
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      clearTextColor: () => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.clearTextColor();
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      getActiveMarks: () =>
        handle.editor?.getActiveMarks() ?? {
          bold: false,
          highlight: false,
          italic: false,
          strike: false,
          code: false,
          color: null,
        },
      addAnnotation: (content, anchorText, range) => {
        const ed = handle.editor;
        if (!ed) return null;
        ed.focus();
        const before = ed.getValue() ?? "";
        const num = nextAnnotationId(before);
        const id = `anno-${num}`;
        const token = refToken(id);
        // 代码行级批注：锚定选区仍与 anchorText 吻合时，若它落在代码块内，
        // 捕获块内行号锚（随定义持久化为 <!--md:line …--> 元数据）。
        let codeLine: CodeLineMeta | null = null;
        if (
          range &&
          (!anchorText ||
            normalizeAnchorText(ed.getTextAt(range.from, range.to)) ===
              normalizeAnchorText(anchorText))
        ) {
          codeLine = ed.getCodeAnchorAt(range);
        } else if (!range) {
          codeLine = ed.getCodeAnchorAt(ed.getSelectionRange());
        }
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
        // Append the definition block and re-set the whole doc. flush=false：
        // 保留撤销历史，marker 插入与本事务相邻合并为一步撤销（AI 写回契约）。
        ed.setValue(appendAnnotationDefinition(withMarker, id, content, codeLine));
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
        return id;
      },
      updateAnnotation: (id, content) => {
        const ed = handle.editor;
        if (!ed) return;
        const md = ed.getValue() ?? "";
        const next = updateAnnotationInMd(md, id, content);
        if (next === md) return;
        // flush=false：流式更新按相邻合并进同一撤销组；收尾（finalizeAnnotation）
        // 用 baseline 收束为一步。
        ed.setValue(next);
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      removeAnnotation: (id) => {
        const ed = handle.editor;
        if (!ed) return;
        const md = ed.getValue() ?? "";
        const next = removeAnnotationFromMd(md, id);
        if (next === md) return;
        ed.setValue(next);
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      /* ---- AI 写回（一步撤销）---- */
      aiWriteDoc: (md) => {
        const ed = handle.editor;
        if (!ed) return;
        ed.aiWriteDoc(md);
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      aiWriteRange: (from, to, md) => {
        const ed = handle.editor;
        if (!ed) return;
        ed.aiWriteRange(from, to, md);
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      aiWriteInsert: (md) => {
        const ed = handle.editor;
        if (!ed) return;
        ed.focus();
        ed.aiWriteInsert(md);
        fileApiRef.current.markDirty();
        onInputRef.current?.(ed.getValue());
      },
      finalizeAnnotation: (id, content, baseline) => {
        const ed = handle.editor;
        if (!ed) return;
        const md = ed.getValue() ?? "";
        const next = updateAnnotationInMd(md, id, content);
        if (next === md) {
          // 批注定义已不在（被删除）或内容本就相同：不动文档——
          // 此时走 baseline 回卷会把流式期间的其他编辑一并卷掉。
          return;
        }
        ed.aiWriteFinalize(baseline, next);
        fileApiRef.current.markDirty();
        onInputRef.current?.(next);
      },
      revealText: (needle) => handle.editor?.revealText(needle),
      findTextRange: (needle, hint) =>
        handle.editor?.findTextRange(needle, hint) ?? null,
      getTextAt: (from, to) => handle.editor?.getTextAt(from, to) ?? "",
      previewEl: () => {
        if (handle.mode === "sv") return null;
        return (
          document.querySelector<HTMLElement>(".mditor-milkdown .ProseMirror") ||
          null
        );
      },
      jumpToSourceLine: (line, smooth) => {
        if (handle.mode !== "sv") return;
        if (line < 0) return;
        // CodeMirror 优先（居中滚动 + 光标落位），回退旧 textarea 的 focus 滚动。
        handle.editor?.jumpToLine(line, smooth);
      },
      ready: () => handle.ready,
      switchMode: (m) => handle.switchMode(m),
      find: () => handle.editor?.focus(),
    }),
    // fileApi 经 fileApiRef.current 读取：markDirty 目前是稳定回调，但走 ref
    // 让「工厂体永不闭包过期的 fileApi」显式成立——未来往工厂里加任何
    // fileApi 依赖都不会静默过期。handle 是唯一真正变化的依赖（编辑器重建）。
    [handle]
  );

  return (
    <div
      id={EDITOR_ID}
      className="mditor-editor-host"
      data-big={handle.bigDoc ? "" : undefined}
    >
      <div
        ref={hostRef}
        className="mditor-milkdown"
        data-mode={handle.mode}
        hidden={handle.mode === "sv"}
      />
      <div
        ref={svHostRef}
        className="mditor-sv"
        data-mode={handle.mode}
        hidden={handle.mode !== "sv"}
      />
      <textarea
        ref={sourceRef}
        className="mditor-source"
        data-mode={handle.mode}
        hidden={handle.mode !== "sv" || handle.svCm}
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
