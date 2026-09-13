// 同步清单（manifest，§4.2）：每工作区根一份，存 app-data 下
// <app-data>/sync/manifests/<rootHash>.json。前端读写经平台适配层；本模块
// 提供纯序列化/归一 + rootHash + 真实 IO 封装（engine 的 io 注入默认实现，
// 单测用内存桩替换）。
//
// 注意：manifest 是同步语义的「基准快照」——lastSyncAt 之前的两侧状态由
// 它锚定，3-way 判定全部相对它进行。除第 8 步落盘外引擎中途崩溃不会写半份
// 清单（崩溃恢复：下次按旧清单重算，原语幂等）。

import { getAdapter } from "../../platform";
import type { SyncManifestFile } from "./types";

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
  };
}

/** 序列化（幂等往返：parse(serialize(m)) 与 m 语义等价）。 */
export function serializeManifest(m: SyncManifest): string {
  return JSON.stringify(m);
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

/** 落盘清单（原子性：整文件覆写；目录惰性创建）。 */
export async function writeManifest(root: string, m: SyncManifest): Promise<void> {
  const path = await manifestFilePath(root);
  const fs = getAdapter().fs;
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (!(await fs.exists(dir))) await fs.mkdir(dir, { recursive: true });
  await fs.writeTextFile(path, serializeManifest(m));
}
