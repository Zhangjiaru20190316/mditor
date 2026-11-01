// pdfjs 懒加载单例（MF 轮 M2/M3 共用）：PdfNoteView 渲染与 docNote 转 MD
// 管线共享同一份库 + worker 实例。
//
// * 库与 worker 全部懒加载（动态 import 收在本模块，首屏 bundle 零增量，
//   对齐 exporter.ts 的首屏零依赖惯例）；
// * worker 经 Vite ?url 产物以 module worker 注入 GlobalWorkerOptions.
//   workerPort，CSP worker-src 'self' blob: 已双镜像放行
//   （tauriCspConfig.test.ts 钉死）；
// * 失败置回 null 允许重试；成功后 workerPort 常驻复用（文档销毁不影响）。

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

/** 懒加载 pdfjs 并确保 worker 就绪（幂等；并发调用共享同一 Promise）。 */
export function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const [lib, workerMod] = await Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      ]);
      lib.GlobalWorkerOptions.workerPort = new Worker(workerMod.default, {
        type: "module",
      });
      return lib;
    })();
    pdfjsPromise.catch(() => {
      pdfjsPromise = null;
    });
  }
  return pdfjsPromise;
}
