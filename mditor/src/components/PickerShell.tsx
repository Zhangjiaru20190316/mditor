// 选择器共享外壳（N19 重构）：QuickSwitcher / CitationPicker 此前各持一份
// 近乎逐行重复的「弹层骨架」——overlay（closing 类切换 + 点击关闭）+
// panel（阻断冒泡）+ 输入行（前缀 / 输入框 / 关闭钮）+ ↑↓/Enter/Esc 键盘
// 导航 + [data-idx] scrollIntoView + 打开后 30ms 聚焦定时器 +
// useDelayedUnmount(180ms) 退场时序。本组件只抽骨架；列表区 / 提示 /
// 底栏经 render prop（{ sel, setSel, listRef }）回到消费者，保证两处
// DOM 结构与类名和抽取前逐字节一致（styles/ 不感知本次重构）。
//
// 职责边界：外壳持有 sel（open 置 true 或 inputValue 变化时归零）、聚焦
// 与退场时序；消费者持有查询串与数据源（QuickSwitcher 的 `>` 命令模式
// 改写——显示 query.slice(1)、回填 ">"+v——留在消费者侧，外壳只看到
// 改写后的 inputValue）。

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useDelayedUnmount } from "../hooks/useDelayedUnmount";
import { CloseIcon } from "./icons";

/** 退场动画时长（与 .qs-overlay 的 closing 过渡一致）。 */
const EXIT_MS = 180;

/** render prop 注入：当前选中下标、选中写入（条目 hover/点击用）与列表
 *  容器 ref（外壳据此做 [data-idx] scrollIntoView）。ref 类型用
 *  RefObject<HTMLDivElement>——useRef<HTMLDivElement | null>(null) 的返回
 *  可直接赋入且满足 div 的 ref 属性（RefObject<HTMLDivElement | null> 会
 *  被 TS 的 variance 推断拒掉，尽管结构等价）。 */
export interface PickerListApi {
  sel: number;
  setSel: (i: number) => void;
  listRef: RefObject<HTMLDivElement>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** overlay 的 aria-label（快速切换 / 插入引用）。 */
  ariaLabel: string;
  /** 输入框前缀符号（› / > / @）。 */
  prefix: string;
  /** 输入框 placeholder。 */
  placeholder: string;
  /** 受控输入值（输入框显示什么）；QuickSwitcher 命令模式下为 query.slice(1)。 */
  inputValue: string;
  /** 输入变化（用户敲了什么）；命令模式回填 ">"+v 由消费者完成。 */
  onInputValueChange: (v: string) => void;
  /** 当前候选条数：键盘导航上界 + 滚动跟随 effect 的依赖。 */
  count: number;
  /** Enter 确认（入参为当前选中下标；越界/空结果由消费者兜底）。 */
  onConfirm: (index: number) => void;
  /** 中部内容（列表 / 提示 / 底栏），接收 { sel, setSel, listRef }。 */
  children: (api: PickerListApi) => ReactNode;
}

// 不 memo：消费者（QuickSwitcher / CitationPicker）已整体 memo，且
// children render prop 每次渲染都是新引用，外壳自身再 memo 只剩开销。
export function PickerShell({
  open,
  onClose,
  ariaLabel,
  prefix,
  placeholder,
  inputValue,
  onInputValueChange,
  count,
  onConfirm,
  children,
}: Props) {
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const mounted = useDelayedUnmount(open, EXIT_MS);

  // 打开时：选中归零 + 等一拍（挂载/入场）后聚焦输入框；关闭/卸载清定时器。
  useEffect(() => {
    if (!open) return;
    setSel(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  // 输入变化 → 选中归零（候选序列已换，旧下标失去意义）。
  useEffect(() => {
    setSel(0);
  }, [inputValue]);

  // 选择变化时滚动进视野（count 进依赖：结果集整体替换后同样对齐）。
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel, count]);

  if (!mounted) return null;

  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setSel((s) => Math.min(s + 1, count - 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      onConfirm(sel);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className={`qs-overlay${open ? "" : " closing"}`}
      onClick={onClose}
      role="dialog"
      aria-label={ariaLabel}
    >
      <div className="qs-panel" onClick={(e) => e.stopPropagation()}>
        <div className="qs-input-row">
          <span className="qs-prefix">{prefix}</span>
          <input
            ref={inputRef}
            className="qs-input"
            value={inputValue}
            placeholder={placeholder}
            onChange={(e) => onInputValueChange(e.target.value)}
            onKeyDown={onKey}
          />
          <button className="qs-x" title="关闭 (Esc)" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
        </div>
        {children({ sel, setSel, listRef })}
      </div>
    </div>
  );
}
