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
// subtleCrypto 不提供 MD5（只有 SHA 系），故本实现改为冲突发生时直接字节
// 比对——语义严格强于 md5 等值（冲突低频，双侧字节本来就要读）。manifest
// 的 md5 字段保留于 schema（恒记 null），兼容清单格式。

import { getAdapter } from "../../platform";
import { basename, extname, joinAbs, toPosix } from "../path-shim";
import { s3Delete, s3Get, s3List, s3Put } from "./s3";
import { readManifest, writeManifest, type SyncManifest } from "./manifest";
import type { S3ConfigPayload, S3Object, SyncManifestFile, SyncSummary } from "./types";
import { EMPTY_SYNC_SUMMARY } from "./types";
import { isIgnoredName, isIgnoredRelPath, isTooDeep, isTooLarge, MAX_SYNC_DEPTH } from "./ignore";

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
  s3Get(key: string): Promise<Uint8Array>;
  s3Put(key: string, data: Uint8Array, mtimeMs?: number): Promise<S3Object>;
  s3Delete(key: string): Promise<void>;
  readManifest(root: string): Promise<SyncManifest | null>;
  writeManifest(root: string, m: SyncManifest): Promise<void>;
  /** 把工作区内的文件移入回收站（D9：绝不物理删除）。 */
  trashMove(root: string, relPath: string): Promise<void>;
  /** 下载前重 stat：返回 null = 文件已不存在；mtime 比扫描时新 → 脏文件跳过。 */
  statLocal(absPath: string): Promise<{ mtimeMs: number; size: number } | null>;
  readLocalBytes(absPath: string): Promise<Uint8Array>;
  writeFileLocal(absPath: string, data: Uint8Array): Promise<void>;
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

/** 动作枚举（矩阵输出）。 */
export type EngineAction =
  | "skip"
  | "download"
  | "upload"
  | "deleteLocal"
  | "deleteRemote"
  | "restoreLocal"
  | "clearRecord"
  | "conflict";

/**
 * 动作矩阵（§5.3）。L 行 × R 列：
 *
 *              same      changed     deleted      new        absent
 *   same       skip      download    deleteLocal  download   conflict
 *   changed    upload    conflict    upload       conflict   conflict
 *   deleted    deleteRemote restore  clearRecord  conflict   conflict
 *   new        conflict  conflict    conflict     conflict   upload
 *   absent     conflict  conflict    conflict     download   conflict
 *
 * 前 4 行 × 前 4 列与规格矩阵逐格一致（含 4 个「不可能」格的冲突兜底）；
 * absent 行/列为保守补全（见文件头注释）。
 */
export function decideAction(l: EngineSideState, r: EngineSideState): EngineAction {
  const MATRIX: Record<string, EngineAction> = {
    "same|same": "skip",
    "same|changed": "download",
    "same|deleted": "deleteLocal",
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

/** 上传 / 下载并发上限（D6：≤3）。 */
const TRANSFER_CONCURRENCY = 3;

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
  /** 首同步（无清单 / 路径漂移后全量重算）。 */
  firstSync: boolean;
}

interface PlannedOp {
  relPath: string;
  action: EngineAction;
  local?: LocalScanFile;
  remote?: S3Object;
}

/**
 * 同步单个工作区根 ↔ 桶内 <prefix>/<根目录名>/。互斥由调用方（trigger）
 * 保证；本函数自身不重入。连接配置经注入的 io 携带（默认实现
 * createDefaultSyncIO(cfg)）。事件流：scan → list → transfer(增量) → finalize。
 */
export async function syncWorkspace(
  root: string,
  prefix: string,
  io: SyncIO,
  hooks: SyncHooks
): Promise<SyncOutcome> {
  const summary: SyncSummary = { ...EMPTY_SYNC_SUMMARY, notes: [] };
  const rootPosix = toPosix(root);
  const rootName = basename(rootPosix);
  // fullPrefix 恒以 / 结尾（prefix 已归一：非空带尾 /，空则直接根目录名）。
  const fullPrefix = `${prefix}${rootName}/`;

  hooks.onState({ phase: "scan", done: 0, total: 0 });

  // 1. 读清单：无 / 版本不识别 / 路径漂移 → 首同步模式（全量重算）。
  let manifest = await io.readManifest(root);
  let firstSync = false;
  if (
    !manifest ||
    toPosix(manifest.workspaceRoot).toLowerCase() !== rootPosix.toLowerCase()
  ) {
    manifest = { version: 1, workspaceRoot: root, lastSyncAt: 0, files: {} };
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
    if (isIgnoredRelPath(f.relPath) || isTooDeep(f.relPath)) continue;
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
    if (relPath === "" || isIgnoredRelPath(relPath) || isTooDeep(relPath)) continue;
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

  // 5. 逐 key 判定 L/R → 查矩阵 → 计划列表。
  const ops: PlannedOp[] = [];
  for (const key of keys) {
    const record = files[key];
    const local = localMap.get(key);
    const remote = remoteMap.get(key);
    const action = decideAction(
      computeLocalState(local, record),
      computeRemoteState(remote, record)
    );
    if (action === "skip") continue;
    ops.push({ relPath: key, action, local, remote });
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
    const bytes = await io.s3Get(remote.key);
    await io.writeFileLocal(abs, bytes);
    // 记录真实落盘后的 mtime/size，避免下次扫描误判 changed。
    const st = (await io.statLocal(abs).catch(() => null)) ?? {
      mtimeMs: Date.now(),
      size: bytes.length,
    };
    setRecord(key, {
      local: { mtimeMs: st.mtimeMs, size: st.size, md5: null },
      remote: { etag: remote.etag ?? "", size: remote.size, lastModified: remote.lastModified },
    });
    return true;
  };

  /** 上传本地文件（普通上传与冲突后上传共用）。 */
  const doUpload = async (key: string, local: LocalScanFile): Promise<void> => {
    const bytes = await io.readLocalBytes(absOf(root, key));
    const put = await io.s3Put(`${fullPrefix}${key}`, bytes, local.mtimeMs);
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
      await resolveConflict(op, { root, fullPrefix, io, files, localMap, remoteMap, summary, hooks });
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

  // ---- 6d. 删除（串行；本地删除一律回收站，D9）----
  const deletes = ops.filter(
    (o) => o.action === "deleteLocal" || o.action === "deleteRemote" || o.action === "clearRecord"
  );
  for (const op of deletes) {
    tick(op.relPath);
    try {
      if (op.action === "deleteLocal") {
        await io.trashMove(root, op.relPath);
        dropRecord(op.relPath);
        summary.deletedLocal++;
      } else if (op.action === "deleteRemote") {
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

  // 7/8. 落盘清单（唯一一次写清单——崩溃安全点）+ 完成时间。
  hooks.onState({ phase: "finalize", done: ops.length, total: ops.length });
  summary.lastSyncAt = Date.now();
  await io.writeManifest(root, {
    version: 1,
    workspaceRoot: root,
    lastSyncAt: summary.lastSyncAt,
    files,
  });
  return { summary, firstSync };
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
}

/**
 * 冲突三分支：
 *  1. 内容相同（字节等值）→ 无副本，新者覆盖另一侧；
 *  2. 内容不同 → 新者胜（本地 mtime vs 远端 lastModified），败者存
 *     `.冲突-时间戳` 副本（同目录）且双端可见；
 *  3. 时钟不可信（无法比出新者）→ 远端胜执行第 2 步 + 摘要 note 人工确认。
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

  // 双侧字节本来都要读（胜者上传 / 败者副本），顺带完成内容比对。
  const localBytes = await io.readLocalBytes(absOf(root, key));
  const remoteBytes = await io.s3Get(remote.key);

  // 分支 1：内容相同 → 无副本，新者覆盖另一侧。
  if (bytesEqual(localBytes, remoteBytes)) {
    if (remoteEpochMs(remote.lastModified) > local.mtimeMs) {
      await downloadAs(key, remote, ctx, remoteBytes);
      summary.downloaded++;
    } else {
      // 本地新（或相等）→ 上传本地（mtime-only 变化触发一次无害覆盖，已知行为）。
      await uploadAs(key, local, ctx, localBytes);
      summary.uploaded++;
    }
    return;
  }

  // 分支 2/3：新者胜，败者保副本。
  const lTime = local.mtimeMs;
  const rTime = remoteEpochMs(remote.lastModified);
  let localWins: boolean;
  if (Number.isNaN(rTime)) {
    localWins = false;
    summary.notes.push(`冲突时钟不可信（远端 lastModified 无法解析），已按远端为准，请人工确认：${key}`);
  } else if (lTime > rTime + 1000) {
    localWins = true;
  } else if (rTime > lTime + 1000) {
    localWins = false;
  } else {
    // 时间接近无法判定 → 远端胜 + 提示人工确认（§5.3 第 3 条）。
    localWins = false;
    summary.notes.push(`冲突双方时间接近无法判定新旧，已按远端为准，请人工确认冲突副本：${key}`);
  }

  const copyRel = conflictCopyName(key);
  const copyAbs = absOf(root, copyRel);

  if (localWins) {
    // 本地胜：远端旧内容存为冲突副本（本地 + 上传）；本地内容上传为正主。
    await io.writeFileLocal(copyAbs, remoteBytes);
    const copyStat = (await io.statLocal(copyAbs).catch(() => null)) ?? {
      mtimeMs: Date.now(),
      size: remoteBytes.length,
    };
    const putCopy = await io.s3Put(`${fullPrefix}${copyRel}`, remoteBytes, copyStat.mtimeMs);
    files[copyRel] = {
      local: { mtimeMs: copyStat.mtimeMs, size: copyStat.size, md5: null },
      remote: { etag: putCopy.etag ?? "", size: putCopy.size, lastModified: putCopy.lastModified },
    };
    await uploadAs(key, local, ctx, localBytes);
  } else {
    // 远端胜：本地旧内容改名为冲突副本并上传；远端内容落为正主。
    await io.renameLocal(absOf(root, key), copyAbs);
    const copyStat = (await io.statLocal(copyAbs).catch(() => null)) ?? {
      mtimeMs: Date.now(),
      size: localBytes.length,
    };
    const putCopy = await io.s3Put(`${fullPrefix}${copyRel}`, localBytes, copyStat.mtimeMs);
    files[copyRel] = {
      local: { mtimeMs: copyStat.mtimeMs, size: copyStat.size, md5: null },
      remote: { etag: putCopy.etag ?? "", size: putCopy.size, lastModified: putCopy.lastModified },
    };
    await downloadAs(key, remote, ctx, remoteBytes);
  }
}

/** 冲突内部复用：下载远端为正主并记录两侧快照（bytes 已读则直传免二次 GET）。 */
async function downloadAs(
  key: string,
  remote: S3Object,
  ctx: ConflictCtx,
  preloaded?: Uint8Array
): Promise<void> {
  const { io, root, files } = ctx;
  const bytes = preloaded ?? (await io.s3Get(remote.key));
  const abs = absOf(root, key);
  await io.writeFileLocal(abs, bytes);
  const st = (await io.statLocal(abs).catch(() => null)) ?? {
    mtimeMs: Date.now(),
    size: bytes.length,
  };
  files[key] = {
    local: { mtimeMs: st.mtimeMs, size: st.size, md5: null },
    remote: { etag: remote.etag ?? "", size: remote.size, lastModified: remote.lastModified },
  };
}

/** 冲突内部复用：上传本地为正主并记录两侧快照（bytes 已读则直传免二次读盘）。 */
async function uploadAs(
  key: string,
  local: LocalScanFile,
  ctx: ConflictCtx,
  preloaded?: Uint8Array
): Promise<void> {
  const { io, root, fullPrefix, files } = ctx;
  const bytes = preloaded ?? (await io.readLocalBytes(absOf(root, key)));
  const put = await io.s3Put(`${fullPrefix}${key}`, bytes, local.mtimeMs);
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
        } catch {
          continue; // 不可读目录跳过
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
    s3Get: (key) => s3Get(cfg, key),
    s3Put: (key, data, mtimeMs) => s3Put(cfg, key, data, mtimeMs),
    s3Delete: (key) => s3Delete(cfg, key),
    readManifest: (root) => readManifest(root),
    writeManifest: (root, m) => writeManifest(root, m),
    async trashMove(root, relPath) {
      // D9：同步删除移入 <app-data>/sync/trash/<rootHash>/<时间戳>-<原名>。
      // v1 不做回收站浏览 UI；移动路径经 hooks.warn 记入诊断（由调用方接线）。
      const appData = await getAdapter().app.appDataDir();
      const { rootHash } = await import("./manifest");
      const hash = await rootHash(root);
      const target = `${toPosix(appData)}/sync/trash/${hash}/${Date.now()}-${relPath
        .split("/")
        .pop()}`;
      const src = absOf(root, relPath);
      const dir = target.slice(0, target.lastIndexOf("/"));
      if (!(await fs().exists(dir))) await fs().mkdir(dir, { recursive: true });
      await fs().rename(src, target);
    },
    async statLocal(abs) {
      try {
        const st = await fs().stat(abs);
        return { mtimeMs: st.mtime?.getTime() ?? 0, size: st.size };
      } catch {
        return null;
      }
    },
    readLocalBytes: (abs) => fs().readFile(abs),
    async writeFileLocal(abs, data) {
      const dir = abs.slice(0, abs.lastIndexOf("/"));
      if (!(await fs().exists(dir))) await fs().mkdir(dir, { recursive: true });
      await fs().writeFile(abs, data);
    },
    renameLocal: (a, b) => fs().rename(a, b),
  };
}
