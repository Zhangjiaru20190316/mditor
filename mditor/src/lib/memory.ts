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

/**
 * 视口档（isBigDocCv）的公式密度旁路：`$` 定界符数达到此值（≈400 个
 * 公式）即按大文档处理——KaTeX 行内公式的 DOM 成本（每公式数十节点）
 * 由公式数主导而非字节数。生产日志（2026-09-26~28，MD-9001/1003）实测：
 * 104KB/2356 公式文档持续掉帧风暴 + 1~4.5s 长任务，35KB/732 公式文档
 * 切标签 1~4.5s 阻塞，而 6KB/170 公式文档无任何异常——阈值取两类样本
 * 间隙的中段。只影响视口档（content-visibility + 行内公式懒渲染，特性
 * 全保留）；减配档（isBigDoc）不按公式密度触发——那会恰恰关掉公式
 * 渲染，对公式密集文档不可接受。转义 `\$` 与代码块内的 `$` 会造成
 * 高估，方向保守（多触发的是特性保留的视口档），可接受。
 */
export const BIG_DOC_MATH_DOLLARS = 800;

/**
 * 体量档阈值（v4.19，proposal-bigdoc-viewport-auto）：字符数（与
 * BIG_DOC_BYTES 同口径，UTF-16 码元）≥1MB，或顶层块（空行分隔段）≥8000
 * ——二者的并集即「超大文档」，默认自动开启视口档（无需手动开设置）。
 * 数据 A（1MB 压测副本，11629 顶层块）：急切渲染打开 12,479ms / 滚动
 * p95 251-279ms / 点公式 p95 728ms，视口档 5,466ms / 82ms / 88ms——
 * 三条链路全面占优，唯一代价是滚动中行内公式显示源码占位（静止 ~400ms
 * 补渲染）。体量档恒为 sizeIsBigDoc 的子集（1MB > 500KB；8000 段 ≥
 * ~16000 行 > 3000），故只放宽 isBigDocCv 的「开关门」，不放宽体量判定，
 * 删除 isBigDocCv 里的旁路一行即完全回退。
 */
export const BIG_DOC_HUGE_BYTES = 1_000_000;
export const BIG_DOC_HUGE_BLOCKS = 8000;

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

// 「大文档视口渲染」子开关（v4.6.1，与总开关的减配解耦）：只启用
// content-visibility（data-big CSS + cvIntrinsicPlugin 高度记忆），保留
// CodeMirror / KaTeX 渲染。动机：154KB KaTeX 密集文档上选中链路（拖选/
// 三击/点公式）的 0.7~1.7s 卡顿全部来自全量渲染 DOM（21 万节点）的布局款，
// big 总开关实测能把同类交互压到 ≤16ms，但它同时砍掉公式渲染——对公式
// 密集文档不可接受；此开关让用户只拿视口化收益。
let bigDocViewportEnabled = false;

/** 设置「大文档视口渲染」子开关；不影响 isBigDoc（减配档）。 */
export function setBigDocViewportEnabled(v: boolean): void {
  bigDocViewportEnabled = v;
}

// 「超大文档自动开启」开关（v4.19，默认开）：体量档（≥1MB / 顶层块
// ≥8000）文档无需手动开上面的子开关即入视口档。这是
// proposal-bigdoc-viewport-auto 拍板后的默认行为——布尔设置无法区分
// 「从未碰过（false）」与「显式关闭（false）」，故显式退回手动模式走
// 这个独立开关（设置面板「超大文档自动开启」）。初始值与
// DEFAULT_SETTINGS.bigDocViewportAuto 一致（默认开），由 useSettings 与
// 另两个开合同点位同步维护。
let bigDocViewportAutoEnabled = true;

/** 设置「超大文档自动开启」；关掉后体量档旁路失效（回退纯手动模式）。 */
export function setBigDocViewportAutoEnabled(v: boolean): void {
  bigDocViewportAutoEnabled = v;
}

/** Pure size test: big enough to warrant big-doc handling (no setting gate). */
export function sizeIsBigDocRaw(content: string | null | undefined): boolean {
  return sizeIsBigDoc(content);
}

function sizeIsBigDoc(content: string | null | undefined): boolean {
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

/** 纯密度测试：`$` 定界符是否达到视口档阈值（无设置门，早退扫描）。 */
export function sizeIsMathDenseDoc(content: string | null | undefined): boolean {
  if (!content) return false;
  let dollars = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 36 && ++dollars >= BIG_DOC_MATH_DOLLARS) return true;
  }
  return false;
}

/** 纯体量档测试：≥1MB 或顶层块 ≥8000（无设置门，早退扫描）。
 *  顶层块按「空行分隔段」近似：两个换行之间的行全为空白即一段边界。
 *  fenced code 内的空行会切成多段（多计）；连续多个空行分隔符也按
 *  每两个换行计一段（同样多计）——误差方向都是更早触发，而体量档只
 *  开特性保留的视口化，安全侧。块数下界成立：8000 段 ⇒ ≥~16000 行
 *  > BIG_DOC_LINES，故本谓词为真必为 sizeIsBigDoc 真（体量档 ⊂ 体量
 *  测试，见 BIG_DOC_HUGE_BYTES 注释）。 */
export function sizeIsHugeDoc(content: string | null | undefined): boolean {
  if (!content) return false;
  if (content.length >= BIG_DOC_HUGE_BYTES) return true;
  // blankSinceNewline：自上一个 \n 起只见过空白（可能是空行）。
  let blocks = 1;
  let blankSinceNewline = false;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (c === 10) {
      if (blankSinceNewline) {
        if (++blocks >= BIG_DOC_HUGE_BLOCKS) return true;
        blankSinceNewline = false;
      } else {
        blankSinceNewline = true;
      }
    } else if (c !== 13 && c !== 32 && c !== 9) {
      blankSinceNewline = false;
    }
  }
  return false;
}

/** Is the document large enough to warrant preview degradation?
 *  Gated by the 大文档性能模式 master switch (feature-downgrade tier). */
export function isBigDoc(content: string | null | undefined): boolean {
  if (!bigDocModeEnabled) return false;
  return sizeIsBigDoc(content);
}

/** Should the document get content-visibility (viewport rendering)?
 *  True under EITHER the master switch (which implies c-v) or the standalone
 *  viewport sub-switch — the CodeMirror/KaTeX features stay keyed on
 *  isBigDoc alone. Size test OR math-density test: a 35KB/700-formula
 *  document costs the layout engine as much as a 500KB plain-text one
 *  (KaTeX ≈ tens of nodes per formula) — density alone qualifies it for
 *  the viewport tier (see BIG_DOC_MATH_DOLLARS).
 *  v4.19 体量档旁路：开关全关时，超大文档（≥1MB / 顶层块 ≥8000，恒为
 *  体量测试子集）仍自动入视口档（「超大文档自动开启」默认开，可整体
 *  关掉回退纯手动）——数据 A 里急切渲染打开 12.5s/滚动 p95 251ms 对
 *  这类文档不可用。 */
export function isBigDocCv(content: string | null | undefined): boolean {
  if (bigDocModeEnabled || bigDocViewportEnabled) {
    return sizeIsBigDoc(content) || sizeIsMathDenseDoc(content);
  }
  return bigDocViewportAutoEnabled && sizeIsHugeDoc(content);
}

/** Human-readable byte size (B / MB / GB) for status display + logging. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const mb = n / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
