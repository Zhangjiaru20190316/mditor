// 同步清单（manifest，§4.2）：每工作区根一份，存 app-data 下
// <app-data>/sync/manifests/<rootHash>.json。前端读写经平台适配层；本模块
// 提供纯序列化/归一 + rootHash + 真实 IO 封装（engine 的 io 注入默认实现，
// 单测用内存桩替换）。
//
// 注意：manifest 是同步语义的「基准快照」——lastSyncAt 之前的两侧状态由
// 它锚定，3-way 判定全部相对它进行。除第 8 步落盘外引擎中途崩溃不会写半份
// 清单（崩溃恢复：下次按旧清单重算，原语幂等）。

import { getAdapter } from "../../platform";
import type { S3ConfigPayload, SyncManifestFile } from "./types";

/** 清单结构版本；不识别的版本按「无清单」处理（回落首同步全量重算）。 */
export const MANIFEST_VERSION = 1;

export interface SyncManifest {
  version: 1;
  /** 工作区根绝对路径（检测路径漂移：不一致即弃用清单全量重算）。 */
  workspaceRoot: string;
  /** epoch ms，最近一次成功同步。 */
  lastSyncAt: number;
  /** key = 工作区相对路径（posix 风格）。 */
  files: Record<string, SyncManifestFile>;
  /**
   * D1：远端身份指纹（endpoint+bucket+prefix 的 SHA-256 前 16 hex）。
   * 指纹与当前配置不一致 ⇒ 远端已不是清单记录的那只桶 ⇒ 按首同步重算
   * （最多产生冲突副本），绝不拿旧清单对着新桶判「远端已删除」。
   * 旧版清单无此字段：视为匹配（本次同步补写指纹），避免全量升级即冲突。
   */
  remoteFingerprint?: string;
}

/**
 * rootHash：工作区根绝对路径 SHA-256 前 16 hex。多根每根一份清单；
 * 同一根换机/移动后路径变化 → hash 变化 → 自然落到新清单（路径漂移双保险，
// 与 workspaceRoot 字段校验互为冗余）。
 */
export async function rootHash(root: string): Promise<string> {
  const data = new TextEncoder().encode(root.replace(/\\/g, "/").toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** 清单文件绝对路径：<app-data>/sync/manifests/<rootHash>.json。 */
export async function manifestFilePath(root: string): Promise<string> {
  const appData = await getAdapter().app.appDataDir();
  const hash = await rootHash(root);
  const posix = appData.replace(/\\/g, "/");
  return `${posix}/sync/manifests/${hash}.json`;
}

/**
 * 反序列化 + 归一：JSON 损坏 / version 不识别 / files 非对象 → null
 * （调用方按首同步处理）。幂等：合法输入原样返回等价结构。
 */
export function parseManifest(raw: string): SyncManifest | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const m = obj as Partial<SyncManifest>;
  if (m.version !== MANIFEST_VERSION) return null;
  if (typeof m.workspaceRoot !== "string" || typeof m.lastSyncAt !== "number") {
    return null;
  }
  const files: Record<string, SyncManifestFile> = {};
  if (m.files && typeof m.files === "object") {
    for (const [k, v] of Object.entries(m.files)) {
      if (!v || typeof v !== "object") continue;
      const f = v as Partial<SyncManifestFile>;
      // 两侧快照形态校验：local/remote 至少一侧存在（双侧 null 是无意义记录）。
      const localOk =
        f.local === null ||
        (f.local &&
          typeof f.local.mtimeMs === "number" &&
          typeof f.local.size === "number");
      const remoteOk =
        f.remote === null ||
        (f.remote &&
          typeof f.remote.etag === "string" &&
          typeof f.remote.size === "number" &&
          typeof f.remote.lastModified === "string");
      if (localOk && remoteOk && (f.local !== null || f.remote !== null)) {
        files[k] = {
          local: f.local ?? null,
          remote: f.remote ?? null,
        };
      }
    }
  }
  return {
    version: MANIFEST_VERSION,
    workspaceRoot: m.workspaceRoot,
    lastSyncAt: m.lastSyncAt,
    files,
    ...(typeof m.remoteFingerprint === "string" ? { remoteFingerprint: m.remoteFingerprint } : {}),
  };
}

/** 序列化（幂等往返：parse(serialize(m)) 与 m 语义等价）。 */
export function serializeManifest(m: SyncManifest): string {
  return JSON.stringify(m);
}

/**
 * D1：远端身份指纹——endpoint+bucket+prefix 归一（小写、去尾斜杠）后
 * SHA-256 前 16 hex。不含凭证（access key 会轮换，不应触发全量重算）。
 */
export async function remoteFingerprint(
  cfg: Pick<S3ConfigPayload, "endpoint" | "bucket">,
  prefix: string
): Promise<string> {
  const norm = `${cfg.endpoint.replace(/\/+$/, "").toLowerCase()}|${cfg.bucket.toLowerCase()}|${prefix.replace(/\/+$/, "")}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(norm));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** 新建空清单（首同步起点）。 */
export function emptyManifest(root: string): SyncManifest {
  return {
    version: MANIFEST_VERSION,
    workspaceRoot: root,
    lastSyncAt: 0,
    files: {},
  };
}

// ---- 真实 IO（engine 默认注入；单测用内存桩替换）---------------------------

/** 读清单；不存在/损坏/版本不识别 → null（首同步）。 */
export async function readManifest(root: string): Promise<SyncManifest | null> {
  const path = await manifestFilePath(root);
  try {
    const raw = await getAdapter().fs.readTextFile(path);
    return parseManifest(raw);
  } catch {
    return null; // 不存在等 IO 错误一律按无清单处理
  }
}

/**
 * 落盘清单。D3：先写 <path>.tmp 再 rename 覆盖（NTFS/ext4 上 rename 对已
 * 存在目标是原子替换）——截断式整文件覆写在崩溃/断电中途会留下半份 JSON，
 * parseManifest 返回 null 后退化为首同步，制造整库冲突副本风暴。
 * tmp 残留（rename 前崩溃）无害：下次写入直接复用同名 tmp 覆盖。
 */
export async function writeManifest(root: string, m: SyncManifest): Promise<void> {
  const path = await manifestFilePath(root);
  const fs = getAdapter().fs;
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (!(await fs.exists(dir))) await fs.mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  await fs.writeTextFile(tmp, serializeManifest(m));
  try {
    await fs.rename(tmp, path);
  } catch (e) {
    // rename 失败时清掉 tmp，避免留一份看起来像新清单的残件。
    try {
      await fs.remove(tmp);
    } catch {
      /* 尽力清理 */
    }
    throw e;
  }
}
