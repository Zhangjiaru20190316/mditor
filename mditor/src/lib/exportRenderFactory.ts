// 离屏渲染工厂（EX 轮阶段二「资源就绪确定性」基建 + 阶段三 PDF 管线的
// 渲染基座）：把导出 HTML 在独立 iframe 里以「真实版心宽度」渲染到就绪。
//
// 与退役对象 printHtml 的三点结构差（对应定罪根因）：
//   * 真实版心宽度（纸宽−边距），不是 0×0 隐藏 iframe —— 布局在真实宽度
//     下发生，后续分页/光栅/文本层测的都是这份布局（RC-1：内容宽按构造
//     等于版心，不存在对话框缩放裁边）。
//   * 资源确定性就绪：逐图 + 字体各自跟踪，超时把「未就绪清单」显式交回
//     调用方列报（RC-3：替代 5s 盲等后照打不误）。超时策略：
//     FACTORY_READY_TIMEOUT_MS 总上限，超时后带清单继续（调用方决定列报
//     还是中止）。
//   * 进度事件 + AbortSignal 可取消 + destroy() 幂等回收（沿 printHtml 的
//     回收注释惯例：连续导出不得堆积 iframe/定时器）。
//
// S10 红线：本模块是所有新渲染路径（PDF/PNG 工厂）的输入侧消毒门——
// buildFactoryDocumentHtml 内先 sanitizeExportHtml（幂等，上游已消毒时
// 无变化）。iframe 内不执行脚本（消毒已移除 script，document.write 的
// 解析亦不跑脚本），渲染是纯静态布局。

import { sanitizeExportHtml } from "./exportSanitize";
import { EXPORT_PROSE_CSS } from "./exportProseCss";

/** 资源就绪总上限（文档化超时策略：超时不是失败，是「显式带清单继续」）。 */
export const FACTORY_READY_TIMEOUT_MS = 20_000;

export interface FactoryProgress {
  stage: "write" | "images" | "fonts" | "layout";
  done: number;
  total: number;
}

/** 工厂内未能就绪的资源（调用方并入 C2 显式列报，不静默）。 */
export interface FactoryResourceIssue {
  kind: "image-error" | "image-timeout";
  src: string;
}

export interface FactoryDocOptions {
  /** 版心内容宽（px）＝纸宽−边距。布局在此宽度下真实发生。 */
  contentWidthPx: number;
  /** 主题 CSS（collectThemeCss 产物，产物与编辑器视觉同源的单一事实源）。 */
  css: string;
  /** 文档标题（iframe <title>，仅诊断可见）。 */
  title?: string;
  /** data-theme（缺省读 <html> 当前主题，与 exporter.currentTheme 同源）。 */
  theme?: string;
  /** 图片单图高度钳制（PDF 分页用：不允许高于一页内容高；PNG 长图不传）。 */
  maxImageHeightPx?: number;
}

/**
 * 组装工厂文档（纯函数）：body 上挂与 exporter.wrapHtml 同源的 data-theme
 * 与主题 CSS，内容包进 #mditor-export-content（固定宽度、零边距——坐标
 * 基准即该容器顶）。img 的 lazy/async 解码改为即刻（离屏 iframe 视口外
 * 的 lazy 图永不加载，工厂必须全量渲染）。S10：输入先消毒。
 */
export function buildFactoryDocumentHtml(
  html: string,
  o: FactoryDocOptions
): string {
  const safe = sanitizeExportHtml(html);
  // 序列化器输出双引号属性；单引号兜底。decoding=async 同理改同步（截图
  // 引擎等待的是加载完成，解码异步与否影响的是入图时机）。
  const eager = safe
    .replace(/(<img\b[^>]*?)\s+loading=["']lazy["']/gi, "$1")
    .replace(/(<img\b[^>]*?)\s+decoding=["']async["']/gi, "$1");
  const theme =
    o.theme ?? document.documentElement.getAttribute("data-theme") ?? "light";
  const clamp = Number.isFinite(o.maxImageHeightPx)
    ? `\n/* 分页护栏：单图不得高于一页内容高（按构造不可能整图被截）；宽度
       钳制在版心内（无尺寸属性的 svg 自然宽度可超出版心溢出页缘）。 */
img, video { max-height: ${o.maxImageHeightPx}px; max-width: 100%; }`
    : `\nimg, video { max-width: 100%; }`;
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="UTF-8">
<title>${escapeAttr(o.title ?? "export")}</title>
<style>
${o.css}
${EXPORT_PROSE_CSS}
/* 工厂版式：真实内容宽 + 零边距（页边距由 PDF 组装负责，布局只管内容）。
   print-color-adjust 沿 wrapHtml 语义保留（无害：工厂不走打印管线）。 */
html { background: var(--bg); }
html, body { margin: 0; padding: 0; }
body { width: ${o.contentWidthPx}px; }
#mditor-export-content { width: ${o.contentWidthPx}px; }${clamp}
@media print {
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
}
</style>
</head>
<body class="vditor-reset">
<div id="mditor-export-content">
${eager}
</div>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** awaitFactoryResources 可测试的最小图片面（HTMLImageElement 子集）。 */
export interface ResourceImageLike {
  complete: boolean;
  src: string;
  addEventListener(
    type: "load" | "error",
    fn: () => void,
    opts?: { once?: boolean }
  ): void;
}

export interface ResourceWaitOptions {
  /** 字体就绪 promise（doc.fonts?.ready ?? 已就绪）。 */
  fontsReady?: Promise<unknown>;
  readyTimeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface ResourceWaitResult {
  issues: FactoryResourceIssue[];
  /** 超时触发（true = 有资源未在上限内就绪，清单即未就绪项）。 */
  timedOut: boolean;
}

/**
 * 确定性资源就绪（RC-3 替代）：逐图 load/error 跟踪 + 字体 ready，总上限
 * 内 race；超时不抛错、不静默——把未就绪图片列进 issues 交回调用方。
 * （data URL / asset: 图通常毫秒级；此上限防的是解码死循环与意外挂起。）
 */
export function awaitFactoryResources(
  images: ResourceImageLike[],
  o: ResourceWaitOptions = {}
): Promise<ResourceWaitResult> {
  return new Promise((resolve) => {
    const total = images.length;
    let done = images.filter((i) => i.complete).length;
    const issues: FactoryResourceIssue[] = [];
    o.onProgress?.(done, total);
    if (total === done) {
      void Promise.resolve(o.fontsReady).then(() =>
        resolve({ issues: [], timedOut: false })
      );
      return;
    }
    let settled = false;
    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        for (const img of images) {
          if (!img.complete) issues.push({ kind: "image-timeout", src: img.src });
        }
      }
      void Promise.resolve(o.fontsReady).then(() => resolve({ issues, timedOut }));
    };
    const one = (): void => {
      done++;
      o.onProgress?.(done, total);
      if (done >= total) finish(false);
    };
    for (const img of images) {
      if (img.complete) continue;
      img.addEventListener("load", one, { once: true });
      img.addEventListener("error", () => {
        issues.push({ kind: "image-error", src: img.src });
        one();
      }, { once: true });
    }
    // finish 只经 one()/超时回调触达，二者都晚于本行（同步初始化先完成）。
    const timer = setTimeout(
      () => finish(true),
      o.readyTimeoutMs ?? FACTORY_READY_TIMEOUT_MS
    );
  });
}

export interface RenderFactoryOptions extends FactoryDocOptions {
  signal?: AbortSignal;
  onProgress?: (p: FactoryProgress) => void;
  readyTimeoutMs?: number;
}

export interface RenderFactoryHandle {
  readonly iframe: HTMLIFrameElement;
  doc: Document;
  /** 版心容器（坐标基准；分页/文本层/光栅都相对它取 rect）。 */
  content: HTMLElement;
  /** 未就绪资源（就绪阶段产出；调用方并入 C2 列报）。 */
  readonly issues: FactoryResourceIssue[];
  /** 就绪是否触发了超时（诊断位）。 */
  timedOut: boolean;
  /** 幂等回收：移除 iframe。连续导出不得堆积。 */
  destroy(): void;
}

/**
 * 在离屏 iframe 里渲染导出 HTML 至资源就绪。iframe 定位在屏幕外
 * （left:-20000px）——不用 display:none（无布局）也不用 visibility:hidden
 * （保守起见让光栅引擎读到真实计算样式）。就绪 = 逐图 + 字体 + 双 rAF
 * 布局收帧；AbortSignal 触发回收并抛 AbortError。
 */
export async function renderInFactory(
  html: string,
  o: RenderFactoryOptions
): Promise<RenderFactoryHandle> {
  if (o.signal?.aborted) throw new DOMException("导出已取消", "AbortError");
  const full = buildFactoryDocumentHtml(html, o);
  const iframe = document.createElement("iframe");
  iframe.title = o.title ?? "mditor-export-factory";
  // 屏幕外真尺寸：布局/字体/解码都真实发生，只是用户不可见。
  iframe.style.cssText =
    "position:fixed;left:-20000px;top:0;border:0;pointer-events:none;" +
    `width:${o.contentWidthPx}px;height:600px;`;
  let destroyed = false;
  const handle: RenderFactoryHandle = {
    iframe,
    doc: null as unknown as Document,
    content: null as unknown as HTMLElement,
    issues: [],
    timedOut: false,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      iframe.remove();
    },
  };
  try {
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    if (!doc) throw new Error("无法创建离屏渲染文档（iframe contentDocument 为空）");
    handle.doc = doc;
    o.onProgress?.({ stage: "write", done: 1, total: 1 });
    doc.open();
    doc.write(full);
    doc.close();
    const content = doc.getElementById("mditor-export-content");
    if (!content) throw new Error("工厂文档结构异常（缺少版心容器）");
    handle.content = content as HTMLElement;

    const abort = new Promise<never>((_, reject) => {
      o.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("导出已取消", "AbortError")),
        { once: true }
      );
    });
    const r = await Promise.race([
      awaitFactoryResources(Array.from(doc.images), {
        fontsReady: doc.fonts?.ready,
        readyTimeoutMs: o.readyTimeoutMs,
        onProgress: (done, total) =>
          o.onProgress?.({ stage: "images", done, total }),
      }),
      abort,
    ]);
    handle.issues.push(...r.issues);
    handle.timedOut = r.timedOut;
    o.onProgress?.({ stage: "fonts", done: 1, total: 1 });
    // 布局收帧：双 setTimeout + 强制同步布局读。不依赖 rAF——被遮挡/
    // 最小化窗口的 rAF 会被 Chromium 暂停（EX-P 实测挂死根因：用户导出中
    // 切走窗口 = 导出永不完成）。KaTeX 标记是静态 HTML，无脚本需要等。
    await Promise.race([
      (async () => {
        void handle.content.scrollHeight; // 强制重排
        await new Promise((res) => setTimeout(res, 0));
        void handle.content.scrollHeight;
        await new Promise((res) => setTimeout(res, 0));
      })(),
      abort,
    ]);
    o.onProgress?.({ stage: "layout", done: 1, total: 1 });
    if (o.signal?.aborted) throw new DOMException("导出已取消", "AbortError");
    return handle;
  } catch (e) {
    handle.destroy();
    throw e;
  }
}
