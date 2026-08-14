// 面板宽度拖拽调节 hook（模块 C）。
//
// 用法：把返回的 { onPointerDown, onDoubleClick } 绑到分隔条元素上。
//   const r = useResizable({
//     side: "left",            // left=拖右增大（侧边栏），right=拖左增大（AI 面板）
//     min: 180, max: 480,
//     getWidth: () => settings.sidebarWidth,
//     onMove: (w) => root.style.setProperty("--sidebar-width", `${w}px`), // 高频，仅改视觉
//     onCommit: (w) => void update({ sidebarWidth: w }),                   // 松手时持久化
//     resetWidth: 260,         // 双击重置
//   });
//   <div className="resizer resizer-sidebar" onPointerDown={r.onPointerDown} onDoubleClick={r.onDoubleClick} />
//
// 实现要点：
//  - 用 pointer events（兼容触摸 / 笔）。
//  - 拖拽中给 body 加 is-resizing 类 + user-select:none（CSS 据此禁用过渡，保证跟手）。
//  - 用 ref 持有最新配置，使 onPointerDown 引用稳定，分隔条不会因回调变化而重挂。

import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export interface UseResizableOptions {
  min: number;
  max: number;
  /** left：拖动向右增大（侧边栏，分隔条在其右侧）；
   *  right：拖动向左增大（AI 面板，分隔条在其左侧）。 */
  side: "left" | "right";
  /** 读取当前（已提交）宽度，作为拖拽起点基准。 */
  getWidth: () => number;
  /** 拖拽过程中高频回调（仅更新视觉，不要在此做持久化）。 */
  onMove: (width: number) => void;
  /** 松手时的最终宽度（用于持久化）。 */
  onCommit: (width: number) => void;
  /** 双击重置的目标宽度（可选；不传则不响应双击）。 */
  resetWidth?: number;
}

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

export interface ResizerHandlers {
  onPointerDown: (e: ReactPointerEvent) => void;
  onDoubleClick: () => void;
}

export function useResizable(opts: UseResizableOptions): ResizerHandlers {
  // 用 ref 保存最新配置，保证返回的两个处理函数引用恒定。
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // 若组件在拖拽过程中卸载（如分隔条所在面板被条件渲染移除，或 pointerup
  // 没派发到 document），用此 ref 在卸载时移除 pointermove/pointerup，否则
  // 它们会永久驻留 document 并持有 startX/startWidth/onMove/onCommit 闭包。
  const teardownRef = useRef<(() => void) | null>(null);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    // 仅响应主键（左键）
    if (e.button !== 0) return;
    e.preventDefault();
    const o = optsRef.current;
    const startX = e.clientX;
    const startWidth = clamp(o.getWidth(), o.min, o.max);

    document.body.classList.add("is-resizing");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    // rAF 合并：pointermove 在某些设备上每秒可触发上百次，直接每次同步改 CSS
    // 变量并驱动面板宽度重排会丢帧。把宽度计算与 onMove 收敛到一帧一次。
    let rafId: number | null = null;
    let pendingW = startWidth;
    const flush = () => {
      rafId = null;
      o.onMove(pendingW);
    };

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const delta = o.side === "left" ? dx : -dx;
      pendingW = clamp(Math.round(startWidth + delta), o.min, o.max);
      if (rafId == null) rafId = requestAnimationFrame(flush);
    };
    // 抽出"拆除监听器 + 复位 body 样式 + 取消 rAF"为独立函数：pointerup 与
    // 组件卸载两种路径都要走它。
    const teardown = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.body.classList.remove("is-resizing");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
    const up = (ev: PointerEvent) => {
      teardown();
      teardownRef.current = null;
      const dx = ev.clientX - startX;
      const delta = o.side === "left" ? dx : -dx;
      const w = clamp(Math.round(startWidth + delta), o.min, o.max);
      // 松手前最后一次 move 的 rAF 可能仍挂起被取消，这里务必把最终宽度
      // 落到视觉，再提交持久化，避免视觉差一帧。
      o.onMove(w);
      o.onCommit(w);
    };

    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    teardownRef.current = teardown;
  }, []);

  // 组件卸载时若拖拽仍未结束，移除残留的 document 监听器并复位 body 样式。
  useEffect(() => {
    return () => {
      teardownRef.current?.();
      teardownRef.current = null;
    };
  }, []);

  const onDoubleClick = useCallback(() => {
    const o = optsRef.current;
    if (o.resetWidth == null) return;
    const w = clamp(o.resetWidth, o.min, o.max);
    // 先同步视觉再持久化，重置也有动画
    o.onMove(w);
    o.onCommit(w);
  }, []);

  return { onPointerDown, onDoubleClick };
}
