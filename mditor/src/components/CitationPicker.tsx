// 引用选择器（模块 3）：按 title / author / citekey / year 检索文献库条目，
// 回车/点击插入 `[@citekey]` 到光标处。数据来自 lib/bibliography 共享单例
// （设置里的 .bib 路径加载）；空库时提示到设置中配置文献库。
//
// 弹层骨架（overlay / 输入行 / 键盘导航 / 滚动跟随 / 退场时序）在
// PickerShell（N19 重构）；本组件只保留文献检索与条目渲染。

import { memo, useEffect, useMemo, useState } from "react";
import { bibFieldText, type BibEntry } from "../lib/bibtex";
import { bibliography } from "../lib/bibliography";
import { authorShort } from "../lib/citation";
import { PickerShell } from "./PickerShell";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 选中条目后插入（App 侧经 editorRef.insertAtCursor 落盘）。 */
  onInsert: (raw: string) => void;
}

const MAX_RESULTS = 20;

export const CitationPicker = memo(function CitationPicker({ open, onClose, onInsert }: Props) {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<BibEntry[]>(() => bibliography.all());
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setEntries(bibliography.all());
    const un = bibliography.subscribe(() => {
      setEntries(bibliography.all());
      setTick((t) => t + 1);
    });
    return () => {
      un();
    };
  }, [open]);

  const results = useMemo(
    () => (open ? bibliography.search(query, MAX_RESULTS) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- entries 是文献库版本变化的重渲染信号（search 读单例实时数据）
    [query, open, entries]
  );

  const pick = (i: number) => {
    const e = results[i];
    if (!e) return;
    onInsert(`[@${e.key}]`);
    onClose();
  };

  const errors = bibliography.getErrors();

  return (
    <PickerShell
      open={open}
      onClose={onClose}
      ariaLabel="插入引用"
      prefix="@"
      placeholder="搜索标题 / 作者 / citekey / 年份…"
      inputValue={query}
      onInputValueChange={setQuery}
      count={results.length}
      onConfirm={pick}
    >
      {({ sel, setSel, listRef }) => (
        <>
          <div className="qs-list" ref={listRef}>
            {results.length === 0 && (
              <div className="qs-empty">
                {entries.length === 0
                  ? "文献库为空——请在「设置 → 知识功能」中配置 .bib 文件路径"
                  : "无匹配条目"}
              </div>
            )}
            {results.map((e, i) => (
              <div
                key={e.key}
                data-idx={i}
                className={`qs-item cp-item${i === sel ? " sel" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => pick(i)}
              >
                <span className="cp-key">{e.key}</span>
                <span className="cp-title" title={bibFieldText(e, "title")}>
                  {bibFieldText(e, "title") || "（无标题）"}
                </span>
                <span className="cp-meta">
                  {authorShort(e)} · {bibFieldText(e, "year") || "n.d."} · {e.type}
                </span>
              </div>
            ))}
          </div>

          {errors.length > 0 && (
            <div className="cp-warn" title={errors.join("\n")}>
              文献库有 {errors.length} 处解析告警（坏条目已跳过）
            </div>
          )}

          <div className="qs-foot">
            <span>↑↓ 选择 · Enter 插入 · Esc 关闭</span>
            <span className="qs-stat">{entries.length} 条文献</span>
          </div>
        </>
      )}
    </PickerShell>
  );
});
