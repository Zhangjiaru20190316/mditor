// 「转为 Markdown」对话框（HN 轮阶段 2）：读取 HTML 笔记 → turndown 转换
// → 预览（经 renderMarkdown 现有消毒管线渲染，进主 DOM 安全）→ 另存为 .md。
// 定位为可选工具：原 HTML 笔记不动，不改变「导入不转换」的主语义。

import { memo, useEffect, useState } from "react";
import { getAdapter } from "../platform";
import { convertHtmlToMarkdown } from "../lib/htmlToMarkdown";
import { MarkdownText } from "./MarkdownText";
import type { Theme } from "../types";

interface Props {
  open: boolean;
  /** 源 HTML 笔记绝对路径。 */
  path: string | null;
  theme: Theme;
  onClose: () => void;
  /** 另存成功（已落盘）→ App 打开新 md 笔记。 */
  onSaved: (mdPath: string) => void;
}

export const HtmlToMdDialog = memo(function HtmlToMdDialog({
  open,
  path,
  theme,
  onClose,
  onSaved,
}: Props) {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error"; msg: string } | { kind: "done"; md: string }
  >({ kind: "loading" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !path) return;
    let alive = true;
    setState({ kind: "loading" });
    getAdapter()
      .fs.readTextFile(path)
      .then((html) => convertHtmlToMarkdown(html))
      .then((md) => {
        if (alive) setState({ kind: "done", md });
      })
      .catch((e) => {
        if (alive) setState({ kind: "error", msg: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [open, path]);

  if (!open) return null;

  const save = async () => {
    if (state.kind !== "done" || !path) return;
    setSaving(true);
    try {
      const fileName = pathSplitName(path).replace(/\.[^.]+$/, "") + ".md";
      const target = await getAdapter().dialog.pickSaveFile(fileName, [
        { name: "Markdown", extensions: ["md"] },
      ]);
      if (!target) return;
      await getAdapter().fs.writeTextFile(target, state.md);
      onSaved(target);
      onClose();
    } catch (e) {
      setState({ kind: "error", msg: `另存失败：${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="htm-overlay" role="dialog" aria-label="转为 Markdown">
      <div className="htm-dialog">
        <div className="htm-head">
          <span className="htm-title">转为 Markdown</span>
          <span className="htm-sub">{path}</span>
          <button className="htm-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="htm-body">
          {state.kind === "loading" && <div className="htm-status">正在转换…</div>}
          {state.kind === "error" && <div className="htm-status htm-error">{state.msg}</div>}
          {state.kind === "done" && (
            <MarkdownText content={state.md} theme={theme} docPath={path} className="htm-preview" />
          )}
        </div>
        <div className="htm-foot">
          <span className="htm-note">原 HTML 笔记不会被修改</span>
          <button className="htm-btn" onClick={onClose}>
            取消
          </button>
          <button
            className="htm-btn primary"
            disabled={state.kind !== "done" || saving}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "另存为 .md"}
          </button>
        </div>
      </div>
    </div>
  );
});

function pathSplitName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? p : p.slice(i + 1);
}
