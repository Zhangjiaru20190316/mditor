// 多根工作区（v4.4，VS Code 式 multi-root）的纯路径工具。
//
// Windows 子系统（对话框、fs 监视器、树读取）会以漂移的大小写返回同一路
// 径，所以根比较一律走「posix 归一 + 小写折叠」；分隔符边界保证 `C:\a`
// 永远不会匹配 `C:\ab`。全部为纯函数，可脱离 Tauri 单测（workspaces.test.ts）。

/** Case-insensitive path equality — Windows 子系统返回的同一路径大小写会漂移。 */
export function samePathFold(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/**
 * Whether `p` equals `root` or lives underneath it — case-insensitive, with
 * a separator boundary so `C:\a` never matches `C:\ab`. Both sides are
 * normalized to posix before comparing.
 */
export function isUnderRoot(p: string, root: string): boolean {
  const pl = p.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  const rl = root.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  return pl === rl || pl.startsWith(rl + "/");
}

/** `p` 是否落在任意一个根之下（含等于根本身）。 */
export function isUnderAnyRoot(p: string, roots: string[]): boolean {
  return roots.some((r) => isUnderRoot(p, r));
}

/**
 * `p` 所属的根（roots 中第一个包含它的元素，原样返回、不归一）。
 * 嵌套根（C:\a 与 C:\a\sub 同时在列）时返回靠前的那个 —— 判定确定性，
 * 展开祖先链等场景两种选择都正确。无匹配返回 null。
 */
export function rootOf(p: string, roots: string[]): string | null {
  for (const r of roots) {
    if (isUnderRoot(p, r)) return r;
  }
  return null;
}

/** 根列表去重（大小写折叠），保持首次出现的顺序。 */
export function dedupeRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    const key = r.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * 归一化 store 中 `workspaces` 键的原始值：过滤非字符串/空串。
 * 返回 null 表示「没有可用的存储值」（未写入或写坏），调用方应回落到
 * 旧版单值 `workspace` 键；空数组是合法状态（用户移除了全部根），原样返回。
 */
export function normalizeStoredWorkspaces(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((r): r is string => typeof r === "string" && r.trim() !== "");
}
