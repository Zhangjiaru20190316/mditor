// 云同步忽略/白名单规则（§5.1，纯函数）。内置默认规则收死不可变——这是
// v5.1.2 的决策：默认语义稳定，双端清单语义才可比对。v5.3 起支持**每工作
// 区根**的范围覆盖（types.ts RootSyncOptions）：覆盖值经设置归一层消毒后
// 传入，引擎在本地扫描与远端 List **双侧一致**应用同一份配置——范围外远
// 端对象对本端「不可见」，永不产生删除动作；被排除的已跟踪条目经
// deleted|deleted → clearRecord 自然清出清单（云端副本保留为孤儿，本地
// 文件不动）。覆盖配置**不**折进 remoteFingerprint：范围变更靠矩阵收敛，
// 不触发首同步重算（避免全库冲突副本风暴）。

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

/**
 * 参与同步的扩展名默认白名单（v5.1.2 决策 → MF 轮修订）：只同步软件内的
 * 笔记类型——Markdown、可交互 HTML、PDF 与 Word(.docx)（多格式笔记，
 * docs/multiformat-note-support-task.md §4.7）。图片等其余附件仍只留在
 * 工作区，不进云端（已存在的旧云端副本保留为孤儿对象，不做删除；老
 * 规则遗留的云端 pdf/docx 无清单记录 → 新端按 absent|new 下载回归）。
 * v5.3 起可被每根的 RootSyncOptions.extensions **替换式**覆盖
 * （extensionMode = custom）；本集合仍是「跟随默认」的唯一事实源，导出供
 * 设置 UI 预置 chips 与引擎回落使用。 */
export const DEFAULT_SYNCABLE_EXTS: ReadonlySet<string> = new Set([
  "md",
  "html",
  "pdf",
  "docx",
]);

/** 相对路径的扩展名是否在白名单内（大小写不敏感；无扩展名不同步）。
 *  exts 缺省 = 内置默认白名单（既有行为完全不变）。 */
export function isSyncableRelPath(
  relPath: string,
  exts: ReadonlySet<string> = DEFAULT_SYNCABLE_EXTS
): boolean {
  const name = relPath.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  return exts.has(name.slice(dot + 1).toLowerCase());
}

// ---- 每根排除规则（v5.3；纯匹配，无 IO）------------------------------------

/** 每根排除规则（归一后的 RootSyncOptions 过滤相关字段切片）。 */
export interface RootExcludeRules {
  /** 目录前缀排除（相对根 posix 路径）。 */
  excludedDirs?: readonly string[];
  /** 通配排除规则（`*` 段内、`**` 跨段、裸名匹配任意层同名段）。 */
  excludePatterns?: readonly string[];
}

/** 单段通配匹配（fnmatch-lite：仅 `*`，段内不含 `/`）。大小写不敏感。 */
function matchSegment(pattern: string, seg: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === seg;
  const parts = pattern.split("*");
  if (!seg.startsWith(parts[0])) return false;
  let idx = parts[0].length;
  for (let i = 1; i < parts.length - 1; i++) {
    const found = seg.indexOf(parts[i], idx);
    if (found === -1) return false;
    idx = found + parts[i].length;
  }
  const last = parts[parts.length - 1];
  return seg.length - idx >= last.length && seg.endsWith(last);
}

/**
 * 模式 ↔ relPath 匹配（大小写不敏感；Windows 盘大小写不敏感，用户手敲
 * 规则的常见大小写差异不应造成「规则看着生效实际没匹配上」）。两类语义：
 *
 * - 字面模式（不含 `*`）：目录语义——模式段序列作为**连续段窗口**出现在
 *   relPath 的任意层级即命中（「assets」命中任意层级的 assets 目录本身
 *   与其下全部内容；也命中同名文件）。与 excludedDirs 的前缀语义同构。
 * - 通配模式（含 `*`）：叶子锚定——模式段序列（`**` 匹配零或多段、其余
 *   段按 matchSegment）须匹配「以末段结尾」的某段后缀（`*.tmp` 命中任意
 *   层级的 .tmp 文件；`temp/**` 命中 temp 目录下全部内容；单段 `*` 不跨
 *   层级，如 a 的直接子文件 b.md 记作 a 段 + 星段 + b.md 段）。
 */
function matchGlob(pattern: string, segs: readonly string[]): boolean {
  const pat = pattern
    .replace(/\/+$/, "")
    .toLowerCase()
    .split("/")
    .filter((s) => s !== "");
  if (pat.length === 0) return false;
  const n = segs.length;
  const m = pat.length;
  if (!pat.some((p) => p.includes("*"))) {
    // 字面模式：连续段窗口匹配（目录 + 内容）。
    for (let s = 0; s + m <= n; s++) {
      let ok = true;
      for (let i = 0; i < m; i++) {
        if (pat[i] !== segs[s + i]) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }
  // 通配模式：dp[i][j] = pat[i..] 是否匹配 segs[j..]（须消耗到末段）；
  // 命中 = 存在起点 j 使整段模式匹配到叶子。
  const dp: boolean[][] = Array.from({ length: m + 1 }, () =>
    new Array<boolean>(n + 1).fill(false)
  );
  dp[m][n] = true;
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n; j >= 0; j--) {
      if (pat[i] === "**") {
        dp[i][j] = dp[i + 1][j] || (j < n && dp[i][j + 1]);
      } else {
        dp[i][j] = j < n && matchSegment(pat[i], segs[j]) && dp[i + 1][j + 1];
      }
    }
  }
  return dp[0].some(Boolean);
}

/**
 * relPath 是否落在每根排除范围内。excludedDirs 用前缀语义（relPath 等于
 * 目录或位于其下）；excludePatterns 走 matchGlob。两组规则任一命中即排除。
 * 只对通过内置忽略规则（`.` 前缀等）之后的路径调用——本函数不替代内置规则。
 */
export function isExcludedRelPath(
  relPath: string,
  rules: RootExcludeRules | undefined
): boolean {
  if (!rules) return false;
  const segs = relPath.toLowerCase().split("/");
  const dirs = rules.excludedDirs;
  if (dirs) {
    for (const d of dirs) {
      const dSegs = d.toLowerCase().split("/").filter((s) => s !== "");
      if (dSegs.length === 0 || segs.length < dSegs.length) continue;
      if (dSegs.every((s, i) => segs[i] === s)) return true;
    }
  }
  const pats = rules.excludePatterns;
  if (pats) {
    for (const pat of pats) {
      if (pat.trim() !== "" && matchGlob(pat, segs)) return true;
    }
  }
  return false;
}

/** 文件大小是否超限（扫描侧预判 + 下载/上传前兜底共用）。 */
export function isTooLarge(size: number): boolean {
  return size > MAX_SYNC_FILE_BYTES;
}
