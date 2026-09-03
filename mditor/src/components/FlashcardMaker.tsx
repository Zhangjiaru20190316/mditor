// 做卡确认弹层（模块 4）：「做成闪卡」与「AI 改写为问答卡」共用。
// 问题/答案预填可调（textarea），确认后经 onInsert 插入 :::flash 块。

import { memo, useEffect, useRef, useState } from "react";
import { useDelayedUnmount } from "../hooks/useDelayedUnmount";
import { CloseIcon } from "./icons";

interface Props {
  open: boolean;
  initial: { question: string; answer: string };
  /** 标题（区分手动做卡 / AI 改写）。 */
  title?: string;
  onClose: () => void;
  /** 确认插入（App 侧经 editorRef 插入 :::flash 块）。 */
  onInsert: (question: string, answer: string) => void;
  /** AI 模式的「重新生成」回调（无则不显示按钮）。 */
  onRegenerate?: () => void;
}

const EXIT_MS = 200;

export const FlashcardMaker = memo(function FlashcardMaker({
  open,
  initial,
  title = "做成闪卡",
  onClose,
  onInsert,
  onRegenerate,
}: Props) {
  const mounted = useDelayedUnmount(open, EXIT_MS);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const qRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuestion(initial.question);
    setAnswer(initial.answer);
    const t = window.setTimeout(() => qRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
  }, [open, initial]);

  if (!mounted) return null;

  const submit = () => {
    if (!question.trim() && !answer.trim()) return;
    onInsert(question.trim() || "（问题）", answer.trim() || "（答案）");
    onClose();
  };

  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      onClose();
    } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      submit();
    }
  };

  return (
    <div
      className={`modal-backdrop${open ? "" : " closing"}`}
      onClick={onClose}
      role="dialog"
      aria-label={title}
    >
      <div className="modal-card fc-maker" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="modal-x" onClick={onClose}>
            <CloseIcon size={14} />
          </button>
        </header>
        <section className="modal-body">
          <label className="field">
            <span className="field-label">问题</span>
            <span className="field-control">
              <textarea
                ref={qRef}
                className="fc-maker-ta"
                rows={2}
                value={question}
                placeholder="要记住的问题（Ctrl+Enter 插入）"
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={onKey}
              />
            </span>
          </label>
          <label className="field">
            <span className="field-label">答案</span>
            <span className="field-control">
              <textarea
                className="fc-maker-ta"
                rows={4}
                value={answer}
                placeholder="答案（默认预填选中内容）"
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={onKey}
              />
            </span>
          </label>
          <span className="hint">
            插入为 :::flash 容器块（问题 / --- / 答案），保存后进入复习调度。
          </span>
        </section>
        <footer className="modal-foot">
          {onRegenerate && (
            <button className="btn-ghost" onClick={onRegenerate}>
              AI 重新生成
            </button>
          )}
          <button className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" onClick={submit}>
            插入卡片（Ctrl+Enter）
          </button>
        </footer>
      </div>
    </div>
  );
});
