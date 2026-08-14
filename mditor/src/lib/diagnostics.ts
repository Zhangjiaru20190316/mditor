// Always-on memory diagnostics: samples + a rolling on-disk log.
//
// The app previously had NO runtime logging — a WebView2 renderer OOM killed
// the process with nothing written to disk, so "why did it crash?" was
// unanswerable. This module fixes that: it samples `performance.memory` and
// appends timestamped JSON lines to <app-data>/logs/memory.log, rotated at
// ~2 MB (one backup kept). The memory guard (hooks/useMemoryGuard) drives
// sampling on its tick and logs every heal decision, so a post-crash log shows
// the heap trend + the rebuild/reload events right up to the kill.
//
// Everything here is defensive: logging must NEVER throw into the editor, so
// each public entry point swallows errors. Sampling is cheap (one
// performance.memory read + one IPC append per tick) and runs in production,
// not just dev.
//
// IMPORTANT: the editor is Milkdown/ProseMirror (pure JS — no GopherJS, no
// WebAssembly, no WebAssembly.Memory), so ALL editor state lives on the V8 heap
// and IS counted by `performance.memory.usedJSHeapSize`: the JS heap numbers
// below are the real picture, not an understatement. Each sample also records
// `milkdown` (a ProseMirror view is mounted) and `prosemirrorViews` (the live
// `.ProseMirror` count). The latter should be exactly 1; if it climbs above 1
// after a recreate, the previous instance's destroy did not remove its DOM and
// the recreate is leaking — the symptom of the bug the serialized destroy→create
// in useMilkdown.ts now prevents.

import { invoke } from "@tauri-apps/api/core";
import { joinAbs } from "./path-shim";
import { ensureDir } from "./tauriFs";
import { getHeapUsage, IS_DEV } from "./memory";

const LOG_FILE = "memory.log";
/** Rotate the log once it exceeds this many bytes (one `.1` backup kept). */
const LOG_MAX_BYTES = 2 * 1024 * 1024;

// ---- TEMPORARY diagnostic probe switch ---------------------------------
// Gates the heavy DOM-metric sampling + listener patch so normal use pays
// nothing. Enabled by: Vite dev (IS_DEV), URL `?diag=1`, or
// settings.diagnostics (App routes the setting in via setDiagnosticsEnabled).
// Remove alongside leakCounters/useLeakProbe once the idle leak is located.
let diagEnabled =
  IS_DEV ||
  (typeof location !== "undefined" && /[?&]diag=1\b/.test(location.search));

/** Runtime toggle driven by settings.diagnostics (called from App). */
export function setDiagnosticsEnabled(on: boolean): void {
  diagEnabled = on;
}
/** Whether the heavy DOM-metric sampling should run. */
export function isDiagnosticsEnabled(): boolean {
  return diagEnabled;
}

// Detached-DOM probe registry: useMilkdown pushes the editor host's first
// child on teardown; we count how many are still alive (WeakRef.deref non-null).
// WeakRef deliberately does NOT extend the lifetime of the very node we probe —
// a still-alive entry therefore means SOMETHING ELSE is holding it (a closure /
// listener / plugin state), which is exactly the leak signature we're hunting.
export const detachedRegistry: WeakRef<Element>[] = [];
const DETACHED_CAP = 20;
export function registerDetached(node: Element | null): void {
  if (!diagEnabled || !node) return;
  detachedRegistry.push(new WeakRef(node));
  if (detachedRegistry.length > DETACHED_CAP) detachedRegistry.shift();
}
function countDetachedAlive(): number {
  let n = 0;
  for (const w of detachedRegistry) if (w.deref()) n++;
  return n;
}

// Net active event-listener delta, maintained by installListenerProbe (patches
// EventTarget.prototype at load). A steadily climbing value pinpoints an effect
// that re-mounts listeners without removing them.
let listenerNet = 0;
/**
 * Patch add/removeEventListener to track a net listener count. Call very early
 * (main.tsx, before React mounts). No-op + never throws when diag is off.
 */
export function installListenerProbe(): void {
  if (!diagEnabled || typeof window === "undefined") return;
  try {
    const proto = EventTarget.prototype;
    const origAdd = proto.addEventListener;
    const origRemove = proto.removeEventListener;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    proto.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ): void {
      listenerNet++;
      origAdd.call(this, type, listener, options);
    } as typeof origAdd;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    proto.removeEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions
    ): void {
      listenerNet--;
      origRemove.call(this, type, listener, options);
    } as typeof origRemove;
  } catch {
    /* never let the patch break the app */
  }
}

export interface MemSample {
  /** epoch ms */
  ts: number;
  /** JS heap used bytes (Chromium performance.memory), or null when unavailable. */
  used: number | null;
  /** JS heap total bytes (used + free, pre-GC), or null. */
  total: number | null;
  /** JS heap hard limit bytes, or null. */
  limit: number | null;
  /** True once a Milkdown/ProseMirror view is mounted, else null. */
  milkdown: boolean | null;
  /** Live `.ProseMirror` element count (should be 1; >1 after a recreate means
   *  the previous view's destroy didn't release its DOM → recreate leak). */
  prosemirrorViews: number | null;
  /** Total live DOM element count (DOM-vs-JS-state discriminator). */
  domNodes?: number | null;
  /** Live `.cm-editor` (CodeMirror) count; climbs => sub-editor residue. */
  cmEditors?: number | null;
  /** Live `.katex` count; climbs => KaTeX render residue. */
  katexNodes?: number | null;
  /** Detached nodes still held (WeakRef alive) — leak if climbing. */
  detachedAlive?: number | null;
  /** Net active event listeners added (debug patch). */
  listeners?: number | null;
}

/** Live DOM-metric snapshot. null when diag is off (zero overhead). */
function sampleDomMetrics(): {
  domNodes: number;
  cmEditors: number;
  katexNodes: number;
  detachedAlive: number;
} | null {
  if (!diagEnabled) return null;
  try {
    if (typeof document === "undefined") return null;
    return {
      domNodes: document.querySelectorAll("*").length,
      cmEditors: document.querySelectorAll(".cm-editor").length,
      katexNodes: document.querySelectorAll(".katex").length,
      detachedAlive: countDetachedAlive(),
    };
  } catch {
    return null;
  }
}

/** Read a memory sample right now. Never throws. */
export function sampleMemory(): MemSample {
  const h = getHeapUsage();
  const ed = probeEditorState();
  const dm = sampleDomMetrics();
  const s: MemSample = {
    ts: Date.now(),
    used: h?.used ?? null,
    total: h?.total ?? null,
    limit: h?.limit ?? null,
    milkdown: ed?.milkdown ?? null,
    prosemirrorViews: ed?.prosemirrorViews ?? null,
  };
  if (dm) {
    s.domNodes = dm.domNodes;
    s.cmEditors = dm.cmEditors;
    s.katexNodes = dm.katexNodes;
    s.detachedAlive = dm.detachedAlive;
  }
  if (diagEnabled) s.listeners = listenerNet;
  return s;
}

/**
 * Best-effort snapshot of the live editor surface. `milkdown` is whether a
 * Milkdown/ProseMirror view is mounted at all; `prosemirrorViews` is the count
 * of `.ProseMirror` elements in the DOM. Under healthy operation there is
 * exactly one view; if a recreate leaves the previous view's DOM behind, the
 * count climbs above 1 — the tell-tale of the destroy-not-completing leak that
 * useMilkdown.ts now prevents by serializing destroy→create. Any error querying
 * the DOM yields null (probe disabled), never throws into the editor.
 */
function probeEditorState(): {
  milkdown: boolean;
  prosemirrorViews: number;
} | null {
  try {
    if (typeof document === "undefined") return null;
    const views = document.querySelectorAll(".ProseMirror").length;
    return {
      milkdown: views > 0,
      prosemirrorViews: views,
    };
  } catch {
    return null;
  }
}

let logPathPromise: Promise<string> | null = null;

/** Resolve (once, cached) the absolute path of the memory log, creating the dir. */
async function logPath(): Promise<string> {
  if (!logPathPromise) {
    logPathPromise = (async () => {
      const ad = await invoke<string>("app_data_dir");
      const dir = joinAbs(ad, "logs");
      await ensureDir(dir);
      return joinAbs(dir, LOG_FILE);
    })();
  }
  return logPathPromise;
}

/**
 * Append one diagnostics line. `tag` identifies the event ("sample", "heal",
 * "heal:reload", "heal:backoff", ...); `extra` is merged into the JSON record
 * alongside the memory sample. Never throws — diagnostics must not surface in
 * the UI.
 */
export async function logMemory(
  tag: string,
  extra?: Record<string, unknown>
): Promise<void> {
  try {
    const path = await logPath();
    const s = sampleMemory();
    const record: Record<string, unknown> = {
      ts: new Date(s.ts).toISOString(),
      tag,
      used: s.used,
      total: s.total,
      limit: s.limit,
      milkdown: s.milkdown,
      prosemirrorViews: s.prosemirrorViews,
    };
    if (extra) Object.assign(record, extra);
    await invoke("append_log", {
      path,
      line: JSON.stringify(record) + "\n",
      maxBytes: LOG_MAX_BYTES,
    });
  } catch {
    /* swallow — diagnostics must never break the editor */
  }
}
