// 复习模式（模块 4）：全屏逐卡出题 → 翻面 → 自评四档（SM-2 简化调度）。
//
// 到期来源：vaultIndex 全库索引的 flashcards 字段（保存/监听增量更新）×
// reviewStore 进度（appDataDir/review-state.json）。哈希失配的进度卡
// （源文件已改动）在结束页汇总提示「需重定位」，不自动迁移。
//
// 入口：菜单「复习闪卡」（view_review）。

import { memo, useEffect, useMemo, useState } from "react";
import { vaultIndex } from "../lib/vaultIndex";
import {
  GRADE_LABELS,
  isDue,
  newSchedule,
  scheduleAfter,
  type ReviewGrade,
  type ScannedCard,
} from "../lib/flashcards";
import { cardKey, reviewStore } from "../lib/reviewStore";
import { useDelayedUnmount } from "../hooks/useDelayedUnmount";
import { CloseIcon } from "./icons";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 打开来源笔记的指定行（点卡上的笔记名跳回）。 */
  onOpenNote: (path: string, line: number) => void;
  enabled: boolean;
}

interface DueCard {
  card: ScannedCard;
  key: string;
  dueDay: number;
  overdue: boolean;
}

const EXIT_MS = 200;

export const FlashcardModal = memo(function FlashcardModal({ open, onClose, onOpenNote, enabled }: Props) {
  const mounted = useDelayedUnmount(open, EXIT_MS);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [done, setDone] = useState(0);
  const [, setTick] = useState(0);

  // 到期清单：打开时 + 索引/进度变化时重算。
  const compute = () => {
    const due: DueCard[] = [];
    const now = Date.now();
    const liveKeys = new Set<string>();
    for (const entry of vaultIndex.entries()) {
      for (const card of entry.flashcards) {
        const key = cardKey(entry.path, card.hash);
        liveKeys.add(key);
        const s = reviewStore.get(key) ?? newSchedule(now);
        if (isDue(s, now)) {
          due.push({ card, key, dueDay: s.dueDay, overdue: s.dueDay < Math.floor(now / 86_400_000) - 1 });
        }
      }
    }
    due.sort((a, b) => a.dueDay - b.dueDay);
    // 哈希失配的进度卡（源文件已改动/删除）。
    const orphans = Object.keys(reviewStore.all()).filter((k) => !liveKeys.has(k));
    return { due, orphans, totalCards: liveKeys.size };
  };

  const snapshot = useMemo(() => (open ? compute() : { due: [], orphans: [], totalCards: 0 }), [open]);
  const [, setRecompute] = useState(0);

  useEffect(() => {
    if (!open) return;
    setIdx(0);
    setFlipped(false);
    setDone(0);
    void reviewStore.ensureLoaded();
    const un1 = vaultIndex.subscribe(() => setRecompute((n) => n + 1));
    const un2 = reviewStore.subscribe(() => setTick((t) => t + 1));
    return () => {
      un1();
      un2();
    };
  }, [open]);

  if (!mounted) return null;

  const { due, orphans, totalCards } = snapshot;
  const card = due[idx];

  const grade = (g: ReviewGrade) => {
    if (!card) return;
    const now = Date.now();
    const prev = reviewStore.get(card.key) ?? newSchedule(now);
    reviewStore.set(card.key, scheduleAfter(prev, g, now));
    void reviewStore.flush();
    setFlipped(false);
    setDone((d) => d + 1);
    setIdx((i) => i + 1);
  };

  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      onClose();
      return;
    }
    if (!flipped) {
      if (ev.key === " " || ev.key === "Enter") {
        ev.preventDefault();
        setFlipped(true);
      }
      return;
    }
    if (ev.key === "1") grade(0);
    else if (ev.key === "2") grade(1);
    else if (ev.key === "3") grade(2);
    else if (ev.key === "4") grade(3);
  };

  const finished = idx >= due.length;

  return (
    <div
      className={`fc-overlay${open ? "" : " closing"}`}
      role="dialog"
      aria-label="复习闪卡"
      tabIndex={-1}
      onKeyDown={onKey}
      ref={(el) => el?.focus()}
    >
      <div className="fc-panel" onClick={(e) => e.stopPropagation()}>
        <header className="fc-head">
          <h2>复习闪卡</h2>
          <span className="fc-progress">
            {Math.min(idx + (finished ? 0 : 1), due.length)}/{due.length}
            {done > 0 ? ` · 已完成 ${done}` : ""}
          </span>
          <button className="modal-x" title="关闭 (Esc)" onClick={onClose}>
            <CloseIcon size={14} />
          </button>
        </header>

        {!enabled ? (
          <div className="fc-empty">全库索引已关闭——请在「设置 → 知识功能」中开启。</div>
        ) : due.length === 0 ? (
          <div className="fc-empty">
            {finished && done > 0 ? "本轮复习完成 🎉" : "今天没有到期的卡片。"}
            <div className="fc-sub">
              库中共 {totalCards} 张卡；到期扫描随保存即时更新。
            </div>
            {orphans.length > 0 && (
              <div className="fc-warn" title="源文件改动后内容哈希失配的进度卡">
                另有 {orphans.length} 张进度卡未找到对应卡片（源文件可能已改动，需重定位或忽略）。
              </div>
            )}
          </div>
        ) : !card ? null : (
          <>
            <div
              className={`fc-card${flipped ? " flipped" : ""}`}
              onClick={() => !flipped && setFlipped(true)}
              role="button"
              tabIndex={0}
            >
              <div className="fc-face fc-front">
                <div className="fc-label">问题</div>
                <div className="fc-text">{card.card.question || "（空问题）"}</div>
                <div className="fc-hint">点击卡片或按空格显示答案</div>
              </div>
              <div className="fc-face fc-back">
                <div className="fc-label">答案</div>
                <div className="fc-text">{card.card.answer || "（空答案）"}</div>
              </div>
            </div>
            <button
              className="fc-note-link"
              title={`${card.card.path} 第 ${card.card.line + 1} 行`}
              onClick={() => onOpenNote(card.card.path, card.card.line)}
            >
              来源：{card.card.path.split(/[\\/]/).pop()}:{card.card.line + 1}
              {card.overdue ? " · 已逾期" : ""}
            </button>
            {flipped ? (
              <div className="fc-grades">
                {([0, 1, 2, 3] as ReviewGrade[]).map((g) => (
                  <button key={g} className={`fc-grade g${g}`} onClick={() => grade(g)}>
                    {GRADE_LABELS[g]}
                    <span className="fc-grade-key">{g + 1}</span>
                  </button>
                ))}
              </div>
            ) : (
              <button className="btn-primary fc-flip" onClick={() => setFlipped(true)}>
                显示答案（空格）
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
});
