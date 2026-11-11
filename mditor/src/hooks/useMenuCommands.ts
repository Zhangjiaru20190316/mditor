// useMenuCommands：App 的「菜单/快捷键」命令层（Q2 拆分第一块，自 App.tsx 原样
// 迁入，行为逐字节等价——switch 分支、依赖数组、快捷键匹配顺序与
// preventDefault 语义全部不动）。三个入口共用同一条分发路径：
//   * macOS 原生菜单的 `menu` 事件（Rust 转发，注册一次）；
//   * Windows 前端菜单栏（TitleBar → MenuBar 的 onDispatch）；
//   * 全局快捷键（与菜单同名的键统一转发 dispatchMenu，单一实现来源）。
// App 侧依赖经 deps 对象显式注入（全部为稳定引用：useRef 产物 / setState
// setter / 稳定 useCallback），因此 hook 内部各依赖数组得以维持拆分前的
// 原样——dispatchMenu 身份稳定、事件监听只注册一次。

import { useCallback, useEffect, useRef } from "react";
import type {
  Dispatch,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from "react";
import { getAdapter } from "../platform";
import { noteOpError } from "../lib/opDebug";
import { openNoteFromDialog } from "../lib/tauriFs";
import { openEmptyNewWindow } from "../lib/multiWindow";
import { vaultIndex } from "../lib/vaultIndex";
import { persistImage } from "../lib/imageManager";
import type { FileApi } from "./useFile";
import type { SettingsApi } from "./useSettings";
import type { EditorHandle } from "../components/Editor";
import type { AiPanelHandle } from "../components/AiPanel";
import type { SyncTrigger } from "../lib/sync/trigger";
import type { TabItem } from "../types";

/** 侧边栏标签值域（与 App.tsx 的 SidebarTab 同一集合；独立声明避免 hook 反向
 *  依赖 App.tsx，结构化类型保证两者互相可赋值）。 */
type SidebarTab = "tree" | "outline" | "recent" | "annotations" | "search" | "links";

/** useMenuCommands 的依赖面：App 侧显式组装注入（第一块拆分 = 显式化依赖面）。
 *  字段全部是「每次渲染同一引用」的值 —— render 期 ref 镜像、useState 的
 *  setter、稳定链路的 useCallback —— hook 内部据此维持拆分前的空依赖
 *  effect 与稳定的 dispatchMenu 身份。 */
export interface UseMenuCommandsDeps {
  // ---- render 期 ref 镜像（调用时读最新实例）----
  /** useFile 的 ref 镜像（App 惯例：稳定回调经 ref 读 live 状态）。 */
  fileApiRef: MutableRefObject<FileApi>;
  /** useSettings 的 ref 镜像。 */
  settingsRef: MutableRefObject<SettingsApi>;
  /** 编辑器句柄（react ref，dispatchMenu 调用时读取）。 */
  editorRef: RefObject<EditorHandle>;
  /** AI 面板句柄（format_fix_md 打开面板后 rAF 轮询取 ref）。 */
  aiPanelRef: RefObject<AiPanelHandle>;
  /** 云同步触发器（main 窗口装配；file_save/save_as 成功后 onSaved）。 */
  syncTriggerRef: MutableRefObject<SyncTrigger | null>;
  /** 「退出」广播的 5s 硬退兜底计时器（App 的 app-quit-request 监听共享）。 */
  quitFallbackTimerRef: MutableRefObject<number | undefined>;
  /** 强制关闭序列（App 的 onCloseRequested / app_exit 兜底共享）。 */
  forceCloseRef: MutableRefObject<() => Promise<void>>;
  /** 导出函数的 ref 转发（doExport 身份不稳定，调用时取最新实例）。 */
  doExportRef: MutableRefObject<
    (kind: "html" | "pdf" | "png" | "docx" | "latex") => Promise<void>
  >;
  /** PI2：打印函数的 ref 转发（doPrint 身份不稳定，同 doExport 惯例）。 */
  doPrintRef: MutableRefObject<() => void>;
  /** 标签表快照（Ctrl+Tab 轮换读取）。 */
  tabsRef: MutableRefObject<TabItem[]>;
  /** 活动标签 key（Ctrl+Tab / Ctrl+W 读取）。 */
  activeKeyRef: MutableRefObject<string>;
  /** activateTab 的 ref 镜像（快捷键注册一次，经 ref 读最新回调）。 */
  activateTabRef: MutableRefObject<
    (key: string, freshContent?: string) => Promise<void>
  >;
  /** closeTab 的 ref 镜像（同上；App 侧 moveToNewWindow 也在共用）。 */
  closeTabRef: MutableRefObject<
    (key: string, opts?: { migrated?: boolean }) => Promise<void>
  >;
  /** DE 轮：pdf/docx 编辑态标签的保存分流（另存/替换流程）。返回 false =
   *  活动标签不在编辑态，调用方回落 md 管线保存。 */
  saveDocEditTabRef: MutableRefObject<() => Promise<boolean>>;
  // ---- setState setters（稳定引用）----
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  setSidebarTab: Dispatch<SetStateAction<SidebarTab>>;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  setQuickOpen: Dispatch<SetStateAction<boolean>>;
  setRecentKey: Dispatch<SetStateAction<number>>;
  setTemplateOpen: Dispatch<SetStateAction<boolean>>;
  setCiteOpen: Dispatch<SetStateAction<boolean>>;
  setReviewOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setAboutOpen: Dispatch<SetStateAction<boolean>>;
  setAiOpen: Dispatch<SetStateAction<boolean>>;
  setLinkDialogText: Dispatch<SetStateAction<string>>;
  setLinkDialogOpen: Dispatch<SetStateAction<boolean>>;
  // ---- 稳定回调（原 dispatchMenu 依赖数组成员，随迁移保持原依赖集）----
  /** 新建未命名标签（稳定链路：snapshotActiveTab←getCurrentContent 均空依赖）。 */
  newUntitledTab: (content?: string) => void;
  /** 状态栏闪现消息（稳定：空依赖）。 */
  flashStatus: (msg: string, ms?: number) => void;
  /** 复制富文本（稳定：仅依赖 flashStatus）。 */
  doCopyRich: () => Promise<void>;
  /** 「添加文件夹到工作区」对话框入口（稳定链路见 App.tsx）。 */
  addFolderFromDialog: () => Promise<void>;
  /** 「打开文件夹（替换工作区）」对话框入口（稳定链路见 App.tsx）。 */
  replaceFolderFromDialog: () => Promise<void>;
  /** HN 轮：「导入 HTML 笔记…」（稳定链路：workspacesRef/openHtmlNote）。 */
  importHtmlNote: () => Promise<void>;
  /** MF 轮：统一打开路由的 ref 镜像（file_open 对话框选到 pdf/docx 时走
   *  只读预览标签，md 走编辑器管线）。 */
  openNoteAnyRef: MutableRefObject<(path: string) => void>;
}

export function useMenuCommands(deps: UseMenuCommandsDeps) {
  const {
    fileApiRef,
    settingsRef,
    editorRef,
    aiPanelRef,
    syncTriggerRef,
    quitFallbackTimerRef,
    forceCloseRef,
    doExportRef,
    doPrintRef,
    tabsRef,
    activeKeyRef,
    activateTabRef,
    closeTabRef,
    saveDocEditTabRef,
    setSidebarOpen,
    setSidebarTab,
    setSearchOpen,
    setQuickOpen,
    setRecentKey,
    setTemplateOpen,
    setCiteOpen,
    setReviewOpen,
    setSettingsOpen,
    setAboutOpen,
    setAiOpen,
    setLinkDialogText,
    setLinkDialogOpen,
    newUntitledTab,
    flashStatus,
    doCopyRich,
    addFolderFromDialog,
    replaceFolderFromDialog,
    importHtmlNote,
    openNoteAnyRef,
  } = deps;

  // ----- 统一菜单分发器：原生 `menu` 事件（macOS）与前端菜单栏（Windows）共用 -----
  // 稳定回调（依赖数组维持迁出前原样）：fileApi/settings 经既有 ref 读取；
  // 不稳定的 doExport 经 App 侧 doExportRef 转发；其余依赖
  // （flashStatus/doCopyRich/newUntitledTab/addFolderFromDialog/
  // replaceFolderFromDialog）本身都是稳定引用。
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
      case "file_new_window":
        // v4.8 多窗口：新建空白窗口（菜单「新建窗口」/ Ctrl+Shift+N）。
        void openEmptyNewWindow().catch((e) => {
          noteOpError("new-window", e);
          flashStatus("新建窗口失败", 5000);
        });
        break;
      case "file_open":
        void (async () => {
          // MF 轮：打开对话框并入 PDF/Word 档（DOC_FILTERS）——pdf/docx 只取
          // 路径经 openNoteAny 走只读预览；md 语义不变（openPath 编辑器管线，
          // 与 useFile.open 的 md 分支等价）。
          try {
            const r = await openNoteFromDialog();
            if (!r) return;
            if (r.content == null) {
              openNoteAnyRef.current(r.path);
            } else {
              await fa.openPath(r.path, r.content);
            }
            setRecentKey((k) => k + 1);
          } catch (e) {
            noteOpError("file-open", e);
            flashStatus("打开失败", 5000);
          }
        })();
        break;
      case "file_open_folder":
        void replaceFolderFromDialog();
        break;
      case "file_add_folder":
        void addFolderFromDialog();
        break;
      case "file_import_html":
        // HN 轮：导入 = 拷贝入 vault（对话框选单文件/文件夹在回调内分流）。
        void importHtmlNote();
        break;
      case "file_quick_open":
        setQuickOpen(true);
        break;
      case "file_save":
        // DE 轮：编辑态标签（pdf/docx 原位编辑）分流到 docNoteSave 流程，
        // 绝不落进 md 管线（fa.doc 属于切换前隐藏的旧 md）。
        if (tabsRef.current.find((t) => t.key === activeKeyRef.current)?.docEdit) {
          void saveDocEditTabRef.current();
          break;
        }
        // 乐观反馈：立即提示「已保存」，不等待落盘；失败/未落盘时覆盖提示。
        // 保存成功后把内存内容推进全库索引（单文件增量，铁律 4）。
        flashStatus("已保存");
        {
          const saved = editorRef.current?.getValue() ?? "";
          const savedPath = fa.doc.path;
          fa.save(() => saved)
            .then((ok) => {
              // v5.3.2：save 返回 false = 未落盘（未命名文档另存被取消 /
              // 保存防护冲突且用户拒绝覆盖）——不得推进索引与云同步（会把
              // 未落盘内容当已保存状态），并收回乐观的「已保存」提示。
              if (!ok) {
                flashStatus("未保存（已取消或已拒绝覆盖）", 5000);
                return;
              }
              if (savedPath) vaultIndex.noteSaved(savedPath, saved);
              // v4.12 云同步：保存成功链路挂防抖触发（autoSync 关闭时 no-op）。
              syncTriggerRef.current?.onSaved();
            })
            .catch(() => flashStatus("保存失败", 5000));
        }
        break;
      case "file_save_as":
        {
          const saved = editorRef.current?.getValue() ?? "";
          void fa.saveAs(() => saved).then((ok) => {
            // saveAs 成功后 doc.path 已更新为落盘路径（useFile.saveAs 语义）。
            const p = ok ? fa.doc.path : null;
            if (p) vaultIndex.noteSaved(p, saved);
            if (ok) syncTriggerRef.current?.onSaved();
          })
          // 失败反馈对齐上方 file_save 分支的 .catch 风格。
          .catch(() => flashStatus("另存为失败", 5000));
        }
        break;
      case "file_sync_now":
        // 手动同步统一走 sync-request 转发（D8）：doc 窗口由 main 引擎代执行；
        // main 收到自己的 echo 由互斥挡住，不会双跑。
        void getAdapter().app.emit("sync-request").catch(() => undefined);
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
      case "file_export_latex":
        void doExportRef.current("latex");
        break;
      case "file_print":
        // PI2：打印当前标签（App.doPrint → 应用内打印对话框 PrintDialog →
        // lib/printJob）。caps.print 关闭的平台（harmony 保守关）菜单/键位
        // 本就不出现，这里再守一道（不假成功）。
        if (getAdapter().capabilities.print) doPrintRef.current();
        break;
      case "edit_insert_citation":
        setCiteOpen(true);
        break;
      case "view_review":
        setReviewOpen(true);
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
        const w = getAdapter().app.window;
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
      case "theme_claude":
        void sa.setTheme("claude");
        break;
      case "theme_claude_dark":
        void sa.setTheme("claude-dark");
        break;
      case "theme_ios":
        void sa.setTheme("ios");
        break;
      case "theme_ios_dark":
        void sa.setTheme("ios-dark");
        break;
      case "app_settings":
        setSettingsOpen(true);
        break;
      case "app_about":
        setAboutOpen(true);
        break;
      case "app_exit":
        // v4.8 多窗口「退出」= 广播协议：emit("app-quit-request")（含自己），
        // 各窗自行 close() 走现有 onCloseRequested → shutdownSequence（flush
        // 3s + 未命名确认）→ forceClose 管线。任何窗口的用户取消（未命名脏
        // 缓冲确认点「否」）→ 该窗留存、整个 app 保留——与浏览器一致；最后
        // 一窗关闭时 forceClose 自然 exit。跨窗「一窗收尾中另一窗发起退出」
        // 由各窗独立的 shutdownInFlightRef 串行消化，无需全局锁。
        // 兜底：先挂 5s 硬退计时器再广播；本窗监听器收到事件（协议回路通）
        // 即取消——计时器只在「广播丢包/监听器全挂」的病态场景触发，且确认
        // 弹窗期间（监听器早已收到过事件）不会被误伤。
        void (async () => {
          quitFallbackTimerRef.current = window.setTimeout(() => {
            quitFallbackTimerRef.current = undefined;
            void getAdapter().app.exitApp(0).catch(() => {
              /* 兜底路径不再连环重试 */
            });
          }, 5000);
          try {
            await getAdapter().app.emit("app-quit-request");
          } catch (err) {
            noteOpError("menu-exit-broadcast", err);
            if (quitFallbackTimerRef.current !== undefined) {
              window.clearTimeout(quitFallbackTimerRef.current);
              quitFallbackTimerRef.current = undefined;
            }
            await forceCloseRef.current();
          }
        })();
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
      case "format_fix_md": {
        // 一键修复 Markdown 格式（v4.5）：打开 AI 面板并触发内置修复动作。
        // 面板条件挂载（aiOpen && !focusMode），首次打开要等一帧才拿得到
        // ref —— rAF 轮询与 onAskSelection 同模式。
        setAiOpen(true);
        let fixTries = 0;
        const fireFix = () => {
          const handle = aiPanelRef.current;
          if (handle) handle.fixFormat();
          else if (fixTries++ < 30) requestAnimationFrame(fireFix);
        };
        requestAnimationFrame(fireFix);
        break;
      }
      case "insert_link":
        setLinkDialogText(editorRef.current?.getSelection() ?? "");
        setLinkDialogOpen(true);
        break;
      case "insert_image":
        void (async () => {
          try {
            const picked = await getAdapter().dialog.pickOpenFile([
              { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"] },
            ]);
            if (!picked || typeof picked !== "string") return;
            const bytes = await getAdapter().fs.readFile(picked);
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
    // 全部依赖都是稳定 useCallback（doCopyRich←flashStatus、newUntitledTab←
    // snapshotActiveTab←getCurrentContent、addFolder/replaceFolder←addWorkspaceRoot
    // /replaceWorkspace←flashStatus+refreshRecentWs、importHtmlNote←
    // doImportHtmlNotes←flashStatus+openHtmlNote），列出只为满足
    // exhaustive-deps —— dispatchMenu 的身份仍然不变。refs / setters 经 deps
    // 对象注入后 eslint 无法识别其稳定性，依赖数组维持拆分前原样。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doCopyRich, flashStatus, newUntitledTab, addFolderFromDialog, replaceFolderFromDialog, importHtmlNote]); // ← stable — reads live state via refs
  // 上面「注册一次」的事件监听（menu 事件 / 全局快捷键）只在提交后才执行 ——
  // 经 ref 镜像取调用时的最新 dispatchMenu。
  const dispatchMenuRef = useRef(dispatchMenu);
  dispatchMenuRef.current = dispatchMenu;

  // ----- menu events from Rust (registered ONCE, reads latest hooks via refs) -----
  // macOS 保留原生菜单，其点击以 `menu` 事件转发到这里；Windows 的前端菜单栏
  // （MenuBar）经 onDispatch 走同一条路径 —— 两条入口行为完全一致。
  useEffect(() => {
    const unlistenP = getAdapter().app.listen<string>("menu", (ev) => {
      dispatchMenuRef.current(ev.payload);
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, []); // ← register once — never re-attach

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
          if (e.altKey) {
            // Ctrl+Alt+F：AI 一键修复 Markdown 格式（v4.5）。
            dispatchMenuRef.current("format_fix_md");
          } else if (e.shiftKey) {
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
          // v4.8 多窗口：Ctrl/Cmd+Shift+N 新建窗口；Ctrl+N 仍新建标签，不冲突。
          if (e.shiftKey) dispatchMenuRef.current("file_new_window");
          else dispatchMenuRef.current("file_new");
          break;
        case "o":
          e.preventDefault();
          dispatchMenuRef.current(e.shiftKey ? "file_open_folder" : "file_open");
          break;
        case "p":
          // Ctrl+P = 快速打开（v4.7 语义不动），Ctrl+Shift+P = 打印当前标签
          // （file_print → PI2 应用内打印对话框，lib/printJob 铁律注）。
          // preventDefault 同时拦下 WebView2 自带的 Ctrl+P 打印（旧注释的
          // 「WebView2 默认打印」担忧由拦截消除）。
          e.preventDefault();
          if (e.shiftKey) dispatchMenuRef.current("file_print");
          else setQuickOpen(true);
          break;
        case "\\":
          e.preventDefault();
          setSidebarOpen((o) => !o);
          break;
        case "d":
          // Ctrl+Alt+D：批注诊断面板（v3.9.3）——设置项持久化，与设置
          // 面板的开关同源。仅 Alt 组合生效，避免占用 Ctrl+D。
          if (e.altKey) {
            e.preventDefault();
            const s = settingsRef.current;
            void s.update({ annoDiagPanel: !s.settings.annoDiagPanel });
          }
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
    // refs/setters 经 deps 注入后 eslint 无法识别其稳定性 —— 注册一次，依赖
    // 数组维持拆分前原样。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // ← register once

  return { dispatchMenu };
}

/** 聚焦编辑器表面后执行 document.execCommand —— 原生菜单取消后，撤销/剪切/
 *  复制/全选等预定义项在前端等价实现（WebView2 对 contenteditable 原生支持；
 *  粘贴受浏览器安全策略限制，尽力而为）。 */
function execOnEditor(editor: EditorHandle | null, cmd: string) {
  editor?.find(); // focus the surface first so the command has a target
  document.execCommand(cmd);
}
