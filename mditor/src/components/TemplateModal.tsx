// 「从模板新建」弹窗（V3.6）：列出内置模板，点击即在新标签页创建。
// 风格复用 modal-backdrop / modal-card 体系。v4.1：useDelayedUnmount 保持
// 挂载约 240ms 播退场动画（.closing）再卸载。

import { useEffect, useRef } from "react";
import { TEMPLATES, type DocTemplate } from "../lib/templates";
import { useDelayedUnmount } from "../hooks/useDelayedUnmount";
import { MarkdownFileIcon } from "./icons";

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (t: DocTemplate) => void;
}

const EXIT_MS = 240;

export function TemplateModal({ open, onClose, onPick }: Props) {
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const mounted = useDelayedUnmount(open, EXIT_MS);
  useEffect(() => {
    if (open) firstRef.current?.focus();
  }, [open]);
  if (!mounted) return null;

  return (
    <div className={`modal-backdrop${open ? "" : " closing"}`} onClick={onClose}>
      <div
        className="modal-card template-card"
        role="dialog"
        aria-label="从模板新建"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>从模板新建</h2>
        </header>
        <div className="template-list">
          {TEMPLATES.map((t, i) => (
            <button
              key={t.id}
              ref={i === 0 ? firstRef : undefined}
              className="template-item"
              onClick={() => {
                onPick(t);
                onClose();
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  onClose();
                }
              }}
            >
              <MarkdownFileIcon size={18} className="template-item-icon" />
              <span className="template-item-name">{t.name}</span>
              <span className="template-item-desc">{t.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
