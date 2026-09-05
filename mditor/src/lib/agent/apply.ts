// ChangePlan 应用逻辑（v4.9）：把审阅（或 auto 模式）选中的 ops 落到编辑器
// 与文件系统。
//
// 安全语义：
//   * 当前笔记的 edit/append：从编辑器实时内容重算（不是直接写工作副本——
//     用户可能只勾选了部分 op），经 deps.writeCurrentNote 一步撤销写回并
//     markDirty（走现有自动保存链路）；
//   * 其他文件的 edit/append：读盘 → 逐 op 重算（应用时二次校验 old_text，
//     外部修改导致的冲突标记失败）→ 一次写回；
//   * create：目标已存在则失败（绝不覆盖）；父目录递归创建；
//   * rename：目标已存在则失败（不覆盖）；复用 fileOps.renamePath；
//   * delete：一律走 Rust trash_file（系统回收站，可恢复）——项目红线
//     trash > rm，本模块不得出现不可恢复删除。
//
// 返回逐 op 结果 + FS 变更报告（调用方据此刷新文件树 / 处理标签页）。

import { mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { dirname } from "../path-shim";
import { pathExists, renamePath } from "../fileOps";
import { CURRENT_KEY, normPath } from "./tools";
import type { ChangeOperation, ChangePlan } from "./types";

export interface ApplyOpResult {
  opId: string;
  ok: boolean;
  error?: string;
}

/** FS 变更报告（调用方据此刷新 FileTree / RecentList / 标签页）。 */
export interface FsChangeReport {
  created: string[];
  renamed: { from: string; to: string }[];
  deleted: string[];
  /** 当前笔记内容已写回（writeCurrentNote 内含 undo 基线处理）。 */
  currentNoteWritten: boolean;
}

export interface ApplyPlanDeps {
  currentPath: string | null;
  getCurrentNote: () => string;
  /** 当前笔记最终内容写回（一步撤销 + markDirty + 自动保存链路）。 */
  writeCurrentNote: (merged: string) => void;
}

export interface ApplyPlanOutcome {
  results: ApplyOpResult[];
  fs: FsChangeReport;
}

/** 单条内容 op 的重算（纯函数，可单测）。 */
export function applyContentOp(
  text: string,
  op: ChangeOperation
): { ok: true; text: string } | { ok: false; error: string } {
  if (op.kind === "append") {
    const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
    return { ok: true, text: text + sep + op.text };
  }
  if (op.kind !== "edit") return { ok: false, error: "内部错误：非内容类 op" };
  const count = text.split(op.oldText).length - 1;
  if (count === 0) {
    return {
      ok: false,
      error: "old_text 在当前内容中未找到（文件可能在循环期间被外部修改），本条已跳过",
    };
  }
  if (count > 1 && !op.replaceAll) {
    return { ok: false, error: `old_text 出现 ${count} 次（不再唯一），本条已跳过` };
  }
  return {
    ok: true,
    text: op.replaceAll
      ? text.split(op.oldText).join(op.newText)
      : text.replace(op.oldText, op.newText),
  };
}

/** 删除单个文件到系统回收站（Rust trash_file 命令；Phase 4）。 */
export async function trashFile(path: string): Promise<void> {
  await invoke("trash_file", { path });
}

export async function applyChangePlan(
  plan: ChangePlan,
  selected: Set<string>,
  deps: ApplyPlanDeps
): Promise<ApplyPlanOutcome> {
  const results: ApplyOpResult[] = [];
  const fs: FsChangeReport = {
    created: [],
    renamed: [],
    deleted: [],
    currentNoteWritten: false,
  };
  const ops = plan.ops.filter((op) => selected.has(op.opId));
  const curKey = deps.currentPath ? normPath(deps.currentPath) : CURRENT_KEY;

  // ---- 内容类：当前笔记（内存重算 + 一步写回） ------------------------------
  const currentContentOps = ops.filter(
    (o) => (o.kind === "edit" || o.kind === "append") && normPath(o.path) === curKey
  );
  if (currentContentOps.length > 0) {
    let text = deps.getCurrentNote();
    let changed = false;
    for (const op of currentContentOps) {
      const r = applyContentOp(text, op);
      if (r.ok) {
        text = r.text;
        changed = true;
        results.push({ opId: op.opId, ok: true });
      } else {
        results.push({ opId: op.opId, ok: false, error: r.error });
      }
    }
    if (changed) {
      deps.writeCurrentNote(text);
      fs.currentNoteWritten = true;
    }
  }

  // ---- 内容类：其他文件（读盘 → 逐 op 重算 → 一次写回） ---------------------
  const byFile = new Map<string, ChangeOperation[]>();
  for (const op of ops) {
    if (op.kind !== "edit" && op.kind !== "append") continue;
    const key = normPath(op.path);
    if (key === curKey) continue;
    const list = byFile.get(key);
    if (list) list.push(op);
    else byFile.set(key, [op]);
  }
  for (const [path, fileOps] of byFile) {
    let text: string | null;
    try {
      text = await readTextFile(path);
    } catch {
      for (const op of fileOps) {
        results.push({ opId: op.opId, ok: false, error: `读取失败（文件不存在或不可读）：${path}` });
      }
      continue;
    }
    let working = text;
    let changed = false;
    for (const op of fileOps) {
      const r = applyContentOp(working, op);
      if (r.ok) {
        working = r.text;
        changed = true;
        results.push({ opId: op.opId, ok: true });
      } else {
        results.push({ opId: op.opId, ok: false, error: r.error });
      }
    }
    if (changed) {
      try {
        await writeTextFile(path, working);
      } catch (e) {
        for (const op of fileOps) {
          const hit = results.find((x) => x.opId === op.opId && x.ok);
          if (hit) {
            hit.ok = false;
            hit.error = `写回失败：${String(e)}`;
          }
        }
      }
    }
  }

  // ---- FS 类：按 plan 顺序（create → rename → delete 语义由模型编排） -------
  for (const op of ops) {
    if (op.kind === "create") {
      try {
        if (await pathExists(op.path)) {
          results.push({ opId: op.opId, ok: false, error: `目标已存在，拒绝覆盖：${op.path}` });
          continue;
        }
        const parent = dirname(op.path);
        if (parent) await mkdir(parent, { recursive: true });
        await writeTextFile(op.path, op.content);
        fs.created.push(op.path);
        results.push({ opId: op.opId, ok: true });
      } catch (e) {
        results.push({ opId: op.opId, ok: false, error: `新建失败：${String(e)}` });
      }
    } else if (op.kind === "rename") {
      try {
        if (!(await pathExists(op.fromPath))) {
          results.push({ opId: op.opId, ok: false, error: `源文件不存在：${op.fromPath}` });
          continue;
        }
        if (await pathExists(op.toPath)) {
          results.push({ opId: op.opId, ok: false, error: `目标已存在，拒绝覆盖：${op.toPath}` });
          continue;
        }
        const parent = dirname(op.toPath);
        if (parent) await mkdir(parent, { recursive: true });
        await renamePath(op.fromPath, op.toPath);
        fs.renamed.push({ from: op.fromPath, to: op.toPath });
        results.push({ opId: op.opId, ok: true });
      } catch (e) {
        results.push({ opId: op.opId, ok: false, error: `重命名失败：${String(e)}` });
      }
    } else if (op.kind === "delete") {
      try {
        if (!(await pathExists(op.path))) {
          results.push({ opId: op.opId, ok: false, error: `文件不存在（可能已被删除）：${op.path}` });
          continue;
        }
        await trashFile(op.path);
        fs.deleted.push(op.path);
        results.push({ opId: op.opId, ok: true });
      } catch (e) {
        results.push({ opId: op.opId, ok: false, error: `移入回收站失败：${String(e)}` });
      }
    }
  }

  return { results, fs };
}
