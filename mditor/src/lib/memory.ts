// Chromium-only memory introspection + thresholds for the OOM self-heal guard.
//
// The editor is Milkdown/ProseMirror (pure JS — no GopherJS, no WebAssembly, no
// WebAssembly.Memory), so ALL editor state lives on the V8 heap as ordinary JS
// objects and `performance.memory.usedJSHeapSize` DOES include it: the JS heap
// numbers are the real picture, not an understatement.
//
// ROOT CAUSE of the idle leak (found & fixed 2026-08): a self-sustaining React
// render loop. useFile memoised `fileApi` with `onLoaded` in its dep array, and
// Editor's setOnLoaded effect depended on `fileApi` — so setOnLoaded → onLoaded
// changes → fileApi rebuilt → effect re-runs → setOnLoaded → …, millions of
// times/min, each run allocating a fileApi useMemo factory closure that piled
// up on the heap. It dodged every timer/DOM counter (all stayed 0) because it
// was pure React scheduling. Fix: Editor.tsx reads fileApi via a ref (fileApi
// removed from the effect deps) and useFile no longer exposes/depends on
// `onLoaded`. Heap is now flat at idle (slopeMbPerMin ≈ 0).
//
// The recreate path below is a separate, EARLIER fix (not the idle leak):
// Crepe.destroy() is async and was fired without awaiting, so the guard's soft
// recreate mounted a new ProseMirror view before the old one released — each
// recreate leaked one editor's worth of state. useMilkdown.ts now serializes
// destroy→create (prevDestroyRef), so a recreate genuinely reclaims; the guard
// escalates to a full webview reload only when a soft recreate fails to dent
// usage (see hooks/useMemoryGuard + lib/session for the snapshot/restore).
//
// `performance.memory` exists only in Chromium-derived runtimes. WebView2 is
// Edge/Chromium so it is available here; we feature-detect and no-op elsewhere
// (e.g. running the same code under a different backend), so release builds on
// non-Chromium webviews degrade silently instead of crashing.

/** Heap snapshot, or null when the runtime lacks performance.memory. */
export interface HeapInfo {
  /** Bytes currently in use by the JS heap. */
  used: number;
  /** Total allocated JS heap (used + free, before GC). */
  total: number;
  /** Hard limit the JS heap may grow to. */
  limit: number;
}

interface ChromiumMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function chromiumMemory(): ChromiumMemory | null {
  const p = performance as Performance & { memory?: ChromiumMemory };
  const m = p.memory;
  if (!m || typeof m.usedJSHeapSize !== "number") return null;
  return m;
}

/** Read the current JS heap usage, or null if unavailable. */
export function getHeapUsage(): HeapInfo | null {
  const m = chromiumMemory();
  if (!m) return null;
  return {
    used: m.usedJSHeapSize,
    total: m.totalJSHeapSize,
    limit: m.jsHeapSizeLimit,
  };
}

/** True when running under Vite dev (gates the diagnostic probes). */
export const IS_DEV = Boolean(import.meta.env && import.meta.env.DEV);

/**
 * Big-document cutoffs: beyond these we trade features (code highlighting,
 * KaTeX inline-digit, faster preview debounce) for memory + CPU headroom. The
 * values are tuned so a typical note is unaffected but a pasted-in book / huge
 * log triggers the degraded path. Evaluated at editor (re)creation time, so a
 * mode switch / self-heal rebuild picks up the current document size.
 */
export const BIG_DOC_LINES = 3000;
export const BIG_DOC_BYTES = 500_000;

// 设置「大文档性能模式」的总开关（useSettings 在设置加载/每次更新时同步
// 维护，不在 effect 里更新——子组件 effect 先于父组件执行，同步设置才能
// 保证 useMilkdown 的档位翻转检测读到新值）。初始值与 DEFAULT_SETTINGS
// .bigDocPerformance 一致（默认关），避免启动窗口期档位判定与设置默认值
// 分叉。false = 无论文档多大都不降级。
let bigDocModeEnabled = false;

/** 设置「大文档性能模式」总开关；false 时 isBigDoc 恒为 false（恒不降级）。 */
export function setBigDocModeEnabled(v: boolean): void {
  bigDocModeEnabled = v;
}

/** Is the document large enough to warrant preview degradation? */
export function isBigDoc(content: string | null | undefined): boolean {
  if (!bigDocModeEnabled) return false;
  if (!content) return false;
  if (content.length > BIG_DOC_BYTES) return true;
  // Count lines without allocating a full array; bail as soon as we exceed.
  let lines = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      lines++;
      if (lines > BIG_DOC_LINES) return true;
    }
  }
  return lines > BIG_DOC_LINES;
}

/** Human-readable byte size (B / MB / GB) for status display + logging. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const mb = n / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
