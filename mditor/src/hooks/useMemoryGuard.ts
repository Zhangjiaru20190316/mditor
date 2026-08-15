// Memory self-heal: a soft recreate tier, escalating to a hard webview reload.
//
// The editor is Milkdown/ProseMirror (pure JS — no GopherJS lute), so
// `performance.memory.usedJSHeapSize` sees all of it. The leak this guard was
// built around — recreate reclaiming nothing because destroy never released —
// is fixed at the source: useMilkdown.ts now awaits the previous Crepe's
// destroy before mounting a new view, so a soft recreate genuinely frees the
// old ProseMirror view + plugin states + CodeMirror sub-editors + KaTeX.
//
// Policy, per ~10s tick:
//   * under threshold → reset the "soft tried" flag (growth episode over).
//   * over threshold, past cooldown, not backed off → heal:
//       - tier 1 (soft): recreate(). Now that destroy is awaited, this reclaims
//         the previous editor instance; recheck 8s later.
//       - tier 2 (hard): if the soft tier didn't dent usage, OR usage is
//         already critical (>90% of the heap limit, no time to waste), reload
//         the webview (guaranteed reclaim). The reload path snapshots session
//         state first so App can re-hydrate (see lib/session).
//   * if a reload happened very recently and usage is already climbing again,
//     that's a genuine runaway we can't fix by reloading once more — back off
//     and tell the user to save + restart, rather than spin in a reload loop.

import { useEffect, useRef } from "react";
import { logMemory, sampleMemory } from "../lib/diagnostics";
import { getHeapUsage } from "../lib/memory";

export interface MemoryGuardOptions {
  /** Master switch (settings.memoryGuard). */
  enabled: boolean;
  /** JS-heap threshold in MB (settings.memoryGuardThresholdMb). */
  thresholdMb: number;
  /** ms between checks + samples. */
  intervalMs?: number;
  /** ms cooldown between heal attempts (anti-thrash on the soft tier). */
  cooldownMs?: number;
  /** ms minimum between full reloads (anti-loop: a reload that didn't help). */
  reloadCooldownMs?: number;
  /** Tier 1: destroy + rebuild the editor (cheap; content preserved). */
  recreate: () => void;
  /**
   * Tier 2: full webview reload (guaranteed reclaim). The implementation must
   * snapshot session state (path/mode/scroll/untitled content) BEFORE calling
   * window.location.reload(); see Editor's reloadForHeal + lib/session.
   */
  reload: () => void;
  /** Whether the buffer can be saved right now (dirty && hasPath). */
  canSave: () => boolean;
  /** Persist now; resolve true on success. */
  save: () => Promise<boolean>;
  /** Status-line notifier (same channel as the file watcher). */
  onStatus?: (msg: string, kind: "sync" | "warn") => void;
}

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_RELOAD_COOLDOWN_MS = 3 * 60 * 1000;
/** Recheck delay after a soft recreate before deciding to escalate. */
const SOFT_RECHECK_MS = 8_000;
/** Used ≥ this fraction of the heap limit → skip the soft tier, reload now. */
const CRITICAL_RATIO = 0.9;

export function useMemoryGuard(opts: MemoryGuardOptions) {
  // Read the latest options on each tick without resetting the interval: `opts`
  // is a fresh object every render (Editor passes it inline).
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const lastHealRef = useRef(0);
  const lastReloadRef = useRef(0);
  const backoffRef = useRef(false);
  /** True once a soft recreate has been tried in the current growth episode. */
  const softTriedRef = useRef(false);

  useEffect(() => {
    if (!opts.enabled) return;
    const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

    // Soft-tier recheck state. The 8s setTimeout used to be fire-and-forget:
    // if the component unmounted or the guard was disabled in between, the
    // callback could still fire and escalate into a window reload. Track the
    // handle + a cancelled flag so effect teardown neutralizes it.
    let cancelled = false;
    let recheckTimer: number | null = null;
    const clearRecheck = () => {
      if (recheckTimer != null) {
        window.clearTimeout(recheckTimer);
        recheckTimer = null;
      }
    };

    const escalateReload = async (
      beforeUsed: number,
      beforeProsemirrorViews: number | null,
      why: "escalate" | "critical"
    ) => {
      const o = optsRef.current;
      const now = Date.now();
      const reloadCooldownMs = o.reloadCooldownMs ?? DEFAULT_RELOAD_COOLDOWN_MS;
      if (now - lastReloadRef.current < reloadCooldownMs) {
        // Reloaded recently and already climbing again — a reload loop won't
        // help. Back off and surface it instead of thrashing the page.
        backoffRef.current = true;
        o.onStatus?.(
          "内存持续偏高：已暂停自动优化，建议保存 (Ctrl+S) 后重启",
          "warn"
        );
        void logMemory("heal:backoff", { reason: "reload-cooldown", beforeUsed });
        return;
      }
      // Refresh the on-disk copy right before the page tears down so the
      // reloaded session reopens the latest content.
      if (o.canSave()) await o.save();
      lastReloadRef.current = now;
      o.onStatus?.("内存优化中：刷新页面以释放内存…", "warn");
      void logMemory("heal:reload", { why, beforeUsed, beforeProsemirrorViews });
      o.reload(); // snapshots + window.location.reload(); page ends here
    };

    const id = window.setInterval(async () => {
      const o = optsRef.current;
      if (!o.enabled) return;

      const now = Date.now();
      const cooldownMs = o.cooldownMs ?? DEFAULT_COOLDOWN_MS;
      const heap = getHeapUsage();
      const used = heap?.used ?? 0;
      const limit = heap?.limit ?? 0;
      const thresholdBytes = o.thresholdMb * 1024 * 1024;
      const overThreshold = used > thresholdBytes;
      const critical = limit > 0 && used > limit * CRITICAL_RATIO;
      const pastCooldown = now - lastHealRef.current > cooldownMs;

      if (!overThreshold) {
        // Back under threshold → the growth episode is over; allow a fresh soft
        // tier next time.
        if (softTriedRef.current && pastCooldown) softTriedRef.current = false;
        return;
      }
      if (backoffRef.current || !pastCooldown) {
        // Over threshold but we've given up, or a recent heal is still settling.
        void logMemory("sample", {
          used,
          threshold: thresholdBytes,
          critical,
          backoff: backoffRef.current,
          softTried: softTriedRef.current,
        });
        return;
      }

      // Over threshold + past cooldown + not backed off → heal.
      if (o.canSave()) await o.save();

      if (critical || softTriedRef.current) {
        // About to OOM, or the soft tier already failed this episode → go
        // straight to a full reload (the only reliable reclaim).
        lastHealRef.current = now;
        const before = sampleMemory();
        await escalateReload(
          before.used ?? used,
          before.prosemirrorViews,
          critical ? "critical" : "escalate"
        );
        return;
      }

      // Tier 1 — soft recreate. Now that useMilkdown awaits the previous
      // destroy before remounting, this genuinely frees the old editor instance;
      // recheck shortly, and escalate to a reload only if it didn't help.
      softTriedRef.current = true;
      lastHealRef.current = now;
      o.onStatus?.("内存优化中：重建编辑器…", "warn");
      const before = sampleMemory();
      o.recreate();
      void logMemory("heal", {
        tier: "soft",
        beforeUsed: before.used,
        beforeProsemirrorViews: before.prosemirrorViews,
      });

      // Defensive: a previous recheck can't still be pending here (cooldown
      // 60s > recheck 8s), but clear before re-arming so timers can never stack.
      clearRecheck();
      recheckTimer = window.setTimeout(() => {
        recheckTimer = null;
        // The guard may have been disabled or the component unmounted since
        // this was scheduled — a stale recheck must never trigger a reload.
        if (cancelled || !optsRef.current.enabled) return;
        const after = sampleMemory();
        const u = after.used ?? 0;
        // Always log the recheck so memory.log shows whether recreate reclaimed
        // (reclaimed > 0 + prosemirrorViews back to 1) or leaked (views > 1).
        void logMemory("heal:soft-recheck", {
          used: after.used,
          prosemirrorViews: after.prosemirrorViews,
          reclaimed:
            before.used != null && after.used != null
              ? before.used - after.used
              : null,
        });
        if (u > thresholdBytes) {
          // Soft tier didn't dent it — escalate to a full reload.
          void escalateReload(u, after.prosemirrorViews, "escalate");
        }
        // (If usage dropped below threshold, leave softTriedRef true; it clears
        //  on the next under-threshold tick once past cooldown.)
      }, SOFT_RECHECK_MS);
    }, intervalMs);

    return () => {
      cancelled = true;
      clearRecheck();
      window.clearInterval(id);
    };
    // Only re-subscribe when the master switch toggles. All other options are
    // read through optsRef.current on each tick, so they don't need to reset the
    // interval (and `opts` is a fresh object every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled]);
}
