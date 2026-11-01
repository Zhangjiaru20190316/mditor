// 多格式笔记（MF 轮）：Word(.docx) 应用内只读视图（M3，docx-preview）。
// DE 轮 M2：只读标签内一键进入「结构化编辑模式」——mammoth 语义 HTML（图片
// data URL 内联，docNote.convertDocxForEdit：消毒 + 表格三步预处理）→
// 独立 Milkdown Crepe 实例（懒加载，主编辑器零接触）。切走标签时
// getHTML() 序列化进 docNoteEdit 状态机（标签保持编辑态与 dirty）；切回
// 重水合（缓冲同样过预处理——spike④：Crepe 序列化的表格也包 <p>）。
// 保存由 App 统一编排（docNoteSave 另存/替换），视图只注册命令句柄。
//
// 版式预览（MF 轮原样）：docx-preview 渲染进离屏容器 → 输出 HTML/CSS 过
// exportSanitize 消毒闸门（S10）→ iframe srcdoc 沙箱；失败回退 mammoth
// 结构预览。
//
// 保真边界（任务书 §4.1，UI 明示不静默）：保存产物是重新生成的 docx
// （mditor 导出样式），不是原样式回写；表格合并单元格平铺、分页符/文本框/
// SmartArt 仅文字保留。

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { getAdapter } from "../platform";
import { noteOpError } from "../lib/opDebug";
import {
  convertDocxForEdit,
  preprocessMammothHtmlForEdit,
  readDocNoteBytes,
  loadMammoth,
} from "../lib/docNote";
import { beginEditing, resumeDocEdit, suspendDocEdit, type DocEditHandle } from "../lib/docNoteEdit";
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
  /** DE 轮 M2：编辑面命令句柄注册（挂载注册 / 卸载注销）。 */
  onRegisterEditHandle?: (path: string, handle: DocEditHandle | null) => void;
  /** DE 轮 M2：编辑面 → TabItem.dirty 回写。 */
  onDirtyChange?: (path: string, dirty: boolean) => void;
  /** DE 轮 M2：保存（另存「原名 (编辑版)」）请求。 */
  onRequestSave?: (path: string) => void;
  /** DE 轮 M2：替换原件请求（App 侧二次确认）。 */
  onRequestReplace?: (path: string) => void | Promise<void>;
  /** DE 轮 M2：保存成功令牌（递增触发视图清态/重载预览）。 */
  savedToken?: number;
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
  onRegisterEditHandle,
  onDirtyChange,
  onRequestSave,
  onRequestReplace,
  savedToken,
}: Props) {
  const caps = getAdapter().capabilities;
  const [missing, setMissing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [mode, setMode] = useState<"loading" | "layout" | "structure" | "error">(
    "loading"
  );
  const [srcdoc, setSrcdoc] = useState("");

  // ---- DE 轮 M2：编辑面状态 ----------------------------------------------------
  const [editPhase, setEditPhase] = useState<"converting" | "ready" | "error">("converting");
  const [spanNotice, setSpanNotice] = useState(false);
  const editHostWrapRef = useRef<HTMLDivElement | null>(null);

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
  // 编辑态挂起预览（编辑面取代 iframe；退出编辑/保存后重载恢复）。
  useEffect(() => {
    if (!caps.docxNoteView || editActive) return;
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
  }, [path, reloadKey, caps.docxNoteView, editActive]);

  // 编辑面挂载/卸载（editActive 驱动；切走标签 = 卸载 = 序列化缓冲保态）。
  useEffect(() => {
    if (!editActive) return;
    let cancelled = false;
    let host: HTMLDivElement | null = null;
    let getHtml: (() => string) | null = null;
    let inst: { destroy(): Promise<void>; editor: { action: (a: unknown) => string } } | null = null;
    const onInput = () => onDirtyChange?.(path, true);
    setEditPhase("converting");
    void (async () => {
      try {
        const { convertHtmlToMarkdown } = await import("../lib/htmlToMarkdown");
        let md: string;
        const st = resumeDocEdit(path);
        if (st?.htmlBuffer) {
          // 切回重水合：缓冲 HTML 同样过表格预处理（spike④ 配方）。
          md = await convertHtmlToMarkdown(preprocessMammothHtmlForEdit(st.htmlBuffer).html);
        } else {
          const r = await convertDocxForEdit(path);
          md = r.markdown;
          setSpanNotice(r.flattenedSpans);
        }
        if (cancelled) return;
        const [{ Crepe }, { getHTML }] = await Promise.all([
          import("@milkdown/crepe"),
          import("@milkdown/utils"),
        ]);
        if (cancelled) return;
        const wrap = editHostWrapRef.current;
        if (!wrap) return;
        host = document.createElement("div");
        host.className = "docx-edit-host";
        wrap.appendChild(host);
        const crepe = new Crepe({
          root: host,
          defaultValue: md,
          features: {
            [Crepe.Feature.TopBar]: false,
            [Crepe.Feature.Toolbar]: false,
            [Crepe.Feature.AI]: false,
          },
        });
        await crepe.create();
        if (cancelled) {
          void crepe.destroy().catch(() => undefined);
          return;
        }
        const editor = crepe as unknown as {
          destroy(): Promise<void>;
          editor: { action: (a: unknown) => string };
        };
        inst = editor;
        getHtml = () => editor.editor.action(getHTML());
        host.addEventListener("input", onInput);
        beginEditing(path);
        onRegisterEditHandle?.(path, {
          serialize: () => ({ htmlBuffer: getHtml ? getHtml() : undefined }),
        });
        setEditPhase("ready");
      } catch (e) {
        if (cancelled) return;
        noteOpError("docx-edit-mount", e);
        setEditPhase("error");
      }
    })();
    return () => {
      cancelled = true;
      // 序列化缓冲进状态机（切走/卸载保态；dirty 由 TabItem 承载）。
      if (getHtml && inst) {
        try {
          suspendDocEdit(path, { htmlBuffer: getHtml() });
        } catch {
          /* 序列化失败：保留上次缓冲（丢弃比崩溃好，dirty 仍在标签上） */
        }
      }
      host?.removeEventListener("input", onInput);
      host?.remove();
      onRegisterEditHandle?.(path, null);
      if (inst) void inst.destroy().catch(() => undefined);
    };
  }, [editActive, path, onDirtyChange, onRegisterEditHandle]);

  // 保存成功令牌：清降级提示外的内部态并重载预览（替换原件场景文件已变）。
  useEffect(() => {
    if (!savedToken) return;
    setReloadKey((k) => k + 1);
    setSpanNotice(false);
  }, [savedToken]);

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

  if (mode === "error" && !editActive) {
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
            ? editPhase === "error"
              ? "编辑面加载失败"
              : editPhase === "converting"
                ? "转换中…"
                : "结构化编辑（保存按 mditor 样式重新生成）"
            : mode === "structure"
              ? "版式预览不可用，已切换结构预览"
              : mode === "loading"
                ? "加载中…"
                : "版式预览"}
        </span>
        {editActive ? (
          <>
            <button
              className="doc-note-btn"
              title="另存「原名 (编辑版).docx」到源目录（原件不动）"
              disabled={editPhase !== "ready"}
              onClick={() => onRequestSave?.(path)}
            >
              保存
            </button>
            <button
              className="doc-note-btn"
              title="替换原文件（需确认；原件进回收站可恢复）"
              disabled={editPhase !== "ready"}
              onClick={() => void onRequestReplace?.(path)}
            >
              替换原件…
            </button>
            <button
              className="doc-note-btn"
              title="退出编辑模式（未保存的编辑将丢弃，需确认）"
              onClick={() => void onExitEdit?.(path)}
            >
              退出编辑
            </button>
          </>
        ) : (
          <>
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
            {caps.docNoteEdit && onEnterEdit && (
              <button
                className="doc-note-btn"
                title="进入结构化编辑模式（版式将按 mditor 样式重新生成）"
                onClick={() => void onEnterEdit(path)}
              >
                编辑
              </button>
            )}
          </>
        )}
        <button className="doc-note-btn" title="用系统应用打开" onClick={() => onOpenExternal(path)}>
          <ExpandIcon size={13} />
        </button>
      </div>
      {editActive ? (
        <div className="docx-edit-wrap">
          {spanNotice && editPhase === "ready" && (
            <div className="docx-edit-notice">
              原文档表格含合并单元格，编辑面按平铺表格承载（保存后合并结构不保留）。
            </div>
          )}
          <div ref={editHostWrapRef} className="docx-edit-host-wrap" />
          {editPhase === "converting" && (
            <div className="pdf-note-overlay">
              <span className="pdf-note-spinner" aria-hidden="true" />
              转换中（mammoth → 编辑文档）…
            </div>
          )}
          {editPhase === "error" && (
            <div className="doc-note-view is-degraded">
              <p>进入编辑模式失败（文档结构无法转换或文件不可读）。</p>
              <button className="doc-note-btn" onClick={() => void onExitEdit?.(path)}>
                退出编辑
              </button>
            </div>
          )}
        </div>
      ) : mode === "loading" ? (
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
