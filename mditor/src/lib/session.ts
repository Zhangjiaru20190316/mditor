// Session snapshot across a healing webview reload.
//
// The memory guard's hard tier is a full webview reload: it tears the whole
// page down via window.location.reload(), discarding the entire V8 context.
// This is the guaranteed reclaim when even a soft recreate fails to dent usage
// — e.g. a leak outside the editor, or fragmentation V8 won't return without a
// context tear-down. (A soft recreate now genuinely reclaims because
// useMilkdown awaits the previous Crepe's destroy before remounting; the reload
// is only the fallback, no longer the only reliable option.)
//
// A reload loses all in-memory state, so before reloading we snapshot the
// minimum needed to restore the session (which file was open, edit mode, scroll
// position, and — for untitled buffers with no on-disk path — the content
// itself) into sessionStorage, and App re-hydrates from it on the next boot.
// sessionStorage (not localStorage) so it never survives a real close/reopen.

const KEY = "mditor:heal-snapshot";

export type EditModeLite = "wysiwyg" | "ir" | "sv";

export interface HealSnapshot {
  /** Open file path, or null for an untitled buffer. */
  path: string | null;
  mode: EditModeLite;
  /** Best-effort vertical scroll of the editor surface, restored after rehydrate. */
  scrollTop: number;
  /** Untitled-buffer content (only set when path is null). */
  untitledContent: string | null;
  /** epoch ms — purely diagnostic. */
  ts: number;
}

/** Persist the snapshot. Never throws — a heal must never be blocked by storage. */
export function saveHealSnapshot(s: Omit<HealSnapshot, "ts">): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...s, ts: Date.now() }));
  } catch {
    /* sessionStorage unavailable / quota — reload still proceeds without restore */
  }
}

/**
 * Consume the snapshot (read + clear). Returns null when there is none (normal
 * boot) or when storage is unreadable. Always clears so a failed restore can't
 * loop the reload on the next boot.
 */
export function takeHealSnapshot(): HealSnapshot | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    return JSON.parse(raw) as HealSnapshot;
  } catch {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    return null;
  }
}
