// `[[` 输入补全弹层（v4.7 双链）：监听编辑器表面的 selectionchange，向
// EditorHandle.getWikiLinkContext 查询光标前是否存在未闭合的 `[[query`；
// 有则列出 vaultIndex 候选（<100ms），↑↓/Enter/Esc 键盘操作，选中后经
// insertWikiLinkAt 替换 `[[query` 为 `[[target]]` 原文（编辑器 remark 插件
// 随即解析为节点）。
//
// 定位：跟随光标的 getBoundingClientRect（selectionchange 时刷新）；失败
// 退化为编辑器容器上方居中。

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { vaultIndex, type VaultEntry } from "../lib/vaultIndex";
import { toPosix } from "../lib/path-shim";

interface Props {
  /** 编辑器是否就绪（未就绪时静默不弹）。 */
  isReady: () => boolean;
  getWikiLinkContext: () => { from: number; query: string } | null;
  /** 用 `md` 替换 [from, 光标)。 */
  insertWikiLinkAt: (md: string, from: number) => void;
  /** 功能开关（设置 wikiLinksEnabled）。 */
  enabled: boolean;
}

const MAX_ITEMS = 12;

interface SuggestState {
  from: number;
  query: string;
  items: VaultEntry[];
  sel: number;
  top: number;
  left: number;
}

export const WikiLinkSuggest = memo(function WikiLinkSuggest({
  isReady,
  getWikiLinkContext,
  insertWikiLinkAt,
  enabled,
}: Props) {
  const [st, setSt] = useState<SuggestState | null>(null);
  // 键盘拦截窗：弹层激活时吃掉 ↑↓/Enter/Esc（capture，避免编辑器先处理）。
  const stRef = useRef<SuggestState | null>(null);
  stRef.current = st;
  // pick 经 ref 调用：keydown effect 只在弹层开/关时挂卸，若直接捕获 pick，
  // 拿到的是 effect 运行那一帧的闭包（连带捕获当时的 insertWikiLinkAt 等
  // props）——编辑器重建、props 换引用后会过期。ref 保证每帧最新。
  const pickRef = useRef<(s: SuggestState, i: number) => void>(() => undefined);

  const close = useCallback(() => setSt(null), []);

  const refresh = useCallback(() => {
    if (!enabled || !isReady()) {
      setSt(null);
      return;
    }
    const ctx = getWikiLinkContext();
    if (!ctx) {
      setSt((prev) => (prev === null ? prev : null));
      return;
    }
    const items = vaultIndex.suggestTargets(ctx.query, MAX_ITEMS);
    // 光标坐标（尽力而为——拿不到就放编辑器上方）。
    let top = 0;
    let left = 0;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const rects = sel.getRangeAt(0).getClientRects();
      const r = rects.length > 0 ? rects[0] : sel.getRangeAt(0).getBoundingClientRect();
      top = r.bottom + 6;
      left = r.left;
    } else {
      const host = document.querySelector<HTMLElement>(".mditor-editor-host");
      if (host) {
        const b = host.getBoundingClientRect();
        top = b.top + 60;
        left = b.left + 40;
      }
    }
    setSt((prev) => {
      // 同一上下文（from/query 未变）且候选集完全一致 → 保持既有状态（防
      // 抖动闪烁）。条目按 path 逐一比对：仅比数量会把「同数量不同条目」
      // （索引更新/候选重排）误判为未变，弹层显示过期候选。
      if (
        prev &&
        prev.from === ctx.from &&
        prev.query === ctx.query &&
        prev.items.length === items.length &&
        prev.items.every((x, i) => x.path === items[i].path)
      ) {
        return prev;
      }
      return { from: ctx.from, query: ctx.query, items, sel: 0, top, left };
    });
  }, [enabled, isReady, getWikiLinkContext]);

  useEffect(() => {
    if (!enabled) return;
    const onSel = () => refresh();
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [enabled, refresh]);

  // 键盘：capture 阶段拦截，避免编辑器 keymap 先消费。effect 只依赖
  // 「弹层是否打开」；状态经 stRef、选中经 pickRef 读取，无过期闭包。
  const open = st != null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const s = stRef.current;
      if (!s) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setSt({ ...s, sel: Math.min(s.sel + 1, s.items.length - 1) });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSt({ ...s, sel: Math.max(s.sel - 1, 0) });
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        pickRef.current(s, s.sel);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  const pick = (s: SuggestState, i: number) => {
    const item = s.items[i];
    if (!item) {
      close();
      return;
    }
    const stem = stemLabel(item);
    insertWikiLinkAt(`[[${stem}]]`, s.from);
    close();
  };
  // 每 render 同步最新 pick（含其捕获的 props）——见 pickRef 处注释。
  pickRef.current = pick;

  if (!st || st.items.length === 0) return null;
  return (
    <div className="wls-pop" style={{ top: st.top, left: st.left }} role="listbox" aria-label="双链补全">
      {st.items.map((e, i) => (
        <div
          key={e.path}
          className={`wls-item${i === st.sel ? " sel" : ""}`}
          onMouseEnter={() => setSt({ ...st, sel: i })}
          onMouseDown={(ev) => {
            // mousedown（先于编辑器失焦 blur）落定，避免 selectionchange 抖动。
            ev.preventDefault();
            ev.stopPropagation();
            pick(st, i);
          }}
        >
          <span className="wls-title">{e.title}</span>
          <span className="wls-path" title={e.path}>
            {shortPath(e.path)}
          </span>
        </div>
      ))}
    </div>
  );
});

/** 插入文本：文件名去扩展名；剔除会破坏 [[…]] 语法的方括号字符
 *  （文件名允许包含它们，但双链语法不允许——防语法注入/破坏）。 */
function stemLabel(e: VaultEntry): string {
  const posix = toPosix(e.path);
  const base = posix.slice(posix.lastIndexOf("/") + 1).replace(/\.(md|markdown|mdx|mdown)$/i, "");
  return base.replace(/[[\]]/g, "");
}

function shortPath(p: string): string {
  const posix = toPosix(p);
  const parts = posix.split("/");
  return parts.length > 2 ? "…" + parts.slice(-2).join("/") : posix;
}
