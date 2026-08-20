// 侧栏跳转 → 弹层首击的一次性预解析传递（v3.9.3）。
//
// AnnotationPopover 的首击只信防抖列表（避免 mousedown 内同步整篇解析
// 冻结主线程——v3.9.1 教训），但侧栏跳转时列表可能滞后于实时文档：首击
// 拿不到 codeLine 就不会解析/高亮代码行，跳转停在 marker 行而不是被批注
// 的代码行。侧栏跳转是低频操作，App 侧预解析一次（O(doc) 可付），经此
// 模块一次性递给随后的合成 mousedown；popover 读取即清空，不残留。

import type { Annotation } from "./annotations";

let pending: Annotation | null = null;

/** 存入预解析结果（App.jumpToAnnotation 在派发合成 mousedown 前调用）。 */
export function setPendingJumpAnno(a: Annotation | null): void {
  pending = a;
}

/** 取走与 `id` 匹配的预解析批注（无论如何都清空槽位，一次性语义）。 */
export function takePendingJumpAnno(id: string): Annotation | null {
  const hit = pending?.id === id ? pending : null;
  pending = null;
  return hit;
}
