// DE 轮 M2/M3：pdf/docx 原位编辑的保存编排（任务书 §4.4 副作用面）。
//
// 保存语义铁律（任务书铁律 1「原件神圣」）：
//   * save-as（默认）：同目录「原名 (编辑版).ext」，冲突经 conflictFreeName
//     绝不覆盖；原件一字节不动；
//   * replace：调用方已完成二次确认 → 原件走 trash_file 进系统回收站
//     （可恢复是底线）→ 新文件写入原路径 → 字节缓存失效 + 状态机重定基准；
//   * 两种模式写盘前都做外部修改校验（mtime/size 指纹，docNoteEdit）——
//     他人改动未确认前绝不覆盖（验收 §五第 7 条）。
// 字节生产（buildDocx / applyPdfPatches）由调用方注入 produce——本模块只管
// 保存语义，不碰格式细节。

import { getAdapter } from "../platform";
import { basename, dirname, extname, join } from "./path-shim";
import { conflictFreeName } from "./htmlNote";
import { invalidateDocNoteBytes } from "./docNote";
import { rebaseAfterReplace, verifyBaseUnchanged } from "./docNoteEdit";

/** 外部修改冲突（保存前指纹校验失败）——UI 明确提示，不覆盖。 */
export class DocNoteConflictError extends Error {
  constructor(curMtime: number, curSize: number) {
    super(`原文件已被外部程序修改（size=${curSize}, mtime=${curMtime}），未执行保存`);
    this.name = "DocNoteConflictError";
  }
}

/** 另存默认后缀（原名之前追加；conflictFreeName 再兜底去重）。 */
const EDITED_SUFFIX = " (编辑版)";

export interface SaveDocEditResult {
  mode: "save-as" | "replace";
  /** 实际落盘路径（save-as 为新文件名；replace 为原路径）。 */
  path: string;
}

/**
 * 写入编辑产物。produce 在指纹校验通过后调用（拿到「确认无外部修改」之后
 * 的最新缓冲）。save-as 绝不触碰原件；replace 的二次确认由调用方 UI 承担
 * （本函数不再弹窗——保存语义与 UI 确认分离）。
 */
export async function saveDocNoteEdited(
  path: string,
  produce: () => Promise<Uint8Array>,
  mode: "save-as" | "replace"
): Promise<SaveDocEditResult> {
  const v = await verifyBaseUnchanged(path);
  if (!v.unchanged) throw new DocNoteConflictError(v.curMtime, v.curSize);
  const bytes = await produce();
  const fs = getAdapter().fs;

  if (mode === "replace") {
    // 原件进系统回收站（trash > rm，可恢复底线）→ 新文件占原路径。
    await getAdapter().app.trashFile(path);
    await fs.writeFile(path, bytes);
    invalidateDocNoteBytes(path);
    await rebaseAfterReplace(path);
    return { mode, path };
  }

  const dir = dirname(path);
  const ext = extname(path);
  const stem = basename(path).slice(0, -ext.length) || "note";
  const taken = new Set(
    (await fs.readDir(dir).catch(() => [])).map((e) => e.name)
  );
  const target = join(dir, conflictFreeName(`${stem}${EDITED_SUFFIX}${ext}`, taken));
  await fs.writeFile(target, bytes);
  return { mode: "save-as", path: target };
}
