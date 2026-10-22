// HTML 笔记应用内视图（HN 轮阶段 1）。
//
// 只读视图对象：iframe 加载 asset 协议 URL（独立 origin，不继承主窗 CSP），
// sandbox 不给 allow-same-origin（协议 origin + sandbox 双层隔离，见
// docs/html-note-spike-report.md）。内容零转换零消毒——交互完整性由隔离承担。
// capabilities.htmlNoteView 为 false 的平台（harmony 未验证）降级为
// 「用系统浏览器打开」提示页，沿用 multiWindow 的能力守卫模式。

import { memo, useCallback, useEffect, useState } from "react";
import { getAdapter } from "../platform";
import { assetFrameUrl, HTML_NOTE_SANDBOX } from "../lib/htmlNote";
import { ExpandIcon, HtmlFileIcon, RefreshIcon } from "./icons";

interface Props {
  /** HTML 笔记磁盘绝对路径。 */
  path: string;
  /** 用系统浏览器打开（App 注入 openExternal 封装，稳定引用）。 */
  onOpenExternal: (path: string) => void;
}

export const HtmlNoteView = memo(function HtmlNoteView({ path, onOpenExternal }: Props) {
  const caps = getAdapter().capabilities;
  const [reloadKey, setReloadKey] = useState(0);
  const [missing, setMissing] = useState(false);

  // 文件存在性探测：iframe 对「加载了空错误页」不可观测，用 fs.exists 区分
  // 「文件被移动/删除」与正常加载（scope 未授权场景同样表现为空白，提示文案
  // 一并指引）。
  useEffect(() => {
    let alive = true;
    setMissing(false);
    getAdapter()
      .fs.exists(path)
      .then((ok) => {
        if (alive) setMissing(!ok);
      })
      .catch(() => {
        /* 探测失败不拦渲染，交给 iframe 自身表现 */
      });
    return () => {
      alive = false;
    };
  }, [path, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // 能力位降级（harmony spike 未验证）：不挂 iframe，不假成功。
  if (!caps.htmlNoteView) {
    return (
      <div className="html-note-view is-degraded">
        <HtmlFileIcon size={28} />
        <p className="html-note-title">{path}</p>
        <p>当前平台暂不支持应用内打开 HTML 笔记（隔离能力待验证）。</p>
        <button className="html-note-btn" onClick={() => onOpenExternal(path)}>
          用系统浏览器打开
        </button>
      </div>
    );
  }

  if (missing) {
    return (
      <div className="html-note-view is-degraded">
        <HtmlFileIcon size={28} />
        <p className="html-note-title">{path}</p>
        <p>文件不存在或已被移动。</p>
        <button className="html-note-btn" onClick={() => onOpenExternal(path)}>
          用系统浏览器打开
        </button>
      </div>
    );
  }

  return (
    <div className="html-note-view">
      <div className="html-note-bar">
        <HtmlFileIcon size={14} className="html-note-bar-icon" />
        <span className="html-note-path" title={path}>
          {path}
        </span>
        <span className="html-note-hint">独立沙箱中运行</span>
        <button className="html-note-btn" title="重新加载" onClick={reload}>
          <RefreshIcon size={13} />
        </button>
        <button
          className="html-note-btn"
          title="用系统浏览器打开"
          onClick={() => onOpenExternal(path)}
        >
          <ExpandIcon size={13} />
        </button>
        {/* 阶段 2 占位（隐藏）：独立窗口查看 / 转为 Markdown */}
      </div>
      <iframe
        key={`${path}#${reloadKey}`}
        src={assetFrameUrl(path)}
        sandbox={HTML_NOTE_SANDBOX}
        title={path}
        className="html-note-frame"
      />
    </div>
  );
});
