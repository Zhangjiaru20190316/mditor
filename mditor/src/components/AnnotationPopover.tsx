// Popover that reveals an annotation's content when its marker is clicked.
//
// Annotations live in the document as `[^anno-N]` markers that Milkdown renders
// as <sup data-type="footnote_reference" data-label="anno-N"> badges (restyled
// by annotation.css). This component listens for clicks anywhere on those
// badges, resolves the id from `data-label`, and opens a fixed-position card
// showing the body.
//
// 打开反馈（v3.9.1）：mousedown 不再做任何同步整篇解析（大文档上 50–200ms
// 的主线程冻结会把第一击吞掉——「要点两次」的来源之一）。第一击立即渲染
// 卡片壳（内容位「正在解析批注…」），防抖列表命中则直接带内容打开；列表
// 滞后时由解析 effect 在渲染后补齐（findLive 仍是存在性判定的事实源，只
// 是挪出了点击处理器、且发生在首帧绘制之后）。
//
// 代码行级批注：当批注带有 codeLine 元数据（锚在代码块内的具体行上，见
// lib/codeAnno.ts）时，打开前先按当前文档内容重新解析行位（跟随内容而非行
// 号），高亮对应代码行（CodeMirror .cm-line / 整块 pre 兜底），popover 贴着
// 第一个高亮行定位；关闭时清掉高亮。高亮锚点被记录在 lib/codeAnno.ts，代码
// 块节点视图被 ProseMirror 重绘后由 stamp 管线自动补画。
//
// Positioning (v3.9): measure ONCE at open — the anchor rect plus every other
// marker's geometry cached in document space — then keep the card glued to its
// anchor with pure arithmetic on scroll (no per-frame querySelectorAll /
// getBoundingClientRect batches), re-measuring only on resize / edit-save /
// popover switch. Streaming content updates never reposition the card (the
// marker doesn't move when only a hidden definition body changes).

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { parseAnnotations, type Annotation } from "../lib/annotations";
import {
  ANNO_MARKER_SELECTOR,
  CODE_LINE_HL_CLASS,
  activeHighlightAnchor,
  clearCodeLineHighlights,
  highlightCodeLines,
  resolveCodeLines,
  setActiveCodeHighlight,
} from "../lib/codeAnno";
import { placeCard, clampTop, type PlaceBox, type PlaceBounds, type PlacePos } from "../lib/popoverPlace";
import { confirmDialog } from "../lib/dialogs";
import { annoCount, annoEmit } from "../lib/annoDebug";
import { takePendingJumpAnno } from "../lib/annoHandoff";
import type { Theme } from "../types";
import { MarkdownText } from "./MarkdownText";
import { AnnotationIcon, CloseIcon } from "./icons";

interface Props {
  /** Current parsed annotations (fast path for the active one's body). */
  annotations: Annotation[];
  /** Fresh synchronous read of the LIVE editor markdown (O(doc) serialize —
   * click/close paths only, i.e. rare). The source of truth for existence. */
  getMarkdown: () => string;
  /** Save edited content for the given id. */
  onUpdate: (id: string, content: string) => void;
  /** Delete the given annotation (marker + definition). */
  onDelete: (id: string) => void;
  /** App theme, forwarded to the Markdown renderer. */
  theme: Theme;
}

/** Document-space marker geometry: viewport left/right (unchanged by vertical
 *  scroll) + content-space top/bottom (viewport top = docTop - scrollTop). */
interface CachedMarker {
  left: number;
  right: number;
  docTop: number;
  docBottom: number;
}

/** The element the card should hug: the highlighted code line inside the
 *  ACTIVE annotation's own block (scoped — the first highlight anywhere in the
 *  document may belong to another annotation), else the marker badge itself. */
function anchorElement(activeId: string): HTMLElement | null {
  return activeHighlightAnchor(activeId);
}

/** 视口的纵向可用边界（v3.9.4）：fixed 卡片必须让开标题栏/标签栏/状态栏。
 *  栏不存在（焦点模式 display:none）时 offsetHeight 为 0，边界自动退化为
 *  裸视口；8px 呼吸边距与 placeCard 的 margin 一致。 */
function measureChromeBounds(): PlaceBounds {
  const bar = (sel: string) =>
    document.querySelector<HTMLElement>(sel)?.offsetHeight ?? 0;
  return {
    top: bar(".titlebar") + bar(".tabbar") + 8,
    bottom: window.innerHeight - bar(".sb-status") - 8,
  };
}

/** el 所在的 ProseMirror 顶层块（徽章 → 段落 → … → 顶层块）。 */
function topBlockOf(el: Element, pm: Element): Element | null {
  let p: Element | null = el.parentElement;
  while (p && p !== pm && p.parentElement !== pm) p = p.parentElement;
  return p === pm ? null : p;
}

/** 大文档（host[data-big]，content-visibility:auto）下只保留视口 ±600px 内
 *  的顶层块：对被跳过渲染的块内部元素调 getBoundingClientRect 会强制整块
 *  布局 —— 全量徽章测量正是弹层打开时滚动卡顿的主源。块级框尺寸对
 *  content-visibility 是已知的（占位/记忆尺寸），测块不布局子树。
 *  小文档返回 null = 不做过滤（布局缓存读取便宜）。 */
function viewportNearBlocks(scroller: HTMLElement): Set<Element> | null {
  if (!scroller.hasAttribute("data-big")) return null;
  const pm = scroller.querySelector(".ProseMirror");
  if (!pm) return null;
  const vh = window.innerHeight;
  const margin = 600;
  const near = new Set<Element>();
  for (const block of Array.from(pm.children)) {
    const r = block.getBoundingClientRect();
    if (r.bottom > -margin && r.top < vh + margin) near.add(block);
  }
  return near;
}

export const AnnotationPopover = memo(function AnnotationPopover({
  annotations,
  getMarkdown,
  onUpdate,
  onDelete,
  theme,
}: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pos, setPos] = useState<PlacePos | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // annotations prop 落后于实时文档（useAnnotations 的 150ms 防抖）：刚插入
  // 批注 / 刚切换文件后的徽章点击，prop 列表里还查不到该 id。由解析 effect
  // 在首帧后对实时文档同步解析一次存到这里，避免弹窗开了立刻被当成
  // “批注不存在”关掉（表现为点击没反应）。
  const [fallback, setFallback] = useState<Annotation | null>(null);
  // 孤儿标记：点击的徽章在实时文档里找不到定义（定义被解析丢弃/损坏）时，
  // 不再静默无反应 —— 延迟一拍重试（rAF 实时镜像可能还差一两帧）后仍缺失，
  // 则渲染“内容缺失”卡片，允许一键删除残留标记。
  const [orphanId, setOrphanId] = useState<string | null>(null);
  // 编辑保存 / 外部几何变化后触发一次全量重测（见 placeCard 注释）。
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const retryTimerRef = useRef<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // activeId 的 ref 镜像：全局监听器只注册一次（mount），回调内读最新值，
  // 避免 activeId 每次变化都重注册 mousedown/keydown。
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  // annotations / getMarkdown 的 ref 镜像（同上，供一次性注册的监听与定时器）。
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const getMarkdownRef = useRef(getMarkdown);
  getMarkdownRef.current = getMarkdown;
  const orphanIdRef = useRef<string | null>(null);
  orphanIdRef.current = orphanId;
  // 本次 activeId 期间是否曾解析到内容（列表或实时解析）：消失关闭判定用——
  // 显示过再消失（侧栏删除等）→ 关闭；从未解析到 → 孤儿卡片。
  const resolvedRef = useRef(false);

  // 打开期间缓存的「其他徽章」几何（文档空间）+ 滚动容器 + chrome 边界。
  // open 时测量一次，纯滚动用算术平移；其他位移源（面板拖拽/内部滚动/布局
  // 变化）触发整体重测。
  const geomRef = useRef<{
    scroller: HTMLElement;
    others: CachedMarker[];
    bounds: PlaceBounds;
  } | null>(null);

  const active = activeId
    ? annotations.find((a) => a.id === activeId) ??
      (fallback?.id === activeId ? fallback : null)
    : null;

  /** 对实时文档做一次同步解析，查指定批注（打开/关闭判定的唯一事实源）。
   *  只在渲染后的 effect / 定时器里调用——绝不在 mousedown 处理器内同步跑
   *  （O(doc) 序列化会冻结主线程，把第一击的视觉反馈吞掉）。 */
  const findLive = useCallback(
    (id: string): Annotation | null =>
      parseAnnotations(getMarkdownRef.current()).find((a) => a.id === id) ?? null,
    []
  );

  /** 代码行级批注的行位重解 + 高亮（onDown 与解析 effect 兜底共用）。
   *  `scroll:false` 供解析 effect 的补齐路径用 —— 打开兜底发生在用户已经
   *  看到卡片壳之后，此时 scrollIntoView 会突然拽走视口（滚动抖动）。
   *  返回第一个高亮行元素（定位用）；解析失败 / marker 不在 → null。 */
  const applyCodeLine = useCallback(
    (
      id: string,
      codeLine: Annotation["codeLine"],
      opts: { scroll?: boolean } = {}
    ): HTMLElement | null => {
      if (!codeLine) return null;
      const markerEl = document.querySelector<HTMLElement>(
        `${ANNO_MARKER_SELECTOR}[data-label="${cssEsc(id)}"]`
      );
      if (!markerEl) return null;
      const resolved = resolveCodeLines(getMarkdownRef.current(), id, codeLine);
      if (!resolved) return null;
      const lineEl = highlightCodeLines(markerEl, resolved.start, resolved.end, {
        ...opts,
        blockIndex: resolved.blockIndex,
      });
      if (!lineEl) return null;
      // 记录高亮锚点：代码块节点视图被重绘后自动补画（stamp 管线）。
      setActiveCodeHighlight(id, resolved.start, resolved.end, resolved.blockIndex);
      return lineEl;
    },
    []
  );

  const close = useCallback(() => {
    annoEmit("popover.close", `关闭 ${activeIdRef.current ?? ""}`);
    setActiveId(null);
    setPos(null);
    setEditing(false);
    setDraft("");
    setFallback(null);
    setOrphanId(null);
    geomRef.current = null;
    if (retryTimerRef.current != null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    clearCodeLineHighlights();
  }, []);

  // 换了激活批注：重置「曾解析到内容」标记（须在下面的解析 effect 之前）。
  useEffect(() => {
    resolvedRef.current = false;
  }, [activeId]);
  // 内容可用（列表或兜底）即视为「已解析」。
  useEffect(() => {
    if (active) resolvedRef.current = true;
  }, [active]);

  // 统一「解析当前批注」effect：打开兜底（第一击内容未就位 → 填充/孤儿卡）
  // 与「批注消失」关闭判定合一。列表查不到且尚未填充时，渲染后对实时文档
  // 同步解析一次（首帧卡片壳已上屏，主线程开销不再吞掉第一击反馈）；仍
  // miss 则 60ms 后复查——活着 → 填充；从未解析到 → 孤儿卡片；曾显示过又
  // 消失（侧栏删除/外部重写）→ 关闭。
  useEffect(() => {
    if (!activeId || orphanId === activeId) return;
    if (annotations.some((a) => a.id === activeId)) return;
    if (fallback?.id === activeId) return;
    if (retryTimerRef.current != null) return;
    const live = findLive(activeId);
    if (live) {
      setFallback(live);
      // 代码行批注且第一击没赶上列表（未高亮）→ 现在补高亮并重锚定卡片。
      if (
        live.codeLine &&
        !document.querySelector(`.${CODE_LINE_HL_CLASS}`)
      ) {
        const lineEl = applyCodeLine(activeId, live.codeLine, { scroll: false });
        if (lineEl) setLayoutEpoch((e) => e + 1);
      }
      return;
    }
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      if (activeIdRef.current !== activeId) return;
      if (annotationsRef.current.some((a) => a.id === activeId)) return;
      if (orphanIdRef.current === activeId) return;
      const retry = findLive(activeId);
      if (retry) {
        setFallback(retry);
        if (
          retry.codeLine &&
          !document.querySelector(`.${CODE_LINE_HL_CLASS}`)
        ) {
          const lineEl = applyCodeLine(activeId, retry.codeLine, { scroll: false });
          if (lineEl) setLayoutEpoch((e) => e + 1);
        }
        return;
      }
      if (resolvedRef.current) close();
      else setOrphanId(activeId);
    }, 60);
  }, [activeId, annotations, fallback, orphanId, findLive, applyCodeLine, close]);

  // 批注随后出现（镜像追上/撤销恢复）→ 退出孤儿态，正常渲染内容。
  useEffect(() => {
    if (active) setOrphanId(null);
  }, [active]);

  // Listen for clicks on annotation markers anywhere in the editor surface.
  // 注册一次（close 是稳定的）：是否"当前有打开的批注"通过 activeIdRef 在
  // 回调内读取，无需随 activeId 变化重注册监听器。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      // Click inside the popover itself → keep open.
      if (cardRef.current && target && cardRef.current.contains(target)) return;
      const marker = target?.closest<HTMLElement>(ANNO_MARKER_SELECTOR);
      if (marker) {
        // Opening / moving between markers — swallow so the editor's own
        // footnote handling (if any) doesn't also fire.
        e.preventDefault();
        e.stopPropagation();
        const id = marker.getAttribute("data-label") ?? "";
        const rect = marker.getBoundingClientRect();
        // 代码行级批注：按当前内容重解行位并高亮；popover 贴第一个高亮行。
        // 解析失败（行内容被删等）或非代码批注 → 回退到 marker 旁定位。
        // v3.9.1：这里只信防抖列表条目（不做同步整篇解析——O(doc) 序列化
        // 会冻结主线程，把第一击的视觉反馈吞掉）；列表滞后由解析 effect
        // 渲染后补齐（含代码行高亮）。
        clearCodeLineHighlights();
        let initialPos: PlacePos | null = null;
        // 首击数据源：防抖列表优先；miss 时取侧栏跳转预解析的 handoff
        // （一次性，见 lib/annoHandoff.ts——v3.9.3：此前列表滞后会让代码
        // 行批注的跳转/高亮在首击全部落空）。绝不在 mousedown 内同步整篇
        // 解析（O(doc) 序列化会冻结主线程，吞掉第一击反馈）。
        const anno =
          annotationsRef.current.find((a) => a.id === id) ??
          takePendingJumpAnno(id) ??
          null;
        if (retryTimerRef.current != null) {
          window.clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
        setOrphanId(null);
        if (anno) {
          const lineEl = applyCodeLine(id, anno.codeLine);
          if (lineEl) {
            const r = lineEl.getBoundingClientRect();
            initialPos = { left: r.right + 8, top: r.top };
          }
        }
        setActiveId(id);
        setFallback(anno);
        annoEmit("popover.open", `打开 ${id}${anno ? "" : "（防抖列表未命中，走解析兜底）"}`, {
          data: { id, codeLine: !!anno?.codeLine },
        });
        // Re-derive position on next paint once we know the marker's viewport
        // position is current (it may shift right after a setValue re-render).
        // 首帧位置同样钳进 chrome 边界（layoutEffect 的 remeasure 会再精调）。
        const firstBounds = measureChromeBounds();
        const initial =
          initialPos ?? { left: rect.right + 8, top: rect.top };
        setPos({
          ...initial,
          top: clampTop(initial.top, cardRef.current?.offsetHeight ?? 160, firstBounds),
        });
        setEditing(false);
        return;
      }
      // Click anywhere else → close.
      if (activeIdRef.current) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && activeIdRef.current) close();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      if (retryTimerRef.current != null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [close, findLive, applyCodeLine]);

  /** 全量重测：锚点 rect + 视口附近徽章几何缓存（文档空间）+ chrome 边界。
   * 打开、切换徽章、编辑保存（layoutEpoch）、resize 时调用 —— 这些时刻徽章
   * 才可能整体移动。大文档只测视口 ±600px 内的徽章（见 viewportNearBlocks）。 */
  const remeasure = useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
    const anchor = anchorElement(id);
    if (!anchor) return;
    const scroller = document.querySelector<HTMLElement>(".mditor-editor-host");
    if (!scroller) return;
    const st = scroller.scrollTop;
    const bounds = measureChromeBounds();
    const others: CachedMarker[] = [];
    const nearBlocks = viewportNearBlocks(scroller);
    const pm = scroller.querySelector(".ProseMirror");
    document
      .querySelectorAll<HTMLElement>(ANNO_MARKER_SELECTOR)
      .forEach((el) => {
        if (el.getAttribute("data-label") === id) return;
        if (nearBlocks && pm) {
          const block = topBlockOf(el, pm);
          if (block && !nearBlocks.has(block)) return;
        }
        const r = el.getBoundingClientRect();
        // hidden definition blocks render zero-size rects at (0,0) — ignore them
        if (r.width === 0 && r.height === 0) return;
        others.push({
          left: r.left,
          right: r.right,
          docTop: r.top + st,
          docBottom: r.bottom + st,
        });
      });
    geomRef.current = { scroller, others, bounds };
    const rect = anchor.getBoundingClientRect();
    const boxes: PlaceBox[] = others.map((b) => ({
      left: b.left,
      right: b.right,
      top: b.docTop - st,
      bottom: b.docBottom - st,
    }));
    setPos(
      placeCard(
        rect,
        boxes,
        {
          w: cardRef.current?.offsetWidth ?? 304,
          h: cardRef.current?.offsetHeight ?? 160,
        },
        bounds
      )
    );
  }, []);

  // 打开 / 切换徽章 / 编辑保存 / 孤儿态翻转时定位一次（layout 阶段，卡片
  // 不闪出屏）。刻意不依赖 active?.content：流式精炼期间内容每 ~150ms 变化
  // 而徽章不动 —— 旧实现每帧全文档测量+强制布局正是“弹层跟着流式乱跳”的
  // 根源。编辑保存经 commitEdit 的 setLayoutEpoch 显式触发重测。
  useLayoutEffect(() => {
    if (!activeId) return;
    remeasure();
  }, [activeId, layoutEpoch, orphanId, remeasure]);

  // 打开期间：rAF 锚点跟随循环（B4，v3.9.3；v3.9.4 分支重构）。每帧只读
  // 激活锚点一个 getBoundingClientRect（开销恒定），位移 <1px 不做任何事：
  //  * 纯纵向位移（无论来源：滚动、盖章 inline 化、图片加载、content-visibility
  //    高度重估）→ 卡片算术平移 + chrome 钳位，绝不 remeasure —— 全量徽章
  //    测量在大文档上会强制离屏 content-visibility 块布局（此前滚动中任何
  //    非 scrollTop 成比的锚点位移都会掉进 remeasure 分支 = 滚动卡顿主源，
  //    且无钳位的算术平移把卡片送进标题栏/状态栏 = 「盖住上下栏」）；
  //  * 横向位移（侧栏/AI 面板拖拽只改 CSS 变量、无 resize 事件）→ 全量重测。
  // 关闭即停 rAF（零空闲开销）；window resize 仍显式重测。
  useEffect(() => {
    if (!activeId) return;
    let raf = 0;
    let last: { left: number; top: number } | null = null;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      annoCount("popover.follow.frame");
      const id = activeIdRef.current;
      if (!id) return;
      const anchor = anchorElement(id);
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      if (last) {
        const dx = Math.abs(rect.left - last.left);
        const dy = rect.top - last.top;
        if (dx < 1 && Math.abs(dy) < 1) return;
        if (dx < 1) {
          const bounds =
            geomRef.current?.bounds ?? {
              top: 8,
              bottom: window.innerHeight - 8,
            };
          const cardH = cardRef.current?.offsetHeight ?? 160;
          setPos((prev) =>
            prev ? { ...prev, top: clampTop(prev.top + dy, cardH, bounds) } : prev
          );
          annoCount("popover.follow.scroll");
        } else {
          remeasure();
          annoCount("popover.follow.remeasure");
        }
      } else {
        remeasure();
      }
      last = { left: rect.left, top: rect.top };
    };
    raf = requestAnimationFrame(tick);
    const onResize = () => remeasure();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [activeId, remeasure]);

  // Seed the textarea whenever we (re)enter edit mode.
  useEffect(() => {
    if (editing && active) setDraft(active.content);
  }, [editing, active]);

  if (!activeId) return null;

  const activeNum = /^anno-(\d+)$/.exec(activeId)?.[1] ?? "?";

  if (!active) {
    if (orphanId !== activeId) {
      // 第一击的加载壳（v3.9.1）：内容还没解析出来（防抖列表滞后 / 大文档
      // 同步解析要几十 ms）时立即渲染卡片骨架，而不是 60ms 空窗内毫无反馈
      // ——「要点两次」的观感来源之一。解析 effect 会把内容或孤儿态填进来。
      return (
        <div
          ref={cardRef}
          className="anno-popover"
          style={pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : undefined}
          role="dialog"
          aria-label="批注"
        >
          <div className="anno-popover-head">
            <span className="anno-popover-title">
              <AnnotationIcon size={12} className="anno-popover-title-icon" />
              批注 #{activeNum}
            </span>
            <button
              className="anno-popover-close"
              title="关闭"
              onMouseDown={(e) => e.preventDefault()}
              onClick={close}
            >
              <CloseIcon size={13} />
            </button>
          </div>
          <div className="anno-popover-body">
            <span className="anno-popover-empty">正在解析批注…</span>
          </div>
        </div>
      );
    }
    // 孤儿态：实时文档里找不到该批注的定义（重试窗口已过）——渲染缺失卡片
    // 而不是无声失败。最常见成因是旧版代码行批注的元数据前缀定义被解析丢弃。
    return (
      <div
        ref={cardRef}
        className="anno-popover orphan"
        style={pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : undefined}
        role="dialog"
        aria-label="批注"
      >
        <div className="anno-popover-head">
          <span className="anno-popover-title">
            <AnnotationIcon size={12} className="anno-popover-title-icon" />
            批注 #{activeNum}
          </span>
          <button
            className="anno-popover-close"
            title="关闭"
            onMouseDown={(e) => e.preventDefault()}
            onClick={close}
          >
            <CloseIcon size={13} />
          </button>
        </div>
        <div className="anno-popover-body">
          <span className="anno-popover-empty">
            批注内容缺失：定义未被解析或已损坏。可删除该残留标记。
          </span>
        </div>
        <div className="anno-popover-actions">
          <button
            className="anno-btn danger"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onDelete(activeId);
              close();
            }}
          >
            删除该标记
          </button>
        </div>
      </div>
    );
  }

  const commitEdit = () => {
    onUpdate(active.id, draft.trim());
    setEditing(false);
    // 保存走整篇 setValue，徽章可能移位：下一提交重测定位置。
    setLayoutEpoch((e) => e + 1);
  };

  return (
    <div
      ref={cardRef}
      className={`anno-popover${editing ? " editing" : ""}`}
      style={pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : undefined}
      role="dialog"
      aria-label="批注"
    >
      <div className="anno-popover-head">
        <span className="anno-popover-title">
          <AnnotationIcon size={12} className="anno-popover-title-icon" />
          批注 #{active.marker}
          {active.codeLine && (
            <span className="anno-popover-lines" title="批注锚定的代码行（随内容跟随）">
              代码 第 {active.codeLine.start}
              {active.codeLine.end > active.codeLine.start
                ? `–${active.codeLine.end}`
                : ""}{" "}
              行
            </span>
          )}
        </span>
        <button
          className="anno-popover-close"
          title="关闭"
          onMouseDown={(e) => e.preventDefault()}
          onClick={close}
        >
          <CloseIcon size={13} />
        </button>
      </div>
      {editing ? (
        <div className="anno-popover-body">
          <textarea
            className="anno-edit-area"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commitEdit();
              }
            }}
            placeholder="批注内容…"
          />
        </div>
      ) : (
        <div className="anno-popover-body">
          {active.content ? (
            <MarkdownText content={active.content} theme={theme} />
          ) : (
            <span className="anno-popover-empty">（空批注）</span>
          )}
        </div>
      )}
      <div className="anno-popover-actions">
        {editing ? (
          <>
            <button
              className="anno-btn primary"
              onMouseDown={(e) => e.preventDefault()}
              onClick={commitEdit}
            >
              保存 (Ctrl+Enter)
            </button>
            <button
              className="anno-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setEditing(false)}
            >
              取消
            </button>
          </>
        ) : (
          <>
            <button
              className="anno-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setEditing(true)}
            >
              编辑
            </button>
            <button
              className="anno-btn danger"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                void (async () => {
                  if (await confirmDialog("删除这条批注？")) {
                    onDelete(active.id);
                    close();
                  }
                })();
              }}
            >
              删除
            </button>
          </>
        )}
      </div>
    </div>
  );
});

/** Escape a value for safe use inside a CSS attribute selector. */
function cssEsc(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}
