// Agent system prompt 构造（v4.9）。
//
// 与普通对话的 buildSystemPrompt 区别：不把笔记全文默认塞进 <note>（检索
// 已由工具承担），只注入轻量上下文（当前文件路径 + 大纲 + 大小 + 工作区根
// 列表）；全文仅当较短（< FULL_NOTE_INLINE_LIMIT 字符）时注入，长文交给
// 模型按需 read_note / get_outline——省 token 且更精准。

import { basename } from "../path-shim";
import { extractOutline, type ToolContext } from "./tools";

/** 短文全文注入阈值（超过则只给大纲，正文让模型按需读取）。 */
export const FULL_NOTE_INLINE_LIMIT = 8_000;

/** 大纲注入的条数上限（防超长文档把 prompt 撑爆）。 */
const OUTLINE_CAP = 120;

/**
 * 构造 Agent 模式的 system prompt。
 * ctx 为工具执行上下文（当前路径/内容/工作区——与 prompt 注入同源，避免
 * 「prompt 说的是 A、工具看到的是 B」的漂移）。
 */
export function buildAgentSystemPrompt(ctx: ToolContext): string {
  const note = ctx.getCurrentNote();
  const isUntitled = ctx.currentPath == null;
  const currentFile = isUntitled
    ? "（未命名的新笔记，尚未保存到磁盘；只读/编辑其内存内容）"
    : ctx.currentPath;

  const lines: string[] = [
    "你是本地 Markdown 笔记库 Mditor 的整理助手（Agent 模式），可以通过工具检索、读取、编辑、新建、重命名和删除笔记。",
    "",
    "## 当前上下文",
    `- 当前笔记：${currentFile}${isUntitled ? "" : `（${note.length} 字符）`}`,
  ];

  const outline = extractOutline(note).slice(0, OUTLINE_CAP);
  if (outline.length > 0) {
    lines.push(`- 当前笔记大纲（${outline.length} 个标题${outline.length >= OUTLINE_CAP ? "，超长已截断" : ""}）：`);
    for (const h of outline) {
      lines.push(`  ${"  ".repeat(Math.max(0, h.level - 1))}H${h.level} L${h.line} ${h.text}`);
    }
  } else {
    lines.push("- 当前笔记大纲：（无标题）");
  }

  if (note.trim() && note.length < FULL_NOTE_INLINE_LIMIT) {
    lines.push("", "<note>", note, "</note>");
  } else if (note.trim()) {
    lines.push(`- 正文较长（${note.length} 字符），未内联：需要细节时用 read_note 读取。`);
  }

  const ws = ctx.workspaces.filter((w) => w && w.trim());
  lines.push("", "## 工作区根目录");
  if (ws.length > 0) {
    for (const w of ws) lines.push(`- ${w}`);
  } else {
    lines.push("-（未打开工作区：无法检索/列表/文件系统操作，只能操作当前笔记）");
  }

  lines.push(
    "",
    "## 工具使用规则",
    "- 需要事实依据时先检索（search_notes / semantic_search）再读取（read_note），禁止凭记忆编造笔记内容。",
    "- 修改笔记用 edit_note：old_text 必须与文件原文逐字一致（含空白与换行）；不确定就先 read_note 核对。",
    "- 编辑是暂存语义：循环结束后所有改动会统一呈现给用户审阅，确认后才应用。同一文件多次编辑按顺序链式生效。",
    "- 文件系统级操作（新建/重命名/删除）无论设置如何都会要求用户确认；删除走系统回收站，可恢复。",
    "- 每个工具结果都可能被截断（truncated: true）——必要时分段读取。",
    "",
    "## 批量整理套路",
    "1. list_notes / search_notes 圈定文件范围；",
    "2. 逐个 read_note（长文可先 get_outline 再定位读取）；",
    "3. 逐个 edit_note / append_to_note 暂存改动（同一文件的多处修改分别提交，保持 old_text 唯一）；",
    "4. 最终回答中汇总每条已暂存的改动（文件 → 做了什么）。",
    "",
    "## 输出规范",
    "- 使用中文，简洁；涉及代码/公式时用 Markdown 语法。",
    "- 回答事实性问题时给出出处（文件名与行号/标题）。",
    "- 结束时若有已暂存的改动，列出改动摘要清单（文件 → 操作 → 要点）。"
  );

  return lines.join("\n");
}

/** 当前笔记的展示名（卡片/审阅 UI 用）。 */
export function currentNoteTitle(currentPath: string | null): string {
  return currentPath ? basename(currentPath) : "当前未命名笔记";
}
