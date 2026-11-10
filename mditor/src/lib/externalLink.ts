// 外部关联（v5.3.x）：文件状态「内 ↔ 外」同步的按文件夹配置——纯解析与
// 判定，零平台依赖（tauriFs 的 kindOfName 为纯函数）。
//
// 三个消费方共享同一份语义（见 types.RootLinkOptions 的 JSDoc）：
//   1. 文件树自动刷新（useTreeWatcher → FileTree.refreshAll）
//   2. vaultIndex 增量重扫闸门（onWatchEvent 过滤；全量 rebuild 不受影响）
//   3. 打开文件外部修改重载（useFileWatcher.shouldWatch）+ useFile 保存前
//      mtime/size 校验（断开时兜底，防止自动保存覆盖外部修改）
//
// 继承语义（用户拍板「就近覆盖」）：子文件夹缺省继承父级；任一字段显式
// 设置即优先于父级——父文件夹断开后子文件夹可单独恢复，反之亦然。

import { basename, toPosix } from "./path-shim";
import { rootOf } from "./workspaces";
import { kindOfName } from "./tauriFs";
import { NOTE_KINDS } from "../defaults";
import type { FolderLinkRule, NoteKind, RootLinkOptions } from "../types";

/** 某目录（子树）解析后的有效外部关联范围。 */
export interface LinkScope {
  /** 外部变化是否对该子树作出反应。 */
  enabled: boolean;
  /** 生效文件类型（替换式解析结果；空集 = 任何文件类型都不反应）。 */
  kinds: ReadonlySet<NoteKind>;
}

const ALL_KINDS: ReadonlySet<NoteKind> = new Set<NoteKind>(NOTE_KINDS);

/** posix 相对路径的父目录（"" = 根层）。 */
function dirOfRel(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

/**
 * 文件夹规则查找（大小写不敏感兜底）：Windows 路径大小写漂移是常态（watch
 * 事件路径与 readDir 配置键的大小写可能不一致），先 O(1) 精确命中，未命中
 * 再做一次大小写折叠扫描。返回 [键, 规则]；无命中返回 null。
 */
function folderRuleAt(
  folders: Record<string, FolderLinkRule> | undefined,
  relDir: string
): [string, FolderLinkRule] | null {
  if (!folders) return null;
  const direct = folders[relDir];
  if (direct) return [relDir, direct];
  const lower = relDir.toLowerCase();
  for (const [k, v] of Object.entries(folders)) {
    if (k.toLowerCase() === lower) return [k, v];
  }
  return null;
}

/**
 * 解析 relDir（相对根的 posix 目录，"" = 根本身）的有效关联范围：自根向下
 * 逐段应用显式覆盖，逐字段就近优先。缺省 = 关联 + 全部四类。
 */
export function resolveLinkScope(
  opts: RootLinkOptions | undefined,
  relDir: string
): LinkScope {
  let enabled = opts?.enabled !== false;
  let kinds: ReadonlySet<NoteKind> | null = opts?.fileTypes
    ? new Set<NoteKind>(opts.fileTypes)
    : null;
  if (relDir !== "" && opts?.folders) {
    const segs = relDir.split("/").filter((s) => s !== "");
    let acc = "";
    for (const seg of segs) {
      acc = acc === "" ? seg : `${acc}/${seg}`;
      const hit = folderRuleAt(opts.folders, acc);
      if (!hit) continue;
      const rule = hit[1];
      if (rule.enabled !== undefined) enabled = rule.enabled;
      if (rule.fileTypes !== undefined) kinds = new Set<NoteKind>(rule.fileTypes);
    }
  }
  return { enabled, kinds: kinds ?? ALL_KINDS };
}

/**
 * watch 事件路径的反应判定（文件树刷新与 vaultIndex 共用）：
 *  - 隐藏项（`.` 开头）：树与索引均不展示 → 恒不反应；
 *  - 四类笔记扩展名 → 文件事件：按**所属目录**的有效类型过滤；
 *  - 无扩展名 → 视为目录（结构性变化）：只看关联开关（目录没有类型）；
 *  - 其余扩展名（.png 等）：树与索引都不展示 → 不反应。
 * 不在任何根下（理论上 watch 不会报）→ 不反应。
 */
export function shouldReactToChange(
  absPath: string,
  roots: readonly string[],
  getOpts: () => Record<string, RootLinkOptions>
): boolean {
  const root = rootOf(absPath, roots as string[]);
  if (!root) return false;
  const name = basename(absPath);
  if (name.startsWith(".")) return false;
  const rel = toPosix(absPath.slice(root.length)).replace(/^\/+/, "");
  const kind = kindOfName(name);
  if (kind !== null) {
    const scope = resolveLinkScope(getOpts()[root], dirOfRel(rel));
    return scope.enabled && scope.kinds.has(kind);
  }
  if (name.lastIndexOf(".") <= 0) {
    return resolveLinkScope(getOpts()[root], rel).enabled;
  }
  return false;
}

/**
 * useFileWatcher 的订阅判定（App 稳定回调传入）：路径所属目录关联有效且
 * 文件类型在生效集合内才监听。不在任何根下的文件（外部单独打开）维持既有
 * 行为（true）；非四类扩展名的已打开文件同理。
 */
export function shouldWatchPath(
  absPath: string,
  roots: readonly string[],
  getOpts: () => Record<string, RootLinkOptions>
): boolean {
  const root = rootOf(absPath, roots as string[]);
  if (!root) return true;
  const name = basename(absPath);
  const rel = toPosix(absPath.slice(root.length)).replace(/^\/+/, "");
  const scope = resolveLinkScope(getOpts()[root], dirOfRel(rel));
  if (!scope.enabled) return false;
  const kind = kindOfName(name);
  return kind === null ? true : scope.kinds.has(kind);
}

/**
 * 切换某文件夹的显式关联规则（文件树右键快捷开关与对话框勾选共用，纯函数）：
 *  - 有效开 → 写 `{ enabled: false }` 断开该子树（其下显式恢复的子级仍就近生效）；
 *  - 有效关且自身有显式关而父级有效开 → 删自身 enabled 回到继承（父级开 = 恢复）；
 *  - 有效关（继承自断开的祖先）→ 写 `{ enabled: true }` 显式恢复。
 * 返回新对象；整个根配置因此变空时返回 undefined（调用方据此删键）。
 * 根级开关不走此函数（relDir 为空原样返回）。
 */
export function toggleFolderRule(
  opts: RootLinkOptions | undefined,
  relDir: string
): RootLinkOptions | undefined {
  const segs = relDir.split("/").filter((s) => s !== "");
  if (segs.length === 0) return opts;
  const parentEnabled = resolveLinkScope(opts, segs.slice(0, -1).join("/")).enabled;
  // 命中既有键（大小写不敏感）就原位改写，避免产生仅大小写不同的重复键。
  const hit = folderRuleAt(opts?.folders, segs.join("/"));
  const key = hit ? hit[0] : segs.join("/");
  const own: FolderLinkRule | undefined = hit ? hit[1] : undefined;

  const nextFolders: Record<string, FolderLinkRule> = { ...(opts?.folders ?? {}) };
  if (resolveLinkScope(opts, key).enabled) {
    nextFolders[key] = { ...own, enabled: false };
  } else if (own?.enabled === false && parentEnabled) {
    const rest = { ...own };
    delete rest.enabled;
    if (Object.keys(rest).length > 0) nextFolders[key] = rest;
    else delete nextFolders[key];
  } else {
    nextFolders[key] = { ...own, enabled: true };
  }

  const next: RootLinkOptions = { ...(opts ?? {}) };
  // 恒定覆盖（而非仅在非空时覆盖）：删空后必须把 spread 进来的旧 folders
  // 引用一并去掉，否则「回到继承」的删键会原地复活。
  if (Object.keys(nextFolders).length > 0) next.folders = nextFolders;
  else delete next.folders;
  if (next.enabled === undefined && next.fileTypes === undefined && next.folders === undefined) {
    return undefined;
  }
  return next;
}
