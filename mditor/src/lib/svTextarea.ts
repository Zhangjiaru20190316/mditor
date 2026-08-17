// 源码模式（sv）textarea 表面辅助函数 —— 从 hooks/useMilkdown.ts 抽出的纯
// 逻辑（无 React / DOM 依赖，除 textarea 表面自身的 value/selection 操作），
// 服务于加粗/高亮/斜体/删除线/行内代码包裹、颜色 span 包裹、可撤销写入、
// 批注代码行锚点、脚注 id 分配等。抽出后可独立单测，也把 useMilkdown 从
// 2400+ 行的 god-hook 状态里卸下一块。

import type { SvSurface } from "./svCodeMirror";
import type { CodeLineMeta } from "./codeAnno";
import { COLOR_DECL_RE, colorFromStyle } from "./colorSpan";

/** Insert `text` at the surface caret (no selection overwrite). */
export function insertIntoTextarea(ta: HTMLTextAreaElement | SvSurface, text: string): void {
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
export function svPosOutsideCodeFence(value: string, pos: number): number {
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
 *  collapsed). */
export function replaceTextareaSelection(ta: HTMLTextAreaElement | SvSurface, text: string): void {
  const s = ta.selectionStart;
  const en = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(en);
  const pos = s + text.length;
  ta.setSelectionRange(pos, pos);
}

/** Undoable surface write（AI 一步撤销的 sv 模式路径）：CodeMirror 表面经
 * undoableReplace 单事务写入（CM 历史一步）；textarea 回退选中 [from,to)
 * 后经 execCommand("insertText") 写入，原生撤销把整次写入当作一步。均返回
 * false 时调用方退回普通赋值，保正确性、牺牲撤销粒度。 */
export function taUndoableReplace(
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
export function svCodeAnchorAt(value: string, from: number, to: number): CodeLineMeta | null {
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
export function toggleWrapTextarea(
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
export function textareaActiveMarks(ta: HTMLTextAreaElement | SvSurface): {
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
export function nextFootnoteId(md: string): string {
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
export function wrapTextareaColor(ta: HTMLTextAreaElement | SvSurface, color: string): void {
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
export function unwrapTextareaColor(ta: HTMLTextAreaElement | SvSurface): void {
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
