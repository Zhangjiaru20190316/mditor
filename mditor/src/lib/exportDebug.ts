// 导出诊断出口（window.__exportDebug，EX 轮）：把编辑器真源（模型序列化
// getHTML / Markdown 源 getValue / 文档路径）以只读方式暴露给 DevTools 与
// perf/ CDP 脚本——导出管线的复现与验收必须走「模型序列化」而非实时 DOM
// （cv 档 content-visibility / 懒渲染占位不进序列化结果，实时 DOM 不是导
// 出真源）。观测专用：内部全 try/catch，无编辑器实例时返回空值，不改变任
// 何导出/编辑行为。

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
