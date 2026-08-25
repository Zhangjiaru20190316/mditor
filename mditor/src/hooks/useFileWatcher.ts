// Watch the open file on disk and reload it into the editor when an external
// process modifies it.
//
// Conflict policy (matches the user's choice):
//   * clean buffer  -> silently reload the disk version
//   * dirty buffer  -> confirm; on accept reload, on keep mark "外部已修改"
//
// Self-trigger avoidance: autosave writes to the very file we watch, which
// fires a modify event back at us. We suppress any event whose disk contents
// equal the buffer we just wrote (tracked via lastSavedSignatureRef). We also
// debounce rapid coalesced events (some editors write in several passes).

import { useCallback, useEffect, useMemo, useRef } from "react";
import { watch, readTextFile } from "@tauri-apps/plugin-fs";
import { sysEmit } from "../lib/sysDebug";
import { dirname, basename, toPosix } from "../lib/path-shim";
import { confirmDialog } from "../lib/dialogs";

interface Options {
  /** Absolute path of the open file, or null for an untitled buffer. */
  path: string | null;
  /** Whether the editor buffer currently has unsaved changes. */
  dirty: boolean;
  /**
   * Read the current editor content. Used to detect whether an external
   * change actually differs (avoid reloads / prompts when content is equal)
   * and to feed the signature check.
   */
  getContent: () => string;
  /**
   * Called with the freshly-read disk content when we decide to reload.
   * The Editor implementation pushes it into Vditor via setValue.
   */
  onReload: (content: string) => void;
  /** Status-line flash ("已从外部同步" / "⚠️ 外部已修改"). */
  onStatus?: (msg: string, kind: "sync" | "warn") => void;
  /** When true (during an autosave write), incoming events are ignored. */
  isSavingRef: React.MutableRefObject<boolean>;
}

/** Cheap structural signature so we don't hold two big strings to compare. */
function signature(s: string): number {
  let h = s.length;
  // sample every Nth char so cost stays O(1)-ish for big files
  const n = s.length;
  const step = Math.max(1, Math.floor(n / 4096));
  for (let i = 0; i < n; i += step) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

export function useFileWatcher(opts: Options) {
  // Keep the latest opts without re-subscribing the watcher on every render.
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // Last content WE wrote to disk (autosave / save). Events whose disk content
  // matches this are our own writes echoing back — ignore them.
  const lastSavedSigRef = useRef<number | null>(null);

  useEffect(() => {
    const { path } = optsRef.current;
    if (!path) {
      lastSavedSigRef.current = null;
      return;
    }
    let cancelled = false;
    let unwatch: (() => void) | null = null;
    // Coalesce a burst of events within this window into one reload check.
    let debounceTimer: number | null = null;

    const dir = dirname(path);
    const targetBase = basename(path);
    // Normalize both sides to posix for the comparison; the fs watcher returns
    // platform-native separators on Windows ("\\") while our path-shim uses "/".
    const targetPosix = toPosix(path);

    const considerReload = async () => {
      const o = optsRef.current;
      if (o.isSavingRef.current) return; // we're mid-write
      try {
        const disk = await readTextFile(o.path!);
        // 1) ignore our own autosave echo
        if (lastSavedSigRef.current != null && signature(disk) === lastSavedSigRef.current) {
          return;
        }
        // 2) ignore no-op (disk already matches what's on screen)
        if (disk === o.getContent()) {
          return;
        }
        // 3) conflict resolution
        if (o.dirty) {
          const ok = await confirmDialog(
            "文件已被外部程序修改。\n是否放弃本地未保存的修改，加载磁盘上的最新版本？",
            "Mditor"
          );
          if (!ok) {
            o.onStatus?.("文件已被外部修改", "warn");
            return;
          }
        }
        lastSavedSigRef.current = signature(disk);
        o.onReload(disk);
        o.onStatus?.("已从外部同步", "sync");
      } catch (err) {
        // file may have been removed mid-read; ignore quietly — but leave a
        // diagnostic trace (v4.3): this catch previously swallowed everything.
        sysEmit(
          "file:read-fail",
          `外部修改回读失败 ${o.path ?? "?"}`,
          { level: "warn", data: { label: "watch-reload", err: String(err).slice(0, 200) } }
        );
      }
    };

    const scheduleReload = () => {
      if (debounceTimer != null) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        void considerReload();
      }, 250);
    };

    watch(
      dir,
      (event) => {
        // Only react to writes/creates/removes on our target file.
        const t = event.type as { kind?: string };
        const kind = t.kind ?? "any";
        if (kind !== "modify" && kind !== "create" && kind !== "any") return;
        const hit = event.paths.some((p) => toPosix(p) === targetPosix || basename(p) === targetBase);
        if (!hit) return;
        scheduleReload();
      },
      { recursive: false }
    ).then((un) => {
      if (cancelled) {
        try { un(); } catch { /* gone */ }
        return;
      }
      unwatch = un;
    }).catch((err) => {
      // watching can fail on some network/privileged dirs — fail soft,
      // the editor still works, just without live reload.
      sysEmit(
        "file:watch-fail",
        `文件监听启动失败 ${dir}`,
        { level: "warn", data: { dir, err: String(err).slice(0, 200) } }
      );
    });

    return () => {
      cancelled = true;
      if (debounceTimer != null) window.clearTimeout(debounceTimer);
      try { unwatch?.(); } catch { /* already gone */ }
    };
    // Re-subscribe only when the watched path changes.
     
  }, [opts.path]);

  /**
   * Tell the watcher that a save just wrote `content` to disk, so the
   * resulting modify event can be recognised as our own and ignored.
   *
   * 稳定引用（useCallback + useMemo）：返回对象在组件生命周期内保持同一身份，
   * 避免上层把 watcherApi 写进依赖数组时引发不必要的重运行。
   */
  const noteSaved = useCallback((content: string) => {
    lastSavedSigRef.current = signature(content);
  }, []);

  return useMemo(() => ({ noteSaved }), [noteSaved]);
}
