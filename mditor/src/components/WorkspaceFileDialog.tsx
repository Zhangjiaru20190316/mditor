// 工作区文件类型选择对话框（v5.3）：单个工作区根在文件树显示哪些笔记
// 类型（Markdown/HTML/PDF/Word，替换式白名单）。三个入口共用：① 添加/
// 替换工作区流程（选完文件夹后弹一次，默认全选）；② 设置 → 工作区 每根
// 行「文件类型…」；③ 文件树右键根目录「文件类型…」。
//
// 语义：仅影响文件树的显示/打开入口（tauriFs.readDirLevel 的 allowed
// 参数）；磁盘文件不动，全局搜索/QuickSwitcher/RAG 行为不变。全部勾选 =
// 默认（调用方据此不写配置键）。

import { useEffect, useRef, useState } from "react";
import { NOTE_KINDS } from "../defaults";
import type { NoteKind } from "../types";
import { useDelayedUnmount } from "../hooks/useDelayedUnmount";

const EXIT_MS = 240;

/** 类型显示名（顺序随 NOTE_KINDS；设置分区的每根摘要共用）。 */
export const KIND_LABELS: Record<NoteKind, string> = {
  md: "Markdown",
  html: "HTML",
  pdf: "PDF",
  docx: "Word",
};

interface Props {
  open: boolean;
  /** 标题中显示的文件夹/工作区名。 */
  name: string;
  /** 初始勾选（undefined/空 = 全部四类，默认行为）。 */
  initialKinds?: readonly string[];
  /** 确认：按 NOTE_KINDS 顺序返回勾选的类型集合（可能为全部四类）。 */
  onConfirm: (kinds: NoteKind[]) => void;
  onClose: () => void;
}

export function WorkspaceFileDialog({ open, name, initialKinds, onConfirm, onClose }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set(NOTE_KINDS));
  const mounted = useDelayedUnmount(open, EXIT_MS);
  const stateInited = useRef(false);

  // 打开瞬间从 initialKinds 初始化（编辑既有配置时预填，缺省全选）。
  useEffect(() => {
    if (!open || stateInited.current) return;
    stateInited.current = true;
    const seed =
      initialKinds && initialKinds.length > 0
        ? initialKinds.filter((k) => (NOTE_KINDS as readonly string[]).includes(k))
        : NOTE_KINDS;
    setSelected(new Set(seed));
  }, [open, initialKinds]);

  useEffect(() => {
    if (!open) stateInited.current = false;
  }, [open]);

  if (!mounted) return null;

  const toggle = (kind: NoteKind): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const confirm = (): void => {
    // 按 NOTE_KINDS 顺序输出（与归一层/引擎的稳定顺序一致）。
    onConfirm(NOTE_KINDS.filter((k) => selected.has(k)));
    onClose();
  };

  return (
    <div className={`modal-backdrop${open ? "" : " closing"}`} onClick={onClose}>
      <div
        className="modal-card wsfile-card"
        role="dialog"
        aria-label={`文件类型：${name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>文件类型</h2>
          <span className="wsfile-root mono" title={name}>
            {name}
          </span>
        </header>
        <div className="wsfile-body">
          <span className="sync-scope-label">该工作区在文件树中显示的类型</span>
          <div className="wsfile-chips" role="group" aria-label="笔记类型">
            {NOTE_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className={`wsfile-chip${selected.has(kind) ? " on" : ""}`}
                onClick={() => toggle(kind)}
              >
                {selected.has(kind) ? "✓ " : ""}
                {KIND_LABELS[kind]}
              </button>
            ))}
          </div>
          <span className="hint">
            取消勾选的类型将从该工作区的文件树隐藏（磁盘文件不受影响；全局搜索
            与索引行为不变）。全部勾选 = 恢复默认显示。
          </span>
        </div>
        <footer className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" onClick={confirm}>
            确定
          </button>
        </footer>
      </div>
    </div>
  );
}
