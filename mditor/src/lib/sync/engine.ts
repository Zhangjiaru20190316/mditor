// 云同步引擎（v4.12，§5）：3-way 状态判定 / 动作矩阵 / 编排执行。
//
// 分层契约（D2）：扫描、清单、矩阵、冲突策略全在此（前端编排）；S3 IO 经
// SyncIO 注入——默认实现走 fs 适配层 + s3.ts 原语，单测用内存桩替换。
// 幂等可重入（§5.4）：manifest 只在收尾落盘一次，中途崩溃下次按旧清单重算；
// 全部原语本身幂等（PUT/GET 覆盖写、删除动作由矩阵前置判定锚定）。
//
// 状态模型说明（对 §5.2/§5.3 的保守补全）：矩阵的 4 态（same/changed/
// deleted/new）无法表达「无记录且不存在」的一侧（首同步时另一侧从未见过
// 该文件）。本引擎引入第 5 态 "absent" 承接该格：new×absent = 本地单侧
// 新增（upload），absent×new = 远端单侧新增（download），new×new = 首同步
// 冲突，其余含 absent 的不可达格一律按规格走冲突兜底——不 panic、不静默丢弃。
//
// 内容比对说明：规格用「本地 md5 vs 远端内容型 ETag」判同；WebCrypto 的
// subtleCrypto 不提供 MD5（只有 SHA 系），故本实现改为冲突发生时流式比对
// 双侧文件（io.localFilesEqual，Rust 侧 256KB 分块读盘）——语义严格强于
// md5 等值（冲突低频，且字节全程不经前端）。manifest 的 md5 字段保留于
// schema（恒记 null），兼容清单格式。
//
// 文件通道说明（v4.12.4 崩溃修复）：上传/下载/冲突暂存全部走「路径」而非
// 「字节」——io.s3PutFile/s3GetFile 由 Rust 直读直写本地文件，文件字节不
// 经 IPC。旧实现把 ≤50MB 文件 base64 后整包 JSON IPC（~4.3x 内存放大 ×并
// 发叠加），是「启用云同步后首同步崩溃」的头号元凶。

import { getAdapter } from "../../platform";
import { basename, extname, joinAbs, toPosix } from "../path-shim";
import type { RootSyncOptions } from "../../types";
import { s3Delete, s3GetFile, s3List, s3PutFile } from "./s3";
import { readManifest, writeManifest, type SyncManifest } from "./manifest";
import type {
  S3ConfigPayload,
  S3Object,
  SyncManifestFile,
  SyncSummary,
  SyncDirection,
  ConflictPolicy,
} from "./types";
import { EMPTY_SYNC_SUMMARY } from "./types";
import {
  DEFAULT_SYNCABLE_EXTS,
  isExcludedRelPath,
  isIgnoredName,
  isIgnoredRelPath,
  isSyncableRelPath,
  isTooDeep,
  isTooLarge,
  MAX_SYNC_DEPTH,
  type RootExcludeRules,
} from "./ignore";

/** 引擎内部状态：规格 4 态 + absent（见文件头注释）。 */
export type EngineSideState = "same" | "changed" | "deleted" | "new" | "absent";

/** 本地扫描结果（listLocal 返回）。 */
export interface LocalScanFile {
  relPath: string; // posix 风格，相对工作区根
  mtimeMs: number;
  size: number;
}

/** 引擎的全部 IO（默认实现 createDefaultSyncIO；单测注入内存桩）。 */
export interface SyncIO {
  /** 递归扫描（应用名称/深度/符号链接忽略；大小过滤由引擎统一做——双侧一致）。 */
  listLocal(root: string): Promise<LocalScanFile[]>;
  s3List(prefix: string): Promise<S3Object[]>;
  /** 下载远端对象到本地文件（实现保证父目录存在；字节不经 JS）。 */
  s3GetFile(key: string, destAbs: string): Promise<void>;
  /** 上传本地文件（实现直读 absPath；字节不经 JS）。 */
  s3PutFile(key: string, absPath: string, mtimeMs?: number): Promise<S3Object>;
  s3Delete(key: string): Promise<void>;
  readManifest(root: string): Promise<SyncManifest | null>;
  writeManifest(root: string, m: SyncManifest): Promise<void>;
  /** 下载前重 stat：返回 null = 文件已不存在；mtime 比扫描时新 → 脏文件跳过。 */
  statLocal(absPath: string): Promise<{ mtimeMs: number; size: number } | null>;
  /** 两个本地文件字节等值（冲突内容比对；流式实现，零大内存）。 */
  localFilesEqual(a: string, b: string): Promise<boolean>;
  /** 复制本地文件（冲突副本从暂存区落位），父目录自动创建。 */
  copyLocal(fromAbs: string, toAbs: string): Promise<void>;
  /** 删除本地文件（best-effort 场景由调用方自行 catch）。 */
  removeLocal(absPath: string): Promise<void>;
  /** 引擎暂存文件路径（app-data sync/tmp 下；实现保证目录存在）。 */
  syncTempFile(name: string): Promise<string>;
  renameLocal(oldAbs: string, newAbs: string): Promise<void>;
}

/** 引擎对外回调（阶段广播 + 警告收集）。 */
export interface SyncHooks {
  onState(evt: {
    phase: "scan" | "list" | "transfer" | "finalize";
    done: number;
    total: number;
    currentFile?: string;
  }): void;
  /** 非致命警告（超限跳过 / 脏文件跳过 / 单文件失败等），进摘要 notes。 */
  warn(msg: string): void;
  /** D1 逃生门：批量删除保险触发时征求放行。返回 true = 本轮放行删除
   *  （清单随轮落盘，下轮起比例归零自解）；缺省 / false = 维持拦截中止。
   *  触发层仅在手动同步轮次提供——自动轮次保持纯拦截（防定时器反复弹窗）。 */
  confirmMassDelete?(info: { root: string; count: number; tracked: number }): Promise<boolean>;
}

/** moveFileWithFallback 的注入原语（通用工具；v5.1.2 起同步不再有 trashMove
 *  调用方，保留函数与单测作为跨盘移动的已验证实现）。 */
export interface MoveFileIo {
  rename(a: string, b: string): Promise<void>;
  copy(a: string, b: string): Promise<void>;
  remove(a: string): Promise<void>;
}

/** 同盘 rename 原子移动；跨盘（Windows/Linux 均报 EXDEV 类错误）回退
 *  copy+delete。工作区与 app-data 常在不同卷（E:\笔记 → C:\AppData），
 *  直接 rename 必败：2026-09-22/23 生产日志 517 连报 MD-10002「删除失败：
 *  failed to rename old path …」即此。copy 失败时原样抛出（源文件不动，
 *  由上层 warn 兜底），绝不先删后拷。 */
export async function moveFileWithFallback(
  src: string,
  target: string,
  io: MoveFileIo
): Promise<void> {
  try {
    await io.rename(src, target);
  } catch {
    await io.copy(src, target);
    await io.remove(src);
  }
}

// ---------------------------------------------------------------------------
// 状态判定（§5.2）纯函数
// ---------------------------------------------------------------------------

/** mtime 取整到秒比较（容忍 FS 精度差异：NTFS 100ns vs 清单秒级）。 */
export function sameSecond(a: number, b: number): boolean {
  return Math.floor(a / 1000) === Math.floor(b / 1000);
}

/** 本地侧状态（相对 manifest 快照）。 */
export function computeLocalState(
  present: LocalScanFile | undefined,
  record: SyncManifestFile | undefined
): EngineSideState {
  const rec = record?.local ?? null;
  if (rec) {
    if (!present) return "deleted";
    if (!sameSecond(present.mtimeMs, rec.mtimeMs) || present.size !== rec.size) {
      return "changed";
    }
    return "same";
  }
  return present ? "new" : "absent";
}

/** 远端侧状态（相对 manifest 快照）。 */
export function computeRemoteState(
  listed: S3Object | undefined,
  record: SyncManifestFile | undefined
): EngineSideState {
  const rec = record?.remote ?? null;
  if (rec) {
    if (!listed) return "deleted";
    if (
      (listed.etag ?? "") !== rec.etag ||
      listed.size !== rec.size ||
      listed.lastModified !== rec.lastModified
    ) {
      return "changed";
    }
    return "same";
  }
  return listed ? "new" : "absent";
}

/** 动作枚举（矩阵输出）。v5.1.2 铁律：不存在 deleteLocal——同步永不删除/
 *  移动本地文件；远端丢失一律重新上传自愈（本地为存在性的唯一事实源）。 */
export type EngineAction =
  | "skip"
  | "download"
  | "upload"
  | "deleteRemote"
  | "restoreLocal"
  | "clearRecord"
  | "conflict";

/**
 * 动作矩阵（§5.3；v5.1.2 修订）。L 行 × R 列：
 *
 *              same      changed     deleted      new        absent
 *   same       skip      download    upload       download   conflict
 *   changed    upload    conflict    upload       conflict   conflict
 *   deleted    deleteRemote restore  clearRecord  conflict   conflict
 *   new        conflict  conflict    conflict     conflict   upload
 *   absent     conflict  conflict    conflict     download   conflict
 *
 * 前 4 行 × 前 4 列与规格矩阵逐格一致，唯 same×deleted 由 deleteLocal 改为
 * upload（远端丢失自愈——曾因键编码错配把远端看成空，deleteLocal 引发
 * 2026-10-23 批量误移本地文件事故，自此引擎不再具备删除本地文件的路径）；
 * absent 行/列为保守补全（见文件头注释）。
 */
export function decideAction(l: EngineSideState, r: EngineSideState): EngineAction {
  const MATRIX: Record<string, EngineAction> = {
    "same|same": "skip",
    "same|changed": "download",
    "same|deleted": "upload", // 远端丢失 → 重新上传自愈（v5.1.2：不删本地）
    "same|new": "download",
    "same|absent": "conflict",
    "changed|same": "upload",
    "changed|changed": "conflict",
    "changed|deleted": "upload", // 改动胜过删除
    "changed|new": "conflict",
    "changed|absent": "conflict",
    "deleted|same": "deleteRemote",
    "deleted|changed": "restoreLocal", // 下载恢复
    "deleted|deleted": "clearRecord",
    "deleted|new": "conflict", // 不可能* → 冲突兜底
    "deleted|absent": "conflict",
    "new|same": "conflict", // 不可能* → 冲突兜底
    "new|changed": "conflict", // 不可能* → 冲突兜底
    "new|deleted": "conflict", // 不可能* → 冲突兜底
    "new|new": "conflict", // 首同步冲突
    "new|absent": "upload", // 首同步 / 新建本地文件
    "absent|same": "conflict",
    "absent|changed": "conflict",
    "absent|deleted": "conflict",
    "absent|new": "download", // 首同步 / 另一机器新建
    "absent|absent": "conflict", // 不可达（key 并集保证至少一侧有信息）
  };
  return MATRIX[`${l}|${r}`] ?? "conflict";
}

// ---------------------------------------------------------------------------
// 方向模式（v5.2）：矩阵输出 → 模式执行面（纯函数）
// ---------------------------------------------------------------------------

/** applyDirection 的结果：收窄后的计划 + 被忽略改动的计数（进 summary.notes）。 */
export interface DirectionPlan {
  ops: PlannedOp[];
  /** 被忽略的远端侧改动数（仅上传模式）。 */
  ignoredRemote: number;
  /** 被忽略的本地侧改动数（仅下载模式）。 */
  ignoredLocal: number;
}

/**
 * 方向模式在 ops 计划层收窄执行面（v5.2）：动作矩阵本体不动（所有方向
 * 共享同一状态判定），仅对矩阵输出重映射/丢弃——
 *
 * - uploadOnly（本地为主，备份镜像）：丢弃 download/restoreLocal（远端
 *   改动不落本地）；upload/deleteRemote/clearRecord 照常（本地删除传播
 *   到云端，D1 批量删除保险仍然生效）；远端丢失自愈 upload 照常（本地
 *   为存在性事实源）。冲突保留给 resolveConflict（本地胜 + 败者副本，
 *   双侧数据零丢失），仅「收编会走下载」的单侧缺失格在计划层丢弃。
 * - downloadOnly（云端为准）：丢弃 upload（本地改动不上云）；deleteRemote
 *   （本地删×远端在）→ restoreLocal——本地删除被云端拉回；远端被删×
 *   本地在的自愈 upload 丢弃——v5.1.2 铁律：引擎永不删除本地文件，云端
 *   删除不传播。冲突保留给 resolveConflict（远端胜 + 败者副本）。
 *
 * 被忽略的改动留在 manifest 旧记录上（本轮不更新），切回双向时自然按
 * changed 重新评估，无误删风险。
 */
export function applyDirection(
  ops: PlannedOp[],
  direction: SyncDirection | undefined
): DirectionPlan {
  if (direction === undefined || direction === "bidirectional") {
    return { ops, ignoredRemote: 0, ignoredLocal: 0 };
  }
  const out: PlannedOp[] = [];
  let ignoredRemote = 0;
  let ignoredLocal = 0;
  for (const op of ops) {
    if (direction === "uploadOnly") {
      if (op.action === "download" || op.action === "restoreLocal") {
        ignoredRemote++;
        continue;
      }
      if (op.action === "conflict" && !op.local) {
        // 缺本地的冲突格（absent×same/changed、deleted×changed）：收编只可
        // 能走下载（与方向相悖）或镜像删除远端改动版（无副本）——保守丢弃。
        ignoredRemote++;
        continue;
      }
      out.push(op);
      continue;
    }
    // downloadOnly
    if (op.action === "upload") {
      ignoredLocal++;
      continue;
    }
    if (op.action === "deleteRemote") {
      // 本地删×远端在 → 云端为准，restoreLocal 拉回（不删本地、不上传）。
      if (op.remote) out.push({ ...op, action: "restoreLocal" });
      continue;
    }
    if (op.action === "conflict" && !op.remote) {
      // 缺远端的冲突格（changed×absent 等）：收编只可能走上传——丢弃。
      ignoredLocal++;
      continue;
    }
    out.push(op); // download / restoreLocal / clearRecord / 双侧齐的 conflict
  }
  return { ops: out, ignoredRemote, ignoredLocal };
}

/**
 * 方向 + 冲突策略 → 冲突胜者覆盖（v5.2）。undefined = 新者胜（既有行为）：
 * 双向 + newestWins。方向优先于策略（仅上传/仅下载的胜者是方向的必然
 * 推论）；显式策略下时钟不可信不再需要兜底——胜者本就确定。
 */
export function resolveConflictWinner(
  direction: SyncDirection | undefined,
  policy: ConflictPolicy | undefined
): "local" | "remote" | undefined {
  if (direction === "uploadOnly") return "local";
  if (direction === "downloadOnly") return "remote";
  if (policy === "localFirst") return "local";
  if (policy === "remoteFirst") return "remote";
  return undefined;
}

// ---------------------------------------------------------------------------
// 冲突辅助（纯函数）
// ---------------------------------------------------------------------------

/** 仅单段 PUT 的 ETag 才是内容 MD5（32 hex 无 `-`）；multipart 带 `-N` 不可比。 */
export function isContentEtag(etag: string | null): boolean {
  return !!etag && /^[0-9a-f]{32}$/i.test(etag);
}

/** 冲突副本名：`<原名去扩展>.冲突-YYYYMMDD-HHmmss.<原扩展>`（同目录）。 */
export function conflictCopyName(relPath: string, nowMs = Date.now()): string {
  const d = new Date(nowMs);
  const stamp =
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
      d.getDate()
    ).padStart(2, "0")}` +
    "-" +
    `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(
      d.getSeconds()
    ).padStart(2, "0")}`;
  const ext = extname(relPath);
  const stem = ext ? relPath.slice(0, relPath.length - ext.length) : relPath;
  return ext ? `${stem}.冲突-${stamp}${ext}` : `${stem}.冲突-${stamp}`;
}

/** 远端 lastModified（RFC3339）→ epoch ms；解析失败返回 NaN（时钟不可信路径）。 */
export function remoteEpochMs(lastModified: string): number {
  const t = Date.parse(lastModified);
  return Number.isNaN(t) ? NaN : t;
}

/** 字节等值（冲突分支 1 的内容比对；长度不同快速短路）。 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 编排（§5.4）
// ---------------------------------------------------------------------------

/** relPath（posix）→ 本地绝对路径。 */
function absOf(root: string, relPath: string): string {
  return joinAbs(root, ...relPath.split("/"));
}

/** 上传 / 下载并发上限（D6：≤3；v4.12.4 降为 2——四根全量首传时给
 *  WebView/Rust 双侧留内存余量，避免多份传输缓冲瞬时叠加）。 */
const TRANSFER_CONCURRENCY = 2;

/** 分批并发执行（单任务失败收集不中断）。 */
async function runBatch<T>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
  onErr: (item: T, err: unknown) => void
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        await run(items[i]);
      } catch (e) {
        onErr(items[i], e);
      }
    }
  });
  await Promise.all(workers);
}

/** 一次同步的结果。 */
export interface SyncOutcome {
  summary: SyncSummary;
  /** 首同步（无清单 / 路径漂移 / 远端身份变化后全量重算）。 */
  firstSync: boolean;
  /** D1：本轮被安全保险中止（未落盘清单，下轮原样重算）。 */
  aborted?: "mass-delete";
  /** v5.3 purge 阶段成功删除的云端对象 relPath（调用方据此清 pendingPurges）。 */
  purged: string[];
  /** v5.3 purge 阶段删除失败的 relPath（留在队列下轮重试）。 */
  purgeFailed: string[];
}

/**
 * 每根同步范围（v5.3）：由 trigger 从 SyncSettings.rootOptions[root] 解析
 * 传入；undefined = 全默认（内置白名单、无排除）。
 */
export interface RootSyncScope {
  /** 扩展名白名单（custom 模式为用户列表，default 模式为 DEFAULT_SYNCABLE_EXTS）。 */
  exts: ReadonlySet<string>;
  /** 排除规则（目录前缀 + 通配），传给 isExcludedRelPath。 */
  exclude: RootExcludeRules;
}

/**
 * RootSyncOptions → 引擎 scope（v5.3，trigger 每轮实时解析）。全部为默认
 * 时返回 undefined（引擎走既有行为，零语义变化）；extensionMode=custom 且
 * 列表为空的配置归一层已剔除，这里再兜底一次回落内置白名单。
 */
export function resolveRootScope(
  opts: RootSyncOptions | undefined
): RootSyncScope | undefined {
  if (!opts) return undefined;
  const exts =
    opts.extensionMode === "custom" && opts.extensions && opts.extensions.length > 0
      ? new Set<string>(opts.extensions)
      : undefined;
  const hasExclude =
    (opts.excludedDirs !== undefined && opts.excludedDirs.length > 0) ||
    (opts.excludePatterns !== undefined && opts.excludePatterns.length > 0);
  if (!exts && !hasExclude) return undefined;
  return {
    exts: exts ?? DEFAULT_SYNCABLE_EXTS,
    exclude: { excludedDirs: opts.excludedDirs, excludePatterns: opts.excludePatterns },
  };
}

export interface PlannedOp {
  relPath: string;
  action: EngineAction;
  local?: LocalScanFile;
  remote?: S3Object;
}

/**
 * 远端目录名解析：remoteDir 覆盖值经消毒（去首尾 /、逐段拒空/./..、空回退），
 * 未提供时回退根路径 basename（桌面语义，键空间规则与 v4.12 兼容）。
 * v5.3.1：允许多段子路径（如「笔记/cmc」）——设备目录与桌面主工作区的
 * 子目录配对（此前拒内部 /，两端键空间只能配对到「专属根」，专属根关闭
 * 即静默分叉）。段级消毒保证绝不产生穿越（.. 被整体回退）。
 */
export function resolveRemoteDir(root: string, remoteDir?: string): string {
  const fallback = basename(toPosix(root));
  if (remoteDir === undefined) return fallback;
  const s = remoteDir.trim().replace(/^\/+|\/+$/g, "");
  if (s.length === 0) return fallback;
  const segs = s.split("/");
  if (segs.some((seg) => seg === "" || seg === "." || seg === "..")) {
    return fallback;
  }
  return segs.join("/");
}

/** 桶内完整前缀（恒以 / 结尾）。引擎与 trigger（指纹计算）共用同一推导。 */
export function fullPrefixOf(prefix: string, root: string, remoteDir?: string): string {
  return `${prefix}${resolveRemoteDir(root, remoteDir)}/`;
}

/**
 * 同步单个工作区根 ↔ 桶内 <prefix>/<根目录名>/。互斥由调用方（trigger）
 * 保证；本函数自身不重入。连接配置经注入的 io 携带（默认实现
 * createDefaultSyncIO(cfg)）。事件流：scan → list → transfer(增量) → finalize。
 *
 * remoteDir：远端目录名覆盖。桌面根是真实路径，basename 即真实目录名；
 * 鸿蒙根是虚拟 token（/Docs/ws-N），basename 是设备本地标识——两端键空间
 * 会不相交（各自备份、永不收敛）。平台层传入真实文件夹名即可与桌面
 * 「同名工作区」配对。换名经 remoteFingerprint 失配走首同步，零删除动作。
 */
export async function syncWorkspace(
  root: string,
  prefix: string,
  io: SyncIO,
  hooks: SyncHooks,
  /** D1：远端身份指纹（endpoint+bucket+prefix）。传入时与清单比对，
   *  不一致 ⇒ 对着新桶/新前缀用旧清单会把全部已跟踪文件判成「远端已删除」
   *  ⇒ 整库进回收站。改为按首同步重算（首同步矩阵不产生任何删除动作）。 */
  remoteIdentity?: string,
  remoteDir?: string,
  /** v5.2：方向与冲突策略。缺省 = 双向 + 新者胜（既有行为）。v5.3 增补：
   *  scope = 每根同步范围（undefined = 全默认）；purgeRemote = 待清除云端
   *  副本 relPath 队列（用户显式确认过，purge 阶段执行，不受批量删除保险
   *  约束——已确认的删除不是保险要拦截的「疑似误配」）。 */
  mode?: {
    direction?: SyncDirection;
    conflictPolicy?: ConflictPolicy;
    scope?: RootSyncScope;
    purgeRemote?: readonly string[];
  }
): Promise<SyncOutcome> {
  const summary: SyncSummary = { ...EMPTY_SYNC_SUMMARY, notes: [] };
  const fullPrefix = fullPrefixOf(prefix, root, remoteDir);
  const direction = mode?.direction;
  const conflictWinner = resolveConflictWinner(direction, mode?.conflictPolicy);
  // v5.3 每根范围：白名单与排除规则在本地扫描 / 远端 List 双侧一致应用。
  const exts = mode?.scope?.exts ?? DEFAULT_SYNCABLE_EXTS;
  const exclude = mode?.scope?.exclude;
  const purged: string[] = [];
  const purgeFailed: string[] = [];

  hooks.onState({ phase: "scan", done: 0, total: 0 });

  // 1. 读清单：无 / 版本不识别 / 路径漂移 / 远端身份变化 → 首同步模式。
  //    指纹比对只在「两侧都有值且不同」时触发——旧版清单没有指纹字段，
  //    升级首轮按匹配处理并在 finalize 补写，避免无谓的全量冲突风暴。
  let manifest = await io.readManifest(root);
  let firstSync = false;
  if (
    !manifest ||
    toPosix(manifest.workspaceRoot).toLowerCase() !== toPosix(root).toLowerCase() ||
    (remoteIdentity !== undefined &&
      manifest.remoteFingerprint !== undefined &&
      manifest.remoteFingerprint !== remoteIdentity)
  ) {
    manifest = { version: 1, workspaceRoot: root, lastSyncAt: 0, files: {} };
    if (remoteIdentity !== undefined) manifest.remoteFingerprint = remoteIdentity;
    firstSync = true;
  }
  const files: Record<string, SyncManifestFile> = { ...manifest.files };

  // 2. 扫描本地。大小超限的键「冻结」（suspended）：不参与状态判定与任何
  //    操作、记录原样保留——若只把本地一侧过滤掉，矩阵会把远端判成
  //    deleted/same 而误删或误下传对端；名称忽略由 io.listLocal 与下方
  //    isIgnoredRelPath 双侧一致保证（引擎侧兜底再滤一遍）。
  const scanned = await io.listLocal(root);
  const suspended = new Set<string>();
  const localMap = new Map<string, LocalScanFile>();
  for (const f of scanned) {
    if (
      isIgnoredRelPath(f.relPath) ||
      !isSyncableRelPath(f.relPath, exts) ||
      isExcludedRelPath(f.relPath, exclude) ||
      isTooDeep(f.relPath)
    ) {
      continue;
    }
    if (isTooLarge(f.size)) {
      hooks.warn(`文件超过 50MB 上限，本轮跳过同步：${f.relPath}`);
      summary.skipped++;
      suspended.add(f.relPath);
      continue;
    }
    localMap.set(f.relPath, f);
  }

  // 3. 远端全分页 List，剥前缀得 relPath，同样按忽略规则过滤。
  hooks.onState({ phase: "list", done: 0, total: 0 });
  const remoteList = await io.s3List(fullPrefix);
  const remoteMap = new Map<string, S3Object>();
  for (const obj of remoteList) {
    if (!obj.key.startsWith(fullPrefix)) continue;
    const relPath = obj.key.slice(fullPrefix.length);
    if (
      relPath === "" ||
      isIgnoredRelPath(relPath) ||
      !isSyncableRelPath(relPath, exts) ||
      isExcludedRelPath(relPath, exclude) ||
      isTooDeep(relPath)
    ) {
      continue;
    }
    // D7 前端侧防线：远端还原的 relPath 携带 .. / 反斜杠 / 控制字符 → 弃。
    // eslint-disable-next-line no-control-regex -- 控制字符正是要拒绝的目标
    if (relPath.split("/").includes("..") || relPath.includes("\\") || /[\x00-\x1f]/.test(relPath)) {
      continue;
    }
    if (isTooLarge(obj.size)) {
      hooks.warn(`远端对象超过 50MB 上限，本轮跳过同步：${relPath}`);
      summary.skipped++;
      suspended.add(relPath);
      continue;
    }
    remoteMap.set(relPath, obj);
  }

  // 4. keys = localMap ∪ remoteMap ∪ manifest.files（冻结键除外）。
  const keys = new Set<string>([
    ...localMap.keys(),
    ...remoteMap.keys(),
    ...Object.keys(files),
  ]);
  for (const k of suspended) keys.delete(k);

  // 5. 逐 key 判定 L/R → 查矩阵 → 计划列表 → 方向模式收窄（v5.2）。
  const planned: PlannedOp[] = [];
  for (const key of keys) {
    const record = files[key];
    const local = localMap.get(key);
    const remote = remoteMap.get(key);
    const action = decideAction(
      computeLocalState(local, record),
      computeRemoteState(remote, record)
    );
    if (action === "skip") continue;
    planned.push({ relPath: key, action, local, remote });
  }
  const dirPlan = applyDirection(planned, direction);
  const ops = dirPlan.ops;
  if (dirPlan.ignoredRemote > 0) {
    summary.notes.push(`仅上传模式：已忽略 ${dirPlan.ignoredRemote} 个远端改动（本地为准）。`);
  }
  if (dirPlan.ignoredLocal > 0) {
    summary.notes.push(`仅下载模式：已忽略 ${dirPlan.ignoredLocal} 个本地改动（云端为准）。`);
  }

  // 6. 执行顺序：冲突（含其副本上传/下载，按 key 内聚）→ 普通下载 → 普通
  //    上传 → 删除（串行）。下载/上传并发 ≤3。
  hooks.onState({ phase: "transfer", done: 0, total: ops.length });
  let done = 0;
  const tick = (currentFile?: string) =>
    hooks.onState({ phase: "transfer", done, total: ops.length, currentFile });

  const setRecord = (key: string, rec: SyncManifestFile) => {
    files[key] = rec;
  };
  const dropRecord = (key: string) => {
    delete files[key];
  };

  /** 下载并落盘（download/restoreLocal 共用）：脏文件检测 + D7 写盘前校验。 */
  const doDownload = async (key: string, remote: S3Object): Promise<boolean> => {
    // D7 写盘前校验：剥前缀后的 relPath 再核一遍（防恶意桶目录穿越写盘）。
    if (key.split("/").includes("..") || key.includes("\\") || key.startsWith("/")) {
      hooks.warn(`远端对象路径非法，跳过下载：${key}`);
      summary.skipped++;
      return false;
    }
    const abs = absOf(root, key);
    // 下载前重 stat：扫描之后又被编辑（mtime 更新）→ 跳过并告警（不覆盖）。
    const fresh = await io.statLocal(abs).catch(() => null);
    const scannedF = localMap.get(key);
    if (fresh && !scannedF) {
      // D4：扫描时不存在、下载时已存在 ⇒ TOCTOU 窗口期被新建/恢复。
      // 旧守卫只认「扫描时已存在且 mtime 变新」，窗口期新建会被远端内容
      // 直接覆盖。缺 scannedF 一律视为脏文件跳过。
      hooks.warn(`同步窗口期内新建的文件，跳过下载以免覆盖：${key}`);
      summary.skipped++;
      return false;
    }
    if (
      fresh &&
      scannedF &&
      fresh.mtimeMs > scannedF.mtimeMs &&
      !sameSecond(fresh.mtimeMs, scannedF.mtimeMs)
    ) {
      hooks.warn(`脏文件跳过（正在编辑，未被远端覆盖）：${key}`);
      summary.skipped++;
      return false;
    }
    await io.s3GetFile(remote.key, abs);
    // 记录真实落盘后的 mtime/size，避免下次扫描误判 changed。
    const st = (await io.statLocal(abs).catch(() => null)) ?? {
      mtimeMs: Date.now(),
      size: remote.size,
    };
    setRecord(key, {
      local: { mtimeMs: st.mtimeMs, size: st.size, md5: null },
      remote: { etag: remote.etag ?? "", size: remote.size, lastModified: remote.lastModified },
    });
    return true;
  };

  /** 上传本地文件（普通上传与冲突后上传共用）。 */
  const doUpload = async (key: string, local: LocalScanFile): Promise<void> => {
    const put = await io.s3PutFile(`${fullPrefix}${key}`, absOf(root, key), local.mtimeMs);
    setRecord(key, {
      local: { mtimeMs: local.mtimeMs, size: local.size, md5: null },
      remote: { etag: put.etag ?? "", size: put.size, lastModified: put.lastModified },
    });
  };

  // ---- 6a. 冲突（串行——副本命名与双侧内容强相关，避免交错）----
  const conflicts = ops.filter((o) => o.action === "conflict");
  for (const op of conflicts) {
    tick(op.relPath);
    try {
      await resolveConflict(op, { root, fullPrefix, io, files, localMap, remoteMap, summary, hooks, winner: conflictWinner });
      summary.conflicts++;
    } catch (e) {
      summary.failed++;
      hooks.warn(`冲突处理失败：${op.relPath}（${String(e).slice(0, 120)}）`);
    }
    done++;
    tick();
  }

  // ---- 6b. 普通下载（并发 ≤3）----
  const downloads = ops.filter((o) => o.action === "download" || o.action === "restoreLocal");
  await runBatch(
    downloads,
    TRANSFER_CONCURRENCY,
    async (op) => {
      tick(op.relPath);
      if (await doDownload(op.relPath, op.remote!)) summary.downloaded++;
    },
    (op, e) => {
      summary.failed++;
      hooks.warn(`下载失败：${op.relPath}（${String(e).slice(0, 120)}）`);
    }
  );
  done += downloads.length;
  tick();

  // ---- 6c. 普通上传（并发 ≤3）----
  const uploads = ops.filter((o) => o.action === "upload");
  await runBatch(
    uploads,
    TRANSFER_CONCURRENCY,
    async (op) => {
      tick(op.relPath);
      await doUpload(op.relPath, op.local!);
      summary.uploaded++;
    },
    (op, e) => {
      summary.failed++;
      hooks.warn(`上传失败：${op.relPath}（${String(e).slice(0, 120)}）`);
    }
  );
  done += uploads.length;
  tick();

  // ---- 6d. 删除（串行；v5.1.2 起仅云端删除——引擎已无本地删除路径）----
  const deletes = ops.filter((o) => o.action === "deleteRemote" || o.action === "clearRecord");
  // D1 批量删除保险（v5.1.2 起只约束 deleteRemote）：一轮的云端删除超过已
  // 跟踪文件的 10% 且 ≥5 个 ⇒ 最可能是 prefix/桶指错或本地库被整体移走，
  // 而不是用户真的删了整库。立即中止：不执行任何删除、不落盘清单（崩溃
  // 安全点唯一，旧清单原样保留），notes 里给出数量与比例。≥5 的下限避免
  // 小库「3 个文件删 1 个」的正常操作被误伤。
  {
    const destructive = deletes.filter((o) => o.action !== "clearRecord");
    const tracked = Object.keys(manifest.files).length;
    if (tracked > 0 && destructive.length >= 5 && destructive.length / tracked > 0.1) {
      const pct = Math.round((destructive.length / tracked) * 100);
      // D1 逃生门（v5.1.1）：真实的大批删除（用户清理库）此前会每轮被此保险
      // 拦下且清单不落盘 → 永久死锁。手动同步轮次经 confirmMassDelete 征求
      // 用户确认；未提供钩子（自动轮次）或拒绝 → 维持原有纯拦截语义。
      const allowed = hooks.confirmMassDelete
        ? await hooks.confirmMassDelete({ root, count: destructive.length, tracked })
        : false;
      if (allowed) {
        summary.notes.push(`已确认放行云端批量删除：${destructive.length}/${tracked}（${pct}%）。`);
      } else {
        summary.notes.push(
          `已中止同步：本轮将删除云端 ${destructive.length}/${tracked} 个副本（${pct}%；本地文件不受影响）。` +
            `若确认这些删除有效，请手动触发同步（点击状态栏云图标）并在确认框中选择「删除」；` +
            `若非本意，多为同步前缀/桶配置变更所致，请核对云同步设置。云端文件未被改动。`
        );
        hooks.onState({ phase: "finalize", done, total: ops.length });
        return { summary, firstSync, aborted: "mass-delete", purged, purgeFailed };
      }
    }
  }
  for (const op of deletes) {
    tick(op.relPath);
    try {
      if (op.action === "deleteRemote") {
        await io.s3Delete(`${fullPrefix}${op.relPath}`);
        dropRecord(op.relPath);
        summary.deletedRemote++;
      } else {
        dropRecord(op.relPath);
      }
    } catch (e) {
      summary.failed++;
      hooks.warn(`删除失败：${op.relPath}（${String(e).slice(0, 120)}）`);
    }
    done++;
    tick();
  }

  // ---- 6e. purge：清除用户显式确认过「同时删除云端副本」的对象（v5.3）----
  //  与 6d 的矩阵删除不同：这批 key 来自同步范围对话框的显式确认（排除时
  //  连带清理），不是保险要拦截的「疑似误配」，不走批量删除保险。安全约束：
  //  当前仍在同步范围内的 key（扫描视图中本地或远端存在）一律跳过——用户
  //  可能又把它包含了回来，陈旧队列不得删除活跃内容；删除失败的 key 由
  //  调用方留在队列下轮重试。
  const purgeList = mode?.purgeRemote;
  if (purgeList && purgeList.length > 0) {
    for (const raw of purgeList) {
      tick(raw);
      try {
        // D7 同款防线：purge 名单来自持久化设置，执行删除前再核一遍路径。
        if (raw.split("/").includes("..") || raw.includes("\\") || /[\x00-\x1f]/.test(raw)) {
          throw new Error("非法路径");
        }
        if (localMap.has(raw) || remoteMap.has(raw)) {
          summary.notes.push(`已回到同步范围，跳过清除云端副本：${raw}`);
        } else {
          await io.s3Delete(`${fullPrefix}${raw}`);
          dropRecord(raw);
          purged.push(raw);
        }
      } catch (e) {
        purgeFailed.push(raw);
        summary.failed++;
        hooks.warn(`清除云端副本失败（下轮重试）：${raw}（${String(e).slice(0, 120)}）`);
      }
      done++;
      tick();
    }
  }

  // 7/8. 落盘清单（唯一一次写清单——崩溃安全点）+ 完成时间。
  hooks.onState({ phase: "finalize", done, total: ops.length });
  summary.lastSyncAt = Date.now();
  await io.writeManifest(root, {
    version: 1,
    workspaceRoot: root,
    lastSyncAt: summary.lastSyncAt,
    files,
    ...(remoteIdentity !== undefined ? { remoteFingerprint: remoteIdentity } : {}),
  });
  return { summary, firstSync, purged, purgeFailed };
}

// ---------------------------------------------------------------------------
// 冲突解析（§5.3）
// ---------------------------------------------------------------------------

interface ConflictCtx {
  root: string;
  fullPrefix: string;
  io: SyncIO;
  files: Record<string, SyncManifestFile>;
  localMap: Map<string, LocalScanFile>;
  remoteMap: Map<string, S3Object>;
  summary: SyncSummary;
  hooks: SyncHooks;
  /** v5.2 胜者覆盖（方向/冲突策略解析结果）；undefined = 新者胜（既有行为）。 */
  winner?: "local" | "remote";
}

/**
 * 冲突三分支：
 *  1. 内容相同（流式字节比对）→ 无副本，新者覆盖另一侧；
 *  2. 内容不同 → 新者胜（本地 mtime vs 远端 lastModified），败者存
 *     `.冲突-时间戳` 副本（同目录）且双端可见；v5.2 起方向/冲突策略可
 *     覆盖胜者（ctx.winner——显式胜者无需时钟兜底），副本机制不变；
 *  3. 时钟不可信（无法比出新者）→ 远端胜执行第 2 步 + 摘要 note 人工确认。
 *
 * v4.12.4：远端版本先由 Rust 暂存到 app-data 临时文件再流式比对——冲突
 * 低频串行，一次额外 GET 换取字节全程不经前端。
 */
async function resolveConflict(op: PlannedOp, ctx: ConflictCtx): Promise<void> {
  const { io, root, fullPrefix, files, localMap, remoteMap, summary } = ctx;
  const key = op.relPath;
  const local = localMap.get(key);
  const remote = remoteMap.get(key);

  // 不可达兜底格：单侧缺失按存在侧收编；双侧缺失清记录。
  if (!local && remote) {
    await downloadAs(key, remote, ctx);
    summary.downloaded++;
    return;
  }
  if (local && !remote) {
    await uploadAs(key, local, ctx);
    summary.uploaded++;
    return;
  }
  if (!local || !remote) {
    delete files[key];
    return;
  }

  const staged = await io.syncTempFile(`conflict-${Date.now()}-${basename(key)}`);
  try {
    await io.s3GetFile(remote.key, staged);
    const same = await io.localFilesEqual(absOf(root, key), staged);

    // 分支 1：内容相同 → 无副本，新者覆盖另一侧。
    if (same) {
      if (remoteEpochMs(remote.lastModified) > local.mtimeMs) {
        await downloadAs(key, remote, ctx, staged);
        summary.downloaded++;
      } else {
        // 本地新（或相等）→ 上传本地（mtime-only 变化触发一次无害覆盖，已知行为）。
        await uploadAs(key, local, ctx);
        summary.uploaded++;
      }
      return;
    }

    // 分支 2/3：胜者判定（v5.2：方向/冲突策略可覆盖；缺省新者胜），败者保副本。
    const lTime = local.mtimeMs;
    const rTime = remoteEpochMs(remote.lastModified);
    let localWins: boolean;
    if (ctx.winner === "local") {
      localWins = true;
    } else if (ctx.winner === "remote") {
      localWins = false;
    } else if (Number.isNaN(rTime)) {
      localWins = false;
      const msg = `冲突时钟不可信（远端 lastModified 无法解析），已按远端为准，请人工确认：${key}`;
      summary.notes.push(msg);
      // D6：时钟类冲突同步升级为 warn——经触发器进入诊断总线与状态事件 notes，
      // 状态栏 tooltip 可见（此前仅沉入 summary.notes，用户无感）。
      ctx.hooks.warn(msg);
    } else if (lTime > rTime + 1000) {
      localWins = true;
    } else if (rTime > lTime + 1000) {
      localWins = false;
    } else {
      // 时间接近无法判定 → 远端胜 + 提示人工确认（§5.3 第 3 条）。
      localWins = false;
      const msg = `冲突双方时间接近无法判定新旧，已按远端为准，请人工确认冲突副本：${key}`;
      summary.notes.push(msg);
      ctx.hooks.warn(msg); // D6：同上，提升为用户可见警告
    }

    const copyRel = conflictCopyName(key);
    const copyAbs = absOf(root, copyRel);

    if (localWins) {
      // 本地胜：远端旧内容（暂存）存为冲突副本（本地 + 上传）；本地内容上传为正主。
      await io.copyLocal(staged, copyAbs);
      const copyStat = (await io.statLocal(copyAbs).catch(() => null)) ?? {
        mtimeMs: Date.now(),
        size: remote.size,
      };
      const putCopy = await io.s3PutFile(`${fullPrefix}${copyRel}`, copyAbs, copyStat.mtimeMs);
      files[copyRel] = {
        local: { mtimeMs: copyStat.mtimeMs, size: copyStat.size, md5: null },
        remote: { etag: putCopy.etag ?? "", size: putCopy.size, lastModified: putCopy.lastModified },
      };
      await uploadAs(key, local, ctx);
    } else {
      // 远端胜：本地旧内容改名为冲突副本并上传；远端内容（暂存）落为正主。
      await io.renameLocal(absOf(root, key), copyAbs);
      const copyStat = (await io.statLocal(copyAbs).catch(() => null)) ?? {
        mtimeMs: Date.now(),
        size: local.size,
      };
      const putCopy = await io.s3PutFile(`${fullPrefix}${copyRel}`, copyAbs, copyStat.mtimeMs);
      files[copyRel] = {
        local: { mtimeMs: copyStat.mtimeMs, size: copyStat.size, md5: null },
        remote: { etag: putCopy.etag ?? "", size: putCopy.size, lastModified: putCopy.lastModified },
      };
      await downloadAs(key, remote, ctx, staged);
    }
  } finally {
    // 暂存清理（downloadAs 落位后已自行删过；此处兜底收尾，双重删除无害）。
    await io.removeLocal(staged).catch(() => {});
  }
}

/** 冲突内部复用：下载远端为正主并记录两侧快照（staged 暂存存在则复制落位，免二次下载）。 */
async function downloadAs(
  key: string,
  remote: S3Object,
  ctx: ConflictCtx,
  staged?: string
): Promise<void> {
  const { io, root, files } = ctx;
  const abs = absOf(root, key);
  if (staged) {
    await io.copyLocal(staged, abs);
    await io.removeLocal(staged).catch(() => {});
  } else {
    await io.s3GetFile(remote.key, abs);
  }
  const st = (await io.statLocal(abs).catch(() => null)) ?? {
    mtimeMs: Date.now(),
    size: remote.size,
  };
  files[key] = {
    local: { mtimeMs: st.mtimeMs, size: st.size, md5: null },
    remote: { etag: remote.etag ?? "", size: remote.size, lastModified: remote.lastModified },
  };
}

/** 冲突内部复用：上传本地为正主并记录两侧快照（路径直传，免二次读盘）。 */
async function uploadAs(
  key: string,
  local: LocalScanFile,
  ctx: ConflictCtx
): Promise<void> {
  const { io, root, fullPrefix, files } = ctx;
  const put = await io.s3PutFile(`${fullPrefix}${key}`, absOf(root, key), local.mtimeMs);
  files[key] = {
    local: { mtimeMs: local.mtimeMs, size: local.size, md5: null },
    remote: { etag: put.etag ?? "", size: put.size, lastModified: put.lastModified },
  };
}

// ---------------------------------------------------------------------------
// 默认 IO（fs 适配层 + s3.ts 原语；单测用内存桩替换）
// ---------------------------------------------------------------------------

/** 默认 SyncIO：真实文件系统 + S3 原语。 */
export function createDefaultSyncIO(cfg: S3ConfigPayload): SyncIO {
  const fs = () => getAdapter().fs;
  return {
    async listLocal(root) {
      const out: LocalScanFile[] = [];
      const rootPosix = toPosix(root);
      // 迭代遍历。忽略规则：`.` 开头名称（本地+远端一致）；符号链接跳过
      // （tauri readDir 的 DirEntry 运行时带 isSymlink 字段，适配层类型未
      // 声明故 as 探测；鸿蒙零装配不触达）；深度 ≤ MAX_SYNC_DEPTH。
      const stack: Array<{ dir: string; rel: string[] }> = [{ dir: root, rel: [] }];
      while (stack.length > 0) {
        const { dir, rel } = stack.pop()!;
        let entries;
        try {
          entries = await fs().readDir(dir);
        } catch (e) {
          // D2：读失败绝不能当作「空目录」吞掉——整棵子树在扫描结果中缺席，
          // 引擎会把其中所有已跟踪文件判成「本地已删除」而清空远端副本
          // （一次网络盘抖动 = 云端备份被清空）。立即中止本轮：错误向上抛，
          // syncWorkspace 不捕获、不落盘清单，下轮带着完好清单重扫。
          // 「消失的文件」（stat 竞态）仍按原样跳过，二者可区分。
          const reason = e instanceof Error ? e.message : String(e);
          throw new Error(
            `SYNC-SCAN-READFAIL: 目录不可读，本轮同步已中止（不会误判为删除）：${dir}（${reason.slice(0, 80)}）`,
            { cause: e }
          );
        }
        for (const e of entries) {
          if (isIgnoredName(e.name)) continue;
          if ((e as { isSymlink?: boolean }).isSymlink) continue;
          const childRel = [...rel, e.name];
          if (childRel.length > MAX_SYNC_DEPTH) continue;
          const abs = joinAbs(rootPosix, ...childRel);
          if (e.isDirectory) {
            stack.push({ dir: abs, rel: childRel });
          } else {
            let st;
            try {
              st = await fs().stat(abs);
            } catch {
              continue; // 竞态消失的文件
            }
            out.push({
              relPath: childRel.join("/"),
              mtimeMs: st.mtime?.getTime() ?? 0,
              size: st.size,
            });
          }
        }
      }
      return out;
    },
    s3List: (prefix) => s3List(cfg, prefix),
    s3GetFile: (key, destAbs) => s3GetFile(cfg, key, destAbs),
    s3PutFile: (key, absPath, mtimeMs) => s3PutFile(cfg, key, absPath, mtimeMs),
    s3Delete: (key) => s3Delete(cfg, key),
    readManifest: (root) => readManifest(root),
    writeManifest: (root, m) => writeManifest(root, m),
    async statLocal(abs) {
      try {
        const st = await fs().stat(abs);
        return { mtimeMs: st.mtime?.getTime() ?? 0, size: st.size };
      } catch {
        return null;
      }
    },
    // 冲突比对与副本落位：字节全程留在 Rust 侧（v4.12.4）。
    localFilesEqual: (a, b) =>
      getAdapter().app.invoke<boolean>("local_files_equal", { a, b }),
    copyLocal: (from, to) =>
      getAdapter().app.invoke<void>("local_copy_file", { from, to }),
    removeLocal: (abs) => fs().remove(abs),
    async syncTempFile(name) {
      // 暂存目录：与回收站同区的 <app-data>/sync/tmp。
      const appData = await getAdapter().app.appDataDir();
      const dir = `${toPosix(appData)}/sync/tmp`;
      if (!(await fs().exists(dir))) await fs().mkdir(dir, { recursive: true });
      return `${dir}/${name}`;
    },
    renameLocal: (a, b) => fs().rename(a, b),
  };
}
