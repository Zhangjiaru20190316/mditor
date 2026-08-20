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
import type { DocState } from "../types";

export interface FileApi {
  doc: DocState;
  // NOTE: `onLoaded` is intentionally NOT exposed here. It is a pure internal
  // callback slot (written via setOnLoaded, read via onLoadedRef by open /
  // openPath). Exposing it — and putting it in the useMemo dep array below —
  // made fileApi change identity on every setOnLoaded call; coupled with
  // Editor's setOnLoaded effect that formed a self-sustaining render storm that
  // leaked the fileApi useMemo closure at ~MB/s. Callers that need loaded
  // content register via setOnLoaded.
  /** Set the callback the editor uses to receive freshly loaded content. */
  setOnLoaded: (cb: ((content: string) => void) | null) => void;
  newDoc: () => void;
  open: () => Promise<boolean>;
  openPath: (path: string, content: string) => Promise<void>;
  /**
   * Restore a full DocState into the buffer WITHOUT touching the recent list —
   * the tab-switch path (V3.6 多标签页). Pushes the content into the editor via
   * onLoaded exactly like openPath, but skips the pushRecent IPC chain so
   * flipping between tabs doesn't churn mditor.json / reorder 最近.
   */
  showDoc: (doc: DocState) => void;
  save: (getContent: () => string) => Promise<boolean>;
  /**
   * Persist the buffer to disk WITHOUT touching the recent list. Used by
   * autosave so the periodic write doesn't deserialize→rewrite the whole
   * mditor.json every tick (the path is already recent from open/saveAs).
   * Returns false if the buffer has no path (caller must have a path).
   */
  writeOnly: (getContent: () => string) => Promise<boolean>;
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

export function useFile(): FileApi {
  const [doc, setDoc] = useState<DocState>({
    path: null,
    content: "",
    dirty: false,
  });
  const [onLoaded, setOnLoadedState] =
    useState<((content: string) => void) | null>(null);

  // Refs holding the latest state so callbacks can stay referentially stable
  // (empty deps) while still reading fresh values at call time.
  const docRef = useRef(doc);
  docRef.current = doc;
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const setOnLoaded = useCallback((cb: ((content: string) => void) | null) => {
    setOnLoadedState(() => cb); // wrap so React treats it as a value, not a thunk
  }, []);

  const newDoc = useCallback(() => {
    setDoc({ path: null, content: "", dirty: false });
    onLoadedRef.current?.("");
  }, []);

  const openPath = useCallback(
    async (path: string, content: string) => {
      setDoc({ path, content, dirty: false });
      // CRITICAL ORDERING: push the content into the editor BEFORE awaiting the
      // recent-list IPC chain. pushRecent does loadRecent + set + save (three
      // serialized IPC roundtrips); running it first used to delay the visible
      // content by that whole window. Now the editor paints the new document
      // immediately, and the recent-list update (invisible to the user while
      // they're looking at the editor) runs right after.
      onLoadedRef.current?.(content);
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

  const showDoc = useCallback((d: DocState) => {
    setDoc({ path: d.path, content: d.content, dirty: d.dirty });
    onLoadedRef.current?.(d.content);
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
      setDoc((prev) => ({ ...prev, path, content: live, dirty: live !== content }));
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
      await saveMd(d.path, content);
      invalidatePrefetch(d.path);
      settleAfterWrite(getContent, content, d.content);
      await pushRecent({
        path: d.path,
        name: baseName(d.path),
        openedAt: new Date().toISOString(),
      });
      return true;
    },
    [saveAs, settleAfterWrite]
  );

  // Lightweight disk write for autosave: skip the recent-list churn. The path
  // is already in the recent list from open/saveAs, so re-serializing the whole
  // store every 30s is pure waste — and over a long editing session that steady
  // IPC/JSON churn is a leading cause of webview memory growth.
  const writeOnly = useCallback(
    async (getContent: () => string) => {
      const d = docRef.current;
      if (!d.path) return false;
      const content = getContent();
      await saveMd(d.path, content);
      invalidatePrefetch(d.path);
      settleAfterWrite(getContent, content, d.content);
      return true;
    },
    [settleAfterWrite]
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
    setDoc((d) => ({ ...d, content, dirty: false }));
  }, []);

  const updatePath = useCallback((oldPath: string, newPath: string) => {
    setDoc((d) => (d.path === oldPath ? { ...d, path: newPath } : d));
  }, []);

  // Stable object: only changes identity when `doc` changes. setOnLoaded is a
  // stable useCallback and onLoaded is deliberately NOT a dep (see FileApi) —
  // it is read internally via onLoadedRef, so changing it must NOT rebuild
  // fileApi. (Letting it rebuild is what previously coupled this hook to
  // Editor's setOnLoaded effect into a render storm / heap leak.)
  return useMemo(
    () => ({
      doc,
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
