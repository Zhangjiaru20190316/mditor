// 云同步固定忽略规则（§5.1，纯函数）。v1 不提供配置——规则一旦可变，
// 双端的清单语义就会漂移，故收死为内置常量。

/** 单文件字节上限（与 Rust 侧 MAX_OBJECT_BYTES 一致；超限跳过并记警告）。 */
export const MAX_SYNC_FILE_BYTES = 50 * 1024 * 1024;

/** 本地 md5 计算上限（>10MB 跳过 md5 记 null，性能取舍，§4.2）。 */
export const MAX_MD5_BYTES = 10 * 1024 * 1024;

/** 目录深度上限（relPath 的段数，防恶意/误操作深递归）。 */
export const MAX_SYNC_DEPTH = 32;

/**
 * 单个名称（文件或目录名）是否被忽略：以 `.` 开头（.git / .obsidian 等）。
 * 本地扫描与远端 List 剥前缀后共用这一判定——远端多出来的隐藏文件不动。
 */
export function isIgnoredName(name: string): boolean {
  return name.startsWith(".");
}

/**
 * 相对路径（posix 风格，`/` 分隔）是否被忽略：任一段以 `.` 开头即忽略。
 * 远端 key 还原为 relPath 后按本规则过滤。
 */
export function isIgnoredRelPath(relPath: string): boolean {
  if (relPath === "") return true;
  return relPath.split("/").some((seg) => seg === "" || isIgnoredName(seg));
}

/** 相对路径深度是否超限（段数 > MAX_SYNC_DEPTH）。 */
export function isTooDeep(relPath: string): boolean {
  return relPath.split("/").filter((s) => s !== "").length > MAX_SYNC_DEPTH;
}

/** 文件大小是否超限（扫描侧预判 + 下载/上传前兜底共用）。 */
export function isTooLarge(size: number): boolean {
  return size > MAX_SYNC_FILE_BYTES;
}
