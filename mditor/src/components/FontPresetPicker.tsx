// 字体预设选择器（设置面板「外观」分区用）。
//
// 替代原生 <select>：弹出面板按分组展示预设，每行用该预设**自己的字体栈**渲染
// 名称与示例——内置 @font-face 字体（fonts.css）所见即所得，「字体设计感」直接
// 可见；其余系统栈预设尽力渲染（未装则回退）。带搜索与当前选中标记。
//
// 零第三方依赖：绝对定位面板 + document mousedown 关闭 + Esc 关闭。
// 注意：不能放进 Field 的 <label> 里——label 会把行点击转发给触发按钮造成
// 面板开合抖动，外层用 div.field 结构（样式同 Field，见 global.css）。

import { useEffect, useMemo, useRef, useState } from "react";
import type { FontPreset } from "../types";
import { CheckIcon, SearchIcon } from "./icons";

interface Props {
  presets: FontPreset[];
  /** 当前选中预设 id；"" = 自定义（字体栈被手动编辑过）。 */
  value: string;
  /** 预设未给 sample 时预览行用的示例文本（正文/代码各自不同）。 */
  defaultSample: string;
  ariaLabel: string;
  /** 选中预设：id + stack 一起写回（语义与旧 <select> 的 onChange 一致）。 */
  onSelect: (id: string, stack: string) => void;
  /** 选「自定义」：仅清空 fontPreset 记录，字体栈保持现状。 */
  onCustom: () => void;
}

export function FontPresetPicker({ presets, value, defaultSample, ariaLabel, onSelect, onCustom }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // 开面板时挂全局关闭监听；关面板时摘掉（并复位搜索词）。
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const { groups, current } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = q
      ? presets.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.id.toLowerCase().includes(q) ||
            (p.group ?? "").toLowerCase().includes(q)
        )
      : presets;
    // 分组顺序 = 预设数组里的首次出现顺序（数据即版式，不在组件里再定规则）。
    const order: string[] = [];
    const map = new Map<string, FontPreset[]>();
    for (const p of shown) {
      const g = p.group ?? "其他";
      if (!map.has(g)) {
        map.set(g, []);
        order.push(g);
      }
      map.get(g)!.push(p);
    }
    return { groups: order.map((g) => [g, map.get(g)!] as const), current: presets.find((p) => p.id === value) };
  }, [presets, query, value]);

  const pick = (e: React.MouseEvent, id: string, stack: string) => {
    // preventDefault：阻断外层（若有）label 把行点击转发给触发按钮。
    e.preventDefault();
    onSelect(id, stack);
    setOpen(false);
  };

  return (
    <div className="fpp" ref={rootRef}>
      <button
        type="button"
        className={`fpp-trigger${open ? " open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          if (!open) setQuery("");
          setOpen(!open);
        }}
      >
        {/* 名称用当前预设自己的字体渲染——关闭状态下也一眼可见字体气质。 */}
        <span className="fpp-trigger-name" style={{ fontFamily: current?.stack }}>
          {current ? current.name : "自定义"}
        </span>
        <span className="fpp-trigger-sub">
          {current ? current.group ?? "预设" : "手动字体栈"}
        </span>
        <svg className="fpp-caret" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="fpp-panel" role="listbox" aria-label={ariaLabel}>
          <div className="fpp-search">
            <SearchIcon size={12} />
            <input
              type="text"
              placeholder="搜索字体…"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="fpp-list">
            <div
              role="option"
              aria-selected={value === ""}
              className={`fpp-row${value === "" ? " active" : ""}`}
              onClick={(e) => {
                e.preventDefault();
                onCustom();
                setOpen(false);
              }}
            >
              <span className="fpp-row-name">自定义</span>
              <span className="fpp-row-sample">手动编辑字体栈</span>
              {value === "" && <CheckIcon size={13} className="fpp-check" />}
            </div>
            {groups.map(([group, items]) => (
              <div key={group} className="fpp-group">
                <div className="fpp-group-label">{group}</div>
                {items.map((p) => (
                  <div
                    key={p.id}
                    role="option"
                    aria-selected={p.id === value}
                    className={`fpp-row${p.id === value ? " active" : ""}`}
                    onClick={(e) => pick(e, p.id, p.stack)}
                  >
                    <span className="fpp-row-name" style={{ fontFamily: p.stack }}>
                      {p.name}
                      {p.bundled && <em className="fpp-badge">内置</em>}
                    </span>
                    <span className="fpp-row-sample" style={{ fontFamily: p.stack }}>
                      {p.sample ?? defaultSample}
                    </span>
                    {p.id === value && <CheckIcon size={13} className="fpp-check" />}
                  </div>
                ))}
              </div>
            ))}
            {groups.length === 0 && (
              <div className="fpp-empty">没有匹配「{query.trim()}」的预设</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
