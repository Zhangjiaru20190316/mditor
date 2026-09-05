// Agent 工具注册表（v4.9）：10 个工具的 OpenAI function schema + 执行器。
//
// 安全边界（桌面应用红线）：
//   * 所有写类工具的路径必须解析后落在当前工作区根目录内（normPath 前缀
//     判断 + 拒绝 `..` 分量），当前笔记本身除外（它是用户显式打开的文件，
//     编辑经 EditorHandle 走正常 dirty/自动保存链路）；
//   * 写类工具在循环期间只改内存工作副本 + 追加 op，绝不直接落盘；应用
//     阶段见 apply.ts（FS 操作强制走确认 UI）；
//   * 工具结果超 MAX_RESULT_CHARS 截断并置 truncated: true；
//   * 工具执行异常一律捕获为 { ok: false, error } 返回给模型，不得让循环崩溃。
//
// 读类工具全部返回绝对路径——模型的后续调用应原样回传（相对路径按第一个
// 工作区根解析，仅作兜底）。

import { readTextFile, stat } from "@tauri-apps/plugin-fs";
import { basename, join } from "../path-shim";
import { collectMdFiles, searchWorkspaces } from "../workspaceSearch";
import { embedTexts, isEmbedConfigured } from "../ai";
import { ragIndex } from "../ragIndex";
import type { Settings } from "../../types";
import {
  MAX_OPS,
  type ChangeOperation,
  type ChangePlan,
  type ToolDefinition,
} from "./types";

/** 工具结果字符串的截断上限（约 6k token）。 */
export const MAX_RESULT_CHARS = 24_000;
/** read_note 全文读取的截断上限。 */
const MAX_NOTE_CHARS = 24_000;
/** list_notes 返回条数上限。 */
const LIST_NOTES_CAP = 300;
/** 未命名当前笔记在工作副本表中的 key（create 等真实路径不会为空串）。 */
export const CURRENT_KEY = "";

// ---- 上下文 ----------------------------------------------------------------

export interface ToolContext {
  /** 当前笔记的磁盘绝对路径；未命名笔记为 null。 */
  currentPath: string | null;
  /** 当前笔记实时内容（编辑器 getValue——比磁盘新，含未保存改动）。 */
  getCurrentNote: () => string;
  /** 工作区根列表（写类路径安全边界的基准）。 */
  workspaces: string[];
  /** 设置（semantic_search 需要嵌入配置）。 */
  settings: Settings;
  /** 待应用改动清单（写类工具的暂存目标）。 */
  plan: ChangePlan;
}

/** 路径规范化：反斜杠归一为 /，去尾斜杠（比较基准，不改盘上语义）。 */
export function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function hasParentComponent(p: string): boolean {
  return p.split("/").includes("..");
}

function isInsideRoot(p: string, root: string): boolean {
  const a = normPath(p);
  const b = normPath(root);
  return a === b || a.startsWith(b + "/");
}

/** 工具入参 path 的解析结果。 */
export type ResolvedPath =
  | { ok: true; abs: string | null; display: string; current: boolean }
  | { ok: false; error: string };

/**
 * 解析工具入参 path：
 *   * 缺省 → 当前笔记（abs = currentPath；未命名 → abs = null，读写均走
 *     内存工作副本 / 编辑器内容）；
 *   * 绝对路径 → 必须是当前笔记，或落在某个工作区根内（拒绝 `..` 穿越）；
 *   * 相对路径 → 拒绝 `..`；挂到第一个工作区根（兜底——工具结果恒返回
 *     绝对路径，模型正常应回传绝对路径）。
 */
export function resolveToolPath(input: string | undefined, ctx: ToolContext): ResolvedPath {
  const raw = (input ?? "").trim();
  if (!raw) {
    if (ctx.currentPath) {
      return { ok: true, abs: normPath(ctx.currentPath), display: basename(ctx.currentPath), current: true };
    }
    return { ok: true, abs: null, display: "未命名笔记", current: true };
  }
  if (hasParentComponent(raw)) {
    return { ok: false, error: `路径含 ".." 上跳分量，拒绝访问：${raw}` };
  }
  const isAbsolute = /^[a-zA-Z]:\//.test(raw.replace(/\\/g, "/")) || raw.startsWith("/") || raw.startsWith("\\\\");
  const cur = ctx.currentPath ? normPath(ctx.currentPath) : null;
  if (isAbsolute) {
    const abs = normPath(raw);
    if (cur && abs === cur) {
      return { ok: true, abs, display: basename(abs), current: true };
    }
    const root = ctx.workspaces.find((r) => isInsideRoot(abs, r));
    if (!root) {
      return {
        ok: false,
        error: `路径不在任何已打开的工作区内（安全边界拒绝越界）：${raw}。工作区根：${ctx.workspaces.join("；") || "（无）"}`,
      };
    }
    return { ok: true, abs, display: basename(abs), current: false };
  }
  if (ctx.workspaces.length === 0) {
    return { ok: false, error: "未打开任何工作区，无法解析相对路径。请先「打开文件夹」。" };
  }
  const abs = normPath(join(ctx.workspaces[0], raw));
  if (cur && abs === cur) {
    return { ok: true, abs, display: basename(abs), current: true };
  }
  return { ok: true, abs, display: basename(abs), current: false };
}

/** 工作副本 key：当前笔记用 CURRENT_KEY（未命名与已命名统一），其余用 normPath。 */
function workKey(abs: string | null): string {
  return abs == null ? CURRENT_KEY : normPath(abs);
}

/**
 * 读取目标笔记的「当前有效内容」：工作副本（循环内已暂存的编辑）优先，
 * 其次当前笔记的编辑器实时内容，最后磁盘。磁盘读取失败返回 null。
 */
async function effectiveNoteText(abs: string | null, ctx: ToolContext): Promise<string | null> {
  const key = workKey(abs);
  if (abs == null) return ctx.plan.workingCopies.get(key) ?? ctx.getCurrentNote();
  if (ctx.currentPath && normPath(abs) === normPath(ctx.currentPath)) {
    return ctx.plan.workingCopies.get(key) ?? ctx.getCurrentNote();
  }
  if (ctx.plan.workingCopies.has(key)) return ctx.plan.workingCopies.get(key)!;
  try {
    return await readTextFile(abs);
  } catch {
    return null;
  }
}

// ---- 大纲（纯函数，可单测） --------------------------------------------------

export interface OutlineItem {
  level: number;
  text: string;
  /** 0-based 行号。 */
  line: number;
}

/** 正则解析标题结构；代码围栏内的 # 不误判（跳过 fence 内行）。 */
export function extractOutline(text: string): OutlineItem[] {
  const lines = text.split(/\r?\n/);
  let inFence = false;
  const out: OutlineItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], line: i });
  }
  return out;
}

// ---- 结果包装 ---------------------------------------------------------------

function ok(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: true, ...extra });
}
function fail(error: string): string {
  return JSON.stringify({ ok: false, error });
}

/** 工具结果超长截断（置 truncated 标记，让模型知道信息不完整）。 */
export function clampResult(obj: Record<string, unknown>): string {
  const json = JSON.stringify(obj);
  if (json.length <= MAX_RESULT_CHARS) return json;
  return (
    JSON.stringify(obj).slice(0, MAX_RESULT_CHARS) +
    `\n（结果过长，已截断至 ${MAX_RESULT_CHARS} 字符）`
  );
}

/** op 序号（进程内单调，opId 只需在单个 ChangePlan 内唯一）。 */
let opSeq = 0;
function nextOpId(): string {
  return `op-${++opSeq}`;
}

function pushOp(ctx: ToolContext, op: ChangeOperation): string | null {
  if (ctx.plan.ops.length >= MAX_OPS) {
    return `改动清单已达上限（${MAX_OPS} 条）。请收敛：总结已完成的改动并给出最终答案。`;
  }
  ctx.plan.ops.push(op);
  return null;
}

// ---- 工具执行器 -------------------------------------------------------------

export type ToolExecutor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

async function readNote(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const r = resolveToolPath(args.path as string | undefined, ctx);
  if (!r.ok) return fail(r.error);
  if (r.current && r.abs === null && !ctx.getCurrentNote().trim()) {
    return ok({ path: null, content: "", note: "当前笔记为空。" });
  }
  const text = await effectiveNoteText(r.abs, ctx);
  if (text === null) return fail(`读取失败（文件不存在或不可读）：${r.abs ?? r.display}`);
  if (text.length <= MAX_NOTE_CHARS) {
    return ok({ path: r.abs ?? "（当前未命名笔记）", chars: text.length, content: text });
  }
  return clampResult({
    ok: true,
    path: r.abs ?? "（当前未命名笔记）",
    chars: text.length,
    truncated: true,
    content: text.slice(0, MAX_NOTE_CHARS),
  });
}

async function getOutline(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const r = resolveToolPath(args.path as string | undefined, ctx);
  if (!r.ok) return fail(r.error);
  const text = await effectiveNoteText(r.abs, ctx);
  if (text === null) return fail(`读取失败（文件不存在或不可读）：${r.abs ?? r.display}`);
  return ok({ path: r.abs ?? "（当前未命名笔记）", outline: extractOutline(text) });
}

async function listNotes(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const roots = ctx.workspaces.filter((w) => typeof w === "string" && w.trim() !== "");
  if (roots.length === 0) return fail("未打开任何工作区。请先「打开文件夹」再加入文件列表。");
  const dir = typeof args.dir === "string" ? (args.dir as string).trim() : "";
  const query = typeof args.query === "string" ? (args.query as string).trim().toLowerCase() : "";
  const files: string[] = [];
  let truncated = false;
  for (const root of roots) {
    if (files.length >= LIST_NOTES_CAP) {
      truncated = true;
      break;
    }
    // dir 过滤：直接收集该子目录（必须落在根内）。
    if (dir) {
      const r = resolveToolPath(dir, ctx);
      if (!r.ok || r.abs == null || !isInsideRoot(r.abs, root)) continue;
      const got = await collectMdFiles(r.abs, undefined, LIST_NOTES_CAP - files.length);
      files.push(...got);
    } else {
      const got = await collectMdFiles(root, undefined, LIST_NOTES_CAP - files.length);
      files.push(...got);
    }
  }
  if (files.length >= LIST_NOTES_CAP) truncated = true;
  let listed = files;
  if (query) listed = files.filter((f) => f.toLowerCase().includes(query));
  // size/mtime 尽力而为：单个 stat 失败不阻塞列表。
  const notes = await Promise.all(
    listed.slice(0, LIST_NOTES_CAP).map(async (p) => {
      let size: number | null = null;
      let mtime: number | null = null;
      try {
        const st = await stat(p);
        size = typeof st.size === "number" ? st.size : null;
        mtime = typeof st.mtime === "number" ? st.mtime : null;
      } catch {
        /* 尽力而为 */
      }
      return { path: normPath(p), name: basename(p), size, mtime };
    })
  );
  return clampResult({ ok: true, count: notes.length, truncated, notes });
}

async function searchNotes(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const query = typeof args.query === "string" ? (args.query as string).trim() : "";
  if (!query) return fail("缺少 query 参数。");
  const caseSensitive = args.case_sensitive === true;
  const roots = ctx.workspaces.filter((w) => typeof w === "string" && w.trim() !== "");
  if (roots.length === 0) return fail("未打开任何工作区，无法检索。");
  const res = await searchWorkspaces(roots, query, { caseSensitive });
  const files = res.files.map((f) => ({
    path: normPath(f.path),
    name: f.name,
    hits: f.hits.map((h) => ({ line: h.line, col: h.col, text: h.text })),
  }));
  return clampResult({
    ok: true,
    scanned: res.scanned,
    totalHits: res.totalHits,
    truncated: res.truncated,
    files,
  });
}

async function semanticSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const query = typeof args.query === "string" ? (args.query as string).trim() : "";
  if (!query) return fail("缺少 query 参数。");
  const s = ctx.settings;
  if (!s.ragEnabled || !isEmbedConfigured(s)) {
    return fail("语义检索未配置（需在「设置 → 知识功能」开启全库问答并配置嵌入模型）。请改用 search_notes 关键词检索。");
  }
  if (!ragIndex.isBuilt(s.ragEmbedModel)) {
    return fail("向量索引尚未构建。请改用 search_notes 关键词检索。");
  }
  const topK = typeof args.top_k === "number" && args.top_k > 0 ? Math.min(Math.floor(args.top_k), 20) : 8;
  try {
    const [qvec] = await embedTexts(s, [query]);
    const hits = ragIndex.search(qvec, topK);
    return clampResult({
      ok: true,
      hits: hits.map((h) => ({
        path: normPath(h.chunk.path),
        heading: h.chunk.heading || null,
        line: h.chunk.line,
        score: Number(h.score.toFixed(4)),
        text: h.chunk.text.slice(0, 600),
      })),
    });
  } catch (e) {
    return fail(`语义检索失败：${String(e)}。请改用 search_notes。`);
  }
}

async function editNote(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const r = resolveToolPath(args.path as string | undefined, ctx);
  if (!r.ok) return fail(r.error);
  const oldText = typeof args.old_text === "string" ? (args.old_text as string) : "";
  const newText = typeof args.new_text === "string" ? (args.new_text as string) : "";
  const replaceAll = args.replace_all === true;
  if (!oldText) return fail("缺少 old_text 参数（必须与文件原文完全一致）。");
  if (oldText === newText) return fail("old_text 与 new_text 相同，无需修改。");
  const text = await effectiveNoteText(r.abs, ctx);
  if (text === null) return fail(`读取失败（文件不存在或不可读）：${r.abs ?? r.display}`);
  const count = text.split(oldText).length - 1;
  if (count === 0) {
    return fail("old_text 在文件中未找到（必须与原文完全一致，包括空白与换行）。请先 read_note 核对原文后重试。");
  }
  if (count > 1 && !replaceAll) {
    return fail(`old_text 在文件中出现 ${count} 次。请扩大上下文使其唯一，或设置 replace_all=true 全部替换。`);
  }
  const updated = replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, newText);
  const key = workKey(r.abs);
  ctx.plan.workingCopies.set(key, updated);
  const capped = pushOp(ctx, {
    kind: "edit",
    opId: nextOpId(),
    path: r.abs ?? CURRENT_KEY,
    title: r.display,
    oldText,
    newText,
    replaceAll,
  });
  if (capped) return fail(capped);
  return ok({
    path: r.abs ?? "（当前未命名笔记）",
    replaced: replaceAll ? count : 1,
    staged: ctx.plan.ops.length,
    note: "修改已暂存，循环结束后统一审阅应用。",
  });
}

async function appendToNote(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const r = resolveToolPath(args.path as string | undefined, ctx);
  if (!r.ok) return fail(r.error);
  const text = typeof args.text === "string" ? (args.text as string) : "";
  if (!text.trim()) return fail("缺少 text 参数。");
  const cur = await effectiveNoteText(r.abs, ctx);
  if (cur === null) return fail(`读取失败（文件不存在或不可读）：${r.abs ?? r.display}`);
  const sep = cur.length === 0 || cur.endsWith("\n") ? "" : "\n";
  const updated = cur + sep + text;
  const key = workKey(r.abs);
  ctx.plan.workingCopies.set(key, updated);
  const capped = pushOp(ctx, {
    kind: "append",
    opId: nextOpId(),
    path: r.abs ?? CURRENT_KEY,
    title: r.display,
    text,
  });
  if (capped) return fail(capped);
  return ok({ path: r.abs ?? "（当前未命名笔记）", appendedChars: text.length, staged: ctx.plan.ops.length });
}

async function createNote(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const raw = typeof args.path === "string" ? (args.path as string).trim() : "";
  const content = typeof args.content === "string" ? (args.content as string) : "";
  if (!raw) return fail("缺少 path 参数。");
  // 新建路径必须落工作区内（相对路径挂第一个根），且不得与当前笔记相同。
  const r = resolveToolPath(raw, ctx);
  if (!r.ok) return fail(r.error);
  if (r.abs == null) return fail("无法解析目标路径（未打开工作区时只能操作当前笔记）。");
  if (r.current) return fail("目标路径与当前笔记相同，不能新建。请换一个路径。");
  const ext = raw.toLowerCase().split(".").pop() ?? "";
  if (!["md", "markdown", "mdx", "mdown"].includes(ext)) {
    return fail("仅支持创建 Markdown 文件（.md / .markdown / .mdx / .mdown）。");
  }
  const key = normPath(r.abs);
  if (ctx.plan.workingCopies.has(key)) return fail(`改动清单中已包含该路径的操作，请勿重复创建：${r.abs}`);
  ctx.plan.workingCopies.set(key, content);
  const capped = pushOp(ctx, {
    kind: "create",
    opId: nextOpId(),
    path: key,
    title: basename(key),
    content,
  });
  if (capped) return fail(capped);
  return ok({ path: key, chars: content.length, staged: ctx.plan.ops.length, note: "新建已暂存，须经用户确认后才会写入磁盘。" });
}

async function renameNote(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const from = typeof args.old_path === "string" ? (args.old_path as string).trim() : "";
  const to = typeof args.new_path === "string" ? (args.new_path as string).trim() : "";
  if (!from || !to) return fail("缺少 old_path / new_path 参数。");
  const rf = resolveToolPath(from, ctx);
  if (!rf.ok) return fail(rf.error);
  if (rf.abs == null) return fail("当前笔记尚未保存到磁盘，无法重命名。");
  const rt = resolveToolPath(to, ctx);
  if (!rt.ok) return fail(rt.error);
  if (rt.abs == null) return fail("无法解析 new_path。");
  if (normPath(rf.abs) === normPath(rt.abs)) return fail("old_path 与 new_path 相同。");
  const capped = pushOp(ctx, {
    kind: "rename",
    opId: nextOpId(),
    fromPath: normPath(rf.abs),
    toPath: normPath(rt.abs),
    title: `${basename(rf.abs)} → ${basename(rt.abs)}`,
  });
  if (capped) return fail(capped);
  return ok({
    from: normPath(rf.abs),
    to: normPath(rt.abs),
    isCurrentNote: rf.current,
    staged: ctx.plan.ops.length,
    note: "重命名/移动已暂存，须经用户确认后执行。",
  });
}

async function deleteNote(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const raw = typeof args.path === "string" ? (args.path as string).trim() : "";
  if (!raw) return fail("缺少 path 参数。");
  if (raw === ".") return fail("无效路径。");
  const r = resolveToolPath(raw, ctx);
  if (!r.ok) return fail(r.error);
  if (r.abs == null) return fail("当前笔记尚未保存到磁盘，无法删除。");
  const capped = pushOp(ctx, {
    kind: "delete",
    opId: nextOpId(),
    path: normPath(r.abs),
    title: basename(r.abs),
  });
  if (capped) return fail(capped);
  return ok({
    path: normPath(r.abs),
    isCurrentNote: r.current,
    staged: ctx.plan.ops.length,
    note: "删除已暂存：应用时移入系统回收站（可恢复），须经用户确认。",
  });
}

// ---- 注册表 -----------------------------------------------------------------

export interface AgentTool {
  definition: ToolDefinition;
  /** 中文名（工具卡片标题）。 */
  label: string;
  execute: ToolExecutor;
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    label: "读取笔记",
    definition: {
      type: "function",
      function: {
        name: "read_note",
        description:
          "读取一篇笔记的全文。不传 path 时读取当前正在编辑的笔记（含未保存改动）。修改前务必先读取，确保 old_text 与原文一致。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "笔记路径（建议使用其它工具返回的绝对路径）；缺省为当前笔记" },
          },
        },
      },
    },
    execute: readNote,
  },
  {
    label: "读取大纲",
    definition: {
      type: "function",
      function: {
        name: "get_outline",
        description: "读取笔记的标题结构（层级/文本/行号），不读全文。快速了解长文结构时用它省 token。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "笔记路径；缺省为当前笔记" },
          },
        },
      },
    },
    execute: getOutline,
  },
  {
    label: "列出笔记",
    definition: {
      type: "function",
      function: {
        name: "list_notes",
        description: "列出工作区内的 Markdown 文件（绝对路径/大小/修改时间），上限 300 条。批量整理前先用它圈定范围。",
        parameters: {
          type: "object",
          properties: {
            dir: { type: "string", description: "只列该子目录下的文件（工作区内路径）" },
            query: { type: "string", description: "按路径子串过滤" },
          },
        },
      },
    },
    execute: listNotes,
  },
  {
    label: "检索笔记",
    definition: {
      type: "function",
      function: {
        name: "search_notes",
        description: "关键词全文检索工作区笔记，返回命中文件/行号/文本片段。回答「哪些笔记提到 X」类问题先用它。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "关键词" },
            case_sensitive: { type: "boolean", description: "是否区分大小写（默认否）" },
          },
          required: ["query"],
        },
      },
    },
    execute: searchNotes,
  },
  {
    label: "语义检索",
    definition: {
      type: "function",
      function: {
        name: "semantic_search",
        description:
          "向量语义检索（按含义找，不依赖字面关键词）。依赖嵌入配置与已构建的索引；不可用时会有明确提示，此时改用 search_notes。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "自然语言描述" },
            top_k: { type: "number", description: "返回条数（默认 8，上限 20）" },
          },
          required: ["query"],
        },
      },
    },
    execute: semanticSearch,
  },
  {
    label: "编辑笔记",
    definition: {
      type: "function",
      function: {
        name: "edit_note",
        description:
          "精确文本替换（暂存，不直接落盘）。old_text 必须与文件当前内容完全一致且唯一匹配（除非 replace_all）。同一文件多次编辑按顺序链式生效。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "笔记路径；缺省为当前笔记" },
            old_text: { type: "string", description: "要替换的原文（必须逐字一致）" },
            new_text: { type: "string", description: "替换后的文本" },
            replace_all: { type: "boolean", description: "old_text 多处出现时全部替换（默认报错）" },
          },
          required: ["old_text", "new_text"],
        },
      },
    },
    execute: editNote,
  },
  {
    label: "追加内容",
    definition: {
      type: "function",
      function: {
        name: "append_to_note",
        description: "把文本追加到笔记末尾（暂存）。撰写新章节/总结用它。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "笔记路径；缺省为当前笔记" },
            text: { type: "string", description: "追加的 Markdown 文本" },
          },
          required: ["text"],
        },
      },
    },
    execute: appendToNote,
  },
  {
    label: "新建笔记",
    definition: {
      type: "function",
      function: {
        name: "create_note",
        description: "新建一篇 Markdown 笔记（暂存；应用时须经用户确认才写入磁盘）。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "工作区内的目标路径（相对或绝对）" },
            content: { type: "string", description: "初始内容（Markdown）" },
          },
          required: ["path", "content"],
        },
      },
    },
    execute: createNote,
  },
  {
    label: "重命名/移动",
    definition: {
      type: "function",
      function: {
        name: "rename_note",
        description: "重命名或移动笔记（暂存；应用时须经用户确认）。",
        parameters: {
          type: "object",
          properties: {
            old_path: { type: "string", description: "现有路径" },
            new_path: { type: "string", description: "目标路径（须在同一工作区内）" },
          },
          required: ["old_path", "new_path"],
        },
      },
    },
    execute: renameNote,
  },
  {
    label: "删除笔记",
    definition: {
      type: "function",
      function: {
        name: "delete_note",
        description: "删除笔记（暂存；应用时移入系统回收站可恢复，且必须经用户确认）。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "要删除的笔记路径" },
          },
          required: ["path"],
        },
      },
    },
    execute: deleteNote,
  },
];

/** 工具名 → 注册项。 */
export const TOOL_BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.definition.function.name, t]));

/** 发给模型的 tools 数组。 */
export const TOOL_DEFINITIONS = AGENT_TOOLS.map((t) => t.definition);
