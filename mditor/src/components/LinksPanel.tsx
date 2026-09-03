// 反向链接 + 标签 面板（v4.7 知识功能，挂侧栏「链接」tab）。
//
// 数据全部来自 lib/vaultIndex（订阅版本刷新）；big 文档性能模式下的「延迟
// 加载」由侧栏 tab 的按需渲染天然满足（不打开不查询），查询本身为内存
// 线性扫（100 来源 <1ms，验收 <200ms）。上下文片段为链接行 ±1 行。

import { memo, useEffect, useMemo, useState } from "react";
import { vaultIndex, type Backlink, type VaultEntry } from "../lib/vaultIndex";

interface Props {
  /** 当前文档路径（未命名缓冲无反链）。 */
  path: string | null;
  /** 打开笔记（可带跳转行号）。 */
  onOpen: (path: string, line?: number) => void;
  /** 功能开关（无索引时显示引导文案）。 */
  enabled: boolean;
}

export const LinksPanel = memo(function LinksPanel({ path, onOpen, enabled }: Props) {
  const [, setTick] = useState(0);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  useEffect(() => vaultIndex.subscribe(() => setTick((t) => t + 1)), []);

  const backlinks = useMemo<Backlink[]>(
    () => (path ? vaultIndex.backlinksTo(path) : []),
    [path, vaultIndex.stats().version] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const tags = useMemo(
    () => vaultIndex.allTags(),
    [vaultIndex.stats().version] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const tagNotes = useMemo<VaultEntry[]>(
    () => (activeTag ? vaultIndex.notesWithTag(activeTag) : []),
    [activeTag, vaultIndex.stats().version] // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (!enabled) {
    return <div className="lp-empty">双链功能已在设置中关闭。</div>;
  }

  return (
    <div className="links-panel">
      <div className="lp-section">
        <div className="lp-head">
          反向链接
          {backlinks.length > 0 && <span className="lp-count">{backlinks.length}</span>}
        </div>
        {!path ? (
          <div className="lp-empty">未命名缓冲没有反向链接。</div>
        ) : backlinks.length === 0 ? (
          <div className="lp-empty">
            {vaultIndex.stats().total === 0 ? "索引为空——请先打开工作区文件夹" : "没有笔记链接到这里"}
          </div>
        ) : (
          <ul className="lp-list">
            {backlinks.map((b, i) => (
              <li
                key={`${b.source}:${b.link.line}:${i}`}
                className="lp-item"
                onClick={() => onOpen(b.source, b.link.line)}
                title={b.source}
              >
                <div className="lp-item-title">{b.sourceTitle}</div>
                <div className="lp-ctx">
                  {b.link.before && <span className="lp-ctx-line">{b.link.before}</span>}
                  <span className="lp-ctx-hit">{b.link.text}</span>
                  {b.link.after && <span className="lp-ctx-line">{b.link.after}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="lp-section">
        <div className="lp-head">
          标签
          {tags.length > 0 && <span className="lp-count">{tags.length}</span>}
        </div>
        {tags.length === 0 ? (
          <div className="lp-empty">在正文中用 空格#标签名 添加标签</div>
        ) : (
          <>
            <div className="lp-tags">
              {tags.map((t) => (
                <button
                  key={t.tag}
                  className={`lp-tag${activeTag === t.tag ? " active" : ""}`}
                  onClick={() => setActiveTag(activeTag === t.tag ? null : t.tag)}
                >
                  #{t.tag}
                  <span className="lp-tag-n">{t.count}</span>
                </button>
              ))}
            </div>
            {activeTag && (
              <ul className="lp-list">
                {tagNotes.length === 0 ? (
                  <li className="lp-empty">没有笔记带这个标签</li>
                ) : (
                  tagNotes.map((n) => (
                    <li
                      key={n.path}
                      className="lp-item"
                      onClick={() => onOpen(n.path)}
                      title={n.path}
                    >
                      <div className="lp-item-title">{n.title}</div>
                    </li>
                  ))
                )}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
});
