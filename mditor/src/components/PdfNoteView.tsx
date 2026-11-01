// 多格式笔记（MF 轮）：PDF 应用内只读视图（M2，pdfjs）。
//
// 受控解析：pdfjs 在主文档渲染到受控容器，不执行文档内脚本（pdfjs 默认禁用
// PDF JavaScript，isEvalSupported 再显式关掉 eval 通路）。字节经
// fs.readFile 二进制通道直读（不走 asset URL，保留字节供转 MD 复用——
// docNote.readDocNoteBytes 单条缓存）。
//
// 性能预算（任务书 §八）：
//   * pdfjs 库与 worker 全部懒加载（动态 import 收在本模块，首屏 bundle
//     零增量）；worker 经 Vite ?url 产物以 module worker 注入
//     GlobalWorkerOptions.workerPort，CSP worker-src 'self' blob: 已放行
//     （tauriCspConfig.test.ts 钉死）；
//   * 可视窗口渲染（滚动区间 + 1.5 屏预渲染），canvas 页缓存上限 5 页 LRU；
//   * devicePixelRatio 上限 2（内存护栏）。
//
// 卸载纪律（对齐导出管线 AbortSignal）：组件卸载/路径切换/重载必须
// destroy 文档 + 取消进行中渲染任务（RenderTask.cancel），反复开关无泄漏。
//
// 已知取舍（任务书 §九）：未内嵌字体的 CJK PDF（依赖 CMap）可能出现字形
// 回退差异——与 Acrobat 的轻微差异可接受，不承诺像素级一致。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { getAdapter } from "../platform";
import { noteOpError } from "../lib/opDebug";
import { readDocNoteBytes } from "../lib/docNote";
import { loadPdfjs } from "../lib/pdfjsLazy";
import { ExpandIcon, PdfFileIcon, RefreshIcon } from "./icons";

// ---- 常量 / 类型 -------------------------------------------------------------

/** 缩放档位（50%–300%，任务书 §4.4）。 */
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
/** canvas 页缓存上限（LRU 淘汰，性能预算：渲染内存峰值 ≤ 300MB）。 */
const PAGE_CANVAS_CACHE = 5;
/** 页间距与滚动容器左右留白（CSS px）。 */
const PAGE_GAP = 12;
const PAGE_HPAD = 24;
/** 可视区间外的预渲染距离（屏高倍数——滚动方向-ahead 渲染）。 */
const PRELOAD_VIEWPORTS = 1.5;

interface PageSize {
  w: number;
  h: number;
}

/** pdfjs getOutline 条目的结构子集（dest 为名称字符串或显式目标数组）。 */
interface OutlineNode {
  title: string;
  dest: unknown;
  items?: OutlineNode[] | null;
}

interface Props {
  /** PDF 笔记磁盘绝对路径。 */
  path: string;
  /** 用系统应用打开（App 注入 openExternalNote 封装，稳定引用）。 */
  onOpenExternal: (path: string) => void;
  /** M3：转为 Markdown 笔记（不传则不显示按钮）。 */
  onConvertToMarkdown?: (path: string) => void;
  /** DE 轮：编辑态激活（App 按 TabItem.docEdit 注入）。 */
  editActive?: boolean;
  /** DE 轮：进入微编辑模式（门控 caps.docNoteEdit 内可见）。 */
  onEnterEdit?: (path: string) => void | Promise<void>;
  /** DE 轮：退出编辑（脏编辑时 App 侧确认；返回 false = 取消退出）。 */
  onExitEdit?: (path: string) => Promise<boolean> | void;
}

// ---- 单页（命令式 canvas：React 不管控其子树，避免 reconcile 冲突）-----------

interface PdfPageProps {
  doc: PDFDocumentProxy;
  index: number; // 1-based
  size: PageSize;
  scale: number;
  top: number;
  total: number;
  borrow: (index: number, scale: number) => HTMLCanvasElement | null;
  giveBack: (index: number, canvas: HTMLCanvasElement, scale: number) => void;
}

const PdfPage = memo(function PdfPage({
  doc,
  index,
  size,
  scale,
  top,
  total,
  borrow,
  giveBack,
}: PdfPageProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    const slot = slotRef.current;
    if (!slot) return;
    setBusy(true);
    void (async () => {
      try {
        // ① 缓存命中（同 scale）：直接搬入已渲染位图，零重渲染。
        const hit = borrow(index, scale);
        if (hit) {
          if (cancelled) {
            giveBack(index, hit, scale);
            return;
          }
          slot.appendChild(hit);
          canvasRef.current = hit;
          setBusy(false);
          return;
        }
        // ② 渲染新 canvas（devicePixelRatio 感知，上限 2）。
        const page = await doc.getPage(index);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = document.createElement("canvas");
        canvas.className = "pdf-canvas";
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx || slotRef.current == null) return;
        const t = page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        task = t;
        await t.promise;
        if (cancelled) {
          canvas.width = 0; // 释放位图
          return;
        }
        slot.appendChild(canvas);
        canvasRef.current = canvas;
        setBusy(false);
      } catch {
        // RenderTask cancel 走 RenderingCancelledException——静默；
        // 真实渲染错误交给上层错误态（doc 级）。
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      const c = canvasRef.current;
      if (c) {
        c.remove();
        canvasRef.current = null;
        if (c.width > 0) giveBack(index, c, scale); // 归还缓存（LRU 淘汰）
      }
    };
  }, [doc, index, scale, borrow, giveBack]);

  return (
    <div
      ref={slotRef}
      className="pdf-page-slot"
      style={{
        top,
        width: Math.floor(size.w * scale),
        height: Math.floor(size.h * scale),
      }}
    >
      {busy && <span className="pdf-page-loading">…</span>}
      <span className="pdf-page-num">
        {index} / {total}
      </span>
    </div>
  );
});

// ---- 大纲树 -------------------------------------------------------------------

interface OutlineTreeProps {
  nodes: OutlineNode[];
  depth: number;
  onJump: (node: OutlineNode) => void;
}

const OutlineTree = memo(function OutlineTree({ nodes, depth, onJump }: OutlineTreeProps) {
  return (
    <ul className="pdf-outline-list">
      {nodes.map((n, i) => (
        <li key={i}>
          <button
            className="pdf-outline-item"
            style={{ paddingLeft: 8 + Math.min(depth, 6) * 12 }}
            title={n.title}
            onClick={() => onJump(n)}
          >
            {n.title || "(无标题)"}
          </button>
          {n.items && n.items.length > 0 && (
            <OutlineTree nodes={n.items} depth={depth + 1} onJump={onJump} />
          )}
        </li>
      ))}
    </ul>
  );
});

// ---- 主视图 -------------------------------------------------------------------

export const PdfNoteView = memo(function PdfNoteView({
  path,
  onOpenExternal,
  onConvertToMarkdown,
  editActive,
  onEnterEdit,
  onExitEdit,
}: Props) {
  const caps = getAdapter().capabilities;
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorKind, setErrorKind] = useState<"encrypted" | "corrupt" | "generic" | null>(null);
  const [missing, setMissing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[] | null>(null);
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [currentPage, setCurrentPage] = useState(1);
  const [visibleRange, setVisibleRange] = useState<[number, number]>([0, 0]);
  const [containerW, setContainerW] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const anchorRef = useRef(1);
  // canvas 页缓存（LRU 5 页）：可视区外卸载的页归还位图，滚回时零重渲染。
  const canvasesRef = useRef(new Map<number, { canvas: HTMLCanvasElement; scale: number }>());
  const lruRef = useRef<number[]>([]);

  // 文件存在性探测：对齐 HtmlNoteView 的 missing 探测（视图对「文件被移动/
  // 删除」给出明确错误态，而非静默空白）。
  useEffect(() => {
    let alive = true;
    setMissing(false);
    getAdapter()
      .fs.exists(path)
      .then((ok) => {
        if (alive) setMissing(!ok);
      })
      .catch(() => {
        /* 探测失败不拦渲染，交给加载错误态 */
      });
    return () => {
      alive = false;
    };
  }, [path, reloadKey]);

  // 文档加载（path / reloadKey 驱动）。bytes 经 docNote 单条缓存（转 MD 复用）；
  // getDocument 会 transfer ArrayBuffer——必须传 bytes.slice() 副本。
  useEffect(() => {
    if (!caps.pdfNoteView) return;
    let cancelled = false;
    let task: { destroy(): Promise<void> } | null = null;
    setStatus("loading");
    setErrorKind(null);
    setDoc(null);
    setSizes(null);
    setOutline(null);
    setCurrentPage(1);
    anchorRef.current = 1;
    docRef.current = null;
    canvasesRef.current.clear();
    lruRef.current = [];
    void (async () => {
      try {
        const bytes = await readDocNoteBytes(path, reloadKey > 0);
        const pdfjs = await loadPdfjs();
        if (cancelled) return;
        // pdfjs v6 已整体移除 eval 通路（isEvalSupported 参数不复存在），
        // 文档内脚本默认禁用——受控解析的安全前提由库自身保证。
        const t = pdfjs.getDocument({ data: bytes.slice() });
        task = t;
        const d = await t.promise;
        if (cancelled) return; // cleanup 的 destroy 已收尾
        const arr: PageSize[] = [];
        for (let i = 1; i <= d.numPages; i++) {
          const p = await d.getPage(i);
          const vp = p.getViewport({ scale: 1 });
          arr.push({ w: vp.width, h: vp.height });
          if (cancelled) return;
        }
        const ol = (await d.getOutline().catch(() => null)) as OutlineNode[] | null;
        if (cancelled) return;
        docRef.current = d;
        setDoc(d);
        setSizes(arr);
        setOutline(ol && ol.length > 0 ? ol : null);
        setOutlineOpen(!!(ol && ol.length > 0));
        setStatus("ready");
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
      } catch (e) {
        if (cancelled) return;
        const name = (e as { name?: string } | null)?.name ?? "";
        if (name === "PasswordException") setErrorKind("encrypted");
        else if (name === "InvalidPDFException") setErrorKind("corrupt");
        else {
          setErrorKind("generic");
          noteOpError("pdf-note-open", e);
        }
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      docRef.current = null;
      void task?.destroy().catch(() => undefined);
    };
  }, [path, reloadKey, caps.pdfNoteView]);

  // 容器宽度（适宽缩放 + 槽位尺寸依赖）。ResizeObserver 而非 window resize
  // ——侧栏开合/分隔条拖动同样影响宽度。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setContainerW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 布局推导：fit 模式按各页自身宽度适配容器（跨页宽差异各自铺满）；数值
  // 缩放统一 scale。tops 为累积偏移（绝对定位槽位免布局抖动）。
  const layout = useMemo(() => {
    if (!sizes || containerW <= 0) return null;
    const fitScale = (s: PageSize) => (containerW - PAGE_HPAD * 2) / s.w;
    const scaleFor = (i: number) => (zoom === "fit" ? fitScale(sizes[i]) : zoom);
    const heights = sizes.map((s, i) => Math.floor(s.h * scaleFor(i)));
    const tops: number[] = [];
    let acc = PAGE_GAP;
    for (const h of heights) {
      tops.push(acc);
      acc += h + PAGE_GAP;
    }
    return { heights, tops, total: acc, scaleFor };
  }, [sizes, zoom, containerW]);

  // 当前有效缩放（顶栏百分比显示用：fit 取第 1 页的等效值）。
  const effScale = useMemo(() => {
    if (!layout || !sizes) return 1;
    return zoom === "fit" ? layout.scaleFor(0) : zoom;
  }, [layout, sizes, zoom]);

  // 滚动 → 当前页码 + 可视区间（rAF 合并；数值全是已知的累积偏移，无需
  // N 个 IntersectionObserver）。
  const updateViewport = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !layout) return;
    const { tops, heights } = layout;
    const y = el.scrollTop;
    const h = el.clientHeight;
    const preload = h * PRELOAD_VIEWPORTS;
    let cur = 1;
    let first = 0;
    let last = tops.length - 1;
    for (let i = 0; i < tops.length; i++) {
      if (tops[i] <= y + h * 0.35) cur = i + 1;
      if (tops[i] + heights[i] >= y - preload) {
        first = i;
        break;
      }
    }
    for (let i = tops.length - 1; i >= 0; i--) {
      if (tops[i] <= y + h + preload) {
        last = i;
        break;
      }
    }
    if (cur < 1) cur = 1;
    setCurrentPage((c) => (c === cur ? c : cur));
    setVisibleRange((r) => (r[0] === first && r[1] === last ? r : [first, last]));
  }, [layout]);

  useEffect(() => {
    // 布局就绪/变更后立即算一次（不等首个滚动事件）。
    updateViewport();
  }, [updateViewport]);

  // 缩放/容器宽变化：锚定当前页（顶边对齐），避免视口跳回第 1 页。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !layout) return;
    const raf = requestAnimationFrame(() => {
      if (anchorRef.current > 1) {
        el.scrollTop = layout.tops[anchorRef.current - 1] - PAGE_GAP;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [layout]);

  useEffect(() => {
    anchorRef.current = currentPage;
  }, [currentPage]);

  // ---- canvas 缓存治理 ------------------------------------------------------

  const borrow = useCallback((index: number, scale: number) => {
    const e = canvasesRef.current.get(index);
    canvasesRef.current.delete(index);
    lruRef.current = lruRef.current.filter((x) => x !== index);
    return e && e.scale === scale ? e.canvas : null;
  }, []);

  const giveBack = useCallback((index: number, canvas: HTMLCanvasElement, scale: number) => {
    canvasesRef.current.set(index, { canvas, scale });
    lruRef.current.push(index);
    while (canvasesRef.current.size > PAGE_CANVAS_CACHE) {
      const evict = lruRef.current.shift();
      if (evict === undefined) break;
      const e = canvasesRef.current.get(evict);
      if (e) e.canvas.width = 0; // 立即释放位图内存
      canvasesRef.current.delete(evict);
    }
  }, []);

  // ---- 交互 ----------------------------------------------------------------

  const scrollToPage = useCallback(
    (n: number) => {
      const el = scrollRef.current;
      if (!el || !layout) return;
      const i = Math.min(Math.max(n, 1), layout.tops.length) - 1;
      el.scrollTop = layout.tops[i] - PAGE_GAP;
      setCurrentPage(i + 1);
    },
    [layout]
  );

  const jumpToOutline = useCallback(async (node: OutlineNode) => {
    const d = docRef.current;
    if (!d) return;
    try {
      let dest = node.dest;
      if (typeof dest === "string") dest = await d.getDestination(dest);
      if (!Array.isArray(dest) || !dest[0]) return;
      const idx = await d.getPageIndex(dest[0] as never);
      scrollToPage(idx + 1);
    } catch (e) {
      noteOpError("pdf-outline-jump", e);
    }
  }, [scrollToPage]);

  const zoomIn = useCallback(() => {
    setZoom((z) => {
      const eff = z === "fit" ? effScale : z;
      return ZOOM_STEPS.find((s) => s > eff + 0.01) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
    });
  }, [effScale]);

  const zoomOut = useCallback(() => {
    setZoom((z) => {
      const eff = z === "fit" ? effScale : z;
      return [...ZOOM_STEPS].reverse().find((s) => s < eff - 0.01) ?? ZOOM_STEPS[0];
    });
  }, [effScale]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // ---- 降级 / 错误 / 缺失态 ---------------------------------------------------

  if (!caps.pdfNoteView) {
    return (
      <div className="doc-note-view is-degraded">
        <PdfFileIcon size={28} />
        <p className="doc-note-title">{path}</p>
        <p>当前平台暂不支持应用内预览 PDF（预览能力待真机验证）。</p>
        <button className="doc-note-btn" onClick={() => onOpenExternal(path)}>
          用系统应用打开
        </button>
      </div>
    );
  }

  if (missing) {
    return (
      <div className="doc-note-view is-degraded">
        <PdfFileIcon size={28} />
        <p className="doc-note-title">{path}</p>
        <p>文件不存在或已被移动。</p>
        <button className="doc-note-btn" onClick={() => onOpenExternal(path)}>
          用系统应用打开
        </button>
      </div>
    );
  }

  if (status === "error") {
    const msg =
      errorKind === "encrypted"
        ? "该 PDF 已加密，暂不支持在应用内打开。"
        : errorKind === "corrupt"
          ? "文件损坏或不是有效的 PDF。"
          : "打开 PDF 失败。";
    return (
      <div className="doc-note-view is-degraded">
        <PdfFileIcon size={28} />
        <p className="doc-note-title">{path}</p>
        <p>{msg}</p>
        <div className="doc-note-actions">
          <button className="doc-note-btn" onClick={reload}>
            重试
          </button>
          <button className="doc-note-btn" onClick={() => onOpenExternal(path)}>
            用系统应用打开
          </button>
        </div>
      </div>
    );
  }

  const numPages = sizes?.length ?? 0;

  return (
    <div className="doc-note-view pdf-note-view">
      <div className="doc-note-bar">
        <PdfFileIcon size={14} className="doc-note-bar-icon" />
        <span className="doc-note-path" title={path}>
          {path}
        </span>
        <span className="pdf-note-pageref">
          {currentPage} / {numPages || "…"}
        </span>
        <button className="doc-note-btn" title="缩小" onClick={zoomOut} disabled={!layout}>
          −
        </button>
        <span className="pdf-note-zoomval" title="当前缩放">
          {zoom === "fit" ? "适宽" : `${Math.round(zoom * 100)}%`}
        </span>
        <button className="doc-note-btn" title="放大" onClick={zoomIn} disabled={!layout}>
          ＋
        </button>
        <button
          className={`doc-note-btn${zoom === "fit" ? " is-active" : ""}`}
          title="适配宽度"
          onClick={() => setZoom("fit")}
          disabled={!layout}
        >
          适宽
        </button>
        {outline && (
          <button
            className={`doc-note-btn${outlineOpen ? " is-active" : ""}`}
            title="大纲（书签）"
            onClick={() => setOutlineOpen((v) => !v)}
          >
            大纲
          </button>
        )}
        <button className="doc-note-btn" title="重新加载" onClick={reload}>
          <RefreshIcon size={13} />
        </button>
        {editActive ? (
          <span className="pdf-note-zoomval doc-note-hint" title="微编辑模式">
            微编辑（占位——行级编辑随 M3 交付）
          </span>
        ) : null}
        {editActive ? (
          <button
            className="doc-note-btn"
            title="退出微编辑（未保存的修改将丢弃，需确认）"
            onClick={() => void onExitEdit?.(path)}
          >
            退出编辑
          </button>
        ) : (
          caps.docNoteEdit &&
          onEnterEdit && (
            <button
              className="doc-note-btn"
              title="进入微编辑模式（行级文本替换；未编辑内容保存后原样保留）"
              onClick={() => void onEnterEdit(path)}
            >
              编辑
            </button>
          )
        )}
        {onConvertToMarkdown && (
          <button
            className="doc-note-btn"
            title="转为 Markdown 笔记（提取纯文本；排版/图片丢失）"
            onClick={() => onConvertToMarkdown(path)}
          >
            转 Markdown
          </button>
        )}
        <button className="doc-note-btn" title="用系统应用打开" onClick={() => onOpenExternal(path)}>
          <ExpandIcon size={13} />
        </button>
      </div>
      <div className="pdf-note-main">
        {outlineOpen && outline && (
          <aside className="pdf-outline" role="navigation" aria-label="PDF 大纲">
            <OutlineTree nodes={outline} depth={0} onJump={(n) => void jumpToOutline(n)} />
          </aside>
        )}
        <div
          ref={scrollRef}
          className="pdf-scroll"
          onScroll={() => requestAnimationFrame(updateViewport)}
        >
          {layout && doc && sizes && (
            <div className="pdf-pages" style={{ height: layout.total }}>
              {(() => {
                const slots = [];
                const [first, last] = visibleRange;
                for (let i = first; i <= last && i < sizes.length; i++) {
                  slots.push(
                    <PdfPage
                      key={i}
                      index={i + 1}
                      doc={doc}
                      size={sizes[i]}
                      scale={layout.scaleFor(i)}
                      top={layout.tops[i]}
                      total={sizes.length}
                      borrow={borrow}
                      giveBack={giveBack}
                    />
                  );
                }
                return slots;
              })()}
            </div>
          )}
        </div>
        {status === "loading" && (
          <div className="pdf-note-overlay">
            <span className="pdf-note-spinner" aria-hidden="true" />
            加载中…
          </div>
        )}
      </div>
      {status === "ready" && numPages > 0 && (
        <div className="pdf-page-badge" aria-hidden="true">
          {currentPage} / {numPages}
        </div>
      )}
    </div>
  );
});
