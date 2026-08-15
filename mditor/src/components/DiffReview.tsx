// 改动预览（AI 修改类操作的应用前审查）。
//
// AI 的润色 / 改写 / 纠错回复不再直接替换文档：AiPanel 用 lib/diff 计算
// 「原文 → AI 文本」的行级 hunks，本组件把它们逐条列出，每处展示
// 原内容（红）与新内容（绿）的对照（单行对单行时附加字符级强调），
// 用户可逐条接受 / 拒绝、全部接受 / 全部拒绝，点卡片可跳回原文位置查看
// 上下文，确认后才由 App 一次性写回（一步撤销，见 useMilkdown 的 aiWrite*）。
//
// 组件本身是纯展示 + 回调，所有决策状态留在 AiPanel。

import { memo } from "react";
import { charDiffRange, type DiffHunk } from "../lib/diff";
import { CheckIcon, CloseIcon, ChevronRightIcon } from "./icons";

interface Props {
  hunks: DiffHunk[];
  /** decisions[i] === true 表示接受第 i 处。 */
  decisions: boolean[];
  /** full=整篇替换审查；selection=选区替换审查（标题提示用）。 */
  mode: "full" | "selection";
  onToggle: (index: number) => void;
  onSetAll: (accept: boolean) => void;
  onApply: () => void;
  onCancel: () => void;
  /** 点击某处改动 → 跳回编辑器中的原文位置查看上下文。 */
  onJump: (hunk: DiffHunk) => void;
}

/** 单侧最多直接渲染的行数，超出折叠为「…另有 N 行」。 */
const MAX_LINES_SHOWN = 4;

interface LineProps {
  line: string;
  kind: "orig" | "new";
  /** 字符级强调区间（[s,e) 或 null）——单行对单行的 hunk 才有。 */
  range?: [number, number] | null;
}

const DiffLine = memo(function DiffLine({ line, kind, range }: LineProps) {
  const empty = line.trim() === "";
  const prefix = kind === "orig" ? "-" : "+";
  const cls = `diff-line diff-line-${kind}${empty ? " diff-line-empty" : ""}`;
  if (!range) {
    return (
      <div className={cls}>
        <span className="diff-line-prefix" aria-hidden="true">{prefix}</span>
        <span className="diff-line-text">{line || "（空行）"}</span>
      </div>
    );
  }
  const [s, e] = range;
  return (
    <div className={cls}>
      <span className="diff-line-prefix" aria-hidden="true">{prefix}</span>
      <span className="diff-line-text">
        {line.slice(0, s)}
        <mark className={`diff-mark diff-mark-${kind}`}>{line.slice(s, e)}</mark>
        {line.slice(e)}
      </span>
    </div>
  );
});

/** 一侧的行块（原 / 新），超长折叠。 */
function LineBlock({ lines, kind, ranges }: { lines: string[]; kind: "orig" | "new"; ranges?: Array<[number, number] | null> }) {
  if (lines.length === 0) {
    return <div className={`diff-block diff-block-${kind} diff-block-none`}>（无）</div>;
  }
  const shown = lines.slice(0, MAX_LINES_SHOWN);
  const rest = lines.length - shown.length;
  return (
    <div className={`diff-block diff-block-${kind}`}>
      {shown.map((l, i) => (
        <DiffLine key={i} line={l} kind={kind} range={ranges?.[i] ?? null} />
      ))}
      {rest > 0 && <div className="diff-more">…另有 {rest} 行</div>}
    </div>
  );
}

export const DiffReview = memo(function DiffReview({
  hunks,
  decisions,
  mode,
  onToggle,
  onSetAll,
  onApply,
  onCancel,
  onJump,
}: Props) {
  const accepted = decisions.filter(Boolean).length;

  if (hunks.length === 0) {
    return (
      <div className="diff-review">
        <div className="diff-head">
          <span className="diff-title">改动预览</span>
          <button className="diff-close" title="关闭" onClick={onCancel}>
            <CloseIcon size={13} />
          </button>
        </div>
        <div className="diff-empty">
          AI 的回复与原文相同，没有需要应用的改动。
        </div>
      </div>
    );
  }

  return (
    <div className="diff-review">
      <div className="diff-head">
        <span className="diff-title">
          改动预览
          <span className="diff-count">
            共 {hunks.length} 处 · 已接受 {accepted} 处
          </span>
        </span>
        <div className="diff-head-actions">
          <button className="diff-mini" onClick={() => onSetAll(true)} title="接受全部改动">
            全部接受
          </button>
          <button className="diff-mini" onClick={() => onSetAll(false)} title="拒绝全部改动">
            全部拒绝
          </button>
          <button className="diff-close" title="关闭审查，不应用任何改动" onClick={onCancel}>
            <CloseIcon size={13} />
          </button>
        </div>
      </div>
      <div className="diff-mode-tag">{mode === "selection" ? "将应用到选中片段" : "将应用到全文"}</div>

      <div className="diff-list">
        {hunks.map((h, i) => {
          const on = decisions[i];
          const pair =
            h.origLines.length === 1 && h.newLines.length === 1
              ? charDiffRange(h.origLines[0], h.newLines[0])
              : null;
          const isIns = h.origLines.length === 0;
          const isDel = h.newLines.length === 0;
          return (
            <div
              key={i}
              className={`diff-hunk${on ? " accepted" : " rejected"}`}
              onClick={() => onJump(h)}
              title="点击跳转到编辑器中的原文位置"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onJump(h);
                }
              }}
            >
              <div className="diff-hunk-head">
                <span className="diff-hunk-badge">#{i + 1}</span>
                <span className="diff-hunk-kind">
                  {isIns ? "新增" : isDel ? "删除" : "替换"}
                  <span className="diff-hunk-lines">
                    （{h.origLines.length || "—"} 行 → {h.newLines.length || "—"} 行）
                  </span>
                </span>
                <span className="diff-hunk-actions">
                  <button
                    className={`diff-act accept${on ? " on" : ""}`}
                    disabled={on}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggle(i);
                    }}
                    title="接受这处改动"
                  >
                    <CheckIcon size={11} /> 接受
                  </button>
                  <button
                    className={`diff-act reject${!on ? " on" : ""}`}
                    disabled={!on}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggle(i);
                    }}
                    title="拒绝这处改动"
                  >
                    <CloseIcon size={11} /> 拒绝
                  </button>
                </span>
              </div>
              <div className="diff-hunk-body">
                <LineBlock lines={h.origLines} kind="orig" ranges={pair ? [pair.aRange] : undefined} />
                {!isIns && !isDel && (
                  <div className="diff-arrow" aria-hidden="true">
                    <ChevronRightIcon size={12} />
                  </div>
                )}
                <LineBlock lines={h.newLines} kind="new" ranges={pair ? [pair.bRange] : undefined} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="diff-foot">
        <span className="diff-hint">应用后可按 Ctrl+Z 一步撤销全部已接受改动</span>
        <button className="diff-apply" disabled={accepted === 0} onClick={onApply}>
          应用 {accepted} 处改动
        </button>
      </div>
    </div>
  );
});
