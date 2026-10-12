// 导出进度对话框（EX 轮 U1）：自研 PDF 管线的自有进度 UI——阶段可视、
// 可取消、结束即卸载（导出中全程零系统弹窗；唯一系统交互是事前的
// pickSaveFile 路径选择）。

import { useEffect } from "react";

export interface ExportProgressState {
  /** 阶段文案（已本地化，由 App 侧映射管线 stage → 用户可读）。 */
  stage: string;
  /** 当前阶段进度（total ≤ 0 = 不确定态，只转圈不计数）。 */
  done: number;
  total: number;
}

interface Props {
  /** 对话框标题（PDF/PNG 等导出类型）。 */
  title: string;
  progress: ExportProgressState;
  onCancel: () => void;
}

export function ExportProgressDialog({ title, progress, onCancel }: Props) {
  // Esc 取消（与「可取消」门禁的键盘路径；对话框不拦截其他键）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const pct =
    progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : null;

  return (
    <div
      className="export-progress-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="导出进度"
    >
      <div className="export-progress-card">
        <div className="export-progress-title">{title}</div>
        <div className="export-progress-stage">{progress.stage}</div>
        <div className="export-progress-bar" aria-hidden={pct === null}>
          {pct !== null && (
            <div className="export-progress-fill" style={{ width: `${pct}%` }} />
          )}
        </div>
        <div className="export-progress-count">
          {pct !== null ? `${progress.done} / ${progress.total}` : ""}
        </div>
        <button type="button" className="export-progress-cancel" onClick={onCancel}>
          取消导出
        </button>
      </div>
    </div>
  );
}
