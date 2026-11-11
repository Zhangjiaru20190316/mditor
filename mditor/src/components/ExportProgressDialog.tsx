// 导出进度对话框（EX 轮 U1）：自研 PDF 管线的自有进度 UI——阶段可视、
// 可取消、结束即收场（导出中全程零系统弹窗；唯一系统交互是事前的
// pickSaveFile 路径选择）。
// v5.3.2：收编进模态动效体系——progress 传 null 即进入退场（useDelayedUnmount
// 保挂 240ms 播 .closing），入场吃 modal-bg-in/modal-card-in 同款曲线。

import { useEffect } from "react";
import { useDelayedUnmount } from "../hooks/useDelayedUnmount";

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
  /** null = 关闭（播放退场后卸载）。 */
  progress: ExportProgressState | null;
  onCancel: () => void;
}

export function ExportProgressDialog({ title, progress, onCancel }: Props) {
  const open = progress !== null;
  const mounted = useDelayedUnmount(open, 240);

  // Esc 取消（与「可取消」门禁的键盘路径；对话框不拦截其他键）。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!mounted) return null;

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : null;

  return (
    <div
      className={`export-progress-overlay${!open ? " closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="导出进度"
    >
      <div className="export-progress-card">
        <div className="export-progress-title">{title}</div>
        <div className="export-progress-stage">{progress?.stage ?? ""}</div>
        <div className="export-progress-bar" aria-hidden={pct === null}>
          {pct !== null && (
            <div className="export-progress-fill" style={{ transform: `scaleX(${pct / 100})` }} />
          )}
        </div>
        <div className="export-progress-count">
          {pct !== null && progress ? `${progress.done} / ${progress.total}` : ""}
        </div>
        <button type="button" className="export-progress-cancel" onClick={onCancel}>
          取消导出
        </button>
      </div>
    </div>
  );
}
