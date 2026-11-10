// Document lifecycle: new / open / save / saveAs, plus dirty tracking.
//
// The editor itself owns the live content (Vditor.getValue()); this hook owns
// the *path* and the save workflow, and exposes a `setContent` callback the
// Editor calls when it loads a file into Vditor.
//
// Performance: all callbacks use refs internally so they have EMPTY dependency
// arrays — the returned object is memoised and referentially stable across
// renders. This is critical: App passes `fileApi` to many memoised children,
// and Editor's `setOnLoaded` effect depends on `fileApi`; an unstable object
// would force both to re-run on every keystroke.

import { useCallback, useMemo, useRef, useState } from "react";
import { openMd, saveMd, saveMdAs, baseName } from "../lib/tauriFs";
import { pushRecent } from "../lib/store";
import { invalidatePrefetch } from "../lib/filePrefetch";
import { getAdapter } from "../platform";
import { confirmDialog } from "../lib/dialogs";
import type { DocState } from "../types";

export interface FileApi {
  doc: DocState;
  /**
   * Synchronous-fresh read of the current doc path (v4.12.3). `doc` is React
   * state: within the same tick that openPath/showDoc assigns a new document,
   * the memoised `doc` property is still the PREVIOUS commit — but the editor
   * load (onLoaded → setValue → ProseMirror node views) runs synchronously
   * inside that same tick and resolves relative image refs against docPath at
   * node-view creation time. Reading it via this ref-backed getter is what
   * makes those resolutions see the NEW path. */
  docPathSync: () => string | null;
  // NOTE: `onLoaded` is intentionally NOT exposed here. It is a pure internal
  // callback slot (written via setOnLoaded, read via onLoadedRef by open /
  // openPath). Exposing it — and putting it in the useMemo dep array below —
  // made fileApi change identity on every setOnLoaded call; coupled with
  // Editor's setOnLoaded effect that formed a self-sustaining render storm that
  // leaked the fileApi useMemo closure at ~MB/s. Callers that need loaded
  // content register via setOnLoaded.
  /** Set the callback the editor uses to receive freshly loaded content.
   *  `tabKey` identifies the tab the document belongs to (App 层的 tab key，
   *  未命名标签也唯一)——Editor 用它做 per-tab 滚动位置记忆。 */
  setOnLoaded: (
    cb: ((content: string, tabKey: string | null) => void) | null
  ) => void;
  /** Replace the buffer with a blank document. `tabKey` 见 setOnLoaded. */
  newDoc: (tabKey?: string | null) => void;
  open: () => Promise<boolean>;
  /** `tabKey` 见 setOnLoaded. */
  openPath: (path: string, content: string, tabKey?: string | null) => Promise<void>;
  /**
   * Restore a full DocState into the buffer WITHOUT touching the recent list —
   * the tab-switch path (V3.6 多标签页). Pushes the content into the editor via
   * onLoaded exactly like openPath, but skips the pushRecent IPC chain so
   * flipping between tabs doesn't churn mditor.json / reorder 最近.
   * `tabKey` 见 setOnLoaded.
   */
  showDoc: (doc: DocState, tabKey?: string | null) => void;
  save: (getContent: () => string) => Promise<boolean>;
  /**
   * Persist the buffer to disk WITHOUT touching the recent list. Used by
   * autosave so the periodic write doesn't deserialize→rewrite the whole
   * mditor.json every tick (the path is already recent from open/saveAs).
   * Returns false if the buffer has no path (caller must have a path).
   *
   * v5.3.x 外部关联保存防护：文件处于断开外部关联的文件夹（无 watcher
   * 保护）时，写盘前比对磁盘内容与基线内容——外部已改即冲突：
   *  - 缺省（自动保存/后台流程）：跳过写入返回 false（调用方自行提示）；
   *  - confirmOnConflict=true（手动保存）：弹确认框，确认后覆盖保存。
   * 关联文件夹的文件不做任何校验（watcher 即保护，既有行为零变化）。
   */
  writeOnly: (getContent: () => string, confirmOnConflict?: boolean) => Promise<boolean>;
  saveAs: (getContent: () => string) => Promise<boolean>;
  /** Mark the buffer dirty (called by the editor on input). */
  markDirty: () => void;
  /** Clear the dirty flag (called after save). */
  markClean: () => void;
  /**
   * Record an external reload (file watcher): the buffer is clean AND its
   * content is now `content`. Unlike a bare markClean this keeps doc.content
   * authoritative — snapshotActiveTab trusts doc.content for clean tabs
   * (skipping the O(n) getMarkdown serialize), so it must never go stale.
   */
  noteExternalReload: (content: string) => void;
  /**
   * Update the on-disk path of the current buffer without touching its content
   * (called after the open file is renamed in the file tree). No-op if the
   * current path doesn't match `oldPath`.
   */
  updatePath: (oldPath: string, newPath: string) => void;
}

/** useFile 选项（v5.3.x 外部关联保存防护）。 */
export interface UseFileOptions {
  /**
   * 该路径是否需要保存前外部修改校验（App 传入稳定回调：文件所在文件夹
   * 断开外部关联 → true）。缺省/返回 false = 既有行为零变化。
   */
  shouldGuardWrite?: (path: string) => boolean;
}

export function useFile(opts?: UseFileOptions): FileApi {
  const [doc, setDoc] = useState<DocState>({
    path: null,
    content: "",
    dirty: false,
  });
  const [onLoaded, setOnLoadedState] =
    useState<((content: string, tabKey: string | null) => void) | null>(null);

  // Refs holding the latest state so callbacks can stay referentially stable
  // (empty deps) while still reading fresh values at call time.
  const docRef = useRef(doc);
  docRef.current = doc;
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  /**
   * 基线内容 = 最近一次「已确认与磁盘一致」的缓冲区内容（磁盘装载点 /
   * 自身写盘成功 / 外部重载）。保存防护据此判定磁盘是否被外部改动过。
   * null = 未知（脏标签快照恢复等）→ 校验 fail-open（放行写入，见
   * prewriteCheck 注释；本次成功写盘后基线即重建）。
   */
  const baselineContentRef = useRef<string | null>(null);

  /**
   * 写盘前校验（v5.3.x，仅断开外部关联的文件走这里）。内容级比对（无
   * mtime 时钟精度问题）：磁盘 === 将写内容 → same（无意义写盘可跳过）；
   * 磁盘 === 基线 → ok；其余（含读取失败，如被删除）→ conflict。
   */
  const prewriteCheck = useCallback(
    async (path: string, content: string): Promise<"ok" | "same" | "conflict"> => {
      try {
        const disk = await getAdapter().fs.readTextFile(path);
        if (disk === content) return "same";
        const baseline = baselineContentRef.current;
        // 基线未知（脏标签快照恢复）→ fail-open（与既有 watch 启动失败的
        // 场景同待遇）：外部改动兜不住，但不至于把自动保存永久堵死；本次
        // 成功写盘后基线即重建，后续外部改动恢复防护。
        if (baseline === null || disk === baseline) return "ok";
        return "conflict";
      } catch {
        return "conflict";
      }
    },
    []
  );

  const setOnLoaded = useCallback(
    (cb: ((content: string, tabKey: string | null) => void) | null) => {
      setOnLoadedState(() => cb); // wrap so React treats it as a value, not a thunk
    },
    []
  );

  const newDoc = useCallback((tabKey?: string | null) => {
    const next = { path: null, content: "", dirty: false };
    docRef.current = next; // 同步可读（见 docPathSync 注释）
    baselineContentRef.current = null;
    setDoc(next);
    onLoadedRef.current?.("", tabKey ?? null);
  }, []);

  const openPath = useCallback(
    async (path: string, content: string, tabKey?: string | null) => {
      const next = { path, content, dirty: false };
      docRef.current = next; // 同步可读（见 docPathSync 注释）——编辑器载入在同一 tick 内读 docPath
      baselineContentRef.current = content; // 磁盘刚读出的内容即基线（v5.3.x）
      setDoc(next);
      // CRITICAL ORDERING: push the content into the editor BEFORE awaiting the
      // recent-list IPC chain. pushRecent does loadRecent + set + save (three
      // serialized IPC roundtrips); running it first used to delay the visible
      // content by that whole window. Now the editor paints the new document
      // immediately, and the recent-list update (invisible to the user while
      // they're looking at the editor) runs right after.
      onLoadedRef.current?.(content, tabKey ?? null);
      await pushRecent({
        path,
        name: baseName(path),
        openedAt: new Date().toISOString(),
      });
    },
    []
  );

  const open = useCallback(async () => {
    const r = await openMd();
    if (!r) return false;
    await openPath(r.path, r.content);
    return true;
  }, [openPath]);

  const showDoc = useCallback((d: DocState, tabKey?: string | null) => {
    const next = { path: d.path, content: d.content, dirty: d.dirty };
    docRef.current = next; // 同步可读（见 docPathSync 注释）
    // 干净快照 = 快照时点的磁盘内容 → 可作基线；脏快照含未保存编辑，基线
    // 未知（置 null，校验 fail-open；见 baselineContentRef 注释）。
    baselineContentRef.current = d.dirty ? null : d.content;
    setDoc(next);
    onLoadedRef.current?.(d.content, tabKey ?? null);
  }, []);

  const saveAs = useCallback(
    async (getContent: () => string) => {
      const d = docRef.current;
      const content = getContent();
      // First-line-as-name is free-form prose — strip characters Windows
      // forbids in file names (plus control chars and trailing dots/spaces),
      // or the save dialog can end up with an unusable default name.
      const title = (d.content.split("\n")[0] ?? "")
        .slice(0, 40)
        // eslint-disable-next-line no-control-regex -- 控制字符正是要清洗的目标
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
        .replace(/[\s.]+$/, "");
      const suggest = d.path ? baseName(d.path) : title || "untitled.md";
      const path = await saveMdAs(content, suggest.endsWith(".md") ? suggest : `${suggest}.md`);
      if (!path) return false;
      invalidatePrefetch(path);
      // 对话框期间到达的编辑不在本次落盘内容里：保持 dirty，让自动保存/
      // Ctrl+S 把它们写入新路径，而不是被误标为已保存。
      const live = getContent();
      const next = { ...docRef.current, path, content: live, dirty: live !== content };
      docRef.current = next; // 同步可读（见 docPathSync 注释）
      baselineContentRef.current = content; // 刚写盘的内容即新路径基线
      setDoc(next);
      await pushRecent({
        path,
        name: baseName(path),
        openedAt: new Date().toISOString(),
      });
      return true;
    },
    []
  );

  // 落盘后的收尾（save/writeOnly 共用）：只有缓冲区在写盘窗口内没被别人
  // 动过（prev.content 仍等于提交时的快照）才回写状态。dirty 按「当前实时
  // 内容是否等于提交内容」判定 —— 写盘期间的新击键保持 dirty，由下一次
  // 自动保存补写，不会被误清（v3.9.1 修复：旧版无条件清脏+回写旧内容，
  // 会把 IPC 窗口内的输入静默丢弃）。
  const settleAfterWrite = useCallback(
    (getContent: () => string, submitted: string, contentAtSubmit: string) => {
      const live = getContent();
      setDoc((prev) =>
        prev.content === contentAtSubmit
          ? { ...prev, content: live, dirty: live !== submitted }
          : prev
      );
    },
    []
  );

  const save = useCallback(
    async (getContent: () => string) => {
      const d = docRef.current;
      if (!d.path) return saveAs(getContent);
      const content = getContent();
      // v5.3.x 保存防护（断开外部关联的文件）：冲突时确认覆盖。
      if (optsRef.current?.shouldGuardWrite?.(d.path)) {
        const verdict = await prewriteCheck(d.path, content);
        if (verdict === "conflict") {
          const ok = await confirmDialog(
            "文件已被外部程序修改。\n确定覆盖磁盘上的版本并保存？",
            "Mditor"
          );
          if (!ok) return false;
        }
      }
      await saveMd(d.path, content);
      baselineContentRef.current = content;
      invalidatePrefetch(d.path);
      settleAfterWrite(getContent, content, d.content);
      await pushRecent({
        path: d.path,
        name: baseName(d.path),
        openedAt: new Date().toISOString(),
      });
      return true;
    },
    [saveAs, settleAfterWrite, prewriteCheck]
  );

  // Lightweight disk write for autosave: skip the recent-list churn. The path
  // is already in the recent list from open/saveAs, so re-serializing the whole
  // store every 30s is pure waste — and over a long editing session that steady
  // IPC/JSON churn is a leading cause of webview memory growth.
  const writeOnly = useCallback(
    async (getContent: () => string, confirmOnConflict?: boolean) => {
      const d = docRef.current;
      if (!d.path) return false;
      const content = getContent();
      // v5.3.x 保存防护（断开外部关联的文件，无 watcher 保护）：磁盘被外部
      // 改动 → 缺省静默跳过（自动保存/后台流程），confirmOnConflict=true
      // （手动保存）弹确认后覆盖。「same」= 磁盘已是将写内容，免写直接收尾。
      if (optsRef.current?.shouldGuardWrite?.(d.path)) {
        const verdict = await prewriteCheck(d.path, content);
        if (verdict === "conflict") {
          if (confirmOnConflict) {
            const ok = await confirmDialog(
              "文件已被外部程序修改。\n确定覆盖磁盘上的版本并保存？",
              "Mditor"
            );
            if (!ok) return false;
          } else {
            return false;
          }
        } else if (verdict === "same") {
          baselineContentRef.current = content;
          settleAfterWrite(getContent, content, d.content);
          return true;
        }
      }
      await saveMd(d.path, content);
      baselineContentRef.current = content;
      invalidatePrefetch(d.path);
      settleAfterWrite(getContent, content, d.content);
      return true;
    },
    [settleAfterWrite, prewriteCheck]
  );

  const markDirty = useCallback(() => {
    setDoc((d) => (d.dirty ? d : { ...d, dirty: true }));
  }, []);

  const markClean = useCallback(() => {
    setDoc((d) => (d.dirty ? { ...d, dirty: false } : d));
  }, []);

  const noteExternalReload = useCallback((content: string) => {
    // 外部程序改写了磁盘：预读缓存里的旧内容必须失效，否则下次打开该
    // 文件会把缓存里的过期版本当作最新（v3.9.1）。
    const path = docRef.current.path;
    if (path) invalidatePrefetch(path);
    baselineContentRef.current = content; // 重载内容即新基线（v5.3.x）
    setDoc((d) => ({ ...d, content, dirty: false }));
  }, []);

  const updatePath = useCallback((oldPath: string, newPath: string) => {
    const d = docRef.current;
    if (d.path !== oldPath) return;
    const next = { ...d, path: newPath };
    docRef.current = next; // 同步可读（见 docPathSync 注释）
    setDoc(next);
  }, []);

  // Stable object: only changes identity when `doc` changes. setOnLoaded is a
  // stable useCallback and onLoaded is deliberately NOT a dep (see FileApi) —
  // it is read internally via onLoadedRef, so changing it must NOT rebuild
  // fileApi. (Letting it rebuild is what previously coupled this hook to
  // Editor's setOnLoaded effect into a render storm / heap leak.)
  return useMemo(
    () => ({
      doc,
      docPathSync: () => docRef.current.path,
      setOnLoaded,
      newDoc,
      open,
      openPath,
      showDoc,
      save,
      writeOnly,
      saveAs,
      markDirty,
      markClean,
      noteExternalReload,
      updatePath,
    }),
    [doc, setOnLoaded, newDoc, open, openPath, showDoc, save, writeOnly, saveAs, markDirty, markClean, noteExternalReload, updatePath]
  );
}
