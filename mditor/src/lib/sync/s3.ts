// S3 原语的前端封装（v4.12 云同步）——Rust 侧 s3_* 命令的唯一调用点。
//
// CSP 红线：渲染层不直连对象存储，全部经 Rust 代理（与 ai.ts 的
// getAdapter().app.invoke 模式一致）；配置随调用透传（D3），Rust 侧不缓存。
//
// 鸿蒙兼容降级（§7.5）：本功能全部 Rust 命令在鸿蒙运行时天然不存在。
//   * isSyncSupported() 是全部 UI/装配点的唯一判定入口（detectRuntime 判定，
//     禁止各处自写运行时判断）；
//   * 每个原语入口先守卫——不支持时抛 UnsupportedError（复用项目既有约定），
//     即使未来某处误调，得到的也是明确错误而非 webview 层的静默失败。
// node（vitest）环境 detectRuntime 恒按 tauri 处理，测试需显式 vi.mock。

import { detectRuntime } from "../../platform";
import { UnsupportedError } from "../../platform/errors";
import { getAdapter } from "../../platform";
import type { SyncSettings } from "../../types";
import type { S3ConfigPayload, S3Object, S3TestInfo } from "./types";

/** 云同步是否在当前运行时可用（tauri/browser=true，harmony=false）。 */
export function isSyncSupported(): boolean {
  return detectRuntime() !== "harmony";
}

/** 同步原语统一守卫：鸿蒙（纯 web 包，无 Tauri Rust 侧）明确报不支持。 */
function requireSync(): void {
  if (!isSyncSupported()) {
    throw new UnsupportedError("云同步当前仅支持桌面版");
  }
}

/** 调用参数组装：S3ConfigPayload 原样透传（serde camelCase 对齐 Rust 结构）。 */
function toArgs(cfg: S3ConfigPayload, extra?: Record<string, unknown>) {
  return { cfg, ...extra };
}

/**
 * Rust 错误消息 → 同步错误码（§5.6）。Rust 侧已把错误整理为
 * 「SYNC-XXX: 中文消息」前缀形态；这里只负责提取与归类兜底，
 * 保证任何未知错误也有稳定码（SYNC-999）。
 */
export const SYNC_ERROR_CODES = {
  CRED: "SYNC-001",
  BUCKET: "SYNC-002",
  NETWORK: "SYNC-003",
  TIMEOUT: "SYNC-004",
  TOO_LARGE: "SYNC-005",
  BAD_KEY: "SYNC-006",
  UNKNOWN: "SYNC-999",
} as const;

export interface SyncErrorInfo {
  code: string;
  message: string;
}

/** 解析 Rust 返回的错误串（「SYNC-XXX: …」形态）为 {code, message}。 */
export function parseSyncError(err: unknown): SyncErrorInfo {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /^SYNC-(\d{3}):\s*(.*)$/s.exec(raw);
  if (m) return { code: `SYNC-${m[1]}`, message: m[2] || raw };
  // 不带前缀的意外错误（webview 层异常等）：保留原文，按未知归类。
  return { code: SYNC_ERROR_CODES.UNKNOWN, message: raw };
}

/** 测试连接失败时的中文排障指引（按错误码，设置界面消费）。 */
export const SYNC_ERROR_HINTS: Record<string, string> = {
  [SYNC_ERROR_CODES.CRED]: "凭证被拒绝：请检查 AccessKey / SecretKey（STS 令牌是否过期）。",
  [SYNC_ERROR_CODES.BUCKET]: "桶不存在或无访问权限：请核对桶名、endpoint 与该子账号的桶授权。",
  [SYNC_ERROR_CODES.NETWORK]: "网络不可达：请检查 endpoint 地址与网络连通性。",
  [SYNC_ERROR_CODES.TIMEOUT]: "请求超时：网络或服务端过慢，请稍后重试。",
  [SYNC_ERROR_CODES.TOO_LARGE]: "对象超出 50MB 上限。",
  [SYNC_ERROR_CODES.BAD_KEY]: "对象 key 非法（含 .. / 反斜杠 / 控制字符）。",
  [SYNC_ERROR_CODES.UNKNOWN]: "未知错误，请重试或查看诊断日志。",
};

/** 验证连通性 + 凭证 + 桶（List 1 键）。 */
export async function s3TestConnection(cfg: S3ConfigPayload): Promise<S3TestInfo> {
  requireSync();
  return getAdapter().app.invoke<S3TestInfo>("s3_test_connection", toArgs(cfg));
}

/** ListObjectsV2 全分页（Rust 侧上限 10000 键）。 */
export async function s3List(cfg: S3ConfigPayload, prefix: string): Promise<S3Object[]> {
  requireSync();
  return getAdapter().app.invoke<S3Object[]>("s3_list", toArgs(cfg, { prefix }));
}

/** 下载对象（二进制；Rust 侧 ≤50MB 硬校验）。 */
export async function s3Get(cfg: S3ConfigPayload, key: string): Promise<Uint8Array> {
  requireSync();
  const buf = await getAdapter().app.invoke<ArrayBuffer>("s3_get", toArgs(cfg, { key }));
  return new Uint8Array(buf);
}

/**
 * 上传对象。data 为 base64（Tauri JSON IPC 无二进制参数通道，md 文件以
 * 文本为主、上限 50MB，base64 开销可接受；SYNC-TODO: 若未来大文件成为
 * 主流可改 raw IPC body）。mtimeMs 尽力写入 x-amz-meta-mtime。
 * 返回上传后的对象元数据（内部 HEAD 取回，供 manifest 记录 etag/lastModified）。
 */
export async function s3Put(
  cfg: S3ConfigPayload,
  key: string,
  data: Uint8Array,
  mtimeMs?: number
): Promise<S3Object> {
  requireSync();
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < data.length; i += CHUNK) {
    binary += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  const payload = btoa(binary);
  return getAdapter().app.invoke<S3Object>(
    "s3_put",
    toArgs(cfg, { key, data: payload, mtimeMs })
  );
}

/** 删除远端对象（不可恢复——设置界面建议开启桶版本控制）。 */
export async function s3Delete(cfg: S3ConfigPayload, key: string): Promise<void> {
  requireSync();
  await getAdapter().app.invoke<void>("s3_delete", toArgs(cfg, { key }));
}

/** HEAD 单对象；404 → null。 */
export async function s3Head(cfg: S3ConfigPayload, key: string): Promise<S3Object | null> {
  requireSync();
  return getAdapter().app.invoke<S3Object | null>("s3_head", toArgs(cfg, { key }));
}

/** SyncSettings → 每次调用透传的连接载荷（D3；region 空值兜底 us-east-1）。 */
export function syncConfigPayload(s: SyncSettings): S3ConfigPayload {
  return {
    endpoint: s.endpoint.trim(),
    region: s.region.trim() || "us-east-1",
    bucket: s.bucket.trim(),
    accessKeyId: s.accessKeyId.trim(),
    secretAccessKey: s.secretAccessKey,
    sessionToken: s.sessionToken || undefined,
    pathStyle: s.pathStyle,
  };
}
