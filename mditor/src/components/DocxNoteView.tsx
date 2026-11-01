// 多格式笔记（MF 轮）：Word(.docx) 应用内只读视图（M3，docx-preview）。
//
// 版式预览：docx-preview 渲染进离屏容器 → 输出 HTML/CSS 过 exportSanitize
// 消毒闸门（S10 红线：所有新渲染路径必过）→ 拼完整文档经 iframe srcdoc 注入
// 沙箱（sandbox=""——纯静态渲染，零脚本零同源，杜绝 docx 样式污染主文档；
// 图片走 useBase64URL 内联，srcdoc 沙箱内可加载）。
// 版式渲染失败（不支持的特性/损坏）→ 回退 mammoth 语义 HTML（同样消毒），
// 顶栏提示「已切换结构预览」。
//
// 只读视图对象：不进编辑器/useFile/docCache/批注/RAG 全套。docx-preview 与
// mammoth 全部懒加载（动态 import 收在组件 effect 内，首屏 bundle 零增量）。

import { memo, useCallback, useEffect, useState } from "react";
import { getAdapter } from "../platform";
import { noteOpError } from "../lib/opDebug";
import { readDocNoteBytes, loadMammoth } from "../lib/docNote";
import { sanitizeExportHtml } from "../lib/exportSanitize";
import { ExpandIcon, DocxFileIcon, RefreshIcon } from "./icons";

interface Props {
  /** Word 笔记磁盘绝对路径。 */
  path: string;
  /** 用系统应用打开（App 注入 openExternalNote 封装，稳定引用）。 */
  onOpenExternal: (path: string) => void;
  /** 转为 Markdown 笔记（M3：视图顶栏入口）。 */
  onConvertToMarkdown?: (path: string) => void;
  /** DE 轮：编辑态激活（App 按 TabItem.docEdit 注入）。 */
  editActive?: boolean;
  /** DE 轮：进入结构化编辑模式（门控 caps.docNoteEdit 内可见）。 */
  onEnterEdit?: (path: string) => void | Promise<void>;
  /** DE 轮：退出编辑（脏编辑时 App 侧确认；返回 false = 取消退出）。 */
  onExitEdit?: (path: string) => Promise<boolean> | void;
}

/** 完整 srcdoc 文档（消毒后的 body HTML；<style> 在 body 内是合法 HTML5，
 *  docx-preview 的页样式随之注入沙箱）。 */
function buildSrcdoc(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}</style></head><body>${bodyHtml}</body></html>`;
}

export const DocxNoteView = memo(function DocxNoteView({
  path,
  onOpenExternal,
  onConvertToMarkdown,
  editActive,
  onEnterEdit,
  onExitEdit,
}: Props) {
  const caps = getAdapter().capabilities;
  const [missing, setMissing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [mode, setMode] = useState<"loading" | "layout" | "structure" | "error">(
    "loading"
  );
  const [srcdoc, setSrcdoc] = useState("");

  // 文件存在性探测：对齐 PdfNoteView / HtmlNoteView 的 missing 探测。
  useEffect(() => {
    let alive = true;
    setMissing(false);
    getAdapter()
      .fs.exists(path)
      .then((ok) => {
        if (alive) setMissing(!ok);
      })
      .catch(() => {
        /* 探测失败不拦渲染，交给加载错误态 */
      });
    return () => {
      alive = false;
    };
  }, [path, reloadKey]);

  // 渲染管线（path / reloadKey 驱动）：docx-preview 版式 → mammoth 结构降级。
  useEffect(() => {
    if (!caps.docxNoteView) return;
    let cancelled = false;
    setMode("loading");
    setSrcdoc("");
    void (async () => {
      try {
        const bytes = await readDocNoteBytes(path, reloadKey > 0);
        if (cancelled) return;
        try {
          // ① 版式预览（docx-preview 沙箱渲染）。离屏容器渲染 → 消毒 → srcdoc。
          const { renderAsync } = await import("docx-preview");
          const holder = document.createElement("div");
          await renderAsync(bytes, holder, undefined, {
            inWrapper: true,
            breakPages: true,
            ignoreLastRenderedPageBreak: false,
            experimental: true,
            useBase64URL: true, // srcdoc 沙箱为 opaque origin，blob: 不可用
          });
          if (cancelled) return;
          setSrcdoc(buildSrcdoc(sanitizeExportHtml(holder.innerHTML)));
          setMode("layout");
        } catch (layoutErr) {
          // ② 结构预览降级（mammoth 语义 HTML，同样过消毒闸门）。
          noteOpError("docx-layout-preview", layoutErr);
          const mammoth = await loadMammoth();
          const ab = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength
          ) as ArrayBuffer;
          const res = await mammoth.convertToHtml({ arrayBuffer: ab });
          if (cancelled) return;
          setSrcdoc(buildSrcdoc(sanitizeExportHtml(res.value)));
          setMode("structure");
        }
      } catch (e) {
        if (cancelled) return;
        noteOpError("docx-note-open", e);
        setMode("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, reloadKey, caps.docxNoteView]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // 能力位降级（harmony 未真机验证）：不假成功。
  if (!caps.docxNoteView) {
    return (
      <div className="doc-note-view is-degraded">
        <DocxFileIcon size={28} />
        <p className="doc-note-title">{path}</p>
        <p>当前平台暂不支持应用内预览 Word 文档（预览能力待真机验证）。</p>
        <button className="doc-note-btn" onClick={() => onOpenExternal(path)}>
          用系统应用打开
        </button>
      </div>
    );
  }

  if (missing) {
    return (
      <div className="doc-note-view is-degraded">
        <DocxFileIcon size={28} />
        <p className="doc-note-title">{path}</p>
        <p>文件不存在或已被移动。</p>
        <button className="doc-note-btn" onClick={() => onOpenExternal(path)}>
          用系统应用打开
        </button>
      </div>
    );
  }

  if (mode === "error") {
    return (
      <div className="doc-note-view is-degraded">
        <DocxFileIcon size={28} />
        <p className="doc-note-title">{path}</p>
        <p>打开 Word 文档失败（文件损坏或不是有效的 .docx）。</p>
        <div className="doc-note-actions">
          <button className="doc-note-btn" onClick={reload}>
            重试
          </button>
          <button className="doc-note-btn" onClick={() => onOpenExternal(path)}>
            用系统应用打开
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="doc-note-view">
      <div className="doc-note-bar">
        <DocxFileIcon size={14} className="doc-note-bar-icon" />
        <span className="doc-note-path" title={path}>
          {path}
        </span>
        <span className="doc-note-hint">
          {editActive
            ? "编辑模式（占位——结构化编辑面随 M2 交付）"
            : mode === "structure"
              ? "版式预览不可用，已切换结构预览"
              : mode === "loading"
                ? "加载中…"
                : "版式预览"}
        </span>
        {editActive ? (
          <button
            className="doc-note-btn"
            title="退出编辑模式（未保存的编辑将丢弃，需确认）"
            onClick={() => void onExitEdit?.(path)}
          >
            退出编辑
          </button>
        ) : (
          caps.docNoteEdit &&
          onEnterEdit && (
            <button
              className="doc-note-btn"
              title="进入结构化编辑模式（版式将按 mditor 样式重新生成）"
              onClick={() => void onEnterEdit(path)}
            >
              编辑
            </button>
          )
        )}
        <button className="doc-note-btn" title="重新加载" onClick={reload}>
          <RefreshIcon size={13} />
        </button>
        {onConvertToMarkdown && (
          <button
            className="doc-note-btn"
            title="转为 Markdown 笔记（标题/列表/表格/图片保留；版式丢失）"
            onClick={() => onConvertToMarkdown(path)}
          >
            转 Markdown
          </button>
        )}
        <button className="doc-note-btn" title="用系统应用打开" onClick={() => onOpenExternal(path)}>
          <ExpandIcon size={13} />
        </button>
      </div>
      {mode === "loading" ? (
        <div className="pdf-note-overlay">
          <span className="pdf-note-spinner" aria-hidden="true" />
          加载中…
        </div>
      ) : (
        // sandbox=""：全限制沙箱（无脚本无同源）——纯静态渲染，样式/图片
        // （data URL）照常工作，样式泄露与脚本执行双双不可能。
        <iframe
          key={`${path}#${reloadKey}#${mode}`}
          srcDoc={srcdoc}
          sandbox=""
          title={path}
          className="docx-frame"
        />
      )}
    </div>
  );
});
