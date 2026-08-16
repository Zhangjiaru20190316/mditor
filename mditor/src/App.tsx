// App shell: layout (sidebar + editor + status), menu event handling, global
// shortcuts, and the wiring between editor / file system / export / clipboard.

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import { readTextFile, readFile } from "@tauri-apps/plugin-fs";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Editor, type EditorHandle } from "./components/Editor";
import { FileTree, type TreeChange } from "./components/FileTree";
import { Outline } from "./components/Outline";
import { RecentList } from "./components/RecentList";
import { AiPanel, type AiPanelHandle, type ApplyChangesPayload } from "./components/AiPanel";
import { SelectionToolbar } from "./components/SelectionToolbar";
import { AnnotationPopover } from "./components/AnnotationPopover";
import { AnnotationList } from "./components/AnnotationList";
import { SearchBar } from "./components/SearchBar";
import { StatusBar } from "./components/StatusBar";
import { SettingsModal } from "./components/SettingsModal";
import { TitleBar } from "./components/TitleBar";
import { AboutModal } from "./components/AboutModal";
import { TabsBar } from "./components/TabsBar";
import { WorkspaceSearch } from "./components/WorkspaceSearch";
import { TemplateModal } from "./components/TemplateModal";
import { LinkDialog } from "./components/LinkDialog";
import { renderTemplate, type DocTemplate } from "./lib/templates";
import type { SearchHit } from "./lib/workspaceSearch";
import { persistImage } from "./lib/imageManager";
import {
  FileTreeIcon,
  OutlineIcon,
  RecentIcon,
  AnnotationIcon,
  FolderIcon,
  ExpandIcon,
  ChevronRightIcon,
  AiIcon,
  SidebarIcon,
  SearchIcon,
} from "./components/icons";
import { useSettings } from "./hooks/useSettings";
import { useFile } from "./hooks/useFile";
import { useResizable } from "./hooks/useResizable";
import { useAnnotations } from "./hooks/useAnnotations";
import { findAnnotationRefLine } from "./lib/annotations";
import { buildAnnotationMessages, chatStream, isAiConfigured } from "./lib/ai";
import { normalizeAnchorText } from "./lib/anchorSearch";
import { baseName, pickFolder, dirOf, MD_EXT_RE } from "./lib/tauriFs";
import { readCached } from "./lib/filePrefetch";
import { toPosix } from "./lib/path-shim";
import { exportHtml, exportPdf, exportPng, exportDocx } from "./lib/exporter";
import { copyRich } from "./lib/clipboard";
import { showAlert, confirmDialog, choiceDialog } from "./lib/dialogs";
import { getWorkspace, setWorkspace, clearRecentPath } from "./lib/store";
import { dismissSplash } from "./lib/splash";
import { takeHealSnapshot } from "./lib/session";
import { countWords } from "./lib/textStats";
import type { FlatHeading, OutlineNode, TabItem } from "./types";

type SidebarTab = "tree" | "outline" | "recent" | "annotations" | "search";

/** Minimum visible duration of the file-switch animation (ms). The loading bar
 *  always plays at least this long so every switch — even a cached/instant one
 *  — gives clear feedback. Kept short so quick switching never feels sluggish. */
const MIN_SWITCH_MS = 300;

/** 路径 → 标签匹配键（Windows 大小写不敏感 + 分隔符归一）。 */
function tabPathKey(p: string): string {
  return toPosix(p).toLowerCase();
}

export default function App() {
  const settingsApi = useSettings();
  const fileApi = useFile();
  const editorRef = useRef<EditorHandle>(null);
  const aiPanelRef = useRef<AiPanelHandle>(null);

  // -- Stabilise hooks values that change every render (plain-object returns)
  // -- so the menu & keyboard effects below register only ONCE.
  const fileApiRef = useRef(fileApi);
  fileApiRef.current = fileApi;
  const settingsRef = useRef(settingsApi);
  settingsRef.current = settingsApi;

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("tree");
  const [workspace, setWs] = useState<string | null>(null);
  // Ref mirror of `workspace` so the stable `openPath` callback can read the
  // current workspace without depending on it (keeps its dep array empty).
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [recentKey, setRecentKey] = useState(0);
  const [autosaveMsg, setAutosaveMsg] = useState("");
  // 单一定时器跟踪状态栏消息的自动清除：连续触发（快速保存 / 文件频繁外部
  // 修改）时先清掉前一个定时器再设新的，避免定时器堆积与过期 closure 持有状态。
  const statusTimerRef = useRef<number | undefined>(undefined);
  const [liveMarkdown, setLiveMarkdown] = useState("");
  // Headings extracted from the live ProseMirror doc (rich-mode outline source;
  // ids are Milkdown's own <hN id>s so outline jumps can't miss). Null until
  // the editor reports its first heading set.
  const [docHeadings, setDocHeadings] = useState<FlatHeading[] | null>(null);
  const [editMode, setEditMode] = useState<"wysiwyg" | "ir" | "sv">("wysiwyg");

  // ---- 多标签页（V3.6）------------------------------------------------------
  // 只有活动标签住在编辑器/useFile 里；切走时把 live 内容快照进 TabItem。
  // 未命名脏缓冲随标签往返保留；有路径的标签切走前静默自动保存（与
  // autosave 同一哲学：落盘优于弹窗）。fileNew/打开文件 = 新标签。
  const [tabs, setTabs] = useState<TabItem[]>([
    { key: "untitled-1", path: null, name: "未命名.md", dirty: false, content: "" },
  ]);
  const [activeKey, setActiveKey] = useState("untitled-1");
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const untitledSeqRef = useRef(1);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkDialogText, setLinkDialogText] = useState("");

  /** 编辑器当前内容（tab 快照 / 保存都用它）。 */
  const getCurrentContent = useCallback(
    () => editorRef.current?.getValue() ?? liveMdRef.current ?? "",
    []
  );

  /** 把活动标签的 live 状态写回 tabs 数组（切走前调用）。 */
  const snapshotActiveTab = useCallback(() => {
    const key = activeKeyRef.current;
    const doc = fileApiRef.current.doc;
    const content = getCurrentContent();
    setTabs((ts) =>
      ts.map((t) => (t.key === key ? { ...t, path: doc.path, dirty: doc.dirty, content } : t))
    );
  }, [getCurrentContent]);

  /** 切换标签页：切走前快照（有路径且脏 → 静默保存）；干净的目标标签重读
   *  磁盘（捕捉外部修改），脏标签恢复快照。freshContent 供 openPath 传入
   *  已读好的内容避免二次 IO。 */
  const activateTab = useCallback(
    async (key: string, freshContent?: string) => {
      if (key === activeKeyRef.current) return;
      const target = tabsRef.current.find((t) => t.key === key);
      if (!target) return;
      const curDoc = fileApiRef.current.doc;
      const curKey = activeKeyRef.current;
      const curContent = getCurrentContent();
      let curDirty = curDoc.dirty;
      if (curDoc.dirty && curDoc.path) {
        try {
          await fileApiRef.current.writeOnly(() => curContent);
          curDirty = false;
        } catch {
          /* 写失败：保留脏快照，切回来还在 */
        }
      }
      let content = target.content;
      if (target.path && !target.dirty) {
        content = freshContent ?? target.content;
        if (freshContent === undefined) {
          try {
            content = await readTextFile(target.path);
          } catch {
            /* 文件被删？退回快照 */
          }
        }
      }
      setTabs((ts) =>
        ts.map((t) =>
          t.key === curKey
            ? { ...t, path: curDoc.path, dirty: curDirty, content: curContent }
            : t
        )
      );
      setActiveKey(key);
      activeKeyRef.current = key;
      fileApiRef.current.showDoc({ path: target.path, content, dirty: target.dirty });
      // 轻量切换动画（复用文件切换的 loading bar）。
      setPendingPath(target.path);
      setDocSwitching(true);
      window.setTimeout(() => {
        if (activeKeyRef.current === key) {
          setPendingPath(null);
          setDocSwitching(false);
        }
      }, 200);
    },
    [getCurrentContent]
  );

  /** 新建未命名标签（模板内容可选）。当前若是一个干净的空未命名标签且新建
   *  内容也为空（Ctrl+N），则原位替换而不是叠出第二个空标签。 */
  const newUntitledTab = useCallback(
    (content = "") => {
      const curActive = tabsRef.current.find((t) => t.key === activeKeyRef.current);
      const replaceCurrent =
        content === "" &&
        !!curActive &&
        curActive.path == null &&
        !curActive.dirty &&
        curActive.content === "";
      if (replaceCurrent && curActive) {
        // 原地清空即可（内容本就是空）。
        fileApiRef.current.newDoc();
        return;
      }
      snapshotActiveTab();
      const key = `untitled-${++untitledSeqRef.current}`;
      setTabs((ts) => [
        ...ts,
        { key, path: null, name: "未命名.md", dirty: content !== "", content },
      ]);
      setActiveKey(key);
      activeKeyRef.current = key;
      fileApiRef.current.showDoc({ path: null, content, dirty: content !== "" });
      setDocSwitching(true);
      window.setTimeout(() => setDocSwitching(false), 200);
    },
    [snapshotActiveTab]
  );

  /** 关闭标签：有路径且脏 → 先保存；未命名且脏 → 确认丢弃；关最后一个
   *  → 回到一个干净的未命名标签。 */
  const closeTab = useCallback(
    async (key: string) => {
      const cur = tabsRef.current;
      const idx = cur.findIndex((t) => t.key === key);
      if (idx < 0) return;
      const target = cur[idx];
      let content = target.content;
      let dirty = target.dirty;
      const isActive = key === activeKeyRef.current;
      if (isActive) {
        content = getCurrentContent();
        dirty = fileApiRef.current.doc.dirty;
      }
      if (dirty && target.path) {
        try {
          if (isActive) {
            await fileApiRef.current.writeOnly(() => content);
          } else {
            const { saveMd } = await import("./lib/tauriFs");
            await saveMd(target.path, content);
          }
          dirty = false;
        } catch {
          /* 保存失败继续关闭（内存快照已丢弃前提示） */
        }
      } else if (dirty && !target.path) {
        const ok = await confirmDialog(
          `「${target.name}」有未保存的内容，关闭后将丢失。确认关闭？`
        );
        if (!ok) return;
      }
      const remaining = cur.filter((t) => t.key !== key);
      if (remaining.length === 0) {
        const k = `untitled-${++untitledSeqRef.current}`;
        setTabs([{ key: k, path: null, name: "未命名.md", dirty: false, content: "" }]);
        setActiveKey(k);
        activeKeyRef.current = k;
        fileApiRef.current.newDoc();
        return;
      }
      setTabs(remaining);
      if (isActive) {
        const next = remaining[Math.min(idx, remaining.length - 1)];
        setActiveKey(next.key);
        activeKeyRef.current = next.key;
        fileApiRef.current.showDoc({
          path: next.path,
          content: next.content,
          dirty: next.dirty,
        });
      }
    },
    [getCurrentContent]
  );

  // 「注册一次」的全局监听（keydown / drag-drop）经 ref 取最新标签页回调。
  const activateTabRef = useRef(activateTab);
  activateTabRef.current = activateTab;
  const closeTabRef = useRef(closeTab);
  closeTabRef.current = closeTab;

  // 活动 useFile 状态（saveAs 改路径 / dirty 变化）同步回标签记录。
  useEffect(() => {
    const doc = fileApi.doc;
    setTabs((ts) =>
      ts.map((t) => {
        if (t.key !== activeKeyRef.current) return t;
        const name = doc.path ? baseName(doc.path) : "未命名.md";
        if (t.path === doc.path && t.dirty === doc.dirty && t.name === name) return t;
        return { ...t, path: doc.path, name, dirty: doc.dirty };
      })
    );
  }, [fileApi.doc]);

  // ---- iOS-style 「先响应动画，再加载内容」file switching ----
  // pendingPath: optimistically highlighted in the file tree the instant a row
  //   is clicked — before the file is even read. Gives immediate visual
  //   acknowledgement (<1 frame) the way iOS list taps do.
  // docSwitching: drives the top loading bar + editor opacity dip while the
  //   new document is being read and rendered into Vditor.
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [docSwitching, setDocSwitching] = useState(false);
  // Token guard so a rapid second click (A → B before A finishes loading)
  // doesn't let A's late result overwrite B. Only the newest click's load is
  // committed to the editor; superseded loads bail out silently.
  const switchTokenRef = useRef(0);
  // Tracks the deferred clear of the switching UI (see openPath). Held in a ref
  // so a newer click can cancel a still-pending min-duration timer on entry,
  // preventing stale timers from stacking / clearing state at the wrong time.
  const switchClearTimerRef = useRef<number | undefined>(undefined);

  // 面板宽度拖拽调节（模块 C）：拖拽中直接改 CSS 变量保证跟手，松手时持久化。
  const sidebarResize = useResizable({
    side: "left",
    min: 180,
    max: 480,
    getWidth: () => settingsRef.current.settings.sidebarWidth,
    onMove: (w) =>
      document.documentElement.style.setProperty("--sidebar-width", `${w}px`),
    onCommit: (w) => void settingsRef.current.update({ sidebarWidth: w }),
    resetWidth: 260,
  });
  const aiResize = useResizable({
    side: "right",
    min: 280,
    max: 600,
    getWidth: () => settingsRef.current.settings.aiPanelWidth,
    onMove: (w) =>
      document.documentElement.style.setProperty("--ai-panel-width", `${w}px`),
    onCommit: (w) => void settingsRef.current.update({ aiPanelWidth: w }),
    resetWidth: 360,
  });
  const focusMode = settingsApi.settings.focusMode;

  // load saved workspace on boot
  useEffect(() => {
    getWorkspace()
      .then(setWs)
      // 工作区恢复失败也要放行开屏，不能把用户挡在主界面外
      .catch(() => undefined)
      .finally(() => {
        // 双 rAF：等「外壳 + 恢复的工作区」首帧提交后再淡出开屏，
        // 保证开屏下方不是空壳（与 openPath 里的双 rAF 同理）
        requestAnimationFrame(() => requestAnimationFrame(dismissSplash));
      });
  }, []);

  // Cancel any pending live-markdown rAF on unmount so a late flush can't
  // setState after the component is gone.
  useEffect(() => {
    return () => {
      if (liveMdRafRef.current != null) cancelAnimationFrame(liveMdRafRef.current);
    };
  }, []);

  const openPath = useCallback(
    async (path: string) => {
      // Take a token so a newer click can supersede this one mid-flight.
      const token = ++switchTokenRef.current;
      // A prior switch may still be inside its min-duration window with a
      // pending clear timer — cancel it so it can't fire under this (newer)
      // click and prematurely drop the loading bar.
      if (switchClearTimerRef.current != null) {
        window.clearTimeout(switchClearTimerRef.current);
        switchClearTimerRef.current = undefined;
      }
      // Phase 1 — INSTANT RESPONSE (<1 frame, the iOS pattern):
      //   * highlight the clicked row optimistically (pendingPath)
      //   * raise the loading bar + dim the editor (docSwitching) RIGHT AWAY
      //   * kick off the file read concurrently (async IPC — doesn't block the
      //     main thread, so the paint below can still commit)
      //   * then YIELD two frames. The double-rAF guarantees the browser has
      //     committed the highlight + shimmer frame before we touch the editor —
      //     without this, the click and the heavy setValue land in the same
      //     blocked frame and the whole gesture feels sluggish.
      // 切换动画始终可见：点击瞬间即出 loading bar + dim（不再经 150ms 门控），
      // 并保证至少 MIN_SWITCH_MS 可见时长——否则命中预读缓存的瞬时切换会完全
      // 跳过动画，体感上"动画没了"。
      setPendingPath(path);
      setDocSwitching(true);
      const startedAt = performance.now();
      // 优先查预读缓存（文件树 hover 时已预读）；命中则跳过 readTextFile。
      const cached = readCached(path);
      const readP = cached !== undefined ? Promise.resolve(cached) : readTextFile(path);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      try {
        const content = await readP;
        // A newer click superseded us while we were waiting — drop this load
        // so the user never sees file A flash in after they clicked B.
        if (token !== switchTokenRef.current) return;
        // 多标签页：已打开的文件 → 激活既有标签（干净标签用刚读的新内容）；
        // 新文件 → 新标签；唯一例外：当前是干净的空未命名标签 → 原位替换
        // （首个文件打开不会凭空多出一个标签）。
        const pk = tabPathKey(path);
        const existing = tabsRef.current.find(
          (t) => t.path != null && tabPathKey(t.path) === pk
        );
        if (existing && existing.key !== activeKeyRef.current) {
          await activateTab(existing.key, existing.dirty ? undefined : content);
        } else if (!existing) {
          const curActive = tabsRef.current.find((t) => t.key === activeKeyRef.current);
          const replaceCurrent =
            !!curActive && curActive.path == null && !curActive.dirty && curActive.content === "";
          const key = replaceCurrent && curActive ? curActive.key : `file-${pk}`;
          const tab: TabItem = {
            key,
            path,
            name: baseName(path),
            dirty: false,
            content,
          };
          if (replaceCurrent && curActive) {
            // 原位替换（沿用旧 key，避免 DOM 重建）：无需快照被替换的标签。
            setTabs((ts) => ts.map((t) => (t.key === key ? tab : t)));
          } else {
            snapshotActiveTab();
            setTabs((ts) => [...ts, tab]);
          }
          setActiveKey(key);
          activeKeyRef.current = key;
          await fileApiRef.current.openPath(path, content);
        }
        if (token !== switchTokenRef.current) return;
        setRecentKey((k) => k + 1);
        // 外部打开的文件若不在当前工作区内，自动把其所在目录设为工作区，
        // 使该文件出现在侧边栏文件树导航中（否则文件树只显示工作区内的文件）。
        const fileDir = toPosix(dirOf(path));
        const ws = workspaceRef.current;
        const inWs = !!ws && (fileDir === toPosix(ws) || fileDir.startsWith(toPosix(ws) + "/"));
        if (!inWs) {
          const dir = dirOf(path);
          setWs(dir);
          await setWorkspace(dir);
          setSidebarOpen(true);
          setSidebarTab("tree");
        }
      } catch (e) {
        if (token !== switchTokenRef.current) return;
        void showAlert(`打开失败：${String(e)}`, "Mditor", "error");
      } finally {
        // Only the newest switch owns clearing the UI state; older loads that
        // were superseded leave it to whichever click won.
        if (token === switchTokenRef.current) {
          // Guarantee the animation is visible for at least MIN_SWITCH_MS even
          // when the load was instant (cached / tiny file) — otherwise the bar
          // never registers. Defer the clear if we finished too quickly.
          const clear = () => {
            // Re-check the token: a newer click may have arrived while we waited.
            if (token !== switchTokenRef.current) return;
            setPendingPath(null);
            setDocSwitching(false);
            switchClearTimerRef.current = undefined;
          };
          const remaining = MIN_SWITCH_MS - (performance.now() - startedAt);
          if (remaining <= 0) clear();
          else switchClearTimerRef.current = window.setTimeout(clear, remaining);
        }
      }
    },
    [activateTab, snapshotActiveTab] // 均 stable —— openPath 身份保持稳定
  );

  // Rehydrate after a healing webview reload (see lib/session + Editor's
  // reloadForHeal). On a normal boot there is no snapshot and this no-ops. When
  // present, reopen the file — or, for an untitled buffer, reseed the captured
  // content once the editor is ready — and best-effort restore the scroll
  // position. Mode intentionally resets to wysiwyg: restoring it would race
  // with the content load (switchMode captures live content into the rebuild).
  useEffect(() => {
    const snap = takeHealSnapshot();
    if (!snap) return;
    let cancelled = false;

    const restoreScroll = () => {
      if (snap.scrollTop <= 0) return;
      // Give Milkdown a beat to render the (possibly large) reopened document
      // before pinning scroll; non-fatal if it lands slightly off.
      window.setTimeout(() => {
        if (cancelled) return;
        const el = document.querySelector<HTMLElement>(".mditor-editor-host");
        if (el) el.scrollTop = snap.scrollTop;
      }, 250);
    };

    const apply = async () => {
      if (snap.path) {
        await openPath(snap.path);
        if (cancelled) return;
        restoreScroll();
        return;
      }
      if (snap.untitledContent != null) {
        // A fresh boot already starts on an untitled empty buffer; wait for the
        // editor to be ready, then seed the captured content.
        const trySet = (tries: number) => {
          if (cancelled) return;
          const ed = editorRef.current;
          if (ed?.ready()) {
            ed.setValue(snap.untitledContent ?? "");
            fileApiRef.current.markDirty();
            restoreScroll();
          } else if (tries < 80) {
            window.setTimeout(() => trySet(tries + 1), 50);
          }
        };
        trySet(0);
      }
    };

    void apply();
    return () => {
      cancelled = true;
    };
  }, [openPath]);

  // React to file-tree mutations (delete / rename) coming from FileTree.
  //   * deleted: drop every tab whose file vanished (dirty tabs with a path
  //     were best-effort saved by autosave; untitled tabs aren't affected);
  //     drop every deleted path from the recent list too. If the ACTIVE tab
  //     vanished, activate a neighbour (or a fresh untitled tab).
  //   * renamed: update the stored path/name of the matching tab (content is
  //     unchanged by a rename).
  // Stable (empty deps) — reads live fileApi via ref.
  const onTreeChange = useCallback((change: TreeChange) => {
    const fa = fileApiRef.current;
    if (change.type === "deleted") {
      const gone = new Set(change.paths.map((p) => tabPathKey(p)));
      for (const p of change.paths) void clearRecentPath(p);
      setRecentKey((k) => k + 1);
      const cur = tabsRef.current;
      const remaining = cur.filter(
        (t) => !t.path || !gone.has(tabPathKey(t.path))
      );
      if (remaining.length === cur.length) return;
      if (remaining.length === 0) {
        const k = `untitled-${++untitledSeqRef.current}`;
        setTabs([{ key: k, path: null, name: "未命名.md", dirty: false, content: "" }]);
        setActiveKey(k);
        activeKeyRef.current = k;
        fa.newDoc();
        return;
      }
      setTabs(remaining);
      const activeGone = !remaining.some((t) => t.key === activeKeyRef.current);
      if (activeGone) {
        const idx = cur.findIndex((t) => t.key === activeKeyRef.current);
        const next = remaining[Math.min(idx, remaining.length - 1)];
        setActiveKey(next.key);
        activeKeyRef.current = next.key;
        fa.showDoc({ path: next.path, content: next.content, dirty: next.dirty });
      }
    } else if (change.type === "renamed") {
      if (fa.doc.path === change.from) {
        fa.updatePath(change.from, change.to);
      }
      setTabs((ts) =>
        ts.map((t) =>
          t.path === change.from
            ? { ...t, path: change.to, name: baseName(change.to) }
            : t
        )
      );
    }
  }, []);

  // Paths removed from the workspace tree via「从工作区移除」(files stay on
  // disk). Memoised Set so its identity is stable across renders that don't
  // touch excludedPaths — keeps FileTree's readTree effect from re-running on
  // unrelated settings changes.
  const excludedSet = useMemo(
    () => new Set(settingsApi.settings.excludedPaths ?? []),
    [settingsApi.settings.excludedPaths]
  );
  const handleExclude = useCallback((path: string) => {
    // Functional update: consecutive excludes must chain off the LATEST list,
    // not a ref snapshot (the same lost-update race update() now guards against).
    void settingsRef.current.update((prev) => {
      const cur = prev.excludedPaths ?? [];
      return cur.includes(path) ? {} : { excludedPaths: [...cur, path] };
    });
  }, []);

  // Open an externally-supplied path (double-clicked .md / `mditor.exe file.md`).
  // 多标签页（V3.6）：打开进新标签页，不会丢当前文档 —— 无需脏确认。
  const maybeOpen = useCallback(
    async (path: string) => {
      void openPath(path);
    },
    [openPath]
  );

  // rAF-coalesced markdown mirror update. Vditor fires input on EVERY keystroke;
  // without coalescing a fast typist in a long doc triggers N App re-renders per
  // second, each reconciling the whole tree. We keep the latest markdown in a
  // ref and flush it once per animation frame — downstream consumers (outline,
  // word count, annotations) already run on useDeferredValue, so they stay
  // smooth, and the React render itself drops from per-keystroke to ≤60fps.
  const liveMdRafRef = useRef<number | null>(null);
  const liveMdRef = useRef("");
  const onInput = useCallback((md: string) => {
    // markDirty 由 Editor 的 onInput 桥接负责（每字符一次），这里只做
    // rAF 合并的 markdown 镜像更新。
    liveMdRef.current = md;
    if (liveMdRafRef.current == null) {
      liveMdRafRef.current = requestAnimationFrame(() => {
        liveMdRafRef.current = null;
        setLiveMarkdown(liveMdRef.current);
      });
    }
  }, []); // stable
  // 注：V3.6 起标签页切换/新建/删除都经 fileApi 的 onLoaded 路径推送内容，
  // 镜像由 onInput 自行更新；旧的 resetLiveMd（强制清空镜像）不再需要。

  // ----- menu events from Rust (registered ONCE, reads latest hooks via refs) -----
  // macOS 保留原生菜单，其点击以 `menu` 事件转发到这里；Windows 的前端菜单栏
  // （MenuBar）经 onDispatch 走同一条路径 —— 两条入口行为完全一致。
  useEffect(() => {
    const unlistenP = listen<string>("menu", (ev) => {
      dispatchMenuRef.current(ev.payload);
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, []); // ← register once — never re-attach

  // ----- external file open (double-click a .md in Explorer / `mditor.exe f.md`) -----
  // Two paths share the same `maybeOpen`:
  //   1) app launched WITH a file arg while not running → Rust stashed it in
  //      `PendingFile`; pull it once after mount.
  //   2) app already running → second launch is caught by the single-instance
  //      plugin and re-emitted here as `open-file`.
  useEffect(() => {
    invoke<string | null>("get_pending_file").then((p) => {
      if (p) maybeOpen(p);
    });
    const unlistenP = listen<string>("open-file", (ev) => {
      if (ev.payload) maybeOpen(ev.payload);
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, [maybeOpen]);

  // ----- 拖放 .md 文件到窗口 = 打开标签页（V3.6）-----------------------------
  // 走 Tauri 的原生 drag-drop 事件（webview 默认启用 dragDropEnabled，HTML5
  // drop 反而收不到），能直接拿到绝对路径。拖拽期间给 body 加类显示提示层。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let over = false;
    getCurrentWindow()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          if (!over) {
            over = true;
            document.body.classList.add("is-dragging-md");
          }
        } else if (p.type === "leave") {
          over = false;
          document.body.classList.remove("is-dragging-md");
        } else if (p.type === "drop") {
          over = false;
          document.body.classList.remove("is-dragging-md");
          for (const path of p.paths) {
            if (/\.(md|markdown|mdx|mdown)$/i.test(path)) void openPath(path);
          }
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        /* 平台/权限不支持 — 静默降级（窗口拖放不可用不影响其余功能） */
      });
    return () => {
      document.body.classList.remove("is-dragging-md");
      unlisten?.();
    };
  }, [openPath]);

  // ----- global keyboard shortcuts (registered ONCE) -----
  // Ctrl+S/N/O/I 等与菜单同名的动作统一转发 dispatchMenu（单一实现来源），
  // 这里只保留事件层职责：preventDefault 与没有菜单 id 的键（Ctrl+F/H 搜索、
  // Ctrl+\ 侧边栏、Esc 焦点模式、F11）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc 退出焦点模式（仅焦点模式开启时拦截）
      if (e.key === "Escape") {
        if (settingsRef.current.settings.focusMode) {
          e.preventDefault();
          void settingsRef.current.toggleFocus();
        }
        return;
      }
      // F11 全屏（与菜单「视图 → 全屏」同一条 dispatch 路径）
      if (e.key === "F11") {
        e.preventDefault();
        dispatchMenuRef.current("view_fullscreen");
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      switch (e.key.toLowerCase()) {
        case "s":
          e.preventDefault();
          dispatchMenuRef.current(e.shiftKey ? "file_save_as" : "file_save");
          break;
        case "f":
          e.preventDefault();
          if (e.shiftKey) {
            // Ctrl+Shift+F：跨文件搜索（V3.6）。
            setSidebarOpen(true);
            setSidebarTab("search");
          } else {
            setSearchOpen(true);
          }
          break;
        case "h":
          // Ctrl/Cmd+Shift+H toggles highlight (handled by the editor surface);
          // only plain Ctrl/Cmd+H opens find/replace.
          if (e.shiftKey) return;
          e.preventDefault();
          setSearchOpen(true);
          break;
        case "n":
          e.preventDefault();
          dispatchMenuRef.current("file_new");
          break;
        case "o":
          e.preventDefault();
          dispatchMenuRef.current(e.shiftKey ? "file_open_folder" : "file_open");
          break;
        case "\\":
          e.preventDefault();
          setSidebarOpen((o) => !o);
          break;
        case "i":
          e.preventDefault();
          dispatchMenuRef.current("view_ai_assistant");
          break;
        case "tab":
          // Ctrl+Tab / Ctrl+Shift+Tab：多标签页轮换（V3.6）。
          e.preventDefault();
          {
            const cur = tabsRef.current;
            if (cur.length > 1) {
              const idx = cur.findIndex((t) => t.key === activeKeyRef.current);
              const next = e.shiftKey
                ? (idx - 1 + cur.length) % cur.length
                : (idx + 1) % cur.length;
              void activateTabRef.current(cur[next].key);
            }
          }
          break;
        case "w":
          // Ctrl+W：关闭当前标签页（V3.6；Tauri 窗口未占用该组合键）。
          e.preventDefault();
          void closeTabRef.current(activeKeyRef.current);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // ← register once

  // 状态栏闪现消息：设置文本并安排自动清除。每次调用先清掉前一个定时器，
  // 因此快速连续触发（连续保存 / 频繁外部修改）不会堆积定时器，旧 closure
  // 也不会在新的消息之后错误地把它清空。稳定回调（仅依赖 setter + ref）。
  const flashStatus = useCallback((msg: string, ms = 2000) => {
    setAutosaveMsg(msg);
    if (statusTimerRef.current !== undefined) window.clearTimeout(statusTimerRef.current);
    statusTimerRef.current = window.setTimeout(() => {
      setAutosaveMsg("");
      statusTimerRef.current = undefined;
    }, ms);
  }, []);

  // ----- export & clipboard helpers -----
  const doExport = useCallback(
    async (kind: "html" | "pdf" | "png" | "docx") => {
      const ed = editorRef.current;
      if (!ed) return;
      const html = ed.getHTML();
      const css = collectThemeCss();
      const ctx = { html, css, docPath: fileApi.doc.path };
      const name =
        (fileApi.doc.path ? baseName(fileApi.doc.path) : "untitled").replace(
          MD_EXT_RE,
          ""
        ) || "untitled";
      try {
        if (kind === "html") {
          // V3.6：导出前选择是否把本地图片内联为 base64（单文件分发）。
          const inline = await choiceDialog(
            "是否把本地图片内联进 HTML（生成单个自包含文件）？\n「保留引用」则维持相对路径，需连同 assets 文件夹一起分发。",
            "内联图片",
            "保留引用"
          );
          await exportHtml(ctx, `${name}.html`, { inlineImages: inline });
        } else if (kind === "pdf") await exportPdf(ctx, `${name}.pdf`);
        else if (kind === "docx") await exportDocx(ctx, `${name}.docx`);
        else if (kind === "png") {
          const el = ed.previewEl();
          if (!el) {
            void showAlert(
              "当前模式下无可截图的预览区，请切换到所见即所得/预览模式",
              "Mditor",
              "warning"
            );
            return;
          }
          const isDarkTheme =
            settingsApi.settings.theme === "dark" ||
            settingsApi.settings.theme === "claude-dark";
          const bg = isDarkTheme ? "#1e1e1e" : "#ffffff";
          await exportPng(el, `${name}.png`, bg);
        }
      } catch (e) {
        void showAlert(`导出失败：${String(e)}`, "Mditor", "error");
      }
    },
    [fileApi.doc.path, settingsApi.settings.theme]
  );

  const doCopyRich = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed) return;
    try {
      const html = ed.getHTML();
      const plain = ed.getValue();
      await copyRich(html, plain, collectThemeCss());
      flashStatus("已复制富文本");
    } catch (e) {
      void showAlert(`复制失败：${String(e)}`, "Mditor", "error");
    }
  }, [flashStatus]);

  // doExport 依赖当前文档路径/主题（身份随打开/保存/换主题变化），而 dispatchMenu
  // 需要空依赖保持稳定 —— 经 ref 转发，调用时永远取最新实例（对齐 fileApiRef 惯例）。
  const doExportRef = useRef(doExport);
  doExportRef.current = doExport;

  // ----- 统一菜单分发器：原生 `menu` 事件（macOS）与前端菜单栏（Windows）共用 -----
  // 稳定回调（空依赖）：fileApi/settings 经既有 ref 读取；不稳定的 doExport 经
  // 上面的 doExportRef 转发；其余依赖（flashStatus/doCopyRich/doCheckUpdate/
  // resetLiveMd/setter）本身都是稳定引用。
  const dispatchMenu = useCallback((id: string) => {
    const fa = fileApiRef.current;
    const sa = settingsRef.current;
    switch (id) {
      case "file_new":
        // 多标签页：新建 = 新的未命名标签，旧文档留在自己的标签里，无需确认。
        newUntitledTab();
        break;
      case "file_new_template":
        setTemplateOpen(true);
        break;
      case "file_open":
        void (async () => {
          const ok = await fa.open();
          if (ok) setRecentKey((k) => k + 1);
        })();
        break;
      case "file_open_folder":
        void (async () => {
          const f = await pickFolder();
          if (f) {
            setWs(f);
            await setWorkspace(f);
            setSidebarOpen(true);
            setSidebarTab("tree");
          }
        })();
        break;
      case "file_save":
        // 乐观反馈：立即提示「已保存」，不等待落盘；失败时覆盖为「保存失败」。
        flashStatus("已保存");
        fa.save(() => editorRef.current?.getValue() ?? "").catch(() =>
          flashStatus("保存失败", 5000)
        );
        break;
      case "file_save_as":
        void fa.saveAs(() => editorRef.current?.getValue() ?? "");
        break;
      case "file_export_html":
        void doExportRef.current("html");
        break;
      case "file_export_pdf":
        void doExportRef.current("pdf");
        break;
      case "file_export_png":
        void doExportRef.current("png");
        break;
      case "file_export_docx":
        void doExportRef.current("docx");
        break;
      case "edit_undo":
        execOnEditor(editorRef.current, "undo");
        break;
      case "edit_redo":
        execOnEditor(editorRef.current, "redo");
        break;
      case "edit_cut":
        execOnEditor(editorRef.current, "cut");
        break;
      case "edit_copy":
        execOnEditor(editorRef.current, "copy");
        break;
      case "edit_paste":
        execOnEditor(editorRef.current, "paste");
        break;
      case "edit_select_all":
        execOnEditor(editorRef.current, "selectAll");
        break;
      case "edit_copy_rich":
        void doCopyRich();
        break;
      case "view_outline":
        setSidebarOpen(true);
        setSidebarTab("outline");
        break;
      case "view_filetree":
        setSidebarOpen(true);
        setSidebarTab("tree");
        break;
      case "view_focus":
        void sa.toggleFocus();
        break;
      case "view_ai_assistant":
        setAiOpen((o) => !o);
        break;
      case "view_fullscreen": {
        const w = getCurrentWindow();
        void (async () => {
          w.setFullscreen(!(await w.isFullscreen()));
        })();
        break;
      }
      case "theme_light":
        void sa.setTheme("light");
        break;
      case "theme_dark":
        void sa.setTheme("dark");
        break;
      case "theme_sepia":
        void sa.setTheme("sepia");
        break;
      case "app_settings":
        setSettingsOpen(true);
        break;
      case "app_about":
        setAboutOpen(true);
        break;
      case "app_exit":
        void exit(0);
        break;
      case "format_bold":
        editorRef.current?.toggleBold();
        editorRef.current?.find();
        break;
      case "format_highlight":
        editorRef.current?.toggleHighlight();
        editorRef.current?.find();
        break;
      case "format_italic":
        editorRef.current?.toggleItalic();
        editorRef.current?.find();
        break;
      case "format_strike":
        editorRef.current?.toggleStrikethrough();
        editorRef.current?.find();
        break;
      case "format_code":
        editorRef.current?.toggleInlineCode();
        editorRef.current?.find();
        break;
      case "insert_link":
        setLinkDialogText(editorRef.current?.getSelection() ?? "");
        setLinkDialogOpen(true);
        break;
      case "insert_image":
        void (async () => {
          try {
            const picked = await openDialog({
              multiple: false,
              filters: [
                {
                  name: "图片",
                  extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"],
                },
              ],
            });
            if (!picked || typeof picked !== "string") return;
            const bytes = await readFile(picked);
            const name = picked.split(/[\\/]/).pop() ?? "image.png";
            const r = await persistImage(
              new File([bytes], name),
              fileApiRef.current.doc.path
            );
            const alt = (name.replace(/\.[^.]+$/, "") || "图片").replace(/[[\]]/g, "");
            editorRef.current?.insertAtCursor(`![${alt}](${r.ref})\n\n`);
            editorRef.current?.find();
          } catch {
            /* 选择器取消 / 读取失败 — 静默忽略 */
          }
        })();
        break;
      case "insert_footnote":
        editorRef.current?.insertFootnote();
        editorRef.current?.find();
        break;
      case "view_typewriter":
        void settingsRef.current.update((prev) => ({
          typewriterMode: !prev.typewriterMode,
        }));
        break;
      case "view_search":
        setSidebarOpen(true);
        setSidebarTab("search");
        break;
    }
    // 三个依赖都是稳定 useCallback（doCopyRich←flashStatus、newUntitledTab←
    // snapshotActiveTab←getCurrentContent），列出只为满足 exhaustive-deps ——
    // dispatchMenu 的身份仍然不变。
  }, [doCopyRich, flashStatus, newUntitledTab]); // ← stable — reads live state via refs
  // 上面「注册一次」的事件监听（menu 事件 / 全局快捷键）声明在本回调之前，
  // 但只在提交后才执行 —— 经 ref 镜像取调用时的最新 dispatchMenu。
  const dispatchMenuRef = useRef(dispatchMenu);
  dispatchMenuRef.current = dispatchMenu;

  const jumpToHeading = useCallback(
    (node: OutlineNode) => {
      // sv mode: the Milkdown DOM is hidden and stale, so target the source
      // textarea directly via the heading's recorded line.
      if (editMode === "sv") {
        if (node.line != null) editorRef.current?.jumpToSourceLine(node.line);
        return;
      }
      // Milkdown renders <hN id="..."> matching the outline slug. Focus FIRST,
      // then scroll: native focus() scrolls the caret into view, and when it ran
      // AFTER an async `smooth` scrollIntoView it overrode the heading scroll and
      // yanked the viewport back to the caret (document start) — so every outline
      // click landed at the top. Focusing first and scrolling instantly
      // (behavior:"auto") makes the heading scroll the last synchronous one, so
      // it wins. (Same reason jumpToAnnotation uses instant scrolling.)
      editorRef.current?.previewEl()?.focus();
      document
        .getElementById(node.id)
        ?.scrollIntoView({ behavior: "auto", block: "start" });
    },
    [editMode]
  );

  // Jump the editor to an annotation's marker badge and open its popover.
  // The AnnotationPopover opens via a global mousedown listener, so after
  // scrolling the marker into view we dispatch a synthetic mousedown on it to
  // reuse that exact open path (keeps positioning/behaviour identical to a
  // real click). No-op if the marker isn't currently rendered (e.g. split-view
  // mode where markers aren't badged).
  const jumpToAnnotation = useCallback(
    (id: string) => {
      // sv mode: the Milkdown DOM is hidden (display:none) but STILL in the
      // document, so the querySelector below would find its marker — an element
      // with no layout box. scrollIntoView on it is a no-op (no scrolling) and
      // the popover would position itself off the marker's zero rect (it pops
      // up at the screen's top-left corner). Instead, scroll the SOURCE
      // surface to the marker's inline `[^id]` reference line — same path the
      // sv-mode outline jump uses. (No popover: in source mode the user reads
      // the raw `[^id]` token itself.)
      if (editMode === "sv") {
        const line = findAnnotationRefLine(
          editorRef.current?.getValue() ?? "",
          id
        );
        if (line != null) editorRef.current?.jumpToSourceLine(line);
        return;
      }
      // Focus the editor surface FIRST — same reason as jumpToHeading above:
      // calling focus() AFTER scrollIntoView restores the (stale) selection and
      // the browser scrolls the caret back into view, yanking the viewport away
      // from the marker so the click appeared not to jump at all. Focusing first
      // makes the marker scroll the final (winning) synchronous one.
      editorRef.current?.previewEl()?.focus();
      const marker = document.querySelector<HTMLElement>(
        `sup[data-type="footnote_reference"][data-label="${id}"]`
      );
      if (!marker) return;
      // Use instant (not smooth) scrolling: the popover positions itself from the
      // marker's viewport rect right after this, so the marker must already be in
      // its final position or the card would stick to the pre-scroll spot.
      marker.scrollIntoView({ behavior: "auto", block: "center" });
      marker.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
    },
    [editMode]
  );

  // Stable toggles for StatusBar (kept out of JSX so React.memo can short-circuit
  // re-renders when only `liveMarkdown` changes during typing).
  const toggleSidebar = useCallback(() => setSidebarOpen((o) => !o), []);
  const toggleAi = useCallback(() => setAiOpen((o) => !o), []);
  const toggleFocus = useCallback(
    () => void settingsApi.toggleFocus(),
    [settingsApi.toggleFocus]
  );

  // ---- Stable editor-bridge callbacks (empty deps; read editorRef.current at
  // ---- call time). These MUST be stable so the memoised children that receive
  // ---- them (SearchBar, AiPanel, SelectionToolbar) skip re-renders during typing.
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const getMarkdown = useCallback(() => editorRef.current?.getValue() ?? "", []);
  const setMarkdown = useCallback((md: string) => editorRef.current?.setValue(md), []);
  const focusEditor = useCallback(() => editorRef.current?.find(), []);
  const getEditorSelection = useCallback(
    () => editorRef.current?.getSelection() ?? "",
    []
  );
  const getEditorSelectionRange = useCallback(
    () => editorRef.current?.getSelectionRange() ?? null,
    []
  );
  // Bold / highlight toggles + active-marks readback, exposed to the floating
  // selection toolbar and the native 格式 menu (stable; read editorRef at call
  // time so the memo'd toolbar skips re-renders during typing).
  const toggleBold = useCallback(() => editorRef.current?.toggleBold(), []);
  const toggleHighlight = useCallback(() => editorRef.current?.toggleHighlight(), []);
  const toggleItalic = useCallback(() => editorRef.current?.toggleItalic(), []);
  const toggleStrikethrough = useCallback(
    () => editorRef.current?.toggleStrikethrough(),
    []
  );
  const toggleInlineCode = useCallback(() => editorRef.current?.toggleInlineCode(), []);
  const setTextColor = useCallback(
    (color: string) => editorRef.current?.setTextColor(color),
    []
  );
  const clearTextColor = useCallback(() => editorRef.current?.clearTextColor(), []);
  const getActiveMarks = useCallback(
    () =>
      editorRef.current?.getActiveMarks() ?? {
        bold: false,
        highlight: false,
        italic: false,
        strike: false,
        code: false,
        color: null,
      },
    []
  );
  const isEditorReady = useCallback(() => editorRef.current?.ready() ?? false, []);
  // AI「插入到光标」：走 aiWriteInsert（一步撤销的单事务写回）。
  const aiInsert = useCallback(
    (md: string) => editorRef.current?.aiWriteInsert(md),
    []
  );
  const insertAfterSelection = useCallback(
    (md: string) => editorRef.current?.insertAfterSelection(md),
    []
  );
  // 改动预览「应用」：把逐处接受/拒绝后的合并文本一次性写回（一步撤销）。
  // 选区模式先校验捕获区间仍持有原文；失效则按内容回退定位，仍找不到才报错。
  const applyAiChanges = useCallback((payload: ApplyChangesPayload) => {
    const ed = editorRef.current;
    if (!ed) return;
    if (payload.mode === "full") {
      ed.aiWriteDoc(payload.merged);
      return;
    }
    if (payload.range) {
      const t = ed.getTextAt(payload.range.from, payload.range.to);
      if (normalizeAnchorText(t) === normalizeAnchorText(payload.original)) {
        ed.aiWriteRange(payload.range.from, payload.range.to, payload.merged);
        return;
      }
    }
    const found = ed.findTextRange(payload.original, payload.range?.from ?? -1);
    if (found) {
      ed.aiWriteRange(found.from, found.to, payload.merged);
      return;
    }
    void showAlert("原选区已变化且未能按内容定位，请重新选中后再试。", "Mditor", "warning");
  }, []);
  // 改动预览「查看上下文」：滚动编辑器到该处改动的原文位置。
  const jumpToAiText = useCallback(
    (needle: string) => editorRef.current?.revealText(needle),
    []
  );
  // Annotation edit/delete bridge for the popover (stable; reads editorRef at
  // call time so the popover can be React.memo'd).
  const updateAnnotation = useCallback(
    (id: string, content: string) =>
      editorRef.current?.updateAnnotation(id, content),
    []
  );
  const deleteAnnotation = useCallback(
    (id: string) => editorRef.current?.removeAnnotation(id),
    []
  );
  // Manual annotation from the selection toolbar: anchor on the selected text
  // (the live selection is lost once the toolbar's textarea is focused, so we
  // pass the text and let addAnnotation re-anchor on it).
  const addAnnotationAtSelection = useCallback(
    (selection: string, content: string, range?: { from: number; to: number } | null) =>
      void editorRef.current?.addAnnotation(content, selection, range),
    []
  );

  // AI "one-click annotation": refine the assistant reply into a compact note,
  // then anchor it at the selection the reply was about (if any). Falls back to
  // the raw reply if refinement fails or the model isn't configured.
  //
  // 流式 + 乐观挂载：点批注的瞬间就挂上占位 marker（"生成中…"），用户立刻在
  // 编辑器里看到反馈；随后精炼内容以流式片段实时写回 marker。
  // updateAnnotation 触发整篇重写，用 rAF 节流到每帧最多一次。
  //
  // 一步撤销（AI 写回契约）：进入前先记 baseline；流式帧各自合并进撤销组；
  // 结束时 finalizeAnnotation 以 baseline 为基线收束为单个撤销步骤——按一次
  // Ctrl+Z 即完全回到点「批注」之前的文档。
  const onAnnotateReply = useCallback(
    async (reply: string, anchorText?: string, range?: { from: number; to: number } | null) => {
      const s = settingsRef.current.settings;
      const editor = editorRef.current;
      if (!editor) return;
      const baseline = editor.getValue();
      // 乐观挂载占位 marker，拿到 annotationId 用于后续更新。
      const annoId = editor.addAnnotation("生成中…", anchorText, range);
      if (!annoId) return;
      const finalize = (text: string) =>
        editor.finalizeAnnotation(annoId, text.trim() || reply.trim(), baseline);

      if (!isAiConfigured(s)) {
        // 未配置 AI：直接用原始回复收尾占位。
        finalize(reply);
        return;
      }

      let partial = "";
      let rafId: number | null = null;
      const flush = () => {
        rafId = null;
        editor.updateAnnotation(annoId, partial);
      };
      try {
        await new Promise<void>((resolve, reject) => {
          chatStream({
            settings: s,
            messages: buildAnnotationMessages(reply),
            requestId: `anno-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            handlers: {
              onChunk: (delta) => {
                partial += delta;
                // rAF 节流：多 chunk 合并为一帧一次 setValue，避免高频重排。
                if (rafId == null) rafId = requestAnimationFrame(flush);
              },
              onDone: () => resolve(),
              onError: (err) => reject(new Error(err)),
            },
          });
        });
        // 收尾：清掉待处理 rAF，以 baseline 收束为一步撤销。
        if (rafId != null) cancelAnimationFrame(rafId);
        finalize(partial.trim());
      } catch {
        // 精炼失败：取消待处理帧，回退为原始回复，保证 marker 不停在"生成中…"。
        if (rafId != null) cancelAnimationFrame(rafId);
        finalize(reply);
      }
    },
    []
  );
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeAi = useCallback(() => setAiOpen(false), []);

  // 跨文件搜索结果 → 打开文件并跳到命中处（V3.6）。sv 模式按行号跳；
  // 富文本按整行内容 reveal（anchorSearch 的空白归一比对可容忍行首缩进）。
  const onOpenSearchResult = useCallback(
    async (path: string, hit: SearchHit) => {
      await openPath(path);
      window.setTimeout(() => {
        if (editMode === "sv") {
          editorRef.current?.jumpToSourceLine(hit.line);
        } else {
          const needle = hit.full.trim();
          if (needle) editorRef.current?.revealText(needle);
        }
      }, 300);
    },
    [openPath, editMode]
  );

  // 「插入链接」弹窗确认 → 编辑器写回（V3.6）。
  const onInsertLinkConfirm = useCallback((href: string, text: string) => {
    editorRef.current?.insertLink(href, text);
    editorRef.current?.find();
  }, []);

  // 「从模板新建」确认 → 新标签页写入模板内容（V3.6）。
  const newUntitledTabRef = useRef(newUntitledTab);
  newUntitledTabRef.current = newUntitledTab;
  const onPickTemplate = useCallback((t: DocTemplate) => {
    newUntitledTabRef.current(renderTemplate(t));
  }, []);
  const onSettingsChange = useCallback(
    (patch: Partial<Parameters<typeof settingsApi.update>[0]>) =>
      void settingsApi.update(patch),
    [settingsApi.update]
  );

  // Stable callbacks for Editor's autosave/watcher status (depend only on
  // stable setters + the stable flashStatus, so they never change identity).
  const onAutosaved = useCallback(() => {
    flashStatus("已自动保存");
    setRecentKey((k) => k + 1);
  }, [flashStatus]);
  const onWatcherStatus = useCallback(
    (msg: string, kind: "sync" | "warn") => {
      flashStatus(msg, kind === "warn" ? 5000 : 2500);
    },
    [flashStatus]
  );
  // Mode switch via the StatusBar selector → Editor.switchMode (destroy+rebuild
  // into the target mode). Stable: only reads editorRef at call time.
  const onSwitchMode = useCallback((m: "wysiwyg" | "ir" | "sv") => {
    editorRef.current?.switchMode(m);
  }, []);

  // Selection toolbar → AI panel dispatch. Stable: only depends on setAiOpen.
  const onAskSelection = useCallback(
    (selection: string, instruction: string, range?: { from: number; to: number } | null) => {
      setAiOpen(true);
      let tries = 0;
      const fire = () => {
        const handle = aiPanelRef.current;
        if (handle) {
          handle.askSelection(selection, instruction, range);
        } else if (tries++ < 30) {
          requestAnimationFrame(fire);
        }
      };
      requestAnimationFrame(fire);
    },
    []
  );

  // Stable filtered quick-action arrays (useMemo so identity only changes when
  // the underlying settings array changes, not on every render).
  const selectionActions = useMemo(
    () =>
      settingsApi.settings.aiQuickActions.filter((a) => a.scope === "selection"),
    [settingsApi.settings.aiQuickActions]
  );

  // Parsed annotations from the live markdown mirror — drives the popover.
  // useDeferredValue keeps parsing off the hot typing path (same trick as the
  // word-count above).
  const annotations = useAnnotations(liveMarkdown);

  // Defer expensive recompute of word count so a fast typist in a large
  // document doesn't get key-input lag — React runs this at lower priority.
  const deferredMarkdown = useDeferredValue(liveMarkdown);
  const words = useMemo(() => countWords(deferredMarkdown), [deferredMarkdown]);

  const docName = fileApi.doc.path ? baseName(fileApi.doc.path) : "未命名.md";

  return (
    <div className={`app ${settingsApi.settings.focusMode ? "is-focus" : ""}`}>
      <TitleBar
        name={docName}
        dirty={fileApi.doc.dirty}
        focusMode={focusMode}
        theme={settingsApi.settings.theme}
        typewriter={settingsApi.settings.typewriterMode}
        onDispatch={dispatchMenu}
      />
      {/* 多标签页（V3.6）：≥2 个标签时显示 */}
      <TabsBar
        tabs={tabs}
        activeKey={activeKey}
        onActivate={(k) => void activateTab(k)}
        onClose={(k) => void closeTab(k)}
      />
      <aside className={`sidebar ${sidebarOpen ? "open" : "closed"}`}>
        <nav className="sb-tabs">
          <button
            className={sidebarTab === "tree" ? "active" : ""}
            onClick={() => setSidebarTab("tree")}
            title="文件树"
          >
            <FileTreeIcon size={17} />
          </button>
          <button
            className={sidebarTab === "outline" ? "active" : ""}
            onClick={() => setSidebarTab("outline")}
            title="大纲"
          >
            <OutlineIcon size={17} />
          </button>
          <button
            className={sidebarTab === "recent" ? "active" : ""}
            onClick={() => setSidebarTab("recent")}
            title="最近"
          >
            <RecentIcon size={17} />
          </button>
          <button
            className={sidebarTab === "annotations" ? "active" : ""}
            onClick={() => setSidebarTab("annotations")}
            title="批注"
          >
            <AnnotationIcon size={17} />
            {annotations.length > 0 && (
              <span className="sb-tab-badge">{annotations.length}</span>
            )}
          </button>
          <button
            className={sidebarTab === "search" ? "active" : ""}
            onClick={() => setSidebarTab("search")}
            title="在工作区中搜索 (Ctrl+Shift+F)"
          >
            <SearchIcon size={17} />
          </button>
        </nav>
        <div className="sb-panel">
          {sidebarTab === "tree" &&
            (workspace ? (
              <>
                <div className="sb-head">
                  <div className="sb-ws">
                    <FolderIcon size={14} className="sb-ws-icon" />
                    <span className="sb-ws-name" title={workspace}>
                      {baseName(workspace)}
                    </span>
                  </div>
                  <button
                    className="sb-tiny"
                    title="切换工作区"
                    onClick={async () => {
                      const f = await pickFolder();
                      if (f) {
                        setWs(f);
                        await setWorkspace(f);
                      }
                    }}
                  >
                    <ExpandIcon size={13} />
                  </button>
                </div>
                <FileTree
                  root={workspace}
                  activePath={pendingPath ?? fileApi.doc.path}
                  onOpen={openPath}
                  onChanged={onTreeChange}
                  excludedPaths={excludedSet}
                  onExclude={handleExclude}
                />
              </>
            ) : (
              <div className="sb-empty">
                <p>未打开文件夹</p>
                <button
                  onClick={async () => {
                    const f = await pickFolder();
                    if (f) {
                      setWs(f);
                      await setWorkspace(f);
                    }
                  }}
                >
                  打开文件夹…
                </button>
              </div>
            ))}
          {sidebarTab === "outline" && (
            <Outline
              mode={editMode}
              markdown={liveMarkdown}
              headings={docHeadings}
              onJump={jumpToHeading}
            />
          )}
          {sidebarTab === "recent" && (
            <RecentList onOpen={openPath} refreshKey={recentKey} />
          )}
          {sidebarTab === "search" && (
            <>
              <div className="sb-head">
                <span className="sb-ws-name">在工作区中搜索</span>
              </div>
              <WorkspaceSearch
                workspace={workspace}
                excludedPaths={excludedSet}
                onOpenResult={(p, h) => void onOpenSearchResult(p, h)}
              />
            </>
          )}
          {sidebarTab === "annotations" && (
            <>
              <div className="sb-head">
                <span className="sb-ws-name">批注</span>
                <span className="sb-count">{annotations.length}</span>
              </div>
              <AnnotationList
                annotations={annotations}
                markdown={liveMarkdown}
                onJump={jumpToAnnotation}
                onUpdate={updateAnnotation}
                onDelete={deleteAnnotation}
              />
            </>
          )}
        </div>
      </aside>

      {/* 侧边栏宽度拖拽分隔条（侧边栏打开且非焦点模式时显示） */}
      {sidebarOpen && !focusMode && (
        <div
          className="resizer resizer-sidebar"
          title="拖拽调节侧边栏宽度（双击重置）"
          onPointerDown={sidebarResize.onPointerDown}
          onDoubleClick={sidebarResize.onDoubleClick}
        />
      )}

      {/* 侧边栏关闭时左缘的展开按钮（hover 显现） */}
      {!sidebarOpen && !focusMode && (
        <button
          className="sidebar-opener"
          title="展开侧边栏 (Ctrl+\)"
          onClick={() => setSidebarOpen(true)}
        >
          <ChevronRightIcon size={12} />
        </button>
      )}

      <main className={`main${docSwitching ? " is-switching" : ""}`}>
        <SearchBar
          open={searchOpen}
          onClose={closeSearch}
          getMarkdown={getMarkdown}
          setMarkdown={setMarkdown}
          focusEditor={focusEditor}
        />
        <Editor
          ref={editorRef}
          settings={settingsApi.settings}
          fileApi={fileApi}
          onInput={onInput}
          onHeadings={setDocHeadings}
          onAutosaved={onAutosaved}
          onWatcherStatus={onWatcherStatus}
          onModeChange={setEditMode}
        />
      </main>

      {/* AI 面板宽度拖拽分隔条（AI 面板打开且非焦点模式时显示） */}
      {aiOpen && !focusMode && (
        <div
          className="resizer resizer-ai"
          title="拖拽调节 AI 面板宽度（双击重置）"
          onPointerDown={aiResize.onPointerDown}
          onDoubleClick={aiResize.onDoubleClick}
        />
      )}

      <AiPanel
        ref={aiPanelRef}
        open={aiOpen}
        settings={settingsApi.settings}
        getNote={getMarkdown}
        onInsert={aiInsert}
        onInsertAfterSelection={insertAfterSelection}
        onApplyChanges={applyAiChanges}
        onJumpToText={jumpToAiText}
        onAnnotate={onAnnotateReply}
        onOpenSettings={openSettings}
        onSettingsChange={onSettingsChange}
        onClose={closeAi}
      />

      <SelectionToolbar
        getSelection={getEditorSelection}
        getSelectionRange={getEditorSelectionRange}
        isReady={isEditorReady}
        actions={selectionActions}
        onAsk={onAskSelection}
        onAnnotate={addAnnotationAtSelection}
        onBold={toggleBold}
        onHighlight={toggleHighlight}
        onItalic={toggleItalic}
        onStrike={toggleStrikethrough}
        onCode={toggleInlineCode}
        onSetColor={setTextColor}
        onClearColor={clearTextColor}
        getActiveMarks={getActiveMarks}
      />

      <AnnotationPopover
        annotations={annotations}
        markdown={liveMarkdown}
        onUpdate={updateAnnotation}
        onDelete={deleteAnnotation}
        theme={settingsApi.settings.theme}
      />

      <button
        className={`ai-fab${aiOpen ? " active" : ""}`}
        title="AI 助手 (Ctrl+I)"
        onClick={() => setAiOpen((o) => !o)}
      >
        <AiIcon size={20} />
      </button>

      {/* 焦点模式：鼠标移到屏幕顶部边缘延迟浮出工具栏 */}
      {focusMode && (
        <div className="focus-hover-zone">
          <div className="focus-toolbar">
            <button
              title="显示侧边栏（退出焦点模式）"
              onClick={() => {
                void settingsApi.toggleFocus();
                setSidebarOpen(true);
              }}
            >
              <SidebarIcon size={13} /> 侧边栏
            </button>
            <button
              title="显示 AI 面板（退出焦点模式）"
              onClick={() => {
                void settingsApi.toggleFocus();
                setAiOpen(true);
              }}
            >
              <AiIcon size={13} /> AI
            </button>
            <button
              title="退出焦点模式 (Esc)"
              onClick={() => void settingsApi.toggleFocus()}
            >
              <ExpandIcon size={13} /> 退出焦点
            </button>
          </div>
        </div>
      )}

      <StatusBar
        name={docName}
        path={fileApi.doc.path}
        dirty={fileApi.doc.dirty}
        words={words}
        mode={editMode}
        autosaveMsg={autosaveMsg}
        sidebarOpen={sidebarOpen}
        aiOpen={aiOpen}
        focusMode={focusMode}
        onToggleSidebar={toggleSidebar}
        onToggleAi={toggleAi}
        onToggleFocus={toggleFocus}
        onSwitchMode={onSwitchMode}
      />

      <SettingsModal
        open={settingsOpen}
        settings={settingsApi.settings}
        workspace={workspace}
        onClose={() => setSettingsOpen(false)}
        onChange={settingsApi.update}
      />

      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />

      {/* V3.6：从模板新建 / 插入链接 弹窗 */}
      <TemplateModal
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        onPick={onPickTemplate}
      />
      <LinkDialog
        open={linkDialogOpen}
        initialText={linkDialogText}
        onConfirm={onInsertLinkConfirm}
        onClose={() => setLinkDialogOpen(false)}
      />
    </div>
  );
}

/** 聚焦编辑器表面后执行 document.execCommand —— 原生菜单取消后，撤销/剪切/
 *  复制/全选等预定义项在前端等价实现（WebView2 对 contenteditable 原生支持；
 *  粘贴受浏览器安全策略限制，尽力而为）。 */
function execOnEditor(editor: EditorHandle | null, cmd: string) {
  editor?.find(); // focus the surface first so the command has a target
  document.execCommand(cmd);
}

/** Collect active theme CSS text for export/clipboard (best-effort).
 *  按 (当前主题, 样式表数量) 缓存：重复导出 / 复制富文本不再重算整段 cssText；
 *  主题切换（懒加载新增 link 使 styleSheets.length 变化）或任何样式表增删
 *  会令缓存自动失效。 */
let themeCssCache: { theme: string; sheetCount: number; css: string } | null = null;
function collectThemeCss(): string {
  const theme = document.documentElement.getAttribute("data-theme") ?? "light";
  const sheetCount = document.styleSheets.length;
  if (
    themeCssCache &&
    themeCssCache.theme === theme &&
    themeCssCache.sheetCount === sheetCount
  ) {
    return themeCssCache.css;
  }
  let css = "";
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const href = sheet.href ?? "";
      // Collect our own bundled CSS (Vite emits under /assets/) plus any inline
      // (<style>) sheets — these carry the prose/theme/annotation/KaTeX/hljs
      // rules the exported document needs to look right. Cross-origin sheets
      // (fonts etc.) are skipped by the catch below.
      if (!href || href.includes("/assets/")) {
        for (const rule of Array.from(sheet.cssRules)) css += rule.cssText + "\n";
      }
    } catch {
      // cross-origin sheet; skip
    }
  }
  themeCssCache = { theme, sheetCount, css };
  return css;
}
