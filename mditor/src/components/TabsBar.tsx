// 文档标签栏（V3.6 多标签页）。仅当打开 ≥2 个标签时渲染（单文档不占空间，
// 与此前的单文档形态完全一致）。
//
// 交互：点击切换；中键 / × 关闭；未保存显示圆点（替代 ×，hover 时 × 回归，
// 与浏览器一致）。React.memo：props 均为稳定引用或小数组，打字期间的 App
// 重渲染不会穿透到这里（tabs 数组仅在标签/保存/脏状态变化时更新）。
//
// v4.1 点位动效：新标签挂载即淡入微扩（CSS tab-in，仅 transform/opacity）；
// 关闭标签保留 180ms 退场残影（.closing 淡出缩收）再移除——App 侧的
// 保存/确认逻辑不等动画、立即更新 tabs，残影只是视觉层；「无」档 /
// prefers-reduced-motion 下退场动画被全局 kill switch 压成瞬时，残影窗口
// 仅剩卸载时序。

import { memo, useEffect, useRef, useState } from "react";
import type { TabItem } from "../types";
import { CloseIcon, MarkdownFileIcon } from "./icons";

interface Props {
  tabs: TabItem[];
  activeKey: string;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
}

/** 关闭退场残影的保留时长（与 CSS tab-out 动画对齐）。 */
const GHOST_MS = 180;

export const TabsBar = memo(function TabsBar({
  tabs,
  activeKey,
  onActivate,
  onClose,
}: Props) {
  // 刚从 props.tabs 里消失、正在播退场动画的标签（按关闭前快照渲染）。
  const [ghosts, setGhosts] = useState<TabItem[]>([]);
  const prevTabsRef = useRef(tabs);
  const ghostTimersRef = useRef<number[]>([]);

  useEffect(() => {
    const prev = prevTabsRef.current;
    prevTabsRef.current = tabs;
    const alive = new Set(tabs.map((t) => t.key));
    const removed = prev.filter((t) => !alive.has(t.key));
    if (removed.length > 0) {
      setGhosts((gs) => [...gs.filter((g) => !alive.has(g.key)), ...removed]);
      for (const r of removed) {
        const id = window.setTimeout(() => {
          setGhosts((gs) => gs.filter((g) => g.key !== r.key));
        }, GHOST_MS);
        ghostTimersRef.current.push(id);
      }
    } else {
      // 外部同步收窄（如关闭最后一个标签回退未命名）：清掉已被复活的残影
      const revived = ghosts.some((g) => alive.has(g.key));
      if (revived) setGhosts((gs) => gs.filter((g) => !alive.has(g.key)));
    }
    // ghosts 经闭包读取最新值，避免把它列入依赖引起 effect 重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  // 卸载清残影定时器，杜绝卸载后 setState。
  useEffect(() => {
    const timers = ghostTimersRef.current;
    return () => {
      for (const id of timers) window.clearTimeout(id);
      timers.length = 0;
    };
  }, []);

  if (tabs.length < 2 && ghosts.length === 0) return null;

  return (
    <div className="tabbar" role="tablist" aria-label="打开的文档">
      {tabs.map((t) => {
        const active = t.key === activeKey;
        return (
          <div
            key={t.key}
            role="tab"
            aria-selected={active}
            className={`tabbar-tab${active ? " active" : ""}`}
            title={t.path ?? "未命名"}
            onClick={() => onActivate(t.key)}
            onMouseDown={(e) => {
              // 中键关闭（浏览器习惯）。
              if (e.button === 1) {
                e.preventDefault();
                onClose(t.key);
              }
            }}
          >
            <MarkdownFileIcon size={13} className="tabbar-tab-icon" />
            <span className="tabbar-tab-name">{t.name}</span>
            <button
              className={`tabbar-tab-close${t.dirty ? " dirty" : ""}`}
              title={t.dirty ? "关闭（有路径的标签会先自动保存）" : "关闭标签页"}
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.key);
              }}
            >
              {t.dirty && <span className="tabbar-tab-dot" />}
              <CloseIcon size={11} />
            </button>
          </div>
        );
      })}
      {/* 关闭退场残影：纯视觉，不响应交互、不参与 tablist 语义 */}
      {ghosts.map((t) => (
        <div key={`ghost-${t.key}`} className="tabbar-tab closing" aria-hidden="true">
          <MarkdownFileIcon size={13} className="tabbar-tab-icon" />
          <span className="tabbar-tab-name">{t.name}</span>
          <button className={`tabbar-tab-close${t.dirty ? " dirty" : ""}`} tabIndex={-1}>
            {t.dirty && <span className="tabbar-tab-dot" />}
            <CloseIcon size={11} />
          </button>
        </div>
      ))}
    </div>
  );
});
