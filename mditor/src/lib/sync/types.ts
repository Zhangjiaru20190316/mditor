// 云同步（v4.12）共享类型。
//
// 分层契约：类型（SyncSettings/S3ProviderPreset）住在 src/types.ts，预设
// 数据（SYNC_PROVIDERS）住在 src/defaults.ts（Q4「types 必是类型」拆分），
// 此处 re-export 方便 sync 模块内单一 import；S3Object / SyncStateEvent /
// 操作与摘要类型只在同步引擎内部流转，定义于此。

export type { SyncSettings, S3ProviderPreset } from "../../types";
export { SYNC_PROVIDERS } from "../../defaults";

/** s3_list / s3_head 返回的远端对象元数据（镜像 Rust 侧 S3Object）。 */
export interface S3Object {
  key: string;
  size: number;
  /** 可能为空（部分实现对无 ETag 的对象返回 None）。 */
  etag: string | null;
  /** RFC3339 字符串（serde 序列化的 DateTime<Utc>）。 */
  lastModified: string;
}

/** s3_test_connection 的返回。 */
export interface S3TestInfo {
  bucket: string;
  endpoint: string;
  region: string;
}

// ---- 状态与事件（§5.6）------------------------------------------------------

export type SyncStatus = "idle" | "syncing" | "error" | "offline";

export interface SyncStateEvent {
  status: SyncStatus;
  /** syncing 时的阶段细分；其余状态可缺省。 */
  phase?: "scan" | "list" | "transfer" | "finalize";
  /** 正在同步的工作区根（绝对路径）。idle/error/offline 时可缺省。 */
  root?: string;
  done: number;
  total: number;
  currentFile?: string;
  /** 全部根完成后的上次同步时间（epoch ms）。 */
  lastSyncAt?: number;
  error?: { code: string; message: string };
  /** 本轮需用户留意的提示（时钟冲突/超限跳过/中止保险等，去重后截断）。D6。 */
  notes?: string[];
}

/** 一次同步的结果摘要（sync-state done 广播与 UI 悬浮提示共用）。 */
export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  skipped: number;
  failed: number;
  /** 「请人工确认冲突副本」类提示（时钟不可信等）。 */
  notes: string[];
  lastSyncAt: number;
}

export const EMPTY_SYNC_SUMMARY: SyncSummary = {
  uploaded: 0,
  downloaded: 0,
  deletedLocal: 0,
  deletedRemote: 0,
  conflicts: 0,
  skipped: 0,
  failed: 0,
  notes: [],
  lastSyncAt: 0,
};

// ---- 同步算法内部类型（§5.2/§5.3）-------------------------------------------

/** 单侧文件状态（相对 manifest 快照）。 */
export type SideState = "same" | "changed" | "deleted" | "new";

/**
 * 动作矩阵的原子动作。conflict 在引擎内进一步展开（内容比对 → 胜者判定 →
 * 副本命名），对 decideAction 的调用方保持单一枚举值。
 */
export type SyncAction =
  | "skip"
  | "download"
  | "upload"
  | "deleteLocal"
  | "deleteRemote"
  | "restoreLocal" // 本地 deleted × 远端 changed → 下载恢复
  | "clearRecord" // 双侧 deleted → 清除 manifest 记录
  | "conflict";

/** manifest 里单文件的两侧快照（见 manifest.ts）。 */
export interface SyncManifestFile {
  local: { mtimeMs: number; size: number; md5: string | null } | null;
  remote: { etag: string; size: number; lastModified: string } | null;
}

/** Rust 侧 S3Config 的前端形态（SyncSettings 的凭证/连接子集）。 */
export interface S3ConfigPayload {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  pathStyle: boolean;
}
