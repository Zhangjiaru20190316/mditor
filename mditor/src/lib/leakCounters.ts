// TEMPORARY diagnostic instrumentation to locate the idle heap leak.
//
// RESOLVED 2026-08: the leak was NEITHER (a) nor (b) below — it was a
// self-sustaining React render loop (Editor's setOnLoaded effect ↔ useFile's
// fileApi memo, which depended on onLoaded). Pure React scheduling, so it
// correctly stayed invisible to every timer/DOM counter here — which is exactly
// why the counters were all 0 while the heap still climbed. Fixed in
// Editor.tsx + hooks/useFile.ts. This module can now be removed; it is kept
// temporarily only to confirm the fix holds (counters stay 0 AND heap flat).
//
// Findings so far (see memory.log "counters" lines): the heap climbs ~10 MB/s
// while EVERY app-layer handler is silent — docChanges/domMutations/stamps/
// fsEvents all 0, and even window-level raf/setInterval/setTimeout are 0 in
// steady state. That points at an allocator that either (a) captured a timer
// reference at module-load inside the compiled Milkdown/ProseMirror/CodeMirror
// bundle (so a window-level patch installed AFTER imports is invisible to it),
// or (b) is not a JS timer at all.
//
// This module does three things to crack it from logs alone (no DevTools):
//   1. AUTO-INSTALLS (on import, which main.tsx does FIRST) a wrapper around
//      globalThis.requestAnimationFrame/setInterval/setTimeout BEFORE any
//      dependency's module body can capture a reference — so even captured
//      loops are counted. A 60 fps loop shows up as raf ~= 600 per 10s window.
//   2. After a ~12s settle, captures ONE registration stack for each of raf /
//      setInterval / setTimeout and logs it ("probe-stack") — the stack's file
//      names which engine bundle owns the loop.
//   3. drainLeakCounters also logs `domNodes` (document.getElementsByTagName
//      count): if it grows while timers are 0 -> DOM leak; if flat -> pure JS
//      state growth.
//
// Always-on (not IS_DEV-gated) because the leak reproduces in the production
// build. Remove useLeakProbe + this module once the leak is found.

import { logMemory, sampleMemory } from "./diagnostics";

const counts: Record<string, number> = {};

/** Increment a named handler counter. Cheap (one property write); safe on hot paths. */
export function bumpLeakCounter(key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

// Heap-usage history for slope estimation. Only records when `used` is present
// (Chromium) so a non-Chromium webview contributes nothing bogus.
const heapHistory: { ts: number; used: number }[] = [];
const HEAP_HISTORY_CAP = 60; // 60 * 10s window = up to 10 minutes of trend

/**
 * Linear-fit heap-growth slope in MB/min over the most recent samples (max 6).
 * null until we have at least two readings. Distinguishes a real monotonic leak
 * (slope > 0 persistently) from GC sawtooth (slope ≈ 0 / oscillates).
 */
function heapSlopeMbPerMin(): number | null {
  const pts = heapHistory.filter((p) => p.used != null);
  if (pts.length < 2) return null;
  const win = pts.slice(-6);
  const t0 = win[0].ts;
  const u0 = win[0].used;
  let num = 0;
  let den = 0;
  for (const p of win) {
    const dtMin = (p.ts - t0) / 60000; // minutes
    const duMb = (p.used - u0) / (1024 * 1024); // MB
    num += dtMin * duMb;
    den += dtMin * dtMin;
  }
  if (den === 0) return null;
  return num / den;
}

/**
 * Snapshot + reset every counter, logging them with the heap sample + DOM
 * metrics + growth slope as a single `probe` line. Always logs so a climbing
 * heap with zero handler activity is itself a signal. Never throws.
 */
export async function drainLeakCounters(): Promise<void> {
  const snapshot: Record<string, number> = { ...counts };
  for (const k of Object.keys(counts)) counts[k] = 0;

  const s = sampleMemory();
  if (s.used != null) {
    heapHistory.push({ ts: s.ts, used: s.used });
    if (heapHistory.length > HEAP_HISTORY_CAP) heapHistory.shift();
  }

  const extra: Record<string, unknown> = { ...snapshot };
  if (s.domNodes != null) extra["domNodes"] = s.domNodes;
  if (s.cmEditors != null) extra["cmEditors"] = s.cmEditors;
  if (s.katexNodes != null) extra["katexNodes"] = s.katexNodes;
  if (s.detachedAlive != null) extra["detachedAlive"] = s.detachedAlive;
  if (s.listeners != null) extra["listeners"] = s.listeners;
  const slope = heapSlopeMbPerMin();
  if (slope != null) extra["slopeMbPerMin"] = Number(slope.toFixed(3));

  try {
    await logMemory("probe", extra);
  } catch {
    /* swallow — diagnostics must never surface in the UI */
  }
}

// ---- early timer probe --------------------------------------------------
let probeInstalled = false;
/** Arm stack capture after the app settles so we capture the steady-state loop. */
let stackArmed = false;
let rafStackDone = false;
let siStackDone = false;
let stStackDone = false;

function captureStack(): string {
  try {
    const s = new Error().stack ?? "";
    // Keep the caller chain (drop the leading "Error" line), pipe-joined so it
    // stays a single loggable string.
    return s.split("\n").slice(1, 11).join(" | ");
  } catch {
    return "";
  }
}

/**
 * Wrap globalThis.requestAnimationFrame/setInterval/setTimeout to count every
 * invocation (into the same `counts` drained above) and, once each, capture a
 * registration stack. Must run BEFORE any dependency captures these timers —
 * hence main.tsx imports this module FIRST and we auto-install on load.
 */
export function installGlobalTimerProbe(): void {
  if (probeInstalled || typeof window === "undefined") return;
  probeInstalled = true;

  // Arm after ~12s so the captured call reflects steady state, not init churn.
  window.setTimeout(() => {
    stackArmed = true;
  }, 12_000);

  const origRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    counts["raf"] = (counts["raf"] ?? 0) + 1;
    if (stackArmed && !rafStackDone) {
      rafStackDone = true;
      void logMemory("probe-stack", { kind: "raf", stack: captureStack() });
    }
    return origRaf(cb);
  }) as typeof window.requestAnimationFrame;

  const origSetInterval = window.setInterval.bind(window);
  window.setInterval = ((...args: Parameters<typeof window.setInterval>): number => {
    counts["setInterval"] = (counts["setInterval"] ?? 0) + 1;
    if (stackArmed && !siStackDone) {
      siStackDone = true;
      void logMemory("probe-stack", { kind: "setInterval", stack: captureStack() });
    }
    return origSetInterval(...args);
  }) as typeof window.setInterval;

  const origSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = ((...args: Parameters<typeof window.setTimeout>): number => {
    counts["setTimeout"] = (counts["setTimeout"] ?? 0) + 1;
    if (stackArmed && !stStackDone) {
      stStackDone = true;
      void logMemory("probe-stack", { kind: "setTimeout", stack: captureStack() });
    }
    return origSetTimeout(...args);
  }) as typeof window.setTimeout;
}

// AUTO-INSTALL on import. main.tsx imports this module as its FIRST import so
// this runs before react-dom / App / @milkdown module bodies can capture the
// timers — closing the "captured at load" blind spot of a later patch.
installGlobalTimerProbe();
