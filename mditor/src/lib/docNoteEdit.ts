// DE 轮（原位编辑）：pdf/docx 编辑态状态机（任务书 §4.4）。
//
// 模块级 Map（键 = docNote.docTabKey(path)，对齐 docBytesCache 惯例）承载
// 每个标签的编辑缓冲：
//   * Word：htmlBuffer（切走标签时由编辑面序列化的 getHTML 产物）；
//   * PDF：patches（行级补丁列表——唯一事实源，每次保存都从原始字节重放，
//     绝不基于已 patch 产物二次叠加）；
//   * 两者共持 baseMtime/baseSize（进入编辑时捕获，保存前校验——外部程序
//     改动原文件 → buffer 作废提示，防覆盖他人改动，验收 §五第 7 条）。
// 纯状态转移可全量 vitest；fs.stat 副作用只出现在 enterDocEdit /
// verifyBaseUnchanged（经 platform 适配层）。
//
// 与 md 管线的关系：本模块是 TabItem.dirty 的第二个（也是唯一的另一个）
// 写入源的数据底座——写入动作由 App 的编辑面回调执行，useFile/编辑器/
// docCache/自动保存对编辑态标签仍然恒隔离（noteKind.isReadonlyTab 含编辑态）。

import { getAdapter } from "../platform";
import { docTabKey } from "./docNote";
import type { PdfPatch } from "./docNote";

/** 编辑态生命周期相位。 */
export type DocEditPhase = "converting" | "editing" | "saving";

export interface DocEditState {
  phase: DocEditPhase;
  /** Word 编辑面序列化文档（M2：Crepe getHTML 产物；切走标签/关标签前写入）。 */
  htmlBuffer?: string;
  /** PDF 行级补丁（M3；唯一事实源）。 */
  patches: PdfPatch[];
  /** 进入编辑时的磁盘指纹（外部修改检测基准）。 */
  baseMtime: number;
  baseSize: number;
}

const states = new Map<string, DocEditState>();

function keyOf(path: string): string {
  return docTabKey(path);
}

/** 进入编辑态：捕获磁盘指纹并建条目（phase=converting——由调用方在转换
 *  完成后 beginEditing）。已存在条目时保持原缓冲（重进编辑面复用）。 */
export async function enterDocEdit(path: string): Promise<DocEditState> {
  const k = keyOf(path);
  const existing = states.get(k);
  if (existing && existing.phase !== "saving") return existing;
  const stat = await getAdapter().fs.stat(path);
  const st: DocEditState = {
    phase: "converting",
    patches: [],
    baseMtime: stat.mtime?.getTime() ?? 0,
    baseSize: stat.size,
  };
  states.set(k, st);
  return st;
}

/** 读取编辑态（无条目 = 未进入编辑）。 */
export function getDocEditState(path: string): DocEditState | null {
  return states.get(keyOf(path)) ?? null;
}

/** 转换完成，进入可编辑相位。 */
export function beginEditing(path: string): void {
  const st = states.get(keyOf(path));
  if (st) st.phase = "editing";
}

/** 保存开始/结束的相位翻转（保存期间编辑面只读，防缓冲与产物竞态）。 */
export function markSaving(path: string): void {
  const st = states.get(keyOf(path));
  if (st) st.phase = "saving";
}

export function endSaving(path: string): void {
  const st = states.get(keyOf(path));
  if (st && st.phase === "saving") st.phase = "editing";
}

/** 切走标签：序列化缓冲（Word htmlBuffer / PDF patches）进状态机，条目保留
 *  （标签保持编辑态与 dirty；切回时 resumeDocEdit 重水合）。 */
export function suspendDocEdit(
  path: string,
  buffer: { htmlBuffer?: string; patches?: PdfPatch[] }
): void {
  const st = states.get(keyOf(path));
  if (!st) return;
  if (buffer.htmlBuffer !== undefined) st.htmlBuffer = buffer.htmlBuffer;
  if (buffer.patches !== undefined) st.patches = buffer.patches;
}

/** 切回标签：取回编辑态（视图据此重水合编辑面）。 */
export function resumeDocEdit(path: string): DocEditState | null {
  return states.get(keyOf(path)) ?? null;
}

/** 更新缓冲（编辑面每次变更后同步；dirty 由 App 写 TabItem）。 */
export function updateDocEditBuffer(
  path: string,
  buffer: { htmlBuffer?: string; patches?: PdfPatch[] }
): void {
  suspendDocEdit(path, buffer);
}

/** 退出编辑 / 关闭标签：释放条目（放弃需确认由调用方 UI 承担）。 */
export function discardDocEdit(path: string): void {
  states.delete(keyOf(path));
}

/** 保存前外部修改校验：mtime/size 任一变化即视为他人改动（unchanged=false）。
 *  mtime 为 0（平台未提供）时退化为仅 size 判定。 */
export async function verifyBaseUnchanged(
  path: string
): Promise<{ unchanged: boolean; baseMtime: number; baseSize: number; curMtime: number; curSize: number }> {
  const st = states.get(keyOf(path));
  const stat = await getAdapter().fs.stat(path);
  const curMtime = stat.mtime?.getTime() ?? 0;
  const curSize = stat.size;
  if (!st) return { unchanged: false, baseMtime: 0, baseSize: 0, curMtime, curSize };
  const unchanged =
    curSize === st.baseSize && (st.baseMtime === 0 || curMtime === st.baseMtime);
  return { unchanged, baseMtime: st.baseMtime, baseSize: st.baseSize, curMtime, curSize };
}

/** 保存替换原文件成功后重置基准（产物占原路径，指纹刷新为新文件）。 */
export function rebaseAfterReplace(path: string): Promise<DocEditState> {
  states.delete(keyOf(path));
  return enterDocEdit(path);
}

/** 测试专用：清空全部状态（vitest 隔离）。 */
export function __resetDocEditForTest(): void {
  states.clear();
}
