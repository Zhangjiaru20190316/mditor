// 快速切换器（Ctrl+P）：模糊搜索全库索引的文件名/标题，按最近打开加权
// 排序，回车跳转。数据来自 lib/vaultIndex 的共享索引；`>` 前缀预留命令
// 面板语义（本期只实现跳转，输入 > 显示提示）。
//
// 性能约束（验收）：输入到出结果 <50ms——rankEntry 为单遍线性扫描
// （1000 条目实测 <2ms），结果截断 30 条渲染。

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { vaultIndex, rankEntry, type RankContext, type VaultEntry, type VaultStats } from "../lib/vaultIndex";
import { loadRecent } from "../lib/store";
import { useDelayedUnmount } from "../hooks/useDelayedUnmount";
import { toPosix } from "../lib/path-shim";
import { CloseIcon } from "./icons";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 选中文件后打开（App 的 openPath）。 */
  onOpen: (path: string) => void;
}

const EXIT_MS = 180;
const MAX_RESULTS = 30;

export const QuickSwitcher = memo(function QuickSwitcher({ open, onClose, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  // 索引快照：订阅共享单例的变更通知（版本 bump）后重拉；vaultIndex 是
  // 模块级单例而非 React 状态，快照化才能参与 memo 渲染。
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [stats, setStats] = useState<VaultStats>(() => vaultIndex.stats());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const mounted = useDelayedUnmount(open, EXIT_MS);
  const openedAtRef = useRef<Map<string, number>>(new Map());

  const refresh = () => {
    setEntries(vaultIndex.entries());
    setStats(vaultIndex.stats());
  };

  // 打开时：聚焦 + 拉一次最近打开数据（recency 加权用）+ 订阅索引变更。
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSel(0);
    openedAtRef.current = new Map();
    void loadRecent()
      .then((list) => {
        const m = new Map<string, number>();
        for (const r of list) {
          try {
            m.set(toPosix(r.path).toLowerCase(), Date.parse(r.openedAt) || 0);
          } catch {
            /* 坏时间戳跳过 */
          }
        }
        openedAtRef.current = m;
        refresh();
      })
      .catch(() => undefined);
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    const un = vaultIndex.subscribe(refresh);
    refresh();
    return () => {
      window.clearTimeout(t);
      un();
    };
  }, [open]);

  const isCommandMode = query.startsWith(">");
  const results = useMemo(() => {
    if (isCommandMode || !open) return [];
    const q = query.trim();
    const ctx: RankContext = { openedAt: openedAtRef.current, now: Date.now() };
    return entries
      .map((e) => ({ e, s: rankEntry(q, e, ctx) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.e.path.localeCompare(b.e.path))
      .slice(0, MAX_RESULTS)
      .map((x) => x.e);
  }, [query, entries, isCommandMode, open]);

  // 选择变化时滚动进视野。
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel, results]);

  if (!mounted) return null;

  const pick = (i: number) => {
    const e = results[i];
    if (!e) return;
    onOpen(e.path);
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

  return (
    <div
      className={`qs-overlay${open ? "" : " closing"}`}
      onClick={onClose}
      role="dialog"
      aria-label="快速切换"
    >
      <div className="qs-panel" onClick={(e) => e.stopPropagation()}>
        <div className="qs-input-row">
          <span className="qs-prefix">{isCommandMode ? ">" : "›"}</span>
          <input
            ref={inputRef}
            className="qs-input"
            value={isCommandMode ? query.slice(1) : query}
            placeholder="搜索文件名或标题…（> 命令面板）"
            onChange={(e) => {
              const v = e.target.value;
              setQuery(isCommandMode ? ">" + v : v);
              setSel(0);
            }}
            onKeyDown={onKey}
          />
          <button className="qs-x" title="关闭 (Esc)" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
        </div>

        {isCommandMode ? (
          <div className="qs-list">
            <div className="qs-cmd-hint">命令面板即将推出——目前仅支持文件跳转。</div>
          </div>
        ) : (
          <div className="qs-list" ref={listRef}>
            {results.length === 0 && (
              <div className="qs-empty">
                {entries.length === 0
                  ? stats.scanning
                    ? "正在索引工作区…"
                    : "索引为空——请先打开一个工作区文件夹"
                  : "无匹配文件"}
              </div>
            )}
            {results.map((e, i) => (
              <div
                key={e.path}
                data-idx={i}
                className={`qs-item${i === sel ? " sel" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => pick(i)}
              >
                <span className="qs-title">{e.title}</span>
                <span className="qs-path" title={e.path}>
                  {trimRoot(e.path)}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="qs-foot">
          <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
          <span className="qs-stat">
            {stats.scanning
              ? `索引中 ${stats.done}/${stats.scanTotal}`
              : `${stats.total} 篇笔记`}
          </span>
        </div>
      </div>
    </div>
  );
});

/** 显示路径去掉工作区根前缀（保持原样当无法判断时）。 */
function trimRoot(path: string): string {
  const posix = toPosix(path);
  const i = posix.lastIndexOf("/");
  // 只留两层以内的尾部路径，避免过长。
  const parts = posix.split("/");
  const tail = parts.slice(Math.max(i - 1, 0)).join("/");
  return tail.length < posix.length ? "…" + tail : tail;
}
