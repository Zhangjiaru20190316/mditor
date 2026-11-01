// 只读标签判别收敛（MF 轮）→ DE 轮语义拆分。
//
// MF 轮把 App.tsx（12 处）与 TabsBar.tsx（2 处）散落的 isHtmlTab 判定收敛为
// 全仓唯一的 isReadonlyTab。DE 轮在其上拆出两个正交判别（任务书 §4.3，
// 本轮最高风险架构点）：
//
//   isReadonlyTab —— 「md 管线隔离」：html/pdf/docx 恒真，**含编辑态**。
//     编辑态也不进 useFile/docCache/自动保存/批注/闪卡/双链/RAG。现有全部
//     管线隔离调用位（activateTab 快照守卫 / doc→tabs 同步短路 / showDoc
//     分支等）一行不改，语义由「只读视图对象」更新为「md 管线隔离」。
//   isDocEditActive —— kind 为 pdf/docx 且显式进入编辑态（TabItem.docEdit）。
//   isViewOnlyTab —— isReadonlyTab && !isDocEditActive：仅「未编辑的视图
//     对象」为真。dirty 圆点语义（TitleBar/TabsBar）、关闭确认、Ctrl+S
//     分流等「视图对象」性质的判定改用本判别：编辑态标签由此获得 dirty、
//     关闭确认、Ctrl+S 三件事（条件只读铁律）。
//
// 图标分发等「需要区分具体格式」的消费点仍直接用 htmlNote/docNote 的具体
// 判别，不经本模块。

import { isHtmlTab } from "./htmlNote";
import { isDocTab } from "./docNote";
import type { TabItem } from "../types";

/** 标签是否与 md 管线隔离（html / pdf / docx，含编辑态；md 与 undefined
 *  kind = false）。语义 = 不进编辑器/useFile/docCache/自动保存/批注/闪卡/
 *  双链/RAG。 */
export function isReadonlyTab(tab: TabItem | null | undefined): boolean {
  return isHtmlTab(tab) || isDocTab(tab);
}

/** 标签是否处于 doc 编辑态（kind 为 pdf/docx 且 TabItem.docEdit 为真）。
 *  编辑态由视图编辑入口显式开启、显式退出——这是「条件只读」的开关本体。 */
export function isDocEditActive(tab: TabItem | null | undefined): boolean {
  return isDocTab(tab) && tab?.docEdit === true;
}

/** 标签是否为「未编辑的视图对象」（只读且不在编辑态）。dirty 圆点 / 关闭
 *  确认 / 保存命令分流等消费点使用本判别：编辑态标签不再被视为纯视图。 */
export function isViewOnlyTab(tab: TabItem | null | undefined): boolean {
  return isReadonlyTab(tab) && !isDocEditActive(tab);
}
