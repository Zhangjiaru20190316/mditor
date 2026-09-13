// 多窗口支持（v4.8）：纯函数部分（URL 构建/解析、窗口标题格式）+ 副作用
// 封装（新建窗口 / 标签迁移 handoff）。
//
// 契约（与 Rust 侧 commands.rs 的 create_doc_window 对齐）：
//   * URL 查询参数只允许 path / handoff 两个短参数；未命名脏缓冲、大文档
//     快照等载荷一律走 Rust 侧 stash（存-取-删，60s TTL），绝不进 URL。
//   * 第一窗口 label 恒为 main（冷启动：PendingFile / heal snapshot / splash
//     只属于它）；新窗口 label 为 doc-{n}，由 Rust 分配。
//
// 纯函数全部可 vitest（见 multiWindow.test.ts）；invoke 封装保持薄——失败
// 由调用方（App 的入口 UI）决定提示方式。鸿蒙迁移 v4.11：经平台适配层
// 分发；capabilities.multiWindow=false 的平台（鸿蒙 MVP）调用即抛
// UnsupportedError，调用点（App 菜单等）已按能力守卫整段跳过。

import { getAdapter } from "../platform";
import { UnsupportedError } from "../platform/errors";
import type { TabItem } from "../types";

/** 启动参数：?path=<已编码绝对路径> 与 ?handoff=<stash id>，均可缺省。 */
export interface BootParams {
  path: string | null;
  handoff: string | null;
}

/** 标签迁移载荷（stash 里的 JSON 结构）。scrollTop 尽力恢复（best-effort）。 */
export interface HandoffPayload {
  tab: TabItem;
  scrollTop: number;
}

/**
 * 构建文档窗口的相对 URL。只拼有值的参数；encodeURIComponent 覆盖中文、
 * 空格、`#`、`&` 等 URL 结构字符。Rust 侧 buildDocWindowUrl 的镜像（往返
 * 一致性由 multiWindow.test.ts 锚定）。
 */
export function buildDocWindowUrl(path?: string, handoffId?: string): string {
  const params: string[] = [];
  if (path) params.push(`path=${encodeURIComponent(path)}`);
  if (handoffId) params.push(`handoff=${encodeURIComponent(handoffId)}`);
  return params.length > 0 ? `index.html?${params.join("&")}` : "index.html";
}

/** 解析 location.search。未知键忽略；空串按缺省处理（返回 null）。 */
export function parseBootParams(search: string): BootParams {
  // 容错：Tauri 的 WebviewUrl::App 在 dev/build 下都应产出合法查询串；
  // 手工改坏的 URL 不允许拖垮启动。
  try {
    const q = new URLSearchParams(search);
    const path = q.get("path");
    const handoff = q.get("handoff");
    return { path: path && path.length > 0 ? path : null, handoff: handoff && handoff.length > 0 ? handoff : null };
  } catch {
    return { path: null, handoff: null };
  }
}

/** 窗口标题：脏缓冲前缀 `• `（任务栏/Alt+Tab 可区分各窗口的文档与状态）。 */
export function formatWindowTitle(name: string, dirty: boolean): string {
  return `${dirty ? "• " : ""}${name} — Mditor`;
}

/** 多窗口能力守卫：不支持的平台统一抛 UnsupportedError。 */
function requireMultiWindow(): void {
  if (!getAdapter().capabilities.multiWindow) {
    throw new UnsupportedError("鸿蒙版暂不支持多窗口");
  }
}

/** 在新窗口打开一个磁盘文件（本窗标签不动）。 */
export async function openPathInNewWindow(path: string): Promise<void> {
  requireMultiWindow();
  await getAdapter().app.createDocWindow(path, null);
}

/** 新建一个空白窗口（Ctrl+Shift+N / 菜单「新建窗口」）。 */
export async function openEmptyNewWindow(): Promise<void> {
  requireMultiWindow();
  await getAdapter().app.createDocWindow(null, null);
}

/**
 * 把一个标签迁移到新窗口：载荷（TabItem + scrollTop）先 stash 进 Rust 侧，
 * 拿到 handoff id 再建窗。调用方随后自行关闭本窗的该标签（closeTab）。
 */
export async function moveTabToNewWindow(tab: TabItem, scrollTop = 0): Promise<void> {
  requireMultiWindow();
  const payload: HandoffPayload = { tab, scrollTop };
  const id = await getAdapter().app.stashTabPayload(JSON.stringify(payload));
  await getAdapter().app.createDocWindow(null, id);
}

/** 取回（即删除）handoff 载荷。id 失效 / JSON 损坏 / 平台不支持 → null
 *  （落到空白未命名）。 */
export async function takeHandoff(id: string): Promise<HandoffPayload | null> {
  if (!getAdapter().capabilities.multiWindow) return null;
  const raw = await getAdapter().app.takeTabPayload(id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HandoffPayload;
  } catch {
    return null;
  }
}
