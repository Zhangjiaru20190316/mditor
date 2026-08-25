// Periodic autosave. Every `intervalMs` (if > 0), if the buffer is dirty AND
// the document has a path, write it to disk and clear the dirty flag.
//
// Untitled documents are NOT autosaved (no path) — the editor still tracks
// dirty so the user is warned on close/open. TODO(P2): snapshot untitled
// buffers to app-data for crash recovery.

import { useEffect, useRef } from "react";
import { sysEmit } from "../lib/sysDebug";

export interface AutosaveOptions {
  intervalMs: number;
  dirty: boolean;
  hasPath: boolean;
  /** Read current editor content. */
  getContent: () => string;
  /** Persist content to the doc's path. */
  doSave: (getContent: () => string) => Promise<boolean>;
  /** Called after a successful autosave (e.g. to flash a status indicator). */
  onSaved?: () => void;
}

export function useAutosave(opts: AutosaveOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // Re-entrancy guard: setInterval fires on schedule regardless of whether the
  // previous async save finished. If a save ever takes longer than the interval
  // (large doc, slow disk, IPC backlog), overlapping save chains pile up — each
  // holding the full document content + recent list in closures → memory growth.
  const busyRef = useRef(false);

  useEffect(() => {
    if (opts.intervalMs <= 0) return;
    const id = window.setInterval(async () => {
      const o = optsRef.current;
      if (busyRef.current) return; // previous save still in flight; skip this tick
      if (!o.dirty || !o.hasPath) return;
      busyRef.current = true;
      try {
        const ok = await o.doSave(o.getContent);
        if (ok) o.onSaved?.();
      } catch (err) {
        // swallow; next tick will retry — but leave a diagnostic trace (v4.3):
        // autosave failures silently retrying forever is invisible without it.
        sysEmit(
          "file:write-fail",
          "自动保存失败（下一周期重试）",
          { level: "warn", data: { label: "autosave", err: String(err).slice(0, 200) } }
        );
      } finally {
        busyRef.current = false;
      }
    }, opts.intervalMs);
    return () => window.clearInterval(id);
  }, [opts.intervalMs]);
}
