// 自研打印对话框（PI2 轮核心交付物）：应用内完成「设置 → 分页预览 → 打印」
// 全流程，不经任何外部程序。
//
//  * 排版：md/docx/html 经 buildPrintPdfBytes（自研 PDF 管线，纸张/方向/
//    边距改动即防抖重排）；pdf 原文件零转码直入预览。
//  * 预览：pdf.js 逐页 canvas（可视渲染 + LRU 页缓存，借 PdfNoteView 的
//    dpr 感知/取消清理惯用法），所见即所打（打印页由同一 doc 光栅化）。
//  * 打印：runPrintJob（pdf.js 按所选 DPI 逐页 PNG → Rust GDI 直打）；
//    取消双语义：渲染阶段即时中止，打印阶段页边界收场。
//  * 附件能力：「保存 PDF…」= 当前预览 PDF 直存（pdf kind 下即原文件副本）。
//  * 偏好记忆：纸张/方向/边距/打印机经 onPrefsChange 回写 settings.printPrefs。
//
// 样式自足（组件级 <style>，printdlg- 前缀，不依赖全局 CSS/主题变量）——
// 预览纸面恒浅色（纸是白的，所见即所得），对话框铬部中性双色（明暗主题
// 均可读）。动效对齐全仓体系：--dur-*/--ease-* 变量 + modal 进出场曲线
// （--dur-base 进 / --dur-exit 出）、「无」档与 prefers-reduced-motion 由
// global.css 的通配 kill switch 压为瞬时（组件无需自理）、lively 档增强
// 以 html[data-motion="lively"] 前缀惰性承载（侧栏字段级联 + sheet 曲线）。

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadPdfjs } from "../lib/pdfjsLazy";
import {
  buildDocxPrintContext,
  buildHtmlPrintContext,
  buildPrintPdfBytes,
  listPrinters,
  parsePageRange,
  printDpiOf,
  readPdfPrintBytes,
  runPrintJob,
  PRINT_DPI_CHOICES,
  type PrintDpiId,
  type PrintKind,
  type PrintOrientation,
  type PrintSource,
  type PrinterInfoDto,
} from "../lib/printJob";
import {
  PDF_PAPERS,
  PDF_MARGIN_CHOICES,
  type PdfExportProgress,
  type PdfPaperId,
} from "../lib/exportPdfPipeline";
import { formatMissingImages, type ExportContext } from "../lib/exporter";
import { getAdapter } from "../platform";
import type { PrintPrefs } from "../types";

// ---- 小工具 -----------------------------------------------------------------

/** 管线阶段 → 预览区文案（App.pdfStageView 的对话框内简化版）。 */
function stageLabel(p: PdfExportProgress): string {
  switch (p.stage) {
    case "factory":
      return `渲染文档结构…（${p.done}/${p.total}）`;
    case "measure":
      return "测量内容块…";
    case "paginate":
      return "分页…";
    case "text":
      return "编排文本层…";
    case "raster":
      return `整页渲染…（${p.done}/${p.total}）`;
    case "assemble":
      return "生成 PDF…";
    default:
      return "正在排版…";
  }
}

const KIND_LABEL: Record<PrintKind, string> = {
  md: "Markdown",
  docx: "Word（版式按 mditor 样式）",
  html: "网页（应用内重排版）",
  pdf: "PDF（原文件）",
};

// ---- 预览页（命令式 canvas；React 不管控其子树）--------------------------------

const PAGE_CACHE_LIMIT = 12;

interface PreviewPageProps {
  doc: PDFDocumentProxy;
  index: number;
  widthPt: number;
  heightPt: number;
  displayWidth: number;
  cache: MutableRefObject<Map<number, HTMLCanvasElement>>;
}

const PreviewPage = memo(function PreviewPage({
  doc,
  index,
  widthPt,
  heightPt,
  displayWidth,
  cache,
}: PreviewPageProps) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const height = Math.max(1, Math.round((displayWidth * heightPt) / widthPt));

  useEffect(() => {
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    let io: IntersectionObserver | null = null;
    const start = (): void => {
      void (async () => {
        const slot = slotRef.current;
        if (!slot || cancelled) return;
        // ① 缓存命中：LRU touch 后直接搬入。
        const cached = cache.current.get(index);
        if (cached) {
          cache.current.delete(index);
          cache.current.set(index, cached);
          if (!cancelled && slotRef.current) {
            slotRef.current.textContent = "";
            slotRef.current.appendChild(cached);
          }
          return;
        }
        try {
          // ② 渲染（dpr 感知，上限 2——PdfNoteView 同款）。
          const page = await doc.getPage(index);
          if (cancelled) return;
          const scale = displayWidth / widthPt;
          const viewport = page.getViewport({ scale });
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
          canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
          canvas.style.width = `${Math.max(1, Math.floor(viewport.width))}px`;
          canvas.style.height = `${Math.max(1, Math.floor(viewport.height))}px`;
          const ctx = canvas.getContext("2d", { alpha: false });
          if (!ctx || cancelled) return;
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
          // ③ LRU 逐出（仍挂在 DOM 的不清零——等其组件卸载随 DOM 回收）。
          while (cache.current.size >= PAGE_CACHE_LIMIT) {
            const oldest = cache.current.keys().next().value as number | undefined;
            if (oldest === undefined) break;
            const c = cache.current.get(oldest);
            cache.current.delete(oldest);
            if (c && !c.isConnected) c.width = 0;
          }
          cache.current.set(index, canvas);
          if (slotRef.current) {
            slotRef.current.textContent = "";
            slotRef.current.appendChild(canvas);
          }
        } catch {
          // RenderTask cancel 静默；真实失败保留灰面占位（doc 级错误另有态）。
        }
      })();
    };
    const slot = slotRef.current;
    if (slot) {
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            io?.disconnect();
            start();
          }
        },
        { rootMargin: "800px" }
      );
      io.observe(slot);
    }
    return () => {
      cancelled = true;
      task?.cancel();
      io?.disconnect();
    };
  }, [doc, index, displayWidth, widthPt, heightPt, cache]);

  return (
    <div className="printdlg-page" style={{ width: displayWidth, height }}>
      <div ref={slotRef} className="printdlg-page-slot" style={{ height }} />
      <span className="printdlg-page-num">{index}</span>
    </div>
  );
});

// ---- 对话框主体 ---------------------------------------------------------------

export interface PrintDialogRequest {
  kind: PrintKind;
  /** 文档名（去扩展名；作业目录/保存 PDF 建议名）。 */
  stem: string;
  /** html/pdf/docx 原文件路径（md 可为 null）。 */
  path: string | null;
  /** kind=md 的内容源（App 的 buildExportContext——与导出同序的预处理）。 */
  mdContextProvider?: (() => Promise<ExportContext | null>) | null;
}

export interface PrintDialogProps {
  request: PrintDialogRequest;
  onClose: () => void;
  prefs: PrintPrefs;
  onPrefsChange: (p: PrintPrefs) => void;
  flashStatus?: (msg: string, ms?: number) => void;
  showAlert?: (
    content: string,
    title?: string,
    icon?: "info" | "warning" | "error"
  ) => void;
}

type Phase =
  | { s: "prepare"; note: string }
  | { s: "ready" }
  | { s: "failed"; error: string }
  | { s: "printing"; stage: "render" | "print"; done: number; total: number };

interface PageSizes {
  numPages: number;
  sizes: { w: number; h: number }[];
}

export function PrintDialog({
  request,
  onClose,
  prefs,
  onPrefsChange,
  flashStatus,
  showAlert,
}: PrintDialogProps) {
  const isPdfKind = request.kind === "pdf";

  const [phase, setPhase] = useState<Phase>({
    s: "prepare",
    note: "正在准备打印内容…",
  });
  const [reformatting, setReformatting] = useState(false);
  const [docMeta, setDocMeta] = useState<PageSizes | null>(null);

  const [printers, setPrinters] = useState<PrinterInfoDto[]>([]);
  const [printersError, setPrintersError] = useState<string | null>(null);
  const [printersLoading, setPrintersLoading] = useState(true);
  const [printer, setPrinter] = useState(prefs.lastPrinter ?? "");

  const [paper, setPaper] = useState<PdfPaperId>(prefs.paper);
  const [orientation, setOrientation] = useState<PrintOrientation>(prefs.orientation);
  const [marginMm, setMarginMm] = useState<number>(prefs.marginMm);
  const [dpiId, setDpiId] = useState<PrintDpiId>("high");
  const [copies, setCopies] = useState(1);
  const [rangeMode, setRangeMode] = useState<"all" | "custom">("all");
  const [rangeInput, setRangeInput] = useState("");

  const [previewWidth, setPreviewWidth] = useState(520);
  /** 退场动画中（播完 var(--dur-exit) 再卸载；防重入）。 */
  const [closing, setClosing] = useState(false);
  /** 对话框内提示条（矢量回退/远程样式跳过等）：flashStatus 是 App 底部
   *  状态栏，本对话框是全屏 modal，直接借用等于把提示打进用户看不到的
   *  地方（铁律 5 精神）。 */
  const [notices, setNotices] = useState<string[]>([]);
  const pushNotice = useCallback((msg: string): void => {
    setNotices((cur) => (cur.includes(msg) ? cur : [...cur, msg].slice(-3)));
  }, []);

  const sourceRef = useRef<PrintSource | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  /** getDocument 的 loadingTask——pdfjs v6 的 destroy 在 task 上（销毁 doc +
   *  终止 worker 通信；PdfNoteView 同款结构类型）。 */
  const docTaskRef = useRef<{ destroy(): Promise<void> } | null>(null);
  const bytesRef = useRef<Uint8Array | null>(null);
  const cacheRef = useRef(new Map<number, HTMLCanvasElement>());
  /** 预览文档换代计数（PreviewPage key 的代际段：换代即重挂页卡，杜绝旧
   *  canvas/IntersectionObserver 残留跨文档复用）。 */
  const docGenRef = useRef(0);
  const layoutAbortRef = useRef<AbortController | null>(null);
  /** 重排防抖定时器（doPrintAction 接管排版时清掉未触发的那次）。 */
  const reformatTimerRef = useRef<number | null>(null);
  const printAbortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const displayWidth = Math.max(200, Math.min(previewWidth, 620));

  // -- 排版 + 加载预览（首次与参数重排共用；signal 取消则产物就地销毁）------
  const runLayout = useCallback(
    async (
      o: { paper: PdfPaperId; orientation: PrintOrientation; marginMm: number },
      signal: AbortSignal
    ): Promise<void> => {
      const source = sourceRef.current;
      // 源缺失（首次源准备即失败后用户改参数重试）：显式失败而非静默返回
      // ——否则 .then 会把 phase 置成「ready」而预览区永远空白。
      if (!source) throw new Error("打印内容源尚未就绪（请关闭后重新打开打印）");
      const artifact = await buildPrintPdfBytes(source, {
        paper: o.paper,
        orientation: o.orientation,
        marginMm: o.marginMm,
        signal,
        onProgress: (p) => {
          if (!signal.aborted && aliveRef.current) {
            setPhase({ s: "prepare", note: stageLabel(p) });
          }
        },
        title: request.stem,
      });
      if (signal.aborted) return;
      const pdfjs = await loadPdfjs();
      const task = pdfjs.getDocument({ data: artifact.bytes.slice() });
      const doc = await task.promise;
      if (signal.aborted) {
        void task.destroy();
        return;
      }
      // 页尺寸（占位比例 + 渲染 scale 基准；pdfjs page dict 缓存，开销可控）。
      // view 是 [x0,y0,x1,y1]——取宽高差而非右/上坐标：CropBox 原点非零的
      // 外来 PDF（自产 PDF 恒 0）否则占位比例失真。
      const sizes: { w: number; h: number }[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const pg = await doc.getPage(i);
        sizes.push({ w: pg.view[2] - pg.view[0], h: pg.view[3] - pg.view[1] });
        if (signal.aborted) break;
      }
      if (signal.aborted) {
        void task.destroy();
        return;
      }
      // 换代：清页缓存（旧位图不在 DOM 的立即释放）、销毁旧 doc。
      cacheRef.current.forEach((c) => {
        if (!c.isConnected) c.width = 0;
      });
      cacheRef.current.clear();
      void docTaskRef.current?.destroy();
      docTaskRef.current = task;
      docRef.current = doc;
      docGenRef.current += 1;
      bytesRef.current = artifact.bytes;
      if (aliveRef.current) setDocMeta({ numPages: doc.numPages, sizes });
      // C2 列报 + 矢量回退告知（与导出同语义；铁律 5）。
      if (artifact.missing.length > 0 && aliveRef.current) {
        showAlert?.(formatMissingImages(artifact.missing), "打印图片清单", "warning");
      }
      const fb = artifact.meta?.vectorFallback;
      if (typeof fb === "string" && fb && aliveRef.current) {
        pushNotice(`矢量导出失败，已自动回退位图模式完成（${fb.slice(0, 80)}）`);
      }
    },
    [request.stem, showAlert, pushNotice]
  );

  // -- 挂载：内容源准备 → 首次排版（一次性；卸载 abort + destroy）------------
  useEffect(() => {
    aliveRef.current = true;
    const ctrl = new AbortController();
    layoutAbortRef.current = ctrl;
    const initial = { paper, orientation, marginMm };
    void (async () => {
      try {
        let source: PrintSource;
        if (request.kind === "md") {
          const ctx = request.mdContextProvider
            ? await request.mdContextProvider()
            : null;
          if (!ctx) throw new Error("无法获取文档内容（文档尚未就绪）");
          source = { kind: "md", ctx };
        } else if (request.kind === "docx") {
          if (!request.path) throw new Error("Word 标签缺少源文件路径");
          if (aliveRef.current) setPhase({ s: "prepare", note: "正在解析 Word 文档…" });
          source = { kind: "docx", ctx: await buildDocxPrintContext(request.path) };
        } else if (request.kind === "html") {
          if (!request.path) throw new Error("HTML 标签缺少源文件路径");
          if (aliveRef.current) setPhase({ s: "prepare", note: "正在解析网页…" });
          const ctx = await buildHtmlPrintContext(request.path);
          if (ctx.skippedRemoteStyles > 0 && aliveRef.current) {
            pushNotice(`已跳过 ${ctx.skippedRemoteStyles} 个远程样式表（应用内打印不联网取样式）`);
          }
          if (ctx.skippedCssAssets > 0 && aliveRef.current) {
            pushNotice(`有 ${ctx.skippedCssAssets} 个样式资源（背景图/字体）读取失败，未进入打印件`);
          }
          source = { kind: "html", ctx };
        } else {
          if (!request.path) throw new Error("PDF 标签缺少源文件路径");
          if (aliveRef.current) setPhase({ s: "prepare", note: "正在读取 PDF…" });
          source = { kind: "pdf", bytes: await readPdfPrintBytes(request.path) };
        }
        if (ctrl.signal.aborted) return;
        sourceRef.current = source;
        await runLayout(initial, ctrl.signal);
        if (!ctrl.signal.aborted && aliveRef.current) setPhase({ s: "ready" });
      } catch (e) {
        if (ctrl.signal.aborted) return;
        if (aliveRef.current) setPhase({ s: "failed", error: String(e) });
      }
    })();
    return () => {
      aliveRef.current = false;
      ctrl.abort();
      // 中止在途重排（可能是防抖后替换的新 ctrl——初始 ctrl 早已完成）：否则
      // runLayout 跑完全程后把新 pdfjs 文档写回 docTaskRef，而本 cleanup 的
      // destroy 已执行过——该文档永远无人销毁（worker 端泄漏到窗口关闭）。
      layoutAbortRef.current?.abort();
      if (reformatTimerRef.current !== null) {
        clearTimeout(reformatTimerRef.current);
        reformatTimerRef.current = null;
      }
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
      void docTaskRef.current?.destroy();
      docTaskRef.current = null;
      docRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- 参数变化 → 防抖重排（pdf kind 无参数重排；旧预览保留可见）------------
  const firstLayoutRef = useRef(true);
  useEffect(() => {
    if (firstLayoutRef.current) {
      firstLayoutRef.current = false;
      return;
    }
    if (isPdfKind) return;
    const t = window.setTimeout(() => {
      reformatTimerRef.current = null;
      const prev = layoutAbortRef.current;
      prev?.abort();
      const ctrl = new AbortController();
      layoutAbortRef.current = ctrl;
      // failed 态也允许参数变更重试：排版失败多为环境性（瞬时 IO/渲染工厂
      // 抖动），改纸张/边距即重排比逼用户关掉重开友好。
      setPhase((p) =>
        p.s === "failed" ? { s: "prepare", note: "正在按新设置重新排版…" } : p
      );
      setReformatting(true);
      void runLayout({ paper, orientation, marginMm }, ctrl.signal)
        .then(() => {
          if (!ctrl.signal.aborted && aliveRef.current) setPhase({ s: "ready" });
        })
        .catch((e) => {
          if (!ctrl.signal.aborted && aliveRef.current) {
            setPhase({ s: "failed", error: String(e) });
          }
        })
        .finally(() => {
          // 复位条件：未被更新的排版接替时才复位（被打印接管的 abort，或正常
          // 完成）；被新一次重排接替则由接替者持有该标志。
          if (
            aliveRef.current &&
            (layoutAbortRef.current === ctrl || !ctrl.signal.aborted)
          ) {
            setReformatting(false);
          }
        });
    }, 500);
    reformatTimerRef.current = t;
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper, orientation, marginMm]);

  // -- 偏好回写（参数/打印机变化即记忆；pdf kind 不记忆纸张族）--------------
  // 首帧跳过（firstLayoutRef 同款惯用法）：挂载即执行的那次值与 prefs 完全
  // 相同，纯无效写盘 + 全窗口 settings-changed 广播；且 refreshPrinters 把
  // printer 从空回落为默认打印机的那次回写，会把 lastPrinter 记忆静默改成
  // 用户从未选过的打印机。
  const firstPrefsRef = useRef(true);
  useEffect(() => {
    if (isPdfKind) return;
    if (firstPrefsRef.current) {
      firstPrefsRef.current = false;
      return;
    }
    onPrefsChange({ paper, orientation, marginMm, lastPrinter: printer || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper, orientation, marginMm, printer]);

  // -- 打印机枚举（打开时 + 手动刷新）----------------------------------------
  const refreshPrinters = useCallback(async (): Promise<void> => {
    setPrintersLoading(true);
    setPrintersError(null);
    try {
      const list = await listPrinters();
      if (!aliveRef.current) return;
      setPrinters(list);
      setPrinter((cur) => {
        if (cur && list.some((p) => p.name === cur)) return cur;
        return list.find((p) => p.isDefault)?.name ?? list[0]?.name ?? "";
      });
    } catch (e) {
      if (aliveRef.current) setPrintersError(String(e));
    } finally {
      if (aliveRef.current) setPrintersLoading(false);
    }
  }, []);
  useEffect(() => {
    void refreshPrinters();
  }, [refreshPrinters]);

  // -- 预览容器宽度（页卡片渲染宽；变化清页缓存）-----------------------------
  useEffect(() => {
    const el = previewScrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = Math.floor(el.clientWidth - 48);
      if (w > 100) setPreviewWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    // 宽度变化：旧缓存位图尺寸不匹配，立即释放重渲染。
    cacheRef.current.forEach((c) => {
      if (!c.isConnected) c.width = 0;
    });
    cacheRef.current.clear();
  }, [displayWidth]);

  // -- 关闭（先播退场动画再卸载；printing 中 = 同时请求取消作业）----------------
  const beginClose = useCallback((): void => {
    if (closing) return;
    setClosing(true);
    // 退场 var(--dur-exit)（160ms）+ 余量播完再交 App 卸载；kill switch 下
    // 动画被压为瞬时，此延迟同样无害（等待窗口恒小于测试 waitFor 上限）。
    closeTimerRef.current = window.setTimeout(() => onClose(), 220);
  }, [closing, onClose]);
  const requestClose = useCallback((): void => {
    if (phase.s === "printing") printAbortRef.current?.abort();
    beginClose();
  }, [phase.s, beginClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [requestClose]);

  // -- 焦点圈禁（Tab 循环在面板内，背景 UI 键盘不可达）+ 初始聚焦 -------------
  // 打开即聚焦打印机下拉（打印对话的惯例首焦点；无打印机时聚焦首个可用
  // 控件）。Modal 无圈禁时 Tab 会落到被遮住的侧栏/编辑器——键盘用户「迷路」。
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const FOCUSABLE = "button, select, input, [tabindex]:not([tabindex='-1'])";
    const enabled = (): HTMLElement[] =>
      [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) =>
          !el.hasAttribute("disabled") &&
          el.getAttribute("aria-disabled") !== "true"
      );
    enabled()[0]?.focus();
    const onTab = (e: KeyboardEvent): void => {
      if (e.key !== "Tab") return;
      const els = enabled();
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (!panel.contains(active) || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!panel.contains(active) || active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener("keydown", onTab);
    return () => panel.removeEventListener("keydown", onTab);
  }, []);

  // -- 页面范围 ----------------------------------------------------------------
  const rangeResult = useMemo(
    () =>
      rangeMode === "custom"
        ? parsePageRange(rangeInput, docMeta?.numPages ?? 0)
        : null,
    [rangeMode, rangeInput, docMeta]
  );
  const selectedPages = useMemo((): number[] | null => {
    if (rangeMode === "all") {
      const n = docMeta?.numPages ?? 0;
      return n > 0 ? Array.from({ length: n }, (_, i) => i + 1) : null;
    }
    return rangeResult?.ok ? rangeResult.pages : null;
  }, [rangeMode, rangeResult, docMeta]);

  const bytesReady = phase.s === "ready" && bytesRef.current != null;
  // 重排进行中不可打印：防的正是「按旧版式发打印 + 新排版在打印中途销毁
  // doc」的竞态（doPrintAction 内另有接管兜底，这里从源头禁掉）。
  const canPrint =
    bytesReady &&
    !reformatting &&
    !!printer &&
    !!selectedPages &&
    selectedPages.length > 0;

  // -- 打印 --------------------------------------------------------------------
  const randId = useCallback((): string => {
    // tauri.localhost / 127.0.0.1 均为安全上下文，randomUUID 可用；留
    // Math.random 兜底以防测试环境（jsdom 配置差异）。
    return typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  }, []);
  const doPrintAction = useCallback(async (): Promise<void> => {
    const doc = docRef.current;
    if (!doc || !selectedPages || !printer || phase.s !== "ready") return;
    // 接管排版：清未触发的重排防抖 + 中止在途重排。否则防抖在打印开始后才
    // 触发，runLayout 会 task.destroy 正被 runPrintJob 光栅化的 doc，打印
    // 中途失败（canPrint 已从源头禁用，这里是程序化调用的兜底）。
    if (reformatTimerRef.current !== null) {
      clearTimeout(reformatTimerRef.current);
      reformatTimerRef.current = null;
    }
    layoutAbortRef.current?.abort();
    const ctrl = new AbortController();
    printAbortRef.current = ctrl;
    setPhase({ s: "printing", stage: "render", done: 0, total: selectedPages.length });
    try {
      const out = await runPrintJob({
        // jobId 全局唯一性要求（Rust 注册表判重 + 多窗口事件过滤 + 作业目录
        // 互斥）：Date.now+实例级 seq 在多窗口同毫秒可撞，补随机段闭合。
        jobId: `print-${Date.now()}-${randId()}`,
        doc,
        pages: selectedPages,
        printer,
        copies,
        dpi: printDpiOf(dpiId),
        paper: isPdfKind ? null : paper,
        stem: request.stem,
        signal: ctrl.signal,
        onRenderProgress: (done, total) => {
          if (aliveRef.current) setPhase({ s: "printing", stage: "render", done, total });
        },
        onPrintEvent: (page, total) => {
          if (aliveRef.current) setPhase({ s: "printing", stage: "print", done: page, total });
        },
      });
      if (!aliveRef.current) return;
      if (out.outcome === "done") {
        flashStatus?.(
          copies > 1
            ? `已发送到打印队列（${selectedPages.length} 页 × ${copies} 份）`
            : `已发送到打印队列（${selectedPages.length} 页）`
        );
        beginClose();
      } else {
        setPhase({ s: "ready" });
        flashStatus?.("已取消打印", 5000);
      }
    } catch (e) {
      if (!aliveRef.current) return;
      setPhase({ s: "ready" });
      if (e instanceof DOMException && e.name === "AbortError") {
        flashStatus?.("已取消打印", 5000);
      } else {
        flashStatus?.("打印失败", 5000);
        showAlert?.(`打印失败：${String(e)}`, "打印", "error");
      }
    } finally {
      printAbortRef.current = null;
    }
  }, [selectedPages, printer, phase.s, copies, dpiId, isPdfKind, paper, request.stem, flashStatus, showAlert, beginClose, randId]);

  // -- 保存 PDF（当前预览即产物；pdf kind = 原文件副本）-----------------------
  const [savingPdf, setSavingPdf] = useState(false);
  const doSavePdf = useCallback(async (): Promise<void> => {
    const bytes = bytesRef.current;
    if (!bytes || savingPdf) return;
    const adapter = getAdapter();
    setSavingPdf(true);
    try {
      const target = await adapter.dialog.pickSaveFile(`${request.stem}.pdf`, [
        { name: "PDF", extensions: ["pdf"] },
      ]);
      if (!target) return;
      await adapter.fs.writeFile(target, bytes);
      flashStatus?.(`已保存：${target}`);
    } catch (e) {
      showAlert?.(`保存 PDF 失败：${String(e)}`, "打印", "error");
    } finally {
      setSavingPdf(false);
    }
  }, [request.stem, flashStatus, showAlert, savingPdf]);

  // -- 渲染 --------------------------------------------------------------------
  const printing = phase.s === "printing";
  const busy = phase.s === "prepare" || reformatting;

  return (
    <div
      className={`printdlg-overlay${closing ? " closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="打印"
    >
      <style>{PRINT_DIALOG_CSS}</style>
      <div className="printdlg-panel" ref={panelRef}>
        <header className="printdlg-header">
          <span className="printdlg-title">打印</span>
          <span className="printdlg-sub">{request.stem} · {KIND_LABEL[request.kind]}</span>
          <button className="printdlg-iconbtn" onClick={requestClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="printdlg-body">
          <aside className="printdlg-side">
            <label className="printdlg-field">
              <span className="printdlg-label">
                打印机
                <button
                  className="printdlg-refresh"
                  onClick={() => void refreshPrinters()}
                  disabled={printersLoading || printing}
                  title="重新枚举打印机"
                >
                  ⟳
                </button>
              </span>
              {printersLoading ? (
                <div className="printdlg-static">正在枚举打印机…</div>
              ) : printersError ? (
                <div className="printdlg-static printdlg-error" title={printersError}>
                  打印机列表不可用
                </div>
              ) : printers.length === 0 ? (
                <div className="printdlg-static">未检测到打印机（可先「保存 PDF…」）</div>
              ) : (
                <select
                  value={printer}
                  onChange={(e) => setPrinter(e.target.value)}
                  disabled={printing}
                >
                  {printers.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                      {p.isDefault ? "（默认）" : ""}
                    </option>
                  ))}
                </select>
              )}
            </label>

            <label className="printdlg-field">
              <span className="printdlg-label">份数</span>
              <input
                type="number"
                min={1}
                max={99}
                value={copies}
                disabled={printing}
                onChange={(e) => {
                  const n = Math.floor(Number(e.target.value));
                  setCopies(Number.isFinite(n) ? Math.min(99, Math.max(1, n)) : 1);
                }}
              />
            </label>

            <div className="printdlg-field">
              <span className="printdlg-label">页面范围</span>
              <div className="printdlg-row">
                <label className="printdlg-radio">
                  <input
                    type="radio"
                    name="printdlg-range"
                    checked={rangeMode === "all"}
                    disabled={printing}
                    onChange={() => setRangeMode("all")}
                  />
                  全部{docMeta ? `（${docMeta.numPages} 页）` : ""}
                </label>
                <label className="printdlg-radio">
                  <input
                    type="radio"
                    name="printdlg-range"
                    checked={rangeMode === "custom"}
                    disabled={printing}
                    onChange={() => setRangeMode("custom")}
                  />
                  自定义
                </label>
              </div>
              {rangeMode === "custom" && (
                <>
                  <input
                    className="printdlg-range-input"
                    type="text"
                    placeholder={`如：1-3, 5（共 ${docMeta?.numPages ?? 0} 页）`}
                    value={rangeInput}
                    disabled={printing}
                    onChange={(e) => setRangeInput(e.target.value)}
                  />
                  {rangeResult && !rangeResult.ok && (
                    <span className="printdlg-field-error">{rangeResult.error}</span>
                  )}
                  {rangeResult?.ok && (
                    <span className="printdlg-field-ok">
                      已选 {rangeResult.pages.length} 页
                    </span>
                  )}
                </>
              )}
            </div>

            <hr className="printdlg-sep" />

            <label className="printdlg-field">
              <span className="printdlg-label">纸张</span>
              <select
                value={paper}
                disabled={isPdfKind || printing}
                onChange={(e) => setPaper(e.target.value as PdfPaperId)}
              >
                {Object.entries(PDF_PAPERS).map(([id, p]) => (
                  <option key={id} value={id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="printdlg-field">
              <span className="printdlg-label">方向</span>
              <select
                value={orientation}
                disabled={isPdfKind || printing}
                onChange={(e) => setOrientation(e.target.value as PrintOrientation)}
              >
                <option value="portrait">纵向</option>
                <option value="landscape">横向</option>
              </select>
            </label>

            <label className="printdlg-field">
              <span className="printdlg-label">边距</span>
              <select
                value={marginMm}
                disabled={isPdfKind || printing}
                onChange={(e) => setMarginMm(Number(e.target.value))}
              >
                {PDF_MARGIN_CHOICES.map((m) => (
                  <option key={m} value={m}>
                    {m} mm
                  </option>
                ))}
              </select>
            </label>

            <label className="printdlg-field">
              <span className="printdlg-label">打印质量</span>
              <select
                value={dpiId}
                disabled={printing}
                onChange={(e) => setDpiId(e.target.value as PrintDpiId)}
              >
                {PRINT_DPI_CHOICES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>

            {isPdfKind && (
              <span className="printdlg-note">PDF 标签按原文件页面直打，不重排版。</span>
            )}
            {request.kind === "docx" && (
              <span className="printdlg-note">Word 版式按 mditor 样式；原版式请在 Word 中打印原文件。</span>
            )}
            {request.kind === "html" && (
              <span className="printdlg-note">网页按应用内样式重排版；本地图自动内联，远程样式表跳过。</span>
            )}
          </aside>

          <section className="printdlg-preview" ref={previewScrollRef}>
            {notices.length > 0 && (
              <div className="printdlg-notices">
                {notices.map((n) => (
                  <div key={n} className="printdlg-notice" title={n}>
                    {n}
                  </div>
                ))}
              </div>
            )}
            {phase.s === "failed" ? (
              <div className="printdlg-center">
                <div className="printdlg-fail-title">无法准备打印内容</div>
                <div className="printdlg-fail-detail">{phase.error}</div>
              </div>
            ) : phase.s === "prepare" && !docMeta ? (
              <div className="printdlg-center">
                <div className="printdlg-spinner" />
                <div className="printdlg-center-note">{phase.note}</div>
              </div>
            ) : (
              <>
                {reformatting && (
                  <div className="printdlg-reformat">正在按新设置重新排版…</div>
                )}
                {docMeta?.sizes.map((sz, i) => (
                  <PreviewPage
                    key={`p${docGenRef.current}-${i}`}
                    doc={docRef.current!}
                    index={i + 1}
                    widthPt={sz.w}
                    heightPt={sz.h}
                    displayWidth={displayWidth}
                    cache={cacheRef}
                  />
                ))}
                {docMeta && (
                  <div className="printdlg-pages-foot">共 {docMeta.numPages} 页</div>
                )}
              </>
            )}
          </section>
        </div>

        <footer className="printdlg-footer">
          <span className="printdlg-footnote">
            {printing
              ? phase.stage === "render"
                ? `正在生成打印页… ${phase.done}/${phase.total}`
                : `正在打印… ${phase.done}/${phase.total}（取消在当前页完成后生效）`
              : busy
                ? "正在准备…"
                : ""}
          </span>
          <div className="printdlg-actions">
            {printing ? (
              <button
                className="printdlg-btn"
                onClick={() => printAbortRef.current?.abort()}
              >
                取消打印
              </button>
            ) : (
              <>
                <button
                  className="printdlg-btn"
                  onClick={() => void doSavePdf()}
                  disabled={!bytesReady || savingPdf}
                >
                  {savingPdf ? "正在保存…" : "保存 PDF…"}
                </button>
                <button className="printdlg-btn" onClick={requestClose}>
                  关闭
                </button>
                <button
                  className="printdlg-btn printdlg-primary"
                  onClick={() => void doPrintAction()}
                  disabled={!canPrint}
                >
                  打印
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

// ---- 组件级样式（printdlg- 前缀；明暗主题通吃的中性面）------------------------

const PRINT_DIALOG_CSS = `
.printdlg-overlay { position: fixed; inset: 0; z-index: 9000; display: flex;
  align-items: center; justify-content: center; background: var(--scrim, rgba(15, 18, 25, 0.5));
  font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  animation: printdlg-bg-in var(--dur-base, 220ms) var(--ease-out, ease-out) both; }
.printdlg-overlay.closing { animation: printdlg-bg-out var(--dur-exit, 160ms)
  var(--ease-in, ease-in) both; pointer-events: none; }
.printdlg-panel { display: flex; flex-direction: column; width: min(960px, calc(100vw - 48px));
  height: min(700px, calc(100vh - 64px)); background: var(--card-bg, #ffffff); color: var(--fg, #1f2430);
  border-radius: 12px; box-shadow: var(--shadow-lg, 0 18px 60px rgba(0, 0, 0, 0.35)); overflow: hidden;
  animation: printdlg-panel-in var(--dur-base, 220ms) var(--ease-out, ease-out) both;
  will-change: transform, opacity; }
.printdlg-overlay.closing .printdlg-panel { animation: printdlg-panel-out
  var(--dur-exit, 160ms) var(--ease-in, ease-in) both; }
@keyframes printdlg-bg-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes printdlg-bg-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes printdlg-panel-in { from { opacity: 0; transform: scale(0.96) translateY(10px); }
  to { opacity: 1; transform: scale(1) translateY(0); } }
@keyframes printdlg-panel-out { from { opacity: 1; transform: scale(1) translateY(0); }
  to { opacity: 0; transform: scale(0.97) translateY(6px); } }
.printdlg-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px;
  border-bottom: 1px solid var(--border, #e5e7ec); flex: none; }
.printdlg-title { font-size: 15px; font-weight: 600; }
.printdlg-sub { font-size: 12px; color: var(--fg-muted, #6b7280); overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.printdlg-iconbtn { margin-left: auto; border: none; background: transparent; font-size: 14px;
  color: var(--fg-muted, #6b7280); cursor: pointer; padding: 4px 8px; border-radius: 6px;
  transition: background-color var(--dur-fast, 120ms) var(--ease-out, ease-out),
    color var(--dur-fast, 120ms) var(--ease-out, ease-out); }
.printdlg-iconbtn:hover { background: var(--hover, #f1f2f6); color: var(--fg, #1f2430); }
.printdlg-body { display: flex; flex: 1; min-height: 0; }
.printdlg-side { width: 268px; flex: none; padding: 14px 16px; overflow-y: auto;
  border-right: 1px solid var(--border, #e5e7ec); display: flex; flex-direction: column; gap: 12px; }
.printdlg-field { display: flex; flex-direction: column; gap: 5px; }
.printdlg-label { font-size: 12px; color: var(--fg-muted, #4b5563); display: flex; align-items: center; gap: 6px; }
.printdlg-refresh { border: 1px solid var(--border, #d5d8e0); background: var(--card-bg, #fff); border-radius: 5px;
  font-size: 12px; line-height: 1; padding: 2px 5px; cursor: pointer; color: var(--fg-muted, #4b5563);
  transition: background-color var(--dur-fast, 120ms) var(--ease-out, ease-out); }
.printdlg-refresh:hover { background: var(--hover, #f1f2f6); }
.printdlg-side select, .printdlg-side input[type="number"], .printdlg-side input[type="text"] {
  font: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid var(--border, #d5d8e0);
  border-radius: 6px; background: var(--bg, #fff); color: var(--fg, #1f2430); width: 100%; box-sizing: border-box;
  transition: border-color var(--dur-fast, 120ms) var(--ease-out, ease-out),
    box-shadow var(--dur-fast, 120ms) var(--ease-out, ease-out); }
.printdlg-side select:focus-visible, .printdlg-side input:focus-visible {
  outline: none; border-color: var(--accent, #3b6fd4); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #3b6fd4) 18%, transparent); }
.printdlg-side select:disabled, .printdlg-side input:disabled { background: var(--hover, #f3f4f6); color: var(--fg-muted, #9ca3af); }
.printdlg-static { font-size: 13px; color: var(--fg-muted, #6b7280); padding: 6px 0; }
.printdlg-error { color: var(--danger, #b91c1c); }
.printdlg-row { display: flex; gap: 14px; }
.printdlg-radio { display: flex; align-items: center; gap: 5px; font-size: 13px; cursor: pointer; }
.printdlg-range-input { margin-top: 2px; }
.printdlg-field-error { font-size: 12px; color: var(--danger, #b91c1c); }
.printdlg-field-ok { font-size: 12px; color: var(--success, #15803d); }
.printdlg-sep { border: none; border-top: 1px solid var(--border, #e5e7ec); margin: 2px 0; }
.printdlg-note { font-size: 12px; color: var(--fg-muted, #8a919e); line-height: 1.5; }
.printdlg-preview { flex: 1; min-width: 0; overflow-y: auto; background: var(--bg, #e8eaef);
  display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 24px;
  position: relative; }
/* 纸面恒白（打印预览语义，不随主题变暗）；桌台底走 --bg、纸影走 --shadow。 */
.printdlg-page { position: relative; background: #fff; box-shadow: var(--shadow, 0 2px 10px rgba(0, 0, 0, 0.18));
  flex: none; animation: printdlg-page-in var(--dur-base, 220ms) var(--ease-out, ease-out) both; }
@keyframes printdlg-page-in { from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; } }
/* lively 档：前三张页卡轻微级联（25ms 步进；更多页保持统一节奏，避免长
   文档首屏尾部等待）。 */
html[data-motion="lively"] .printdlg-page:nth-child(2) { animation-delay: 25ms; }
html[data-motion="lively"] .printdlg-page:nth-child(3) { animation-delay: 50ms; }
html[data-motion="lively"] .printdlg-page:nth-child(n + 4) { animation-delay: 75ms; }
.printdlg-page-slot { display: block; }
.printdlg-page-canvas, .printdlg-page-slot canvas { display: block;
  animation: printdlg-canvas-in var(--dur-fast, 120ms) var(--ease-out, ease-out) both; }
@keyframes printdlg-canvas-in { from { opacity: 0; } to { opacity: 1; } }
.printdlg-page-num { position: absolute; right: -8px; bottom: -20px; font-size: 11px;
  color: var(--fg-muted, #6b7280); background: var(--bg, #e8eaef); padding: 0 4px; }
.printdlg-pages-foot { font-size: 12px; color: var(--fg-muted, #6b7280); padding: 6px 0 2px; }
.printdlg-notices { position: sticky; top: 0; z-index: 3; display: flex;
  flex-direction: column; gap: 4px; width: 100%; pointer-events: none; }
.printdlg-notice { font-size: 12px; color: #92400e; background: #fef3c7;
  border: 1px solid #fcd34d; border-radius: 6px; padding: 5px 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  animation: printdlg-notice-in var(--dur-base, 220ms) var(--ease-out, ease-out) both; }
@keyframes printdlg-notice-in { from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: none; } }
.printdlg-reformat { position: sticky; top: 0; z-index: 2; font-size: 12px; color: #1d4ed8;
  background: #dbeafe; border-radius: 6px; padding: 5px 12px; }
.printdlg-center { margin: auto; display: flex; flex-direction: column; align-items: center;
  gap: 12px; max-width: 420px; text-align: center; }
.printdlg-spinner { width: 26px; height: 26px; border-radius: 50%;
  border: 3px solid var(--border, #d5d8e0); border-top-color: var(--accent, #4a7dcc); animation: printdlg-spin 0.9s linear infinite; }
@keyframes printdlg-spin { to { transform: rotate(360deg); } }
.printdlg-center-note { font-size: 13px; color: var(--fg-muted, #4b5563); }
.printdlg-fail-title { font-size: 14px; font-weight: 600; color: var(--danger, #b91c1c); }
.printdlg-fail-detail { font-size: 12px; color: var(--fg-muted, #6b7280); word-break: break-all; }
.printdlg-footer { display: flex; align-items: center; gap: 12px; padding: 10px 16px;
  border-top: 1px solid var(--border, #e5e7ec); flex: none; }
.printdlg-footnote { font-size: 12px; color: var(--fg-muted, #6b7280); flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.printdlg-actions { display: flex; gap: 8px; flex: none; }
.printdlg-btn { font: inherit; font-size: 13px; padding: 7px 16px; border-radius: 7px;
  border: 1px solid var(--border, #d5d8e0); background: var(--card-bg, #fff); color: var(--fg, #1f2430); cursor: pointer;
  transition: background-color var(--dur-fast, 120ms) var(--ease-out, ease-out),
    border-color var(--dur-fast, 120ms) var(--ease-out, ease-out),
    transform var(--dur-fast, 120ms) var(--ease-out, ease-out); }
.printdlg-btn:hover:not(:disabled) { background: var(--hover, #f1f2f6); }
.printdlg-btn:active:not(:disabled) { transform: scale(0.98); }
.printdlg-btn:disabled { color: var(--fg-muted, #9ca3af); cursor: not-allowed; }
.printdlg-btn:focus-visible { outline: 2px solid var(--accent, #3b6fd4); outline-offset: 1px; }
.printdlg-primary { background: var(--accent, #3b6fd4); border-color: var(--accent, #3b6fd4); color: #fff; }
.printdlg-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent, #3b6fd4) 88%, #000); }
/* lively 档增强（惰性前缀，balanced/none 零开销；none/reduced-motion 由
   global.css 通配 kill switch 压为瞬时）：面板 iOS sheet 曲线止动 + 侧栏
   字段逐项上浮级联（25ms/项、封顶 100ms，对齐设置模态惯例）。 */
html[data-motion="lively"] .printdlg-panel { animation: printdlg-panel-in-lively 0.3s
  var(--ease-sheet, cubic-bezier(0.32, 0.72, 0, 1)) both; }
html[data-motion="lively"] .printdlg-overlay.closing .printdlg-panel {
  animation: printdlg-panel-out var(--dur-exit, 160ms) var(--ease-in, ease-in) both; }
@keyframes printdlg-panel-in-lively { from { opacity: 0; transform: scale(0.97) translateY(8px); }
  to { opacity: 1; transform: scale(1) translateY(0); } }
html[data-motion="lively"] .printdlg-side .printdlg-field {
  animation: printdlg-field-in var(--dur-base, 220ms) var(--ease-out, ease-out) both; }
html[data-motion="lively"] .printdlg-side .printdlg-field:nth-child(2) { animation-delay: 25ms; }
html[data-motion="lively"] .printdlg-side .printdlg-field:nth-child(3) { animation-delay: 50ms; }
html[data-motion="lively"] .printdlg-side .printdlg-field:nth-child(4) { animation-delay: 75ms; }
html[data-motion="lively"] .printdlg-side .printdlg-field:nth-child(n + 5) { animation-delay: 100ms; }
@keyframes printdlg-field-in { from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); } }
`;
