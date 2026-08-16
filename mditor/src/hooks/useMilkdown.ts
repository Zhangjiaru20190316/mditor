// Milkdown (Crepe) lifecycle + configuration factory.
//
// Replaces useVditor.ts with an editor whose engine is pure JS/ProseMirror
// (no GopherJS lute), so the heap that grew monotonically and survived destroy
// is gone. The exposed handle preserves the imperative surface the rest of the
// app (Editor.tsx's EditorHandle) relied on from Vditor.
//
//   * Crepe provides commonmark + gfm (incl. footnotes), history, clipboard,
//     indent, trailing, upload, plus opt-in features: CodeMirror code blocks,
//     KaTeX (latex), image block, slash (block-edit), table, link tooltip.
//   * Mode switching: Milkdown is a live WYSIWYG, so wysiwyg and ir share one
//     Crepe instance (only the label differs); sv ("source") is a textarea that
//     round-trips through getMarkdown()/replaceAll. The Crepe instance stays
//     alive (hidden) in sv so getHTML()/exports keep working synchronously.
//   * Annotations live as native `[^anno-N]` footnotes. Milkdown emits
//     <sup data-type="footnote_reference" data-label="anno-N"> and
//     <dl data-type="footnote_definition" data-label="anno-N">, which CSS restyle
//     into badges / hide outright (see styles/annotation.css) — no per-render
//     DOM stamping needed, unlike the Vditor MutationObserver approach.
//   * Heading ids: the outline's rich-mode ids are extracted straight from the
//     live ProseMirror doc (attrs.id — the very ids on the rendered <hN>), so
//     Outline → getElementById jumps always resolve. The headingIdGenerator
//     override below merely keeps those ids predictable slugs.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { Crepe } from "@milkdown/crepe";
import {
  replaceAll,
  insert,
  getHTML,
  replaceRange,
  insertPos,
  markdownToSlice,
  callCommand,
} from "@milkdown/utils";
import { editorViewCtx, parserCtx } from "@milkdown/core";
import { closeHistory } from "@milkdown/prose/history";
import { toggleMark, setBlockType as pmSetBlockType, wrapIn, lift } from "@milkdown/prose/commands";
import { wrapInList, liftListItem } from "@milkdown/prose/schema-list";
import {
  addRowBefore,
  addRowAfter,
  addColumnBefore,
  addColumnAfter,
  deleteRow,
  deleteColumn,
} from "@milkdown/prose/tables";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { Slice } from "@milkdown/prose/model";
import type { Mark, Node as PMNode, ResolvedPos } from "@milkdown/prose/model";
import { headingIdGenerator, toggleInlineCodeCommand } from "@milkdown/kit/preset/commonmark";
import { syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { highlightPlugins } from "../lib/highlightMark";
import { textColorPlugins } from "../lib/textColorMark";
import { createSvEditor } from "../lib/svCodeMirror";
import type { SvEditorHandle, SvSurface } from "../lib/svCodeMirror";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/nord.css";
import type { EditMode, Settings, BlockInfo, BlockTargetKind, FlatHeading } from "../types";
import { persistImage, persistRemoteImage, resolveImgSrc } from "../lib/imageManager";
import { isBigDoc, getHeapUsage } from "../lib/memory";
import { logMemory } from "../lib/diagnostics";
import { headingSlugBase } from "../lib/outline";
import {
  normalizeAnchorText,
  findAnchorPos,
  findAnchorRange,
  nearestOccurrenceEnd,
} from "../lib/anchorSearch";
import type { CodeLineMeta } from "../lib/codeAnno";
import { stampAnnotationMarkers } from "./useAnnotationMarkers";
import { stampEditorImageLazyAttrs } from "../lib/imageLazy";
import { COLOR_DECL_RE, colorFromStyle } from "../lib/colorSpan";

/** Imperative ops Editor.tsx composes its EditorHandle from. Mirrors the subset
 *  of the Vditor instance Editor.tsx called (getValue/setValue/getHTML/
 *  getSelection/insertValue/updateValue/focus). */
export interface MilkdownFacade {
  getValue: () => string;
  setValue: (md: string, clearStack?: boolean) => void;
  getHTML: () => string;
  getSelection: () => string;
  insertValue: (md: string) => void;
  /** Replace the current selection with parsed `md` (inserts at cursor if none). */
  updateValue: (md: string) => void;
  /** Insert parsed `md` immediately AFTER the current selection (cursor stays
   *  after the inserted block). Used by the AI panel's "insert after selection". */
  insertAfter: (md: string) => void;
  /** Live selection's document positions {from,to}, or null when collapsed.
   *  Captured while the selection is alive so a caller can later insert at that
   *  exact range (e.g. anchoring an annotation) without relying on plain text. */
  getSelectionRange: () => { from: number; to: number } | null;
  /** Insert parsed `md` at an explicit document position, independent of the
   *  current (possibly collapsed) selection. */
  insertAtPos: (md: string, pos: number) => void;
  /** Place a `[^id]` annotation marker near the anchor described by `range` /
   *  `anchorText`, as close as the schema allows. When the anchor sits inside a
   *  block that can't hold an inline footnote_reference (code_block, math_block,
   *  …), the marker is dropped into a fresh marker paragraph immediately AFTER
   *  that block instead of inside it (an inside insert is silently rejected by
   *  the schema, which is why annotating code blocks used to leave a dangling
   *  definition with no badge). Returns true when a marker was placed, false
   *  when no usable spot was found so the caller can fall back to the tail. */
  insertAnnoMarker: (
    id: string,
    range: { from: number; to: number } | null,
    anchorText?: string
  ) => boolean;
  /** Plain text spanning document positions [from,to]. Used to validate that a
   *  range captured earlier still corresponds to anchorText (the document may
   *  have been edited between capture and use). */
  getTextAt: (from: number, to: number) => string;
  /** End document position of the first occurrence of `needle` inside a single
   *  text node, or -1 if not found. Searching the document tree (not the
   *  markdown source) yields a position where an inserted footnote_reference
   *  lands as a sibling inline node — never inside bold/code/link syntax
   *  markers (which is what made AI annotations fail to render). */
  findTextPos: (needle: string) => number;
  /** Toggle bold (strong) on the current selection. Rich mode runs the
   *  ProseMirror toggleMark; sv mode wraps/unwraps the textarea with `**`. */
  toggleBold: () => void;
  /** Toggle ==highlight== on the current selection. Rich mode runs the
   *  highlight toggleMark; sv mode wraps/unwraps the textarea with `==`. */
  toggleHighlight: () => void;
  /** Toggle *italic* (emphasis) on the current selection（V3.6）. */
  toggleItalic: () => void;
  /** Toggle ~~strikethrough~~ on the current selection（V3.6）. */
  toggleStrikethrough: () => void;
  /** Toggle `inline code` on the current selection（V3.6）. Rich mode runs
   *  milkdown's toggleInlineCodeCommand；sv 模式用 ` 包裹。 */
  toggleInlineCode: () => void;
  /** 把当前选区变成（或以 text 为文字在光标处创建）指向 href 的链接（V3.6）。 */
  insertLink: (href: string, text?: string) => void;
  /** 在光标处插入脚注 `[^fn-N]`，并在文末追加其空定义（V3.6）。返回脚注 id。 */
  insertFootnote: () => string | null;
  /** sv 模式：滚动到 0-based `line` 行首并把光标放那里（大纲跳转）。 */
  jumpToLine: (line: number) => void;
  /** Whether the sv surface is the CodeMirror instance（Editor 用它决定隐藏
   *  回退 textarea）。 */
  svCodeMirrorActive: () => boolean;
  /** Apply a text color to the current selection (replaces any existing color).
   *  Rich mode runs a removeMark+addMark transaction; sv mode wraps the textarea
   *  selection with `<span style="color:…">…</span>`. */
  setTextColor: (color: string) => void;
  /** Remove any text color from the current selection. */
  clearTextColor: () => void;
  /** Whether the current selection/caret already carries bold / highlight /
   *  a text color — drives the active state of the toolbar buttons/swatches. */
  getActiveMarks: () => {
    bold: boolean;
    highlight: boolean;
    italic: boolean;
    strike: boolean;
    code: boolean;
    color: string | null;
  };
  /* ---- 块级右键菜单（BlockContextMenu）----------------------------------
   * 仅富文本模式有效（sv 返回 null / no-op，由调用方避免弹出）。点击坐标来自
   * contextmenu 事件的 clientX/Y。 */
  /** 解析屏幕坐标处的块信息并把光标规范到该块（右键不移动 PM 选区，若不
   *  规范，后续命令会作用于右键前光标所在的无关块）。返回 null 表示坐标
   *  不在文档内或编辑器未就绪。 */
  getBlockInfoAt: (x: number, y: number) => BlockInfo | null;
  /** 把当前块切换为目标类型（带 toggle 语义：同款标题/列表再点一次还原为
   *  段落；blockquote 为包裹/解包裹；hr 为在当前顶层块后插入分割线）。 */
  setBlockType: (kind: BlockTargetKind, level?: number) => void;
  /** 当前块上移/下移一格（跳过空段落；列表内以整个列表项为单位）。
   *  返回是否真的移动了（到边界返回 false）。 */
  moveBlock: (dir: "up" | "down") => boolean;
  /** 在当前块下方插入其副本，光标移入副本。 */
  duplicateBlock: () => void;
  /** 删除当前块，光标落到相邻块。 */
  deleteBlock: () => void;
  /** 表格行/列操作（点击处已规范到表格内某个单元格）。 */
  tableOp: (op: "rowBefore" | "rowAfter" | "colBefore" | "colAfter" | "delRow" | "delCol") => void;
  /** 改写 [from,to] 链接的 href；href 为空串则移除链接（保留文字）。 */
  updateLinkHref: (from: number, to: number, href: string) => void;
  /** 删除 `pos` 处的节点（用于图片）。 */
  deleteNodeAt: (pos: number) => void;
  /** 改写 `pos` 处图片的 src（用于「更换图片」，写入可移植的 markdown 引用）。 */
  setImageSrc: (pos: number, src: string) => void;
  /* ---- AI 写回（一步撤销契约）---------------------------------------------
   * AI 的任何一次写回都恰好构成一个撤销步骤：富文本模式下每个写回都是
   * 一个带 closeHistory 标记的事务（强制开启新的撤销组，绝不与用户此前的
   * 输入合并），sv 模式下经 select-all/range + execCommand("insertText")
   * 写入，textarea 的原生撤销把整次写回当作一步。 */
  /** 整篇写回（改动审查「全部应用」/ 替换全文）。 */
  aiWriteDoc: (md: string) => void;
  /** 区间写回（改动审查选区模式）：把 [from,to) 替换为解析后的 md。 */
  aiWriteRange: (from: number, to: number, md: string) => void;
  /** 在光标处插入（AI「插入到光标」）。 */
  aiWriteInsert: (md: string) => void;
  /** 多事务写回收尾（AI 批注流式精炼）：先无痕恢复 baseline（不记入历史），
   *  再把 next 作为唯一被记录的事务写入——一次撤销即回到 baseline。 */
  aiWriteFinalize: (baseline: string, next: string) => void;
  /** 代码行级批注：range 位于代码块内时返回 {start,end,firstLine} 行锚点，
   *  否则 null（调用方退回块级批注）。 */
  getCodeAnchorAt: (range: { from: number; to: number } | null) => CodeLineMeta | null;
  /** 滚动文档到 needle 首次出现处（只移动视图/选区，不产生历史步骤）。 */
  revealText: (needle: string) => void;
  /** 定位 needle（hint 附近的那个匹配）的文档区间，找不到返回 null。
   *  用于选区失效后按内容回退定位。 */
  findTextRange: (needle: string, hint?: number) => { from: number; to: number } | null;
  focus: () => void;
}

export interface MilkdownHandle {
  /** Imperative facade; null until the editor is ready. */
  editor: MilkdownFacade | null;
  ready: boolean;
  mode: EditMode;
  /** Current doc exceeds the big-doc cutoff (CodeMirror/KaTeX disabled). */
  bigDoc: boolean;
  /** sv surface is backed by the CodeMirror instance (fallback = textarea). */
  svCm: boolean;
  /** Switch edit mode. Content is preserved; undo history is cleared on the
   *  sv ⇄ rich transition (replaceAll flush). wysiwyg ⇄ ir is a label change. */
  switchMode: (m: EditMode) => void;
  /** Destroy + rebuild the Crepe instance in place (memory-guard escape hatch). */
  recreate: () => void;
  /** Re-apply font/size/spacing vars when settings change. */
  applyTheme: (s: Settings) => void;
}

interface Options {
  hostRef: RefObject<HTMLDivElement | null>;
  sourceRef: RefObject<HTMLTextAreaElement | null>;
  /** sv 模式的 CodeMirror 宿主（V3.6）；不可用时回退 sourceRef textarea。 */
  svHostRef: RefObject<HTMLDivElement | null>;
  docPath: () => string | null;
  onInput: (md: string) => void;
  /** Live document headings (rich modes). Emitted only when the heading
   *  signature actually changes; the array ref is stable across no-op edits. */
  onHeadings?: (flat: FlatHeading[]) => void;
  settings: Settings;
}

// ---- T6: proactive history reclaim ---------------------------------------
// ProseMirror/Milkdown keep nearly every edit step on the undo stack, which is
// the main "only grows within a single document" memory source. There is no
// public API to PARTIALLY trim it, and the memory guard already reclaims it via
// a soft recreate once usage crosses the threshold. To reduce how often that
// escalates to a full page reload, we PROACTIVELY reclaim history on idle for
// big documents that have been heavily edited AND whose heap is already in the
// warning band — by far the cheapest safe move (it reuses the trusted recreate
// path; the alternative, hand-rolled EditorState surgery, risks editor
// corruption on exactly the big docs we can least afford to break).
//
// The gate is intentionally strict so this never disturbs normal editing: only
// big docs, only after a long idle (user stepped away), only with many edits
// accumulated, and only when the heap is genuinely elevated. The caret/scroll
// reset that recreate implies is acceptable on a long idle and is strictly
// better than the hard reload this prevents.
const IDLE_HISTORY_TRIM_MS = 180_000; // 3 min of no edits
const IDLE_HISTORY_TRIM_EDITS = 1000; // accumulated edits since last reclaim
const IDLE_HISTORY_TRIM_HEAP_RATIO = 0.8; // heap ≥ 80% of the guard threshold

/** 粘贴的纯文本恰好是一个远程图片 URL（可带查询串/锚点）时触发下载落盘。 */
const REMOTE_IMG_URL_RE =
  /^https?:\/\/\S+\.(png|jpe?g|gif|webp|svg|bmp)(?:[?#]\S*)?$/i;

export function useMilkdown(opts: Options): MilkdownHandle {
  const { hostRef, sourceRef, svHostRef } = opts;
  const crepeRef = useRef<Crepe | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setModeState] = useState<EditMode>("wysiwyg");
  const [bigDoc, setBigDoc] = useState(false);
  const [recreateToken, setRecreateToken] = useState(0);
  // ---- sv 模式的 CodeMirror 表面（V3.6）--------------------------------
  // 首次进入 sv 时惰性创建并常驻（隐藏），每次进入 sv 用 setValueReset 重置
  // 内容与撤销历史。所有 sv 分支经 svSurface() 读取：优先 CM 适配器，回退
  // 旧 <textarea>（CM 创建失败/宿主缺失时仍可用）。
  const svRef = useRef<SvEditorHandle | null>(null);
  const [svCm, setSvCm] = useState(false);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const bigDocRef = useRef(false);
  // Content used to SEED a freshly (re)built Crepe. Updated from getValue()
  // right before every destroy/recreate.
  const contentRef = useRef<string>("");
  // Live mirror of the textarea text in sv mode (for getValue before the ref is
  // attached / during transitions).
  const sourceTextRef = useRef<string>("");
  // True while we are applying a programmatic replaceAll, so the markdownUpdated
  // listener does not echo the change back up as user input.
  const suppressRef = useRef(false);
  // One-entry cache for sv-mode getHTML (see facade.getHTML): the last
  // source-mode markdown pushed into the hidden Crepe + its serialized HTML.
  // Reset at the top of every (re)create so a new instance never serves a
  // stale serialization.
  const svHtmlCacheRef = useRef<{ md: string | null; html: string }>({
    md: null,
    html: "",
  });
  // The destroy() promise of the most recent Crepe instance, carried across
  // effect runs so the next create awaits it before mounting a fresh view.
  // Crepe.destroy() is async; without this serialization the new ProseMirror
  // view mounts on the same host while the old one's plugin states / CodeMirror
  // sub-editors / KaTeX are still releasing, so each recreate leaks one editor's
  // worth of state — the memory guard's own recreate loop turns that into
  // monotonic heap growth.
  const prevDestroyRef = useRef<Promise<void>>(Promise.resolve());

  // T6: edits since the last proactive history reclaim + the pending idle timer
  // that, when it fires, may trigger a recreate to drop the undo stack.
  const editsSinceTrimRef = useRef(0);
  const idleTrimTimerRef = useRef<number | null>(null);

  const settingsRef = useRef(opts.settings);
  settingsRef.current = opts.settings;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const onInputRef = useRef(opts.onInput);
  onInputRef.current = opts.onInput;
  const onHeadingsRef = useRef(opts.onHeadings);
  onHeadingsRef.current = opts.onHeadings;

  // ---- create / recreate ------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // A fresh instance means the sv-mode HTML cache no longer describes it.
    svHtmlCacheRef.current = { md: null, html: "" };
    let destroyed = false;
    let instance: Crepe | null = null;
    // Pending double-rAF for annotation stamping. Coalesced (only one walk
    // queued at a time) and cancellable, so a typing burst doesn't queue a walk
    // per keystroke and teardown can cancel any in-flight walk before destroy.
    let pendingRaf: number | null = null;
    const scheduleStamp = () => {
      if (pendingRaf != null) return;
      // Milkdown finalizes footnote node attrs over a couple of frames after the
      // transaction, so double-rAF walks the settled DOM.
      pendingRaf = requestAnimationFrame(() => {
        pendingRaf = requestAnimationFrame(() => {
          pendingRaf = null;
          stampAnnotationMarkers();
          // T0: lazy-load off-screen editor images (idempotent, no-op w/o imgs).
          stampEditorImageLazyAttrs();
        });
      });
    };

    // Serialize destroy→create: wait for the PREVIOUS instance to finish tearing
    // down before mounting a fresh view. Crepe.destroy() is async; without this,
    // the new ProseMirror view mounts on the same host while the old one's plugin
    // states / CodeMirror sub-editors / KaTeX are still releasing, so each
    // recreate leaks one editor's worth of state. The memory guard's own
    // recreate loop turns that into monotonic heap growth — this is the primary
    // fix for "JS heap keeps rising". (React effects can't be async, so we kick
    // the chain off and guard with `destroyed`; the cleanup records its destroy
    // promise on prevDestroyRef for the next run to await.)
    const build = prevDestroyRef.current.then(async () => {
      if (destroyed) return; // cleanup ran while we waited for the prev destroy

      const seed = contentRef.current;
      const big = isBigDoc(seed);
      bigDocRef.current = big;
      setBigDoc(big);

      const crepe = new Crepe({
        root: host,
        defaultValue: "",
        features: {
          [Crepe.Feature.CodeMirror]: !big,
          [Crepe.Feature.Latex]: !big,
          [Crepe.Feature.TopBar]: false,
          [Crepe.Feature.AI]: false,
        },
        featureConfigs: {
          // 公式块（$$...$$）默认只显示 KaTeX 渲染结果，隐藏 LaTeX 源码；
          // 点击代码块上的切换按钮可回到源码编辑。仅影响 latex 代码块——
          // 普通代码块没有 preview，code-block 不会对其加 hidden 类，照常显示。
          [Crepe.Feature.CodeMirror]: {
            previewOnlyByDefault: true,
            // basicSetup 自带的 defaultHighlightStyle 用 style-mod 注入一套
            // 硬编码的浅色（主题无关，且类名是运行时生成的随机名，外层 CSS
            // 无法接管）。这里注册 classHighlighter（非 fallback，优先级更高）
            // 让 token 输出稳定的 tok-* 类，颜色交给 global.css 的 --tok-*
            // 变量按主题渲染，与 AI 面板的 hljs 配色保持同源。
            extensions: [syntaxHighlighting(classHighlighter)],
          },
          [Crepe.Feature.ImageBlock]: {
            // Return the portable markdown ref (relative `assets/…`); proxyDomURL
            // below rewrites it to asset:// only for display, so the saved
            // markdown stays portable.
            onUpload: async (file: File) => {
              const r = await persistImage(file, optsRef.current.docPath());
              return r.ref;
            },
            proxyDomURL: (url: string) =>
              resolveImgSrc(url, optsRef.current.docPath()),
          },
          [Crepe.Feature.Placeholder]: {
            text: "开始书写…  (Ctrl+S 保存，Ctrl+F 查找)",
            mode: "doc",
          },
        },
      });

      // T6: schedule a proactive history reclaim after a long idle. Re-armed on
      // every real (non-suppressed) doc change, so it only fires once typing has
      // truly paused. Cleared on teardown below.
      const scheduleIdleTrim = () => {
        if (idleTrimTimerRef.current != null) {
          window.clearTimeout(idleTrimTimerRef.current);
        }
        idleTrimTimerRef.current = window.setTimeout(() => {
          idleTrimTimerRef.current = null;
          if (destroyed) return;
          if (!bigDocRef.current) return;
          if (editsSinceTrimRef.current < IDLE_HISTORY_TRIM_EDITS) return;
          const heap = getHeapUsage();
          const thresholdBytes =
            settingsRef.current.memoryGuardThresholdMb * 1024 * 1024;
          // Only reclaim when the heap is genuinely elevated — otherwise this
          // would disturb big-doc users whose memory is perfectly fine.
          if (!heap || heap.used < thresholdBytes * IDLE_HISTORY_TRIM_HEAP_RATIO) {
            return;
          }
          editsSinceTrimRef.current = 0;
          void logMemory("heal", { tier: "idle-history-trim" });
          setRecreateToken((t) => t + 1);
        }, IDLE_HISTORY_TRIM_MS);
      };

      crepe.on((l) => {
        l.markdownUpdated((_c, md) => {
          // Only echo user-visible input when we aren't applying a programmatic
          // replaceAll (setValue/seed/switchMode) — those notify the caller
          // themselves. Annotation stamping, however, must run on EVERY doc
          // change (including programmatic ones like file load) so the badges/
          // hidden defs stay correct regardless of how the DOM came to be.
          if (!suppressRef.current) {
            contentRef.current = md;
            onInputRef.current(md);
            // T6: count real edits toward the proactive history-reclaim gate.
            editsSinceTrimRef.current++;
            scheduleIdleTrim();
          }
          scheduleStamp();
        });
        // Feed the outline from the LIVE document: ids here are Milkdown's
        // attrs.id — identical to the rendered <hN id> — so outline jumps
        // can't diverge from the DOM the way source-slug parsing did (a
        // heading holding a footnote/annotation marker, image, or inline
        // HTML slugifies differently as raw source than as rendered text,
        // and one divergence shifted every later duplicate's -#N dedup).
        // `updated` fires for EVERY transaction: each keystroke, the
        // sync-heading-id plugin's id-stamping transaction right after a
        // structural edit, programmatic replaceAlls (file loads), and even
        // selection-only updates — a full-doc walk on each used to cost
        // 2× O(doc) per keystroke. Instead coalesce walks to at most one per
        // microtask (the latest doc wins, so stamped ids are already in) and
        // skip entirely when the doc reference didn't change.
        let lastHeadingsSig: string | null = null;
        let lastWalkedDoc: PMNode | null = null;
        let pendingDoc: PMNode | null = null;
        let headingsScheduled = false;
        const walkHeadings = () => {
          headingsScheduled = false;
          const doc = pendingDoc;
          pendingDoc = null;
          if (!doc || doc === lastWalkedDoc) return;
          lastWalkedDoc = doc;
          const flat: FlatHeading[] = [];
          doc.descendants((node) => {
            if (node.type.name !== "heading") return;
            const text = node.textContent;
            // Mirror the sync plugin: empty headings carry no id. Headings
            // whose id the stamping transaction hasn't landed yet (id "") are
            // skipped too — they arrive with their final id on the next tick.
            if (text.trim().length === 0 || !node.attrs.id) return false;
            flat.push({ level: node.attrs.level, text, id: node.attrs.id });
            // A heading's subtree holds no nested headings.
            return false;
          });
          const sig = flat.map((h) => `${h.level}|${h.id}|${h.text}`).join("\n");
          // Unchanged signature → don't re-emit; the stable array ref lets the
          // memoized Outline skip re-rendering while the user edits prose.
          // (Sentinel null start: an empty doc's sig is "" and must still be
          // emitted once, or switching to an empty file would leave the
          // previous file's headings on screen.)
          if (sig === lastHeadingsSig) return;
          lastHeadingsSig = sig;
          onHeadingsRef.current?.(flat);
        };
        l.updated((_c, doc) => {
          pendingDoc = doc as PMNode;
          if (headingsScheduled) return;
          headingsScheduled = true;
          queueMicrotask(walkHeadings);
        });
      });

      // Register the ==highlight== mark (schema + command + input rule +
      // Mod-Shift-h keymap + the shared ==mark== remark plugin) BEFORE the
      // schema is built during create(). commonmark's `strong` mark is already
      // shipped by Crepe, so bold needs no extra registration.
      crepe.editor.use(highlightPlugins);

      // Register the text-color mark (`<span style="color:…">`) the same way:
      // schema + remark parse/serialize wiring, before create() builds the schema.
      crepe.editor.use(textColorPlugins);

      try {
        await crepe.create();
      } catch (e) {
        try {
          await crepe.destroy();
        } catch {
          /* already gone */
        }
        console.error("[mditor] Milkdown create failed:", e);
        return;
      }
      if (destroyed) {
        // Cleanup ran before create resolved — tear the orphan down.
        try {
          await crepe.destroy();
        } catch {
          /* already gone */
        }
        return;
      }
      // Override the heading-id generator to match lib/outline.ts. The
      // sync-heading-id plugin reads this slice dynamically on every doc
      // update, so setting it now affects all subsequently-created headings.
      try {
        crepe.editor.ctx.update(headingIdGenerator.key, () => (node: unknown) => {
          const text = (node as { textContent?: string } | null)?.textContent ?? "";
          return headingSlugBase(text);
        });
      } catch {
        /* generator slice missing — keep Milkdown's default */
      }
      // Seed content with flush=true so headings pick up the generator AND the
      // undo history starts clean for this document.
      if (seed) {
        suppressRef.current = true;
        try {
          crepe.editor.action(replaceAll(seed, true));
        } catch {
          /* editor not fully ready — content will be re-pushed by Editor */
        }
        suppressRef.current = false;
        contentRef.current = seed;
      }
      instance = crepe;
      crepeRef.current = crepe;
      applyProseVars(settingsRef.current);
      setReady(true);
    });
    // Defensive: never let an unexpected late rejection surface as unhandled.
    // The create-failure path above already logs; this only swallows surprises.
    void build.catch(() => {
      /* handled inside build where actionable */
    });

    return () => {
      destroyed = true;
      crepeRef.current = null;
      // Cancel any in-flight annotation stamp so it doesn't run against the
      // about-to-be-destroyed DOM.
      if (pendingRaf != null) cancelAnimationFrame(pendingRaf);
      // T6: cancel any pending proactive history-reclaim timer.
      if (idleTrimTimerRef.current != null) {
        window.clearTimeout(idleTrimTimerRef.current);
        idleTrimTimerRef.current = null;
      }
      // Kick off destroy and RECORD its promise so the next create awaits it
      // before mounting a new view (see prevDestroyRef / build above).
      prevDestroyRef.current = (async () => {
        try {
          await instance?.destroy();
        } catch {
          /* already gone */
        }
      })();
      setReady(false);
    };
    // Only re-run on a deliberate recreate. Mode switching does NOT rebuild
    // (wysiwyg/ir share the instance; sv just toggles visibility).
  }, [recreateToken, hostRef, sourceRef]);

  // ---- sv CodeMirror 表面（V3.6）：首次进入 sv 时惰性创建，常驻复用 ------
  useEffect(() => {
    if (mode !== "sv") return;
    const host = svHostRef.current;
    if (!host || svRef.current) return;
    svRef.current = createSvEditor(host, {
      initial: contentRef.current,
      onDocChanged: (md) => {
        // suppressRef 由 facade 的程序化写入置位 —— 那些写入由调用方自行上抛。
        if (suppressRef.current) return;
        sourceTextRef.current = md;
        contentRef.current = md;
        onInputRef.current(md);
      },
      isTypewriter: () => settingsRef.current.typewriterMode,
      onToggleWrap: (mark) => {
        const ta = svRef.current?.surface;
        if (!ta) return;
        const d = mark === "bold" ? "**" : "==";
        toggleWrapTextarea(ta, d, d);
        sourceTextRef.current = ta.value;
        contentRef.current = ta.value;
        onInputRef.current(ta.value);
      },
    });
    setSvCm(true);
  }, [mode, svHostRef]);

  // 组件卸载时销毁 CM（sv ⇄ 富文本切换不销毁 —— 每次进入 sv 重置内容即可）。
  useEffect(
    () => () => {
      svRef.current?.destroy();
      svRef.current = null;
    },
    []
  );

  /** sv 模式的编辑面：优先 CodeMirror 适配器，回退旧 <textarea>。 */
  const svSurface = useCallback(
    (): HTMLTextAreaElement | SvSurface | null =>
      svRef.current?.surface ?? sourceRef.current,
    [sourceRef]
  );

  // ---- textarea (sv) input forwarding -----------------------------------
  useEffect(() => {
    const ta = sourceRef.current;
    if (!ta) return;
    // The upstream notification (markDirty → outline + word count recompute)
    // is debounced; the text mirrors below stay immediate so getValue /
    // autosave / mode switches always read fresh content regardless of a
    // pending notification. Flushed on teardown so a final burst isn't lost.
    let notifyTimer: number | null = null;
    const notifyInput = () => {
      if (notifyTimer != null) window.clearTimeout(notifyTimer);
      notifyTimer = window.setTimeout(() => {
        notifyTimer = null;
        onInputRef.current(ta.value);
      }, 200);
    };
    const onInput = () => {
      if (suppressRef.current) return;
      sourceTextRef.current = ta.value;
      contentRef.current = ta.value;
      notifyInput();
    };
    ta.addEventListener("input", onInput);
    // Tab inserts a tab rather than leaving the field; matches a source editor.
    // Ctrl/Cmd+B and Ctrl/Cmd+Shift+H toggle bold / highlight by wrapping the
    // selection in `**…**` / `==…==` (rich modes are handled by Milkdown's own
    // keymaps + the highlight keymap registered in lib/highlightMark.ts).
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Tab") {
        e.preventDefault();
        const s = ta.selectionStart;
        const en = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + "  " + ta.value.slice(en);
        ta.selectionStart = ta.selectionEnd = s + 2;
        onInput();
        return;
      }
      if (mod && !e.altKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        toggleWrapTextarea(ta, "**", "**");
        onInput();
        return;
      }
      if (mod && e.shiftKey && (e.key === "h" || e.key === "H")) {
        e.preventDefault();
        toggleWrapTextarea(ta, "==", "==");
        onInput();
      }
    };
    ta.addEventListener("keydown", onKeyDown);
    return () => {
      ta.removeEventListener("input", onInput);
      ta.removeEventListener("keydown", onKeyDown);
      if (notifyTimer != null) {
        window.clearTimeout(notifyTimer);
        onInputRef.current(ta.value);
      }
    };
  }, [sourceRef]);

  // ---- the imperative facade (stable; reads live state via refs) --------
  const facade = useMemo<MilkdownFacade>(() => {
    const sv = svSurface;
    const rawMarkdown = (): string => {
      if (modeRef.current === "sv") {
        return sv()?.value ?? sourceTextRef.current ?? contentRef.current;
      }
      try {
        return crepeRef.current?.getMarkdown() ?? contentRef.current;
      } catch {
        return contentRef.current;
      }
    };
    /** sv 模式：用分隔符包裹/解包选区并上抛输入（加粗/高光/斜体…共用）。 */
    const svWrap = (open: string, close: string) => {
      const ta = sv();
      if (!ta) return;
      toggleWrapTextarea(ta, open, close);
      sourceTextRef.current = ta.value;
      contentRef.current = ta.value;
      onInputRef.current(ta.value);
    };
    /** 富文本模式：按 mark 名 toggleMark。 */
    const richToggleMark = (name: string) => {
      try {
        crepeRef.current!.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const mt = view.state.schema.marks[name];
          if (mt) toggleMark(mt)(view.state, view.dispatch);
        });
      } catch {
        /* not ready */
      }
    };
    /** 当前选区纯文本（两种模式）。 */
    const rawSelectionText = (): string => {
      if (modeRef.current === "sv") {
        const ta = sv();
        return ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : "";
      }
      try {
        return crepeRef.current!.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { from, to } = view.state.selection;
          return view.state.doc.textBetween(from, to, "\n");
        });
      } catch {
        return "";
      }
    };

    return {
      getValue: () => rawMarkdown(),
      setValue: (md, clearStack) => {
        if (modeRef.current === "sv") {
          if (svRef.current && clearStack) {
            // CM 表面：整体重置（含撤销历史清空），对齐 replaceAll flush。
            svRef.current.setValueReset(md);
          } else if (sv()) {
            sv()!.value = md;
          }
          sourceTextRef.current = md;
          contentRef.current = md;
          // 与旧 textarea 路径一致：整篇载入可能翻转 big-doc 档位（重建隐藏
          // 的 Crepe，保证切回富文本时 CodeMirror/KaTeX 特性位正确）。
          if (clearStack) maybeRecreateForBigDoc(md);
          return;
        }
        const crepe = crepeRef.current;
        if (!crepe) {
          contentRef.current = md;
          return;
        }
        // A full-document load that flips the big-doc cutoff would parse the
        // doc twice: once for this replaceAll, then again when the recreate
        // below seeds the new instance with the same content. Skip the doomed
        // replaceAll — the recreate path seeds from contentRef — so a big
        // file that crosses the cutoff is parsed exactly once.
        if (clearStack === true && isBigDoc(md) !== bigDocRef.current) {
          maybeRecreateForBigDoc(md);
          return;
        }
        suppressRef.current = true;
        try {
          crepe.editor.action(replaceAll(md, clearStack === true));
        } catch {
          /* not ready */
        }
        suppressRef.current = false;
        contentRef.current = md;
        if (clearStack) maybeRecreateForBigDoc(md);
      },
      getHTML: () => {
        const crepe = crepeRef.current;
        if (!crepe) return "";
        if (modeRef.current === "sv") {
          // Keep the (hidden, alive) Crepe in sync with the source surface so
          // the serialized HTML reflects source-mode edits. getHTML is sync in
          // the EditorHandle contract, so we cannot await a remark render here.
          const md = sv()?.value ?? sourceTextRef.current ?? contentRef.current;
          // Export flows (copy-rich, export HTML/DOCX) call getHTML several
          // times over the same text; each call is a full parse + serialize
          // that also wipes the hidden instance's undo stack. Serve repeats
          // from a one-entry signature cache instead (invalidated on every
          // recreate — see the svHtmlCacheRef reset in the create effect).
          const cached = svHtmlCacheRef.current;
          if (cached.md === md) return cached.html;
          suppressRef.current = true;
          try {
            crepe.editor.action(replaceAll(md, true));
          } catch {
            /* ignore */
          }
          suppressRef.current = false;
          try {
            const html = crepe.editor.action(getHTML());
            svHtmlCacheRef.current = { md, html };
            return html;
          } catch {
            return "";
          }
        }
        try {
          return crepe.editor.action(getHTML());
        } catch {
          return "";
        }
      },
      getSelection: () => {
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return "";
          return ta.value.slice(ta.selectionStart, ta.selectionEnd);
        }
        try {
          return crepeRef.current!.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { from, to } = view.state.selection;
            return view.state.doc.textBetween(from, to, "\n");
          });
        } catch {
          return "";
        }
      },
      insertValue: (md) => {
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return;
          insertIntoTextarea(ta, md);
          sourceTextRef.current = ta.value;
          contentRef.current = ta.value;
          onInputRef.current(ta.value);
          return;
        }
        const crepe = crepeRef.current;
        if (!crepe) return;
        suppressRef.current = true;
        try {
          crepe.editor.action(insert(md));
        } catch {
          /* not ready */
        }
        suppressRef.current = false;
      },
      updateValue: (md) => {
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return;
          replaceTextareaSelection(ta, md);
          sourceTextRef.current = ta.value;
          contentRef.current = ta.value;
          onInputRef.current(ta.value);
          return;
        }
        const crepe = crepeRef.current;
        if (!crepe) return;
        suppressRef.current = true;
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { from, to } = view.state.selection;
            replaceRange(md, { from, to })(ctx);
          });
        } catch {
          /* not ready */
        }
        suppressRef.current = false;
      },
      insertAfter: (md) => {
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return;
          const en = ta.selectionEnd;
          const insert = `${md}`;
          ta.value = ta.value.slice(0, en) + insert + ta.value.slice(en);
          ta.selectionStart = ta.selectionEnd = en + insert.length;
          sourceTextRef.current = ta.value;
          contentRef.current = ta.value;
          onInputRef.current(ta.value);
          return;
        }
        const crepe = crepeRef.current;
        if (!crepe) return;
        suppressRef.current = true;
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { to } = view.state.selection;
            // Insert parsed markdown at the end of the selection (position `to`),
            // leaving the original selection intact.
            insertPos(md, to)(ctx);
          });
        } catch {
          /* not ready */
        }
        suppressRef.current = false;
      },
      getSelectionRange: () => {
        // Returns the live selection's document positions {from,to}, or null
        // when collapsed. Captured while the selection is still alive (before a
        // popover/panel steals focus) so a caller can later insert at exactly
        // that range instead of guessing from plain text.
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return null;
          const from = ta.selectionStart;
          const to = ta.selectionEnd;
          return from === to ? null : { from, to };
        }
        try {
          return crepeRef.current!.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { from, to } = view.state.selection;
            return from === to ? null : { from, to };
          });
        } catch {
          return null;
        }
      },
      insertAtPos: (md, pos) => {
        // Insert parsed markdown at an EXPLICIT document position — independent
        // of the current (possibly collapsed) selection. Used to anchor an
        // annotation marker at a range captured earlier. Mirrors insertAfter,
        // but takes the position as an argument instead of reading it from the
        // live selection.
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return;
          ta.value = ta.value.slice(0, pos) + md + ta.value.slice(pos);
          ta.setSelectionRange(pos + md.length, pos + md.length);
          sourceTextRef.current = ta.value;
          contentRef.current = ta.value;
          onInputRef.current?.(ta.value);
          return;
        }
        const crepe = crepeRef.current;
        if (!crepe) return;
        suppressRef.current = true;
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            // The annotation marker `[^anno-N]` is a single inline
            // footnote_reference atom. insertPos parses the string then
            // round-trips it through DOM (markdownToSlice), which for a bare
            // token yields a closed paragraph slice that can't be placed inline
            // — it ends up rendered as literal `[^anno-N]` text instead of a
            // badge. Create the node directly from the schema and insert it
            // inline at `pos`, bypassing the markdown/DOM round-trip entirely.
            // (insertAfter at line ~559 stays block-level on purpose.)
            const m = /^\[\^([^\]]+)\]\s*$/.exec(md.trim());
            const node = m
              ? view.state.schema.nodes.footnote_reference?.create({ label: m[1] })
              : null;
            if (node) {
              view.dispatch(view.state.tr.insert(pos, node));
              return;
            }
            insertPos(md, pos, true)(ctx);
          });
        } catch {
          /* not ready */
        }
        suppressRef.current = false;
      },
      insertAnnoMarker: (id, range, anchorText) => {
        // Place a [^id] footnote_reference marker near the anchor described by
        // `range`/`anchorText`. If the anchor is inside a block that can't hold
        // an inline footnote_reference (code_block, math_block, …), the marker
        // goes in a fresh marker paragraph right after that block — inserting
        // inside would be silently rejected by the schema, leaving a dangling
        // definition with no badge. Returns true if placed, false to let the
        // caller fall back to appending at the document tail.
        const token = `[^${id}]`;
        if (modeRef.current === "sv") {
          // Source mode edits raw markdown. A [^id] inside a fenced code block
          // is literal text (not a footnote), so if the target sits inside a
          // fence, move the insertion to just after the closing fence.
          const ta = sv();
          if (!ta) return false;
          let pos = -1;
          if (range && range.to > range.from) {
            const t = ta.value.slice(range.from, range.to);
            if (t && (!anchorText || normalizeAnchorText(t) === normalizeAnchorText(anchorText)))
              pos = range.to;
          }
          if (pos < 0 && anchorText) {
            // Repeated wording: the occurrence nearest the captured range wins
            // over the first one — a stale range still says WHERE to look.
            pos = nearestOccurrenceEnd(
              ta.value,
              anchorText.trim(),
              range && range.from > 0 ? range.from : -1
            );
          }
          if (pos < 0 && range && range.to > range.from && range.from <= ta.value.length)
            pos = Math.min(range.to, ta.value.length);
          if (pos < 0) pos = ta.selectionStart;
          pos = svPosOutsideCodeFence(ta.value, pos);
          ta.value = ta.value.slice(0, pos) + token + ta.value.slice(pos);
          ta.selectionStart = ta.selectionEnd = pos + token.length;
          sourceTextRef.current = ta.value;
          contentRef.current = ta.value;
          onInputRef.current?.(ta.value);
          return true;
        }
        const crepe = crepeRef.current;
        if (!crepe) return false;
        suppressRef.current = true;
        try {
          return crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const doc = view.state.doc;
            const schema = view.state.schema;
            const fnType = schema.nodes.footnote_reference;
            if (!fnType) return false;
            // 1) Candidate position, most-to-least trusted:
            //    a) a captured range whose text still matches the anchor
            //       (whitespace-tolerantly — the anchor is the DOM selection
            //       string, which separates paragraphs with "\n\n" while
            //       textBetween joins blocks with "\n", so an exact compare
            //       rejected every cross-paragraph selection);
            //    b) the anchor's occurrence in the flattened document closest
            //       to the captured range — handles the cross-paragraph /
            //       cross-mark anchors the old single-text-node search could
            //       never match, and disambiguates repeated wording using the
            //       (possibly stale) range as a hint;
            //    c) the stale range itself — its text was edited away, but the
            //       spot is still a better guess than the document tail;
            //    d) the cursor — full-document replies carry no anchor at all
            //       (the「批注」tooltip promises「或在光标处」).
            let pos = -1;
            const size = doc.content.size;
            if (range && range.to > range.from) {
              const from = Math.max(0, Math.min(range.from, size));
              const to = Math.max(from, Math.min(range.to, size));
              const t = doc.textBetween(from, to, "\n");
              if (t && (!anchorText || normalizeAnchorText(t) === normalizeAnchorText(anchorText)))
                pos = to;
              if (pos < 0 && anchorText) pos = findAnchorPos(doc, anchorText, from);
            } else if (anchorText) {
              pos = findAnchorPos(doc, anchorText, -1);
            }
            if (pos < 0 && range && range.to > range.from && range.from < size)
              pos = Math.min(range.to, size);
            if (pos < 0) pos = view.state.selection.to;
            // 2) Inline insert when the current textblock allows it.
            const $pos = doc.resolve(pos);
            if ($pos.parent.type.contentMatch.matchType(fnType) != null) {
              view.dispatch(
                view.state.tr.insert(pos, fnType.create({ label: id }))
              );
              return true;
            }
            // 3) Anchor is inside a block that can't hold the marker
            //    (code_block / math_block / …). Drop a marker paragraph right
            //    after that block (its parent is a block container: doc /
            //    list_item / blockquote, all of which accept a paragraph).
            if ($pos.depth >= 1) {
              const after = $pos.after($pos.depth);
              const fn = fnType.create({ label: id });
              const paraType = schema.nodes.paragraph;
              const para = paraType ? paraType.create(null, fn) : fn;
              view.dispatch(view.state.tr.insert(after, para));
              return true;
            }
            return false;
          });
        } catch {
          return false;
        } finally {
          suppressRef.current = false;
        }
      },
      getTextAt: (from, to) => {
        // Plain text spanning [from,to]. Validates that a range captured
        // earlier still matches anchorText (the document may have been edited
        // between capture and use, making {from,to} stale or out of bounds).
        if (modeRef.current === "sv") {
          const ta = sv();
          return ta ? ta.value.slice(from, to) : "";
        }
        try {
          return crepeRef.current!.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            return view.state.doc.textBetween(from, to, "\n");
          });
        } catch {
          return "";
        }
      },
      findTextPos: (needle) => {
        // End document position of the first occurrence of `needle` inside a
        // single text node (-1 if not found). Searching the document tree
        // (rather than the markdown source) returns a position within a text
        // node, so an inserted footnote_reference lands as a sibling inline
        // node — never inside bold/code/link syntax markers. Cross-mark
        // selections aren't matched (-1) and fall back to the document tail.
        if (!needle) return -1;
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return -1;
          const idx = ta.value.indexOf(needle);
          return idx >= 0 ? idx + needle.length : -1;
        }
        try {
          return crepeRef.current!.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            let result = -1;
            view.state.doc.descendants((node, pos) => {
              if (result >= 0) return false;
              if (node.isText && node.text) {
                const idx = node.text.indexOf(needle);
                if (idx >= 0) {
                  result = pos + idx + needle.length;
                  return false;
                }
              }
              return true;
            });
            return result;
          });
        } catch {
          return -1;
        }
      },
      /* ---- AI 写回（一步撤销契约，见 MilkdownFacade 接口注释） ---- */
      aiWriteDoc: (md) => {
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return;
          taUndoableReplace(ta, 0, ta.value.length, md);
          sourceTextRef.current = ta.value;
          contentRef.current = ta.value;
          return;
        }
        const crepe = crepeRef.current;
        if (!crepe) return;
        suppressRef.current = true;
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const doc = ctx.get(parserCtx)(md);
            if (!doc) return;
            view.dispatch(
              closeHistory(
                view.state.tr.replace(
                  0,
                  view.state.doc.content.size,
                  new Slice(doc.content, 0, 0)
                )
              )
            );
          });
        } catch {
          /* not ready */
        }
        suppressRef.current = false;
        contentRef.current = md;
        // NOTE: 故意不调 maybeRecreateForBigDoc —— big-doc 翻转要重建编辑器、
        // 清空撤销历史，违背一步撤销契约；边界在下次文件载入时自然对齐。
      },
      aiWriteRange: (from, to, md) => {
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return;
          const f = Math.max(0, Math.min(from, ta.value.length));
          const t = Math.max(f, Math.min(to, ta.value.length));
          taUndoableReplace(ta, f, t, md);
          sourceTextRef.current = ta.value;
          contentRef.current = ta.value;
          return;
        }
        const crepe = crepeRef.current;
        if (!crepe) return;
        suppressRef.current = true;
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const size = view.state.doc.content.size;
            const f = Math.max(0, Math.min(from, size));
            const t = Math.max(f, Math.min(to, size));
            const slice = markdownToSlice(md)(ctx);
            view.dispatch(closeHistory(view.state.tr.replaceRange(f, t, slice)));
          });
        } catch {
          /* not ready */
        }
        suppressRef.current = false;
      },
      aiWriteInsert: (md) => {
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return;
          taUndoableReplace(ta, ta.selectionStart, ta.selectionEnd, md);
          sourceTextRef.current = ta.value;
          contentRef.current = ta.value;
          return;
        }
        const crepe = crepeRef.current;
        if (!crepe) return;
        suppressRef.current = true;
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const slice = markdownToSlice(md)(ctx);
            view.dispatch(closeHistory(view.state.tr.replaceSelection(slice).scrollIntoView()));
          });
        } catch {
          /* not ready */
        }
        suppressRef.current = false;
      },
      aiWriteFinalize: (baseline, next) => {
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return;
          if (svRef.current) {
            // CM 表面：重置到 baseline（清掉流式期间的撤销痕迹），再一次
            // 单事务写入 next —— 撤销一步即回到 baseline。
            svRef.current.setValueReset(baseline);
            taUndoableReplace(ta, 0, baseline.length, next);
          } else {
            // 原生撤销路径：静默重置到 baseline，随后一次 execCommand 写入。
            ta.value = baseline;
            taUndoableReplace(ta, 0, ta.value.length, next);
          }
          sourceTextRef.current = ta.value;
          contentRef.current = ta.value;
          return;
        }
        const crepe = crepeRef.current;
        if (!crepe) return;
        suppressRef.current = true;
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const d0 = ctx.get(parserCtx)(baseline);
            if (d0) {
              const restore = view.state.tr.replace(
                0,
                view.state.doc.content.size,
                new Slice(d0.content, 0, 0)
              );
              restore.setMeta("addToHistory", false);
              view.dispatch(restore);
            }
            const d1 = ctx.get(parserCtx)(next);
            if (d1) {
              view.dispatch(
                closeHistory(
                  view.state.tr.replace(
                    0,
                    view.state.doc.content.size,
                    new Slice(d1.content, 0, 0)
                  )
                )
              );
            }
          });
        } catch {
          /* not ready */
        }
        suppressRef.current = false;
        contentRef.current = next;
      },
      getCodeAnchorAt: (range) => {
        if (!range || range.to <= range.from) return null;
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return null;
          return svCodeAnchorAt(ta.value, range.from, range.to);
        }
        try {
          return crepeRef.current!.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const doc = view.state.doc;
            const size = doc.content.size;
            const from = Math.max(0, Math.min(range.from, size));
            const to = Math.max(from, Math.min(range.to, size));
            const $from = doc.resolve(from);
            let depth = -1;
            for (let d = $from.depth; d >= 1; d--) {
              if ($from.node(d).type.name === "code_block") {
                depth = d;
                break;
              }
            }
            if (depth < 0) return null;
            const contentStart = $from.before(depth) + 1;
            const contentEnd = $from.after(depth) - 1;
            const toClamped = Math.min(to, contentEnd);
            if (toClamped <= from) return null;
            const before = doc.textBetween(contentStart, from, "\n");
            const through = doc
              .textBetween(contentStart, toClamped, "\n")
              .replace(/\n$/, "");
            const start = before.split("\n").length; // `from` 所在行（1-based）
            const end = through.split("\n").length; // `to` 所在行（1-based）
            const lines = $from.node(depth).textContent.split("\n");
            const firstLine = lines[start - 1] ?? "";
            if (!firstLine.trim() || start > end) return null;
            return { start, end, firstLine };
          });
        } catch {
          return null;
        }
      },
      revealText: (needle) => {
        if (!needle) return;
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return;
          const idx = ta.value.indexOf(needle);
          if (idx < 0) return;
          ta.setSelectionRange(idx, idx + needle.length);
          ta.focus(); // focus 滚动 caret 行入视图
          return;
        }
        try {
          crepeRef.current!.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const pos = findAnchorPos(view.state.doc, needle, -1);
            if (pos <= 0) return;
            // 仅选区事务（无 steps → 不进历史），scrollIntoView 滚到该处。
            const tr = view.state.tr.setSelection(
              TextSelection.near(view.state.doc.resolve(pos), -1)
            );
            tr.scrollIntoView();
            view.dispatch(tr);
          });
        } catch {
          /* not ready */
        }
      },
      findTextRange: (needle, hint) => {
        if (!needle) return null;
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return null;
          const end = nearestOccurrenceEnd(ta.value, needle, hint ?? -1);
          return end < 0 ? null : { from: end - needle.length, to: end };
        }
        try {
          return crepeRef.current!.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            return findAnchorRange(view.state.doc, needle, hint ?? -1);
          });
        } catch {
          return null;
        }
      },
      focus: () => {
        if (modeRef.current === "sv") {
          sv()?.focus();
          return;
        }
        try {
          crepeRef.current?.editor.action((ctx) => {
            ctx.get(editorViewCtx).focus();
          });
        } catch {
          /* ignore */
        }
      },
      toggleBold: () => {
        if (modeRef.current === "sv") {
          svWrap("**", "**");
          return;
        }
        richToggleMark("strong");
      },
      toggleHighlight: () => {
        if (modeRef.current === "sv") {
          svWrap("==", "==");
          return;
        }
        richToggleMark("highlight");
      },
      toggleItalic: () => {
        if (modeRef.current === "sv") {
          svWrap("*", "*");
          return;
        }
        richToggleMark("emphasis");
      },
      toggleStrikethrough: () => {
        if (modeRef.current === "sv") {
          svWrap("~~", "~~");
          return;
        }
        richToggleMark("strikethrough");
      },
      toggleInlineCode: () => {
        if (modeRef.current === "sv") {
          svWrap("`", "`");
          return;
        }
        try {
          crepeRef.current!.editor.action(callCommand(toggleInlineCodeCommand.key));
        } catch {
          /* not ready */
        }
      },
      insertLink: (href, text) => {
        // 选区文字成为链接文字；无选区时用 text / href 本身。escape 掉会破坏
        // 链接语法的方括号。
        const label = (rawSelectionText().trim() || text || href).replace(
          /([[\]])/g,
          "\\$1"
        );
        const md = `[${label}](${href})`;
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return;
          replaceTextareaSelection(ta, md);
          sourceTextRef.current = ta.value;
          contentRef.current = ta.value;
          onInputRef.current(ta.value);
          return;
        }
        const crepe = crepeRef.current;
        if (!crepe) return;
        suppressRef.current = true;
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { from, to } = view.state.selection;
            replaceRange(md, { from, to })(ctx);
          });
        } catch {
          /* not ready */
        }
        suppressRef.current = false;
      },
      insertFootnote: () => {
        const id = nextFootnoteId(rawMarkdown());
        const token = `[^${id}]`;
        const def = `\n\n[^${id}]: \n`;
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return null;
          let pos = ta.selectionEnd;
          pos = svPosOutsideCodeFence(ta.value, pos);
          ta.value = ta.value.slice(0, pos) + token + ta.value.slice(pos);
          ta.setSelectionRange(pos + token.length, pos + token.length);
          const withDef = ta.value.replace(/\s+$/, "") + def;
          ta.value = withDef;
          sourceTextRef.current = withDef;
          contentRef.current = withDef;
          onInputRef.current(withDef);
          return id;
        }
        const crepe = crepeRef.current;
        if (!crepe) return null;
        suppressRef.current = true;
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const fnType = view.state.schema.nodes.footnote_reference;
            if (!fnType) return;
            const pos = view.state.selection.to;
            const $pos = view.state.doc.resolve(pos);
            const node = fnType.create({ label: id });
            if ($pos.parent.type.contentMatch.matchType(fnType) != null) {
              view.dispatch(view.state.tr.insert(pos, node));
            } else if ($pos.depth >= 1) {
              const paraType = view.state.schema.nodes.paragraph;
              const para = paraType ? paraType.create(null, node) : node;
              view.dispatch(view.state.tr.insert($pos.after($pos.depth), para));
            } else {
              return;
            }
            const cur = crepeRef.current?.getMarkdown() ?? "";
            const next = cur.replace(/\s+$/, "") + def;
            try {
              crepeRef.current?.editor.action(replaceAll(next, false));
            } catch {
              /* not ready */
            }
            contentRef.current = next;
          });
          return id;
        } catch {
          return null;
        } finally {
          suppressRef.current = false;
        }
      },
      jumpToLine: (line) => {
        if (svRef.current) {
          svRef.current.jumpToLine(line);
          return;
        }
        const ta = sourceRef.current;
        if (!ta || line < 0) return;
        const pos =
          line === 0 ? 0 : ta.value.split("\n", line).join("\n").length + 1;
        ta.setSelectionRange(pos, pos);
        ta.focus();
      },
      svCodeMirrorActive: () => !!svRef.current,
      getActiveMarks: () => {
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta)
            return { bold: false, highlight: false, italic: false, strike: false, code: false, color: null };
          return textareaActiveMarks(ta);
        }
        try {
          return crepeRef.current!.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { from, empty } = view.state.selection;
            // For a caret, use the marks that would be applied to newly typed
            // text (storedMarks, falling back to the resolved position's marks).
            // For a range, report the marks present at the start of the range —
            // the standard toolbar behaviour.
            const marks = empty
              ? (view.state.storedMarks ??
                view.state.doc.resolve(from).marks())
              : view.state.doc.resolve(from).marks();
            const colorMark = marks.find((m) => m.type.name === "textColor");
            return {
              bold: marks.some((m) => m.type.name === "strong"),
              highlight: marks.some((m) => m.type.name === "highlight"),
              italic: marks.some((m) => m.type.name === "emphasis"),
              strike: marks.some((m) => m.type.name === "strikethrough"),
              // 行内代码是节点而非 mark：光标所在文本块即 inline_code 时为真。
              code: view.state.selection.$from.parent.type.name === "inline_code",
              color: (colorMark?.attrs.color as string | undefined) ?? null,
            };
          });
        } catch {
          return { bold: false, highlight: false, italic: false, strike: false, code: false, color: null };
        }
      },
      setTextColor: (color: string) => {
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return;
          wrapTextareaColor(ta, color);
          sourceTextRef.current = ta.value;
          contentRef.current = ta.value;
          onInputRef.current(ta.value);
          return;
        }
        try {
          crepeRef.current!.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const mt = view.state.schema.marks.textColor;
            if (!mt) return;
            const { from, to } = view.state.selection;
            // Replace any existing color on the range, then apply the new one —
            // so picking a different swatch swaps color rather than stacking.
            const tr = view.state.tr
              .removeMark(from, to, mt)
              .addMark(from, to, mt.create({ color }));
            view.dispatch(tr);
          });
        } catch {
          /* not ready */
        }
      },
      clearTextColor: () => {
        if (modeRef.current === "sv") {
          const ta = sv();
          if (!ta) return;
          unwrapTextareaColor(ta);
          sourceTextRef.current = ta.value;
          contentRef.current = ta.value;
          onInputRef.current(ta.value);
          return;
        }
        try {
          crepeRef.current!.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const mt = view.state.schema.marks.textColor;
            if (!mt) return;
            const { from, to } = view.state.selection;
            view.dispatch(view.state.tr.removeMark(from, to, mt));
          });
        } catch {
          /* not ready */
        }
      },
      /* ---- 块级右键菜单命令（富文本模式；sv 由调用方拦截，不弹菜单） ---- */
      getBlockInfoAt: (x, y) => {
        if (modeRef.current === "sv") return null;
        try {
          return crepeRef.current!.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const doc = view.state.doc;
            const hit = view.posAtCoords({ left: x, top: y });
            // 右键落在 .ProseMirror 的 padding（页首 / 页末 40vh / 左右 gutter）
            // 时 posAtCoords 会落空：按纵向位置回退到文档首/末，让菜单弹在
            // 最近块上（Notion 式）。
            let pos: number;
            if (hit) {
              pos = hit.inside > -1 ? hit.inside : hit.pos;
            } else {
              const rect = view.dom.getBoundingClientRect();
              pos = y - rect.top > rect.height / 2 ? doc.content.size : 0;
            }
            pos = Math.max(0, Math.min(pos, doc.content.size));
            let $pos = doc.resolve(pos);
            // pos 解析到 doc 顶层（depth 0，如首尾边界）时 movableUnit 会拒绝；
            // 用 TextSelection.near 规范进最近的文本块。
            if ($pos.depth < 1) {
              $pos = doc.resolve(TextSelection.near($pos, 1).from);
            }
            // 右键本身不移动 PM 选区；把光标规范到点击处，后续菜单命令才会
            // 作用于被右键的块。若已有选区覆盖点击点（跨块拖选后右键）则保留。
            const { from, to, empty } = view.state.selection;
            if (empty || pos < from || pos > to) {
              view.dispatch(
                view.state.tr.setSelection(TextSelection.near($pos, 1))
              );
            }
            const unit = movableUnit($pos);
            if (!unit) return null;
            const parentDepth = unit.depth - 1;
            const parent = $pos.node(parentDepth);
            const idx = $pos.index(parentDepth);
            // 相邻块探测：跳过空段落（Markdown 的“空行”），移动时读作跨过视觉间隔。
            const prevIdx = nearestSibling(parent, idx, -1);
            const nextIdx = nearestSibling(parent, idx, 1);
            let inTable = false;
            for (let d = 1; d <= $pos.depth; d++) {
              const n = $pos.node(d).type.name;
              if (n === "table" || n === "table_row" || n === "table_cell" || n === "table_header") {
                inTable = true;
                break;
              }
            }
            return {
              kind: classifyUnit(unit.node, parent.type.name),
              headingLevel:
                unit.node.type.name === "heading"
                  ? ((unit.node.attrs.level as number) ?? 1)
                  : null,
              from: $pos.before(unit.depth),
              to: $pos.after(unit.depth),
              canMoveUp: prevIdx >= 0,
              canMoveDown: nextIdx < parent.childCount,
              inTable,
              link: linkRangeAt(doc, pos),
              image: imageAt($pos, pos),
            };
          });
        } catch {
          return null;
        }
      },
      setBlockType: (kind, level) => {
        if (modeRef.current === "sv") return;
        try {
          crepeRef.current!.editor.action((ctx) => {
            applyBlockTarget(ctx.get(editorViewCtx), kind, level);
          });
        } catch {
          /* not ready */
        }
      },
      moveBlock: (dir) => {
        if (modeRef.current === "sv") return false;
        try {
          return crepeRef.current!.editor.action((ctx) =>
            moveBlockCommand(ctx.get(editorViewCtx), dir)
          );
        } catch {
          return false;
        }
      },
      duplicateBlock: () => {
        if (modeRef.current === "sv") return;
        try {
          crepeRef.current!.editor.action((ctx) => {
            duplicateBlockCommand(ctx.get(editorViewCtx));
          });
        } catch {
          /* not ready */
        }
      },
      deleteBlock: () => {
        if (modeRef.current === "sv") return;
        try {
          crepeRef.current!.editor.action((ctx) => {
            deleteBlockCommand(ctx.get(editorViewCtx));
          });
        } catch {
          /* not ready */
        }
      },
      tableOp: (op) => {
        if (modeRef.current === "sv") return;
        const cmds = {
          rowBefore: addRowBefore,
          rowAfter: addRowAfter,
          colBefore: addColumnBefore,
          colAfter: addColumnAfter,
          delRow: deleteRow,
          delCol: deleteColumn,
        } as const;
        try {
          crepeRef.current!.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            cmds[op](view.state, view.dispatch);
          });
        } catch {
          /* not ready */
        }
      },
      updateLinkHref: (from, to, href) => {
        if (modeRef.current === "sv") return;
        try {
          crepeRef.current!.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const linkType = view.state.schema.marks.link;
            if (!linkType) return;
            if (!href) {
              view.dispatch(view.state.tr.removeMark(from, to, linkType));
              return;
            }
            // 保留原 title（若有）
            let title: string | undefined;
            view.state.doc.nodesBetween(from, to, (n) => {
              if (title !== undefined) return false;
              const lm = n.marks.find((m) => m.type.name === "link");
              if (lm) title = lm.attrs.title as string | undefined;
              return title === undefined;
            });
            view.dispatch(
              view.state.tr.addMark(from, to, linkType.create({ href, title }))
            );
          });
        } catch {
          /* not ready */
        }
      },
      deleteNodeAt: (pos) => {
        if (modeRef.current === "sv") return;
        try {
          crepeRef.current!.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const n = view.state.doc.nodeAt(pos);
            if (!n) return;
            const tr = view.state.tr.delete(pos, pos + n.nodeSize);
            tr.setSelection(
              TextSelection.near(
                tr.doc.resolve(Math.min(pos, tr.doc.content.size)),
                -1
              )
            );
            view.dispatch(tr);
          });
        } catch {
          /* not ready */
        }
      },
      setImageSrc: (pos, src) => {
        if (modeRef.current === "sv") return;
        try {
          crepeRef.current!.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const n = view.state.doc.nodeAt(pos);
            if (!n || n.type.name !== "image") return;
            view.dispatch(
              view.state.tr.setNodeMarkup(pos, undefined, { ...n.attrs, src })
            );
          });
        } catch {
          /* not ready */
        }
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 远程图片 URL 粘贴 → 下载落盘（Typora 行为）--------------------------
  // 粘贴纯文本恰好是远程图片 URL 时，经 Rust 侧 fetch_image 下载（webview CSP
  // 禁止直连外网）并落盘到 assets/，插入本地引用；下载失败退回为插入原始 URL。
  // 剪贴板里是文件/图片时不拦截（交给 ImageBlock 的 onUpload 正常落盘）。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onPaste = (e: ClipboardEvent) => {
      if (modeRef.current === "sv") return; // sv 的 textarea 保留原生粘贴
      const items = e.clipboardData?.items;
      if (items) {
        for (const it of Array.from(items)) {
          if (it.kind === "file") return; // 文件粘贴走 ImageBlock onUpload
        }
      }
      const text = e.clipboardData?.getData("text/plain")?.trim() ?? "";
      if (!REMOTE_IMG_URL_RE.test(text)) return;
      e.preventDefault();
      void (async () => {
        const md = await persistRemoteImage(text, optsRef.current.docPath());
        facade.insertValue(md ?? text);
      })();
    };
    host.addEventListener("paste", onPaste);
    return () => host.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostRef]);

  // Recreate the instance when big-doc state flips after a full document load
  // (CodeMirror/KaTeX are create-time feature flags and can't be toggled live).
  const maybeRecreateForBigDoc = (md: string) => {
    const big = isBigDoc(md);
    if (big !== bigDocRef.current) {
      contentRef.current = md;
      bigDocRef.current = big;
      setBigDoc(big);
      setRecreateToken((t) => t + 1);
    }
  };

  // ---- mode switching / recreate / theme --------------------------------
  const switchMode = useCallback(
    (m: EditMode) => {
      // Re-selecting the current mode is a no-op — skip the whole-doc
      // getMarkdown() serialization the transition would otherwise run.
      if (m === modeRef.current) return;
      contentRef.current =
        modeRef.current === "sv"
          ? svSurface()?.value ?? sourceTextRef.current ?? contentRef.current
          : (crepeRef.current?.getMarkdown() ?? contentRef.current);

      if (m === "sv") {
        sourceTextRef.current = contentRef.current;
        if (svRef.current) {
          // CodeMirror 表面：重置内容与撤销历史（CM 会在宿主上重新渲染）。
          svRef.current.setValueReset(contentRef.current);
        } else if (sourceRef.current) {
          sourceRef.current.value = contentRef.current;
        }
        setModeState("sv");
        return;
      }
      // Leaving sv: push the textarea back into the Crepe (flush clears undo).
      if (modeRef.current === "sv") {
        const crepe = crepeRef.current;
        if (crepe) {
          suppressRef.current = true;
          try {
            crepe.editor.action(replaceAll(contentRef.current, true));
          } catch {
            /* ignore */
          }
          suppressRef.current = false;
        }
      }
      setModeState(m);
    },
    [svSurface, sourceRef]
  );

  const recreate = useCallback(() => {
    contentRef.current =
      modeRef.current === "sv"
        ? svSurface()?.value ?? sourceTextRef.current ?? contentRef.current
        : (crepeRef.current?.getMarkdown() ?? contentRef.current);
    setRecreateToken((t) => t + 1);
  }, [svSurface]);

  const applyTheme = useCallback((s: Settings) => {
    applyProseVars(s);
  }, []);

  return useMemo<MilkdownHandle>(
    () => ({
      editor: ready ? facade : null,
      ready,
      mode,
      bigDoc,
      svCm,
      switchMode,
      recreate,
      applyTheme,
    }),
    [ready, mode, bigDoc, svCm, facade, switchMode, recreate, applyTheme]
  );
}

/** Insert `text` at the surface caret (no selection overwrite). */
function insertIntoTextarea(ta: HTMLTextAreaElement | SvSurface, text: string): void {
  const s = ta.selectionStart;
  const en = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(en);
  const pos = s + text.length;
  ta.setSelectionRange(pos, pos);
}

/** If `pos` (a textarea caret offset) lies inside a fenced code block, return
 *  the offset immediately after that block's closing fence line, so a markdown
 *  token inserted there is NOT swallowed as literal code. Otherwise return
 *  `pos` unchanged. Recognises ``` and ~~~ fences with up to 3 leading spaces.
 *  Used by the annotation marker in source mode. */
function svPosOutsideCodeFence(value: string, pos: number): number {
  const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
  // Fence state up to the START of the line containing `pos`.
  const lineStart = value.lastIndexOf("\n", pos - 1) + 1;
  let inFence = false;
  let fenceChar = ""; // "`" or "~" — only the same char closes the fence
  for (const ln of value.slice(0, lineStart).split("\n")) {
    const m = ln.match(FENCE_RE);
    if (!m) continue;
    if (!inFence) {
      inFence = true;
      fenceChar = m[1][0];
    } else if (m[1][0] === fenceChar) {
      inFence = false;
      fenceChar = "";
    }
  }
  if (!inFence) return pos;
  // Inside a fence: find its closing fence at/after the current line and
  // return the offset at the start of the line AFTER it.
  let offset = lineStart;
  for (const ln of value.slice(lineStart).split("\n")) {
    const m = ln.match(FENCE_RE);
    offset += ln.length + 1; // +1 for the "\n"
    if (m && m[1][0] === fenceChar) {
      return Math.min(offset, value.length);
    }
  }
  // Unclosed fence (user mid-typing): fall back to end of document.
  return value.length;
}

/** Replace the surface's current selection with `text` (inserts at caret if
 *  the selection is collapsed). */
function replaceTextareaSelection(ta: HTMLTextAreaElement | SvSurface, text: string): void {
  const s = ta.selectionStart;
  const en = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(en);
  const pos = s + text.length;
  ta.setSelectionRange(pos, pos);
}

/** Undoable surface write（AI 一步撤销的 sv 模式路径）：CodeMirror 表面经
 *  undoableReplace 单事务写入（CM 历史一步）；textarea 回退选中 [from,to)
 *  后经 execCommand("insertText") 写入，原生撤销把整次写入当作一步。均返回
 *  false 时调用方退回普通赋值，保正确性、牺牲撤销粒度。 */
function taUndoableReplace(
  ta: HTMLTextAreaElement | SvSurface,
  from: number,
  to: number,
  text: string
): boolean {
  // CodeMirror 适配器带单事务写入；textarea 无此方法（undefined）走原生路径。
  const fn = (ta as SvSurface).undoableReplace;
  if (typeof fn === "function") return fn.call(ta, from, to, text);
  const el = ta as HTMLTextAreaElement;
  el.focus();
  el.setSelectionRange(from, to);
  let ok: boolean;
  try {
    ok = document.execCommand("insertText", false, text);
  } catch {
    ok = false;
  }
  if (!ok) {
    const before = el.value.slice(0, from);
    el.value = before + text + el.value.slice(to);
    el.setSelectionRange(before.length + text.length, before.length + text.length);
  }
  return ok;
}

/** sv 模式的代码行锚点：textarea 偏移 [from,to) 是否落在某个围栏代码块内，
 *  在则返回块内行号 {start,end,firstLine}（1-based，firstLine 为锚定首行
 *  原文，供内容跟随）。 */
function svCodeAnchorAt(value: string, from: number, to: number): CodeLineMeta | null {
  const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
  const lines = value.split("\n");
  let off = 0;
  let inFence = false;
  let fenceCh = "";
  const contentLines: string[] = [];
  const contentOffsets: number[] = [];
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    const lineStart = off;
    const lineEnd = off + lines[i].length;
    off = lineEnd + 1;
    const m = FENCE.exec(lines[i]);
    if (!inFence) {
      if (m) {
        inFence = true;
        fenceCh = m[1][0];
        contentLines.length = 0;
        contentOffsets.length = 0;
        start = -1;
        end = -1;
      }
      continue;
    }
    if (m && m[1][0] === fenceCh) {
      inFence = false; // 块结束；已记录的 start/end（若有）即最终结果
      continue;
    }
    // 代码内容行
    contentLines.push(lines[i]);
    contentOffsets.push(lineStart);
    if (start < 0 && from >= lineStart && from <= lineEnd) start = contentLines.length;
    if (start > 0 && to > lineStart && to <= lineEnd + 1) end = contentLines.length;
  }
  if (start < 0) return null;
  if (end < 0) end = start; // to 越界（块外）：按单行处理
  const firstLine = contentLines[start - 1] ?? "";
  if (!firstLine.trim()) return null;
  return { start, end, firstLine };
}

/** Wrap (or unwrap, if already wrapped) the surface selection with `open` and
 *  `close` delimiters — a toggle, so pressing the shortcut twice is a no-op
 *  rather than nesting `****`. */
function toggleWrapTextarea(
  ta: HTMLTextAreaElement | SvSurface,
  open: string,
  close: string
): void {
  const s = ta.selectionStart;
  const en = ta.selectionEnd;
  const val = ta.value;
  const before = val.slice(Math.max(0, s - open.length), s);
  const after = val.slice(en, en + close.length);
  const wrapped = before === open && after === close;
  if (wrapped) {
    // Strip the surrounding delimiters; keep the selection on the inner text.
    ta.value =
      val.slice(0, s - open.length) + val.slice(s, en) + val.slice(en + close.length);
    ta.selectionStart = s - open.length;
    ta.selectionEnd = en - open.length;
  } else {
    ta.value =
      val.slice(0, s) + open + val.slice(s, en) + close + val.slice(en);
    ta.selectionStart = s + open.length;
    ta.selectionEnd = en + open.length;
  }
}

/** Whether the surface selection/caret currently sits inside `**…**` / `==…==`
 *  / `*…*` / `~~…~~` / `` `…` `` / a `<span style="color:…">…</span>`. Drives
 *  the toolbar active state in source mode. */
function textareaActiveMarks(ta: HTMLTextAreaElement | SvSurface): {
  bold: boolean;
  highlight: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  color: string | null;
} {
  const s = ta.selectionStart;
  const en = ta.selectionEnd;
  const val = ta.value;
  const bold =
    val.slice(Math.max(0, s - 2), s) === "**" && val.slice(en, en + 2) === "**";
  const highlight =
    val.slice(Math.max(0, s - 2), s) === "==" && val.slice(en, en + 2) === "==";
  const strike =
    val.slice(Math.max(0, s - 2), s) === "~~" && val.slice(en, en + 2) === "~~";
  // 斜体：单星号包裹且不属于 `**` 加粗的内侧。
  const italic =
    !bold &&
    val.slice(Math.max(0, s - 1), s) === "*" &&
    val.slice(en, en + 1) === "*";
  const code =
    val.slice(Math.max(0, s - 1), s) === "`" && val.slice(en, en + 1) === "`";
  return { bold, highlight, italic, strike, code, color: textareaColorAt(ta) };
}

/** 下一个可用的脚注 id（`fn-N`，与批注的 `anno-N` 命名空间隔离）。 */
function nextFootnoteId(md: string): string {
  let max = 0;
  const re = /\[\^fn-(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `fn-${max + 1}`;
}

// Match a color span opening tag and capture its declared color. Tolerant of
// extra attributes and either quote style. (Anchored at the END of a look-back
// window: the textarea helpers below search backwards from the caret.) The
// style/color-declaration atoms these pair with live in lib/colorSpan.ts,
// shared with the remark round-trip so the two can't drift.
const SPAN_OPEN_RE = /<span\b[^>]*\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>\s*$/i;
const SPAN_CLOSE_RE = /^\s*<\/span>/i;

/** If the surface selection/caret is wrapped by `<span style=color>…</span>`,
 *  return that color; otherwise null. Scans a small window around the selection
 *  so it works for both a caret and a range. */
function textareaColorAt(ta: HTMLTextAreaElement | SvSurface): string | null {
  const s = ta.selectionStart;
  const en = ta.selectionEnd;
  const val = ta.value;
  // Look back up to ~120 chars for an opening color span not yet closed.
  const winStart = Math.max(0, s - 120);
  const before = val.slice(winStart, s);
  const after = val.slice(en, en + 12);
  // Must be immediately followed by </span> for a tight range match; for a
  // collapsed caret we still require the close to be right after the caret.
  if (!SPAN_CLOSE_RE.test(after)) {
    // Allow the close to sit a couple chars ahead (trailing spaces are rare
    // inside a span, but tolerate them).
    if (!/^\s{0,2}<\/span>/i.test(after)) return null;
  }
  const open = SPAN_OPEN_RE.exec(before);
  if (!open) return null;
  const style = open[1] ?? open[2] ?? "";
  return colorFromStyle(style);
}

/** Wrap (or re-color, or unwrap if same color) the textarea selection with a
 *  `<span style="color:…">…</span>`. Toggling: if the selection already carries
 *  the SAME color span it is unwrapped; if it carries a DIFFERENT color the span
 *  is replaced (open tag rewritten) so colors don't nest. */
function wrapTextareaColor(ta: HTMLTextAreaElement | SvSurface, color: string): void {
  const s = ta.selectionStart;
  const en = ta.selectionEnd;
  const val = ta.value;
  const before = val.slice(Math.max(0, s - 120), s);
  const after = val.slice(en, en + 12);

  const existingOpen = SPAN_OPEN_RE.exec(before);
  const hasClose = SPAN_CLOSE_RE.test(after) || /^\s{0,2}<\/span>/i.test(after);
  if (existingOpen && hasClose) {
    const curStyle = existingOpen[1] ?? existingOpen[2] ?? "";
    const curColor = colorFromStyle(curStyle);
    const openStartInWin = existingOpen.index;
    const openStart = Math.max(0, s - 120) + openStartInWin;
    const openTag = existingOpen[0];
    if (curColor && curColor.toLowerCase() === color.toLowerCase()) {
      // Same color → unwrap (toggle off): strip open + close tags.
      const closeLen = val.slice(en).match(/^<\/span>/i)?.[0].length ?? "</span>".length;
      ta.value =
        val.slice(0, openStart) +
        val.slice(openStart + openTag.length, en) +
        val.slice(en + closeLen);
      const shrink = openTag.length;
      ta.selectionStart = openStart;
      ta.selectionEnd = en - shrink;
    } else {
      // Different color → rewrite the open tag's color (keeps the close).
      const newStyle = curStyle.replace(COLOR_DECL_RE, `color: ${color}`);
      const styleStr = curStyle.includes("color:") ? newStyle : `color: ${color}` + (curStyle.trim() ? `;${curStyle}` : "");
      const newOpen = `<span style="${styleStr}">`;
      ta.value =
        val.slice(0, openStart) + newOpen + val.slice(openStart + openTag.length);
      ta.selectionStart = s;
      ta.selectionEnd = en;
    }
    return;
  }
  // Not yet wrapped: wrap fresh.
  const open = `<span style="color:${color}">`;
  const close = "</span>";
  ta.value = val.slice(0, s) + open + val.slice(s, en) + close + val.slice(en);
  ta.selectionStart = s + open.length;
  ta.selectionEnd = en + open.length;
}

/** Remove the nearest enclosing color span around the surface selection, if any. */
function unwrapTextareaColor(ta: HTMLTextAreaElement | SvSurface): void {
  const s = ta.selectionStart;
  const en = ta.selectionEnd;
  const val = ta.value;
  const before = val.slice(Math.max(0, s - 120), s);
  const after = val.slice(en, en + 12);
  const existingOpen = SPAN_OPEN_RE.exec(before);
  const hasClose = SPAN_CLOSE_RE.test(after) || /^\s{0,2}<\/span>/i.test(after);
  if (!existingOpen || !hasClose) return;
  const openStart = Math.max(0, s - 120) + existingOpen.index;
  const openTag = existingOpen[0];
  const closeLen = val.slice(en).match(/^<\/span>/i)?.[0].length ?? "</span>".length;
  ta.value =
    val.slice(0, openStart) +
    val.slice(openStart + openTag.length, en) +
    val.slice(en + closeLen);
  const shrink = openTag.length;
  ta.selectionStart = openStart;
  ta.selectionEnd = en - shrink;
}

/** Apply font/size/spacing as CSS vars on :root (the prose CSS in global.css
 *  consumes them on .ProseMirror). Mirrors the Vditor applyProseVars surface. */
function applyProseVars(s: Settings) {
  const root = document.documentElement;
  root.style.setProperty("--font-prose", s.fontFamily);
  root.style.setProperty("--font-mono", s.monoFontFamily);
  root.style.setProperty("--font-size", `${s.fontSize}px`);
  root.style.setProperty("--line-height", String(s.lineHeight));
  root.style.setProperty("--para-spacing", `${s.paragraphSpacing}px`);
}

/* -------------------------------------------------------------------------- */
/* 块级命令（BlockContextMenu）的纯 ProseMirror 辅助函数                        */
/*                                                                            */
/* “当前块”的判定：光标所在顶层块（doc 的直接子节点）。若该顶层块是列表，则取      */
/* 光标所在的最外层 list_item（整项移动/复制，携带其嵌套内容）。表格、引用等       */
/* 复合块整体作为单元处理（与 Notion 的块语义一致）。                            */
/* -------------------------------------------------------------------------- */

/** The "movable unit" at $pos: the top-level block, or — inside a top-level
 *  list — the shallowest list_item (the visible whole item). */
function movableUnit($pos: ResolvedPos): { depth: number; node: PMNode } | null {
  if ($pos.depth < 1) return null;
  const top = $pos.node(1);
  if (top.type.name === "bullet_list" || top.type.name === "ordered_list") {
    for (let d = 2; d <= $pos.depth; d++) {
      if ($pos.node(d).type.name === "list_item") {
        return { depth: d, node: $pos.node(d) };
      }
    }
  }
  return { depth: 1, node: top };
}

function isEmptyParagraph(n: PMNode): boolean {
  return n.type.name === "paragraph" && n.childCount === 0;
}

/** Index of the nearest sibling of `idx` in direction `step`, skipping empty
 *  paragraphs (the markdown “空行” — moving across one reads as jumping a
 *  visual gap, so it should not block the move). Returns -1 / childCount when
 *  the edge is reached. */
function nearestSibling(parent: PMNode, idx: number, step: 1 | -1): number {
  let i = idx + step;
  while (i >= 0 && i < parent.childCount && isEmptyParagraph(parent.child(i))) {
    i += step;
  }
  return i;
}

/** Semantic kind of a block node. A list_item is classified by its parent
 *  list (task items carry a non-null `checked` attr — gfm preset). */
function classifyUnit(node: PMNode, parentName: string): BlockInfo["kind"] {
  switch (node.type.name) {
    case "paragraph":
      return "paragraph";
    case "heading":
      return "heading";
    case "blockquote":
      return "blockquote";
    case "code_block":
      return "code_block";
    case "horizontal_rule":
      return "hr";
    case "table":
      return "table";
    case "image":
      return "image";
    case "math":
    case "math_block":
      return "math_block";
    case "html":
    case "html_block":
      return "html";
    case "list_item":
      if (parentName === "bullet_list") {
        return node.attrs.checked != null ? "task_list" : "bullet_list";
      }
      if (parentName === "ordered_list") return "ordered_list";
      return "other";
    default:
      return "other";
  }
}

/** The contiguous range of the link mark around `pos`, or null. Expansion
 *  walks neighbour text nodes carrying an equal link mark — the standard
 *  “mark range at caret” resolution. */
function linkRangeAt(
  doc: PMNode,
  pos: number
): { from: number; to: number; href: string } | null {
  const $p = doc.resolve(pos);
  const findLink = (marks: readonly Mark[] | undefined) =>
    marks?.find((m) => m.type.name === "link");
  const mark = findLink($p.marks()) ?? findLink($p.nodeBefore?.marks) ?? findLink($p.nodeAfter?.marks);
  if (!mark) return null;
  const hasLink = (n: PMNode | null | undefined): boolean =>
    !!n && !!findLink(n.marks)?.eq(mark);
  let from = pos;
  let to = pos;
  while (from > 0 && hasLink(doc.resolve(from - 1).nodeBefore)) from--;
  while (to < doc.content.size && hasLink(doc.resolve(to).nodeAfter)) to++;
  if (from >= to) return null;
  return { from, to, href: ((mark.attrs.href as string | undefined) ?? "") };
}

/** The image node at (or immediately around) `pos` — clicked directly, or via
 *  its caption/wrapper (the block image hosts the caption text). */
function imageAt($pos: ResolvedPos, pos: number): { pos: number; src: string } | null {
  // Caption / wrapper click: the image is an ancestor.
  for (let d = $pos.depth; d >= 1; d--) {
    if ($pos.node(d).type.name === "image") {
      return {
        pos: $pos.before(d),
        src: (($pos.node(d).attrs.src as string | undefined) ?? ""),
      };
    }
  }
  // Direct hit: check the node starting at / adjacent to the click position.
  for (const p of [pos, pos + 1, Math.max(0, pos - 1)]) {
    const n = p <= $pos.doc.content.size ? $pos.doc.nodeAt(p) : null;
    if (n && n.type.name === "image") {
      return { pos: p, src: ((n.attrs.src as string | undefined) ?? "") };
    }
  }
  return null;
}

/** Depth of the nearest ancestor of the given type names, or 0. */
function ancestorDepth($pos: ResolvedPos, names: string[]): number {
  for (let d = $pos.depth; d >= 1; d--) {
    if (names.includes($pos.node(d).type.name)) return d;
  }
  return 0;
}

/** Whether the list_item containing the caret is a task item (checked != null). */
function currentItemIsTask($pos: ResolvedPos): boolean {
  const d = ancestorDepth($pos, ["list_item"]);
  return d > 0 && $pos.node(d).attrs.checked != null;
}

/** Switch the nearest ancestor list's flavour: bullet ⇄ ordered, and plain ⇄
 *  task (task state lives on the `list_item` children's `checked` attr). Used
 *  both after wrapInList (to seed task items) and for in-place conversion —
 *  converting the whole list matches the familiar editor behaviour. */
function switchListKind(view: EditorView, kind: BlockTargetKind): void {
  const state = view.state;
  const N = state.schema.nodes;
  const $from = state.selection.$from;
  const listDepth = ancestorDepth($from, ["bullet_list", "ordered_list"]);
  if (!listDepth) return;
  const list = $from.node(listDepth);
  const listPos = $from.before(listDepth);
  const wantType = kind === "ordered_list" ? N.ordered_list : N.bullet_list;
  const wantTask = kind === "task_list";
  const tr = state.tr.setNodeMarkup(listPos, wantType ?? undefined, list.attrs);
  const liType = N.list_item;
  if (liType && liType.spec.attrs && "checked" in liType.spec.attrs) {
    let p = listPos + 1;
    for (let i = 0; i < list.childCount; i++) {
      const c = list.child(i);
      if (c.type.name === "list_item") {
        tr.setNodeMarkup(p, undefined, {
          ...c.attrs,
          checked: wantTask ? false : null,
        });
      }
      p += c.nodeSize;
    }
  }
  view.dispatch(tr.scrollIntoView());
}

/** Apply a block-type target chosen from the context menu, with toggle
 *  semantics (clicking the current flavour converts back to a paragraph). */
function applyBlockTarget(
  view: EditorView,
  kind: BlockTargetKind,
  level?: number
): void {
  const N = view.state.schema.nodes;
  const $from = view.state.selection.$from;
  const run = (cmd: (state: typeof view.state, dispatch?: typeof view.dispatch) => boolean) =>
    cmd(view.state, view.dispatch);
  const inQuote = ancestorDepth($from, ["blockquote"]) > 0;
  const listName =
    ancestorDepth($from, ["bullet_list"]) > 0
      ? "bullet_list"
      : ancestorDepth($from, ["ordered_list"]) > 0
        ? "ordered_list"
        : null;
  const parent = $from.parent; // nearest textblock

  switch (kind) {
    case "paragraph":
      if (listName && N.list_item) run(liftListItem(N.list_item));
      else if (inQuote) run(lift);
      else run(pmSetBlockType(N.paragraph));
      break;
    case "heading": {
      const lv = Math.min(6, Math.max(1, level ?? 2));
      if (parent.type.name === "heading" && parent.attrs.level === lv) {
        run(pmSetBlockType(N.paragraph)); // same level again → back to paragraph
        break;
      }
      // heading isn't valid inside list_item — lift out first, then apply.
      if (listName && N.list_item) run(liftListItem(N.list_item));
      run(pmSetBlockType(N.heading, { level: lv }));
      break;
    }
    case "blockquote":
      if (inQuote) run(lift);
      else if (N.blockquote) run(wrapIn(N.blockquote));
      break;
    case "code_block":
      if (parent.type.name === "code_block") {
        run(pmSetBlockType(N.paragraph));
        break;
      }
      if (listName && N.list_item) run(liftListItem(N.list_item));
      run(pmSetBlockType(N.code_block));
      break;
    case "bullet_list":
    case "ordered_list":
    case "task_list": {
      const curTask = listName === "bullet_list" && currentItemIsTask($from);
      // Toggle off when already this exact flavour.
      if (
        (kind === "bullet_list" && listName === "bullet_list" && !curTask) ||
        (kind === "ordered_list" && listName === "ordered_list") ||
        (kind === "task_list" && curTask)
      ) {
        if (N.list_item) run(liftListItem(N.list_item));
        break;
      }
      if (!listName) {
        const wrapType = kind === "ordered_list" ? N.ordered_list : N.bullet_list;
        if (wrapType) run(wrapInList(wrapType));
        if (kind === "task_list") switchListKind(view, "task_list");
        break;
      }
      // Different flavour / plain ⇄ task → convert the whole list in place.
      switchListKind(view, kind);
      break;
    }
    case "hr": {
      const hrType = N.horizontal_rule;
      if (!hrType) break;
      // hr must live at the top level: insert after the current top-level block.
      const after = $from.after(1);
      const tr = view.state.tr.insert(after, hrType.create());
      tr.setSelection(
        TextSelection.near(tr.doc.resolve(Math.min(after + 1, tr.doc.content.size)), 1)
      );
      view.dispatch(tr.scrollIntoView());
      break;
    }
  }
  view.focus();
}

/** Swap the movable unit with its nearest (empty-paragraph-skipping) sibling.
 *  Implemented as delete + insert in ONE transaction so undo collapses the
 *  move into a single step and the caret travels with the block. */
function moveBlockCommand(view: EditorView, dir: "up" | "down"): boolean {
  const state = view.state;
  const $from = state.selection.$from;
  const unit = movableUnit($from);
  if (!unit) return false;
  const parentDepth = unit.depth - 1;
  const parent = $from.node(parentDepth);
  const start = $from.before(unit.depth);
  const end = $from.after(unit.depth);
  const step = dir === "down" ? 1 : -1;
  const j = nearestSibling(parent, $from.index(parentDepth), step as 1 | -1);
  if (j < 0 || j >= parent.childCount) return false;
  // Doc range of the target sibling. start(parentDepth) is the content start
  // of the parent, which equals the position of its FIRST child (0 for doc,
  // Ls+1 for a list at Ls) — no extra offset needed.
  let tStart = 0;
  let tEnd = 0;
  let p = $from.start(parentDepth);
  for (let i = 0; i < parent.childCount; i++) {
    if (i === j) tStart = p;
    p += parent.child(i).nodeSize;
    if (i === j) tEnd = p;
  }
  // NOTE: PM's node.copy() with no argument yields an EMPTY node (content
  // defaults to null → Fragment.empty); the content must be passed explicitly.
  const copy = unit.node.copy(unit.node.content);
  // Caret offset inside the unit so it stays at the same reading spot.
  const headOff = Math.max(
    1,
    Math.min(unit.node.nodeSize - 1, state.selection.head - start)
  );
  const tr = state.tr;
  tr.delete(start, end);
  const ins = tr.mapping.map(dir === "down" ? tEnd : tStart);
  tr.insert(ins, copy);
  tr.setSelection(TextSelection.near(tr.doc.resolve(ins + headOff), 1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Insert a copy of the movable unit right below itself; caret moves into the
 *  copy (same reading offset, clamped to the copy's interior). */
function duplicateBlockCommand(view: EditorView): void {
  const state = view.state;
  const $from = state.selection.$from;
  const unit = movableUnit($from);
  if (!unit) return;
  const start = $from.before(unit.depth);
  const end = $from.after(unit.depth);
  const headOff = Math.max(
    1,
    Math.min(unit.node.nodeSize - 1, state.selection.head - start)
  );
  const tr = state.tr.insert(end, unit.node.copy(unit.node.content));
  tr.setSelection(TextSelection.near(tr.doc.resolve(end + headOff), 1));
  view.dispatch(tr.scrollIntoView());
}

/** Delete the movable unit; caret falls to the end of the preceding neighbour
 *  (or the start of what follows when deleting the first block). */
function deleteBlockCommand(view: EditorView): void {
  const state = view.state;
  const $from = state.selection.$from;
  const unit = movableUnit($from);
  if (!unit) return;
  const start = $from.before(unit.depth);
  const end = $from.after(unit.depth);
  const tr = state.tr.delete(start, end);
  tr.setSelection(
    TextSelection.near(tr.doc.resolve(Math.min(start, tr.doc.content.size)), -1)
  );
  view.dispatch(tr.scrollIntoView());
}
