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
import { editorViewCtx, parserCtx, schemaCtx, serializerCtx } from "@milkdown/core";
import type { Ctx } from "@milkdown/ctx";
import { closeHistory } from "@milkdown/prose/history";
import { toggleMark } from "@milkdown/prose/commands";
import {
  addRowBefore,
  addRowAfter,
  addColumnBefore,
  addColumnAfter,
  deleteRow,
  deleteColumn,
} from "@milkdown/prose/tables";
import { TextSelection } from "@milkdown/prose/state";
import { Slice, Node } from "@milkdown/prose/model";
import type { Node as PMNode, DOMOutputSpec } from "@milkdown/prose/model";
import { headingIdGenerator, toggleInlineCodeCommand } from "@milkdown/kit/preset/commonmark";
import { syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { highlightPlugins } from "../lib/highlightMark";
import { textColorPlugins } from "../lib/textColorMark";
import { noteScrollWrite } from "../lib/scrollDebug";
import { noteOpError } from "../lib/opDebug";
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
import {
  appendDefinitionOp,
  finalizeAnnotationOp,
  removeAnnoOp,
  replaceDefinitionOp,
  type TargetedOpResult,
} from "../lib/annotationOps";
import { stampAnnotationMarkers } from "./useAnnotationMarkers";
import { isUserActive } from "../lib/activity";
import {
  annoCount,
  annoEmit,
  registerAnnoProbe,
  registerPmObserverGate,
  type AnnoEditorProbe,
} from "../lib/annoDebug";
import {
  applyParsedDoc,
  bindEditor,
  cacheParsedDoc,
  takeCachedDoc,
  unbindEditor,
} from "../lib/parsePipeline";
import {
  insertIntoTextarea,
  replaceTextareaSelection,
  svPosOutsideCodeFence,
  svCodeAnchorAt,
  taUndoableReplace,
  toggleWrapTextarea,
  textareaActiveMarks,
  wrapTextareaColor,
  unwrapTextareaColor,
  nextFootnoteId,
} from "../lib/svTextarea";
import {
  classifyUnit,
  linkRangeAt,
  imageAt,
  movableUnit,
  nearestSibling,
  applyBlockTarget,
  moveBlockCommand,
  duplicateBlockCommand,
  deleteBlockCommand,
} from "../lib/blockCommands";

/* -------------------------------------------------------------------------- */
/* 批注徽章编号内建化（B2，v3.9.3）+ 诊断探针                                   */
/* -------------------------------------------------------------------------- */

const ANNO_LABEL_NUM_RE = /^anno-(\d+)$/;

/**
 * 把 footnote_reference 的 schema toDOM 包一层：label 匹配 `anno-N` 时在
 * 渲染产物 attrs 里直接注入 `data-anno-num=N`。此前编号只靠 useAnnotation-
 * Markers 的防抖盖章（60–250ms）写入 DOM 属性——ProseMirror 任何重建
 * （整篇回退 / finalize 原位重放 / 节点视图重绘）都会先渲染一个无编号的
 * 空 <sup>，重建越频繁编号越补不回（「徽章不显示数字」根因）。补丁后
 * 编号随 DOM 创建即存在，任何重建零延迟恢复；盖章管线保留为兜底（幂等，
 * 值相同时不写）。NodeType.spec 是普通可变对象（prosemirror-model 构造
 * 函数 `this.spec = spec`），包裹式 patch 不改原渲染结构；每次 crepe
 * 重建产生新 schema，需重新打（__annoBadge 哨兵防重复）。
 */
function patchFootnoteRefBadge(ctx: Ctx): void {
  try {
    const view = ctx.get(editorViewCtx);
    const type = view.state.schema.nodes.footnote_reference;
    if (!type) return;
    const spec = type.spec as {
      toDOM?: (node: PMNode) => DOMOutputSpec;
    } & { __annoBadge?: boolean };
    const orig = spec.toDOM;
    if (!orig || spec.__annoBadge) return;
    const wrapped = (node: PMNode): DOMOutputSpec => {
      const out = orig.call(spec, node);
      const m = ANNO_LABEL_NUM_RE.exec(String(node.attrs.label ?? ""));
      if (!m || !Array.isArray(out)) return out;
      const attrs = out[1];
      if (attrs != null && typeof attrs === "object" && !Array.isArray(attrs)) {
        return [out[0], { ...attrs, "data-anno-num": m[1] }, ...out.slice(2)];
      }
      return [out[0] as string, { "data-anno-num": m[1] }, ...out.slice(1)];
    };
    (wrapped as { __annoBadge?: boolean }).__annoBadge = true;
    spec.toDOM = wrapped;
  } catch (e) {
    annoEmit("badge.patch.error", "footnote_reference toDOM 补丁失败（编号回退盖章路径）", {
      level: "warn",
      data: { error: String(e) },
    });
  }
}

/** findDefinitionNode 的通用形式：在 doc 里找 label 匹配的节点。 */
function findNodeByLabel(
  doc: PMNode,
  typeName: string,
  label: string
): PMNode | null {
  let hit: PMNode | null = null;
  doc.descendants((n) => {
    if (hit) return false;
    if (n.type.name === typeName && n.attrs.label === label) {
      hit = n;
      return false;
    }
    return true;
  });
  return hit;
}

/**
 * 诊断探针（批注体检用）：暴露真实 ProseMirror 文档与 Milkdown 解析器，
 * 让 annoDebug.runAnnoHealthCheck 能做「文本层 → 节点层 → 真实解析器层」
 * 的分层核查。每次 crepe 重建重新注册；销毁置 null（探针持有 ctx 引用）。
 */
function annoProbeFromCtx(ctx: Ctx): AnnoEditorProbe {
  return {
    hasDefInDoc(id) {
      try {
        const view = ctx.get(editorViewCtx);
        return findNodeByLabel(view.state.doc, "footnote_definition", id) != null;
      } catch {
        return false;
      }
    },
    parseStandalone(defText, id) {
      try {
        const parsed = ctx.get(parserCtx)(defText);
        return parsed ? findNodeByLabel(parsed, "footnote_definition", id) != null : false;
      } catch {
        return false;
      }
    },
    serializeDef(id) {
      try {
        const view = ctx.get(editorViewCtx);
        const node = findNodeByLabel(view.state.doc, "footnote_definition", id);
        if (!node) return null;
        const serialize = ctx.get(serializerCtx);
        // serializer 期望顶层 doc（getMarkdown 对 range 切片也是先包 doc），
        // 单定义节点包一层再序列化，产物即该定义自己的 markdown。
        const doc = view.state.schema.topNodeType.createAndFill(null, node);
        return doc ? serialize(doc) : null;
      } catch {
        return null;
      }
    },
  };
}


/** Imperative ops Editor.tsx composes its EditorHandle from. Mirrors the subset
 *  of the Vditor instance Editor.tsx called (getValue/setValue/getHTML/
 *  getSelection/insertValue/updateValue/focus). */
export interface MilkdownFacade {
  getValue: () => string;
  setValue: (md: string, clearStack?: boolean) => void;
  /** 定点更新一条批注的定义（流式精炼热路径）：只替换 doc 里的
   *  footnote_definition 节点，其余块（含 CodeMirror 代码块子编辑器）的
   *  DOM/node view 原样保留。失败返回 TargetedOpResult 的原因——流式
   *  中间态（no-parse/no-def）应由调用方跳帧，只有 surface（sv 模式等
   *  整篇写回代价低的表面）才回退整篇写回。 */
  updateAnnotationBody: (
    id: string,
    content: string,
    meta: CodeLineMeta | null
  ) => TargetedOpResult;
  /** 定点追加一条批注定义到文档末尾（创建批注热路径）：marker 插入后不再
   *  整篇 setValue，代码块 DOM 不动。事务与 marker 插入合并为一步撤销。
   *  返回 false 时调用方回退整篇写回。 */
  appendAnnoDefinition: (
    id: string,
    content: string,
    meta: CodeLineMeta | null
  ) => boolean;
  /** 定点收尾（流式精炼结束，v3.9.1 不再依赖 baseline）：无痕删除该批注
   *  全部落点后单事务原位放回 marker + 最终定义（closeHistory），两次都只
   *  触碰批注自己的节点（一次 Ctrl+Z 回批注前，契约不变；整篇重写触发
   *  代码块重建的路径只剩回退）。内部事务被抑制回声，由 Editor 调用方
   *  统一补 markDirty + onInput。返回 false 时调用方回退 aiWriteFinalize。 */
  finalizeAnnotationBody: (
    id: string,
    content: string,
    meta: CodeLineMeta | null
  ) => boolean;
  /** 定点删除批注：单事务删定义 + 全部同 id 引用（+ 因此变空的 marker 段）。
   *  返回 false（定义不存在/sv）时调用方回退整篇 removeAnnotationFromMd。 */
  removeAnno: (id: string) => boolean;
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
  /** sv 模式：滚动到 0-based `line` 行首并把光标放那里（大纲跳转）。
   *  smooth=true 时平滑滚动。 */
  jumpToLine: (line: number, smooth?: boolean) => void;
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

/** 整篇文档载入（flush 语义 = replaceAll(md, true)），带解析缓存快路径：
 *  命中 → Node.fromJSON + EditorState 重建，零 remark 解析（阶段 1）；
 *  未命中 → 原地解析（与 replaceAll 同构）并把结果回填缓存（仅大文档），
 *  下次切回同一份内容即命中。任何失败静默返回，调用方语义与旧路径一致。 */
function loadMarkdownFull(crepe: Crepe, md: string): void {
  const cachedJson = takeCachedDoc(md);
  if (cachedJson != null) {
    try {
      const applied = crepe.editor.action((ctx) => {
        const doc = Node.fromJSON(ctx.get(schemaCtx), cachedJson as never);
        applyParsedDoc(ctx, doc);
        return true;
      });
      if (applied) return;
    } catch {
      /* fromJSON 失败（schema 漂移）→ 落回原地解析 */
    }
  }
  try {
    const parsed = crepe.editor.action((ctx) => {
      const doc = ctx.get(parserCtx)(md);
      if (doc) applyParsedDoc(ctx, doc);
      return doc;
    });
    if (parsed) cacheParsedDoc(md, parsed);
  } catch {
    /* not ready */
  }
}

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
  // 重建（内存守护软重建 / idle 历史回收）前捕获的滚动位置与光标上下文，
  // 新实例 ready 后尽力恢复 —— 重建从“无提示的位置重置”变成“几乎无感”。
  const pendingRestoreRef = useRef<{
    scrollTop: number;
    anchor: string;
    hint: number;
  } | null>(null);

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
          // 用户还在阅读/滚动/输入时不打断 —— 重建会重置光标与滚动位置，
          // 这个主动优化只应发生在真正的空闲窗口（下一次真实编辑会重新武装）。
          if (isUserActive(120_000)) return;
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
          // themselves. DOM stamping (annotation badges + image lazy attrs) is
          // NOT scheduled here anymore: useAnnotationMarkers' MutationObserver
          // already debounces+coalesces the very DOM changes these transactions
          // produce (60ms + rAF), so the old double-rAF per markdownUpdated
          // merely duplicated every stamp walk per keystroke.
          if (!suppressRef.current) {
            contentRef.current = md;
            onInputRef.current(md);
            // T6: count real edits toward the proactive history-reclaim gate.
            editsSinceTrimRef.current++;
            scheduleIdleTrim();
          }
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
      // 阶段1/2：把新实例的 Schema/remark 插件表登记给解析管线（缓存签名 +
      // worker 哨兵校验都基于它）。每次 recreate 都会重新绑定。放在 seed 之前，
      // 让 seed 的整篇解析也能正确回填缓存。
      bindEditor(crepe.editor.ctx);
      // B2：footnote_reference toDOM 注入 data-anno-num（编号随 DOM 创建即
      // 存在，重建零延迟恢复）+ 诊断探针（批注体检用，重建时重绑）+
      // PM 观察器暂停门（盖章战争根修，见 annoDebug.withPmObserverPaused）。
      crepe.editor.action((ctx) => patchFootnoteRefBadge(ctx));
      registerAnnoProbe(annoProbeFromCtx(crepe.editor.ctx));
      registerPmObserverGate((fn) => {
        const v = crepe.editor.ctx.get(editorViewCtx);
        const obs = (
          v as unknown as {
            domObserver?: { stop(): void; start(): void };
          }
        ).domObserver;
        if (!obs || typeof obs.stop !== "function" || typeof obs.start !== "function") {
          fn();
          return;
        }
        obs.stop();
        try {
          fn();
        } finally {
          obs.start();
        }
      });
      annoEmit("editor.ready", "Milkdown 实例就绪（徽章 toDOM 补丁 + 探针 + PM 门已挂）");
      // Seed content with flush=true so headings pick up the generator AND the
      // undo history starts clean for this document.
      if (seed) {
        suppressRef.current = true;
        loadMarkdownFull(crepe, seed);
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
      registerAnnoProbe(null);
      registerPmObserverGate(null);
      unbindEditor();
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
      } catch (e) {
        noteOpError(`toggleMark:${name}`, e);
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
        // 诊断：非载入（clearStack!==true）的 setValue 是程序化整篇重写——
        // 会重建全部代码块子编辑器与批注徽章（闪烁来源），计数以便定位
        // 「谁还在整篇写」（文件载入不计入）。
        if (clearStack !== true) annoCount("fulldoc.setValue");
        // A full-document load that flips the big-doc cutoff would parse the
        // doc twice: once for this load, then again when the recreate below
        // seeds the new instance with the same content. Skip the doomed load —
        // the recreate path seeds from contentRef — so a big file that crosses
        // the cutoff is parsed exactly once.
        if (clearStack === true && isBigDoc(md) !== bigDocRef.current) {
          maybeRecreateForBigDoc(md);
          return;
        }
        if (clearStack === true) {
          // 整篇载入：优先解析缓存（阶段 1 命中 → 零解析），未命中原地解析
          // 并回填缓存。suppress 包住两条路径，避免程序化载入被当作用户输入。
          suppressRef.current = true;
          loadMarkdownFull(crepe, md);
          suppressRef.current = false;
          contentRef.current = md;
          return;
        }
        suppressRef.current = true;
        try {
          crepe.editor.action(replaceAll(md, false));
        } catch (e) {
          noteOpError("setValue", e);
        }
        suppressRef.current = false;
        contentRef.current = md;
      },
      updateAnnotationBody: (id, content, meta) => {
        // 流式精炼热路径：整篇 replaceAll 每帧把所有代码块的 CodeMirror
        // 子编辑器连根重建（视觉上“乱闪”），且撤销栈被大量全文档步压满。
        // 这里只替换目标 footnote_definition 节点 —— ProseMirror 只重渲染
        // 变化区间，代码块与其余块不动。事务照常进历史：相邻帧由
        // prosemirror-history 的 newGroupDelay 合并，收尾仍由
        // aiWriteFinalize(baseline) 收束为一步撤销（契约不变）。
        // 实现见 lib/annotationOps.replaceDefinitionOp。
        if (modeRef.current === "sv") return { ok: false, reason: "surface" };
        const crepe = crepeRef.current;
        if (!crepe) return { ok: false, reason: "surface" };
        return crepe.editor.action((ctx) =>
          replaceDefinitionOp(ctx, id, content, meta)
        );
      },
      appendAnnoDefinition: (id, content, meta) => {
        // 创建批注热路径：marker 已定点插入，定义也定点追加（文档末尾），
        // 不再整篇 setValue —— 代码块 DOM 全程不动，创建瞬间不闪。
        // 与 insertAnnoMarker 一样抑制回声：Editor 随后统一补一次
        // markDirty + onInput（避免监听器 + 手动路径双重上抛）。
        if (modeRef.current === "sv") return false;
        const crepe = crepeRef.current;
        if (!crepe) return false;
        suppressRef.current = true;
        try {
          return crepe.editor.action((ctx) =>
            appendDefinitionOp(ctx, id, content, meta)
          );
        } catch {
          return false;
        } finally {
          suppressRef.current = false;
        }
      },
      finalizeAnnotationBody: (id, content, meta) => {
        // 流式收尾热路径（v3.9.1 去 baseline 版，见 annotationOps）：无痕
        // 删除批注落点 + 原位放回，收尾瞬间代码块不再重建。两步事务被抑制
        // 回声（避免中间态镜像），Editor 调用方统一补 markDirty + onInput。
        if (modeRef.current === "sv") return false;
        const crepe = crepeRef.current;
        if (!crepe) return false;
        suppressRef.current = true;
        try {
          return crepe.editor.action((ctx) =>
            finalizeAnnotationOp(ctx, id, content, meta)
          );
        } catch {
          return false;
        } finally {
          suppressRef.current = false;
        }
      },
      removeAnno: (id) => {
        // 删除热路径：单事务删定义 + 引用，不整篇重写。
        if (modeRef.current === "sv") return false;
        const crepe = crepeRef.current;
        if (!crepe) return false;
        return crepe.editor.action((ctx) => removeAnnoOp(ctx, id));
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
          // 走 loadMarkdownFull：与 replaceAll(md,true) 同 flush 语义，且
          // 大文档在此前已解析过（缓存/预解析）时零解析直装、结果回填缓存。
          suppressRef.current = true;
          loadMarkdownFull(crepe, md);
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
        } catch (e) {
          noteOpError("insertValue", e);
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
        } catch (e) {
          noteOpError("updateValue", e);
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
        } catch (e) {
          noteOpError("insertAfter", e);
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
        } catch (e) {
          noteOpError("insertAtPos", e);
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
              // 同步盖章（幂等、有早退）：徽章编号在浏览器绘制前就位。
              // 等 MutationObserver 的 60ms 防抖意味着新徽章先以空药丸
              // 渲染一拍再蹦出编号 —— 创建瞬间可见的「闪一下」。
              stampAnnotationMarkers();
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
              // 同上；这里还多一层：marker 段落先以普通块级段落（~44px 行
              // 盒 + 段距）渲染，60ms 盖上 anno-row-item 后才 inline 化
              // （~24px）——布局塌陷 + 滚动锚定补偿 = 创建瞬间「先沉后弹」
              // 双跳。同步盖章让 inline 形态首帧生效，双跳消失。
              stampAnnotationMarkers();
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
        } catch (e) {
          noteOpError("aiWriteDoc", e);
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
        } catch (e) {
          noteOpError("aiWriteRange", e);
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
            noteScrollWrite("pm-insert");
            view.dispatch(closeHistory(view.state.tr.replaceSelection(slice).scrollIntoView()));
          });
        } catch (e) {
          noteOpError("aiWriteInsert", e);
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
        annoCount("fulldoc.aiWriteFinalize", 2);
        annoEmit(
          "anno.finalize.full",
          "aiWriteFinalize：baseline 还原 + 写入 next（整篇×2，一次性）",
          { level: "warn" }
        );
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
        } catch (e) {
          noteOpError("aiWriteFinalize", e);
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
            noteScrollWrite("reveal");
            view.dispatch(tr);
          });
        } catch (e) {
          noteOpError("revealText", e);
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
        } catch (e) {
          noteOpError("toggleInlineCode", e);
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
        } catch (e) {
          noteOpError("insertLink", e);
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
            } catch (e) {
              noteOpError("insertFootnote", e);
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
      jumpToLine: (line, smooth) => {
        if (svRef.current) {
          svRef.current.jumpToLine(line, smooth);
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
        } catch (e) {
          noteOpError("setTextColor", e);
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
        } catch (e) {
          noteOpError("clearTextColor", e);
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
        } catch (e) {
          noteOpError("setBlockType", e);
        }
      },
      moveBlock: (dir) => {
        if (modeRef.current === "sv") return false;
        try {
          return crepeRef.current!.editor.action((ctx) =>
            moveBlockCommand(ctx.get(editorViewCtx), dir)
          );
        } catch (e) {
          // 返回 false 对调用方是「无可移动」的正常信号，但异常路径（命令
          // 内部抛错）在这里本不可见——接入 opDebug，静默失败必须留痕。
          noteOpError("moveBlock", e);
          return false;
        }
      },
      duplicateBlock: () => {
        if (modeRef.current === "sv") return;
        try {
          crepeRef.current!.editor.action((ctx) => {
            duplicateBlockCommand(ctx.get(editorViewCtx));
          });
        } catch (e) {
          noteOpError("duplicateBlock", e);
        }
      },
      deleteBlock: () => {
        if (modeRef.current === "sv") return;
        try {
          crepeRef.current!.editor.action((ctx) => {
            deleteBlockCommand(ctx.get(editorViewCtx));
          });
        } catch (e) {
          noteOpError("deleteBlock", e);
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
        } catch (e) {
          noteOpError("tableOp", e);
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
        } catch (e) {
          noteOpError("updateLinkHref", e);
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
      // 走 loadMarkdownFull：大文档从 sv 切回富文本同样吃解析缓存（此前在
      // sv 里整篇载入/预解析过的内容零解析直装）。
      if (modeRef.current === "sv") {
        const crepe = crepeRef.current;
        if (crepe) {
          suppressRef.current = true;
          loadMarkdownFull(crepe, contentRef.current);
          suppressRef.current = false;
        }
      }
      setModeState(m);
    },
    [svSurface, sourceRef]
  );

  const recreate = useCallback(() => {
    // 重建前快照滚动 + 光标上下文（富文本模式）：新实例 seed 后按文本
    // 重新锚定光标并恢复滚动位置。sv 模式不需要（表面常驻、内容不重置）。
    if (modeRef.current !== "sv") {
      try {
        const scroller = document.querySelector<HTMLElement>(".mditor-editor-host");
        crepeRef.current?.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const head = view.state.selection.head;
          const from = Math.max(0, head - 48);
          const to = Math.min(view.state.doc.content.size, head + 48);
          const anchor = view.state.doc.textBetween(from, to, "\n").trim();
          if (anchor) {
            pendingRestoreRef.current = {
              scrollTop: scroller?.scrollTop ?? 0,
              anchor,
              hint: head,
            };
          }
        });
      } catch {
        /* best-effort — 重建照常进行 */
      }
    }
    contentRef.current =
      modeRef.current === "sv"
        ? svSurface()?.value ?? sourceTextRef.current ?? contentRef.current
        : (crepeRef.current?.getMarkdown() ?? contentRef.current);
    setRecreateToken((t) => t + 1);
  }, [svSurface]);

  // 重建完成后恢复光标与滚动位置（尽力而为：按文本锚点重定位，找不到就
  // 保持新实例的默认状态）。双 rAF 等新视图完成首次布局再写 scrollTop。
  useEffect(() => {
    if (!ready) return;
    const r = pendingRestoreRef.current;
    if (!r) return;
    pendingRestoreRef.current = null;
    let raf2: number | null = null;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        raf2 = null;
        if (modeRef.current === "sv") return;
        try {
          crepeRef.current?.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const range = findAnchorRange(view.state.doc, r.anchor, r.hint);
            if (range) {
              const pos = Math.min(range.from, view.state.doc.content.size);
              view.dispatch(
                view.state.tr.setSelection(
                  TextSelection.near(view.state.doc.resolve(pos))
                )
              );
            }
          });
        } catch {
          /* best-effort */
        }
        const scroller = document.querySelector<HTMLElement>(".mditor-editor-host");
        if (scroller && r.scrollTop > 0) {
          noteScrollWrite("rebuild-restore");
          scroller.scrollTop = r.scrollTop;
        }
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2 != null) cancelAnimationFrame(raf2);
    };
  }, [ready]);

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
