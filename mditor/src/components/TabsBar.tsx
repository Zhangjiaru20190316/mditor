// 文档标签栏（V3.6 多标签页）。仅当打开 ≥2 个标签时渲染（单文档不占空间，
// 与此前的单文档形态完全一致）。
//
// 交互：点击切换；中键 / × 关闭；未保存显示圆点（替代 ×，hover 时 × 回归，
// 与浏览器一致）。React.memo：props 均为稳定引用或小数组，打字期间的 App
// 重渲染不会穿透到这里（tabs 数组仅在标签/保存/脏状态变化时更新）。

import { memo } from "react";
import type { TabItem } from "../types";
import { CloseIcon, MarkdownFileIcon } from "./icons";

interface Props {
  tabs: TabItem[];
  activeKey: string;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
}

export const TabsBar = memo(function TabsBar({
  tabs,
  activeKey,
  onActivate,
  onClose,
}: Props) {
  if (tabs.length < 2) return null;
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
    </div>
  );
});
