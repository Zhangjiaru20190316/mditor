// S3 原语的前端封装（v4.12 云同步；v4.13 起鸿蒙经 ArkTS 桥代理）——
// s3_* 命令的唯一调用点。
//
// 分层契约：渲染层不直连对象存储，全部经平台后端代理——桌面走 Rust
// （src-tauri/src/s3.rs），鸿蒙走 ArkTS SigV4（net/S3Bridge.ets）；CSP 的
// connect-src 论述仅适用桌面 webview（鸿蒙 ArkWeb 无 CSP 锁定，但沿用同
// 一代理分层）。配置随调用透传（D3），后端侧不缓存。
//
//   * isSyncSupported() 是全部 UI/装配点的唯一判定入口（detectRuntime 判定，
//     禁止各处自写运行时判断）——browser 预览运行时判 false；
//   * 每个原语入口先守卫——不支持时抛 UnsupportedError（复用项目既有约定）；
//   * 二进制差异（D4）：桌面 s3_get 走 Tauri raw IPC 返回 ArrayBuffer；
//     鸿蒙桥统一 {base64}（fromBase64 解码复用鸿蒙适配层实现）。
// node（vitest）环境 detectRuntime 恒按 tauri 处理，测试需显式 vi.mock。

import { detectRuntime } from "../../platform";
import { UnsupportedError } from "../../platform/errors";
import { getAdapter } from "../../platform";
import { fromBase64 } from "../../platform/harmony";
import type { SyncSettings } from "../../types";
import type { S3ConfigPayload, S3Object, S3TestInfo } from "./types";

/** 云同步是否在当前运行时可用（tauri/harmony=true，browser=false）。 */
export function isSyncSupported(): boolean {
  return detectRuntime() !== "browser";
}

/** 同步原语统一守卫：browser 预览运行时（无平台后端）明确报不支持。 */
function requireSync(): void {
  if (!isSyncSupported()) {
    throw new UnsupportedError("云同步当前仅支持桌面版与鸿蒙版");
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

/** 下载对象（≤50MB 硬校验在后端）。 */
export async function s3Get(cfg: S3ConfigPayload, key: string): Promise<Uint8Array> {
  requireSync();
  if (detectRuntime() === "harmony") {
    // 鸿蒙桥二进制通道统一 {base64}（D4），解码复用鸿蒙适配层实现。
    const r = await getAdapter().app.invoke<{ base64: string }>("s3_get", toArgs(cfg, { key }));
    return fromBase64(r.base64);
  }
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
