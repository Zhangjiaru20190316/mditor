// Agent 改动清单审阅（v4.9）：runAgent 产出的 ChangePlan 的应用前审查。
//
// 与 chat 模式的 DiffReview（单笔记逐 hunk）并存、互不复用状态：本组件按
// 文件分组列出跨文件操作，edit 类可展开行内 diff（复用 lib/diff 的
// diffText 与 .diff-line 样式），每条带勾选（默认全选）；create/rename/
// delete 展示目标路径与操作说明（delete 标红并明示「移入回收站」）。底部
// 「应用所选 / 全部选择 / 放弃」。组件纯展示 + 回调，决策状态留在 AiPanel。

import { memo, useMemo, useState } from "react";
import { diffText } from "../lib/diff";
import { basename } from "../lib/path-shim";
import type { ChangeOperation, ChangePlan } from "../lib/agent/types";
import { ChevronRightIcon, CloseIcon, TrashIcon } from "./icons";

interface Props {
  plan: ChangePlan;
  /** 当前笔记的工作副本 key（normPath 或 CURRENT_KEY）：分组排最前并打标）。 */
  currentKey: string;
  /** opId → 是否勾选。 */
  decisions: Record<string, boolean>;
  onToggle: (opId: string) => void;
  onSetAll: (accept: boolean) => void;
  onApply: () => void;
  onCancel: () => void;
}

/** 单个 edit op 的行内 diff（懒计算——展开才算）。 */
function EditDiff({ op }: { op: Extract<ChangeOperation, { kind: "edit" }> }) {
  const hunks = useMemo(() => diffText(op.oldText, op.newText), [op]);
  if (hunks.length === 0) {
    return <div className="apr-diff-empty">新旧文本相同。</div>;
  }
  return (
    <div className="apr-diff">
      {hunks.map((h, i) => (
        <div key={i} className="apr-diff-hunk">
          {h.origLines.slice(0, 3).map((l, j) => (
            <div key={`o${j}`} className="diff-line diff-line-orig">
              <span className="diff-line-prefix" aria-hidden="true">-</span>
              <span className="diff-line-text">{l || "（空行）"}</span>
            </div>
          ))}
          {h.origLines.length > 3 && <div className="diff-more">…另有 {h.origLines.length - 3} 行</div>}
          {h.newLines.slice(0, 3).map((l, j) => (
            <div key={`n${j}`} className="diff-line diff-line-new">
              <span className="diff-line-prefix" aria-hidden="true">+</span>
              <span className="diff-line-text">{l || "（空行）"}</span>
            </div>
          ))}
          {h.newLines.length > 3 && <div className="diff-more">…另有 {h.newLines.length - 3} 行</div>}
        </div>
      ))}
    </div>
  );
}

const KIND_LABEL: Record<ChangeOperation["kind"], string> = {
  edit: "编辑",
  append: "追加",
  create: "新建",
  rename: "重命名",
  delete: "删除",
};

interface OpRowProps {
  op: ChangeOperation;
  on: boolean;
  isCurrent: boolean;
  onToggle: (opId: string) => void;
}

const OpRow = memo(function OpRow({ op, on, isCurrent, onToggle }: OpRowProps) {
  const [expanded, setExpanded] = useState(false);
  const isDelete = op.kind === "delete";
  const path = op.kind === "rename" ? op.fromPath : op.path;
  const detail = op.kind === "rename" ? `${op.fromPath} → ${op.toPath}` : path;
  const preview =
    op.kind === "append"
      ? op.text
      : op.kind === "create"
        ? op.content
        : null;

  return (
    <div className={`apr-op${on ? "" : " off"}${isDelete ? " apr-op-danger" : ""}`}>
      <div className="apr-op-head">
        <label className="apr-check" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={on} onChange={() => onToggle(op.opId)} />
        </label>
        <button
          className="apr-op-main"
          onClick={() => (op.kind === "edit" || preview ? setExpanded((v) => !v) : undefined)}
          title={detail}
        >
          <span className={`apr-op-kind${isDelete ? " danger" : ""}`}>
            {isDelete && <TrashIcon size={10} />} {KIND_LABEL[op.kind]}
          </span>
          <span className="apr-op-title">
            {op.title}
            {isCurrent && <span className="apr-op-tag">当前笔记</span>}
          </span>
          {isDelete && <span className="apr-op-note">移入回收站（可恢复）</span>}
          {(op.kind === "edit" || preview) && (
            <span className="apr-op-caret">
              <ChevronRightIcon size={11} className={`chevron${expanded ? " open" : ""}`} />
            </span>
          )}
        </button>
      </div>
      {expanded && op.kind === "edit" && <EditDiff op={op} />}
      {expanded && preview && (
        <div className="apr-op-preview">
          <pre>{preview.length > 2000 ? preview.slice(0, 2000) + "\n…（截断）" : preview}</pre>
        </div>
      )}
    </div>
  );
});

export const AgentPlanReview = memo(function AgentPlanReview({
  plan,
  currentKey,
  decisions,
  onToggle,
  onSetAll,
  onApply,
  onCancel,
}: Props) {
  // 按文件分组（保持 plan 顺序）；当前笔记组排最前。
  const groups = useMemo(() => {
    const keyOf = (op: ChangeOperation): string =>
      op.kind === "rename" ? op.fromPath : op.path;
    const map = new Map<string, ChangeOperation[]>();
    for (const op of plan.ops) {
      const k = keyOf(op);
      const list = map.get(k);
      if (list) list.push(op);
      else map.set(k, [op]);
    }
    const sorted = [...map.entries()];
    sorted.sort((a, b) => {
      const ac = a[0] === currentKey ? 0 : 1;
      const bc = b[0] === currentKey ? 0 : 1;
      return ac - bc;
    });
    return sorted;
  }, [plan, currentKey]);

  const selected = plan.ops.filter((op) => decisions[op.opId]).length;

  return (
    <div className="apr">
      <div className="diff-head">
        <span className="diff-title">
          改动清单
          <span className="diff-count">
            共 {plan.ops.length} 条 · 已选 {selected} 条
          </span>
        </span>
        <div className="diff-head-actions">
          <button className="diff-mini" onClick={() => onSetAll(true)} title="全选">
            全选
          </button>
          <button className="diff-mini" onClick={() => onSetAll(false)} title="全不选">
            全不选
          </button>
          <button className="diff-close" title="放弃全部改动" onClick={onCancel}>
            <CloseIcon size={13} />
          </button>
        </div>
      </div>
      <div className="diff-mode-tag">Agent 的改动均未落盘——勾选后才应用；删除走系统回收站</div>

      <div className="apr-list">
        {groups.map(([path, ops]) => (
          <div key={path} className="apr-group">
            <div className="apr-group-head" title={path}>
              {basename(path) || "当前笔记"}
              <span className="apr-group-count">{ops.length} 条</span>
            </div>
            {ops.map((op) => (
              <OpRow
                key={op.opId}
                op={op}
                on={!!decisions[op.opId]}
                isCurrent={path === currentKey}
                onToggle={onToggle}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="diff-foot">
        <span className="diff-hint">应用后当前笔记可 Ctrl+Z 撤销；其余文件直接写盘</span>
        <button className="diff-apply" disabled={selected === 0} onClick={onApply}>
          应用 {selected} 条改动
        </button>
      </div>
    </div>
  );
});
