// 插件类型断言的统一收口点（report3 遗留项 N20）。
//
// 背景：milkdown/unified 生态的插件工厂与本项目的包装函数返回类型天然不交，
// 此前散布 26+ 处 `as unknown as MilkdownPlugin[]` / `as unknown as Plugin`
// 内联断言：
//   * milkdown 的 $.x() 系 composable（$remark/$nodeSchema/$prose…）返回
//     `[ctxSlice, plugin]` 元组或单插件，`.flat()` 后的联合元素类型与
//     `editor.use()` 期望的 `MilkdownPlugin[]` 不交（内置 preset 同款写法）；
//   * 本项目手写的 remark 插件（lib/remarkMark.ts、remarkWikiLink.ts 等）
//     刻意保持松散类型（不依赖 package.json 未声明的 transitive dep 类型），
//     注册进 unified 管线时只能断言。
//
// 集中为两个带名字的工具函数后，断言仍是零开销的一层 hard cast，但语义
// 收口在本文件：将来升级 milkdown/unified 若引入真实类型不兼容，只需要
// 审计这一处；新增注册点也不再复制 `as unknown as` 惯例。

import type { MilkdownPlugin } from "@milkdown/ctx";
import type { Plugin } from "unified";

/**
 * 把 milkdown 插件束（`[$remark(...), $nodeSchema(...), ...].flat()` 的产物）
 * 断言为 `MilkdownPlugin[]`。仅供 `editor.use()` / 插件束导出前的收口使用。
 */
export function asMilkdownPlugins(list: unknown[]): MilkdownPlugin[] {
  return list as MilkdownPlugin[];
}

/**
 * 把本项目手写的 remark 插件断言为 unified `Plugin`，供 `.use()` 注册。
 * 带选项的插件用显式泛型保留调用点对选项的类型检查，例如：
 * `asRemarkPlugin<[WikiLinkOptions]>(remarkWikiLink)`（等价于原先的
 * `remarkWikiLink as unknown as Plugin<[WikiLinkOptions]>`）。
 */
export function asRemarkPlugin<Parameters extends unknown[] = []>(
  plugin: unknown
): Plugin<Parameters> {
  return plugin as Plugin<Parameters>;
}
