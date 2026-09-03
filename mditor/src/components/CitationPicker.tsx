// 引用选择器（模块 3）：按 title / author / citekey / year 检索文献库条目，
// 回车/点击插入 `[@citekey]` 到光标处。数据来自 lib/bibliography 共享单例
// （设置里的 .bib 路径加载）；空库时提示到设置中配置文献库。

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { bibFieldText, type BibEntry } from "../lib/bibtex";
import { bibliography } from "../lib/bibliography";
import { authorShort } from "../lib/citation";
import { useDelayedUnmount } from "../hooks/useDelayedUnmount";
import { CloseIcon } from "./icons";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 选中条目后插入（App 侧经 editorRef.insertAtCursor 落盘）。 */
  onInsert: (raw: string) => void;
}

const EXIT_MS = 180;
const MAX_RESULTS = 20;

export const CitationPicker = memo(function CitationPicker({ open, onClose, onInsert }: Props) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [entries, setEntries] = useState<BibEntry[]>(() => bibliography.all());
  const [, setTick] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const mounted = useDelayedUnmount(open, EXIT_MS);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSel(0);
    setEntries(bibliography.all());
    const un = bibliography.subscribe(() => {
      setEntries(bibliography.all());
      setTick((t) => t + 1);
    });
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => {
      window.clearTimeout(t);
      un();
    };
  }, [open]);

  const results = useMemo(
    () => (open ? bibliography.search(query, MAX_RESULTS) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- entries 是文献库版本变化的重渲染信号（search 读单例实时数据）
    [query, open, entries]
  );

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel, results]);

  if (!mounted) return null;

  const pick = (i: number) => {
    const e = results[i];
    if (!e) return;
    onInsert(`[@${e.key}]`);
    onClose();
  };

  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      pick(sel);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      onClose();
    }
  };

  const errors = bibliography.getErrors();

  return (
    <div
      className={`qs-overlay${open ? "" : " closing"}`}
      onClick={onClose}
      role="dialog"
      aria-label="插入引用"
    >
      <div className="qs-panel" onClick={(e) => e.stopPropagation()}>
        <div className="qs-input-row">
          <span className="qs-prefix">@</span>
          <input
            ref={inputRef}
            className="qs-input"
            value={query}
            placeholder="搜索标题 / 作者 / citekey / 年份…"
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKey}
          />
          <button className="qs-x" title="关闭 (Esc)" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
        </div>

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
      </div>
    </div>
  );
});
