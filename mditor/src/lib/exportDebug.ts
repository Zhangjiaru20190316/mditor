// 导出诊断出口（window.__exportDebug，EX 轮）：把编辑器真源（模型序列化
// getHTML / Markdown 源 getValue / 文档路径）以只读方式暴露给 DevTools 与
// perf/ CDP 脚本——导出管线的复现与验收必须走「模型序列化」而非实时 DOM
// （cv 档 content-visibility / 懒渲染占位不进序列化结果，实时 DOM 不是导
// 出真源）。观测专用：内部全 try/catch，无编辑器实例时返回空值，不改变任
// 何导出/编辑行为。

import type { PdfPipelineOptions } from "./exportPdfPipeline";

export interface ExportDebugHandle {
  /** PM 模型序列化 HTML（导出管线真源；sv 模式走隐藏实例序列化）。 */
  getHTML(): string;
  /** Markdown 源码（LaTeX 导出输入）。 */
  getValue(): string;
  /** 当前文档磁盘路径（相对图片解析基准），未保存文档为 null。 */
  docPath(): string | null;
  /** EX Fix-D4 验收用：编辑器当前是否处于大文档减配档（导出侧
   *  renderDegradedMath 的门控信号）。只读观测。 */
  isBigDoc(): boolean;
  /** EX 阶段三/四验收用：在当前文档上跑自研 PDF 管线并写盘到指定路径
   *  （免 pickSaveFile 对话框的 perf 驱动入口）。返回管线 meta（页数/
   *  分页统计/组装信息/分阶段耗时）。不改变任何默认导出行为。 */
  exportPdfTo(
    path: string,
    opts?: {
      paper?: PdfPipelineOptions["paper"];
      marginMm?: number;
      rasterScale?: number;
      textLayer?: boolean;
      /** 进度事件透传（perf 侧逐块观测/冻点定位用）。 */
      onProgress?: PdfPipelineOptions["onProgress"];
      /** 调试：把指定页（0 基）的页位图 PNG 写到 dir（C1 视觉抽检）。 */
      dumpPages?: { indices: number[]; dir: string; name?: string };
    }
  ): Promise<Record<string, unknown>>;
  /** EX 阶段六验收用：同工厂内三变体光栅 A/B——trim1（现行为裁剪）/
   *  stream（修复前流式，含全量克隆成本）/ trim2（裁剪对照二跑）。返回行
   *  墨量剖面滞后/相关、块顶对原位基准差、各变体耗时。仅 perf 驱动，不
   *  改变任何默认导出行为。 */
  rasterAb(opts?: {
    paper?: PdfPipelineOptions["paper"];
    marginMm?: number;
    rasterScale?: number;
    pageCount?: number;
    maxLagPx?: number;
    /** 页位图落盘目录（ex6-ab-{variant}-page{i}.png）。 */
    dumpDir?: string;
  }): Promise<Record<string, unknown>>;
  /** 与文件树点击同流程打开文档（perf 驱动 fixture 用；工作区外文档无
   *  其他免对话框入口）。返回是否成功打开。 */
  open(path: string): Promise<boolean>;
}

let handle: ExportDebugHandle | null = null;

/** App 挂载编辑器后注册（只注册引用，不持有不重建）。 */
export function registerExportDebugHandle(h: ExportDebugHandle): void {
  handle = h;
}

/** main.tsx 挂 window.__exportDebug（常驻、零风险）。 */
export function attachExportDebugGlobal(): void {
  (
    window as unknown as { __exportDebug?: ExportDebugHandle }
  ).__exportDebug = {
    getHTML: () => {
      try {
        return handle?.getHTML() ?? "";
      } catch {
        return "";
      }
    },
    getValue: () => {
      try {
        return handle?.getValue() ?? "";
      } catch {
        return "";
      }
    },
    docPath: () => {
      try {
        return handle?.docPath() ?? null;
      } catch {
        return null;
      }
    },
    isBigDoc: () => {
      try {
        return handle?.isBigDoc() ?? false;
      } catch {
        return false;
      }
    },
    exportPdfTo: (p, opts) => {
      const run = handle?.exportPdfTo(p, opts) ?? Promise.resolve({});
      return run.catch((e) => {
        // 失败也以对象形态返回（CDP returnByValue 无法搬运异常栈）。
        return { error: String(e) };
      });
    },
    rasterAb: (opts) => {
      const run = handle?.rasterAb(opts) ?? Promise.resolve({});
      return run.catch((e) => {
        return { error: String(e) };
      });
    },
    open: (p: string) => {
      try {
        return handle
          ?.open(p)
          .then(() => true)
          .catch(() => false) ?? Promise.resolve(false);
      } catch {
        return Promise.resolve(false);
      }
    },
  };
}
