// 源码模式（sv）的 CodeMirror 6 编辑面（V3.6）。
//
// 之前 sv 模式是一个裸 <textarea>：无语法高亮、无行号、无折叠。本模块把
// CodeMirror 6（markdown 语言 + 行号 + foldGutter + 活动行高亮 + 历史栈）装进
// sv 宿主，同时导出一个「textarea 形状」的适配器（SvSurface）——useMilkdown
// 里所有 sv 分支（facade 与 toggleWrapTextarea 等辅助函数）只依赖
// value/selectionStart/selectionEnd/setSelectionRange/focus 这一小部分
// textarea API，适配器实现同一子集即可原样复用全部既有逻辑。
//
// 撤销契约（AI 一步撤销）：adapter.undoableReplace 把一次写回作为一个事务
// dispatch（进历史），CM 原生 Ctrl+Z 恰好退回这一步 —— 对齐富文本模式的
// closeHistory 单事务语义。setValueReset 用 setState 整体重置（清历史），
// 对应文件载入 / 进入 sv 模式时的 clearStack=true 路径。
//
// 主题：不使用 CM 的 theme() 硬编码颜色，token 颜色由 HighlightStyle 输出
// 引用 global.css 里按主题定义的 --tok-* / --fg-* CSS 变量（与代码块高亮、
// 静态渲染同源同色），外观细节在 global.css 的 .mditor-sv 规则里完成。

import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  placeholder,
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  history,
  defaultKeymap,
  historyKeymap,
} from "@codemirror/commands";
import {
  foldGutter,
  indentOnInput,
  bracketMatching,
  foldKeymap,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";
import { noteScrollWrite } from "./scrollDebug";

/** textarea 形状的 sv 编辑面（适配器或回退的 <textarea> 本身）。 */
export interface SvSurface {
  value: string;
  /** textarea 语义的可写选区：赋值 dispatch 选区事务（辅助函数里有
   *  `ta.selectionStart = ta.selectionEnd = x` 的写法）。 */
  selectionStart: number;
  selectionEnd: number;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  /** 单事务撤销式写入（AI 一步撤销的 sv 路径）。textarea 回退实现返回
   *  false，调用方退回 execCommand。 */
  undoableReplace?(from: number, to: number, text: string): boolean;
}

export interface SvEditorHandle {
  view: EditorView;
  /** 实现 SvSurface 的适配器（挂在 CM view 上）。 */
  surface: SvSurface;
  /** 整体重置文档并清空撤销历史（文件载入 / 进入 sv 模式）。 */
  setValueReset: (md: string) => void;
  /** 把光标规范到 0-based `line` 行首并滚动到视口中部（大纲跳转等）。
   *  smooth=true 时平滑滚动到目标行（大纲跳转），否则瞬时（默认，注释/
   *  搜索跳转等依赖落位后立即量 rect 的路径）。 */
  jumpToLine: (line: number, smooth?: boolean) => void;
  destroy: () => void;
}

export interface SvEditorOptions {
  /** 初始文档内容。 */
  initial: string;
  /** 文档变化（用户输入或适配器写入）回调 —— 由 useMilkdown 决定是否上抛。 */
  onDocChanged: (md: string) => void;
  /** 选区变化回调（选区字数统计等轻量监听）。 */
  onSelectionChanged?: () => void;
  /** 读取打字机模式是否开启（实时读取，避免重建编辑器）。 */
  isTypewriter?: () => boolean;
  /** 加粗/高光快捷键的 textarea 等价实现（包装/解包选区）。 */
  onToggleWrap?: (mark: "bold" | "highlight") => void;
}

/** Markdown 源码高亮：token → 主题 CSS 变量（颜色在 global.css 按主题定义）。 */
const mdHighlightStyle = HighlightStyle.define([
  { tag: t.heading, color: "var(--tok-keyword)", fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic", color: "var(--tok-attr)" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--tok-comment)" },
  { tag: t.monospace, color: "var(--tok-string)" },
  { tag: t.link, color: "var(--tok-attr)", textDecoration: "underline" },
  { tag: t.url, color: "var(--tok-string)" },
  { tag: t.quote, color: "var(--tok-comment)", fontStyle: "italic" },
  { tag: t.list, color: "var(--tok-keyword)" },
  { tag: t.processingInstruction, color: "var(--tok-meta)" }, // 围栏 ``` 与行内标记
  { tag: t.meta, color: "var(--tok-meta)" },
  { tag: t.comment, color: "var(--tok-comment)" },
  { tag: t.contentSeparator, color: "var(--tok-punct)" },
  { tag: t.escape, color: "var(--tok-number)" },
  { tag: t.tagName, color: "var(--tok-type)" },
  { tag: t.attributeName, color: "var(--tok-attr)" },
  { tag: t.attributeValue, color: "var(--tok-string)" },
  { tag: t.keyword, color: "var(--tok-keyword)" },
  { tag: t.number, color: "var(--tok-number)" },
  { tag: t.string, color: "var(--tok-string)" },
  { tag: t.typeName, color: "var(--tok-type)" },
]);

/** 平滑跳转期间抑制打字机自动居中：jumpToLine 的选区事务会同步触发
 *  updateListener 的 viewScrolledCenter（瞬时滚动），它会立刻掐断进行中的
 *  平滑动画 —— 跳转前后置位/复位此标记让该次居中跳过。 */
interface SmoothJumpFlag {
  active: boolean;
}

/** 系统开启了「减少动态效果」时退回瞬时滚动。 */
function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function buildExtensions(opts: SvEditorOptions, smoothJump?: SmoothJumpFlag) {
  return [
    lineNumbers(),
    foldGutter(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorView.lineWrapping,
    indentOnInput(),
    bracketMatching(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    rectangularSelection(),
    crosshairCursor(),
    placeholder("开始书写…  (源码模式 · Ctrl+S 保存，Ctrl+F 查找)"),
    markdown({ base: markdownLanguage, codeLanguages: [] }),
    syntaxHighlighting(mdHighlightStyle),
    keymap.of([
      { key: "Mod-b", run: () => (opts.onToggleWrap?.("bold"), true) },
      { key: "Mod-Shift-h", run: () => (opts.onToggleWrap?.("highlight"), true) },
      {
        // 与旧 textarea 行为一致：Tab 插入两个空格而不是移动焦点。
        key: "Tab",
        run: (view) => {
          view.dispatch(
            view.state.replaceSelection("  ")
          );
          return true;
        },
      },
      ...foldKeymap,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) opts.onDocChanged(update.state.doc.toString());
      if (update.selectionSet) {
        opts.onSelectionChanged?.();
        // 打字机模式：光标行滚动到视口中部（effect-only 事务，不进历史，
        // 也不会再触发本监听的 selectionSet 分支 → 无递归）。平滑跳转发起
        // 的选区变化跳过（见 SmoothJumpFlag）。
        if (opts.isTypewriter?.() && !smoothJump?.active) {
          viewScrolledCenter(update.view);
        }
      }
    }),
  ];
}

/** 打字机滚动：把主光标滚到视口纵向中部。 */
function viewScrolledCenter(view: EditorView): void {
  const pos = view.state.selection.main.head;
  view.dispatch({
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
}

/** 在 `host` 上创建源码模式 CodeMirror 实例。 */
export function createSvEditor(
  host: HTMLElement,
  opts: SvEditorOptions
): SvEditorHandle {
  const smoothJump: SmoothJumpFlag = { active: false };
  const view = new EditorView({
    state: EditorState.create({
      doc: opts.initial,
      extensions: buildExtensions(opts, smoothJump),
    }),
    parent: host,
  });

  const surface: SvSurface = {
    get value() {
      return view.state.doc.toString();
    },
    set value(v: string) {
      if (v === view.state.doc.toString()) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: v },
      });
    },
    get selectionStart() {
      const { anchor, head } = view.state.selection.main;
      return Math.min(anchor, head);
    },
    set selectionStart(v: number) {
      const end = Math.max(view.state.selection.main.anchor, view.state.selection.main.head);
      surface.setSelectionRange(v, end);
    },
    get selectionEnd() {
      const { anchor, head } = view.state.selection.main;
      return Math.max(anchor, head);
    },
    set selectionEnd(v: number) {
      const start = Math.min(view.state.selection.main.anchor, view.state.selection.main.head);
      surface.setSelectionRange(start, v);
    },
    focus() {
      view.focus();
    },
    setSelectionRange(start: number, end: number) {
      const len = view.state.doc.length;
      const s = Math.max(0, Math.min(start, len));
      const e = Math.max(s, Math.min(end, len));
      view.dispatch({ selection: { anchor: s, head: e } });
    },
    undoableReplace(from, to, text) {
      const len = view.state.doc.length;
      const f = Math.max(0, Math.min(from, len));
      const ti = Math.max(f, Math.min(to, len));
      view.focus();
      view.dispatch({
        changes: { from: f, to: ti, insert: text },
        selection: { anchor: f + text.length },
      });
      return true;
    },
  };

  return {
    view,
    surface,
    setValueReset(md: string) {
      view.setState(
        EditorState.create({ doc: md, extensions: buildExtensions(opts, smoothJump) })
      );
    },
    jumpToLine(line: number, smooth = false) {
      // 两个分支都写滚动位置（瞬时：CM scrollIntoView + focus；平滑：
      // scroller.scrollTo），入口统一打点，瞬时分支此前漏登记。
      noteScrollWrite("sv-jump");
      const l = Math.max(0, Math.min(line, view.state.doc.lines - 1));
      const pos = view.state.doc.line(l + 1).from;
      const y: "start" | "center" = opts.isTypewriter?.() ? "center" : "start";
      if (!smooth) {
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y }),
        });
        view.focus();
        return;
      }
      // 平滑跳转（大纲）：CM 的 scrollIntoView 只能瞬时滚，这里先落光标
      // （选区事务被 smoothJump 标记抑制掉打字机居中），再对 scrollDOM
      // 做一次平滑 scrollTo 到与瞬时路径相同的对齐目标。focus 的原生
      // 光标滚动在量坐标前发生，之后发起的平滑滚动是最后一次滚动指令，
      // 不再会被覆盖。尊重系统的减少动态效果偏好。
      // v3.9：抑制标志覆盖动画全程（此前同步 dispatch 后就复位，动画
      // 窗口内任何选区事务触发的打字机居中都会瞬时滚动掐断动画 —— 滚动
      // 抖动候选根因）。scrollend（完成/被打断）或超时兜底复位，与富文本
      // 路径 host.dataset.smoothJump 的清除策略一致。
      smoothJump.active = true;
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
      const scroller = view.scrollDOM;
      const block = view.lineBlockAt(pos);
      const viewportTop = view.documentTop + block.top;
      const rect = scroller.getBoundingClientRect();
      const offset =
        y === "center"
          ? viewportTop - rect.top - scroller.clientHeight / 2
          : viewportTop - rect.top;
      const clear = () => {
        smoothJump.active = false;
      };
      scroller.scrollTo({
        top: Math.max(0, scroller.scrollTop + offset),
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      if (prefersReducedMotion()) {
        clear();
        return;
      }
      scroller.addEventListener("scrollend", clear, { once: true });
      window.setTimeout(clear, 1200);
    },
    destroy() {
      view.destroy();
    },
  };
}
